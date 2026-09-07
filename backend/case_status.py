"""Quy ước trạng thái nghiệp vụ và lịch nhắc của hồ sơ định cư."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


# Thứ tự này cũng là thứ tự hiển thị trên giao diện. APPROVED/REJECTED là hai trạng thái
# kết thúc; mọi trạng thái trước đó vẫn cần admin theo dõi cho đến khi có quyết định.
CASE_STATUS_DEFINITIONS = (
    {"value": "PENDING", "label": "Chờ tiếp nhận", "color": "#6B7280"},
    {"value": "COLLECTING_DOCUMENTS", "label": "Đang thu thập giấy tờ", "color": "#D97706"},
    {"value": "REVIEWING_DOCUMENTS", "label": "Đang kiểm tra hồ sơ", "color": "#4F46E5"},
    {"value": "READY_TO_SUBMIT", "label": "Sẵn sàng nộp", "color": "#0284C7"},
    {"value": "SUBMITTED", "label": "Đã nộp", "color": "#2563EB"},
    {"value": "UNDER_REVIEW", "label": "Đang xét duyệt", "color": "#7C3AED"},
    {"value": "ADDITIONAL_DOCUMENTS_REQUIRED", "label": "Cần bổ sung giấy tờ", "color": "#EA580C"},
    {"value": "AWAITING_DECISION", "label": "Chờ kết quả", "color": "#0891B2"},
    {"value": "APPROVED", "label": "Đã đậu", "color": "#059669"},
    {"value": "REJECTED", "label": "Đã rớt", "color": "#DC2626"},
)

FINAL_CASE_STATUSES = frozenset({"APPROVED", "REJECTED"})
STATUS_REMINDER_INTERVAL_DAYS = 14


def next_status_reminder_at(case) -> datetime | None:
    """Tính mốc nhắc kế tiếp để chức năng email sau này chỉ cần truy vấn và gửi.

    Đổi trạng thái sẽ xoá mốc đã nhắc gần nhất, vì một giai đoạn mới cần đủ 14 ngày trước
    lần nhắc đầu tiên. Hồ sơ đã đậu/rớt không còn được nhắc.
    """
    if case.applicationStatus in FINAL_CASE_STATUSES:
        return None
    anchor = case.lastStatusReminderAt or case.applicationStatusUpdatedAt or case.createdAt
    return anchor + timedelta(days=STATUS_REMINDER_INTERVAL_DAYS)


def case_status_fields(case) -> dict:
    """Các field trạng thái dùng chung cho mọi DTO hồ sơ."""
    next_reminder = next_status_reminder_at(case)
    utc_now = datetime.now(timezone.utc).replace(tzinfo=None)
    return {
        "applicationStatus": case.applicationStatus,
        "applicationStatusUpdatedAt": case.applicationStatusUpdatedAt,
        "lastStatusReminderAt": case.lastStatusReminderAt,
        "nextStatusReminderAt": next_reminder,
        "statusReminderDue": next_reminder is not None and next_reminder <= utc_now,
        "statusReminderIntervalDays": STATUS_REMINDER_INTERVAL_DAYS,
    }
