"""Tầng gọi LLM dùng chung cho toàn app — quản lý API key, thứ tự nhà cung cấp và cách xử
lý lỗi ở MỘT chỗ duy nhất.

Tách ra khỏi classify.py khi bước OCR (ocr.py) cũng cần gọi Gemini: trước đó toàn bộ phần
này nằm trong classify.py, để ocr.py import classify.py thì vừa lệch nghĩa (OCR không phụ
thuộc phân loại) vừa dễ thành vòng import về sau. classify.py giờ chỉ còn prompt + logic
nghiệp vụ.

THỨ TỰ NHÀ CUNG CẤP (áp dụng cho mọi bước): GEMINI trước — dùng hạn mức miễn phí, duyệt hết
mọi MODEL x mọi KEY — hết sạch mới sang DEEPSEEK (trả tiền). Riêng bước OCR ảnh thì DeepSeek
không đọc được ảnh nên hết Gemini là quay về Tesseract chạy tại chỗ (xem ocr.py).
"""

from __future__ import annotations

import logging
import os
import random
import time

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    NotFoundError,
    OpenAI,
    RateLimitError,
)

logger = logging.getLogger("llm")


# Đọc biến môi trường coi CHUỖI RỖNG NHƯ CHƯA ĐẶT. Bắt buộc phải như vậy vì trên production
# các biến này đi qua docker-compose.prod.yml dạng `${GEMINI_MODELS:-}` — cú pháp đó LUÔN
# set biến, chỉ là set thành rỗng khi .env.prod chưa khai báo. Với os.getenv thường thì
# "đã set nhưng rỗng" KHÁC "chưa set", nên default trong code bị bỏ qua:
#   GEMINI_MODELS=""            -> danh sách model RỖNG -> Gemini không bao giờ được gọi,
#                                  âm thầm rơi hết về DeepSeek (tốn tiền) mà không báo lỗi
#   GEMINI_MAX_OUTPUT_TOKENS="" -> int("") ném ValueError NGAY LÚC IMPORT -> backend chết hẳn
# Cả 2 đều đã tái hiện được, không phải lo xa.
def _env_str(name: str, default: str) -> str:
    return os.getenv(name) or default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name) or ""
    try:
        return int(raw)
    except ValueError:
        if raw:
            logger.warning("%s=%r không phải số — dùng mặc định %d.", name, raw, default)
        return default


def _env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in _env_str(name, default).split(",") if item.strip()]


def describe_error(e: Exception) -> str:
    """Dịch exception kỹ thuật khi gọi LLM (message gốc từ SDK openai luôn bằng tiếng Anh)
    sang câu tiếng Việt dễ hiểu cho nhân viên — không hiển thị nguyên văn lên UI."""
    if isinstance(e, APITimeoutError):
        return "AI phản hồi quá lâu (quá thời gian chờ) — thử lại sau."
    if isinstance(e, APIConnectionError):
        return "Không kết nối được tới API AI — kiểm tra kết nối mạng."
    if isinstance(e, AuthenticationError):
        return "Sai hoặc thiếu API key — kiểm tra cấu hình DEEPSEEK_API_KEY / GEMINI_API_KEYv*."
    if isinstance(e, RateLimitError):
        return "API AI đang bị giới hạn tần suất gọi (rate limit) — thử lại sau."
    if isinstance(e, APIStatusError):
        return f"API AI trả về lỗi (mã {e.status_code}) — thử lại sau."
    import json as _json

    if isinstance(e, _json.JSONDecodeError):
        return "AI trả về nội dung không đúng định dạng, không phân loại được."
    if isinstance(e, (KeyError, ValueError)):
        return "Kết quả từ AI thiếu dữ liệu hoặc sai định dạng."
    return "Lỗi không xác định khi gọi API AI — thử lại sau."


# ---------------------------------------------------------------------------
# DeepSeek — nguồn DỰ PHÒNG (trả tiền), dùng khi đã hết hạn mức free của Gemini
# ---------------------------------------------------------------------------
# Phân luồng nhiều API key DeepSeek (round-robin ngẫu nhiên) thay vì dồn hết request vào 1
# key — chỉ có ý nghĩa THẬT SỰ từ sau khi sửa bug async chặn event loop (xem
# case_documents.py:upload_document): trước đó mọi request OCR/AI vốn đã bị serialize hết
# nên 1 key không phải nút thắt; giờ nhiều file thật sự chạy song song, dồn hết vào 1 key
# dễ dính rate-limit của riêng key đó. Các key dự phòng LLM_API_KEY_2..10 đã có sẵn trong
# .env gốc (project khác để lại, dùng cho "parallel shards") — main.py đã load_dotenv cả
# 2 file (.env.local rồi .env) nên các biến này đã có sẵn trong os.environ.
_DEEPSEEK_KEYS = [
    key
    for key in [
        os.environ["DEEPSEEK_API_KEY"],
        *(os.getenv(f"LLM_API_KEY_{i}") for i in range(2, 11)),
    ]
    if key
]
_DEEPSEEK_KEYS = list(dict.fromkeys(_DEEPSEEK_KEYS))  # bỏ trùng, giữ thứ tự

_deepseek_clients = [
    OpenAI(
        base_url=os.environ["DEEPSEEK_BASE_URL"],
        api_key=key,
        # deepseek-v4-flash là model reasoning — xem giải thích ở CORRECTION_MAX_TOKENS trong
        # classify.py. 600s để đủ dư địa cho mọi loại gọi dùng chung pool này (correction
        # 60000 token, summary 60000, classification 8000), theo ước tính ~7ms/token đã đo.
        timeout=600.0,
        max_retries=1,
    )
    for key in _DEEPSEEK_KEYS
]


def get_deepseek_client() -> OpenAI:
    return random.choice(_deepseek_clients)


# ---------------------------------------------------------------------------
# Gemini — nguồn CHÍNH (miễn phí)
# ---------------------------------------------------------------------------
# Dùng chung SDK `openai` qua endpoint OpenAI-compatible của Google thay vì cài thêm
# google-genai: cùng 1 kiểu client, cùng cách bắt lỗi như pool DeepSeek — không phải viết 2
# nhánh xử lý lỗi khác nhau. Đã xác nhận endpoint này chạy thật cho CẢ text lẫn ẢNH (vision
# qua image_url data URI), nên không cần thêm SDK riêng cho phần OCR.
GEMINI_BASE_URL = _env_str(
    "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/"
)

# CHUỖI MODEL dự phòng, KHÔNG phải 1 model duy nhất. Lý do: hạn mức miễn phí của Google tính
# RIÊNG CHO TỪNG MODEL (bảng rate-limit trong Google AI Studio có cột RPM/TPM/RPD riêng cho
# mỗi dòng model). Hết suất model này thì model kia vẫn còn nguyên — nhảy thẳng sang DeepSeek
# (trả tiền) là vứt đi phần free đó.
#
# Thứ tự + lý do, tất cả đều ĐO THẬT trên MA TRẬN đầy đủ (mọi model x mọi key), không đoán:
#   gemini-3.7-flash        ĐẶT ĐẦU: hạn mức free CAO NHẤT (15 RPM, so với 5 RPM của các bản
#                           còn lại) và vision mạnh nhất — đo thật trên trang giấy chứng nhận
#                           kết hôn nền hoa văn đỏ (trang Tesseract đọc ra rác): đọc ĐÚNG cả
#                           tên vợ chồng, 2 số CMND 183725316/183910373, số 18/2013, ngày
#                           18/02/2013, kể cả dòng chữ dọc bé ở lề. 9.0s, 1180 token @1600px.
#                           LƯU Ý: có lúc trả 503 UNAVAILABLE rồi vài phút sau chạy lại bình
#                           thường — quá tải TẠM THỜI, chính là lý do phải có chuỗi dự phòng.
#   gemini-3.6-flash        35.5s trên hồ sơ 20 tài liệu, đủ 5 phần đúng format; phân loại
#                           đúng 6/6 lần trên case khó (CCCD của mẹ). Chỉ 5 RPM nên rất dễ 429.
#   gemini-3.5-flash        41.1s trên cùng hồ sơ đó, chất lượng tương đương. Chạy được với
#                           TẤT CẢ key.
#
# ĐÃ LOẠI (theo quyết định của người dùng, hoặc do thử thật không dùng được):
#   gemini-3-flash-preview  chạy được với cả 5 key nhưng chỉ 5 RPM / 20 RPD — đóng góp ít hơn
#       hẳn 2 model lite bên dưới (15 RPM / 50 RPD), người dùng chọn bỏ cho gọn chuỗi.
#       LƯU Ý cho lần sau: dòng "Gemini 3 Flash" trên bảng rate-limit chính là model này —
#       KHÔNG hề có model tên "gemini-3-flash", đừng thêm cái tên đó vào.
#   gemini-2.5-flash        người dùng chọn bỏ. Ghi lại phát hiện quan trọng để lần sau không
#       kết luận nhầm: nó trả 404 với v1/v3/v4/v5 nhưng chạy BÌNH THƯỜNG với v2 — tức 404
#       "model không khả dụng" là giới hạn theo TỪNG PROJECT (mỗi key = 1 project Google),
#       KHÔNG phải model bị gỡ toàn cục; thông báo lỗi ghi rõ "no longer available to NEW
#       users", project cũ vẫn giữ quyền. Đây là lý do nhánh NotFoundError trong try_gemini
#       phải thử tiếp key khác chứ không được break.
#   gemini-3.1-pro-preview  429 hết hạn mức free NGAY lần gọi đầu — bản pro gần như không có
#       suất miễn phí, thêm vào chỉ tổ tốn tiền, đúng thứ cần tránh.
#   gemini-flash-latest / gemini-flash-lite-latest  là ALIAS trỏ vào model khác, dùng sẽ khiến
#       chuỗi này trùng lặp ngầm mà không biết đang gọi cái gì.
#   gemini-2.5-flash-lite   404 với MỌI key đã thử.
#
# Đọc từ .env được để còn xoay xở khi Google đổi/ngừng model — rủi ro có thật.
GEMINI_MODELS = _env_list(
    "GEMINI_MODELS", "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash"
)

# CHUỖI LITE — thử TRƯỚC chuỗi chính cho tài liệu NHỎ (1 trang / ít chữ). Không thay thế
# chuỗi chính: nếu lite cũng hết suất thì vẫn rơi xuống chuỗi chính rồi mới tới DeepSeek.
#
# Lý do có chuỗi riêng thay vì nhét chung: hạn mức free của bản lite CAO GẤP 3 (15 RPM /
# 50 RPD, so với 5 RPM / 20 RPD của các bản thường), nên dồn việc dễ sang lite là cách giữ
# hạn mức quý của bản thường cho tài liệu khó. Cả 2 model lite đều chạy được với CẢ 5 key.
#
# Chất lượng ĐÃ ĐO trên chính ảnh thật, không phải suy đoán:
#   - CCCD 1 trang (dễ): cả 2 bản lite đọc đúng số định danh, 2.4-5.4s.
#   - Giấy khai sinh nền hoa văn đỏ (trang KHÓ NHẤT trong corpus): gemini-3.5-flash-lite vẫn
#     đọc đúng cả 3 tên người (TRẦN VĂN HÙNG / PHAN THỊ HOA / TRẦN MƯỜI), ngày sinh, nơi sinh.
#     Tức lite không hề kém trên tác vụ OCR thuần.
# CHỈ dùng cho OCR + SỬA LỖI OCR (2 việc máy móc). KHÔNG dùng cho phân loại — đó là chỗ cần
# suy luận thật để biết giấy tờ của ai trong gia đình (xem docstring classify.py: tắt suy
# luận từng khớp nhầm CCCD của mẹ 3/4 lần, confidence vẫn 0.9-1.0 nên sai ÂM THẦM).
GEMINI_LITE_MODELS = _env_list(
    "GEMINI_LITE_MODELS", "gemini-3.1-flash-lite,gemini-3.5-flash-lite"
)

# Tắt suy luận phía Gemini — tương đương extra_body={"thinking":{"type":"disabled"}} của
# DeepSeek nhưng khác cách khai báo (Gemini dùng tham số chuẩn `reasoning_effort`).
# ĐÃ THỬ "none": Gemini trả 400 INVALID_ARGUMENT, không nhận. "low" thì nhận và nhanh đúng
# như mong đợi — đo trên cùng 1 input sửa OCR: mặc định 16.4s, "low" chỉ 2.1s (nhanh gấp 8).
GEMINI_LOW_REASONING = "low"

# TRẦN TOKEN ĐẦU RA cho Gemini — luôn để KỊCH TRẦN của model (65.536 theo tài liệu Google
# cho dòng 3.x flash), KHÔNG dùng con số riêng theo từng bước như phía DeepSeek.
#
# Vì sao để kịch trần: max_tokens là GIỚI HẠN TRÊN, không phải phần đặt trước — để cao không
# tốn thêm gì, nhưng để thấp thì bị cắt ngang mà API VẪN trả 200 kèm text dở (đã tái hiện:
# cùng câu hỏi, max_tokens=100 -> finish_reason="length", chữ cụt; 2000 -> bình thường).
# Với OCR, bị cắt nghĩa là MẤT NỬA CUỐI TRANG mà không báo lỗi. Dòng 3.x là model LAI CÓ SUY
# LUẬN, phần suy luận ăn chung trần này nên rủi ro cắt ngang càng cao. Thời gian chạy vẫn
# được chặn bằng timeout=600s của client, không phải bằng trần token.
#
# LƯU Ý khi chỉnh: API KHÔNG từ chối số vượt trần — thử 65537 với cả 4 model đều trả 200
# bình thường, tức nó âm thầm cắt xuống. Đừng suy ra "không lỗi = hỗ trợ".
#
# Trần này CHỈ áp cho Gemini. Phía DeepSeek vẫn giữ các con số riêng theo từng bước
# (CORRECTION/CLASSIFICATION/SUMMARY_MAX_TOKENS trong classify.py) vì chúng được hiệu chỉnh
# bằng số đo reasoning_tokens thật của DeepSeek, có ghi rõ margin — không nên đụng vào.
GEMINI_MAX_OUTPUT_TOKENS = _env_int("GEMINI_MAX_OUTPUT_TOKENS", 65536)

# Mỗi client đi kèm NHÃN key ("v1"/"v2"/"v3" theo đúng tên biến môi trường) chứ không phải
# client trần. Lý do: thứ tự thử được XÁO NGẪU NHIÊN mỗi lần gọi, nên nếu log "key thứ N"
# theo vị trí trong danh sách ĐÃ XÁO thì con số đó VÔ NGHĨA — không biết thật sự key nào
# đang gánh tải, tức không kiểm chứng được 3 key có được dùng đều hay không.
#
# Lọc key rỗng và bỏ trùng phải làm TRÊN CẶP (nhãn, key), không phải trên danh sách key rồi
# zip lại với ("v1","v2","v3"): nếu thiếu GEMINI_API_KEYv2 thì danh sách key còn [v1, v3]
# nhưng zip sẽ gán nhãn thành "v1","v2" — log chỉ sai key, truy vết hạn mức sẽ nhầm hẳn.
# Quét GEMINI_API_KEYv1..v{GEMINI_MAX_KEYS} — KHÔNG hard-code danh sách nhãn, để thêm key
# mới vào .env là chạy được ngay, không phải sửa code (đã xảy ra thật: lúc đầu cố định
# v1/v2/v3, người dùng thêm v4 thì key đó bị bỏ qua âm thầm — không lỗi, chỉ là không bao
# giờ được dùng, rất khó phát hiện). Dừng quét ở số đầu tiên không có để .env thưa (vd chỉ
# có v1 và v5) không tạo khoảng trống khó hiểu — nếu cần nhiều hơn thì đánh số liên tục.
_GEMINI_PAIRS: list[tuple[str, str]] = []
_seen_keys: set[str] = set()
for _n in range(1, _env_int("GEMINI_MAX_KEYS", 20) + 1):
    _label = f"v{_n}"
    _key = os.getenv(f"GEMINI_API_KEY{_label}")
    if not _key:
        break
    if _key not in _seen_keys:  # bỏ trùng phòng khi 2 biến trỏ cùng 1 key
        _seen_keys.add(_key)
        _GEMINI_PAIRS.append((_label, _key))

# max_retries=0 — KHÁC pool DeepSeek (để 1). Cố ý: SDK openai tự retry 429 kèm backoff
# TRƯỚC KHI ném lỗi ra (log thật: "Retrying request to /chat/completions in 0.44 seconds"),
# nên mỗi cặp (model, key) đã cạn hạn mức tốn 2 request + ~0.4s ngủ thay vì 1 request. Mà
# retry lại ĐÚNG key vừa báo hết hạn mức thì gần như chắc chắn hỏng tiếp — vòng lặp
# model x key trong try_gemini mới là cơ chế thử lại đúng nghĩa. Tắt retry của SDK để
# fallback không bị chậm gấp đôi một cách vô ích.
_gemini_clients = [
    (label, OpenAI(base_url=GEMINI_BASE_URL, api_key=key, timeout=600.0, max_retries=0))
    for label, key in _GEMINI_PAIRS
]

# ---------------------------------------------------------------------------
# Ghi nhớ chỗ đã cạn để KHÔNG dò lại — thứ quyết định tốc độ fallback
# ---------------------------------------------------------------------------
# Vấn đề đã quan sát thật: mỗi lệnh gọi duyệt lại ma trận TỪ ĐẦU, không nhớ gì. Trace
# production cho thấy cả 5 key của gemini-3.7-flash bị 429, rồi lệnh gọi NGAY SAU ĐÓ lại dò
# đúng 5 key đó và lại 429 đủ 5 lần. File 7 trang = 7 lần OCR = dò lại 7 lượt cùng một chỗ
# đã biết chắc là cạn. Đây là lý do chính khiến fallback "lâu sao sao".
#
# Cách chữa: nhớ lại trong bộ nhớ tiến trình, bỏ qua trong thời gian nghỉ.
#   - 429 -> cạn theo TỪNG CẶP (model, key), vì hạn mức tính riêng cho từng cặp.
#   - 5xx -> hỏng theo MODEL (mọi key đều gọi vào cùng model đó), nghỉ ngắn hơn vì 503 của
#     Google là quá tải TẠM THỜI (đã thấy 3.7-flash 503 rồi vài phút sau chạy lại bình thường).
# Hết thời gian nghỉ thì tự thử lại — nếu vẫn cạn thì chỉ tốn đúng 1 lượt rồi lại nghỉ tiếp,
# tự điều chỉnh, không cần biết chính xác hạn mức reset lúc nào.
#
# CỐ Ý dùng dict thường không khoá: route FastAPI dạng `def` chạy trong threadpool nên nhiều
# luồng cùng đụng vào đây, nhưng thao tác chỉ là get/set 1 khoá bất biến — dưới GIL là an
# toàn, và kể cả có ghi đè lẫn nhau thì hậu quả xấu nhất là dò thừa 1 lượt, không sai kết quả.
GEMINI_KEY_COOLDOWN_SECONDS = _env_int("GEMINI_KEY_COOLDOWN_SECONDS", 60)
GEMINI_MODEL_COOLDOWN_SECONDS = _env_int("GEMINI_MODEL_COOLDOWN_SECONDS", 30)

_key_cooldown: dict[tuple[str, str], float] = {}  # (model, nhãn key) -> thời điểm hết nghỉ
_model_cooldown: dict[str, float] = {}            # model -> thời điểm hết nghỉ

logger.info(
    "LLM: Gemini %d key(s) x %d model %s (nguồn chính) — DeepSeek %d key(s) (dự phòng).",
    len(_gemini_clients), len(GEMINI_MODELS), GEMINI_MODELS, len(_deepseek_clients),
)


def try_gemini(
    *, step: str, messages: list[dict], prefer_lite: bool = False, **extra
) -> str | None:
    """Duyệt TỪNG MODEL x TỪNG KEY cho tới khi có kết quả; None nếu hết sạch.

    Hạn mức free tính riêng theo CẢ HAI chiều (mỗi key là 1 project riêng, mỗi model có bộ
    đếm riêng trong project đó), nên chỉ khi tất cả model x key đều hết mới thật sự hết free.

    Không nhận `max_tokens`: mọi lệnh gọi Gemini đều dùng KỊCH TRẦN GEMINI_MAX_OUTPUT_TOKENS
    (xem giải thích ở đó) — nơi gọi không cần và không nên tự đặt trần thấp hơn.

    `prefer_lite=True` (tài liệu nhỏ, việc máy móc): thử chuỗi LITE trước rồi mới tới chuỗi
    chính — THÊM vào chứ không thay thế, nên trường hợp xấu nhất vẫn không mất khả năng nào,
    chỉ tốn thêm vài lượt gọi. Xem GEMINI_LITE_MODELS để biết vì sao đáng làm vậy."""
    max_tokens = GEMINI_MAX_OUTPUT_TOKENS
    chain = (GEMINI_LITE_MODELS + GEMINI_MODELS) if prefer_lite else GEMINI_MODELS
    now = time.monotonic()
    skipped = 0
    for model in chain:
        if _model_cooldown.get(model, 0.0) > now:
            skipped += len(_gemini_clients)
            continue
        # Xáo ngẫu nhiên thứ tự key để tải rải đều thay vì luôn dồn vào key đầu tiên — cùng
        # cách đã dùng cho pool DeepSeek (get_deepseek_client).
        for label, client in random.sample(_gemini_clients, len(_gemini_clients)):
            if _key_cooldown.get((model, label), 0.0) > now:
                skipped += 1
                continue
            try:
                completion = client.chat.completions.create(
                    model=model, max_tokens=max_tokens, messages=messages, **extra
                )
                choice = completion.choices[0]
                content = choice.message.content
                if content and content.strip():
                    if choice.finish_reason == "length":
                        # BỊ CẮT NGANG vì hết max_tokens — API vẫn trả 200 kèm phần text dở,
                        # nên nếu không kiểm tra ở đây thì nội dung THIẾU sẽ được lưu vào DB
                        # y như nội dung đủ, không ai biết. Đúng loại lỗi âm thầm đã gặp 3 lần
                        # với DeepSeek (xem lịch sử nâng CORRECTION_MAX_TOKENS trong
                        # classify.py). Vẫn trả phần đọc được (thiếu còn hơn không có gì, và
                        # nguồn kế tiếp cũng sẽ bị cắt y hệt vì cùng max_tokens), nhưng phải
                        # kêu to để còn biết đường nâng trần.
                        logger.warning(
                            "%s: Gemini %s key %s BỊ CẮT NGANG do chạm trần %d token — "
                            "nội dung trả về THIẾU, cân nhắc nâng max_tokens cho bước này.",
                            step, model, label, max_tokens,
                        )
                    else:
                        logger.info("%s: Gemini %s, key %s.%s", step, model, label,
                                    f" (bỏ qua {skipped} chỗ đang nghỉ)" if skipped else "")
                    # Gọi được nghĩa là chỗ này đã hồi — xoá dấu nghỉ để lần sau không bỏ qua
                    # oan (vd cooldown đặt lúc 429 nhưng hạn mức đã reset sớm hơn dự kiến).
                    _key_cooldown.pop((model, label), None)
                    _model_cooldown.pop(model, None)
                    return content.strip()
                # Rỗng hoàn toàn: hay gặp nhất là trần token quá thấp tới mức model dùng hết
                # sạch vào phần suy luận, chưa kịp sinh chữ nào (đã tái hiện được: cùng 1 câu
                # hỏi, max_tokens=100 -> finish=length content rỗng/dở, max_tokens=2000 -> OK).
                logger.warning(
                    "%s: Gemini %s key %s trả rỗng (finish=%s, trần %d token) — thử tiếp.",
                    step, model, label, choice.finish_reason, max_tokens,
                )
            except RateLimitError:
                # 429 = hết hạn mức của RIÊNG cặp (key này, model này). Đây là lối đi THƯỜNG
                # GẶP chứ không phải sự cố nên log mức info. Hạn mức thật: 5 request/phút với
                # gemini-3.6-flash, 15 với gemini-3.7-flash — rất dễ chạm khi upload nhiều
                # file cùng lúc, nên nhiều model x nhiều key mới là thứ giữ cho pipeline
                # không tụt hết về DeepSeek.
                _key_cooldown[(model, label)] = now + GEMINI_KEY_COOLDOWN_SECONDS
                logger.info("%s: Gemini %s key %s hết hạn mức (429) — nghỉ %ds, thử tiếp.",
                            step, model, label, GEMINI_KEY_COOLDOWN_SECONDS)
            except AuthenticationError:
                # Key sai/bị thu hồi — lỗi của RIÊNG key này. Phải bắt TRƯỚC APIStatusError vì
                # AuthenticationError là lớp con của nó, nếu không sẽ rơi vào nhánh "break"
                # bên dưới và bỏ oan các key còn lại vốn vẫn dùng được.
                logger.warning("%s: Gemini key %s không hợp lệ — thử key tiếp theo.", step, label)
            except NotFoundError:
                # 404 "model không khả dụng" là chuyện của RIÊNG PROJECT (mỗi key = 1 project
                # Google riêng), KHÔNG phải model bị gỡ toàn cục — đo thật: gemini-2.5-flash
                # trả 404 với v1/v3/v4/v5 nhưng chạy BÌNH THƯỜNG với v2 (project cũ, được giữ
                # quyền dùng; thông báo lỗi ghi rõ "no longer available to NEW users").
                # Vì vậy phải thử tiếp key khác, KHÔNG được break như nhánh 5xx bên dưới —
                # break ở đây sẽ bỏ sót đúng key duy nhất còn dùng được. Cũng phải bắt TRƯỚC
                # APIStatusError vì NotFoundError là lớp con.
                logger.info("%s: Gemini %s không khả dụng với key %s (404) — thử key tiếp theo.",
                            step, model, label)
            except APIStatusError as e:
                # Lỗi phía MODEL, không phải phía key: 503 lúc model quá tải (đã gặp thật với
                # gemini-3.7-flash — 503 rồi sau đó chạy bình thường), hay 404 khi Google
                # ngừng model. Đổi key vô ích vì key nào cũng gọi vào đúng model đó, nên bỏ
                # các key còn lại và sang MODEL kế tiếp trong chuỗi.
                _model_cooldown[model] = now + GEMINI_MODEL_COOLDOWN_SECONDS
                logger.warning("%s: Gemini %s lỗi phía model (mã %s) — nghỉ %ds, sang model kế tiếp.",
                               step, model, e.status_code, GEMINI_MODEL_COOLDOWN_SECONDS)
                break
            except Exception as e:  # noqa: BLE001
                # Timeout/mất mạng: có thể do riêng lần gọi này, thử nốt các key còn lại.
                logger.warning("%s: Gemini %s key %s lỗi (%s) — thử tiếp.",
                               step, model, label, type(e).__name__)
    return None


def complete_with_fallback(
    *,
    step: str,
    messages: list[dict],
    deepseek_max_tokens: int,
    response_format: dict | None = None,
    gemini_reasoning_effort: str | None = None,
    deepseek_extra_body: dict | None = None,
    prefer_lite: bool = False,
) -> str | None:
    """Gọi LLM văn bản: GEMINI trước, hết sạch mới sang DEEPSEEK. Trả về nội dung, hoặc None
    nếu nguồn cuối trả rỗng.

    `deepseek_max_tokens` CHỈ áp cho nhánh DeepSeek — đặt tên rõ như vậy để không ai tưởng
    nó cũng giới hạn Gemini: phía Gemini luôn chạy kịch trần GEMINI_MAX_OUTPUT_TOKENS. Các
    con số của DeepSeek được hiệu chỉnh riêng bằng số đo reasoning_tokens thật (xem
    classify.py), không dùng chung được.

    CỐ Ý để lỗi của DeepSeek (nguồn cuối) NÉM RA NGOÀI thay vì nuốt: nơi gọi vốn đã có sẵn
    except riêng để dịch lỗi sang tiếng Việt cho nhân viên (describe_error) và để quyết định
    fallback riêng của từng bước — giữ nguyên hành vi đó."""
    gemini_extra: dict = {}
    if response_format:
        gemini_extra["response_format"] = response_format
    if gemini_reasoning_effort:
        gemini_extra["reasoning_effort"] = gemini_reasoning_effort

    content = try_gemini(
        step=step, messages=messages, prefer_lite=prefer_lite, **gemini_extra
    )
    if content:
        return content

    deepseek_extra: dict = {}
    if response_format:
        deepseek_extra["response_format"] = response_format
    if deepseek_extra_body:
        deepseek_extra["extra_body"] = deepseek_extra_body

    completion = get_deepseek_client().chat.completions.create(
        model=os.environ["DEEPSEEK_MODEL"],
        max_tokens=deepseek_max_tokens,
        messages=messages,
        **deepseek_extra,
    )
    logger.info("%s: dùng DeepSeek (đã hết lượt Gemini).", step)
    result = completion.choices[0].message.content
    return result.strip() if result else None
