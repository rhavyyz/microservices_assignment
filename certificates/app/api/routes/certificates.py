from fastapi import APIRouter, HTTPException
from sqlalchemy.exc import SQLAlchemyError

from app.database import DatabaseConfigurationError, check_database_connection

router = APIRouter()


@router.get("/healthcheck", tags=["health"])
def healthcheck() -> dict[str, str]:
    try:
        check_database_connection()
    except (DatabaseConfigurationError, SQLAlchemyError):
        raise HTTPException(status_code=503, detail="unhealthy") from None

    return {"status": "ok"}
