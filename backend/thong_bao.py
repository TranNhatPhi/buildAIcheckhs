"""Thông báo cho chuông — dùng CHUNG cho trang admin (GET /admin/notifications) và trang Docs
(GET /notifications), để hai bên luôn thấy cùng một danh sách. Hai loại, chỉ xét hồ sơ còn ở phần
nhân viên (chưa tới "Hoàn thành" = chưa làm xong để gửi nguồn):

- "DON_VI_KN": đã nhận "Đơn vị xác nhận kinh nghiệm" (ngày SỚM nhất trong các đơn vị) được
  NHAC_DON_VI_KN_NGAY ngày trở lên (giờ VN).
- "CHUA_CAP_NHAT": NHAC_IM_LANG_NGAY ngày không có file mới (lần upload gần nhất; chưa có file thì
  tính từ lúc tạo hồ sơ) mà vẫn còn thiếu giấy tờ bắt buộc. CÙNG quy tắc với khung nhắc vàng trong
  trang hồ sơ (components/CaseDetail.tsx, NGAY_IM_LANG_CANH_BAO) — sửa thì sửa cả hai.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from completeness import compute_checklist_summary
from models import Case, ChecklistItem, now_utc
from schemas import parse_experience_units

NHAC_DON_VI_KN_NGAY = int(os.getenv("EXPERIENCE_UNIT_REMINDER_DAYS", "7"))
NHAC_IM_LANG_NGAY = 7
CHUA_GUI_NGUON = ("PENDING", "COLLECTING_DOCUMENTS", "REVIEWING_DOCUMENTS")


def moc_cap_nhat(c: Case):
    """Lần có file mới gần nhất; chưa có file thì lúc tạo hồ sơ."""
    return max((d.uploadedAt for d in c.documents if d.uploadedAt), default=None) or c.createdAt


def ngay_chua_cap_nhat(c: Case, tom_tat) -> int | None:
    """Số ngày không có file mới NẾU hồ sơ thuộc diện nhắc "7 ngày chưa cập nhật", ngược lại None.

    Một chỗ duy nhất cho quy tắc này: chuông Docs, thẻ "7 ngày chưa cập nhật hồ sơ" ở tổng quan
    admin (qua CaseListItemDTO.idleDays) và bộ lọc trang thống kê đều đọc từ đây.
    `tom_tat` = kết quả compute_checklist_summary của chính hồ sơ (nơi gọi đã có sẵn).
    """
    if c.deletedAt is not None or c.applicationStatus not in CHUA_GUI_NGUON:
        return None
    moc = moc_cap_nhat(c)
    if moc is None:
        return None
    so_ngay = (now_utc() - moc).days
    thieu = tom_tat.total_required_items - tom_tat.completed_required_items
    return so_ngay if so_ngay >= NHAC_IM_LANG_NGAY and thieu > 0 and tom_tat.percent < 100 else None


def ho_so_qua_han(db: Session) -> dict:
    """{"reminderDays", "idleDays", "items": [...]} — mỗi item có "kind" (DON_VI_KN | CHUA_CAP_NHAT).

    Không có "đã đọc": hồ sơ tới "Hoàn thành" (hoặc có file mới / nộp đủ) là tự biến khỏi danh
    sách — thông báo còn đó chừng nào việc còn chưa xong.
    """
    hom_nay = datetime.now(timezone(timedelta(hours=7))).date()
    items = db.scalars(select(ChecklistItem)).all()
    don_vi_kn, chua_cap_nhat = [], []
    for c in db.scalars(
        select(Case).where(Case.deletedAt.is_(None), Case.applicationStatus.in_(CHUA_GUI_NGUON))
    ):
        tom_tat = None

        def tien_do():
            nonlocal tom_tat
            if tom_tat is None:
                tom_tat = compute_checklist_summary(
                    items, c.documents, c.maritalStatus, c.numberOfChildren, c.skillLevel,
                    force_complete=c.completedAt is not None,
                )
            return tom_tat

        # --- Đơn vị xác nhận kinh nghiệm quá hạn ---
        don_vi = parse_experience_units(c.experienceUnits)
        ngay = []
        for u in don_vi:
            try:
                ngay.append(date.fromisoformat(u["confirmedDate"]))
            except (TypeError, ValueError):
                continue
        if ngay:
            ngay_nhan = min(ngay)
            han = ngay_nhan + timedelta(days=NHAC_DON_VI_KN_NGAY)
            if hom_nay >= han:
                don_vi_kn.append({
                    "kind": "DON_VI_KN",
                    "caseId": c.id,
                    "clientName": c.clientName,
                    "partner": c.partner,
                    "units": [u["name"] for u in don_vi],
                    "receivedDate": ngay_nhan.isoformat(),
                    "dueDate": han.isoformat(),
                    "daysOverdue": (hom_nay - han).days,
                    "applicationStatus": c.applicationStatus,
                    "percent": tien_do().percent,
                })

        # --- 7 ngày không có file mới mà còn thiếu giấy tờ bắt buộc ---
        so_ngay = ngay_chua_cap_nhat(c, tien_do())
        if so_ngay is not None:
            tt = tien_do()
            moc = moc_cap_nhat(c)
            thieu = tt.total_required_items - tt.completed_required_items
            chua_cap_nhat.append({
                "kind": "CHUA_CAP_NHAT",
                "caseId": c.id,
                "clientName": c.clientName,
                "partner": c.partner,
                # Ngày theo giờ VN để hiện ra đúng ngày nhân viên thấy trên lịch.
                "lastUpdate": (moc + timedelta(hours=7)).date().isoformat(),
                "neverUploaded": not c.documents,
                "daysIdle": so_ngay,
                "missingCount": thieu,
                "applicationStatus": c.applicationStatus,
                "percent": tt.percent,
            })

    don_vi_kn.sort(key=lambda x: (-x["daysOverdue"], x["clientName"]))
    chua_cap_nhat.sort(key=lambda x: (-x["daysIdle"], x["clientName"]))
    return {"reminderDays": NHAC_DON_VI_KN_NGAY, "idleDays": NHAC_IM_LANG_NGAY, "items": don_vi_kn + chua_cap_nhat}
