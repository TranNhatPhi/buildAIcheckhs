"""Gửi email định kỳ cho các hồ sơ chưa có kết quả Đậu/Rớt."""

from __future__ import annotations

import argparse
import html
import logging
import os
import smtplib
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

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
STATUS_LABELS = {item["value"]: item["label"] for item in CASE_STATUS_DEFINITIONS}
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


def _build_message(cases: list[Case], sent_at: datetime) -> EmailMessage:
    recipient = os.getenv("STATUS_REMINDER_TO_EMAIL", DEFAULT_ADMIN_EMAIL).strip()
    sender = os.getenv("GMAIL_SENDER_EMAIL", DEFAULT_ADMIN_EMAIL).strip()
    subject = f"[LNC] Nhắc kiểm tra {len(cases)} hồ sơ chưa có kết quả"

    text_lines = [
        f"Có {len(cases)} hồ sơ đã đến chu kỳ nhắc {STATUS_REMINDER_INTERVAL_DAYS} ngày:",
        "",
    ]
    html_rows = []
    for index, case in enumerate(cases, start=1):
        status_label = STATUS_LABELS[case.applicationStatus]
        updated_at = case.applicationStatusUpdatedAt or case.createdAt
        url = _case_url(case.id)
        case_lines = [
            f"{index}. Hồ sơ: {case.clientName}",
            f"   Trạng thái: {status_label}",
            f"   Cập nhật trạng thái: {_format_datetime(updated_at)}",
        ]
        if url:
            case_lines.append(f"   Mở hồ sơ: {url}")
        case_lines.append("")
        text_lines.extend(case_lines)
        link_html = (
            f'<a href="{html.escape(url)}">Mở hồ sơ</a>' if url else "Không có đường dẫn"
        )
        html_rows.append(
            "<tr>"
            f"<td>{index}</td>"
            f"<td>{html.escape(case.clientName)}</td>"
            f"<td>{html.escape(status_label)}</td>"
            f"<td>{html.escape(_format_datetime(updated_at))}</td>"
            f"<td>{link_html}</td>"
            "</tr>"
        )

    text_lines.extend(
        [
            "Vui lòng kiểm tra và cập nhật trạng thái. Hồ sơ Đã đậu/Đã rớt sẽ tự ngừng nhắc.",
            f"Email tự động tạo lúc {_format_datetime(sent_at)}.",
        ]
    )
    html_body = f"""
    <html><body>
      <p>Có <strong>{len(cases)}</strong> hồ sơ đã đến chu kỳ nhắc
      <strong>{STATUS_REMINDER_INTERVAL_DAYS} ngày</strong>:</p>
      <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse">
        <thead><tr><th>STT</th><th>Hồ sơ</th><th>Trạng thái</th><th>Cập nhật</th><th>Thao tác</th></tr></thead>
        <tbody>{''.join(html_rows)}</tbody>
      </table>
      <p>Vui lòng kiểm tra và cập nhật trạng thái. Hồ sơ Đã đậu/Đã rớt sẽ tự ngừng nhắc.</p>
    </body></html>
    """

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.set_content("\n".join(text_lines))
    message.add_alternative(html_body, subtype="html")
    return message


def _send_message(message: EmailMessage) -> None:
    sender = os.getenv("GMAIL_SENDER_EMAIL", DEFAULT_ADMIN_EMAIL).strip()
    # Google hiển thị App Password thành từng nhóm có khoảng trắng; bỏ khoảng trắng giúp
    # người cấu hình có thể dán nguyên giá trị mà SMTP vẫn đăng nhập đúng.
    app_password = os.getenv("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()
    if not app_password:
        raise RuntimeError("Thiếu GMAIL_APP_PASSWORD; chưa thể gửi email nhắc.")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(sender, app_password)
        smtp.send_message(message)


def send_test_email() -> None:
    recipient = os.getenv("STATUS_REMINDER_TO_EMAIL", DEFAULT_ADMIN_EMAIL).strip()
    sender = os.getenv("GMAIL_SENDER_EMAIL", DEFAULT_ADMIN_EMAIL).strip()
    message = EmailMessage()
    message["Subject"] = "[LNC] Kiểm tra cấu hình email nhắc hồ sơ"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        "Cấu hình email nhắc hồ sơ đã hoạt động. Hệ thống sẽ kiểm tra hằng ngày và chỉ "
        f"nhắc lại từng hồ sơ sau mỗi {STATUS_REMINDER_INTERVAL_DAYS} ngày cho đến khi "
        "trạng thái là Đã đậu hoặc Đã rớt."
    )
    _send_message(message)
    logger.info("Đã gửi email kiểm tra tới %s.", recipient)


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

        message = _build_message(due_cases, now)
        if dry_run:
            logger.info(
                "DRY RUN — sẽ gửi %s hồ sơ tới %s.\n%s",
                len(due_cases),
                message["To"],
                message.get_body(preferencelist=("plain",)).get_content(),
            )
            return len(due_cases)

        _send_message(message)
        for case in due_cases:
            case.lastStatusReminderAt = now
        db.commit()
        logger.info("Đã gửi email nhắc %s hồ sơ tới %s.", len(due_cases), message["To"])
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
