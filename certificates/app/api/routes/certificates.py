import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import DatabaseConfigurationError, check_database_connection, get_db
from app.errors import ApiError, problem_docs
from app.schemas.certificate import CertificateList, HealthStatus
from app.security import current_user_id
from app.services.certificate_service import CertificateNotFoundError, CertificateService
from app.services.storage import BlobStorage, CertificateStorageError, get_storage

log = logging.getLogger(__name__)

router = APIRouter()


@router.get(
    "/healthcheck",
    tags=["health"],
    summary="Database connectivity check",
    response_model=HealthStatus,
    responses={503: {"description": "The database is not configured or not reachable"}},
)
def healthcheck() -> dict[str, str]:
    try:
        check_database_connection()
    except (DatabaseConfigurationError, SQLAlchemyError):
        raise HTTPException(status_code=503, detail="unhealthy") from None

    return {"status": "ok"}


def get_service(
    session: Session = Depends(get_db),
    storage: BlobStorage = Depends(get_storage),
) -> CertificateService:
    return CertificateService(session, storage)


@router.get(
    "/api/v1/certificates/me",
    tags=["certificates"],
    summary="List the caller's certificates, newest first",
    response_model=CertificateList,
    responses=problem_docs(400, 401, 503),
)
def list_my_certificates(
    user_id: uuid.UUID = Depends(current_user_id),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    service: CertificateService = Depends(get_service),
) -> CertificateList:
    certificates = service.list_user_certificates(user_id, limit=limit, offset=offset)
    return CertificateList.model_validate({"certificates": certificates})


@router.get(
    "/api/v1/certificates/{certificate_id}",
    tags=["certificates"],
    summary="Download a certificate PDF (owner only)",
    response_class=Response,
    responses={
        200: {
            "description": "The certificate as a PDF attachment",
            "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}},
        },
        **problem_docs(400, 401, 404, 503),
    },
)
def download_certificate(
    certificate_id: uuid.UUID,
    user_id: uuid.UUID = Depends(current_user_id),
    service: CertificateService = Depends(get_service),
) -> Response:
    try:
        certificate, pdf_bytes = service.get_certificate_pdf(certificate_id, owner_id=user_id)
    except CertificateNotFoundError:
        # Same answer for "does not exist" and "belongs to someone else": no enumeration.
        raise ApiError(404, "NOT_FOUND") from None
    except (FileNotFoundError, ValueError):
        # The row exists but the blob does not (or its key is invalid): a server-side fault, not a client one.
        log.error("certificate_blob_missing certificate_id=%s", certificate_id)
        raise CertificateStorageError("Certificate file is unavailable") from None

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="certificate-{certificate.id}.pdf"'},
    )
