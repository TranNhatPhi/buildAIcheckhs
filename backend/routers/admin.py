import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import storage
from admin_auth import require_admin
from case_status import FINAL_CASE_STATUSES, case_status_fields, next_status_reminder_at
from completeness import compute_checklist_summary, compute_financial_threshold_vnd
from db import get_db
from doc_checks import dem_han_tai_lieu
from mappers import financial_threshold_to_dto
from models import Case, ChecklistItem, Document, EmailLog, now_utc
from schemas import (
    AdminDocumentDTO,
    AdminStatsDTO,
    CaseListItemDTO,
    DocumentDTO,
    EmailLogDTO,
    parse_tags,
)

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/cases", response_model=list[CaseListItemDTO])
def list_all_cases(db: Session = Depends(get_db)):
    # Không lọc deletedAt như list_cases (cases.py) — admin cần thấy CẢ hồ sơ đã xoá mềm.
    cases = db.scalars(select(Case).order_by(Case.createdAt.desc())).all()
    checklist_items = db.scalars(select(ChecklistItem)).all()

    result = []
    for c in cases:
        summary = compute_checklist_summary(
            checklist_items, c.documents, c.maritalStatus, c.numberOfChildren, c.skillLevel
        )
        threshold = compute_financial_threshold_vnd(c.maritalStatus, c.numberOfChildren)
        qua_han, sap_han = dem_han_tai_lieu(c.documents)
        result.append(
            CaseListItemDTO(
                id=c.id,
                clientName=c.clientName,
                maritalStatus=c.maritalStatus,
                numberOfChildren=c.numberOfChildren,
                skillLevel=c.skillLevel,
                notes=c.notes,
                tags=parse_tags(c.tags),
                createdAt=c.createdAt,
                deletedAt=c.deletedAt,
                **case_status_fields(c),
                percent=summary.percent,
                needsReviewCount=summary.needs_review_count,
                financialThreshold=financial_threshold_to_dto(threshold),
                expiredDocCount=qua_han,
                expiringSoonDocCount=sap_han,
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
    active_non_final_cases = db.scalars(
        select(Case).where(
            Case.deletedAt.is_(None),
            Case.applicationStatus.not_in(FINAL_CASE_STATUSES),
        )
    ).all()
    utc_now = now_utc()
    reminders_due = sum(
        1
        for case in active_non_final_cases
        if (next_due := next_status_reminder_at(case)) is not None and next_due <= utc_now
    )

    # Ba nhóm số liệu dưới đây đều tính trên hồ sơ CHƯA xoá mềm: đây là số liệu để biết
    # "còn việc gì phải làm", mà hồ sơ đã xoá thì không còn việc gì.
    # Phân bố trạng thái gom bằng GROUP BY chứ không đếm trong Python: chỉ 1 query trả về
    # đúng 10 dòng, thay vì kéo cả bảng Case về rồi lặp.
    cases_by_status = {
        status: count
        for status, count in db.execute(
            select(Case.applicationStatus, func.count())
            .where(Case.deletedAt.is_(None))
            .group_by(Case.applicationStatus)
        ).all()
    }

    # Nhãn và hạn giấy tờ thì phải duyệt object: nhãn lưu dạng chuỗi JSON trong 1 cột (không
    # GROUP BY được), còn hạn thì phải chạy danh_gia_han trên từng file.
    live_cases = db.scalars(select(Case).where(Case.deletedAt.is_(None))).all()
    cases_by_tag: dict[str, int] = {}
    expired_docs = expiring_soon_docs = 0
    for case in live_cases:
        for tag in parse_tags(case.tags):
            cases_by_tag[tag] = cases_by_tag.get(tag, 0) + 1
        qua_han, sap_han = dem_han_tai_lieu(case.documents)
        expired_docs += qua_han
        expiring_soon_docs += sap_han

    return AdminStatsDTO(
        totalCases=active_cases + deleted_cases,
        activeCases=active_cases,
        deletedCases=deleted_cases,
        needsReviewDocuments=needs_review,
        errorDocuments=errors,
        pendingDecisionCases=len(active_non_final_cases),
        statusRemindersDue=reminders_due,
        expiredDocuments=expired_docs,
        expiringSoonDocuments=expiring_soon_docs,
        casesByStatus=cases_by_status,
        casesByTag=cases_by_tag,
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


@router.get("/email-logs", response_model=list[EmailLogDTO])
def list_email_logs(limit: int = 200, db: Session = Depends(get_db)):
    """Nhật ký email đã gửi, mới nhất trước.

    Có `limit` vì bảng này chỉ tăng chứ không bao giờ giảm — một hồ sơ chạy hết vòng đời có
    thể sinh hàng chục email, trả về tất cả sẽ ngày càng nặng mà không ai đọc tới cuối.
    """
    logs = db.scalars(
        select(EmailLog).order_by(EmailLog.createdAt.desc()).limit(max(1, min(limit, 1000)))
    ).all()

    result = []
    for log in logs:
        # Nhật ký cũ / dòng ghi lỗi có thể không có casesJson hợp lệ — nhật ký hỏng một dòng
        # không được phép làm chết cả trang, nên bọc lại và trả về mảng rỗng.
        try:
            rows = json.loads(log.casesJson) if log.casesJson else []
        except (TypeError, ValueError):
            rows = []
        result.append(
            EmailLogDTO(
                id=log.id,
                createdAt=log.createdAt,
                trigger=log.trigger,
                caseId=log.caseId,
                caseClientName=log.caseClientName,
                applicationStatus=log.applicationStatus,
                title=log.title,
                intro=log.intro,
                footer=log.footer,
                cases=rows,
                recipient=log.recipient,
                status=log.status,
                errorMessage=log.errorMessage,
            )
        )
    return result
