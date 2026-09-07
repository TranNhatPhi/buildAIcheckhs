"""Gửi email định kỳ cho các hồ sơ chưa có kết quả Đậu/Rớt."""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from sqlalchemy import select

load_dotenv(".env.local")
load_dotenv("../.env.local")
load_dotenv("../.env")

from case_status import (  # noqa: E402
    CASE_STATUS_DEFINITIONS,
    FINAL_CASE_STATUSES,
    STATUS_REMINDER_INTERVAL_DAYS,
    next_status_reminder_at,
)
from db import SessionLocal  # noqa: E402
from models import Case, now_utc  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("status-reminder")

DEFAULT_ADMIN_EMAIL = "documentlncglobal@gmail.com"
DEFAULT_POLL_SECONDS = 24 * 60 * 60
EMAILJS_SEND_URL = "https://api.emailjs.com/api/v1.0/email/send"
# api.emailjs.com nằm sau Cloudflare, và Cloudflare CHẶN thẳng User-Agent mặc định của
# urllib ("Python-urllib/3.9"): trả HTTP 403 với body "error code: 1010" — đó là lỗi của
# Cloudflare, KHÔNG phải EmailJS, nên đừng đi lục lại key hay cấu hình template.
# Đã đo: cùng payload, chỉ cần đặt User-Agent bất kỳ khác mặc định là request vào tới
# EmailJS (nhận đúng lỗi nghiệp vụ của họ). Không cần giả làm trình duyệt.
EMAILJS_USER_AGENT = "lnc-status-reminder/1.0"
STATUS_LABELS = {item["value"]: item["label"] for item in CASE_STATUS_DEFINITIONS}
STATUS_COLORS = {item["value"]: item["color"] for item in CASE_STATUS_DEFINITIONS}
REMINDER_CASE_STATUSES = tuple(
    item["value"]
    for item in CASE_STATUS_DEFINITIONS
    if item["value"] not in FINAL_CASE_STATUSES
)
VIETNAM_TIMEZONE = timezone(timedelta(hours=7))


def _format_datetime(value: datetime | None) -> str:
    if value is None:
        return "Chưa có"
    local_value = value.replace(tzinfo=timezone.utc).astimezone(VIETNAM_TIMEZONE)
    return local_value.strftime("%d/%m/%Y %H:%M (giờ Việt Nam)")


def _case_url(case_id: str) -> str | None:
    base_url = os.getenv("APP_BASE_URL", "").strip().rstrip("/")
    return f"{base_url}/cases/{case_id}" if base_url else None


def _build_template_params(cases: list[Case], sent_at: datetime) -> dict[str, object]:
    return {
        "case_count": len(cases),
        "sent_at": _format_datetime(sent_at),
        "cases": [
            {
                "client_name": case.clientName,
                "status_label": STATUS_LABELS[case.applicationStatus],
                "status_color": STATUS_COLORS[case.applicationStatus],
                "updated_at": _format_datetime(
                    case.applicationStatusUpdatedAt or case.createdAt
                ),
                "case_url": _case_url(case.id) or "#",
            }
            for case in cases
        ],
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


def _send_template(template_params: dict[str, object]) -> None:
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
        # sai ở đâu: "Account not found" là sai service_id hoặc user_id, "Account not found"
        # KHÔNG liên quan private key — nếu private key sai thì lỗi sẽ khác hẳn.
        raise RuntimeError(
            f"EmailJS trả lỗi HTTP {exc.code}: {detail}. Đang dùng {_mo_ta_config(config)}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(f"Không kết nối được EmailJS: {exc.reason}") from exc


def send_test_email() -> None:
    now = now_utc()
    _send_template(
        {
            "case_count": 1,
            "sent_at": _format_datetime(now),
            "cases": [
                {
                    "client_name": "Hồ sơ kiểm tra EmailJS",
                    "status_label": "Đang kiểm tra hồ sơ",
                    "status_color": "#4F46E5",
                    "updated_at": _format_datetime(now),
                    "case_url": os.getenv("APP_BASE_URL", "").strip() or "#",
                }
            ],
        }
    )
    logger.info("Đã gửi email kiểm tra tới %s.", DEFAULT_ADMIN_EMAIL)


def run_once(*, dry_run: bool = False) -> int:
    """Gửi một email tổng hợp, rồi mới ghi mốc gửi để chu kỳ kế tiếp không bị sai."""
    db = SessionLocal()
    try:
        now = now_utc()
        candidates = db.scalars(
            select(Case).where(
                Case.deletedAt.is_(None),
                Case.applicationStatus.in_(REMINDER_CASE_STATUSES),
            )
        ).all()
        due_cases = sorted(
            (
                case
                for case in candidates
                if (due_at := next_status_reminder_at(case)) is not None and due_at <= now
            ),
            key=lambda case: next_status_reminder_at(case) or now,
        )
        if not due_cases:
            logger.info("Không có hồ sơ nào đến hạn nhắc.")
            return 0

        template_params = _build_template_params(due_cases, now)
        if dry_run:
            logger.info(
                "DRY RUN — sẽ gửi %s hồ sơ tới %s.\n%s",
                len(due_cases),
                DEFAULT_ADMIN_EMAIL,
                json.dumps(template_params, ensure_ascii=False, indent=2),
            )
            return len(due_cases)

        _send_template(template_params)
        for case in due_cases:
            case.lastStatusReminderAt = now
        db.commit()
        logger.info(
            "Đã gửi email nhắc %s hồ sơ tới %s qua EmailJS.",
            len(due_cases),
            DEFAULT_ADMIN_EMAIL,
        )
        return len(due_cases)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Gửi email nhắc trạng thái hồ sơ")
    parser.add_argument("--once", action="store_true", help="Chạy một lần rồi thoát")
    parser.add_argument("--dry-run", action="store_true", help="In nội dung, không gửi email")
    parser.add_argument(
        "--test-email",
        action="store_true",
        help="Gửi email kiểm tra ngay, không thay đổi lịch nhắc hồ sơ",
    )
    args = parser.parse_args()

    if args.test_email:
        send_test_email()
        return
    if args.once:
        run_once(dry_run=args.dry_run)
        return

    poll_seconds = int(os.getenv("STATUS_REMINDER_POLL_SECONDS", str(DEFAULT_POLL_SECONDS)))
    logger.info(
        "Bắt đầu kiểm tra email nhắc mỗi %s giây; chu kỳ từng hồ sơ là %s ngày.",
        poll_seconds,
        STATUS_REMINDER_INTERVAL_DAYS,
    )
    while True:
        try:
            run_once(dry_run=args.dry_run)
        except Exception:
            # Tiến trình phải sống để tự thử lại vào vòng sau; crash-loop liên tục vì một
            # lần Gmail mất kết nối sẽ vừa gây nhiễu log vừa không giúp gửi sớm hơn.
            logger.exception("Gửi email nhắc thất bại; sẽ thử lại ở vòng kiểm tra kế tiếp.")
        time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
