import json
import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.auth import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    create_session_value,
    read_session_value,
    login_limiter,
    read_session,
    require_api_token,
    require_csrf,
)
from app.cleanup import run_cleanup
from app.config import Settings, get_settings
from app.database import SessionLocal, get_db, init_db
from app.file_services import delete_file, get_file, list_files, save_file, storage_dir, total_file_bytes
from app.schemas import ClipboardIn, ClipboardOut, ClipboardUpdate, FileListOut, FileOut, HistoryOut, PublicConfig
from app.services import clear_history, create_entry, delete_entry, get_history, get_latest, serialize_entry, update_entry
from app.websocket import manager


logging.basicConfig(level=logging.INFO, format='{"level":"%(levelname)s","message":"%(message)s"}')
logger = logging.getLogger("local-clipboard")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    settings.validate_startup_secrets()
    init_db()
    with SessionLocal() as db:
        run_cleanup(db, settings)
    logger.info("Local Clipboard started")
    yield
    logger.info("Local Clipboard stopped")


app = FastAPI(title="Local Clipboard", version="3.0.0", lifespan=lifespan)
templates = Jinja2Templates(directory="app/templates")
app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.middleware("http")
async def security_and_size_middleware(request: Request, call_next):
    settings = get_settings()
    content_length = request.headers.get("content-length")
    request_limit = settings.max_file_bytes + 1024 * 1024 if request.url.path == "/api/files" else settings.max_entry_bytes + 8192
    if content_length and int(content_length) > request_limit:
        return JSONResponse(status_code=413, content={"detail": "Request body is too large."})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    return response


def csrf_token(request: Request) -> str:
    token = request.cookies.get(CSRF_COOKIE)
    return token if token else secrets.token_urlsafe(32)


def api_or_session_auth(request: Request, settings: Settings, write: bool = False) -> None:
    authorization = request.headers.get("authorization")
    if authorization:
        require_api_token(authorization=authorization, settings=settings)
        return
    if read_session(request, settings):
        if write:
            require_csrf(request, request.headers.get("x-csrf-token"))
        return
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request, settings: Settings = Depends(get_settings)):
    if not read_session(request, settings):
        return RedirectResponse("/login", status_code=status.HTTP_303_SEE_OTHER)
    token = csrf_token(request)
    response = templates.TemplateResponse("index.html", {"request": request, "csrf_token": token})
    response.set_cookie(CSRF_COOKIE, token, httponly=False, samesite="lax", secure=settings.session_secure)
    return response


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, settings: Settings = Depends(get_settings)):
    if read_session(request, settings):
        return RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    return templates.TemplateResponse("login.html", {"request": request, "error": None})


@app.post("/login", response_class=HTMLResponse)
async def login(
    request: Request,
    password: str = Form(...),
    settings: Settings = Depends(get_settings),
):
    client = request.client.host if request.client else "unknown"
    if not login_limiter.check(client, settings.login_rate_limit, settings.login_rate_window_seconds):
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Слишком много попыток. Попробуйте позже."},
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        )
    if not secrets.compare_digest(password, settings.app_password or ""):
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Неверный пароль."},
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    response = RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    response.set_cookie(
        SESSION_COOKIE,
        create_session_value(settings),
        httponly=True,
        samesite="lax",
        secure=settings.session_secure,
        max_age=settings.session_ttl_seconds,
    )
    response.set_cookie(CSRF_COOKIE, secrets.token_urlsafe(32), httponly=False, samesite="lax", secure=settings.session_secure)
    return response


@app.post("/logout")
async def logout(settings: Settings = Depends(get_settings)):
    response = RedirectResponse("/login", status_code=status.HTTP_303_SEE_OTHER)
    response.delete_cookie(SESSION_COOKIE, secure=settings.session_secure, samesite="lax")
    response.delete_cookie(CSRF_COOKIE, secure=settings.session_secure, samesite="lax")
    return response


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config", response_model=PublicConfig)
async def public_config(settings: Settings = Depends(get_settings)):
    return PublicConfig(
        max_entry_bytes=settings.max_entry_bytes,
        max_history_items=settings.max_history_items,
        retention_days=settings.retention_days,
        max_file_bytes=settings.max_file_bytes,
        max_file_storage_bytes=settings.max_file_storage_bytes,
    )


@app.get("/api/files", response_model=FileListOut)
async def api_files(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    api_or_session_auth(request, settings)
    return FileListOut(items=list_files(db), total_bytes=total_file_bytes(db))


@app.post("/api/files", response_model=FileOut, status_code=status.HTTP_201_CREATED)
async def api_upload_file(
    request: Request,
    upload: UploadFile = File(...),
    source: str | None = Form(None),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    api_or_session_auth(request, settings, write=True)
    entry = await save_file(db, upload, source, settings)
    await manager.broadcast("files_changed", {"id": entry.id})
    return entry


@app.get("/api/files/{file_id}/download")
async def api_download_file(
    file_id: int,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    api_or_session_auth(request, settings)
    entry = get_file(db, file_id)
    path = storage_dir(settings) / entry.stored_name
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File data not found")
    return FileResponse(path, media_type=entry.content_type, filename=entry.original_name)


@app.delete("/api/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def api_delete_file(
    file_id: int,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    api_or_session_auth(request, settings, write=True)
    delete_file(db, get_file(db, file_id), settings)
    await manager.broadcast("files_changed", {"id": file_id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/clipboard", response_model=ClipboardOut | None)
async def api_get_clipboard(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    api_or_session_auth(request, settings)
    return get_latest(db)


@app.post("/api/clipboard", response_model=ClipboardOut, status_code=status.HTTP_201_CREATED)
async def api_create_clipboard(
    payload: ClipboardIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    api_or_session_auth(request, settings, write=True)
    entry = create_entry(db, payload, settings)
    await manager.broadcast("clipboard_updated", serialize_entry(entry))
    return entry


@app.put("/api/clipboard/{entry_id}", response_model=ClipboardOut)
async def api_update_clipboard(
    entry_id: int,
    payload: ClipboardUpdate,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    api_or_session_auth(request, settings, write=True)
    entry = update_entry(db, entry_id, payload, settings)
    await manager.broadcast("clipboard_updated", serialize_entry(entry))
    return entry


@app.delete("/api/clipboard/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def api_delete_clipboard(
    entry_id: int,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    api_or_session_auth(request, settings, write=True)
    delete_entry(db, entry_id)
    await manager.broadcast("history_changed", None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/api/history", response_model=HistoryOut)
async def api_history(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    api_or_session_auth(request, settings)
    return HistoryOut(items=get_history(db, settings))


@app.delete("/api/history", status_code=status.HTTP_204_NO_CONTENT)
async def api_clear_history(request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    api_or_session_auth(request, settings, write=True)
    clear_history(db)
    await manager.broadcast("history_changed", None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    settings = get_settings()
    if not read_session_value(websocket.cookies.get(SESSION_COOKIE), settings):
        await websocket.close(code=1008)
        return
    await manager.connect(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > 65536:
                await websocket.close(code=1009)
                return
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event = message.get("event")
            payload = message.get("payload") or {}
            if event == "peer_register":
                await manager.register_peer(
                    websocket,
                    str(payload.get("name", "")),
                    str(payload.get("device_type", "desktop")),
                )
            elif event == "peer_signal" and isinstance(payload.get("signal"), dict):
                await manager.relay(websocket, str(payload.get("target", "")), payload["signal"])
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)
