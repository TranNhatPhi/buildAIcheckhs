"""Quy ước trạng thái nghiệp vụ và lịch nhắc của hồ sơ định cư."""

from __future__ import annotations

import os

from datetime import datetime, timedelta, timezone


# Thứ tự này cũng là thứ tự hiển thị trên giao diện. APPROVED/REJECTED là hai trạng thái
# kết thúc; mọi trạng thái trước đó vẫn cần admin theo dõi cho đến khi có quyết định.
#
# Giữ nguyên MÃ cũ (READY_TO_SUBMIT, SUBMITTED, APPROVED, REJECTED) dù đổi tên hiển thị: mã nằm
# trong DB, nhật ký email và lịch nhắc — đổi mã là phải chuyển dữ liệu mà không được gì thêm.
CASE_STATUS_DEFINITIONS = (
    # --- Phần nhân viên (trang checklist) ---
    {"value": "PENDING", "label": "Chờ tiếp nhận", "color": "#6B7280"},
    {"value": "COLLECTING_DOCUMENTS", "label": "Đang thu thập giấy tờ", "color": "#D97706"},
    {"value": "REVIEWING_DOCUMENTS", "label": "Đang kiểm tra hồ sơ", "color": "#4F46E5"},
    # Đủ 100% giấy tờ bắt buộc — tự chuyển (case_auto_status) và là CỬA DUY NHẤT sang phần admin.
    {"value": "COMPLETED", "label": "Hoàn thành", "color": "#0D9488"},
    # --- Phần admin (trang quản trị) ---
    {"value": "READY_TO_SUBMIT", "label": "Sẵn sàng nộp", "color": "#0284C7"},
    # Trước đây tên "Đã nộp": đã nộp lên, đang chờ cơ quan xét duyệt trả kết quả.
    {"value": "SUBMITTED", "label": "Đang xử lý", "color": "#2563EB"},
    {"value": "APPROVED", "label": "Được chấp thuận", "color": "#059669"},
    {"value": "REJECTED", "label": "Không thành công", "color": "#DC2626"},
    # Khép hồ sơ sau khi không thành công (không nộp lại nữa). CHỈ vào được từ "Không thành công".
    {"value": "LIQUIDATED", "label": "Thanh lý hồ sơ", "color": "#475569"},
)

# Trạng thái đã bỏ (bộ 11 trạng thái cũ) -> trạng thái mới tương ứng. seed.py chuyển dữ liệu
# theo bảng này mỗi lần deploy, để không hồ sơ nào mang mã không còn trên giao diện.
LEGACY_STATUS_MAP = {
    "UNDER_REVIEW": "SUBMITTED",
    "ADDITIONAL_DOCUMENTS_REQUIRED": "SUBMITTED",
    "AWAITING_DECISION": "SUBMITTED",
}

FINAL_CASE_STATUSES = frozenset({"APPROVED", "REJECTED", "LIQUIDATED"})


# Chia quyền đổi trạng thái theo GIAI ĐOẠN: nhân viên lo từ lúc nhận tới khi đủ giấy tờ, admin
# lo từ lúc nộp trở đi. "Hoàn thành" là điểm bàn giao giữa hai bên.
STAFF_STATUSES = ("PENDING", "COLLECTING_DOCUMENTS", "REVIEWING_DOCUMENTS", "COMPLETED")
ADMIN_STATUSES = ("READY_TO_SUBMIT", "SUBMITTED", "APPROVED", "REJECTED", "LIQUIDATED")

# "Nộp lại lần N" không phải trạng thái lưu trong DB mà là một THAO TÁC (POST /cases/{id}/resubmit):
# xoá hết file, tăng lần nộp, đưa hồ sơ về "Chờ tiếp nhận". Chỉ cho hồ sơ đã thật sự nộp đi mà
# chưa đậu — "Sẵn sàng nộp" chưa nộp thì không có gì để nộp lại, "Được chấp thuận" là xong rồi.
RESUBMIT_FROM_STATUSES = ("SUBMITTED", "REJECTED")
# Chỉ được nộp lại MỘT lần: lần 2 là lần cuối, không có lần nộp thứ 3 (quy định văn phòng).
MAX_SUBMISSION_ROUND = 2


def ly_do_khong_chuyen_duoc(den: str, hien_tai: str, tien_do: int, la_admin: bool) -> str | None:
    """Lý do KHÔNG được chuyển hồ sơ sang trạng thái `den`; None = được phép.

    Quy tắc theo đúng thứ tự hồ sơ đi:
      - "Hoàn thành" chỉ khi đủ 100% giấy tờ bắt buộc;
      - vào phần admin chỉ qua MỘT cửa: "Hoàn thành" -> "Sẵn sàng nộp".

    Bản giống hệt nằm ở lib/application-status.ts (statusChangeBlockedReason) để giao diện làm
    mờ sẵn lựa chọn không hợp lệ. Backend vẫn kiểm tra lại: chỉ chặn trên giao diện là có ngày
    một ô chọn mới quên áp quy tắc.

    Giữ nguyên trạng thái cũ luôn hợp lệ: bấm lưu (vd sửa tên khách) không bao giờ bị chặn.

    Chia quyền: nhân viên chỉ đổi trong STAFF_STATUSES và chỉ khi hồ sơ CÒN ở giai đoạn đó; admin
    đổi trong ADMIN_STATUSES và được TRẢ VỀ "Hoàn thành". Lối trả về đó là bắt buộc: không có nó
    thì lỡ bấm nhầm "Sẵn sàng nộp" là hồ sơ kẹt — nhân viên không đổi được vì đã sang phần admin,
    admin không đổi được vì không có quyền phần checklist.
    """
    if den == hien_tai:
        return None
    if not la_admin:
        if hien_tai in ADMIN_STATUSES:
            return "Hồ sơ đã chuyển cho admin — từ 'Sẵn sàng nộp' trở đi do admin cập nhật ở trang quản trị."
        if den not in STAFF_STATUSES:
            return "Từ 'Sẵn sàng nộp' trở đi do admin cập nhật ở trang quản trị."
    elif den == "COMPLETED":
        # Chỉ là lối TRẢ VỀ cho hồ sơ đã sang phần admin; hồ sơ còn ở giai đoạn giấy tờ thì việc
        # đánh dấu "Hoàn thành" là của nhân viên (và của việc tự chuyển khi đủ 100%).
        if hien_tai not in ADMIN_STATUSES:
            return "Hồ sơ còn ở giai đoạn giấy tờ — chuyển sang 'Hoàn thành' do nhân viên làm ở trang checklist."
    elif den not in ADMIN_STATUSES:
        return "Trang quản trị chỉ cập nhật từ 'Sẵn sàng nộp' trở đi (hoặc trả hồ sơ về 'Hoàn thành')."
    # Khớp quy tắc tự chuyển (case_auto_status.trang_thai_theo_tien_do): chọn tay trái quy tắc thì
    # lượt quét mỗi giờ lại đổi về — chặn ngay từ đầu cho khỏi "tự nhảy" khó hiểu.
    if den == "PENDING" and tien_do > 0:
        return f"Hồ sơ đã có giấy tờ ({tien_do}%) — 'Chờ tiếp nhận' chỉ dành cho hồ sơ 0%."
    if den in ("COLLECTING_DOCUMENTS", "REVIEWING_DOCUMENTS") and tien_do <= 0:
        return "Hồ sơ chưa có giấy tờ bắt buộc nào (0%) — vẫn ở 'Chờ tiếp nhận', upload giấy tờ là tự chuyển."
    if den == "COMPLETED" and tien_do < 100:
        return f"Chưa đủ 100% giấy tờ bắt buộc (đang {tien_do}%) — chưa chuyển sang 'Hoàn thành' được."
    if den in ADMIN_STATUSES and hien_tai not in ADMIN_STATUSES:
        if hien_tai != "COMPLETED":
            return "Chỉ hồ sơ ở trạng thái 'Hoàn thành' mới chuyển cho admin được."
        if den != "READY_TO_SUBMIT":
            return "Hồ sơ phải chuyển sang 'Sẵn sàng nộp' trước."
    # "Thanh lý hồ sơ" chỉ dành cho hồ sơ đã "Không thành công"; đã thanh lý thì chỉ trả về được
    # "Không thành công" (lỡ bấm nhầm) — không mở lại thẳng sang nộp / Hoàn thành từ đây.
    if den == "LIQUIDATED" and hien_tai != "REJECTED":
        return "Chỉ hồ sơ 'Không thành công' mới chuyển sang 'Thanh lý hồ sơ' được."
    if hien_tai == "LIQUIDATED" and den != "REJECTED":
        return "Hồ sơ đã thanh lý — chỉ trả về được 'Không thành công'."
    return None


# Hồ sơ được đánh dấu hoàn tất sẽ bị XOÁ VĨNH VIỄN (cả khách hàng lẫn file) sau bấy nhiêu ngày —
# xem case_cleanup.py. Lịch sử: 15 ngày xoá mềm -> 14 ngày chỉ xoá file -> 14 ngày xoá hẳn.
# Để ở đây cho endpoint đánh dấu và tiến trình dọn dùng CHUNG một con số — hai nơi khai riêng
# là hứa một đằng xoá một nẻo.
CASE_AUTO_DELETE_DAYS = int(os.getenv("CASE_AUTO_DELETE_DAYS", "14"))

STATUS_REMINDER_INTERVAL_DAYS = 14

# Báo email NGAY khi chuyển sang, không đợi chu kỳ 14 ngày: "Đang xử lý" (trước là "Đã nộp") là
# mốc cần ghi nhận đúng ngày để tính thời gian chờ kết quả. Các trạng thái còn lại chỉ đi theo
# đường nhắc định kỳ (xem next_status_reminder_at).
INSTANT_EMAIL_STATUSES = frozenset({"SUBMITTED"})


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
        # Lần nộp: 1 = lần đầu; admin bấm "Nộp lại" thì tăng lên (hiện "Nộp lại lần 2" cạnh tên).
        "submissionRound": case.submissionRound or 1,
        # "Ngày cập nhật" ở trang thống kê = lần có FILE MỚI gần nhất (None = chưa có file) — cùng mốc
        # với nhắc "7 ngày chưa cập nhật" (thong_bao.py), không phải updatedAt: sửa ghi chú hay lượt
        # tự đồng bộ trạng thái cũng chạm updatedAt mà hồ sơ chẳng tiến thêm bước nào.
        "lastDocumentAt": max((d.uploadedAt for d in case.documents if d.uploadedAt), default=None),
    }
