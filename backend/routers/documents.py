import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

import activity
import ocr
import paddle_ocr_vl
import storage
from case_auto_status import dong_bo_hoan_thanh
from classify import ap_thong_tin_boc_duoc, classify_ocr_text
from completeness import is_item_applicable, is_savings_item
from db import get_db
from models import ChecklistItem, Document, now_utc
from savings import refresh_case_savings_quietly
from schemas import (
    DocumentDTO,
    PatchDocumentRequest,
    UpdateExpiresAtRequest,
    UpdateManualCorrectedTextRequest,
)

router = APIRouter(prefix="/documents", tags=["documents"])


def _content_disposition(filename: str) -> str:
    """Tên file khách hàng đặt luôn có dấu tiếng Việt (vd "Trần Văn Hùng...") — HTTP header
    bắt buộc ASCII/Latin-1, gửi thẳng UTF-8 làm Starlette CRASH ngay lúc dựng Response
    (UnicodeEncodeError, xảy ra khi tạo Response nên KHÔNG lọt qua try/except bọc quanh
    storage.get_document_bytes bên dưới) — xác nhận đây đúng là nguyên nhân lỗi 500 thật gặp
    trên production (test trực tiếp bằng đúng tên file lỗi, ra đúng UnicodeEncodeError).
    Dùng chuẩn RFC 5987 (filename*=UTF-8''...): trình duyệt hiện đại ưu tiên đọc filename*
    (UTF-8, percent-encoded), fallback filename= thuần ASCII (thay ký tự ngoài ASCII bằng
    "_") cho các client cũ không hiểu filename*."""
    ascii_name = filename.encode("ascii", errors="replace").decode("ascii")
    # Dấu nháy, gạch chéo ngược và ký tự điều khiển có thể làm hỏng cú pháp header; tên
    # UTF-8 thật vẫn nằm nguyên vẹn trong filename* đã percent-encode ở dưới.
    ascii_fallback = re.sub(r'[\x00-\x1f\x7f"\\?]', "_", ascii_name)
    encoded = quote(filename, safe="")
    return f'inline; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded}'


@router.patch("/{document_id}", response_model=DocumentDTO)
def patch_document(document_id: str, body: PatchDocumentRequest, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")

    # Giữ lại mục CŨ trước khi ghi đè: nếu nhân viên GỠ một file ra khỏi mục tiết kiệm thì
    # tổng số dư cũng phải tính lại, không chỉ khi họ GÁN vào. Không nhớ mục cũ thì trường
    # hợp gỡ ra sẽ để lại con số cũ đã sai trên màn hình.
    was_savings = is_savings_item(doc.matchedChecklistItemId)

    if body.matchedChecklistItemId:
        target = db.get(ChecklistItem, body.matchedChecklistItemId)
        if not target:
            raise HTTPException(status_code=400, detail="Mục checklist không tồn tại")
        if not is_item_applicable(
            target, doc.case.maritalStatus, doc.case.numberOfChildren, doc.case.skillLevel
        ):
            raise HTTPException(
                status_code=400, detail="Mục checklist không áp dụng cho hồ sơ này"
            )

    doc.matchedChecklistItemId = body.matchedChecklistItemId
    doc.status = "MANUALLY_SET" if body.matchedChecklistItemId else "NEEDS_REVIEW"
    doc.isManualOverride = True
    db.commit()
    dong_bo_hoan_thanh(db, doc.case)
    activity.ghi(
        "DOC_ASSIGN", case=doc.case, document=doc,
        detail=f"'{doc.originalFilename}' → {activity.ten_muc(db, doc.matchedChecklistItemId) or 'gỡ khỏi mục (cần review)'}",
    )

    if was_savings or is_savings_item(doc.matchedChecklistItemId):
        refresh_case_savings_quietly(db, doc.case)

    db.refresh(doc)
    return doc


@router.patch("/{document_id}/corrected-text", response_model=DocumentDTO)
def update_manual_corrected_text(
    document_id: str, body: UpdateManualCorrectedTextRequest, db: Session = Depends(get_db)
):
    """Nhân viên tự sửa tay mục 2 (văn bản sau khi DeepSeek sửa) khi phát hiện AI sửa sai —
    lưu riêng vào manualCorrectedText, không đụng vào correctedText gốc do AI sinh ra."""
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")

    trimmed = body.manualCorrectedText.strip()
    doc.manualCorrectedText = trimmed or None
    db.commit()
    activity.ghi("DOC_EDIT_TEXT", case=doc.case, document=doc, detail=f"'{doc.originalFilename}'")
    db.refresh(doc)
    return doc


@router.patch("/{document_id}/expires-at", response_model=DocumentDTO)
def update_manual_expires_at(
    document_id: str, body: UpdateExpiresAtRequest, db: Session = Depends(get_db)
):
    """Nhân viên sửa tay ngày hết hạn khi AI đọc sai — lưu riêng vào manualExpiresAt, KHÔNG
    đụng aiExpiresAt để vẫn còn bản AI đối chiếu.

    Con số này quyết định giấy tờ còn dùng được hay không, nên cho sửa tay là bắt buộc: OCR
    trên giấy tờ đóng dấu/mờ đọc nhầm ngày là chuyện thường, mà đọc nhầm ở đây thì hồ sơ đã
    quá hạn vẫn hiện là còn hạn."""
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")

    doc.manualExpiresAt = body.manualExpiresAt
    db.commit()
    activity.ghi(
        "DOC_EDIT_EXPIRY", case=doc.case, document=doc,
        detail=f"'{doc.originalFilename}' → "
        + (f"{body.manualExpiresAt:%d/%m/%Y}" if body.manualExpiresAt else "bỏ ngày nhập tay"),
    )
    db.refresh(doc)
    return doc


@router.delete("/{document_id}")
def delete_document(document_id: str, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")

    was_savings = is_savings_item(doc.matchedChecklistItemId)
    case = doc.case
    ten_file, muc = doc.originalFilename, activity.ten_muc(db, doc.matchedChecklistItemId)

    storage.delete_document(doc.storedPath)
    db.delete(doc)
    db.commit()
    dong_bo_hoan_thanh(db, case)
    activity.ghi("DOC_DELETE", case=case, detail=f"'{ten_file}'" + (f" (mục {muc})" if muc else ""))

    if was_savings:
        # Quan hệ đã được đọc ở trên; hết transaction phải buộc tải lại để tài liệu vừa xoá
        # không còn lọt vào phép tính số dư kế tiếp.
        db.expire(case, ["documents"])
        refresh_case_savings_quietly(db, case)
    return {"ok": True}


@router.get("/{document_id}/file")
def get_document_file(document_id: str, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")

    try:
        content = storage.get_document_bytes(doc.storedPath)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="File không còn tồn tại trên hệ thống lưu trữ") from e
    activity.ghi("DOC_OPEN", case=doc.case, document=doc, detail=f"'{doc.originalFilename}'")
    return Response(
        content=content,
        media_type=doc.mimeType,
        headers={"Content-Disposition": _content_disposition(doc.originalFilename)},
    )


@router.get("/{document_id}/pages/{page_num}")
def get_document_page_image(document_id: str, page_num: int, db: Session = Depends(get_db)):
    """Xem ảnh đã render của 1 trang PDF cụ thể (lưu lúc OCR — xem ocr.save_pdf_page_images).

    CHỈ PDF mới có ảnh trang. pageCount giờ được ghi cho MỌI loại file (ảnh rời = 1 trang) nên
    nó KHÔNG còn nghĩa "file này có ảnh trang" như trước — ảnh jpg/png qua được chốt pageCount
    rồi vẫn 404 ở bước đọc MinIO bên dưới, đúng như mong đợi."""
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")
    if not doc.pageCount or page_num < 1 or page_num > doc.pageCount:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh trang này")

    key = f"{doc.caseId}/{doc.id}-pages/page-{page_num}.png"
    try:
        content = storage.get_document_bytes(key)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh trang này") from e
    return Response(content=content, media_type="image/png")


@router.post("/{document_id}/reclassify", response_model=DocumentDTO)
def reclassify_document(document_id: str, engine: str = "auto", db: Session = Depends(get_db)):
    """`engine=paddle`: đọc lại bằng PaddleOCR-VL thay vì thứ tự nguồn mặc định.

    Dành cho lúc bản đọc tự động sai và nhân viên muốn thử nguồn khác. Mọi kiểm tra phải xong
    TRƯỚC khi đặt status="OCR_RUNNING" bên dưới: trả lỗi sau khi đã đặt là document kẹt vĩnh
    viễn ở trạng thái "đang đọc" (không có tiến trình nền nào gỡ nó ra).
    """
    if engine not in ("auto", "paddle"):
        raise HTTPException(status_code=400, detail=f"Không có cách đọc tên '{engine}'.")
    if engine == "paddle" and not paddle_ocr_vl.is_enabled():
        raise HTTPException(
            status_code=400,
            detail="Máy chủ này chưa bật PaddleOCR-VL (thiếu PADDLE_OCR_VL_URL) — dùng 'Phân tích lại' thường.",
        )

    # Xem giải thích ở patch_document: phải nhớ mục CŨ vì phân loại lại có thể chuyển file
    # RA KHỎI mục tiết kiệm, lúc đó tổng số dư cũng phải tính lại.
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")

    was_savings = is_savings_item(doc.matchedChecklistItemId)

    all_items = db.scalars(select(ChecklistItem)).all()
    applicable_items = [
        i
        for i in all_items
        if is_item_applicable(
            i, doc.case.maritalStatus, doc.case.numberOfChildren, doc.case.skillLevel
        )
    ]

    doc.status = "OCR_RUNNING"
    doc.processingStartedAt = now_utc()
    db.commit()

    try:
        # LUÔN chạy lại OCR từ file gốc, không dùng lại ocrText cũ — trước đây có tối ưu
        # "nếu đã có ocrText thì bỏ qua OCR, chỉ chạy lại bước phân loại" để tiết kiệm thời
        # gian cho ca chỉ lỗi ở bước phân loại (vd DeepSeek rate limit). Bỏ tối ưu này vì nó
        # phá vỡ đúng lời hứa của nút "Phân tích lại" (UI ghi rõ "Đang chạy OCR + AI") — sau
        # khi cải thiện pipeline OCR (đổi PSM, hạ ngưỡng confidence), các document cũ bấm
        # "Phân tích lại" vẫn bị kẹt với text OCR cũ, không hề được OCR lại như nút hứa.
        # try_harder=True: thử nhiều cách tiền xử lý ảnh, giữ lại bản đọc được nhiều ký tự
        # nhất — chấp nhận chậm hơn (nhân viên đã chủ động bấm "Phân tích lại" để có kết
        # quả tốt hơn kết quả tự động lúc upload, không dùng cách nhanh mặc định nữa).
        content = storage.get_document_bytes(doc.storedPath)
        ocr_text, page_count, _lines, pages = ocr.extract_text(
            content, doc.originalFilename, doc.mimeType, try_harder=True,
            ocr_engine=None if engine == "auto" else engine,
        )

        is_pdf = doc.mimeType == "application/pdf" or doc.originalFilename.lower().endswith(".pdf")
        if is_pdf:
            ocr.save_pdf_page_images(doc.caseId, doc.id, pages)
        # Ghi số trang cho MỌI loại file chứ không riêng PDF: danh sách tài liệu hiển thị
        # số trang từng file, mà ảnh rời thì pageCount cũ để trống nên hiện ra ô trắng.
        # Đây là SỐ TRANG OCR ĐÃ ĐỌC (ảnh rời luôn là 1), khớp với số trang ảnh đã lưu.
        doc.pageCount = page_count

        doc.status = "CLASSIFYING"
        db.commit()

        outcome = classify_ocr_text(ocr_text, doc.originalFilename, applicable_items)
    except ValueError as e:
        doc.status = "ERROR"
        doc.classificationError = str(e)
        db.commit()
        dong_bo_hoan_thanh(db, doc.case)
        activity.ghi("DOC_RECLASSIFY", case=doc.case, document=doc,
                     detail=f"'{doc.originalFilename}' — lỗi: {str(e)[:120]}")
        db.refresh(doc)
        return doc

    doc.ocrText = outcome.ocr_text
    doc.correctedText = outcome.corrected_text
    # Chạy lại OCR từ đầu sinh ra correctedText hoàn toàn mới — bản chỉnh tay trước đó (nếu
    # có) được sửa dựa trên correctedText CŨ, giờ không còn khớp với bản mới nữa nên xoá đi
    # thay vì giữ lại 1 bản chỉnh tay đã lỗi thời, dễ gây nhầm lẫn hơn là hữu ích.
    doc.manualCorrectedText = None
    doc.status = outcome.status
    doc.matchedChecklistItemId = outcome.matched_checklist_item_id
    doc.aiRawLabel = outcome.ai_raw_label
    doc.aiConfidence = outcome.ai_confidence
    doc.aiReasoning = outcome.ai_reasoning
    doc.classificationError = outcome.classification_error
    ap_thong_tin_boc_duoc(doc, outcome.fields)
    doc.isManualOverride = False
    db.commit()
    dong_bo_hoan_thanh(db, doc.case)
    activity.ghi(
        "DOC_RECLASSIFY", case=doc.case, document=doc,
        detail=f"'{doc.originalFilename}'{' (Chữ mờ? Đọc lại)' if engine == 'paddle' else ''} → "
        + (activity.ten_muc(db, doc.matchedChecklistItemId) or "chưa khớp mục nào"),
    )

    if was_savings or is_savings_item(doc.matchedChecklistItemId):
        refresh_case_savings_quietly(db, doc.case)

    db.refresh(doc)
    return doc
