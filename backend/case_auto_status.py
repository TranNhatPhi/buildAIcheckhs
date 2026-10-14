"""Tự chuyển trạng thái phần nhân viên theo tiến độ giấy tờ — HOÀN TOÀN theo % (13/10/2026, admin yêu cầu):

- tiến độ <= NGUONG_CHO_TIEP_NHAN (20%)  -> "Chờ tiếp nhận"
- trên 20%, dưới 100%                    -> "Đang thu thập giấy tờ"
- đủ 100% giấy tờ bắt buộc               -> "Hoàn thành"

Đi CẢ HAI chiều: tụt % (xoá file, gỡ file khỏi mục, đổi hôn nhân làm checklist dài ra...) thì lùi
trạng thái theo — giữ đúng "Hoàn thành chỉ khi 100%", không thì hồ sơ thiếu giấy vẫn nằm ở "Hoàn
thành" và admin nhận sang "Sẵn sàng nộp" được.

Hồ sơ đã sang phần admin (từ "Sẵn sàng nộp" trở đi) thì KHÔNG đụng tới: lúc đó trạng thái phản
ánh việc nộp/xét duyệt, không còn phản ánh giấy tờ — "Đang xử lý" mà tự nhảy về "Hoàn thành" chỉ
vì một file bị gỡ là mất dấu hồ sơ đang ở đâu với cơ quan xét duyệt.

Gọi SAU khi đã commit thay đổi giấy tờ, ở mọi endpoint làm đổi tiến độ; tiến trình case_cleanup
quét thêm mỗi giờ làm lưới an toàn cho chỗ nào lọt (và để chuyển các hồ sơ đã 100% từ trước).
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from case_status import ADMIN_STATUSES, NGUONG_CHO_TIEP_NHAN
from completeness import compute_checklist_summary
from models import Case, ChecklistItem, now_utc

logger = logging.getLogger(__name__)

TRANG_THAI_KHI_TUT = "COLLECTING_DOCUMENTS"


def trang_thai_theo_tien_do(hien_tai: str, tien_do: int) -> str | None:
    """Trạng thái mới nên chuyển sang; None = giữ nguyên."""
    if hien_tai in ADMIN_STATUSES:
        return None
    if tien_do >= 100:
        moi = "COMPLETED"
    elif tien_do <= NGUONG_CHO_TIEP_NHAN:
        moi = "PENDING"
    else:
        moi = TRANG_THAI_KHI_TUT
    return None if moi == hien_tai else moi


def dong_bo_hoan_thanh(db: Session, case: Case | None, items: list[ChecklistItem] | None = None) -> bool:
    """Chuyển trạng thái theo tiến độ nếu cần và commit. Trả True khi có đổi.

    Không bao giờ ném lỗi ra ngoài: đây là bước phụ chạy sau khi upload/xoá đã thành công, hỏng
    ở đây không được làm hỏng thao tác chính của nhân viên.
    """
    if case is None or case.deletedAt is not None or case.applicationStatus in ADMIN_STATUSES:
        return False
    try:
        db.expire(case, ["documents"])        # vừa thêm/xoá file trong transaction trước
        if items is None:
            items = db.scalars(select(ChecklistItem)).all()
        tien_do = compute_checklist_summary(
            items, case.documents, case.maritalStatus, case.numberOfChildren, case.skillLevel,
            force_complete=case.completedAt is not None,
        ).percent
        moi = trang_thai_theo_tien_do(case.applicationStatus, tien_do)
        if moi is None:
            return False
        logger.info("Hồ sơ %s: %d%% -> tự chuyển %s -> %s", case.id, tien_do, case.applicationStatus, moi)
        case.applicationStatus = moi
        # Giống đổi tay: bắt đầu lại chu kỳ nhắc kiểm tra trạng thái.
        case.applicationStatusUpdatedAt = now_utc()
        case.lastStatusReminderAt = None
        db.commit()
        return True
    except Exception:
        logger.exception("Không tự đồng bộ được trạng thái hồ sơ %s", getattr(case, "id", "?"))
        db.rollback()
        return False


def tien_do_that(db: Session, case: Case) -> int:
    """Tiến độ THẬT theo giấy tờ — KHÔNG tính dấu "Hoàn tất" (force_complete=False)."""
    db.expire(case, ["documents"])
    return compute_checklist_summary(
        db.scalars(select(ChecklistItem)).all(), case.documents,
        case.maritalStatus, case.numberOfChildren, case.skillLevel, force_complete=False,
    ).percent


def bo_hoan_tat_neu_tut(db: Session, case: Case, truoc: int) -> bool:
    """Xoá file làm % giảm (Docs yêu cầu 14/10/2026: "xoá file nào ràng buộc % thì % phải giảm").

    Hồ sơ thường tự giảm vì % tính lại từ giấy tờ. Hồ sơ ĐÃ "Hoàn tất" bị ép 100% (force_complete) nên
    phải BỎ Hoàn tất — completedAt + hẹn xoá file (autoDeleteAt) — khi tiến độ THẬT sau khi xoá thấp hơn
    `truoc` (tiến độ thật ngay trước khi xoá). Xoá file không tính vào % (file thừa, mục tuỳ chọn còn file
    khác...) thì giữ nguyên Hoàn tất. Gọi TRƯỚC dong_bo_hoan_thanh để trạng thái lùi theo % mới. Trả True
    nếu đã bỏ Hoàn tất. Không ném lỗi (bước phụ sau thao tác xoá đã thành công)."""
    if case is None or case.completedAt is None:
        return False
    try:
        sau = tien_do_that(db, case)
        if sau >= truoc:
            return False
        case.completedAt = None
        case.autoDeleteAt = None
        db.commit()
        logger.info("Hồ sơ %s: xoá file làm tiến độ thật %d%% -> %d%% — tự bỏ Hoàn tất", case.id, truoc, sau)
        import activity

        activity.ghi("CASE_UNCOMPLETE", case=case,
                     detail=f"Tự bỏ Hoàn tất: xoá file làm tiến độ giảm {truoc}% → {sau}% (huỷ hẹn xoá file)")
        return True
    except Exception:
        logger.exception("Không tự bỏ Hoàn tất được cho hồ sơ %s", getattr(case, "id", "?"))
        db.rollback()
        return False
