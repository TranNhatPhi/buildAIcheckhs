from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import storage
from admin_auth import require_admin
from completeness import compute_checklist_summary, compute_financial_threshold_vnd
from db import get_db
from mappers import financial_threshold_to_dto
from models import Case, ChecklistItem, Document
from schemas import AdminDocumentDTO, AdminStatsDTO, CaseListItemDTO, DocumentDTO

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/cases", response_model=list[CaseListItemDTO])
def list_all_cases(db: Session = Depends(get_db)):
    # Không lọc deletedAt như list_cases (cases.py) — admin cần thấy CẢ hồ sơ đã xoá mềm.
    cases = db.scalars(select(Case).order_by(Case.createdAt.desc())).all()
    checklist_items = db.scalars(select(ChecklistItem)).all()

    result = []
    for c in cases:
        summary = compute_checklist_summary(checklist_items, c.documents, c.maritalStatus, c.numberOfChildren)
        threshold = compute_financial_threshold_vnd(c.maritalStatus, c.numberOfChildren)
        result.append(
            CaseListItemDTO(
                id=c.id,
                clientName=c.clientName,
                maritalStatus=c.maritalStatus,
                numberOfChildren=c.numberOfChildren,
                notes=c.notes,
                createdAt=c.createdAt,
                deletedAt=c.deletedAt,
                percent=summary.percent,
                needsReviewCount=summary.needs_review_count,
                financialThreshold=financial_threshold_to_dto(threshold),
            )
        )
    return result


@router.get("/stats", response_model=AdminStatsDTO)
def get_stats(db: Session = Depends(get_db)):
    active_cases = db.scalar(select(func.count()).select_from(Case).where(Case.deletedAt.is_(None)))
    deleted_cases = db.scalar(select(func.count()).select_from(Case).where(Case.deletedAt.is_not(None)))
    needs_review = db.scalar(
        select(func.count()).select_from(Document).where(Document.status == "NEEDS_REVIEW")
    )
    errors = db.scalar(select(func.count()).select_from(Document).where(Document.status == "ERROR"))

    return AdminStatsDTO(
        totalCases=active_cases + deleted_cases,
        activeCases=active_cases,
        deletedCases=deleted_cases,
        needsReviewDocuments=needs_review,
        errorDocuments=errors,
    )


@router.get("/documents", response_model=list[AdminDocumentDTO])
def list_all_documents(db: Session = Depends(get_db)):
    # Tất cả tài liệu, mọi case (kể cả case đã xoá mềm) — sắp xếp mới nhất trước để nhân
    # viên thấy ngay hoạt động upload gần đây nhất.
    documents = db.scalars(select(Document).order_by(Document.uploadedAt.desc())).all()
    return [
        AdminDocumentDTO(
            **DocumentDTO.model_validate(d).model_dump(),
            caseClientName=d.case.clientName,
            caseDeletedAt=d.case.deletedAt,
        )
        for d in documents
    ]


@router.delete("/cases/{case_id}/permanent")
def permanently_delete_case(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    if case.deletedAt is None:
        raise HTTPException(
            status_code=400, detail="Chỉ xoá vĩnh viễn được hồ sơ đã xoá mềm trước đó"
        )

    for doc in case.documents:
        storage.delete_document(doc.storedPath)
    db.delete(case)  # cascade="all, delete-orphan" (models.py) tự xoá các Document liên quan
    db.commit()
    return {"ok": True}
