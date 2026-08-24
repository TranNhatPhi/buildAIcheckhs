"""
Xử lý sau OCR: (1) dùng DeepSeek sửa lỗi chính tả/sắp xếp lại câu cho mạch lạc (có kèm
toạ độ từng dòng để LLM hiểu bố cục), (2) phân loại nội dung vào đúng mục checklist.
Port từ lib/classify.ts (Next.js) + bổ sung bước sửa lỗi vì OCR trên giấy tờ thật (đóng
dấu, viết tay, layout phức tạp) thường đọc sai/xáo trộn thứ tự nhiều hơn hẳn so với ảnh
test sạch — bước sửa lỗi giúp cả người đọc và bước phân loại có tín hiệu tốt hơn.

Lưu ý quan trọng về model: DEEPSEEK_MODEL hiện cấu hình là model có suy luận (reasoning) —
đã xác nhận qua thực nghiệm là với input càng lộn xộn/khó hiểu thì model càng "suy nghĩ"
lâu (test trực tiếp qua curl: có input mất hơn 120s vẫn chưa xong). Tài khoản hiện tại chỉ
có 2 model (deepseek-v4-flash, deepseek-v4-pro), cả 2 đều reasoning, không có bản thường
nhanh hơn để đổi sang. Vì vậy có `max_tokens` để chặn việc sinh token vô hạn, và timeout
đủ lớn để không cắt ngang những trường hợp cần suy luận dài hợp lý.
"""
from __future__ import annotations

import json
import logging
import os
import random
from dataclasses import dataclass

from openai import APIConnectionError, APIStatusError, APITimeoutError, AuthenticationError, OpenAI, RateLimitError

from models import ChecklistItem

logger = logging.getLogger("classify")


def _describe_deepseek_error(e: Exception) -> str:
    """Dịch exception kỹ thuật khi gọi DeepSeek API (message gốc từ SDK openai luôn bằng
    tiếng Anh) sang câu tiếng Việt dễ hiểu cho nhân viên — không hiển thị nguyên văn lên UI."""
    if isinstance(e, APITimeoutError):
        return "DeepSeek phản hồi quá lâu (quá thời gian chờ) — thử lại sau."
    if isinstance(e, APIConnectionError):
        return "Không kết nối được tới DeepSeek API — kiểm tra kết nối mạng."
    if isinstance(e, AuthenticationError):
        return "Sai hoặc thiếu API key DeepSeek — kiểm tra cấu hình DEEPSEEK_API_KEY."
    if isinstance(e, RateLimitError):
        return "DeepSeek API đang bị giới hạn tần suất gọi (rate limit) — thử lại sau."
    if isinstance(e, APIStatusError):
        return f"DeepSeek API trả về lỗi (mã {e.status_code}) — thử lại sau."
    if isinstance(e, json.JSONDecodeError):
        return "DeepSeek trả về nội dung không đúng định dạng, không phân loại được."
    if isinstance(e, (KeyError, ValueError)):
        return "Kết quả phân loại từ DeepSeek thiếu dữ liệu hoặc sai định dạng."
    return "Lỗi không xác định khi gọi DeepSeek API — thử lại sau."

CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.6"))

# Phân luồng nhiều API key DeepSeek (round-robin ngẫu nhiên) thay vì dồn hết request vào 1
# key — chỉ có ý nghĩa THẬT SỰ từ sau khi sửa bug async chặn event loop (xem
# case_documents.py:upload_document): trước đó mọi request OCR/AI vốn đã bị serialize hết
# nên 1 key không phải nút thắt; giờ nhiều file thật sự chạy song song, dồn hết vào 1 key
# dễ dính rate-limit của riêng key đó. Các key dự phòng LLM_API_KEY_2..10 đã có sẵn trong
# .env gốc (project khác để lại, dùng cho "parallel shards") — main.py đã load_dotenv cả
# 2 file (.env.local rồi .env) nên các biến này đã có sẵn trong os.environ, không cần khai
# báo thêm ở .env.local.
_API_KEYS = [
    key
    for key in [
        os.environ["DEEPSEEK_API_KEY"],
        *(os.getenv(f"LLM_API_KEY_{i}") for i in range(2, 11)),
    ]
    if key
]
_API_KEYS = list(dict.fromkeys(_API_KEYS))  # bỏ trùng, giữ thứ tự — phòng khi 2 biến trỏ cùng 1 key

_clients = [
    OpenAI(
        base_url=os.environ["DEEPSEEK_BASE_URL"],
        api_key=key,
        # deepseek-v4-flash là model reasoning — xem giải thích ở CORRECTION_MAX_TOKENS. Nâng
        # 300s→600s khi thêm SUMMARY_MAX_TOKENS=60000 (bản phân tích chuyên sâu, mục lớn nhất
        # trong file): theo ước tính ~7ms/token đã quan sát được, 60000 token có thể cần tới
        # ~420s để sinh xong, sát trần cũ 300s — nâng lên 600s để đủ dư địa cho mọi loại gọi
        # dùng chung client pool này (correction 40000, summary 60000, classification 8000).
        timeout=600.0,
        max_retries=1,
    )
    for key in _API_KEYS
]
logger.info("DeepSeek client pool: %d key(s) sẵn sàng để phân luồng.", len(_clients))


def _get_client() -> OpenAI:
    return random.choice(_clients)

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
CORRECTION_MAX_TOKENS = 40000
CLASSIFICATION_MAX_TOKENS = 8000

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
        completion = _get_client().chat.completions.create(
            model=os.environ["DEEPSEEK_MODEL"],
            max_tokens=CORRECTION_MAX_TOKENS,
            messages=[
                {"role": "system", "content": CORRECTION_SYSTEM_PROMPT},
                {"role": "user", "content": raw_text},
            ],
        )
        corrected = completion.choices[0].message.content
        return corrected.strip() if corrected else None
    except Exception as e:  # noqa: BLE001
        logger.warning("Lỗi bước sửa OCR bằng DeepSeek: %s", e)
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
        completion = _get_client().chat.completions.create(
            model=os.environ["DEEPSEEK_MODEL"],
            max_tokens=CLASSIFICATION_MAX_TOKENS,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _build_classification_system_prompt(applicable_items)},
                {
                    "role": "user",
                    "content": f"Tên file gốc: {filename}\n\nNội dung trích xuất được:\n{text_for_classification or '(không đọc được nội dung)'}",
                },
            ],
        )
        raw = completion.choices[0].message.content or ""
        parsed = json.loads(raw)

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
            classification_error=f"Lỗi phân loại DeepSeek: {_describe_deepseek_error(e)}",
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

Nhiệm vụ: viết một bản PHÂN TÍCH CHI TIẾT VÀ ĐẦY ĐỦ (tiếng Việt) về hồ sơ khách hàng này — đây là
báo cáo phân tích chuyên sâu cho nhân viên tư vấn đọc kỹ, KHÔNG phải bản tóm tắt lướt nhanh, nên
không giới hạn độ dài, viết đủ chi tiết để bao quát hết thông tin quan trọng đọc được. Gồm các
phần sau:

1. THÔNG TIN CÁ NHÂN: liệt kê đầy đủ mọi thông tin cá nhân rút ra được của đương đơn (họ tên, ngày
   sinh, giới tính, số CCCD/CMND, số hộ chiếu + ngày cấp/hết hạn, quê quán/nơi thường trú...) và
   của người phụ thuộc nếu có (vợ/chồng, con, cha mẹ) — càng chi tiết càng tốt, không tóm lược.
2. DANH SÁCH GIẤY TỜ ĐÃ NỘP: điểm qua từng nhóm giấy tờ đã có, với các số liệu/chi tiết quan trọng
   của từng giấy tờ (số hiệu, ngày cấp, ngày hết hạn, cơ quan cấp...) — liệt kê cụ thể theo từng
   file, không gộp chung chung.
3. ĐỐI CHIẾU & ĐIỂM BẤT NHẤT (QUAN TRỌNG NHẤT): rà soát chéo toàn bộ giấy tờ, liệt kê CHI TIẾT
   từng điểm không khớp phát hiện được — vd tên/ngày sinh/số giấy tờ khác nhau giữa các file, ngày
   tháng bất thường hoặc không hợp lệ, giấy tờ có vẻ đã hết hạn, thông tin cha/mẹ/vợ/chồng/con
   không khớp giữa các nguồn. Với MỖI điểm bất nhất, nêu rõ: giá trị bất nhất là gì, xuất hiện ở
   (những) file/giấy tờ nào. Nếu không phát hiện gì bất thường thì ghi rõ "không phát hiện điểm
   bất thường".
4. GHI CHÚ KHÁC: nếu có đoạn OCR mờ/không đọc rõ ảnh hưởng tới việc đọc thông tin, nêu rõ file nào
   cần nhân viên tự mở lên xem lại bằng mắt để xác nhận.

Quy tắc BẮT BUỘC:
- CHỈ dựa trên thông tin được cung cấp bên dưới — KHÔNG bịa thêm, KHÔNG suy đoán thông tin không có.
- Nếu không đọc được thông tin đủ để nói gì về khách hàng, nói thẳng là vậy, không cố suy diễn.
- Trả lời bằng văn xuôi mạch lạc theo từng phần đánh số như trên, không dùng markdown/bullet phức
  tạp, có thể xuống dòng giữa các phần cho dễ đọc.
"""


def summarize_case_profile(case_context: str, documents_text: str) -> tuple[str | None, str | None]:
    """Trả về (summary, error_message) — đúng 1 trong 2 có giá trị. Dùng cho nút "Phân tích AI
    chuyên sâu" ở trang Tổng hợp thông tin — chỉ tóm tắt dữ liệu ĐÃ CÓ sẵn trong DB (không OCR
    lại), nên input đã sạch hơn hẳn so với bước sửa lỗi OCR thô, thường nhanh hơn nhiều."""
    if not documents_text.strip():
        return None, "Chưa có file nào được phân loại — chưa có dữ liệu để phân tích."

    try:
        completion = _get_client().chat.completions.create(
            model=os.environ["DEEPSEEK_MODEL"],
            max_tokens=SUMMARY_MAX_TOKENS,
            messages=[
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"{case_context}\n\nThông tin trích xuất từ các giấy tờ đã nộp:\n{documents_text}",
                },
            ],
        )
        summary = completion.choices[0].message.content
        if not summary or not summary.strip():
            return None, "DeepSeek không trả về nội dung tóm tắt — thử lại sau."
        return summary.strip(), None
    except Exception as e:  # noqa: BLE001
        logger.warning("Lỗi phân tích AI chuyên sâu: %s", e)
        return None, _describe_deepseek_error(e)
