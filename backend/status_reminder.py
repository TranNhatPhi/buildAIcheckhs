"""Gửi email định kỳ cho các hồ sơ chưa có kết quả Đậu/Rớt."""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime

from dotenv import load_dotenv
from sqlalchemy import select

load_dotenv(".env.local")
load_dotenv("../.env.local")
load_dotenv("../.env")

import emailjs  # noqa: E402
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
REMINDER_CASE_STATUSES = tuple(
    item["value"]
    for item in CASE_STATUS_DEFINITIONS
    if item["value"] not in FINAL_CASE_STATUSES
)


def _build_template_params(cases: list[Case], sent_at: datetime) -> dict[str, object]:
    rows = [
        emailjs.build_case_row(
            case_id=case.id,
            client_name=case.clientName,
            application_status=case.applicationStatus,
            updated_at=case.applicationStatusUpdatedAt or case.createdAt,
        )
        for case in cases
    ]
    return emailjs.build_template_params(
        rows,
        sent_at,
        title="Nhắc kiểm tra trạng thái hồ sơ",
        intro=(
            f"Có {len(rows)} hồ sơ đã đến chu kỳ nhắc {STATUS_REMINDER_INTERVAL_DAYS} ngày "
            "và vẫn chưa có kết quả đậu hoặc rớt."
        ),
        footer=(
            "Vui lòng kiểm tra và cập nhật trạng thái. Hồ sơ chuyển sang Đã đậu hoặc Đã rớt "
            "sẽ tự động ngừng nhận thông báo."
        ),
    )


def send_test_email() -> None:
    now = now_utc()
    emailjs.send_template(
        emailjs.build_template_params(
            [
                {
                    "client_name": "Hồ sơ kiểm tra EmailJS",
                    "status_label": "Đang kiểm tra hồ sơ",
                    "status_color": "#4F46E5",
                    "updated_at": emailjs.format_datetime(now),
                    "case_url": os.getenv("APP_BASE_URL", "").strip() or "#",
                }
            ],
            now,
            title="Email kiểm tra cấu hình EmailJS",
            intro=(
                "Đây là email kiểm tra, không phải nhắc hồ sơ thật. Nhận được thư này nghĩa "
                "là cấu hình EmailJS đang hoạt động."
            ),
            footer="Không cần làm gì với email này.",
        )
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

        emailjs.send_template(template_params)
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
