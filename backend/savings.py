"""Đọc số dư tiết kiệm của một hồ sơ từ chính các giấy tờ tài chính đã nộp.

Tách riêng khỏi routers/ vì có 2 nơi cần dùng: tự động chạy sau khi upload xong một giấy tờ
tài chính (routers/case_documents.py) và nút "Đọc lại" bấm tay (routers/cases.py).
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from classify import extract_savings_balance
from completeness import is_savings_item
from models import Case, now_utc

logger = logging.getLogger("savings")


def collect_savings_text(case: Case) -> str:
    """Gom nội dung các giấy tờ đã khớp vào mục tiết kiệm/số dư của hồ sơ này.

    CHỈ lấy giấy tờ ĐÃ khớp mục (matchedChecklistItemId) — file còn đang chờ nhân viên soát
    lại thì chưa chắc là giấy tờ tài chính, đưa vào sẽ khiến AI cộng nhầm tiền từ giấy tờ
    khác vào tổng số dư."""
    parts: list[str] = []
    for doc in case.documents:
        if not is_savings_item(doc.matchedChecklistItemId):
            continue
        # Cùng thứ tự ưu tiên với analyze_case: bản nhân viên sửa tay đáng tin nhất.
        text = doc.manualCorrectedText or doc.correctedText or doc.ocrText
        if text and text.strip():
            parts.append(f"[{doc.matchedChecklistItemId}] ({doc.originalFilename})\n{text.strip()}")
    return "\n\n".join(parts)


def refresh_case_savings(db: Session, case: Case) -> str | None:
    """Đọc lại số dư bằng AI và ghi vào Case. Trả về thông báo lỗi, hoặc None nếu xong.

    KHÔNG đụng tới savingsManualVnd — số nhân viên tự nhập luôn được giữ nguyên và vẫn thắng
    số AI đọc (xem completeness.assess_savings). Chạy lại chỉ làm mới phần AI đề xuất."""
    documents_text = collect_savings_text(case)
    if not documents_text.strip():
        return "Hồ sơ chưa có giấy tờ tài chính nào đã được phân loại để đọc số dư."

    total_vnd, note, error = extract_savings_balance(documents_text)
    if error:
        return error

    case.savingsAiVnd = total_vnd
    case.savingsAiNote = note
    case.savingsUpdatedAt = now_utc()
    db.commit()
    logger.info("Hồ sơ %s: AI đọc số dư = %s", case.id, total_vnd)
    return None


def refresh_case_savings_quietly(db: Session, case: Case) -> None:
    """Bản dùng cho luồng upload: đọc lại số dư nhưng KHÔNG BAO GIỜ làm hỏng request gọi nó.

    Upload đã là đường dài (OCR + sửa lỗi + phân loại, có thể hàng chục giây — xem
    case_documents.upload_document); để một lỗi ở bước phụ này ném ra ngoài sẽ làm hỏng cả
    lượt upload dù file đã lưu và đã phân loại xong hoàn toàn bình thường."""
    try:
        error = refresh_case_savings(db, case)
        if error:
            logger.info("Hồ sơ %s: chưa đọc được số dư (%s)", case.id, error)
    except Exception as e:  # noqa: BLE001
        logger.warning("Hồ sơ %s: lỗi khi đọc số dư sau upload: %s", case.id, e)
        db.rollback()
