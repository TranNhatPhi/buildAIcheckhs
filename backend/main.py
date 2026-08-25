"""
Backend FastAPI cho app "Checklist Hồ Sơ Canada" — gộp toàn bộ: quản lý hồ sơ (case),
upload/quản lý document, tính đủ/thiếu checklist, OCR (VietOCR local) và phân loại
(DeepSeek). Next.js chỉ còn là frontend gọi sang API này (xem NEXT_PUBLIC_API_URL).
"""
import logging
import os

from dotenv import load_dotenv

load_dotenv("../.env.local")
load_dotenv("../.env")  # DATABASE_URL

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import ocr
from routers import admin, case_documents, cases, documents, ocr_test

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("backend")

app = FastAPI(title="Canada Checklist Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(cases.router)
app.include_router(case_documents.router)
app.include_router(documents.router)
app.include_router(ocr_test.router)
app.include_router(admin.router)


@app.on_event("startup")
def startup():
    ocr.load_models()
    logger.info("Backend ready.")


@app.get("/health")
def health():
    return {"status": "ok", "modelsLoaded": ocr.models_loaded()}


@app.get("/config")
def config():
    return {"hasDeepseekKey": bool(os.getenv("DEEPSEEK_API_KEY"))}
