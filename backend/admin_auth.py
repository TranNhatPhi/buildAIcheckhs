import os
import secrets

from fastapi import Header, HTTPException


def require_admin(x_admin_password: str = Header(...)) -> None:
    expected = os.environ["ADMIN_PASSWORD"]
    if not secrets.compare_digest(x_admin_password, expected):
        raise HTTPException(status_code=401, detail="Sai mật khẩu admin")
