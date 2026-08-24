from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

import storage
from classify import summarize_case_profile
from completeness import compute_checklist_summary, compute_financial_threshold_vnd
from db import get_db
from mappers import checklist_summary_to_dto, financial_threshold_to_dto
from models import Case, ChecklistItem, now_utc
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
            "aiAnalysisStatus": case.aiAnalysisStatus,
            "aiAnalysisSummary": case.aiAnalysisSummary,
            "aiAnalysisError": case.aiAnalysisError,
            "aiAnalysisUpdatedAt": case.aiAnalysisUpdatedAt,
        },
        checklist=checklist_summary_to_dto(summary),
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.post("/{case_id}/analyze", response_model=CaseAnalysisResponse)
def analyze_case(case_id: str, db: Session = Depends(get_db)):
    # Ghi status/kết quả vào Case NGAY CẢ KHI client đã ngắt kết nối giữa chừng (vd bấm F5)
    # — hàm `def` thường chạy trong threadpool riêng của request đó, không bị huỷ khi
    # client đóng kết nối, nên vẫn chạy tới cùng và commit bình thường; GET /cases/{id} từ
    # lần tải lại trang sau đó sẽ thấy đúng status/kết quả mới nhất thay vì mất trắng như
    # trước (kết quả trước đây chỉ nằm trong state React, mất theo mỗi lần F5). Có thể mất
    # 1-4 phút với hồ sơ nhiều file — xem SUMMARY_MAX_TOKENS ở classify.py.
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
            # Ưu tiên bản nhân viên đã tự sửa tay (nếu có) — đây là bản đã được xác nhận
            # đúng, đáng tin hơn bản AI tự sinh khi phân tích chéo giữa các giấy tờ.
            text = doc.manualCorrectedText or doc.correctedText or doc.ocrText
            if text and text.strip():
                parts.append(f"[{status.item.nameVi}] ({doc.originalFilename})\n{text.strip()}")
    documents_text = "\n\n".join(parts)

    if not documents_text.strip():
        raise HTTPException(
            status_code=400, detail="Chưa có file nào được phân loại — chưa có dữ liệu để phân tích."
        )

    case.aiAnalysisStatus = "RUNNING"
    case.aiAnalysisError = None
    db.commit()

    result, error = summarize_case_profile(case_context, documents_text)

    # Không có cách nào huỷ NGANG cuộc gọi DeepSeek đang chạy trong thread này (blocking
    # I/O, không phải async task có thể cancel) — nếu nhân viên đã bấm "Huỷ" trong lúc chờ
    # (xem /analyze/cancel bên dưới), status trong DB đã bị ghi đè thành CANCELLED từ 1
    # request khác. refresh() để đọc lại status MỚI NHẤT trước khi quyết định có ghi kết
    # quả hay không — tránh việc kết quả đến trễ "hồi sinh" lại 1 lượt phân tích nhân viên
    # đã chủ động huỷ, làm họ bất ngờ thấy kết quả bật ra sau khi tưởng đã huỷ xong.
    db.refresh(case)
    if case.aiAnalysisStatus == "CANCELLED":
        raise HTTPException(status_code=409, detail="Đã huỷ phân tích.")

    if error:
        case.aiAnalysisStatus = "ERROR"
        case.aiAnalysisError = error
        case.aiAnalysisUpdatedAt = now_utc()
        db.commit()
        raise HTTPException(status_code=400, detail=error)

    case.aiAnalysisStatus = "DONE"
    case.aiAnalysisSummary = result
    case.aiAnalysisError = None
    case.aiAnalysisUpdatedAt = now_utc()
    db.commit()
    return CaseAnalysisResponse(summary=result)


@router.post("/{case_id}/analyze/cancel")
def cancel_analyze_case(case_id: str, db: Session = Depends(get_db)):
    """Nhân viên bấm "Huỷ" trong lúc đang chờ "Phân tích AI chuyên sâu". CHỈ đổi status
    trong DB — không (và không thể) chặn cuộc gọi DeepSeek đang chạy trong thread khác,
    xem comment ở analyze_case về cách kết quả đến trễ được bỏ qua khi status đã CANCELLED."""
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    if case.aiAnalysisStatus == "RUNNING":
        case.aiAnalysisStatus = "CANCELLED"
        case.aiAnalysisUpdatedAt = now_utc()
        db.commit()
    return {"ok": True}


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
