import io
import re
import urllib.parse
import zipfile

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

import pdf_export
import storage
from admin_auth import require_admin
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
    cases = db.scalars(
        select(Case).where(Case.deletedAt.is_(None)).order_by(Case.createdAt.desc())
    ).all()
    checklist_items = db.scalars(select(ChecklistItem)).all()

    result = []
    for c in cases:
        summary = compute_checklist_summary(
            checklist_items, c.documents, c.maritalStatus, c.numberOfChildren, c.skillLevel
        )
        threshold = compute_financial_threshold_vnd(c.maritalStatus, c.numberOfChildren)
        result.append(
            CaseListItemDTO(
                id=c.id,
                clientName=c.clientName,
                maritalStatus=c.maritalStatus,
                numberOfChildren=c.numberOfChildren,
                skillLevel=c.skillLevel,
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
        skillLevel=body.skillLevel,
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
        skillLevel=case.skillLevel,
        notes=case.notes,
        createdAt=case.createdAt,
        percent=0,
        needsReviewCount=0,
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.get("/deleted", response_model=list[CaseListItemDTO], dependencies=[Depends(require_admin)])
def list_deleted_cases(db: Session = Depends(get_db)):
    """Danh sách hồ sơ đã xoá mềm — dành cho giao diện admin (khôi phục) sau này. Đặt route
    literal "/deleted" TRƯỚC route "/{case_id}" bên dưới, nếu không FastAPI sẽ hiểu nhầm
    "deleted" là 1 case_id thay vì khớp đúng route này."""
    cases = db.scalars(
        select(Case).where(Case.deletedAt.is_not(None)).order_by(Case.deletedAt.desc())
    ).all()
    checklist_items = db.scalars(select(ChecklistItem)).all()

    result = []
    for c in cases:
        summary = compute_checklist_summary(
            checklist_items, c.documents, c.maritalStatus, c.numberOfChildren, c.skillLevel
        )
        threshold = compute_financial_threshold_vnd(c.maritalStatus, c.numberOfChildren)
        result.append(
            CaseListItemDTO(
                id=c.id,
                clientName=c.clientName,
                maritalStatus=c.maritalStatus,
                numberOfChildren=c.numberOfChildren,
                skillLevel=c.skillLevel,
                notes=c.notes,
                createdAt=c.createdAt,
                deletedAt=c.deletedAt,
                percent=summary.percent,
                needsReviewCount=summary.needs_review_count,
                financialThreshold=financial_threshold_to_dto(threshold),
            )
        )
    return result


@router.post("/{case_id}/restore", response_model=CaseListItemDTO, dependencies=[Depends(require_admin)])
def restore_case(case_id: str, db: Session = Depends(get_db)):
    """Khôi phục hồ sơ đã xoá mềm — chưa có nút trên UI hiện tại, dành cho giao diện admin
    sau này (xem GET /cases/deleted). Toàn bộ document/file trên MinIO vẫn còn nguyên vì
    delete_case chỉ đánh dấu deletedAt, không xoá thật gì cả."""
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    if case.deletedAt is None:
        raise HTTPException(status_code=400, detail="Hồ sơ này chưa bị xoá")

    case.deletedAt = None
    db.commit()
    db.refresh(case)

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren, case.skillLevel
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)
    return CaseListItemDTO(
        id=case.id,
        clientName=case.clientName,
        maritalStatus=case.maritalStatus,
        numberOfChildren=case.numberOfChildren,
        skillLevel=case.skillLevel,
        notes=case.notes,
        createdAt=case.createdAt,
        percent=summary.percent,
        needsReviewCount=summary.needs_review_count,
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.get("/{case_id}", response_model=CaseDetailDTO)
def get_case(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren, case.skillLevel
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)

    return CaseDetailDTO(
        case={
            "id": case.id,
            "clientName": case.clientName,
            "maritalStatus": case.maritalStatus,
            "numberOfChildren": case.numberOfChildren,
            "skillLevel": case.skillLevel,
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
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren, case.skillLevel
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

    # Danh sách giấy tờ CHƯA nộp — tính thẳng từ checklist đã có sẵn (summary), KHÔNG nhờ
    # DeepSeek suy ra, vì model chỉ thấy được text của các file ĐÃ NỘP, không thể biết mục
    # nào của checklist còn thiếu. In đậm tên từng mục (giống cách DeepSeek tô sáng giá trị
    # cần chú ý ở mục 3/4) để nhân viên lướt nhanh là thấy ngay.
    missing_items = [s for s in summary.items if not s.item.isOptional and not s.complete]
    if missing_items:
        missing_lines = "\n".join(
            f"- **{s.item.nameVi}**"
            + (f" ({s.fulfilled_count}/{s.required_count} đã có)" if s.required_count > 1 else "")
            for s in missing_items
        )
    else:
        missing_lines = "- Đã nộp đủ tất cả mục bắt buộc trong checklist."
    missing_section = f"3. GIẤY TỜ CHƯA NỘP THEO CHECKLIST\n{missing_lines}"

    # Chèn ngay sau mục 2 (danh sách giấy tờ ĐÃ nộp) thay vì để cuối bài — nhân viên đọc 2
    # danh sách "đã nộp"/"chưa nộp" liền nhau dễ đối chiếu hơn. Đổi số thứ tự các mục còn
    # lại của DeepSeek (3→4, 4→5, 5→6) để nhường chỗ — đổi THEO THỨ TỰ NGƯỢC (5 trước, 3
    # sau) để không bị đè số vừa đổi (đổi 3→4 trước thì bước đổi 4→5 sẽ ăn nhầm luôn mục
    # vừa đổi thành 5→6 sai).
    renumbered = re.sub(r"(?m)^5\.", "6.", result)
    renumbered = re.sub(r"(?m)^4\.", "5.", renumbered)
    renumbered = re.sub(r"(?m)^3\.", "4.", renumbered)
    insertion_marker = re.search(r"(?m)^4\.\s", renumbered)
    if insertion_marker:
        idx = insertion_marker.start()
        result = f"{renumbered[:idx]}{missing_section}\n\n{renumbered[idx:]}"
    else:
        # DeepSeek không theo đúng format tiêu đề mong đợi (hiếm) — vẫn đảm bảo thông tin
        # không mất, đành nối vào cuối như trước thay vì chèn giữa.
        result = f"{result}\n\n{missing_section}"

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


def _dedupe_filename(name: str, used_names: set[str]) -> str:
    if name not in used_names:
        used_names.add(name)
        return name
    stem, dot, ext = name.rpartition(".")
    counter = 1
    while True:
        candidate = f"{stem} ({counter}).{ext}" if dot else f"{name} ({counter})"
        if candidate not in used_names:
            used_names.add(candidate)
            return candidate
        counter += 1


@router.get("/{case_id}/download-all")
def download_all_documents(case_id: str, db: Session = Depends(get_db)):
    """Nút "Tải tất cả hồ sơ" ở trang Tổng hợp thông tin — gộp toàn bộ file gốc (PDF/ảnh)
    khách hàng đã upload cùng bản "Phân tích AI chuyên sâu" (nếu đã chạy) thành 1 file ZIP
    duy nhất để nhân viên tải về máy cá nhân, khỏi phải tải tay từng file một."""
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    buffer = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for doc in sorted(case.documents, key=lambda d: d.uploadedAt):
            try:
                content = storage.get_document_bytes(doc.storedPath)
            except Exception:  # noqa: BLE001
                continue
            name = _dedupe_filename(doc.originalFilename or "file", used_names)
            zf.writestr(name, content)

        if case.aiAnalysisSummary:
            pdf_bytes = pdf_export.render_text_to_pdf(
                case.aiAnalysisSummary, f"Phân tích AI chuyên sâu — {case.clientName}"
            )
        else:
            pdf_bytes = None

        if pdf_bytes is not None:
            zf.writestr(_dedupe_filename("Phan tich AI chuyen sau.pdf", used_names), pdf_bytes)
        else:
            # Không tìm được font Unicode để xuất PDF (xem pdf_export.py), hoặc chưa từng
            # chạy phân tích — fallback về .txt thay vì làm hỏng cả lượt tải ZIP.
            if case.aiAnalysisSummary:
                # Bỏ dấu "**...**" (dùng để tô sáng khi hiển thị trên web) vì .txt không
                # render markdown — để nguyên chỉ thấy dấu sao thừa, gây rối mắt.
                analysis_text = re.sub(r"\*\*(.+?)\*\*", r"\1", case.aiAnalysisSummary)
            else:
                analysis_text = (
                    'Chưa có bản phân tích AI chuyên sâu — vào trang Tổng hợp thông tin và bấm '
                    'nút "Phân tích AI chuyên sâu" trước khi tải.'
                )
            zf.writestr(
                _dedupe_filename("Phan tich AI chuyen sau.txt", used_names), analysis_text
            )

    # Header HTTP chỉ encode được latin-1 — tên khách hàng tiếng Việt có dấu (vd "ễ", "ồ")
    # không hợp lệ nếu nhét thẳng vào filename= thường (đã xác nhận: UnicodeEncodeError khi
    # test thật). Dùng filename= ASCII an toàn làm fallback + filename*=UTF-8'' theo đúng
    # chuẩn RFC 5987/6266 để trình duyệt hiện đúng tên tiếng Việt lúc tải về.
    ascii_fallback = re.sub(r"[^\x00-\x7f]", "_", case.clientName).strip() or "ho-so"
    utf8_name = urllib.parse.quote(f"{case.clientName}.zip")
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_fallback}.zip"; filename*=UTF-8\'\'{utf8_name}'
            )
        },
    )


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
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren, case.skillLevel
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)

    return CaseListItemDTO(
        id=case.id,
        clientName=case.clientName,
        maritalStatus=case.maritalStatus,
        numberOfChildren=case.numberOfChildren,
        skillLevel=case.skillLevel,
        notes=case.notes,
        createdAt=case.createdAt,
        percent=summary.percent,
        needsReviewCount=summary.needs_review_count,
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.delete("/{case_id}")
def delete_case(case_id: str, db: Session = Depends(get_db)):
    """Xoá MỀM — chỉ đánh dấu deletedAt (ẩn khỏi danh sách chính GET /cases), KHÔNG xoá
    Case/Document trong DB và KHÔNG xoá file trên MinIO. Chừa dữ liệu nguyên vẹn để giao
    diện admin sau này khôi phục lại được qua POST /cases/{case_id}/restore."""
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    case.deletedAt = now_utc()
    db.commit()
    return {"ok": True}
