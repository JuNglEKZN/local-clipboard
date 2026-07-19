import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import Settings, get_settings


SESSION_COOKIE = "local_clipboard_session"
CSRF_COOKIE = "local_clipboard_csrf"
CSRF_HEADER = "x-csrf-token"


def get_serializer(settings: Settings) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.session_secret or "dev-secret", salt="local-clipboard-session")


def create_session_value(settings: Settings) -> str:
    return get_serializer(settings).dumps({"authenticated": True, "nonce": secrets.token_urlsafe(16)})


def read_session(request: Request, settings: Settings) -> bool:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return False
    try:
        data = get_serializer(settings).loads(raw, max_age=settings.session_ttl_seconds)
    except (BadSignature, SignatureExpired):
        return False
    return bool(data.get("authenticated"))


def require_web_auth(request: Request, settings: Settings = Depends(get_settings)) -> None:
    if not read_session(request, settings):
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/login"})


def require_api_token(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization[7:].strip()
    if not secrets.compare_digest(token, settings.api_token or ""):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token")


def require_csrf(request: Request, x_csrf_token: str | None = Header(default=None, alias=CSRF_HEADER)) -> None:
    cookie = request.cookies.get(CSRF_COOKIE)
    if not cookie or not x_csrf_token or not secrets.compare_digest(cookie, x_csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token")


@dataclass
class LoginLimiter:
    attempts: dict[str, deque[float]]

    def __init__(self) -> None:
        self.attempts = defaultdict(deque)

    def check(self, key: str, limit: int, window: int) -> bool:
        now = time.monotonic()
        bucket = self.attempts[key]
        while bucket and now - bucket[0] > window:
            bucket.popleft()
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        return True


login_limiter = LoginLimiter()
