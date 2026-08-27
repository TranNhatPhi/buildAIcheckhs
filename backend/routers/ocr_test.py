"""Endpoint test OCR thuần — không tạo case/document, không phân loại DeepSeek. Dùng để
kiểm tra nhanh độ chính xác OCR trên 1 file bất kỳ (ảnh hoặc PDF) qua Swagger UI.

- POST /ocr/test: trả text + toạ độ + số lượng dòng nhận diện được (gộp TẤT CẢ các trang
  nếu là PDF nhiều trang — không riêng trang đầu), kèm ảnh gốc và ảnh đã đánh dấu vùng OCR
  nhận diện dạng base64 data URI cho TỪNG trang (mảng, 1 phần tử/trang) — nhúng thẳng
  trong JSON, xem được ngay không cần request thêm — VÀ lưu luôn các ảnh này vào MinIO
  (prefix/"folder" "ocr-images/") — trả thêm key để xem/tải lại sau qua
  GET /ocr/test/image/{key}, không bị mất khi đóng response như trước (base64 chỉ tồn tại
  trong đúng lần gọi đó).
- POST /ocr/test/visualize: trả trực tiếp 1 ảnh PNG ghép ảnh gốc + ảnh đã đánh dấu của 1
  trang cụ thể (query param `page`, mặc định trang 1 — dùng `?page=2` để xem trang khác
  nếu là PDF nhiều trang) — tiện xem nhanh qua Swagger UI mà không cần decode base64, đồng
  thời cũng lưu vào MinIO (key trả về ở header X-Image-Key)."""
import base64
import io
import re
from datetime import datetime, timezone

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel

import ocr
import storage

router = APIRouter(prefix="/ocr", tags=["ocr"])

# "Folder" (thực chất là key prefix trong bucket MinIO — S3/MinIO không có khái niệm
# folder thật, chỉ mô phỏng qua dấu "/" trong key) chứa ảnh debug OCR, tách biệt khỏi
# file hồ sơ khách hàng thật (case_id/...) để dễ dọn dẹp riêng nếu cần.
OCR_DEBUG_PREFIX = "ocr-images"

_UNSAFE_KEY_CHARS_RE = re.compile(r"[^a-zA-Z0-9._-]")


def _sanitize_for_key(name: str) -> str:
    return _UNSAFE_KEY_CHARS_RE.sub("_", name)[:60]


def _new_run_folder(original_filename: str) -> str:
    """Mỗi lần gọi /ocr/test hay /ocr/test/visualize tạo 1 "folder" riêng trong MinIO, đặt
    tên theo thời gian + tên file gốc — trước đây key bắt đầu bằng UUID ngẫu nhiên, khiến
    trình duyệt MinIO sắp xếp lộn xộn, ảnh gốc/đã detect của cùng 1 lần test bị tách rời
    khỏi nhau giữa hàng chục lần test khác. Đặt thời gian lên đầu để sắp xếp theo thời gian
    (mới nhất/cũ nhất rõ ràng), và các ảnh cùng 1 lần test nằm chung 1 folder, dễ tìm."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{ts}_{_sanitize_for_key(original_filename)}"


class OcrLineDTO(BaseModel):
    box: list[int]  # [x1, y1, x2, y2]
    text: str


class OcrTestResponse(BaseModel):
    text: str
    pageCount: int
    lineCount: int
    lines: list[OcrLineDTO]
    originalImageUrls: list[str]
    detectedImageUrls: list[str]
    originalImageKeys: list[str]
    detectedImageKeys: list[str]


def _load_page_image(content: bytes, filename: str, mime_type: str, page_num: int):
    """page_num đếm từ 1. Dùng cho /test/visualize (1 trang cụ thể) — /test dùng thẳng
    `pages` trả về từ ocr.extract_text() thay vì hàm này để tránh render PDF 2 lần."""
    from PIL import Image

    is_pdf = mime_type == "application/pdf" or filename.lower().endswith(".pdf")
    if is_pdf:
        import fitz

        doc = fitz.open(stream=content, filetype="pdf")
        if page_num < 1 or page_num > len(doc):
            doc.close()
            raise HTTPException(
                status_code=400, detail=f"File chỉ có {len(doc)} trang, không có trang {page_num}"
            )
        pix = doc[page_num - 1].get_pixmap(
            matrix=fitz.Matrix(ocr.PDF_RENDER_DPI / 72, ocr.PDF_RENDER_DPI / 72)
        )
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        doc.close()
        return img
    if page_num != 1:
        raise HTTPException(status_code=400, detail="File ảnh (không phải PDF) chỉ có 1 trang")
    return Image.open(io.BytesIO(content))


def _to_png_bytes(img) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def _to_data_url(png_bytes: bytes) -> str:
    encoded = base64.b64encode(png_bytes).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _save_debug_image(png_bytes: bytes, run_folder: str, label: str) -> str:
    key = f"{OCR_DEBUG_PREFIX}/{run_folder}/{label}.png"
    return storage.upload_object(key, png_bytes, "image/png")


@router.post("/test", response_model=OcrTestResponse)
def test_ocr(file: UploadFile = File(...)):
    # `def` thường, không `async def` — hàm này chạy OCR/Tesseract (block) nên phải để
    # FastAPI dispatch qua threadpool thay vì chạy thẳng trên event loop (xem giải thích
    # chi tiết ở case_documents.py:upload_document, cùng vấn đề).
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="File rỗng")

    filename = file.filename or "file"
    mime_type = file.content_type or ""

    try:
        # use_gemini=False: trang debug này vẽ khung TOẠ ĐỘ từng dòng do Tesseract dò ra —
        # Gemini chỉ trả text thuần, không có toạ độ, đi đường đó thì không còn gì để vẽ.
        text, page_count, lines, pages = ocr.extract_text(
            content, filename, mime_type, use_gemini=False
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Không đọc được file: {ocr.describe_file_read_error(e)}"
        ) from e

    # Ảnh debug cho TỪNG trang — trước đây chỉ làm trang đầu (pages[0]), khiến PDF nhiều
    # trang "như bị cắt còn 1 trang" trên ảnh minh hoạ dù text/lines vẫn đủ mọi trang.
    run_folder = _new_run_folder(filename)
    original_urls: list[str] = []
    detected_urls: list[str] = []
    original_keys: list[str] = []
    detected_keys: list[str] = []
    for i, page_img in enumerate(pages, start=1):
        original, annotated, _page_lines = ocr.debug_detect_parts(page_img)
        original_png = _to_png_bytes(original)
        annotated_png = _to_png_bytes(annotated)
        original_urls.append(_to_data_url(original_png))
        detected_urls.append(_to_data_url(annotated_png))
        original_keys.append(_save_debug_image(original_png, run_folder, f"page{i}-original"))
        detected_keys.append(_save_debug_image(annotated_png, run_folder, f"page{i}-detected"))

    line_dtos = [OcrLineDTO(box=list(l.box), text=l.text) for l in lines]
    return OcrTestResponse(
        text=text,
        pageCount=page_count,
        lineCount=len(line_dtos),
        lines=line_dtos,
        originalImageUrls=original_urls,
        detectedImageUrls=detected_urls,
        originalImageKeys=original_keys,
        detectedImageKeys=detected_keys,
    )


@router.post("/test/visualize")
def visualize_ocr(file: UploadFile = File(...), page: int = 1):
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="File rỗng")

    try:
        img = _load_page_image(content, file.filename or "file", file.content_type or "", page)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Không đọc được file: {ocr.describe_file_read_error(e)}"
        ) from e

    annotated, lines = ocr.debug_detect(img)

    buf = io.BytesIO()
    annotated.save(buf, format="PNG")
    png_bytes = buf.getvalue()
    run_folder = _new_run_folder(file.filename or "file")
    image_key = _save_debug_image(png_bytes, run_folder, f"visualize-page{page}")

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"X-Line-Count": str(len(lines)), "X-Image-Key": image_key, "X-Page": str(page)},
    )


@router.get("/test/image/{key:path}")
def get_ocr_test_image(key: str):
    """Xem/tải lại ảnh debug OCR đã lưu (key trả về từ /ocr/test hoặc /ocr/test/visualize).
    Chỉ phục vụ key nằm trong prefix ocr-images/ — tránh bị lợi dụng đọc file bất kỳ
    trong bucket (vd file hồ sơ khách hàng thật ở prefix theo case_id)."""
    if not key.startswith(f"{OCR_DEBUG_PREFIX}/"):
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh")
    try:
        content = storage.get_document_bytes(key)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh") from e
    return Response(content=content, media_type="image/png")
