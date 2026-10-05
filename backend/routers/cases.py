import io
import json
import logging
import re
import unicodedata
import urllib.parse
import zipfile
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

import activity
import emailjs
import pdf_export
import storage
import thong_bao
from admin_auth import is_admin, require_admin
from case_auto_status import dong_bo_hoan_thanh
from case_status import (
    CASE_AUTO_DELETE_DAYS,
    CASE_STATUS_DEFINITIONS,
    FINAL_CASE_STATUSES,
    INSTANT_EMAIL_STATUSES,
    STATUS_REMINDER_INTERVAL_DAYS,
    case_status_fields,
    ly_do_khong_chuyen_duoc,
    MAX_SUBMISSION_ROUND,
    RESUBMIT_FROM_STATUSES,
)
from classify import summarize_case_profile
from completeness import (
    assess_savings,
    compute_checklist_summary,
    compute_financial_threshold_vnd,
    relink_marital_variants,
)
from db import get_db
from doc_checks import danh_gia_han, dem_han_tai_lieu, doi_chieu_cheo
from mappers import (
    checklist_summary_to_dto,
    doc_checks_to_dto,
    financial_threshold_to_dto,
    savings_to_dto,
)
from models import Case, ChecklistItem, now_utc
from savings import refresh_case_savings
from schemas import (
    dump_experience_units,
    parse_experience_units,
    ALLOWED_TAGS,
    CaseAnalysisResponse,
    CaseDetailDTO,
    CaseListItemDTO,
    CreateCaseRequest,
    SavingsAssessmentDTO,
    UpdateCaseRequest,
    UpdateSavingsRequest,
    UpdateTagsRequest,
    parse_tags,
)

logger = logging.getLogger("cases")

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
            checklist_items, c.documents, c.maritalStatus, c.numberOfChildren, c.skillLevel,
            force_complete=c.completedAt is not None,
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
                partner=c.partner,
                receiverName=c.receiverName,
                managerName=c.managerName,
                saleName=c.saleName,
                occupation=c.occupation,
                experienceMonths=c.experienceMonths,
                experienceUnits=parse_experience_units(c.experienceUnits),
                notes=c.notes,
                tags=parse_tags(c.tags),
                createdAt=c.createdAt,
                completedAt=c.completedAt,
                autoDeleteAt=c.autoDeleteAt,
                filesPurgedAt=c.filesPurgedAt,
                **case_status_fields(c),
                percent=summary.percent,
                needsReviewCount=summary.needs_review_count,
                financialThreshold=financial_threshold_to_dto(threshold),
                expiredDocCount=qua_han,
                expiringSoonDocCount=sap_han,
                idleDays=thong_bao.ngay_chua_cap_nhat(c, summary),
            )
        )
    return result


@router.get("/tags")
def list_tags():
    """Danh sách tag hợp lệ + màu hiển thị — frontend gọi 1 lần lúc load trang để render
    dropdown/chip đúng màu, không hardcode lại danh sách ở 2 nơi."""
    return [{"name": name, "color": color} for name, color in ALLOWED_TAGS.items()]


@router.get("/partners")
def list_partners(db: Session = Depends(get_db)):
    """Các đối tác ĐANG được dùng, để form gợi ý sẵn khi gõ.

    Không có bảng Partner riêng: đây là ô chữ tự do, danh sách gợi ý sinh ra từ chính dữ
    liệu đã nhập. Đổi lại là không phải dựng thêm màn hình quản lý đối tác, nhưng gõ sai
    chính tả sẽ đẻ ra một nhóm mới — gợi ý sẵn chính là thứ kéo mọi người gõ giống nhau.

    Sắp theo tên để thứ tự ổn định giữa các lần gọi; hồ sơ đã xoá mềm không tính.
    """
    rows = db.scalars(
        select(Case.partner)
        .where(Case.deletedAt.is_(None), Case.partner.is_not(None), Case.partner != "")
        .distinct()
        .order_by(Case.partner)
    ).all()
    return [r for r in rows if r]


@router.get("/occupations")
def list_occupations(db: Session = Depends(get_db)):
    """Các nghề nghiệp đã nhập, để form gợi ý. Cùng lý do và cùng đánh đổi như /partners:
    ô chữ tự do, danh sách gợi ý sinh từ chính dữ liệu, không có bảng riêng."""
    rows = db.scalars(
        select(Case.occupation)
        .where(Case.deletedAt.is_(None), Case.occupation.is_not(None), Case.occupation != "")
        .distinct()
        .order_by(Case.occupation)
    ).all()
    return [r for r in rows if r]


def _goi_y(db: Session, cot) -> list[str]:
    """Giá trị ĐANG được dùng của một ô chữ tự do, để form gợi ý — cùng lý do như /partners."""
    rows = db.scalars(
        select(cot).where(Case.deletedAt.is_(None), cot.is_not(None), cot != "").distinct().order_by(cot)
    ).all()
    return [r for r in rows if r]


@router.get("/receivers")
def list_receivers(db: Session = Depends(get_db)):
    return _goi_y(db, Case.receiverName)


@router.get("/managers")
def list_managers(db: Session = Depends(get_db)):
    return _goi_y(db, Case.managerName)


@router.get("/sales")
def list_sales(db: Session = Depends(get_db)):
    return _goi_y(db, Case.saleName)


@router.get("/experience-units")
def list_experience_units(db: Session = Depends(get_db)):
    """Tên các công ty xác nhận kinh nghiệm đã nhập ở MỌI hồ sơ — gợi ý cho ô "Đơn vị xác nhận kinh
    nghiệm": hồ sơ khác cùng công ty thì gõ vài chữ là chọn được, khỏi gõ lại (và khỏi gõ lệch
    "Cty A" / "Công ty A" thành hai công ty).

    Cùng một công ty gõ khác hoa/thường hay khác kiểu dấu (máy Mac) gộp làm một, hiện cách gõ hay
    dùng nhất. Phải khai TRƯỚC GET /{case_id}, không thì "experience-units" bị hiểu là một case_id.
    """
    dem: dict[str, dict[str, int]] = {}
    for raw in db.scalars(
        select(Case.experienceUnits).where(Case.deletedAt.is_(None), Case.experienceUnits.is_not(None))
    ):
        for u in parse_experience_units(raw):
            ten = " ".join(unicodedata.normalize("NFC", u["name"]).split())
            if ten:
                cach_go = dem.setdefault(ten.casefold(), {})
                cach_go[ten] = cach_go.get(ten, 0) + 1
    ket_qua = [max(cach_go.items(), key=lambda kv: kv[1])[0] for cach_go in dem.values()]
    return sorted(ket_qua, key=str.casefold)


@router.get("/statuses")
def list_application_statuses():
    """Danh sách có thứ tự để UI và chức năng email dùng cùng một quy ước trạng thái."""
    return [
        {
            **definition,
            "isFinal": definition["value"] in FINAL_CASE_STATUSES,
            "reminderEnabled": definition["value"] not in FINAL_CASE_STATUSES,
            "reminderIntervalDays": STATUS_REMINDER_INTERVAL_DAYS,
        }
        for definition in CASE_STATUS_DEFINITIONS
    ]


@router.post("", response_model=CaseListItemDTO, status_code=201)
def create_case(body: CreateCaseRequest, db: Session = Depends(get_db)):
    case = Case(
        clientName=body.clientName,
        maritalStatus=body.maritalStatus,
        numberOfChildren=body.numberOfChildren,
        skillLevel=body.skillLevel,
        # Cắt khoảng trắng thừa và quy chuỗi rỗng về NULL: "  " và "" phải là "không có đối
        # tác" giống hệt nhau, nếu không danh sách gợi ý sẽ mọc ra một "nhóm" vô hình.
        partner=(body.partner or "").strip() or None,
        receiverName=(body.receiverName or "").strip() or None,
        managerName=(body.managerName or "").strip() or None,
        saleName=(body.saleName or "").strip() or None,
        occupation=(body.occupation or "").strip() or None,
        experienceMonths=body.experienceMonths,
        experienceUnits=dump_experience_units(body.experienceUnits),
        notes=body.notes,
    )
    db.add(case)
    db.commit()
    db.refresh(case)
    activity.ghi("CASE_CREATE", case=case)

    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)
    return CaseListItemDTO(
        id=case.id,
        clientName=case.clientName,
        maritalStatus=case.maritalStatus,
        numberOfChildren=case.numberOfChildren,
        skillLevel=case.skillLevel,
        partner=case.partner,
        receiverName=case.receiverName,
        managerName=case.managerName,
        saleName=case.saleName,
        occupation=case.occupation,
        experienceMonths=case.experienceMonths,
        experienceUnits=parse_experience_units(case.experienceUnits),
        notes=case.notes,
        tags=[],
        createdAt=case.createdAt,
        completedAt=case.completedAt,
        autoDeleteAt=case.autoDeleteAt,
        filesPurgedAt=case.filesPurgedAt,
        **case_status_fields(case),
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
            checklist_items, c.documents, c.maritalStatus, c.numberOfChildren, c.skillLevel,
            force_complete=c.completedAt is not None,
        )
        threshold = compute_financial_threshold_vnd(c.maritalStatus, c.numberOfChildren)
        result.append(
            CaseListItemDTO(
                id=c.id,
                clientName=c.clientName,
                maritalStatus=c.maritalStatus,
                numberOfChildren=c.numberOfChildren,
                skillLevel=c.skillLevel,
                partner=c.partner,
                receiverName=c.receiverName,
                managerName=c.managerName,
                saleName=c.saleName,
                occupation=c.occupation,
                experienceMonths=c.experienceMonths,
                experienceUnits=parse_experience_units(c.experienceUnits),
                notes=c.notes,
                tags=parse_tags(c.tags),
                createdAt=c.createdAt,
                completedAt=c.completedAt,
                autoDeleteAt=c.autoDeleteAt,
                filesPurgedAt=c.filesPurgedAt,
                deletedAt=c.deletedAt,
                **case_status_fields(c),
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
    dong_bo_hoan_thanh(db, case)
    activity.ghi("CASE_RESTORE", case=case)
    db.refresh(case)

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren,
        case.skillLevel, force_complete=case.completedAt is not None,
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)
    return CaseListItemDTO(
        id=case.id,
        clientName=case.clientName,
        maritalStatus=case.maritalStatus,
        numberOfChildren=case.numberOfChildren,
        skillLevel=case.skillLevel,
        partner=case.partner,
        receiverName=case.receiverName,
        managerName=case.managerName,
        saleName=case.saleName,
        occupation=case.occupation,
        experienceMonths=case.experienceMonths,
        experienceUnits=parse_experience_units(case.experienceUnits),
        notes=case.notes,
        tags=parse_tags(case.tags),
        createdAt=case.createdAt,
        completedAt=case.completedAt,
        autoDeleteAt=case.autoDeleteAt,
        filesPurgedAt=case.filesPurgedAt,
        **case_status_fields(case),
        percent=summary.percent,
        needsReviewCount=summary.needs_review_count,
        financialThreshold=financial_threshold_to_dto(threshold),
    )


@router.get("/{case_id}", response_model=CaseDetailDTO)
def get_case(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    # Gộp theo 30 phút + bỏ qua admin/không rõ tên (xem activity._GOP_PHUT).
    activity.ghi("CASE_VIEW", case=case)

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren,
        case.skillLevel, force_complete=case.completedAt is not None,
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)
    items_by_id = {i.id: i for i in checklist_items}
    han = danh_gia_han(list(case.documents), items_by_id)
    bat_nhat = doi_chieu_cheo(list(case.documents))

    return CaseDetailDTO(
        case={
            "id": case.id,
            "clientName": case.clientName,
            "maritalStatus": case.maritalStatus,
            "numberOfChildren": case.numberOfChildren,
            "skillLevel": case.skillLevel,
            "partner": case.partner,
            "receiverName": case.receiverName,
            "managerName": case.managerName,
            "saleName": case.saleName,
            "occupation": case.occupation,
            "experienceMonths": case.experienceMonths,
            "experienceUnits": parse_experience_units(case.experienceUnits),
            "notes": case.notes,
            "tags": parse_tags(case.tags),
            "createdAt": case.createdAt,
            "completedAt": case.completedAt,
            "autoDeleteAt": case.autoDeleteAt,
            "filesPurgedAt": case.filesPurgedAt,
            **case_status_fields(case),
            "documents": sorted(case.documents, key=lambda d: d.uploadedAt),
            "aiAnalysisStatus": case.aiAnalysisStatus,
            "aiAnalysisSummary": case.aiAnalysisSummary,
            "aiAnalysisError": case.aiAnalysisError,
            "aiAnalysisUpdatedAt": case.aiAnalysisUpdatedAt,
        },
        checklist=checklist_summary_to_dto(summary),
        financialThreshold=financial_threshold_to_dto(threshold),
        savings=_savings_dto(case),
        docChecks=doc_checks_to_dto(han, bat_nhat),
    )


def _savings_dto(case: Case) -> SavingsAssessmentDTO:
    return savings_to_dto(
        assess_savings(
            case.maritalStatus,
            case.numberOfChildren,
            case.savingsAiVnd,
            case.savingsAiNote,
            case.savingsManualVnd,
        ),
        case.savingsUpdatedAt,
    )


@router.post("/{case_id}/savings/detect", response_model=SavingsAssessmentDTO)
def detect_case_savings(case_id: str, db: Session = Depends(get_db)):
    """Đọc lại số dư tiết kiệm từ giấy tờ đã nộp bằng AI.

    Bình thường bước này tự chạy sau khi upload xong giấy tờ tài chính (xem
    case_documents.upload_document) — endpoint này dành cho lúc nhân viên sửa tay văn bản
    OCR rồi muốn AI đọc lại, hoặc lần đọc trước gặp lỗi mạng."""
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    error = refresh_case_savings(db, case)
    if error:
        raise HTTPException(status_code=400, detail=error)

    db.refresh(case)
    activity.ghi("SAVINGS_DETECT", case=case)
    return _savings_dto(case)


@router.patch("/{case_id}/savings", response_model=SavingsAssessmentDTO)
def update_case_savings(
    case_id: str, body: UpdateSavingsRequest, db: Session = Depends(get_db)
):
    """Nhân viên tự nhập/sửa số dư. Gửi manualVnd=null để XOÁ số nhập tay và quay lại dùng
    số AI đọc — CỐ Ý không đụng tới savingsAiVnd để vẫn còn bản AI mà đối chiếu."""
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    if body.manualVnd is not None and body.manualVnd < 0:
        raise HTTPException(status_code=400, detail="Số dư không thể là số âm.")

    case.savingsManualVnd = body.manualVnd
    case.savingsUpdatedAt = now_utc()
    db.commit()
    db.refresh(case)
    activity.ghi(
        "SAVINGS_EDIT", case=case,
        detail=f"{body.manualVnd:,} VNĐ".replace(",", ".") if body.manualVnd is not None else "Xoá số nhập tay",
    )
    return _savings_dto(case)


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
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren,
        case.skillLevel, force_complete=case.completedAt is not None,
    )

    activity.ghi("AI_ANALYZE", case=case)
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
    # Ghi mốc thời gian NGAY LÚC BẮT ĐẦU (không chỉ lúc xong) — frontend cần biết lượt phân
    # tích này đã chạy được bao lâu để hiện thanh tiến trình + ước tính thời gian còn lại.
    # Dùng lại đúng cột aiAnalysisUpdatedAt thay vì thêm cột "startedAt" mới: ý nghĩa vẫn
    # đúng ("lần cập nhật trạng thái gần nhất"), và tránh phải sửa cấu trúc bảng + chạy
    # migration trên production (schema đang quản lý thủ công — xem models.py). Khi status là
    # RUNNING thì giá trị này chính là thời điểm bắt đầu; khi DONE/ERROR là thời điểm kết
    # thúc. Nhờ lưu trong DB (không phải state React), F5 hay mở từ máy khác vẫn tính đúng.
    case.aiAnalysisUpdatedAt = now_utc()
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
    # Không để tên file do client gửi tạo entry "../..." hoặc thư mục con trong ZIP; lúc
    # giải nén, mọi tài liệu phải nằm ngay trong thư mục người dùng đã chọn.
    name = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "_", name) or "file"
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
def download_all_documents(case_id: str, ids: Optional[str] = None, db: Session = Depends(get_db)):
    """Gộp file gốc (PDF/ảnh) của hồ sơ thành 1 file ZIP để nhân viên tải về một lần.

    `ids` = danh sách id tài liệu, ngăn nhau bằng dấu phẩy -> CHỈ nén những file đó. Thiếu
    `ids` thì nén toàn bộ, kèm bản "Phân tích AI chuyên sâu" (giữ nguyên hành vi cũ của nút
    "Tải tất cả" ở trang Tổng hợp).

    Khi có chọn lọc thì KHÔNG kèm bản phân tích AI: nhân viên tick vài tờ giấy cụ thể (vd gửi
    bổ sung cho lãnh sự) mà file zip lại có thêm bản phân tích nội bộ là đưa nhầm tài liệu
    ra ngoài.
    """
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    chon = {x for x in (ids or "").split(",") if x} or None
    tai_lieu = [d for d in case.documents if chon is None or d.id in chon]
    if chon is not None and not tai_lieu:
        raise HTTPException(status_code=404, detail="Không tìm thấy file nào trong số đã chọn")

    buffer = io.BytesIO()
    used_names: set[str] = set()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for doc in sorted(tai_lieu, key=lambda d: d.uploadedAt):
            try:
                content = storage.get_document_bytes(doc.storedPath)
            except Exception:  # noqa: BLE001
                continue
            name = _dedupe_filename(doc.originalFilename or "file", used_names)
            zf.writestr(name, content)

        if chon is not None:
            pdf_bytes = None
        elif case.aiAnalysisSummary:
            pdf_bytes = pdf_export.render_text_to_pdf(
                case.aiAnalysisSummary, f"Phân tích AI chuyên sâu — {case.clientName}"
            )
        else:
            pdf_bytes = None

        if pdf_bytes is not None:
            zf.writestr(_dedupe_filename("Phan tich AI chuyen sau.pdf", used_names), pdf_bytes)
        elif chon is not None:
            pass  # tải file đã chọn thì không kèm gì thêm
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
    hau_to = f" ({len(tai_lieu)} file da chon)" if chon is not None else ""
    ascii_fallback = re.sub(r'[^\x20-\x7e]|["\\]', "_", case.clientName).strip() or "ho-so"
    utf8_name = urllib.parse.quote(f"{case.clientName}{hau_to}.zip", safe="")
    activity.ghi(
        "ZIP_DOWNLOAD", case=case,
        detail=f"{len(tai_lieu)} file đã chọn" if chon is not None else f"Tất cả {len(tai_lieu)} file",
    )
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_fallback}{hau_to}.zip"; filename*=UTF-8\'\'{utf8_name}'
            )
        },
    )


def _bao_doi_trang_thai(row: dict, sent_at, case_id: str, application_status: str) -> None:
    """Gửi email báo đổi trạng thái. NUỐT mọi lỗi — chạy trong BackgroundTask nên ném ra
    cũng không ai bắt, mà trạng thái thì đã lưu xong rồi: để EmailJS chết kéo theo cả thao
    tác đổi trạng thái là đánh đổi tệ. Lỗi vào log, hồ sơ vẫn được nhắc lại sau 14 ngày.
    """
    try:
        emailjs.send_cases(
            [row],
            sent_at,
            title=f"Hồ sơ chuyển sang: {row['status_label']}",
            intro=(
                f"Hồ sơ {row['client_name']} vừa được chuyển sang trạng thái "
                f"“{row['status_label']}”."
            ),
            footer=(
                "Email này gửi ngay lúc đổi trạng thái, không phải nhắc định kỳ. Nếu chưa xử "
                f"lý xong, hồ sơ sẽ được nhắc lại sau {STATUS_REMINDER_INTERVAL_DAYS} ngày."
            ),
            trigger="STATUS_CHANGE",
            case_id=case_id,
            case_client_name=row["client_name"],
            application_status=application_status,
        )
        logger.info("Đã gửi email báo đổi trạng thái: %s.", row["client_name"])
    except Exception:
        logger.exception("Không gửi được email báo đổi trạng thái cho %s.", row["client_name"])


@router.patch("/{case_id}", response_model=CaseListItemDTO)
def update_case(
    case_id: str,
    body: UpdateCaseRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    # Endpoint dùng chung: trang admin gửi kèm mật khẩu, trang nhân viên thì không — đó là cách
    # duy nhất biết ai đang đổi trạng thái để áp đúng phần quyền (xem ly_do_khong_chuyen_duoc).
    la_admin: bool = Depends(is_admin),
):
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    # exclude_unset: chỉ áp field nào thực sự có trong request body — sửa 1 field (vd chỉ
    # đổi tên) không vô tình xoá/ghi đè các field khác không được gửi lên.
    updates = body.model_dump(exclude_unset=True)
    old_application_status = case.applicationStatus
    # Giá trị CŨ của các trường gửi lên — để lịch sử chỉ ghi trường THỰC SỰ đổi.
    gia_tri_cu = {f: getattr(case, f, None) for f in updates}
    for field, value in updates.items():
        setattr(case, field, value)
    # Ô chữ tự do: xoá trắng thì lưu None, không lưu "" — không thì danh sách gợi ý và bộ lọc
    # ở trang thống kê admin sẽ có một mục "rỗng" riêng tách khỏi "chưa nhập".
    for field in ("receiverName", "managerName", "saleName"):
        if field in updates:
            setattr(case, field, (updates[field] or "").strip() or None)
    # Vòng setattr ở trên gán nguyên list dict vào cột TEXT — ghi lại đúng dạng JSON đã chuẩn hoá.
    if "experienceUnits" in updates:
        case.experienceUnits = dump_experience_units(body.experienceUnits, gia_tri_cu.get("experienceUnits"))

    # Chỉ khởi động lại chu kỳ 14 ngày khi trạng thái THỰC SỰ đổi. Bấm lưu lại cùng một
    # trạng thái không được trì hoãn email nhắc vô thời hạn.
    status_changed = (
        "applicationStatus" in updates
        and updates["applicationStatus"] != old_application_status
    )
    if status_changed:
        case.applicationStatusUpdatedAt = now_utc()
        case.lastStatusReminderAt = None

    # Vài mục LOW_SKILL có bản riêng cho độc thân và cho kết hôn (CCCD bố/mẹ, khai sinh con...).
    # Đổi tình trạng hôn nhân mà không chuyển theo thì giấy tờ đã nộp nằm lại ở bản mục không
    # còn áp dụng, checklist báo "thiếu" dù khách đã nộp. Xem LOW_SKILL_MARITAL_VARIANTS.
    if "maritalStatus" in updates:
        relink_marital_variants(case)

    # Kiểm tra SAU khi đã áp các trường khác trong cùng request: hộp "Sửa hồ sơ" gửi cả tình
    # trạng hôn nhân lẫn trạng thái một lúc, mà đổi hôn nhân là đổi checklist -> đổi tiến độ.
    if status_changed:
        tien_do = compute_checklist_summary(
            db.scalars(select(ChecklistItem)).all(), case.documents, case.maritalStatus,
            case.numberOfChildren, case.skillLevel, force_complete=case.completedAt is not None,
        ).percent
        ly_do = ly_do_khong_chuyen_duoc(updates["applicationStatus"], old_application_status, tien_do, la_admin)
        if ly_do:
            db.rollback()
            raise HTTPException(status_code=400, detail=ly_do)

    db.commit()
    # Nhân viên TỰ chọn trạng thái thì tôn trọng lựa chọn đó; chỉ tự đồng bộ khi request đổi thứ
    # khác (hôn nhân, số con, tay nghề -> checklist đổi -> tiến độ đổi).
    if not status_changed:
        dong_bo_hoan_thanh(db, case)
    db.refresh(case)

    if status_changed:
        activity.ghi(
            "STATUS_CHANGE", case=case,
            detail=f"{activity.nhan_trang_thai(old_application_status)} → {activity.nhan_trang_thai(case.applicationStatus)}",
        )
    doi = [
        activity.TEN_TRUONG[f] for f in updates
        if f in activity.TEN_TRUONG and (gia_tri_cu.get(f) or None) != (getattr(case, f, None) or None)
    ]
    if doi:
        activity.ghi("CASE_EDIT", case=case, detail="Sửa " + ", ".join(doi))

    # Đọc giá trị ra NGAY tại đây rồi mới xếp lịch gửi: BackgroundTask chạy sau khi session
    # DB đã đóng, chạm vào thuộc tính ORM lúc đó có thể nổ DetachedInstanceError.
    status_email_queued = status_changed and case.applicationStatus in INSTANT_EMAIL_STATUSES
    if status_email_queued:
        # Gửi ở background chứ không gửi thẳng trong request: EmailJS mất khoảng 1 giây,
        # không có lý do bắt nhân viên ngồi nhìn ô trạng thái quay trong lúc chờ mạng.
        background_tasks.add_task(
            _bao_doi_trang_thai,
            emailjs.build_case_row(
                case_id=case.id,
                client_name=case.clientName,
                application_status=case.applicationStatus,
                updated_at=case.applicationStatusUpdatedAt,
            ),
            now_utc(),
            case.id,
            case.applicationStatus,
        )

    checklist_items = db.scalars(select(ChecklistItem)).all()
    summary = compute_checklist_summary(
        checklist_items, case.documents, case.maritalStatus, case.numberOfChildren,
        case.skillLevel, force_complete=case.completedAt is not None,
    )
    threshold = compute_financial_threshold_vnd(case.maritalStatus, case.numberOfChildren)

    return CaseListItemDTO(
        id=case.id,
        clientName=case.clientName,
        maritalStatus=case.maritalStatus,
        numberOfChildren=case.numberOfChildren,
        skillLevel=case.skillLevel,
        partner=case.partner,
        receiverName=case.receiverName,
        managerName=case.managerName,
        saleName=case.saleName,
        occupation=case.occupation,
        experienceMonths=case.experienceMonths,
        experienceUnits=parse_experience_units(case.experienceUnits),
        notes=case.notes,
        tags=parse_tags(case.tags),
        createdAt=case.createdAt,
        completedAt=case.completedAt,
        autoDeleteAt=case.autoDeleteAt,
        filesPurgedAt=case.filesPurgedAt,
        **case_status_fields(case),
        percent=summary.percent,
        needsReviewCount=summary.needs_review_count,
        financialThreshold=financial_threshold_to_dto(threshold),
        statusEmailQueued=status_email_queued,
    )


@router.patch("/{case_id}/tags", response_model=list[str])
def update_case_tags(case_id: str, body: UpdateTagsRequest, db: Session = Depends(get_db)):
    """Ghi đè toàn bộ danh sách tag của hồ sơ. Gửi mảng rỗng để xoá hết tag."""
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    # Validate + dedupe, giữ nguyên thứ tự nhân viên chọn.
    seen: set[str] = set()
    clean: list[str] = []
    for tag in body.tags:
        if tag not in ALLOWED_TAGS:
            raise HTTPException(status_code=400, detail=f'Tag "{tag}" không hợp lệ.')
        if tag not in seen:
            seen.add(tag)
            clean.append(tag)

    case.tags = json.dumps(clean, ensure_ascii=False) if clean else None
    db.commit()
    activity.ghi("TAGS_EDIT", case=case, detail=", ".join(clean) or "Bỏ hết nhãn")
    return clean


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
    activity.ghi("CASE_DELETE", case=case)
    return {"ok": True}


class CaseCompletionDTO(BaseModel):
    """Kết quả đánh dấu/bỏ đánh dấu hoàn tất. Không trả nguyên CaseListItemDTO vì dựng nó cần
    tính lại checklist + ngưỡng tài chính, mà danh sách hồ sơ luôn tải lại ngay sau đó."""

    id: str
    # Optional[...] chứ KHÔNG phải "datetime | None": container chạy Python 3.9, cú pháp PEP 604
    # chỉ có từ 3.10 và Pydantic dựng model ngay lúc import -> backend chết lúc khởi động.
    completedAt: Optional[datetime]
    autoDeleteAt: Optional[datetime]
    autoDeleteDays: int
    # Trạng thái SAU khi tự đồng bộ theo tiến độ (đánh dấu -> 100% -> "Hoàn thành"; bỏ đánh dấu
    # mà giấy tờ thật chưa đủ -> lùi về "Đang thu thập giấy tờ"). Danh sách cập nhật tại chỗ.
    applicationStatus: str


class ResubmitDTO(BaseModel):
    id: str
    submissionRound: int
    applicationStatus: str
    deletedFiles: int


@router.post("/{case_id}/resubmit", response_model=ResubmitDTO, dependencies=[Depends(require_admin)])
def resubmit_case(case_id: str, db: Session = Depends(get_db)):
    """Admin chọn "Nộp lại lần N": làm lại hồ sơ từ đầu cho lần nộp kế tiếp.

    - XOÁ VĨNH VIỄN toàn bộ file của lần trước (DB + MinIO, kể cả ảnh trang) — hồ sơ về 0%;
    - tăng submissionRound (giao diện hiện "Nộp lại lần N" cạnh tên khách);
    - trạng thái về "Chờ tiếp nhận" để nhân viên làm lại ở trang checklist;
    - huỷ "Hoàn tất" + hẹn tự xoá (không thì hồ sơ đang làm lại bị xoá cứng giữa chừng);
    - xoá số dư tiết kiệm (cả số AI lẫn số nhập tay) và bản phân tích AI — cả hai đều dựa trên
      file vừa xoá, để lại là hồ sơ 0% vẫn hiện "đủ tiền".

    Không gửi email: "Chờ tiếp nhận" không nằm trong INSTANT_EMAIL_STATUSES.
    """
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    if case.applicationStatus not in RESUBMIT_FROM_STATUSES:
        raise HTTPException(
            status_code=400,
            detail="Chỉ hồ sơ 'Đang xử lý' hoặc 'Không thành công' mới chọn nộp lại được.",
        )
    if (case.submissionRound or 1) >= MAX_SUBMISSION_ROUND:
        raise HTTPException(
            status_code=400,
            detail=f"Hồ sơ đã nộp lần {case.submissionRound} — chỉ được nộp lại một lần, không có lần nộp thứ {case.submissionRound + 1}.",
        )

    so_file = len(case.documents)
    for doc in list(case.documents):
        db.delete(doc)
    now = now_utc()
    case.submissionRound = (case.submissionRound or 1) + 1
    case.applicationStatus = "PENDING"
    case.applicationStatusUpdatedAt = now
    case.lastStatusReminderAt = None
    case.completedAt = None
    case.autoDeleteAt = None
    case.savingsAiVnd = None
    case.savingsAiNote = None
    case.savingsManualVnd = None
    case.savingsUpdatedAt = now
    case.aiAnalysisStatus = "IDLE"
    case.aiAnalysisSummary = None
    case.aiAnalysisError = None
    case.aiAnalysisUpdatedAt = None
    db.commit()

    # Xoá file SAU khi DB đã commit: lỗi MinIO lúc này chỉ để lại file mồ côi (tốn chỗ), còn làm
    # ngược lại mà DB lỗi thì hồ sơ trỏ tới file đã mất.
    try:
        storage.delete_prefix(f"{case.id}/")
    except Exception:
        logger.exception("Nộp lại hồ sơ %s: không xoá được file trên MinIO", case.id)

    logger.info("Hồ sơ %s: nộp lại lần %s, đã xoá %s file", case.id, case.submissionRound, so_file)
    activity.ghi("CASE_RESUBMIT", case=case, detail=f"Lần {case.submissionRound} — đã xoá {so_file} file")
    return ResubmitDTO(
        id=case.id, submissionRound=case.submissionRound, applicationStatus=case.applicationStatus,
        deletedFiles=so_file,
    )


@router.post("/{case_id}/complete", response_model=CaseCompletionDTO)
def mark_case_complete(case_id: str, db: Session = Depends(get_db)):
    """Đánh dấu hồ sơ đã xong: tiến độ thành 100% và hẹn tự xoá sau CASE_AUTO_DELETE_DAYS ngày.

    Đặt ở router /cases (nhân viên dùng) chứ không phải /admin: đây là thao tác nghiệp vụ hằng
    ngày của người làm hồ sơ, không phải việc quản trị.

    KHÔNG xoá ngay: tới hạn, tiến trình case_cleanup XOÁ CỨNG cả hồ sơ lẫn file (không khôi phục
    được). Bấm lại trên hồ sơ ĐÃ đánh dấu thì gia hạn lại từ hôm nay. Tiến độ thành 100% nên
    trạng thái cũng tự sang "Hoàn thành" (case_auto_status).
    """
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    if case.deletedAt is not None:
        raise HTTPException(status_code=400, detail="Hồ sơ đã bị xoá — khôi phục trước rồi mới đánh dấu hoàn tất.")

    now = now_utc()
    case.completedAt = now
    case.autoDeleteAt = now + timedelta(days=CASE_AUTO_DELETE_DAYS)
    db.commit()
    dong_bo_hoan_thanh(db, case)
    db.refresh(case)
    activity.ghi("CASE_COMPLETE", case=case, detail=f"Hẹn xoá vĩnh viễn {case.autoDeleteAt:%d/%m/%Y}")
    return CaseCompletionDTO(
        id=case.id, completedAt=case.completedAt, autoDeleteAt=case.autoDeleteAt,
        autoDeleteDays=CASE_AUTO_DELETE_DAYS, applicationStatus=case.applicationStatus,
    )


@router.delete("/{case_id}/complete", response_model=CaseCompletionDTO)
def unmark_case_complete(case_id: str, db: Session = Depends(get_db)):
    """Bỏ đánh dấu hoàn tất: tiến độ trở lại số thật và HUỶ hẹn xoá."""
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    case.completedAt = None
    case.autoDeleteAt = None
    db.commit()
    dong_bo_hoan_thanh(db, case)
    activity.ghi("CASE_UNCOMPLETE", case=case)
    return CaseCompletionDTO(
        id=case_id, completedAt=None, autoDeleteAt=None, autoDeleteDays=CASE_AUTO_DELETE_DAYS,
        applicationStatus=case.applicationStatus,
    )
