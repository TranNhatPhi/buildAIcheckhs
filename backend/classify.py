"""
Xử lý sau OCR: (1) dùng DeepSeek sửa lỗi chính tả/sắp xếp lại câu cho mạch lạc (có kèm
toạ độ từng dòng để LLM hiểu bố cục), (2) phân loại nội dung vào đúng mục checklist.
Port từ lib/classify.ts (Next.js) + bổ sung bước sửa lỗi vì OCR trên giấy tờ thật (đóng
dấu, viết tay, layout phức tạp) thường đọc sai/xáo trộn thứ tự nhiều hơn hẳn so với ảnh
test sạch — bước sửa lỗi giúp cả người đọc và bước phân loại có tín hiệu tốt hơn.

Lưu ý quan trọng về model: DEEPSEEK_MODEL cấu hình là model có suy luận (reasoning) — đã
xác nhận qua thực nghiệm là với input càng lộn xộn/khó hiểu thì model càng "suy nghĩ" lâu
(test trực tiếp qua curl: có input mất hơn 200s vẫn chưa xong). Tài khoản hiện tại chỉ có
2 model (deepseek-v4-flash, deepseek-v4-pro), cả 2 đều reasoning theo TÊN model — NHƯNG có
thể tắt hẳn phần suy luận qua tham số request `extra_body={"thinking": {"type": "disabled"}}`
(xác nhận qua curl trực tiếp lên api.deepseek.com, không phải đoán).

Đã thực nghiệm để quyết định BƯỚC NÀO được tắt reasoning:
- SỬA LỖI OCR (correct_ocr_text): tắt reasoning AN TOÀN — chỉ là việc sửa chính tả/sắp xếp
  lại câu theo quy tắc cố định, không cần phán đoán. Giảm 150-450s xuống 1-10s (nhanh hơn
  40-150 lần), output kiểm tra bằng tay vẫn mạch lạc, không bịa/sai số liệu.
- PHÂN LOẠI (classify_ocr_text): ĐÃ THỬ tắt reasoning rồi PHỤC HỒI LẠI vì phát hiện lỗi thật
  qua thực nghiệm — chạy lặp lại 4 lần cùng 1 file "CCCD của mẹ khách hàng" (tên file có ghi
  rõ "mother"), 3/4 lần model bỏ qua tín hiệu tên file, khớp nhầm thành mục CCCD của chính
  đương đơn thay vì mục CCCD của mẹ — với confidence vẫn 0.9-1.0 (tức sẽ TỰ ĐỘNG khớp, không
  đưa nhân viên soát lại vì confidence cao hơn CONFIDENCE_THRESHOLD). Việc phân biệt "giấy tờ
  này là của ai trong gia đình" (đương đơn/vợ chồng/cha/mẹ/con) cần suy luận thật, không phải
  việc máy móc — nên giữ nguyên reasoning bật cho bước này dù chậm hơn.
- "Phân tích AI chuyên sâu" (summarize_case_profile — đối chiếu chéo nhiều giấy tờ, phát hiện
  bất nhất): CỐ Ý giữ reasoning bật, vì cần suy luận thật (so sánh nhiều nguồn dữ liệu), theo
  đúng yêu cầu người dùng "reason chỉ dành cho phân tích chuyên sâu".

Kết quả: 1 file giảm từ ~300-450s (2 lệnh có reasoning) xuống còn ~150-230s (chỉ còn lệnh
phân loại có reasoning, lệnh sửa lỗi gần như tức thời) — giảm khoảng nửa thời gian AN TOÀN,
thay vì giảm ~100 lần nhưng có rủi ro sai âm thầm ở các mục dễ nhầm lẫn giữa thành viên gia
đình. Vẫn giữ `max_tokens` cao + timeout lớn cho client dùng chung (áp dụng cho cả lệnh
có/không reasoning).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from llm import GEMINI_LOW_REASONING, _env_int, complete_with_fallback, describe_error
from models import ChecklistItem

logger = logging.getLogger("classify")

# Tắt suy luận (reasoning) — CHỈ dùng cho correct_ocr_text (sửa chính tả OCR, việc máy móc
# theo quy tắc cố định). KHÔNG dùng cho classify_ocr_text (đã thử rồi bỏ — cần suy luận thật
# để phân biệt giấy tờ của thành viên nào trong gia đình) hay summarize_case_profile (phân
# tích chuyên sâu) — xem giải thích + số liệu thực nghiệm ở docstring đầu file.
_NO_THINKING = {"thinking": {"type": "disabled"}}


CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.6"))


# ĐÃ THỬ giới hạn max_tokens thấp (4000) để chặn suy luận vô hạn — THẤT BẠI: đã xác nhận
# bằng thực nghiệm là với input lộn xộn, model dùng HẾT 4000 token chỉ để suy luận
# (reasoning_content dài, content cuối rỗng, finish_reason="length") — tức bị cắt ngang
# TRƯỚC KHI ra được câu trả lời, khiến correction luôn thất bại trên đúng những case khó
# nhất (chính là case cần sửa nhất). Vì vậy để max_tokens cao, dựa vào `timeout` ở trên
# làm giới hạn thời gian thực tế — chấp nhận một số request rất khó (chữ bị OCR sai/ảo
# giác nặng) có thể timeout và fallback về text thô, thay vì luôn thất bại.
#
# NÂNG 2 LẦN — mỗi lần đều xác nhận bằng thực nghiệm thật (gọi lặp lại DeepSeek, không đoán):
# (1) 16000 → 28000: cùng 1 input CCCD khó, gọi lặp lại nhiều lần cho ra reasoning_tokens
#     KHÔNG cố định (15313 rồi 16943 — dao động ~10%). Ở trần 16000, lần dùng 16943 bị cắt
#     ngang giữa chừng (content rỗng) trong khi lần dùng 15313 lọt qua — đây là lý do bước
#     sửa OCR "lúc được lúc không" trên CÙNG 1 tài liệu dù không đổi gì cả.
# (2) 28000 → 40000: phát hiện thêm là bước sửa OCR THẬT trong pipeline gửi kèm TOẠ ĐỘ từng
#     dòng (_format_lines_with_boxes, để LLM hiểu bố cục — xem correct_ocr_text) chứ không
#     phải text thuần — test lại với ĐÚNG prompt thật (có toạ độ) trên cùng tài liệu CCCD
#     cho ra 23646 reasoning_tokens (166.7s), cao hơn hẳn so với lúc test bằng text thuần
#     (15000-17000 token) — tức bản thân việc thêm toạ độ khiến model suy luận nặng hơn
#     nhiều. Ở trần 28000 gần như không còn margin cho biến động ~10% nói trên. Nâng lên
#     40000 (~65% margin so với đỉnh 23646 đã đo được) + timeout 240s→300s (thời gian có vẻ
#     tỉ lệ gần tuyến tính với số token, ~7ms/token từ số liệu đo được).
# (3) 40000 → 60000: sau khi thêm quy tắc bảng Markdown + giữ nguyên marker phân trang "---
#     Trang N ---" vào prompt (khiến model phải suy luận thêm về cấu trúc), 1 lần reclassify
#     THẬT bị lỗi correctedText=None (rỗng, không log exception — đúng dấu hiệu bị cắt ngang
#     do hết token). Gọi lặp lại 3 lần CÙNG input để đo lại: 25893, 31662, 23127 reasoning
#     token — đỉnh 31662 chỉ còn ~20% margin so với trần 40000 cũ, khớp với lỗi vừa gặp. Nâng
#     lên 60000 (~90% margin so với đỉnh 31662 đã đo) — client timeout đã sẵn 600s (nâng lúc
#     thêm SUMMARY_MAX_TOKENS=60000) nên không cần đổi thêm.
CORRECTION_MAX_TOKENS = 60000
CLASSIFICATION_MAX_TOKENS = 8000

# Text ngắn hơn mức này thì bước sửa OCR ưu tiên model lite của Gemini (hạn mức free gấp 3 —
# xem GEMINI_LITE_MODELS trong llm.py). Dùng SỐ KÝ TỰ chứ không phải số trang vì hàm sửa lỗi
# chỉ nhận được text, không biết file mấy trang — mà "ít token" mới đúng là thứ quyết định.
# 3000 lấy từ số đo thật: tài liệu 1 trang đọc ra 723-1036 ký tự, 2 trang khoảng 1300-2200 —
# nên 3000 phủ trọn nhóm 1-2 trang mà không đụng tới tài liệu dày (7 trang: 7541 ký tự).
# CHỈ áp cho bước sửa lỗi (việc máy móc), KHÔNG áp cho phân loại — xem docstring đầu file.
LITE_CORRECTION_MAX_CHARS = _env_int("LITE_CORRECTION_MAX_CHARS", 3000)

CORRECTION_SYSTEM_PROMPT = """Bạn là trợ lý sửa lỗi văn bản OCR tiếng Việt. Bạn sẽ nhận được các
dòng chữ trích xuất bằng OCR từ một giấy tờ hành chính (căn cước, giấy khai sinh, bằng cấp...).
Nội dung từng dòng có thể sai chính tả, mất dấu, thứ tự dòng có thể chưa đúng thứ tự đọc tự nhiên.

Nhiệm vụ: viết lại thành văn bản mạch lạc, đúng chính tả tiếng Việt, sắp xếp lại theo thứ tự đọc
tự nhiên của một giấy tờ hành chính thật nếu thứ tự dòng gốc bị xáo trộn.

Quy tắc BẮT BUỘC:
- Nếu input có các dòng phân trang dạng "--- Trang N ---" (giấy tờ PDF nhiều trang), GIỮ NGUYÊN
  các dòng phân trang này y hệt, đúng vị trí ranh giới giữa các trang, trong bài trả lời — chỉ
  sắp xếp lại thứ tự đọc trong PHẠM VI từng trang, không di chuyển nội dung sang trang khác.
- KHÔNG được bịa thêm thông tin không có trong các dòng gốc (tên người, số liệu, ngày tháng...).
- Giữ nguyên chính xác mọi con số, ngày tháng, số CCCD/hộ khẩu — chỉ sửa chính tả chữ cái, không
  được đoán/sửa số liệu vì có thể làm sai lệch thông tin thật.
- Nếu một dòng quá vô nghĩa/rời rạc để sửa mà không đoán bừa, giữ nguyên dòng đó thay vì bịa.
- Nếu một đoạn rõ ràng là DẠNG BẢNG (bảng điểm nhiều môn/nhiều học kỳ, danh sách thành viên hộ
  gia đình, bảng thông tin nhiều cột...), trình bày lại đúng đoạn đó dưới dạng bảng Markdown
  (dòng đầu là tên cột cách nhau bằng `|`, dòng kế tiếp là `---|---|...`, các dòng sau là dữ
  liệu) để hiển thị rõ ràng thay vì liệt kê số liệu rời rạc khó đọc — CHỈ áp dụng cho đúng phần
  là bảng, phần văn xuôi còn lại của giấy tờ vẫn viết bình thường như trên, không dùng thêm
  markdown nào khác (không in đậm, không tiêu đề #, không gạch đầu dòng).
- Ngoài quy tắc bảng ở trên, trả lời CHỈ bằng văn bản đã sửa, không thêm giải thích.
"""


def correct_ocr_text(raw_text: str) -> str | None:
    """Trả về text đã sửa, hoặc None nếu bước sửa lỗi thất bại (khi đó nơi gọi nên
    fallback dùng lại raw_text thay vì chặn cả pipeline).

    TRƯỚC ĐÂY có gửi kèm toạ độ pixel từng dòng (_format_lines_with_boxes) để LLM hiểu bố
    cục — bỏ vì xác nhận bằng thực nghiệm (đo usage thật của DeepSeek trên cùng 1 tài liệu)
    là bản có toạ độ khiến model suy luận nặng hơn hẳn (23646 reasoning token, 166.7s) so
    với bản text thuần (~15000-17000 token) — tốn token/thời gian hơn nhiều cho lợi ích sắp
    xếp lại thứ tự dòng mà model vẫn làm được khá tốt chỉ với text thuần."""
    if not raw_text or not raw_text.strip():
        return None
    try:
        return complete_with_fallback(
            step="Sửa OCR",
            messages=[
                {"role": "system", "content": CORRECTION_SYSTEM_PROMPT},
                {"role": "user", "content": raw_text},
            ],
            deepseek_max_tokens=CORRECTION_MAX_TOKENS,
            # Tắt suy luận ở CẢ 2 nhà cung cấp — bước này chỉ sửa chính tả/sắp xếp theo quy
            # tắc cố định, không cần phán đoán (xem docstring đầu file về thực nghiệm đã làm
            # với DeepSeek). Hai bên khai báo khác nhau nên phải truyền cả 2 tham số.
            gemini_reasoning_effort=GEMINI_LOW_REASONING,
            deepseek_extra_body=_NO_THINKING,
            prefer_lite=len(raw_text) <= LITE_CORRECTION_MAX_CHARS,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Lỗi bước sửa OCR: %s", e)
        return None


def _build_classification_system_prompt(items: list[ChecklistItem]) -> str:
    lines = []
    for i in items:
        line = f'- id="{i.id}" | nhóm="{i.group}" | tên="{i.nameVi}"'
        if i.note:
            line += f' | ghi chú="{i.note}"'
        if i.isOptional:
            line += " | (tuỳ chọn)"
        lines.append(line)
    item_lines = "\n".join(lines)

    return f"""Bạn là trợ lý phân loại giấy tờ hồ sơ định cư Canada cho một công ty tư vấn di trú Việt Nam.
Bạn sẽ nhận được nội dung văn bản đã trích xuất (OCR, đã qua bước sửa lỗi chính tả) từ một file
khách hàng upload (ảnh chụp/scan giấy tờ hoặc PDF).
Nhiệm vụ: xác định file này khớp với MỘT mục nào trong danh sách checklist dưới đây, dựa trên nội dung được cung cấp.

Danh sách mục checklist hợp lệ:
{item_lines}

Quy tắc:
- Chỉ chọn "matched_item_id" là một trong các id ở trên, hoặc chuỗi "unmatched" nếu nội dung không rõ ràng khớp mục nào.
- Nhiều mục có tên gần giống nhau (vd bằng cấp vs học bạ vs bảng điểm) — đọc kỹ nội dung để phân biệt loại giấy tờ chính xác.
- "confidence" là số từ 0 đến 1, thể hiện mức độ chắc chắn.
- "reasoning" là 1 câu ngắn gọn bằng tiếng Việt giải thích vì sao chọn mục đó.
- Trả lời CHỈ bằng JSON hợp lệ theo đúng format: {{"matched_item_id": string, "confidence": number, "reasoning": string}}"""


@dataclass
class ClassifyOutcome:
    ocr_text: str | None
    corrected_text: str | None
    status: str  # CLASSIFIED | NEEDS_REVIEW | ERROR
    matched_checklist_item_id: str | None
    ai_raw_label: str | None
    ai_confidence: float | None
    ai_reasoning: str | None
    classification_error: str | None


EMPTY_TEXT_THRESHOLD = 5  # số ký tự — dưới mức này coi như "không đọc được chữ gì"


def classify_ocr_text(
    ocr_text: str,
    filename: str,
    applicable_items: list[ChecklistItem],
) -> ClassifyOutcome:
    # File gần như không có chữ (vd ảnh chân dung trơn cho mục "Hình thẻ trắng") — bỏ qua
    # cả 2 lệnh gọi DeepSeek (sửa lỗi + phân loại) vì không có gì để sửa/phân loại từ text
    # rỗng, chỉ tốn thời gian gọi API vô ích. Trả thẳng "chưa phân loại" để nhân viên tự
    # chọn tay — đã thử gợi ý heuristic cụ thể theo mục nhưng người dùng không muốn, chỉ
    # cần giữ lại phần bỏ qua DeepSeek (thuần lợi ích hiệu năng, không đổi kết quả).
    if len(ocr_text.strip()) < EMPTY_TEXT_THRESHOLD:
        return ClassifyOutcome(
            ocr_text=ocr_text,
            corrected_text=None,
            status="NEEDS_REVIEW",
            matched_checklist_item_id=None,
            ai_raw_label="unmatched",
            ai_confidence=0.1,
            ai_reasoning="File không đọc được chữ nào, không đủ căn cứ để xác định loại giấy tờ.",
            classification_error=None,
        )

    corrected_text = correct_ocr_text(ocr_text)
    # Ưu tiên dùng text đã sửa cho bước phân loại (tín hiệu sạch hơn); nếu bước sửa lỗi
    # thất bại thì fallback về text OCR thô thay vì chặn cả pipeline.
    text_for_classification = corrected_text or ocr_text

    try:
        # KHÔNG truyền reasoning_effort cho Gemini ở bước này — cần suy luận thật để phân
        # biệt "giấy tờ này của ai trong gia đình" (xem docstring đầu file: DeepSeek tắt
        # reasoning từng khớp nhầm CCCD của mẹ thành CCCD đương đơn 3/4 lần). Đã kiểm chứng
        # lại đúng case đó với Gemini để reasoning mặc định: gemini-3.6-flash đúng 6/6 lần,
        # mỗi lần ~4s, trong khi DeepSeek có reasoning mất hàng chục tới hàng trăm giây.
        raw = complete_with_fallback(
            step="Phân loại",
            messages=[
                {"role": "system", "content": _build_classification_system_prompt(applicable_items)},
                {
                    "role": "user",
                    "content": f"Tên file gốc: {filename}\n\nNội dung trích xuất được:\n{text_for_classification or '(không đọc được nội dung)'}",
                },
            ],
            deepseek_max_tokens=CLASSIFICATION_MAX_TOKENS,
            response_format={"type": "json_object"},
        )
        parsed = json.loads(raw or "")

        matched_item_id = str(parsed["matched_item_id"])
        confidence = float(parsed["confidence"])
        reasoning = str(parsed.get("reasoning", ""))

        valid_ids = {i.id for i in applicable_items}
        is_known_match = matched_item_id != "unmatched" and matched_item_id in valid_ids
        meets_threshold = confidence >= CONFIDENCE_THRESHOLD

        if is_known_match and meets_threshold:
            return ClassifyOutcome(
                ocr_text=ocr_text,
                corrected_text=corrected_text,
                status="CLASSIFIED",
                matched_checklist_item_id=matched_item_id,
                ai_raw_label=matched_item_id,
                ai_confidence=confidence,
                ai_reasoning=reasoning,
                classification_error=None,
            )

        return ClassifyOutcome(
            ocr_text=ocr_text,
            corrected_text=corrected_text,
            status="NEEDS_REVIEW",
            matched_checklist_item_id=None,
            ai_raw_label=matched_item_id,
            ai_confidence=confidence,
            ai_reasoning=reasoning,
            classification_error=None,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Lỗi phân loại DeepSeek: %s", e)
        return ClassifyOutcome(
            ocr_text=ocr_text,
            corrected_text=corrected_text,
            status="ERROR",
            matched_checklist_item_id=None,
            ai_raw_label=None,
            ai_confidence=None,
            ai_reasoning=None,
            classification_error=f"Lỗi phân loại: {describe_error(e)}",
        )


# Theo yêu cầu người dùng: cần bản phân tích CHI TIẾT ĐẦY ĐỦ (không phải bản tóm tắt ngắn
# lướt nữa). Người dùng yêu cầu đặt mức 20000 — đã THỬ THẬT với hồ sơ 12 file (Nguyễn Hồng
# Sơn) và xác nhận KHÔNG đủ: prompt chi tiết bắt AI đối chiếu chéo từng giấy tờ khiến
# reasoning_content một mình đã tốn hết sạch 20000 token (finish_reason="length", content
# rỗng hoàn toàn) — tức ở mức 20000, tính năng này LUÔN LỖI với hồ sơ nhiều file, không
# phải thi thoảng. Test lại với trần 64000 để đo mức thật: reasoning_tokens=26873 +
# completion phần trả lời=7311 (16203 ký tự), tổng completion_tokens=34184, chạy xong bình
# thường (finish_reason="stop"). Đặt 60000 (~75% margin so với đỉnh 34184 đã đo, cùng cách
# tính margin đã dùng cho CORRECTION_MAX_TOKENS — DeepSeek reasoning dao động ~10%+ giữa
# các lần gọi dù cùng input) để tính năng THỰC SỰ chạy được thay vì đặt đúng con số người
# dùng yêu cầu nhưng luôn trả về lỗi.
SUMMARY_MAX_TOKENS = 60000

SUMMARY_SYSTEM_PROMPT = """Bạn là trợ lý phân tích hồ sơ cho công ty tư vấn định cư Canada. Bạn sẽ
nhận được thông tin đã trích xuất (OCR + đã sửa lỗi) từ các giấy tờ mà một khách hàng đã nộp, mỗi
đoạn được gắn nhãn theo đúng mục checklist mà file đó khớp vào.

Nhiệm vụ: viết một bản PHÂN TÍCH cho nhân viên tư vấn — ưu tiên NGẮN GỌN, DỄ LƯỚT (nhân viên cần
nhìn vào là biết ngay cần làm gì), KHÔNG viết văn xuôi dài dòng. Gồm đúng 5 phần sau, mỗi phần bắt
đầu bằng dòng tiêu đề số thứ tự (vd "1. THÔNG TIN CÁ NHÂN"):

1. THÔNG TIN CÁ NHÂN: liệt kê NGẮN GỌN dưới dạng gạch đầu dòng "- Nhãn: giá trị" (1 dòng/1 thông
   tin — họ tên, ngày sinh, giới tính, số CCCD/CMND, số hộ chiếu, quê quán...), của đương đơn và
   người phụ thuộc nếu có. Không viết thành câu văn, không giải thích thêm.
2. DANH SÁCH GIẤY TỜ ĐÃ NỘP: gạch đầu dòng, MỖI FILE 1 DÒNG NGẮN dạng "- Tên file: loại giấy tờ,
   số hiệu/ngày cấp chính (nếu có)" — không liệt kê hết mọi trường, chỉ 1-2 chi tiết định danh
   quan trọng nhất của file đó.
3. ĐIỂM CẦN SỬA/BẤT NHẤT (QUAN TRỌNG NHẤT): gạch đầu dòng, MỖI ĐIỂM BẤT NHẤT 1 DÒNG NGẮN, format
   "- [Trường thông tin]: **giá trị A** (nguồn A) vs **giá trị B** (nguồn B)" — không viết đoạn văn
   giải thích dài, chỉ nêu đúng sự khác biệt và nguồn. BẮT BUỘC in đậm (**...**) đúng các giá trị
   khác nhau đó. Nếu không phát hiện gì thì ghi 1 dòng "- Không phát hiện điểm bất thường".
4. GHI CHÚ KHÁC: gạch đầu dòng, mỗi dòng 1 file OCR mờ/không đọc rõ cần nhân viên tự mở xem, format
   "- **Tên file**: lý do ngắn gọn cần xem lại". Nếu không có thì ghi 1 dòng "- Không có ghi chú
   khác".
5. TÓM TẮT CẦN CHỈNH SỬA: đúc kết NGẮN NHẤT có thể từ phần 3 và 4 thành danh sách việc cần làm,
   gạch đầu dòng, mỗi việc 1 câu ngắn gọn kiểu checklist hành động (vd "- Xác minh số hộ chiếu
   đúng (P055574825 hay P03537482?)", "- Xem lại bản gốc: Bằng C3.pdf, CCCD mẹ"). Đây là phần
   nhân viên đọc ĐẦU TIÊN nên phải cô đọng nhất trong cả báo cáo.

Quy tắc BẮT BUỘC:
- CHỈ dựa trên thông tin được cung cấp bên dưới — KHÔNG bịa thêm, KHÔNG suy đoán thông tin không có.
- Nếu không đọc được thông tin đủ để nói gì về khách hàng, nói thẳng là vậy, không cố suy diễn.
- MỌI phần đều dùng gạch đầu dòng "- " như hướng dẫn trên, không viết văn xuôi liền mạch, không
  dùng markdown khác ngoài "- " để gạch đầu dòng và "**...**" để in đậm (không tiêu đề #, không
  bảng markdown).
"""


def summarize_case_profile(case_context: str, documents_text: str) -> tuple[str | None, str | None]:
    """Trả về (summary, error_message) — đúng 1 trong 2 có giá trị. Dùng cho nút "Phân tích AI
    chuyên sâu" ở trang Tổng hợp thông tin — chỉ tóm tắt dữ liệu ĐÃ CÓ sẵn trong DB (không OCR
    lại), nên input đã sạch hơn hẳn so với bước sửa lỗi OCR thô, thường nhanh hơn nhiều.

    Thứ tự nhà cung cấp: GEMINI TRƯỚC (mọi model x mọi key, dùng hạn mức miễn phí), HẾT free
    mới quay về DEEPSEEK — xem llm.complete_with_fallback."""
    if not documents_text.strip():
        return None, "Chưa có file nào được phân loại — chưa có dữ liệu để phân tích."

    try:
        # Giữ reasoning mặc định ở cả 2 nhà cung cấp — bước này cần suy luận thật (đối chiếu
        # chéo nhiều nguồn dữ liệu để phát hiện bất nhất), theo đúng yêu cầu người dùng.
        summary = complete_with_fallback(
            step="Phân tích chuyên sâu",
            messages=[
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"{case_context}\n\nThông tin trích xuất từ các giấy tờ đã nộp:\n{documents_text}",
                },
            ],
            deepseek_max_tokens=SUMMARY_MAX_TOKENS,
        )
        if not summary:
            return None, "AI không trả về nội dung tóm tắt — thử lại sau."
        return summary, None
    except Exception as e:  # noqa: BLE001
        logger.warning("Lỗi phân tích AI chuyên sâu: %s", e)
        return None, describe_error(e)


# ---------------------------------------------------------------------------
# Đọc số dư tiết kiệm từ giấy tờ chứng minh tài chính
# ---------------------------------------------------------------------------

# Nhỏ hơn hẳn CLASSIFICATION_MAX_TOKENS: đầu ra chỉ là 1 con số + vài dòng liệt kê nguồn,
# không phải đoạn phân tích dài. Vẫn để rộng rãi vì Gemini 3.x là model lai — phần suy luận
# ăn CHUNG hạn mức này, cắt sát quá là trả về rỗng với finish_reason="length" (đã gặp thật
# ở SUMMARY_MAX_TOKENS, xem ghi chú ở đó).
SAVINGS_MAX_TOKENS = 8000

SAVINGS_SYSTEM_PROMPT = """Bạn đọc giấy tờ chứng minh tài chính (sổ tiết kiệm, giấy xác nhận số dư
sổ tiết kiệm) của khách hàng làm hồ sơ định cư Canada, và trả về TỔNG SỐ TIỀN TIẾT KIỆM khách
đang có, tính bằng ĐỒNG VIỆT NAM.

Trả về JSON đúng dạng:
{"total_vnd": <số nguyên, đơn vị đồng>, "accounts": [{"source": "<tên file>", "bank": "<ngân hàng>",
"account_no": "<số sổ/số tài khoản nếu đọc được>", "amount_vnd": <số nguyên>}], "note": "<giải
thích ngắn gọn bằng tiếng Việt: đã cộng những khoản nào, đã loại khoản nào và vì sao>"}

Quy tắc BẮT BUỘC:
- KHÔNG ĐƯỢC TRÙNG TIỀN. Sổ tiết kiệm và Giấy xác nhận số dư của CÙNG MỘT sổ là CÙNG MỘT khoản
  tiền được chứng minh hai lần — chỉ tính MỘT LẦN. Dấu hiệu cùng một sổ: trùng số sổ/số tài
  khoản, hoặc trùng cả ngân hàng lẫn số tiền. Đây là lỗi nguy hiểm nhất ở việc này: cộng trùng
  làm hồ sơ thiếu tiền trông như đủ tiền.
- Chỉ tính TIỀN GỬI TIẾT KIỆM đứng tên khách hoặc vợ/chồng khách. KHÔNG tính giá trị nhà đất,
  xe, lương hàng tháng, hay số dư tài khoản thanh toán thông thường.
- Nếu giấy tờ ghi bằng ngoại tệ (USD...), ĐỪNG tự quy đổi — bỏ khoản đó ra khỏi total_vnd và
  ghi rõ trong "note" là có khoản ngoại tệ cần nhân viên tự quy đổi.
- Đọc kỹ số 0. "100.000.000" là một trăm triệu, "10.000.000" là mười triệu. Nếu chữ số bị mờ
  hoặc không chắc chắn, ĐỪNG ĐOÁN: bỏ khoản đó ra và ghi lý do vào "note".
- Nếu không tìm thấy khoản tiết kiệm nào đọc được, trả về {"total_vnd": null, "accounts": [],
  "note": "<lý do>"}.
- CHỈ dựa trên nội dung được cung cấp. KHÔNG bịa số.
"""


MYSQL_BIGINT_MAX = 9_223_372_036_854_775_807


def _parse_vnd_amount(value: object) -> int | None:
    """Đổi số tiền AI trả về mà không làm tròn âm thầm hoặc vượt giới hạn cột BIGINT."""
    if isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite() or amount != amount.to_integral_value():
        return None
    parsed = int(amount)
    if parsed < -MYSQL_BIGINT_MAX - 1 or parsed > MYSQL_BIGINT_MAX:
        return None
    return parsed


def extract_savings_balance(documents_text: str) -> tuple[int | None, str | None, str | None]:
    """Đọc tổng số dư tiết kiệm từ văn bản các giấy tờ tài chính đã nộp.

    Trả về (tổng_vnd, ghi_chú_cho_nhân_viên, lỗi) — `lỗi` khác None nghĩa là không đọc được,
    lúc đó 2 giá trị đầu là None.

    Con số trả về là ĐỀ XUẤT của AI, không phải kết luận: nơi gọi lưu vào Case.savingsAiVnd
    và luôn để nhân viên đè lên bằng savingsManualVnd (xem completeness.assess_savings)."""
    if not documents_text.strip():
        return None, None, "Chưa có giấy tờ tài chính nào được phân loại."

    try:
        raw = complete_with_fallback(
            step="Đọc số dư tiết kiệm",
            messages=[
                {"role": "system", "content": SAVINGS_SYSTEM_PROMPT},
                {"role": "user", "content": documents_text},
            ],
            deepseek_max_tokens=SAVINGS_MAX_TOKENS,
            response_format={"type": "json_object"},
        )
        parsed = json.loads(raw or "")
    except Exception as e:  # noqa: BLE001
        logger.warning("Lỗi đọc số dư tiết kiệm: %s", e)
        return None, None, describe_error(e)

    if not isinstance(parsed, dict):
        logger.warning("AI trả về dữ liệu số dư không phải JSON object: %r", parsed)
        return None, None, "AI trả về dữ liệu số dư không đúng định dạng."

    total = parsed.get("total_vnd")
    if total is None:
        return None, str(parsed.get("note") or "AI không đọc được số dư nào."), None

    # Decimal nhận cả "400000000.0" và "4e8" nhưng không làm mất độ chính xác như float;
    # đồng thời chặn NaN/vô cực/số lẻ và số vượt BIGINT trước khi ghi MySQL.
    total_vnd = _parse_vnd_amount(total)
    if total_vnd is None:
        logger.warning("AI trả về total_vnd không phải số: %r", total)
        return None, None, "AI trả về số dư không đọc được thành số."

    if total_vnd < 0:
        return None, None, "AI trả về số dư âm — bỏ qua."

    # Ghép phần liệt kê từng khoản vào ghi chú: nhân viên phải nhìn thấy con số tổng ĐƯỢC
    # CỘNG TỪ ĐÂU mới soát được, nhất là để bắt lỗi cộng trùng sổ tiết kiệm với giấy xác
    # nhận số dư của chính sổ đó.
    lines: list[str] = []
    for acc in parsed.get("accounts") or []:
        if not isinstance(acc, dict):
            continue
        bits = [str(acc.get(k)) for k in ("bank", "account_no") if acc.get(k)]
        amount = acc.get("amount_vnd")
        parsed_amount = _parse_vnd_amount(amount)
        amount_str = f"{parsed_amount:,} đ".replace(",", ".") if parsed_amount is not None else "?"
        lines.append(f"- {acc.get('source') or 'không rõ nguồn'}: {amount_str}"
                     + (f" ({', '.join(bits)})" if bits else ""))

    note_parts = []
    if lines:
        note_parts.append("\n".join(lines))
    if parsed.get("note"):
        note_parts.append(str(parsed["note"]))

    return total_vnd, "\n\n".join(note_parts) or None, None
