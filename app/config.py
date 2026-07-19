from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_host: str = Field("0.0.0.0", alias="APP_HOST")
    app_port: int = Field(8080, alias="APP_PORT")
    app_password: str | None = Field(None, alias="APP_PASSWORD")
    api_token: str | None = Field(None, alias="API_TOKEN")
    session_secret: str | None = Field(None, alias="SESSION_SECRET")
    session_secure: bool = Field(False, alias="SESSION_SECURE")
    session_ttl_seconds: int = Field(60 * 60 * 24 * 7, alias="SESSION_TTL_SECONDS")
    max_entry_bytes: int = Field(512000, alias="MAX_ENTRY_BYTES")
    max_history_items: int = Field(50, alias="MAX_HISTORY_ITEMS")
    retention_days: int = Field(30, alias="RETENTION_DAYS")
    max_database_bytes: int = Field(104857600, alias="MAX_DATABASE_BYTES")
    database_path: str = Field("/data/clipboard.db", alias="DATABASE_PATH")
    timezone: str = Field("Europe/Amsterdam", alias="TIMEZONE")
    dev_mode: bool = Field(False, alias="DEV_MODE")
    login_rate_limit: int = Field(8, alias="LOGIN_RATE_LIMIT")
    login_rate_window_seconds: int = Field(300, alias="LOGIN_RATE_WINDOW_SECONDS")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)

    @field_validator("max_entry_bytes", "max_history_items", "retention_days", "max_database_bytes", "session_ttl_seconds")
    @classmethod
    def must_be_positive(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("value must be positive")
        return value

    def validate_startup_secrets(self) -> None:
        insecure = {"", "change-me", None}
        missing = [
            name
            for name, value in {
                "APP_PASSWORD": self.app_password,
                "API_TOKEN": self.api_token,
                "SESSION_SECRET": self.session_secret,
            }.items()
            if value in insecure
        ]
        if missing and not self.dev_mode:
            raise RuntimeError(
                "Refusing to start without secure secrets: "
                + ", ".join(missing)
                + ". Set DEV_MODE=true only for local development."
            )

    @property
    def database_url(self) -> str:
        path = Path(self.database_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{path}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
