import os
from pathlib import Path

os.environ.update(
    {
        "DEV_MODE": "true",
        "APP_PASSWORD": "test-password",
        "API_TOKEN": "test-token",
        "SESSION_SECRET": "test-secret",
        "DATABASE_PATH": "/tmp/local_clipboard_test.db",
        "MAX_ENTRY_BYTES": "32",
        "MAX_HISTORY_ITEMS": "2",
        "RETENTION_DAYS": "30",
        "MAX_DATABASE_BYTES": "104857600",
        "FILE_STORAGE_PATH": "/tmp/local_clipboard_test_files",
        "MAX_FILE_BYTES": "32",
        "MAX_FILE_STORAGE_BYTES": "128",
    }
)

Path("/tmp/local_clipboard_test.db").unlink(missing_ok=True)

from fastapi.testclient import TestClient

from app.config import get_settings
from app.database import SessionLocal, init_db
from app.main import app
from app.models import ClipboardEntry, FileEntry


def client():
    get_settings.cache_clear()
    init_db()
    with SessionLocal() as db:
        db.query(ClipboardEntry).delete()
        db.query(FileEntry).delete()
        db.commit()
    file_dir = Path("/tmp/local_clipboard_test_files")
    file_dir.mkdir(exist_ok=True)
    for path in file_dir.iterdir():
        path.unlink()
    return TestClient(app)


def auth_headers():
    return {"Authorization": "Bearer test-token"}


def test_healthcheck_is_public():
    response = client().get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_create_and_get_clipboard_preserves_unicode():
    c = client()
    payload = {"text": "Привет\n  code 😊", "source": "pytest"}
    response = c.post("/api/clipboard", json=payload, headers=auth_headers())
    assert response.status_code == 201
    created = response.json()
    assert created["text"] == payload["text"]
    assert created["source"] == "pytest"
    assert created["size_bytes"] == len(payload["text"].encode("utf-8"))

    latest = c.get("/api/clipboard", headers=auth_headers()).json()
    assert latest["id"] == created["id"]
    assert latest["text"] == payload["text"]


def test_entry_size_limit_returns_413():
    response = client().post("/api/clipboard", json={"text": "x" * 33}, headers=auth_headers())
    assert response.status_code == 413


def test_history_limit_keeps_newest_items():
    c = client()
    for text in ["one", "two", "three"]:
        c.post("/api/clipboard", json={"text": text}, headers=auth_headers())
    response = c.get("/api/history", headers=auth_headers())
    assert response.status_code == 200
    assert [item["text"] for item in response.json()["items"]] == ["three", "two"]


def test_missing_token_is_unauthorized():
    response = client().get("/api/clipboard")
    assert response.status_code == 401


def test_upload_list_download_and_delete_file():
    c = client()
    content = "Привет".encode()
    response = c.post(
        "/api/files",
        files={"upload": ("отчёт.txt", content, "text/plain")},
        data={"source": "pytest"},
        headers=auth_headers(),
    )
    assert response.status_code == 201
    created = response.json()
    assert created["original_name"] == "отчёт.txt"
    assert created["size_bytes"] == len(content)

    listing = c.get("/api/files", headers=auth_headers()).json()
    assert listing["total_bytes"] == len(content)
    assert [item["id"] for item in listing["items"]] == [created["id"]]

    download = c.get(f"/api/files/{created['id']}/download", headers=auth_headers())
    assert download.status_code == 200
    assert download.content == content
    assert "attachment" in download.headers["content-disposition"]

    deleted = c.delete(f"/api/files/{created['id']}", headers=auth_headers())
    assert deleted.status_code == 204
    assert c.get("/api/files", headers=auth_headers()).json()["items"] == []


def test_file_size_limit_returns_413_and_leaves_no_file():
    c = client()
    response = c.post(
        "/api/files",
        files={"upload": ("large.bin", b"x" * 33, "application/octet-stream")},
        headers=auth_headers(),
    )
    assert response.status_code == 413
    assert c.get("/api/files", headers=auth_headers()).json()["items"] == []
    assert list(Path("/tmp/local_clipboard_test_files").iterdir()) == []
