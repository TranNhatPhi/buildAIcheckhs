"""Xoá VĨNH VIỄN một hồ sơ: toàn bộ file trên MinIO, các dòng Document, và chính hồ sơ.

Dùng chung cho cả hai đường xoá cứng — nút "Xoá vĩnh viễn" ở trang admin, và tiến trình
case_cleanup (hồ sơ đánh dấu hoàn tất quá 14 ngày) — để hai nơi không bao giờ xoá khác nhau.

Xoá theo CẢ THƯ MỤC "<case_id>/" chứ không từng tài liệu: file gốc nằm ở storedPath, còn ảnh
từng trang PDF ("<doc_id>-pages/page-N.png") thì không có cột nào trỏ tới. Bản xoá cũ đi theo
storedPath nên để sót toàn bộ ảnh trang — chính là ảnh chụp CCCD/khai sinh của khách, nặng gấp
hàng chục lần file gốc (đo: một trang 17 MB, file gốc 399 KB).

MinIO TRƯỚC, DB SAU. Làm ngược lại mà MinIO hỏng giữa chừng thì hồ sơ đã mất khỏi DB, không còn
gì để biết thư mục nào cần dọn — ảnh giấy tờ của khách nằm lại mãi mãi. Theo thứ tự này, MinIO
lỗi thì hàm ném lỗi và hồ sơ vẫn còn nguyên, lần sau xoá lại được.

Nhật ký email (EmailLog) KHÔNG bị xoá theo: nó chỉ lưu caseId dạng chữ, không có khoá ràng buộc,
và nội dung thư đã gửi vẫn cần tra lại được về sau.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

import storage
from models import Case


def hard_delete_case(db: Session, case: Case) -> int:
    """Xoá vĩnh viễn hồ sơ. Trả về số file đã xoá trên MinIO. KHÔNG khôi phục được."""
    so_file = storage.delete_prefix(f"{case.id}/")
    db.delete(case)  # cascade="all, delete-orphan" (models.py) xoá luôn các Document
    db.commit()
    return so_file


def purge_case_files(db: Session, case: Case) -> int:
    """Xoá TOÀN BỘ FILE giấy tờ của hồ sơ, GIỮ LẠI hồ sơ khách (thông tin, trạng thái, nguồn, đơn vị
    XNKN, lịch sử...). Dùng cho tự xoá sau "Hoàn tất" (case_cleanup.run_once) từ 13/10/2026 — Docs yêu
    cầu "xoá là xoá file thôi, profile vẫn giữ" sau khi 2 hồ sơ bị xoá hẳn cả khách.

    Cùng thứ tự MinIO TRƯỚC, DB SAU như hard_delete_case. Ghi filesPurgedAt để trang hồ sơ nói rõ
    "file đã xoá ngày ...", bỏ autoDeleteAt để vòng quét sau không xoá lại. completedAt giữ nguyên:
    hồ sơ vẫn hiện 100% / "Hoàn tất" như lúc nhân viên bấm. Trả về số file đã xoá trên MinIO."""
    from models import now_utc

    so_file = storage.delete_prefix(f"{case.id}/")
    for doc in list(case.documents):
        db.delete(doc)
    # File "hồ sơ hoàn thành" (<case_id>/hoan-thanh/...) đã bị xoá cùng thư mục ở trên -> bỏ luôn dòng DB.
    for f in list(case.finalDocuments):
        db.delete(f)
    case.filesPurgedAt = now_utc()
    case.autoDeleteAt = None
    db.commit()
    return so_file
