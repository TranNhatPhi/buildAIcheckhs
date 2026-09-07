"""Gửi email qua EmailJS — dùng chung cho hai đường: tiến trình nhắc định kỳ 14 ngày
(status_reminder.py) và thông báo tức thì khi đổi trạng thái hồ sơ (routers/cases.py).

Cả hai đường dùng CHUNG một template EmailJS (`EMAILJS_TEMPLATE_ID`) nhận `cases` là một
mảng — thông báo tức thì chỉ là mảng một phần tử. Cố ý làm vậy để không phải tạo và bảo
trì thêm template thứ hai trên dashboard.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from case_status import CASE_STATUS_DEFINITIONS

logger = logging.getLogger("emailjs")

EMAILJS_SEND_URL = "https://api.emailjs.com/api/v1.0/email/send"
# api.emailjs.com nằm sau Cloudflare, và Cloudflare CHẶN thẳng User-Agent mặc định của
# urllib ("Python-urllib/3.9"): trả HTTP 403 với body "error code: 1010" — đó là lỗi của
# Cloudflare, KHÔNG phải EmailJS, nên đừng đi lục lại key hay cấu hình template.
# Đã đo: cùng payload, chỉ cần đặt User-Agent bất kỳ khác mặc định là request vào tới
# EmailJS (nhận đúng lỗi nghiệp vụ của họ). Không cần giả làm trình duyệt.
EMAILJS_USER_AGENT = "lnc-status-reminder/1.0"

STATUS_LABELS = {item["value"]: item["label"] for item in CASE_STATUS_DEFINITIONS}
STATUS_COLORS = {item["value"]: item["color"] for item in CASE_STATUS_DEFINITIONS}
VIETNAM_TIMEZONE = timezone(timedelta(hours=7))


def format_datetime(value: datetime | None) -> str:
    if value is None:
        return "Chưa có"
    local_value = value.replace(tzinfo=timezone.utc).astimezone(VIETNAM_TIMEZONE)
    return local_value.strftime("%d/%m/%Y %H:%M (giờ Việt Nam)")


def case_url(case_id: str) -> str | None:
    base_url = os.getenv("APP_BASE_URL", "").strip().rstrip("/")
    return f"{base_url}/cases/{case_id}" if base_url else None


def build_case_row(
    *, case_id: str, client_name: str, application_status: str, updated_at: datetime | None
) -> dict[str, str]:
    """Một dòng hồ sơ trong email.

    Nhận giá trị thuần chứ không nhận object Case: thông báo tức thì chạy trong
    BackgroundTask, tức SAU khi session DB đã đóng — chạm vào thuộc tính ORM lúc đó có thể
    nổ DetachedInstanceError. Đọc sẵn giá trị ra ngay trong request rồi truyền vào đây.
    """
    return {
        "client_name": client_name,
        "status_label": STATUS_LABELS.get(application_status, application_status),
        "status_color": STATUS_COLORS.get(application_status, "#6B7280"),
        "updated_at": format_datetime(updated_at),
        "case_url": case_url(case_id) or "#",
    }


def _che(value: str) -> str:
    """Che bớt để log được trên VM mà không lộ nguyên khoá."""
    return f"{value[:4]}…{value[-2:]} ({len(value)} ký tự)" if len(value) > 8 else "(quá ngắn)"


def _mo_ta_config(config: dict[str, str]) -> str:
    # service_id/template_id/public key vốn không phải bí mật nên in đủ; chỉ che private key.
    return (
        f"service_id={config['service_id']}, template_id={config['template_id']}, "
        f"user_id={config['user_id']}, accessToken={_che(config['accessToken'])}"
    )


def send_template(template_params: dict[str, object]) -> None:
    """Gửi một email. Ném RuntimeError nếu thất bại — nơi gọi tự quyết định nuốt hay không."""
    config = {
        "service_id": os.getenv("EMAILJS_SERVICE_ID", "").strip(),
        "template_id": os.getenv("EMAILJS_TEMPLATE_ID", "").strip(),
        "user_id": os.getenv("EMAILJS_PUBLIC_KEY", "").strip(),
        "accessToken": os.getenv("EMAILJS_PRIVATE_KEY", "").strip(),
    }
    missing = [name for name, value in config.items() if not value]
    if missing:
        raise RuntimeError("Thiếu cấu hình EmailJS: " + ", ".join(missing))

    payload = {**config, "template_params": template_params}
    request = Request(
        EMAILJS_SEND_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": EMAILJS_USER_AGENT},
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"EmailJS trả về HTTP {response.status}.")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        # Kèm luôn giá trị đang dùng (che bớt) vì thông báo của EmailJS quá cụt để lần ra
        # sai ở đâu: "Account not found" là sai service_id hoặc user_id, KHÔNG liên quan
        # private key — nếu private key sai thì lỗi sẽ khác hẳn.
        raise RuntimeError(
            f"EmailJS trả lỗi HTTP {exc.code}: {detail}. Đang dùng {_mo_ta_config(config)}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(f"Không kết nối được EmailJS: {exc.reason}") from exc


def build_template_params(
    rows: list[dict[str, str]], sent_at: datetime, *, title: str, intro: str, footer: str
) -> dict[str, object]:
    """Gói dữ liệu cho template EmailJS.

    title/intro/footer là BIẾN chứ không nằm cứng trong template, vì hai đường gửi nói hai
    chuyện khác nhau: nhắc định kỳ nói "đã đến chu kỳ 14 ngày", báo tức thì nói "vừa đổi
    trạng thái". Đóng đinh chữ trong template thì một trong hai đường sẽ gửi email sai nội
    dung. Bản đối chiếu của template nằm ở emailjs-template.html ngoài thư mục gốc.
    """
    return {
        "email_title": title,
        "email_intro": intro,
        "email_footer": footer,
        "case_count": len(rows),
        "sent_at": format_datetime(sent_at),
        "cases": rows,
    }


def send_cases(
    rows: list[dict[str, str]], sent_at: datetime, *, title: str, intro: str, footer: str
) -> None:
    send_template(build_template_params(rows, sent_at, title=title, intro=intro, footer=footer))
