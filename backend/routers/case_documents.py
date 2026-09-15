from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

import ocr
import storage
from classify import ap_thong_tin_boc_duoc, classify_ocr_text
from completeness import is_item_applicable, is_savings_item
from db import get_db
from models import Case, ChecklistItem, Document, now_utc
from savings import refresh_case_savings_quietly
from schemas import DocumentDTO

router = APIRouter(prefix="/cases/{case_id}/documents", tags=["documents"])

MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024  # 20MB, dưới xa giới hạn 32MB của DeepSeek/Claude API


def _find_duplicate(db: Session, case_id: str, content: bytes) -> Document | None:
    """Tìm file đã có trong CÙNG hồ sơ với nội dung trùng khít (so từng byte).

    Upload trùng rất dễ xảy ra khi nhân viên chọn nhiều file cùng lúc (đã gặp thật: cùng 1
    CCCD nằm 2 lần trong danh sách) — mỗi lần trùng tốn TRỌN một lượt OCR 4 biến thể + 2 lần
    gọi DeepSeek, đúng thứ đang gây nặng máy, mà kết quả chắc chắn y hệt bản đã có.

    Lọc trước theo fileSizeBytes (cột đã có sẵn) để chỉ phải tải về từ MinIO những file CÓ
    KHẢ NĂNG trùng — thực tế gần như luôn 0 hoặc 1 file, nên rẻ hơn nhiều so với việc thêm
    cột lưu hash: không phải sửa cấu trúc bảng (schema đang quản lý thủ công, xem models.py),
    không phải chạy migration trên production, và có tác dụng NGAY với toàn bộ tài liệu cũ
    (nếu lưu hash thì các bản ghi cũ đều NULL, phải backfill mới dùng được).

    So từng byte thay vì so tên file: không có dương tính giả (2 file khác nhau vô tình
    trùng tên+dung lượng vẫn upload được), và bắt được cả file bị ĐỔI TÊN — trường hợp rất
    hay gặp khi trình duyệt tự thêm hậu tố "(1)" lúc tải lại cùng 1 file."""
    same_size = db.scalars(
        select(Document).where(
            Document.caseId == case_id, Document.fileSizeBytes == len(content)
        )
    ).all()
    for doc in same_size:
        try:
            if storage.get_document_bytes(doc.storedPath) == content:
                return doc
        except Exception:  # noqa: BLE001
            # File không còn trên MinIO (đã bị xoá thủ công/lỗi lưu trữ) — không thể so sánh
            # nên coi như không trùng, để người dùng vẫn upload được thay vì bị chặn oan.
            continue
    return None


def _find_same_name(db: Session, case_id: str, filename: str) -> Document | None:
    """Tìm bản CŨ của cùng một giấy tờ: cùng hồ sơ, cùng tên file.

    Chỉ gọi SAU _find_duplicate, nên tới đây nội dung chắc chắn đã KHÁC — tức nhân viên đã
    sửa file rồi upload lại (scan lại cho rõ, bổ sung trang, sửa nội dung bên trong). Trước
    đây trường hợp này tạo thêm một bản ghi THỨ HAI cùng tên: bản cũ đã lỗi thời vẫn nằm
    nguyên trong hồ sơ, cùng khớp vào một mục checklist, nhìn vào không biết bản nào mới.
    Giờ xử như thao tác lưu đè file trong thư mục — lấy bản mới, bỏ bản cũ.

    Chỉ nhận khi có ĐÚNG MỘT file cùng tên. Nhiều file trùng tên nghĩa là chính cách đặt tên
    đã mơ hồ (vd cả hồ sơ toàn "scan.pdf") — đè bừa lúc đó là xoá mất một giấy tờ KHÁC, nên
    thà thêm bản ghi mới và để nhân viên tự dọn."""
    same_name = db.scalars(
        select(Document).where(
            Document.caseId == case_id, Document.originalFilename == filename
        )
    ).all()
    return same_name[0] if len(same_name) == 1 else None


def _reset_for_new_version(document: Document, key: str, mime_type: str, size: int) -> None:
    """Đưa bản ghi cũ về đúng trạng thái như vừa upload lần đầu, giữ nguyên id.

    Giữ id (thay vì xoá bản ghi rồi tạo mới) vì ảnh từng trang PDF lưu theo key cố định
    "{caseId}/{id}-pages/page-{n}.png" — cùng id thì ảnh trang mới ghi đè thẳng lên ảnh cũ,
    không để lại rác trong MinIO.

    Xoá SẠCH mọi thứ suy ra từ nội dung cũ, KỂ CẢ phần nhân viên sửa tay (manualCorrectedText,
    manualExpiresAt, isManualOverride). Giữ lại nghe có vẻ tiếc công, nhưng những trường đó
    được ưu tiên hơn bản AI ở mọi chỗ hiển thị và phân tích (xem models.py) — để nguyên là
    bản sửa tay của nội dung CŨ tiếp tục đè lên nội dung MỚI, sai theo kiểu không nhìn ra."""
    document.storedPath = key
    document.mimeType = mime_type
    document.fileSizeBytes = size
    document.uploadedAt = now_utc()
    document.pageCount = None
    document.ocrText = None
    document.correctedText = None
    document.manualCorrectedText = None
    document.matchedChecklistItemId = None
    document.aiRawLabel = None
    document.aiConfidence = None
    document.aiReasoning = None
    document.aiDocOwner = None
    document.aiHolderName = None
    document.aiHolderDob = None
    document.aiIdNumber = None
    document.aiIdType = None
    document.aiIssuedAt = None
    document.aiExpiresAt = None
    document.manualExpiresAt = None
    document.aiFieldsNote = None
    document.classificationError = None
    document.isManualOverride = False
    document.status = "OCR_RUNNING"


def _xoa_anh_trang_cu(case_id: str, document_id: str, page_count: int | None) -> None:
    """Dọn ảnh từng trang của bản CŨ. Bản mới có thể ít trang hơn bản cũ — không dọn thì
    những trang thừa của bản cũ nằm lại nguyên key và vẫn mở ra được qua
    GET /documents/{id}/pages/{n}, trộn nội dung hai bản với nhau."""
    for i in range(1, (page_count or 0) + 1):
        try:
            storage.delete_document(f"{case_id}/{document_id}-pages/page-{i}.png")
        except Exception:  # noqa: BLE001
            # Không xoá được ảnh cũ chỉ để lại rác trong MinIO — không đáng làm hỏng cả
            # lượt upload bản mới vốn đã thành công.
            pass


@router.post("", response_model=DocumentDTO, status_code=201)
def upload_document(
    case_id: str,
    response: Response,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    # `def` thường (không phải `async def`) — QUAN TRỌNG: hàm này gọi OCR (subprocess
    # Tesseract, block) và DeepSeek (HTTP client đồng bộ, block) bên trong, có thể mất
    # 30-150s. Nếu khai `async def` mà không await đúng cách, các lệnh block này chạy
    # thẳng trên event loop asyncio duy nhất của Uvicorn — ĐÓNG BĂNG TOÀN BỘ server cho
    # MỌI người dùng khác (kể cả các request GET đơn giản không liên quan) suốt thời gian
    # xử lý. Đã xác nhận bằng thực nghiệm: 3 upload đồng thời làm 1 GET đơn giản treo hơn
    # 10s. Khai `def` thường để FastAPI/Starlette tự chạy trong threadpool riêng, cho phép
    # nhiều request chạy song song thật sự — đúng pattern các route khác trong app đã dùng.
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    filename = file.filename or "file"
    if len(filename) > 191:
        raise HTTPException(status_code=400, detail="Tên file quá dài (tối đa 191 ký tự)")

    content = file.file.read()
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=400, detail="File quá lớn (tối đa 20MB)")

    # Chặn TRƯỚC khi lưu vào MinIO và trước khi chạy OCR/AI — mục đích chính là tiết kiệm
    # tài nguyên, nên phải chặn ở đây chứ không phải sau khi đã xử lý xong.
    duplicate = _find_duplicate(db, case_id, content)
    if duplicate:
        raise HTTPException(
            status_code=409,
            detail=f'File này đã có trong hồ sơ ("{duplicate.originalFilename}") — bỏ qua, không cần upload lại.',
        )

    # Không tin mù quáng Content-Type client tự khai báo — xác nhận thật ra có file tên
    # ".webp" nhưng khai báo "image/webp" trong khi nội dung byte thật là JPEG, khiến ảnh
    # hiển thị lỗi không ổn định phía trình duyệt. Dò lại định dạng thật từ nội dung file.
    mime_type = ocr.detect_real_mime_type(content, file.content_type or "application/octet-stream")
    key = storage.upload_document(case_id, filename, content, mime_type)

    # Cùng tên nhưng nội dung đã khác = bản mới của chính giấy tờ đó -> lưu đè lên bản ghi
    # cũ, đúng như thao tác "replace" khi chép file vào thư mục đã có file trùng tên. Nếu
    # thêm bản ghi thứ hai thì hồ sơ đọng lại cả bản cũ lẫn bản mới cùng tên, cùng khớp một
    # mục checklist, và nhân viên không có cách nào nhìn ra bản nào là bản đang dùng.
    previous = _find_same_name(db, case_id, filename)
    replaced_key = None
    replaced_page_count = None
    # Bản CŨ có phải giấy tờ tài chính không — phải đọc TRƯỚC khi xoá matchedChecklistItemId.
    # Nếu bản cũ là sổ tiết kiệm mà bản mới không phải, số dư của cả hồ sơ vẫn đang cộng tiền
    # của bản cũ; không tính lại thì con số đó sai mà không có dấu hiệu gì.
    replaced_was_savings = False
    if previous is not None:
        replaced_key = previous.storedPath
        replaced_page_count = previous.pageCount
        replaced_was_savings = is_savings_item(previous.matchedChecklistItemId)
        document = previous
        _reset_for_new_version(document, key, mime_type, len(content))
        # 200 thay cho 201: không tạo thêm tài liệu nào, chỉ thay nội dung tài liệu đã có.
        # Frontend dựa vào đúng con số này để báo "đã cập nhật bản mới" thay vì "đã thêm".
        response.status_code = 200
    else:
        document = Document(
            caseId=case_id,
            originalFilename=filename,
            storedPath=key,
            mimeType=mime_type,
            fileSizeBytes=len(content),
            status="OCR_RUNNING",
        )
        db.add(document)
    db.commit()
    db.refresh(document)

    # Dọn bản cũ SAU khi commit: commit hỏng thì bản ghi vẫn đang trỏ vào file cũ, xoá trước
    # là mất trắng tài liệu. Xoá sau thì tệ nhất cũng chỉ còn lại một file mồ côi trong MinIO.
    if replaced_key:
        _xoa_anh_trang_cu(case_id, document.id, replaced_page_count)
        try:
            storage.delete_document(replaced_key)
        except Exception:  # noqa: BLE001
            pass

    all_items = db.scalars(select(ChecklistItem)).all()
    applicable_items = [
        i
        for i in all_items
        if is_item_applicable(i, case.maritalStatus, case.numberOfChildren, case.skillLevel)
    ]

    is_pdf = mime_type == "application/pdf" or filename.lower().endswith(".pdf")

    try:
        # try_harder=True cho PDF ngay từ lần upload đầu — đã xác nhận bằng thực nghiệm
        # trên PDF thật (CCCD scan chèn vào trang A4) là cách xử lý mặc định (1 lần, nhanh)
        # có thể trả về HOÀN TOÀN RỖNG (0 ký tự) với loại file này, phải dùng "best-of"
        # (thử nhiều cách tiền xử lý, trong đó có nhị phân hoá) mới đọc được. Ảnh thường
        # (jpg/png) vẫn dùng cách nhanh mặc định vì không gặp vấn đề này.
        ocr_text, page_count, _lines, pages = ocr.extract_text(
            content, document.originalFilename, mime_type, try_harder=is_pdf
        )

        if is_pdf:
            ocr.save_pdf_page_images(case_id, document.id, pages)
            document.pageCount = page_count

        document.status = "CLASSIFYING"
        db.commit()

        outcome = classify_ocr_text(ocr_text, document.originalFilename, applicable_items)
    except ValueError as e:
        outcome = None
        document.status = "ERROR"
        document.classificationError = str(e)

    if outcome is not None:
        document.ocrText = outcome.ocr_text
        document.correctedText = outcome.corrected_text
        document.status = outcome.status
        document.matchedChecklistItemId = outcome.matched_checklist_item_id
        document.aiRawLabel = outcome.ai_raw_label
        document.aiConfidence = outcome.ai_confidence
        document.aiReasoning = outcome.ai_reasoning
        document.classificationError = outcome.classification_error
        ap_thong_tin_boc_duoc(document, outcome.fields)

    db.commit()

    # File vừa vào là giấy tờ tài chính -> đọc lại số dư của cả hồ sơ ngay, để nhân viên mở
    # hồ sơ ra là thấy sẵn kết luận đủ/thiếu tiền, không phải bấm thêm nút nào. Đọc lại TOÀN
    # BỘ giấy tờ tài chính chứ không chỉ file này: tổng số dư phụ thuộc vào việc đối chiếu
    # các sổ với nhau để không cộng trùng (xem SAVINGS_SYSTEM_PROMPT ở classify.py).
    #
    # Bản "quietly" — lỗi ở bước phụ này không được phép làm hỏng lượt upload đã thành công.
    if is_savings_item(document.matchedChecklistItemId) or replaced_was_savings:
        refresh_case_savings_quietly(db, case)

    db.refresh(document)
    return document


@router.delete("")
def delete_all_documents(case_id: str, db: Session = Depends(get_db)):
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")

    documents = db.scalars(select(Document).where(Document.caseId == case_id)).all()
    had_savings_document = any(is_savings_item(doc.matchedChecklistItemId) for doc in documents)
    for doc in documents:
        storage.delete_document(doc.storedPath)
        db.delete(doc)
    db.commit()

    if had_savings_document:
        db.expire(case, ["documents"])
        refresh_case_savings_quietly(db, case)
    return {"ok": True, "deletedCount": len(documents)}
