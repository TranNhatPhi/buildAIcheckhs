from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

import ocr
import storage
from classify import classify_ocr_text
from completeness import is_item_applicable
from db import get_db
from models import Case, ChecklistItem, Document
from schemas import DocumentDTO

router = APIRouter(prefix="/cases/{case_id}/documents", tags=["documents"])

MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024  # 20MB, dưới xa giới hạn 32MB của DeepSeek/Claude API


@router.post("", response_model=DocumentDTO, status_code=201)
def upload_document(case_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
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

    content = file.file.read()
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=400, detail="File quá lớn (tối đa 20MB)")

    # Không tin mù quáng Content-Type client tự khai báo — xác nhận thật ra có file tên
    # ".webp" nhưng khai báo "image/webp" trong khi nội dung byte thật là JPEG, khiến ảnh
    # hiển thị lỗi không ổn định phía trình duyệt. Dò lại định dạng thật từ nội dung file.
    mime_type = ocr.detect_real_mime_type(content, file.content_type or "application/octet-stream")
    key = storage.upload_document(case_id, file.filename or "file", content, mime_type)

    document = Document(
        caseId=case_id,
        originalFilename=file.filename or "file",
        storedPath=key,
        mimeType=mime_type,
        fileSizeBytes=len(content),
        status="OCR_RUNNING",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    all_items = db.scalars(select(ChecklistItem)).all()
    applicable_items = [
        i
        for i in all_items
        if is_item_applicable(i, case.maritalStatus, case.numberOfChildren, case.skillLevel)
    ]

    is_pdf = mime_type == "application/pdf" or (file.filename or "").lower().endswith(".pdf")

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

    db.commit()
    db.refresh(document)
    return document


@router.delete("")
def delete_all_documents(case_id: str, db: Session = Depends(get_db)):
    documents = db.scalars(select(Document).where(Document.caseId == case_id)).all()
    for doc in documents:
        storage.delete_document(doc.storedPath)
        db.delete(doc)
    db.commit()
    return {"ok": True, "deletedCount": len(documents)}
