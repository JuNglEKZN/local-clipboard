from datetime import datetime

from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_serializer

from app.config import get_settings


class ClipboardIn(BaseModel):
    text: str = Field(...)
    source: str | None = Field(None, max_length=120)


class ClipboardUpdate(BaseModel):
    text: str = Field(...)
    source: str | None = Field(None, max_length=120)


class ClipboardOut(BaseModel):
    id: int
    text: str
    created_at: datetime
    updated_at: datetime
    size_bytes: int
    source: str | None = None

    model_config = ConfigDict(from_attributes=True)

    @field_serializer("created_at", "updated_at")
    def serialize_datetime(self, value: datetime) -> str:
        settings = get_settings()
        try:
            zone = ZoneInfo(settings.timezone)
        except Exception:
            zone = ZoneInfo("UTC")
        if value.tzinfo is None:
            value = value.replace(tzinfo=zone)
        return value.isoformat()


class HistoryOut(BaseModel):
    items: list[ClipboardOut]


class PublicConfig(BaseModel):
    max_entry_bytes: int
    max_history_items: int
    retention_days: int


class ErrorMessage(BaseModel):
    detail: str
