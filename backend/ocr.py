"""
OCR cho app "Checklist Hồ Sơ Canada".

Kiến trúc (đã thử qua nhiều phương án trong quá trình phát triển — xem lịch sử git commit
message / trao đổi với người dùng để biết chi tiết thực nghiệm):
- Từng thử PaddleOCR đọc chữ trực tiếp: mất/sai dấu tiếng Việt có hệ thống.
- Từng thử tách dòng bằng xử lý ảnh cổ điển (projection profile) + VietOCR đọc: thất bại
  nặng trên giấy tờ thật có ảnh chân dung/QR code/watermark (CCCD) — nhầm cả ảnh thành 1
  khối "chữ".
- Từng thử PaddleOCR (chỉ dò vị trí) + VietOCR (đọc chữ): dò vị trí tốt hơn hẳn, nhưng
  VietOCR vẫn "ảo giác" (bịa hẳn nội dung không liên quan) trên vùng chữ đè lên watermark.
- **Tesseract (pytesseract, lang="vie") cho kết quả tốt nhất**: không bịa nội dung — kể cả
  khi đọc sai vài ký tự, phần còn lại vẫn bám sát nội dung thật (khác hẳn kiểu "ảo giác"
  của VietOCR). Tesseract tự lo cả phần dò vị trí lẫn đọc chữ trong 1 bước, nên bỏ hẳn
  được PaddleOCR/VietOCR, đơn giản hoá đáng kể dependency.
- PSM (page segmentation mode) ban đầu chọn 6 (1 khối văn bản đồng nhất) — SAI trên CCCD
  thật: xác nhận bằng thực nghiệm (dump toàn bộ token thô của Tesseract), với layout thẻ
  có nhãn chữ nhỏ + giá trị chữ to đậm (tên, số CCCD), PSM 6 hoàn toàn KHÔNG dò ra được
  vùng chữ to đậm là text — không phải bị lọc do confidence thấp, mà bị bỏ sót ngay từ
  bước segment, dữ liệu thô còn không hề có token nào ở đó. Đổi sang PSM 4 (1 cột văn bản,
  cỡ chữ có thể khác nhau) dò được cả 2 loại — đã test lại trên ảnh giấy khai sinh (không
  có layout dạng thẻ) cho kết quả giống hệt PSM 6, không bị regression.
- Vẫn giữ bước tiền xử lý ảnh trước khi OCR: deskew (chỉnh nghiêng), tăng tương phản
  (CLAHE), khử nhiễu nhẹ, phóng to nếu ảnh độ phân giải thấp — giúp Tesseract đọc chính
  xác hơn trên ảnh scan chất lượng không đều.
"""
from __future__ import annotations

import io
import logging
import os
import re

import cv2
import fitz  # PyMuPDF
import numpy as np
import pytesseract
from pytesseract import Output
from PIL import Image, ImageDraw, ImageFont

import storage

logger = logging.getLogger("ocr")

PDF_RENDER_DPI = 200
# ĐÃ THỬ "vie+eng" (dùng đồng thời 2 gói ngôn ngữ) để đọc tốt hơn nhãn song ngữ Việt/Anh
# trên CCCD ("Họ và tên / Full name") và CV thuần tiếng Anh — THẤT BẠI: xác nhận bằng A/B
# test có kiểm soát (cùng 1 ảnh, cùng tiền xử lý, chỉ đổi lang) là "vie+eng" làm MẤT DẤU
# tiếng Việt trên nhiều từ, kể cả trên chính TÊN NGƯỜI ("PHẠM VĂN HOÀNG" → "PHAM VĂN
# HOANG") — cái giá quá đắt cho việc chỉ sửa được vài chữ tiếng Anh phụ ("OP"→"OF"). Mất
# dấu trên tên thật trong giấy tờ pháp lý nghiêm trọng hơn nhiều so với lợi ích. Đa số tài
# liệu trong hệ thống là giấy tờ tiếng Việt nên giữ "vie" làm mặc định.
TESSERACT_LANG = os.getenv("TESSERACT_LANG", "vie")
TESSERACT_PSM = os.getenv("TESSERACT_PSM", "4")
MIN_WORD_CONFIDENCE = int(os.getenv("OCR_MIN_WORD_CONFIDENCE", "5"))
# Đã thử ngưỡng 40 — QUÁ CAO: xác nhận bằng thực nghiệm, tiêu đề "CĂN CƯỚC CÔNG DÂN" trên
# CCCD thật (chữ in đậm, màu đỏ, khác kiểu chữ phần còn lại) Tesseract đọc ĐÚNG nhưng
# Tesseract tự chấm chỉ 21% — bị lọc mất, khiến DeepSeek không còn tín hiệu để phân biệt
# CCCD với Passport (nhầm thành Passport). Hạ xuống 15 sửa được ca đó, nhưng thực nghiệm
# tiếp trên chính họ tên trên CCCD (chữ to đậm) lại lộ y hệt vấn đề: "VĂN"/"HOÀNG" đọc
# ĐÚNG nhưng Tesseract chỉ chấm 9% — vẫn bị ngưỡng 15 lọc mất. Hạ tiếp xuống 5 mới giữ được.
# Từ thực nghiệm, rác thật (watermark/hoa văn đọc nhầm) đa số rơi vào mức 0, còn chữ thật
# dù "khó tự tin" (kiểu chữ to/đậm/khác biệt) vẫn thường >= 5. Không có ngưỡng nào tách
# hoàn hảo 2 nhóm — hạ thấp để ưu tiên GIỮ tín hiệu thật, dựa vào bước DeepSeek sửa lỗi
# (classify.py) để tự lọc nhiễu còn sót thay vì ngưỡng số cứng.

PREPROCESS_ENABLED = os.getenv("OCR_PREPROCESS", "1") != "0"
DENOISE_ENABLED = os.getenv("OCR_DENOISE", "1") != "0"
UPSCALE_MIN_DIM_PX = 900  # nếu cạnh nhỏ hơn kích thước này thì phóng to lên trước khi xử lý

_ready = False


def load_models():
    """Tesseract không cần load model vào bộ nhớ (gọi CLI theo từng ảnh) — chỉ kiểm tra
    đã cài đặt + có gói ngôn ngữ cần thiết, fail sớm ngay lúc khởi động thay vì đợi tới
    request đầu tiên."""
    global _ready
    if _ready:
        return
    try:
        langs = pytesseract.get_languages(config="")
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(
            "Không tìm thấy Tesseract — cài qua `brew install tesseract tesseract-lang`."
        ) from e
    # TESSERACT_LANG có thể là nhiều ngôn ngữ nối bằng "+" (vd "vie+eng" — cú pháp Tesseract
    # cho phép dùng đồng thời nhiều gói ngôn ngữ trong 1 lần OCR, hữu ích cho giấy tờ song
    # ngữ Việt/Anh như CCCD, CV) — phải kiểm tra TỪNG phần, không so nguyên chuỗi.
    missing = [code for code in TESSERACT_LANG.split("+") if code not in langs]
    if missing:
        raise RuntimeError(
            f"Thiếu gói ngôn ngữ Tesseract {missing} — cài qua `brew install tesseract-lang`."
        )
    _ready = True
    logger.info("Tesseract OCR sẵn sàng (lang=%s, psm=%s).", TESSERACT_LANG, TESSERACT_PSM)


def models_loaded() -> bool:
    return _ready


# ---------------------------------------------------------------------------
# Tiền xử lý ảnh
# ---------------------------------------------------------------------------

def _deskew(gray: np.ndarray) -> np.ndarray:
    """Chỉnh nghiêng nhẹ (thường do lệch khi đưa giấy vào máy scan)."""
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    coords = np.column_stack(np.where(binary > 0))
    if len(coords) < 100:
        return gray

    angle = cv2.minAreaRect(coords)[-1]
    if angle > 45:
        angle -= 90

    if abs(angle) < 0.5 or abs(angle) > 15:
        return gray

    h, w = gray.shape
    center = (w // 2, h // 2)
    matrix = cv2.getRotationMatrix2D(center, -angle, 1.0)
    return cv2.warpAffine(
        gray, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )


def _base_gray_deskewed(pil_img: Image.Image) -> np.ndarray:
    """Phần tiền xử lý DÙNG CHUNG cho mọi biến thể bên dưới: chuyển xám, phóng to nếu ảnh
    nhỏ, chỉnh nghiêng — các bước này luôn có lợi bất kể cách xử lý tương phản/nhiễu sau
    đó. Trả về ndarray xám (không phải PIL Image) để các variant xử lý tiếp cho nhanh,
    khỏi phải deskew lại nhiều lần."""
    gray = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2GRAY)

    h, w = gray.shape
    min_dim = min(h, w)
    if min_dim < UPSCALE_MIN_DIM_PX:
        scale = UPSCALE_MIN_DIM_PX / min_dim
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

    return _deskew(gray)


def _to_rgb_image(gray: np.ndarray) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB))


def _preprocess(pil_img: Image.Image) -> Image.Image:
    if not PREPROCESS_ENABLED:
        return pil_img.convert("RGB")

    gray = _base_gray_deskewed(pil_img)

    if DENOISE_ENABLED:
        gray = cv2.fastNlMeansDenoising(gray, h=7, templateWindowSize=7, searchWindowSize=21)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    return _to_rgb_image(gray)


def _preprocess_variants(pil_img: Image.Image) -> dict[str, Image.Image]:
    """Nhiều cách tiền xử lý khác nhau cho CÙNG 1 ảnh gốc — dùng khi cần OCR kỹ hơn (nút
    "Phân tích lại"): mỗi cách phù hợp với 1 kiểu ảnh khác nhau (ảnh sạch/mờ/chữ nhỏ đè
    watermark...), không có cách nào luôn thắng tất cả nên thử hết rồi so kết quả thay vì
    đoán trước 1 cách cố định như _preprocess() ở trên (dùng cho lần OCR đầu, ưu tiên
    nhanh)."""
    if not PREPROCESS_ENABLED:
        base = pil_img.convert("RGB")
        return {"raw": base}

    gray = _base_gray_deskewed(pil_img)
    variants: dict[str, Image.Image] = {}

    # default: giống hệt _preprocess() — khử nhiễu nhẹ + tăng tương phản vừa phải.
    denoised = cv2.fastNlMeansDenoising(gray, h=7, templateWindowSize=7, searchWindowSize=21)
    variants["default"] = _to_rgb_image(cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(denoised))

    # no_denoise: bỏ khử nhiễu — fastNlMeansDenoising đôi khi làm mờ luôn nét chữ nhỏ/mảnh
    # trên ảnh vốn đã không nhiễu nhiều, mất chi tiết cần cho OCR.
    variants["no_denoise"] = _to_rgb_image(cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray))

    # binary: nhị phân hoá thích ứng (adaptive threshold) — thường cho kết quả rất tốt với
    # chữ in rõ nét trên nền tương đối đồng đều (giấy khai sinh, bằng cấp scan phẳng), dù
    # có thể hỏng ảnh có watermark/hoạ tiết nền phức tạp (CCCD).
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15
    )
    variants["binary"] = _to_rgb_image(binary)

    # strong_contrast: tăng tương phản mạnh hơn hẳn (clipLimit 4.0 thay vì 2.0) — cho ảnh
    # chụp thiếu sáng/mờ mà mức tương phản mặc định chưa đủ để tách chữ khỏi nền.
    variants["strong_contrast"] = _to_rgb_image(cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8)).apply(gray))

    return variants


# ---------------------------------------------------------------------------
# OCR bằng Tesseract (tự lo cả dò vị trí lẫn đọc chữ)
# ---------------------------------------------------------------------------

class OcrLine:
    __slots__ = ("box", "text")

    def __init__(self, box: tuple[int, int, int, int], text: str):
        self.box = box
        self.text = text


# Dọn nhiễu ký tự bằng regex TRƯỚC khi đưa vào bước sửa lỗi/phân loại DeepSeek — chỉ xử
# lý các artifact OCR hay gặp ở mức ký tự (dấu backtick/nháy/gạch đứng lạc, gạch dưới dài
# do đọc nhầm viền thẻ/watermark, khoảng trắng kép), KHÔNG cố đoán/sửa nội dung — việc đó
# vẫn để DeepSeek làm ở bước sau vì cần hiểu ngữ nghĩa, regex không làm được.
_STRAY_PUNCT_RE = re.compile(r"[`‹›“”„¨^~•·|]+")
_LONG_UNDERSCORE_RE = re.compile(r"_{2,}")
_MULTI_SPACE_RE = re.compile(r"\s{2,}")
_WORD_OR_DIGIT_RE = re.compile(r"[^\W\d_]|\d", re.UNICODE)  # chữ cái (kể cả có dấu) hoặc số


def _clean_ocr_text(text: str) -> str:
    text = _STRAY_PUNCT_RE.sub(" ", text)
    text = _LONG_UNDERSCORE_RE.sub(" ", text)
    text = _MULTI_SPACE_RE.sub(" ", text)
    return text.strip(" .:,;'\"")


def _is_noise_line(text: str) -> bool:
    """Dòng gần như không còn chữ/số thật sau khi dọn regex — thường là nhiễu thuần tuý
    đọc nhầm từ watermark/viền thẻ, bỏ hẳn thay vì đưa cho DeepSeek xử lý."""
    return len(_WORD_OR_DIGIT_RE.findall(text)) < 2


def _ocr_single_image_lines(img: Image.Image) -> list[OcrLine]:
    processed = _preprocess(img)
    return _lines_from_preprocessed(processed)


def _ocr_single_image_lines_best_of(img: Image.Image) -> list[OcrLine]:
    """Chạy Tesseract với TỪNG cách tiền xử lý ở _preprocess_variants(), giữ lại kết quả
    có TỔNG SỐ KÝ TỰ đọc được nhiều nhất — coi đọc được nhiều ký tự hơn là tín hiệu tốt
    (đọc thiếu vùng nào đó khiến số ký tự giảm hẳn, như đã gặp thật với vùng chữ to đậm bị
    bỏ sót — xem ghi chú PSM ở đầu file). Chỉ dùng cho "Phân tích lại" (chậm hơn ~4 lần vì
    chạy Tesseract nhiều lần), KHÔNG dùng cho lần OCR đầu lúc upload (ưu tiên tốc độ)."""
    variants = _preprocess_variants(img)
    best_lines: list[OcrLine] = []
    best_len = -1
    best_name = "?"
    for name, processed in variants.items():
        lines = _lines_from_preprocessed(processed)
        total_len = sum(len(l.text) for l in lines)
        if total_len > best_len:
            best_len, best_lines, best_name = total_len, lines, name
    logger.info(
        "Best-of preprocessing: chọn '%s' (%d ký tự) trong %d phương án.",
        best_name, best_len, len(variants),
    )
    return best_lines


def _lines_from_preprocessed(processed: Image.Image) -> list[OcrLine]:
    load_models()

    data = pytesseract.image_to_data(
        processed, lang=TESSERACT_LANG, config=f"--psm {TESSERACT_PSM}", output_type=Output.DICT
    )

    # Gộp các từ (word) cùng (block, paragraph, line) thành 1 dòng, bỏ từ có độ tin cậy
    # quá thấp (thường là nhiễu đọc nhầm từ watermark/hoa văn nền, không phải chữ thật).
    line_groups: dict[tuple[int, int, int], list[int]] = {}
    n = len(data["text"])
    for i in range(n):
        text = data["text"][i].strip()
        conf = int(data["conf"][i]) if data["conf"][i] not in ("", "-1") else -1
        if not text or conf < MIN_WORD_CONFIDENCE:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        line_groups.setdefault(key, []).append(i)

    lines: list[OcrLine] = []
    for key in sorted(line_groups.keys()):
        indices = line_groups[key]
        words = [data["text"][i].strip() for i in indices]
        cleaned = _clean_ocr_text(" ".join(words))
        if not cleaned or _is_noise_line(cleaned):
            continue
        x1 = min(data["left"][i] for i in indices)
        y1 = min(data["top"][i] for i in indices)
        x2 = max(data["left"][i] + data["width"][i] for i in indices)
        y2 = max(data["top"][i] + data["height"][i] for i in indices)
        lines.append(OcrLine((x1, y1, x2, y2), cleaned))

    return lines


def _ocr_single_image(img: Image.Image) -> str:
    return "\n".join(line.text for line in _ocr_single_image_lines(img))


def draw_detected_boxes(processed: Image.Image, lines: list[OcrLine]) -> Image.Image:
    """Vẽ khung đỏ quanh từng dòng chữ đã nhận diện + số thứ tự — dùng để debug trực
    quan xem Tesseract đang dò đúng vùng nào, đọc được gì (endpoint /ocr/test/visualize)."""
    annotated = processed.convert("RGB").copy()
    draw = ImageDraw.Draw(annotated)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 18)
    except Exception:  # noqa: BLE001
        font = ImageFont.load_default()

    for i, line in enumerate(lines, start=1):
        x1, y1, x2, y2 = line.box
        draw.rectangle([x1, y1, x2, y2], outline=(255, 0, 0), width=2)
        label = str(i)
        label_bg = [x1, max(0, y1 - 20), x1 + 10 + 10 * len(label), max(0, y1 - 20) + 20]
        draw.rectangle(label_bg, fill=(255, 0, 0))
        draw.text((label_bg[0] + 3, label_bg[1] + 1), label, fill=(255, 255, 255), font=font)

    return annotated


def _load_label_font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", size)
    except Exception:  # noqa: BLE001
        return ImageFont.load_default()


def _stack_images_with_labels(
    top: Image.Image, top_label: str, bottom: Image.Image, bottom_label: str
) -> Image.Image:
    """Ghép ảnh gốc (trên) + ảnh đã tiền xử lý và đánh dấu vùng OCR nhận diện (dưới)
    thành 1 ảnh duy nhất, có nhãn — để xem so sánh trực quan trong 1 lần gọi API."""
    width = max(top.width, bottom.width)
    label_h = 32

    def _resize_to_width(im: Image.Image) -> Image.Image:
        im = im.convert("RGB")
        if im.width == width:
            return im
        ratio = width / im.width
        return im.resize((width, int(im.height * ratio)))

    top_r = _resize_to_width(top)
    bottom_r = _resize_to_width(bottom)

    combined = Image.new(
        "RGB", (width, label_h + top_r.height + label_h + bottom_r.height), (255, 255, 255)
    )
    draw = ImageDraw.Draw(combined)
    font = _load_label_font(20)

    draw.text((6, 6), top_label, fill=(0, 0, 0), font=font)
    combined.paste(top_r, (0, label_h))
    y2 = label_h + top_r.height
    draw.text((6, y2 + 6), bottom_label, fill=(0, 0, 0), font=font)
    combined.paste(bottom_r, (0, y2 + label_h))

    return combined


def debug_detect_parts(img: Image.Image) -> tuple[Image.Image, Image.Image, list[OcrLine]]:
    """Tiền xử lý + OCR 1 lần, trả về (ảnh gốc dạng RGB, ảnh đã đánh dấu khung OCR, danh
    sách dòng) — dùng chung cho mọi endpoint debug OCR để không phải chạy OCR nhiều lần."""
    processed = _preprocess(img)
    lines = _lines_from_preprocessed(processed)
    annotated = draw_detected_boxes(processed, lines)
    return img.convert("RGB"), annotated, lines


def debug_detect(img: Image.Image) -> tuple[Image.Image, list[OcrLine]]:
    """Như debug_detect_parts nhưng ghép gốc + đã đánh dấu thành 1 ảnh duy nhất (dùng cho
    endpoint trả PNG trực tiếp, /ocr/test/visualize)."""
    original, annotated, lines = debug_detect_parts(img)
    combined = _stack_images_with_labels(
        original, "Ảnh gốc", annotated, "Ảnh đã tiền xử lý + khung vùng OCR nhận diện"
    )
    return combined, lines


def describe_file_read_error(e: Exception) -> str:
    """Dịch exception kỹ thuật (PyMuPDF/Pillow, message gốc luôn bằng tiếng Anh) sang câu
    tiếng Việt dễ hiểu cho nhân viên — không hiển thị nguyên văn message tiếng Anh lên UI."""
    msg = str(e).lower()
    if "empty stream" in msg or "empty file" in msg or not msg:
        return "File rỗng hoặc bị hỏng khi lưu trữ, không đọc được nội dung."
    if "cannot identify image" in msg:
        return "Không nhận dạng được định dạng ảnh — file có thể bị hỏng hoặc không phải ảnh hợp lệ."
    if "password" in msg or "encrypt" in msg:
        return "File PDF có mật khẩu bảo vệ — cần gỡ mật khẩu trước khi upload."
    if "broken document" in msg or "cannot open" in msg or "syntax error" in msg or "format error" in msg:
        return "File PDF bị hỏng hoặc không đúng định dạng, không mở được."
    return "File bị hỏng hoặc không đúng định dạng, không đọc được nội dung."


def detect_real_mime_type(content: bytes, declared_mime_type: str) -> str:
    """Không tin mù quáng vào Content-Type do trình duyệt người upload tự khai báo — xác
    nhận thực tế trên chính hệ thống này: 1 file tên ".webp" khai báo Content-Type
    "image/webp" nhưng NỘI DUNG BYTE THẬT lại là JPEG (đổi tên file mà không đổi định
    dạng), khiến <img> phía trình duyệt hiển thị lỗi không ổn định tuỳ trình duyệt (browser
    tin theo header, không phải lúc nào cũng tự dò lại định dạng thật). Đọc lại định dạng
    thật từ chính nội dung file thay vì tin tên file/khai báo của client."""
    if content[:4] == b"%PDF":
        return "application/pdf"
    try:
        with Image.open(io.BytesIO(content)) as img:
            real_mime = Image.MIME.get(img.format)
            if real_mime:
                return real_mime
    except Exception:  # noqa: BLE001
        pass
    return declared_mime_type or "application/octet-stream"


def _crop_to_content(pil_img: Image.Image, padding_ratio: float = 0.03) -> Image.Image:
    """Tự động cắt bỏ lề trắng thừa quanh nội dung thật — cần thiết cho ảnh render từ PDF
    (ảnh CCCD/giấy tờ được scan/chèn vào 1 trang A4 lớn, phần lớn còn lại là lề trắng).

    Xác nhận bằng thực nghiệm trên PDF thật: 1 trang CCCD chỉ chiếm ~30% chiều cao trang
    (phần còn lại gần trắng tinh, mật độ điểm ảnh tối < 2%) — Tesseract (mọi PSM tự động dò
    bố cục) hoàn toàn KHÔNG nhận diện được chữ nào trên toàn trang dù ảnh CCCD tự nó đọc
    bằng mắt hoàn toàn bình thường, vì thuật toán dò bố cục của Tesseract kỳ vọng khối chữ
    có kích thước tương xứng với trang, không phải 1 "đảo" nội dung nhỏ giữa vùng trắng
    rộng lớn. Không dùng cho ảnh chụp/scan trực tiếp (JPG/PNG upload) vì ảnh đó thường đã
    gần sát nội dung — chỉ áp dụng cho trang PDF render ra."""
    gray = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2GRAY)
    h, w = gray.shape

    # Downsample để tính mật độ nhanh và ổn định hơn (giảm ảnh hưởng nhiễu từng điểm ảnh lẻ).
    small_w = 200
    small = cv2.resize(gray, (small_w, max(1, int(small_w * h / w))), interpolation=cv2.INTER_AREA)
    ink = small < 200  # điểm ảnh tối = có nội dung (chữ/ảnh), điểm ảnh sáng = nền/lề trắng

    def _content_bounds(density: np.ndarray) -> tuple[int, int] | None:
        threshold = max(float(density.max()) * 0.15, 0.01)  # tương đối theo đỉnh, có sàn tối thiểu
        indices = np.where(density > threshold)[0]
        if len(indices) == 0:
            return None
        return int(indices[0]), int(indices[-1])

    row_bounds = _content_bounds(ink.mean(axis=1))
    col_bounds = _content_bounds(ink.mean(axis=0))
    if row_bounds is None or col_bounds is None:
        return pil_img  # trang trắng thật/không phát hiện được nội dung — giữ nguyên

    scale_y, scale_x = h / small.shape[0], w / small.shape[1]
    y1, y2 = int(row_bounds[0] * scale_y), int((row_bounds[1] + 1) * scale_y)
    x1, x2 = int(col_bounds[0] * scale_x), int((col_bounds[1] + 1) * scale_x)

    pad_y, pad_x = int((y2 - y1) * padding_ratio), int((x2 - x1) * padding_ratio)
    y1, y2 = max(0, y1 - pad_y), min(h, y2 + pad_y)
    x1, x2 = max(0, x1 - pad_x), min(w, x2 + pad_x)

    # Vùng nội dung đã chiếm gần hết trang rồi (không có nhiều lề để bỏ) — khỏi crop cho
    # đỡ tốn công vô ích, tránh rủi ro cắt nhầm khi bbox tính sai trên trang đã kín nội dung.
    if (x2 - x1) * (y2 - y1) > 0.85 * w * h:
        return pil_img

    return pil_img.crop((x1, y1, x2, y2))


def pdf_to_images(pdf_bytes: bytes) -> list[Image.Image]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    zoom = PDF_RENDER_DPI / 72
    matrix = fitz.Matrix(zoom, zoom)
    images = []
    for page in doc:
        pix = page.get_pixmap(matrix=matrix)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        images.append(_crop_to_content(img))
    doc.close()
    return images


def save_pdf_page_images(case_id: str, document_id: str, pages: list[Image.Image]) -> None:
    """Lưu ảnh từng trang PDF đã render vào MinIO, "folder" riêng theo document:
    {case_id}/{document_id}-pages/page-{n}.png. Dùng key cố định (không random UUID như
    storage.upload_document) để xem lại được qua GET /documents/{document_id}/pages/{n}
    mà không cần lưu thêm bảng tra key nào khác — chỉ cần document_id + số trang
    (Document.pageCount)."""
    for i, page_img in enumerate(pages, start=1):
        buf = io.BytesIO()
        page_img.convert("RGB").save(buf, format="PNG")
        key = f"{case_id}/{document_id}-pages/page-{i}.png"
        storage.upload_object(key, buf.getvalue(), "image/png")


def extract_text(
    content: bytes, filename: str, mime_type: str, try_harder: bool = False
) -> tuple[str, int, list[OcrLine], list[Image.Image]]:
    """Trả về (text, pageCount, lines, pages). `lines` giữ toạ độ từng dòng (dùng cho vẽ
    khung debug ở /ocr/test — không còn dùng cho prompt LLM, xem ghi chú ở
    classify.correct_ocr_text). `pages` là ảnh từng trang đã render (PDF) hoặc ảnh gốc
    (non-PDF) — trả ra để nơi gọi lưu lại vào MinIO nếu cần (vd PDF nhiều trang), tránh
    phải render PDF lại lần 2 chỉ để lấy ảnh.

    `try_harder=True`: mỗi trang chạy Tesseract với NHIỀU cách tiền xử lý khác nhau
    (_preprocess_variants), giữ lại kết quả đọc được nhiều ký tự nhất — chậm hơn hẳn (~4
    lần) nên chỉ bật cho "Phân tích lại" (nhân viên chủ động chờ để có kết quả tốt hơn),
    không bật cho lần OCR đầu lúc upload.

    Raise ValueError nếu không đọc được file."""
    is_pdf = mime_type == "application/pdf" or filename.lower().endswith(".pdf")

    try:
        if is_pdf:
            pages = pdf_to_images(content)
        else:
            pages = [Image.open(io.BytesIO(content))]
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"Không đọc được file: {describe_file_read_error(e)}") from e

    if not pages:
        return "", 0, [], []

    ocr_page = _ocr_single_image_lines_best_of if try_harder else _ocr_single_image_lines

    page_texts = []
    all_lines: list[OcrLine] = []
    for i, page_img in enumerate(pages):
        page_lines = ocr_page(page_img)
        all_lines.extend(page_lines)
        text = "\n".join(line.text for line in page_lines)
        if len(pages) > 1:
            page_texts.append(f"--- Trang {i + 1} ---\n{text}")
        else:
            page_texts.append(text)

    return "\n\n".join(page_texts), len(pages), all_lines, pages
