"""Đọc chữ 1 trang bằng PaddleOCR-VL chạy TẠI CHỖ (Docker + GPU, dựng từ repo PaddleOCR ở
C:\\buildAIcheckhs\\paddleOCRVl — xem pull-and-up.ps1 trong thư mục đó).

Vì sao thêm nguồn này dù đã có Gemini + Tesseract: Gemini là hạn mức MIỄN PHÍ có trần theo
phút/ngày (xem llm.py) — upload một đợt lớn là cạn, lúc đó mọi trang rơi về Tesseract, mà
Tesseract đọc kém hẳn trên giấy nền hoa văn (đo trên giấy khai sinh nền đỏ: 1 biến thể đọc
được ĐÚNG 2 ký tự). PaddleOCR-VL là mô hình thị giác-ngôn ngữ như Gemini nhưng chạy trên GPU
của chính máy: không hạn mức, không tốn tiền, không gửi giấy tờ khách ra ngoài.

KHÔNG nhầm với lần thử "PaddleOCR" ghi trong docstring đầu ocr.py (mất/sai dấu tiếng Việt có
hệ thống) — đó là PaddleOCR đời cũ nhận dạng từng dòng; PaddleOCR-VL là mô hình khác hẳn. Chất
lượng tiếng Việt của nó CHƯA đo trên giấy tờ thật của app — vì vậy mặc định nó đứng SAU Gemini
(chỉ thay chỗ của Tesseract), đổi lên trước bằng PADDLE_OCR_VL_FIRST=1 sau khi đã đo.

Cố ý TẮT khi PADDLE_OCR_VL_URL trống: production (VM GCP, không GPU, không có service này)
không khai biến đó nên hành vi ở đó giữ nguyên như cũ.
"""
from __future__ import annotations

import base64
import html
import io
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser

from PIL import Image

from llm import _env_int, _env_str

logger = logging.getLogger("paddle_ocr_vl")

# Gốc URL của API, vd "http://localhost:8090" (backend chạy trên máy) hoặc
# "http://host.docker.internal:8090" (backend chạy trong container — "localhost" trong container
# là chính container đó). Trống = tắt hẳn nguồn này.
PADDLE_OCR_VL_URL = _env_str("PADDLE_OCR_VL_URL", "").rstrip("/")

# "1" = đọc bằng PaddleOCR-VL TRƯỚC Gemini. Mặc định "0" (sau Gemini) — xem docstring đầu file.
PADDLE_OCR_VL_FIRST = _env_str("PADDLE_OCR_VL_FIRST", "0") == "1"

# "1" = CHỈ chạy khi nhân viên bấm nút "Đọc lại bằng PaddleOCR-VL", không tham gia đường đọc
# tự động lúc upload.
#
# Vì sao cần công tắc riêng chứ không suy từ PADDLE_OCR_VL_URL: khi Gemini đang tắt
# (GEMINI_OCR_ENABLED=0), khai URL vào là PaddleOCR-VL lập tức thành nguồn đọc MẶC ĐỊNH của
# mọi lần upload — không ai chọn thế cả. Đã đo trên giấy xác nhận cư trú thật: PaddleOCR-VL
# BỎ HẲN dòng đầu ("Mẫu CT07 ban hành kèm theo Thông tư số 66/2023/TT-BCA...", nó xếp vùng đó
# là header) và đọc "HÀ TĨNH" thành "HÀ TỈNH", trong khi Tesseract đọc đúng cả hai. Một tờ
# chưa đủ để kết luận, nhưng đủ để KHÔNG cho nó làm mặc định khi chưa đo trên bộ giấy tờ thật.
PADDLE_OCR_VL_MANUAL_ONLY = _env_str("PADDLE_OCR_VL_MANUAL_ONLY", "0") == "1"

# 1 trang trên RTX 3060 dự kiến chỉ vài chục giây; 120s là trần để một server treo không giữ
# request upload (vốn đã dài 30-150s, xem AGENTS.md) lâu thêm vô hạn. CHƯA đo thật — chỉnh
# lại sau khi có số liệu.
PADDLE_OCR_VL_TIMEOUT_SECONDS = _env_int("PADDLE_OCR_VL_TIMEOUT_SECONDS", 120)

# Số trang gửi song song. Khác Gemini (4, vì chỉ chờ mạng): ở đây mọi request dồn vào CÙNG MỘT
# GPU 12GB, chia với cả model bố cục lẫn vLLM — gửi ồ ạt chỉ xếp hàng bên trong server. CHƯA đo.
PAGE_CONCURRENCY = _env_int("PADDLE_OCR_VL_CONCURRENCY", 2)

# Hỏng kết nối / quá giờ thì NGHỈ một lúc rồi mới thử lại. Không nghỉ thì khi server tắt hoặc
# treo, MỖI TRANG của MỌI file lại chờ đủ timeout rồi mới rơi xuống nguồn kế tiếp — file 7 trang
# có thể chờ thêm vài phút vô ích. Cùng lý do với cơ chế cooldown của Gemini trong llm.py.
PADDLE_OCR_VL_COOLDOWN_SECONDS = _env_int("PADDLE_OCR_VL_COOLDOWN_SECONDS", 60)

# JPEG q92 thay vì PNG: trang PDF render 300 DPI là ~3500x2500, PNG base64 nặng hàng chục MB
# trong 1 request JSON. Không tự thu nhỏ ảnh — server tự đưa về kích thước model cần.
_JPEG_QUALITY = 92

_cooldown_until = 0.0
# Chỉ để log "server không phản hồi" 1 lần mỗi đợt nghỉ, không ngập log khi upload cả loạt.
_cooldown_lock = threading.Lock()


def is_enabled() -> bool:
    return bool(PADDLE_OCR_VL_URL)


def ocr_page(page_img: Image.Image, page_no: int = 1) -> str | None:
    """Trả về văn bản của trang, hoặc None khi KHÔNG dùng được (tắt, đang nghỉ, lỗi, trang
    không có chữ) — nơi gọi tự chuyển sang nguồn kế tiếp. Không bao giờ ném lỗi ra ngoài: một
    nguồn DỰ PHÒNG hỏng không được làm hỏng cả lượt upload."""
    global _cooldown_until
    if not is_enabled() or time.monotonic() < _cooldown_until:
        return None

    try:
        buf = io.BytesIO()
        page_img.convert("RGB").save(buf, format="JPEG", quality=_JPEG_QUALITY)
        payload = json.dumps({
            "file": base64.b64encode(buf.getvalue()).decode(),
            "fileType": 1,  # 1 = ảnh (0 = PDF). App đã tự tách PDF thành từng trang ảnh.
            # Hai cờ dưới mặc định BẬT ở server và trả kèm ảnh base64 (ảnh cắt từng vùng, ảnh
            # vẽ khung bố cục) — nặng thêm nhiều MB mỗi trang mà app không dùng tới.
            "returnMarkdownImages": False,
            "visualize": False,
            # Server mặc định BỎ các vùng header/footer/number/footnote/aside_text khỏi markdown
            # — hợp với việc đọc sách báo, nhưng ở giấy tờ hành chính VN thì phần đầu trang
            # ("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", "Công an Quận...", số hiệu văn bản) chính
            # là tín hiệu để phân loại, còn chú thích cuối trang hay ghi thời hạn hiệu lực. Chỉ
            # bỏ các vùng ẢNH, vì ảnh vốn cũng bị lọc ở _markdown_to_text.
            "markdownIgnoreLabels": ["header_image", "footer_image"],
        }).encode()
    except Exception as e:  # noqa: BLE001
        logger.warning("PaddleOCR-VL: không mã hoá được ảnh trang %d (%s).", page_no, type(e).__name__)
        return None

    req = urllib.request.Request(
        f"{PADDLE_OCR_VL_URL}/layout-parsing",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=PADDLE_OCR_VL_TIMEOUT_SECONDS) as resp:
            body = json.load(resp)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        # Server tắt / chưa nạp xong model / treo. HTTPError (lỗi 4xx/5xx có phản hồi) là lớp
        # con của URLError nên cũng vào đây — lỗi 5xx thường là server đang quá tải/OOM GPU,
        # nghỉ một lúc là đúng.
        with _cooldown_lock:
            if time.monotonic() >= _cooldown_until:
                logger.warning(
                    "PaddleOCR-VL không dùng được (%s: %s) — nghỉ %ds, trong lúc đó bỏ qua nguồn này.",
                    type(e).__name__, getattr(e, "reason", e), PADDLE_OCR_VL_COOLDOWN_SECONDS,
                )
            _cooldown_until = time.monotonic() + PADDLE_OCR_VL_COOLDOWN_SECONDS
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("PaddleOCR-VL trang %d: phản hồi không đọc được (%s).", page_no, type(e).__name__)
        return None

    try:
        if body.get("errorCode", 0) != 0:
            logger.warning("PaddleOCR-VL trang %d báo lỗi: %s", page_no, body.get("errorMsg"))
            return None
        results = body["result"]["layoutParsingResults"]
        text = _markdown_to_text("\n\n".join(r["markdown"]["text"] for r in results))
    except (KeyError, TypeError) as e:
        logger.warning("PaddleOCR-VL trang %d: sai định dạng phản hồi (%s).", page_no, e)
        return None

    if not text.strip():
        # Cùng quy ước với Gemini (llm.try_gemini coi rỗng là thất bại): để nguồn kế tiếp thử
        # lại, thay vì chốt luôn "trang trắng" chỉ vì 1 nguồn không thấy chữ.
        return None
    logger.info("OCR trang %d: PaddleOCR-VL (%.1fs).", page_no, time.monotonic() - started)
    return text


# ---------------------------------------------------------------------------
# Markdown của PaddleOCR-VL -> văn bản theo đúng quy ước còn lại của app
# ---------------------------------------------------------------------------
# PaddleOCR-VL trả bảng dưới dạng HTML <table> nhúng trong markdown và bọc vùng ảnh bằng
# <div><img ...></div>. Phần còn lại của app lại dùng BẢNG MARKDOWN (`| a | b |` — xem
# CORRECTION_SYSTEM_PROMPT ở classify.py và FormattedDocumentText.tsx): để nguyên HTML thì khi
# bước sửa lỗi hỏng (nó rơi về văn bản OCR thô), nhân viên nhìn thấy nguyên cục thẻ HTML.

_TABLE_RE = re.compile(r"<table\b.*?</table>", re.IGNORECASE | re.DOTALL)
_IMG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_DIV_RE = re.compile(r"</?div\b[^>]*>", re.IGNORECASE)
_BLANK_LINES_RE = re.compile(r"\n{3,}")


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._cell: list[str] | None = None
        self._colspan = 1

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            self._cell = []
            try:
                self._colspan = max(1, int(dict(attrs).get("colspan") or 1))
            except ValueError:
                self._colspan = 1
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            if not self.rows:
                self.rows.append([])
            text = " ".join("".join(self._cell).split()).replace("|", "\\|")
            # Ô gộp nhiều cột: giữ chữ ở ô đầu, chèn ô trống cho các cột còn lại để các cột
            # phía sau không bị lệch sang trái. rowspan thì bỏ qua — bảng markdown không có
            # khái niệm gộp dòng, lệch nhẹ ở đó chấp nhận được.
            self.rows[-1].extend([text] + [""] * (self._colspan - 1))
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _html_table_to_markdown(table_html: str) -> str:
    parser = _TableParser()
    parser.feed(table_html)
    rows = [r for r in parser.rows if any(c.strip() for c in r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n" + "\n".join(lines) + "\n"


def _markdown_to_text(md: str) -> str:
    md = _TABLE_RE.sub(lambda m: _html_table_to_markdown(m.group(0)), md)
    md = _IMG_RE.sub("", md)
    md = _DIV_RE.sub("", md)
    md = html.unescape(md)
    return _BLANK_LINES_RE.sub("\n\n", md).strip()
