"""Chuông thông báo trang Docs — công khai như mọi API của trang Docs (chưa có đăng nhập).

Router RIÊNG (prefix /notifications) chứ không đặt dưới /cases: GET /cases/{case_id} khai trước sẽ
nuốt mất "/cases/notifications" thành một case_id và trả 404.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import thong_bao
from db import get_db

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
def docs_notifications(db: Session = Depends(get_db)):
    return thong_bao.ho_so_qua_han(db)
