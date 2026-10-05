"""Bản xem trước của mẫu hợp đồng lao động — PDF + ảnh từng trang, cho thư viện mẫu kiểu "xem
trước trang đầu" ở trang "Mẫu hợp đồng lao động" (giống thư viện mẫu CV).

Key trên MinIO (cố định theo id mẫu, không lưu DB — suy ra lại được):
    contract-templates/<id>/preview.pdf
    contract-templates/<id>/page-<n>.png
File gốc nằm ở ContractTemplate.storedPath (ngoài thư mục <id>/ — cho mẫu cũ không phải đổi key).

Word -> PDF bằng LibreOffice không giao diện (cài trong backend/Dockerfile). Mỗi lần chuyển dùng
một thư mục hồ sơ LibreOffice RIÊNG: hai lượt soffice chạy cùng lúc chung một hồ sơ thì lượt sau
thoát ngay mà không ra file (3 replica backend + nhiều người tải mẫu cùng lúc).
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile

import fitz  # PyMuPDF — đã có sẵn cho OCR

import storage

logger = logging.getLogger(__name__)

PREFIX = "contract-templates"
DPI_ANH = 110  # A4 ~ 910 x 1290 px: đủ nét cho thẻ xem trước lẫn trang xem chi tiết
TOI_DA_TRANG = 30


def key_pdf(template_id: str) -> str:
    return f"{PREFIX}/{template_id}/preview.pdf"


def key_trang(template_id: str, so: int) -> str:
    return f"{PREFIX}/{template_id}/page-{so}.png"


def word_sang_pdf(content: bytes, duoi: str) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        nguon = os.path.join(d, f"mau{duoi}")
        with open(nguon, "wb") as f:
            f.write(content)
        kq = subprocess.run(
            [
                "soffice",
                f"-env:UserInstallation=file://{d}/lo-profile",
                "--headless",
                "--norestore",
                "--convert-to",
                "pdf",
                "--outdir",
                d,
                nguon,
            ],
            capture_output=True,
            timeout=120,
        )
        dich = os.path.join(d, "mau.pdf")
        if kq.returncode != 0 or not os.path.exists(dich):
            raise RuntimeError(
                f"LibreOffice không chuyển được sang PDF (mã {kq.returncode}): "
                f"{kq.stderr.decode('utf-8', 'replace')[-300:]}"
            )
        with open(dich, "rb") as f:
            return f.read()


def tao_ban_xem_truoc(template_id: str, content: bytes, duoi: str) -> int:
    """Tạo PDF xem trước + ảnh từng trang, lưu lên MinIO. Trả về số trang. Lỗi thì ném ra —
    nơi gọi quyết định (upload: bỏ qua, mẫu vẫn dùng được, chỉ thiếu ảnh xem trước)."""
    pdf = content if duoi == ".pdf" else word_sang_pdf(content, duoi)
    storage.upload_object(key_pdf(template_id), pdf, "application/pdf")
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        so_trang = doc.page_count
        for i, trang in enumerate(doc):
            if i >= TOI_DA_TRANG:
                break
            png = trang.get_pixmap(dpi=DPI_ANH).tobytes("png")
            storage.upload_object(key_trang(template_id, i + 1), png, "image/png")
        return so_trang
    finally:
        doc.close()
