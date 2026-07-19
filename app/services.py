from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import ClipboardEntry
from app.schemas import ClipboardIn, ClipboardUpdate


def now_in_timezone(settings: Settings) -> datetime:
    try:
        zone = ZoneInfo(settings.timezone)
    except Exception:
        zone = ZoneInfo("UTC")
    return datetime.now(zone)


def as_aware(value: datetime, settings: Settings) -> datetime:
    if value.tzinfo is not None:
        return value
    try:
        zone = ZoneInfo(settings.timezone)
    except Exception:
        zone = ZoneInfo("UTC")
    return value.replace(tzinfo=zone)


def text_size(text: str) -> int:
    return len(text.encode("utf-8"))


def validate_entry_size(text: str, settings: Settings) -> int:
    size = text_size(text)
    if size > settings.max_entry_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Text is too large. Maximum size is {settings.max_entry_bytes} bytes.",
        )
    return size


def serialize_entry(entry: ClipboardEntry) -> dict:
    settings = get_settings()
    return {
        "id": entry.id,
        "text": entry.text,
        "created_at": as_aware(entry.created_at, settings).isoformat(),
        "updated_at": as_aware(entry.updated_at, settings).isoformat(),
        "size_bytes": entry.size_bytes,
        "source": entry.source,
    }


def get_latest(db: Session) -> ClipboardEntry | None:
    return db.scalar(select(ClipboardEntry).order_by(desc(ClipboardEntry.updated_at), desc(ClipboardEntry.id)).limit(1))


def get_history(db: Session, settings: Settings) -> list[ClipboardEntry]:
    return list(db.scalars(select(ClipboardEntry).order_by(desc(ClipboardEntry.updated_at), desc(ClipboardEntry.id)).limit(settings.max_history_items)))


def create_entry(db: Session, payload: ClipboardIn, settings: Settings) -> ClipboardEntry:
    size = validate_entry_size(payload.text, settings)
    timestamp = now_in_timezone(settings)
    entry = ClipboardEntry(
        text=payload.text,
        created_at=timestamp,
        updated_at=timestamp,
        size_bytes=size,
        source=payload.source,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    cleanup_history(db, settings)
    db.refresh(entry)
    return entry


def update_entry(db: Session, entry_id: int, payload: ClipboardUpdate, settings: Settings) -> ClipboardEntry:
    entry = db.get(ClipboardEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    entry.text = payload.text
    entry.size_bytes = validate_entry_size(payload.text, settings)
    entry.source = payload.source
    entry.updated_at = now_in_timezone(settings)
    db.commit()
    db.refresh(entry)
    cleanup_history(db, settings)
    db.refresh(entry)
    return entry


def delete_entry(db: Session, entry_id: int) -> None:
    entry = db.get(ClipboardEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Entry not found")
    db.delete(entry)
    db.commit()


def clear_history(db: Session) -> None:
    db.query(ClipboardEntry).delete()
    db.commit()


def cleanup_history(db: Session, settings: Settings) -> None:
    latest = get_latest(db)
    if latest is None:
        return
    latest_id = latest.id
    cutoff = now_in_timezone(settings).timestamp() - settings.retention_days * 86400

    entries = list(db.scalars(select(ClipboardEntry).order_by(desc(ClipboardEntry.updated_at), desc(ClipboardEntry.id))))
    for entry in entries:
        if entry.id != latest_id and as_aware(entry.updated_at, settings).timestamp() < cutoff:
            db.delete(entry)
    db.commit()

    entries = list(db.scalars(select(ClipboardEntry).order_by(desc(ClipboardEntry.updated_at), desc(ClipboardEntry.id))))
    for entry in entries[settings.max_history_items :]:
        if entry.id != latest_id:
            db.delete(entry)
    db.commit()

    enforce_database_size(db, settings, latest_id)


def enforce_database_size(db: Session, settings: Settings, latest_id: int) -> None:
    db_path = Path(settings.database_path)
    if not db_path.exists() or sqlite_total_size(db_path) <= settings.max_database_bytes:
        return
    removable = list(db.scalars(select(ClipboardEntry).where(ClipboardEntry.id != latest_id).order_by(ClipboardEntry.updated_at)))
    for entry in removable:
        if sqlite_total_size(db_path) <= settings.max_database_bytes:
            break
        db.delete(entry)
        db.commit()


def count_entries(db: Session) -> int:
    return int(db.scalar(select(func.count(ClipboardEntry.id))) or 0)


def sqlite_total_size(db_path: Path) -> int:
    return sum(path.stat().st_size for path in [db_path, db_path.with_name(db_path.name + "-wal"), db_path.with_name(db_path.name + "-shm")] if path.exists())
