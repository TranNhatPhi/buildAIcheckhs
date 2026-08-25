"""Xuất văn bản (báo cáo Phân tích AI chuyên sâu) thành PDF cho nút "Tải tất cả hồ sơ".

Dùng PyMuPDF (đã là dependency sẵn có cho ocr.py) tự vẽ text lên trang PDF mới — KHÔNG dùng
font mặc định "helv" (Helvetica base14) vì đã xác nhận bằng thực nghiệm là font đó KHÔNG có
glyph cho dấu tiếng Việt, mọi ký tự có dấu (đ, ệ, ữ, ồ, ơ...) hiển thị thành "?". Nhúng font
hệ thống "Arial Unicode.ttf" (có sẵn trên macOS, đã test render đúng 100% qua cả text-extract
lẫn render ảnh trực quan) để hiển thị đúng tiếng Việt có dấu.

App này chạy local trên 1 máy (không phải server đa nền tảng) nên dùng đường dẫn font hệ
thống macOS là chấp nhận được — nhưng vẫn có fallback an toàn: nếu font không tồn tại (máy
khác/Mac đời sau gỡ font này) thì trả về None, nơi gọi (routers/cases.py) sẽ tự chuyển sang
xuất .txt thay vì làm cả tính năng tải hồ sơ bị lỗi.
"""
from __future__ import annotations

import logging
import re

import fitz

logger = logging.getLogger(__name__)

_FONT_CANDIDATES = [
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
]

_PAGE_WIDTH, _PAGE_HEIGHT = fitz.paper_size("a4")
_MARGIN = 50
_CONTENT_WIDTH = _PAGE_WIDTH - 2 * _MARGIN
_BODY_SIZE = 10.5
_HEADING_SIZE = 13
_LINE_HEIGHT = _BODY_SIZE * 1.45
_HEADING_LINE_HEIGHT = _HEADING_SIZE * 1.6

# Tiêu đề mục đánh số kiểu "1. THÔNG TIN CÁ NHÂN" (SUMMARY_SYSTEM_PROMPT ở classify.py) —
# cùng heuristic với isHeadingLine ở FormattedDocumentText.tsx (frontend) để nhất quán.
_HEADING_RE = re.compile(r"^\s*\d+\.\s+(.+)$")


def _is_heading(line: str) -> bool:
    m = _HEADING_RE.match(line)
    if not m:
        return False
    rest = m.group(1).strip()
    return bool(rest) and len(rest) <= 60 and ":" not in rest and rest == rest.upper()


def _find_font_path() -> str | None:
    for path in _FONT_CANDIDATES:
        try:
            with open(path, "rb"):
                return path
        except OSError:
            continue
    return None


def _wrap_line(font: fitz.Font, text: str, size: float, max_width: float) -> list[str]:
    if not text:
        return [""]
    words = text.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if font.text_length(candidate, fontsize=size) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def render_text_to_pdf(text: str, doc_title: str) -> bytes | None:
    """Trả về bytes PDF, hoặc None nếu không tìm được font Unicode khả dụng trên máy này."""
    font_path = _find_font_path()
    if not font_path:
        logger.warning("Không tìm thấy font Unicode để xuất PDF — fallback về .txt.")
        return None

    try:
        font = fitz.Font(fontfile=font_path)
        pdf = fitz.open()

        page = None
        y = 0.0

        def new_page() -> None:
            nonlocal page, y
            page = pdf.new_page(width=_PAGE_WIDTH, height=_PAGE_HEIGHT)
            page.insert_font(fontname="F0", fontfile=font_path)
            y = _MARGIN

        new_page()
        assert page is not None
        page.insert_text((_MARGIN, y), doc_title, fontsize=16, fontname="F0")
        y += 16 * 1.6 + 10

        # Bỏ dấu "**...**" (dùng để tô sáng khi hiển thị trên web) — PDF vẽ text thô, không
        # có khái niệm markdown, để nguyên chỉ thấy dấu sao thừa gây rối mắt.
        clean_text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)

        for raw_line in clean_text.split("\n"):
            is_heading = _is_heading(raw_line)
            size = _HEADING_SIZE if is_heading else _BODY_SIZE
            line_height = _HEADING_LINE_HEIGHT if is_heading else _LINE_HEIGHT
            wrapped = _wrap_line(font, raw_line, size, _CONTENT_WIDTH)

            if is_heading:
                y += line_height * 0.3  # khoảng cách thêm phía trên mỗi mục mới

            for wline in wrapped:
                if y + line_height > _PAGE_HEIGHT - _MARGIN:
                    new_page()
                    assert page is not None
                page.insert_text((_MARGIN, y), wline, fontsize=size, fontname="F0")
                y += line_height

        # "Arial Unicode.ttf" phủ gần như toàn bộ Unicode (bao gồm rất nhiều chữ Hán/CJK
        # không dùng tới) nên bản thân font đã nặng hàng chục MB — nếu nhúng nguyên file thì
        # 1 báo cáo vài nghìn ký tự cũng ra file PDF hơn 20MB (đã xác nhận bằng thực nghiệm).
        # subset_fonts() cắt font xuống chỉ còn đúng các glyph THỰC SỰ dùng trong văn bản.
        pdf.subset_fonts()
        return pdf.tobytes()
    except Exception:  # noqa: BLE001
        logger.warning("Lỗi khi xuất PDF phân tích AI — fallback về .txt.", exc_info=True)
        return None
