import re
import unicodedata
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import FileEntry
from app.services import now_in_timezone


CHUNK_SIZE = 1024 * 1024


def safe_original_name(value: str | None) -> str:
    name = Path((value or "file").replace("\\", "/")).name
    name = unicodedata.normalize("NFC", name).strip().replace("\x00", "")
    name = re.sub(r"[\r\n]", "", name)
    if not name or name in {".", ".."}:
        return "file"
    return name[:255]


def storage_dir(settings: Settings) -> Path:
    path = Path(settings.file_storage_path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def total_file_bytes(db: Session) -> int:
    return int(db.scalar(select(func.sum(FileEntry.size_bytes))) or 0)


def list_files(db: Session) -> list[FileEntry]:
    return list(db.scalars(select(FileEntry).order_by(desc(FileEntry.created_at), desc(FileEntry.id))))


def get_file(db: Session, file_id: int) -> FileEntry:
    entry = db.get(FileEntry, file_id)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return entry


async def save_file(db: Session, upload: UploadFile, source: str | None, settings: Settings) -> FileEntry:
    directory = storage_dir(settings)
    stored_name = uuid4().hex
    final_path = directory / stored_name
    temp_path = directory / f".{stored_name}.upload"
    size = 0

    try:
        with temp_path.open("xb") as destination:
            while chunk := await upload.read(CHUNK_SIZE):
                size += len(chunk)
                if size > settings.max_file_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"File is too large. Maximum size is {settings.max_file_bytes} bytes.",
                    )
                destination.write(chunk)

        if total_file_bytes(db) + size > settings.max_file_storage_bytes:
            raise HTTPException(
                status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
                detail="File storage limit reached.",
            )

        temp_path.replace(final_path)
        entry = FileEntry(
            original_name=safe_original_name(upload.filename),
            stored_name=stored_name,
            content_type=(upload.content_type or "application/octet-stream")[:255],
            size_bytes=size,
            created_at=now_in_timezone(settings),
            source=(source[:120] if source else None),
        )
        db.add(entry)
        db.commit()
        db.refresh(entry)
        return entry
    except Exception:
        temp_path.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def delete_file(db: Session, entry: FileEntry, settings: Settings) -> None:
    path = storage_dir(settings) / entry.stored_name
    db.delete(entry)
    db.commit()
    path.unlink(missing_ok=True)
