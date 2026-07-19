from sqlalchemy.orm import Session

from app.config import Settings
from app.services import cleanup_history


def run_cleanup(db: Session, settings: Settings) -> None:
    cleanup_history(db, settings)
