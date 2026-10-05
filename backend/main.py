"""
Backend FastAPI cho app "Checklist Hồ Sơ Canada" — gộp toàn bộ: quản lý hồ sơ (case),
upload/quản lý document, tính đủ/thiếu checklist, OCR (VietOCR local) và phân loại
(DeepSeek). Next.js chỉ còn là frontend gọi sang API này (xem NEXT_PUBLIC_API_URL).
"""
import logging
import os
import socket

from dotenv import load_dotenv

load_dotenv("../.env.local")
load_dotenv("../.env")  # DATABASE_URL

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

import activity
import ocr
import paddle_ocr_vl
from routers import (
    activity_log,
    admin,
    case_documents,
    cases,
    contract_templates,
    documents,
    notifications,
    ocr_test,
    translation_check,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("backend")

app = FastAPI(title="Canada Checklist Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
    # Trình duyệt chỉ cho JS đọc header tuỳ biến khi được liệt kê ở đây (gọi khác nguồn gốc).
    expose_headers=["X-Check-Id"],
)

app.include_router(cases.router)
app.include_router(case_documents.router)
app.include_router(documents.router)
app.include_router(ocr_test.router)
app.include_router(admin.router)
app.include_router(translation_check.router)
app.include_router(activity_log.router)
app.include_router(notifications.router)
app.include_router(contract_templates.router)


@app.middleware("http")
async def nhan_dien_nguoi_thao_tac(request: Request, call_next):
    """Ai đang gọi (tên tự chọn trong cookie, IP, trình duyệt, có phải admin) — đọc MỘT lần rồi
    cất vào contextvar để endpoint gọi activity.ghi(...) không phải nhận thêm tham số."""
    token = activity.dat(activity.nhan_dien(
        request.headers, request.cookies, request.client.host if request.client else None
    ))
    try:
        return await call_next(request)
    finally:
        activity.bo(token)


@app.on_event("startup")
def startup():
    ocr.load_models()
    logger.info("Backend ready.")


@app.get("/health")
def health():
    # "instance" = tên container đang phục vụ request này. Có 3 replica backend sau load
    # balancer (xem docker-compose.yml) nên khi một replica đọc sai/chậm/treo, đây là cách
    # nhanh nhất để biết request rơi vào cái nào mà đi đọc đúng log đó. Caddy cũng dùng
    # chính endpoint này làm health check.
    return {"status": "ok", "modelsLoaded": ocr.models_loaded(), "instance": socket.gethostname()}


@app.get("/config")
def config():
    return {
        "hasDeepseekKey": bool(os.getenv("DEEPSEEK_API_KEY")),
        # Frontend ẩn nút "Đọc lại bằng PaddleOCR-VL" khi máy chủ không có service này
        # (production trên VM GCP không có GPU nên không khai PADDLE_OCR_VL_URL) — hiện nút
        # bấm vào chỉ báo lỗi thì thà đừng hiện.
        "hasPaddleOcrVl": paddle_ocr_vl.is_enabled(),
    }
