import os
import secrets
from typing import Optional

from fastapi import Header, HTTPException


def require_admin(x_admin_password: str = Header(...)) -> None:
    expected = os.environ["ADMIN_PASSWORD"]
    if not secrets.compare_digest(x_admin_password, expected):
        raise HTTPException(status_code=401, detail="Sai mật khẩu admin")


def is_admin(x_admin_password: Optional[str] = Header(default=None)) -> bool:
    """Người gọi có phải admin không — KHÔNG chặn ai, chỉ trả True/False.

    Dùng cho endpoint dùng CHUNG giữa nhân viên và admin (PATCH /cases/{id}): trang admin gọi
    qua adminFetch có gửi kèm mật khẩu, trang nhân viên thì không. Mật khẩu SAI coi như không
    phải admin chứ không báo lỗi — không thì gõ sai mật khẩu ở trang admin lại làm hỏng luôn
    việc lưu ở trang nhân viên.

    Optional[str] chứ không "str | None": container chạy Python 3.9, FastAPI đọc chú thích kiểu
    ngay lúc khởi động (xem bẫy PEP 604 trong AGENTS.md).
    """
    expected = os.environ.get("ADMIN_PASSWORD", "")
    return bool(x_admin_password and expected and secrets.compare_digest(x_admin_password, expected))
