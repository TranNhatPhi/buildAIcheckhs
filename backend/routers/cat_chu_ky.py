"""CẮT chữ ký từ ảnh / PDF / Word (Docs 16/10/2026: "bôi 1 chữ ký trong ảnh hoặc pdf hoặc word thì lấy chữ ký đó ra").

    POST /signature-tools/preview   file -> {pages: [data URL JPEG], count}  ảnh xem trước từng trang để bôi vùng
    POST /signature-tools/crop      file + page + x, y, w, h (tỉ lệ 0..1 của trang) -> PNG vùng đã cắt (độ phân giải
                                    cao, CHƯA xoá nền — giao diện gửi tiếp vào POST /imm5645|imm1295/{id}/signature như
                                    ảnh tải lên, ở đó mới xoá nền / cắt sát / lưu thư viện).

KHÔNG LƯU file gốc (thường có thông tin riêng — vd ảnh mẫu Docs gửi có cả email + mật khẩu): cả 2 API chỉ đọc tạm
trong request, giao diện gửi lại file khi cắt. Thứ duy nhất được lưu là vùng chữ ký đã cắt (qua API thư viện).
"""
from __future__ import annotations

import base64
import io
import os

import fitz
from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from PIL import Image, ImageOps

import ocr

router = APIRouter(prefix="/signature-tools", tags=["signature-tools"])

TOI_DA_MB = 25
TRANG_TOI_DA = 20
RONG_XEM_TRUOC = 1400  # px — đủ nét để bôi chính xác
DPI_CAT = 300  # trang PDF / Word render lại ở độ phân giải này khi cắt


async def _doc(file: UploadFile) -> tuple[bytes, str]:
    noi_dung = await file.read()
    if not noi_dung:
        raise HTTPException(status_code=400, detail="File rỗng.")
    if len(noi_dung) > TOI_DA_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"File quá lớn (tối đa {TOI_DA_MB} MB).")
    return noi_dung, (file.filename or "").lower()


def _pdf_cua(noi_dung: bytes, ten: str) -> bytes | None:
    """PDF / Word / Excel -> bytes PDF; ảnh -> None."""
    if ocr.la_file_van_phong(ten):
        import contract_preview

        try:
            return contract_preview.word_sang_pdf(noi_dung, os.path.splitext(ten)[1])
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="Không mở được file Word / Excel — file hỏng hoặc có mật khẩu.") from e
    if ten.endswith(".pdf") or noi_dung[:5] == b"%PDF-":
        return noi_dung
    return None


def _mo_anh(noi_dung: bytes) -> Image.Image:
    try:
        return ImageOps.exif_transpose(Image.open(io.BytesIO(noi_dung))).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Không đọc được file — chọn ảnh (JPG / PNG), PDF hoặc Word.") from e


def _data_url(img: Image.Image) -> str:
    if img.width > RONG_XEM_TRUOC:
        img = img.resize((RONG_XEM_TRUOC, round(img.height * RONG_XEM_TRUOC / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=82)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


@router.post("/preview")
async def xem_truoc(file: UploadFile = File(...)):
    noi_dung, ten = await _doc(file)
    pdf = _pdf_cua(noi_dung, ten)
    if pdf is None:
        return {"pages": [_data_url(_mo_anh(noi_dung))], "count": 1}
    try:
        doc = fitz.open(stream=pdf, filetype="pdf")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Không mở được PDF — file hỏng hoặc có mật khẩu.") from e
    try:
        trang = []
        for p in list(doc)[:TRANG_TOI_DA]:
            pix = p.get_pixmap(dpi=min(150, int(RONG_XEM_TRUOC / max(1.0, p.rect.width) * 72)))
            trang.append(_data_url(Image.frombytes("RGB", (pix.width, pix.height), pix.samples)))
        return {"pages": trang, "count": len(doc)}
    finally:
        doc.close()


@router.post("/crop")
async def cat(
    file: UploadFile = File(...),
    page: int = Form(0),
    x: float = Form(...),
    y: float = Form(...),
    w: float = Form(...),
    h: float = Form(...),
):
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1):
        raise HTTPException(status_code=400, detail="Vùng bôi không hợp lệ.")
    noi_dung, ten = await _doc(file)
    pdf = _pdf_cua(noi_dung, ten)
    if pdf is None:
        img = _mo_anh(noi_dung)
    else:
        doc = fitz.open(stream=pdf, filetype="pdf")
        try:
            if not 0 <= page < min(len(doc), TRANG_TOI_DA):
                raise HTTPException(status_code=400, detail="Không có trang này.")
            p = doc[page]
            # Chỉ render đúng vùng đã bôi ở DPI cao — nét chữ ký sắc mà không phải dựng cả trang.
            r = p.rect
            vung = fitz.Rect(r.x0 + x * r.width, r.y0 + y * r.height,
                             r.x0 + min(1.0, x + w) * r.width, r.y0 + min(1.0, y + h) * r.height)
            pix = p.get_pixmap(dpi=DPI_CAT, clip=vung)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        finally:
            doc.close()
        x, y, w, h = 0.0, 0.0, 1.0, 1.0
    W, H = img.size
    hop = (round(x * W), round(y * H), round(min(1.0, x + w) * W), round(min(1.0, y + h) * H))
    if hop[2] - hop[0] < 8 or hop[3] - hop[1] < 8:
        raise HTTPException(status_code=400, detail="Vùng bôi quá nhỏ — kéo rộng hơn quanh chữ ký.")
    buf = io.BytesIO()
    img.crop(hop).save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})
