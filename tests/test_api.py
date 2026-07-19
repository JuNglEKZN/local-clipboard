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
    }
)

Path("/tmp/local_clipboard_test.db").unlink(missing_ok=True)

from fastapi.testclient import TestClient

from app.config import get_settings
from app.database import SessionLocal, init_db
from app.main import app
from app.models import ClipboardEntry


def client():
    get_settings.cache_clear()
    init_db()
    with SessionLocal() as db:
        db.query(ClipboardEntry).delete()
        db.commit()
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
