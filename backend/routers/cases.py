from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

import storage
from classify import summarize_case_profile
from completeness import compute_checklist_summary, compute_financial_threshold_vnd
from db import get_db
from mappers import checklist_summary_to_dto, financial_threshold_to_dto
from models import Case, ChecklistItem
from schemas import (
    CaseAnalysisResponse,
    CaseDetailDTO,
    CaseListItemDTO,
    CreateCaseRequest,
    UpdateCaseRequest,
)

router = APIRouter(prefix="/cases", tags=["cases"])


@router.get("", response_model=list[CaseListItemDTO])
def list_cases(db: Session = Depends(get_db)):
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
                percent=summary.percent,
                needsReviewCount=summary.needs_review_count,
                financialThreshold=financial_threshold_to_dto(threshold),
            )
        )
    return result


@router.post("", response_model=CaseListItemDTO, status_code=201)
def create_case(body: CreateCaseRequest, db: Session = Depends(get_db)):
    case = Case(
        clientName=body.clientName,
        maritalStatus=body.maritalStatus,
        numberOfChildren=body.numberOfChildren,
        notes=body.notes,
    )
    db.add(case)
    db.commit()
    db.refresh(case)

    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)
    return CaseListItemDTO(
        id=case.id,
        clientName=case.clientName,
        maritalStatus=case.maritalStatus,
        numberOfChildren=case.numberOfChildren,
        notes=case.notes,
        createdAt=case.createdAt,
        percent=0,
        needsReviewCount=0,
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.get("/{case_id}", response_model=CaseDetailDTO)
def get_case(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)

    return CaseDetailDTO(
        case={
            "id": case.id,
            "clientName": case.clientName,
            "maritalStatus": case.maritalStatus,
            "numberOfChildren": case.numberOfChildren,
            "notes": case.notes,
            "createdAt": case.createdAt,
            "documents": sorted(case.documents, key=lambda d: d.uploadedAt),
        },
        checklist=checklist_summary_to_dto(summary),
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.post("/{case_id}/analyze", response_model=CaseAnalysisResponse)
def analyze_case(case_id: str, db: Session = Depends(get_db)):
    """Nút "Phân tích AI chuyên sâu" ở trang Tổng hợp thông tin — gộp text đã có sẵn (OCR +
    đã sửa lỗi) từ mọi file đã phân loại, nhờ DeepSeek viết 1 bản tóm tắt ngắn gọn. Không
    OCR lại, chỉ tổng hợp dữ liệu đã có trong DB nên nhanh hơn hẳn bước sửa lỗi OCR thô."""
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren
    )

    case_context = (
        f"Tên khách hàng: {case.clientName}\n"
        f"Tình trạng hôn nhân: {'Đã kết hôn' if case.maritalStatus == 'MARRIED' else 'Độc thân'}\n"
        f"Số con: {case.numberOfChildren}"
    )

    parts: list[str] = []
    for status in summary.items:
        for doc in status.matched_documents:
            text = doc.correctedText or doc.ocrText
            if text and text.strip():
                parts.append(f"[{status.item.nameVi}] ({doc.originalFilename})\n{text.strip()}")
    documents_text = "\n\n".join(parts)

    result, error = summarize_case_profile(case_context, documents_text)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return CaseAnalysisResponse(summary=result)


@router.patch("/{case_id}", response_model=CaseListItemDTO)
def update_case(case_id: str, body: UpdateCaseRequest, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    # exclude_unset: chỉ áp field nào thực sự có trong request body — sửa 1 field (vd chỉ
    # đổi tên) không vô tình xoá/ghi đè các field khác không được gửi lên.
    updates = body.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(case, field, value)

    db.commit()
    db.refresh(case)

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)

    return CaseListItemDTO(
        id=case.id,
        clientName=case.clientName,
        maritalStatus=case.maritalStatus,
        numberOfChildren=case.numberOfChildren,
        notes=case.notes,
        createdAt=case.createdAt,
        percent=summary.percent,
        needsReviewCount=summary.needs_review_count,
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.delete("/{case_id}")
def delete_case(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    # Xoá file trên MinIO của từng document trước — xoá Case ở DB sẽ cascade xoá các
    # Document row (đã cấu hình cascade="all, delete-orphan" trong models.py), nhưng
    # không tự xoá được file thật trên MinIO nên phải làm tay ở đây.
    for doc in case.documents:
        storage.delete_document(doc.storedPath)

    db.delete(case)
    db.commit()
    return {"ok": True}
