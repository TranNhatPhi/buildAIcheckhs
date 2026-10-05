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

import base64
import io
import logging
import os
import re
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, as_completed, wait

import cv2
import fitz  # PyMuPDF
import numpy as np
import pytesseract
from pytesseract import Output
from PIL import Image, ImageDraw, ImageFont

import llm
import paddle_ocr_vl
import storage

logger = logging.getLogger("ocr")

PDF_RENDER_DPI = 300
# Từng để 200 — THẤP HƠN chuẩn khuyến nghị ngành cho OCR (300). Xác nhận bằng thực nghiệm
# trên 1 trang khó thật (Giấy khai sinh có watermark bản đồ dày đặc chồng lên chữ): cùng 1
# trang, cùng tiền xử lý, chỉ đổi DPI — 200 DPI đọc được 293 ký tự, 300 DPI đọc được 556 ký
# tự (gần gấp đôi), 400 DPI đọc được 952 ký tự. Chọn 300 (không phải 400) làm điểm cân bằng:
# đã đạt chuẩn khuyến nghị, cải thiện rõ rệt, mà ảnh chỉ to hơn ~2.25 lần (thay vì ~4 lần ở
# 400 DPI) — đỡ tốn CPU/thời gian xử lý hơn, quan trọng vì VM còn phải chia tải cho nhiều
# việc khác (MySQL, MinIO, nhiều request OCR chạy song song).
#
# ĐÃ THỬ "vie+eng" (dùng đồng thời 2 gói ngôn ngữ) để đọc tốt hơn nhãn song ngữ Việt/Anh
# trên CCCD ("Họ và tên / Full name") và CV thuần tiếng Anh — THẤT BẠI: xác nhận bằng A/B
# test có kiểm soát (cùng 1 ảnh, cùng tiền xử lý, chỉ đổi lang) là "vie+eng" làm MẤT DẤU
# tiếng Việt trên nhiều từ, kể cả trên chính TÊN NGƯỜI ("PHẠM VĂN HOÀNG" → "PHAM VĂN
# HOANG") — cái giá quá đắt cho việc chỉ sửa được vài chữ tiếng Anh phụ ("OP"→"OF"). Mất
# dấu trên tên thật trong giấy tờ pháp lý nghiêm trọng hơn nhiều so với lợi ích. Đa số tài
# liệu trong hệ thống là giấy tờ tiếng Việt nên giữ "vie" làm mặc định.
TESSERACT_LANG = os.getenv("TESSERACT_LANG", "vie")
TESSERACT_PSM = os.getenv("TESSERACT_PSM", "4")
# Trước đây KHÔNG đặt timeout cho Tesseract — nếu subprocess treo (ảnh lỗi/quá khổ, hiếm
# nhưng đã xảy ra), thread xử lý đợi VÔ THỜI HẠN: document đứng vĩnh viễn ở OCR_RUNNING,
# không tự thoát, không báo lỗi, không cách nào tự phục hồi ngoài can thiệp tay (xem sự cố
# production — nhiều tài liệu kẹt OCR_RUNNING không rõ nguyên nhân). 90s cho 1 ảnh là rất
# rộng rãi (OCR 1 trang bình thường chỉ vài giây) — đủ dư địa cho ảnh nặng/máy đang tải cao,
# nhưng vẫn đảm bảo LUÔN thoát ra được thay vì treo mãi.
TESSERACT_TIMEOUT_SECONDS = int(os.getenv("TESSERACT_TIMEOUT_SECONDS", "90"))

# Số tiến trình Tesseract được chạy CÙNG LÚC trong 1 tiến trình backend.
#
# VÌ SAO CẦN GIỚI HẠN — sự cố thật ("19. Phan Huy Di Dan - Certificate of employment.pdf"
# báo "xử lý quá 90s không xong"): ĐO LẠI CHÍNH FILE ĐÓ trên máy dev, mỗi lần gọi Tesseract
# chỉ mất 1.1-1.8s, cả 5 trang x 5 biến thể chỉ ~38s. Tức ảnh KHÔNG hề "lỗi hoặc quá khổ"
# như thông báo lỗi cũ đoán — nó chậm gấp >60 lần trên production vì TRANH CPU:
#   - UploadDropzone gửi 4 file song song (MAX_CONCURRENT=4);
#   - route upload là `def` thường nên FastAPI ném vào threadpool (mặc định 40 luồng) —
#     không có gì xếp hàng lại;
#   - khi Gemini hết hạn mức (429), CẢ 4 file cùng rơi xuống Tesseract, mỗi trang lại chạy
#     5 biến thể (_preprocess_variants);
#   - backend chạy NHIỀU REPLICA sau load balancer trên cùng 1 máy (production 2, dev 3).
# Tesseract là việc NGỐN CPU THẬT (khác hẳn phần gọi Gemini vốn chỉ chờ mạng — xem chỗ chạy
# song song trong extract_text). Nhồi hàng chục tiến trình Tesseract vào vài vCPU không làm
# xong nhanh hơn, chỉ khiến MỌI lần gọi đều chậm đến mức chạm timeout rồi hỏng cả loạt.
# Xếp hàng lại thì mỗi lần gọi chạy gần đúng tốc độ thật của nó, tổng thời gian NGẮN HƠN.
#
# Chia cho SỐ REPLICA backend dùng chung host: mỗi container đều thấy đủ số CPU của host
# (cgroup không giới hạn CPU trong compose hiện tại) — không chia thì tổng số tiến trình
# Tesseract chạy cùng lúc bằng số replica NHÂN số nhân, đúng lại cái bẫy vừa nói.
#
# Trước đây chia cứng cho 2 vì production có đúng 2 replica. Phải khai ra thành biến vì thêm
# replica mà quên chỗ này là âm thầm phá vỡ giới hạn: 3 replica trên máy 72 nhân sẽ thành 108
# tiến trình Tesseract tranh nhau 72 nhân. Đặt BACKEND_REPLICAS đúng bằng số backend trong
# compose (xem docker-compose.yml), hoặc khai thẳng TESSERACT_MAX_WORKERS để chốt cứng.
BACKEND_REPLICAS = max(1, int(os.getenv("BACKEND_REPLICAS", "2") or 2))
TESSERACT_MAX_WORKERS = int(os.getenv("TESSERACT_MAX_WORKERS", "0") or 0) or max(
    1, (os.cpu_count() or 2) // BACKEND_REPLICAS
)
_tesseract_slots = threading.BoundedSemaphore(TESSERACT_MAX_WORKERS)

# Mỗi tiến trình Tesseract mặc định tự bung OpenMP ra NHIỀU luồng. Chạy 1 tiến trình thì có
# lợi, nhưng app này luôn chạy NHIỀU tiến trình cùng lúc (các trang + các biến thể song song,
# cộng nhiều file upload một lượt) — khi đó các luồng OpenMP của mỗi tiến trình giành CPU của
# nhau. Đo trên máy dev 72 luồng, kết quả OCR y hệt nhau giữa 2 cách:
#   3 PDF x 8 trang cùng lúc: mặc định 47.5s -> OMP_THREAD_LIMIT=1 39.4s
#   6 ảnh cùng lúc:           mặc định  8.8s -> OMP_THREAD_LIMIT=1  7.0s
#   1 ảnh ĐƠN LẺ:             mặc định  2.3s -> OMP_THREAD_LIMIT=1  3.3s (chỉ ca này chậm hơn)
# setdefault: ai đặt sẵn biến này trong môi trường thì vẫn theo người đó. Đặt lúc import là đủ
# vì chỉ tiến trình CON (tesseract) đọc biến này, lúc nó được sinh ra.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

# Trần thời gian cho TOÀN BỘ 1 trang ở đường Tesseract (chạy nhiều biến thể, xem
# _ocr_single_image_lines_best_of). Riêng TESSERACT_TIMEOUT_SECONDS chỉ chặn TỪNG lần gọi,
# nên trang xấu vẫn có thể ngốn 5 x 90s = 450s mà cuối cùng chẳng đọc được gì. Hết ngân sách
# thì bỏ các biến thể còn lại và dùng kết quả tốt nhất đã đọc được — thà có kết quả gần đúng
# còn hơn để người dùng chờ mãi rồi nhận về lỗi.
TESSERACT_PAGE_BUDGET_SECONDS = int(os.getenv("TESSERACT_PAGE_BUDGET_SECONDS", "150"))

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
    # Ghi cả số slot chạy song song: khi production báo "đọc tài liệu quá lâu", đây là con số
    # đầu tiên cần xem (xem giải thích ở TESSERACT_MAX_WORKERS).
    logger.info(
        "Tesseract OCR sẵn sàng (lang=%s, psm=%s, tối đa %d tiến trình song song, "
        "timeout %ds/lần, ngân sách %ds/trang).",
        TESSERACT_LANG, TESSERACT_PSM, TESSERACT_MAX_WORKERS,
        TESSERACT_TIMEOUT_SECONDS, TESSERACT_PAGE_BUDGET_SECONDS,
    )


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


def _upscale_and_deskew(gray: np.ndarray) -> np.ndarray:
    """Phóng to nếu ảnh nhỏ + chỉnh nghiêng — luôn có lợi bất kể cách chuyển ảnh 1 kênh nào
    được dùng trước đó (xám thường hay khử màu, xem _base_gray_deskewed / _colour_dropout)."""
    h, w = gray.shape
    min_dim = min(h, w)
    if min_dim < UPSCALE_MIN_DIM_PX:
        scale = UPSCALE_MIN_DIM_PX / min_dim
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

    return _deskew(gray)


def _base_gray_deskewed(pil_img: Image.Image) -> np.ndarray:
    """Phần tiền xử lý DÙNG CHUNG cho mọi biến thể bên dưới: chuyển xám, phóng to nếu ảnh
    nhỏ, chỉnh nghiêng — các bước này luôn có lợi bất kể cách xử lý tương phản/nhiễu sau
    đó. Trả về ndarray xám (không phải PIL Image) để các variant xử lý tiếp cho nhanh,
    khỏi phải deskew lại nhiều lần."""
    gray = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2GRAY)
    return _upscale_and_deskew(gray)


def _colour_dropout(pil_img: Image.Image) -> np.ndarray:
    """Khử MÀU thay vì chuyển xám: lấy max(R,G,B) từng pixel — mọi thứ có MÀU BÃO HOÀ (hoa
    văn bảo an đỏ, chữ in đỏ, con dấu đỏ/xanh) bị đẩy về gần trắng, còn mực ĐEN TRUNG TÍNH
    (chữ đánh máy, chữ in nhãn) giữ nguyên độ đậm. Đây chính là kỹ thuật "colour dropout"
    máy scan form vẫn dùng để bỏ phần in sẵn của biểu mẫu.

    LÝ DO THÊM — đo thật trên giấy chứng nhận kết hôn ("6. Trần Văn Hùng - ĐKKH.pdf"), loại
    giấy in kín nền hoa văn trống đồng màu đỏ. Giá trị pixel đo được trên trang đó:

        vùng             chuyển xám    max(R,G,B)
        chữ đánh máy         73            76
        chữ in nhãn          69            76
        hoa văn nền         106           127
        tiêu đề đỏ          133           238  (mất hẳn)

    Chuyển xám thường đặt hoa văn nền (106) LỌT GIỮA chữ thật (69-73) và tiêu đề (133), rồi
    CLAHE ở biến thể "default" kéo hoa văn lên ngang chữ thật — Tesseract đọc ra rác thuần
    tuý ("= = =ô =>3⁄@G@*% Ô"). Đây là cùng cơ chế đã ghi ở docstring _preprocess_variants
    với watermark giấy khai sinh, nhưng nặng hơn hẳn vì hoa văn phủ KÍN trang chứ không chỉ
    chìm ở giữa. Khử màu tách được vì hoa văn đỏ bão hoà còn chữ thì không.

    Cái mất: dòng tiêu đề in màu đỏ (vd "GIẤY CHỨNG NHẬN KẾT HÔN") biến mất theo. Chấp nhận
    được vì đây chỉ là 1 trong nhiều biến thể — best-of chỉ chọn nó khi nó đọc được NHIỀU
    HƠN hẳn, tức đúng những trang mà cách cũ vốn không đọc nổi gì."""
    rgb = np.array(pil_img.convert("RGB"))
    return _upscale_and_deskew(np.max(rgb, axis=2).astype(np.uint8))


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
    nhanh).

    Từng CHỈ giữ 2 biến thể (trước đây 4) — đo thực nghiệm trên 52 trang tài liệu thật (mọi
    PDF đang có trong DB): "default" thắng 25/52, "binary" thắng 23/52 (tổng 92%),
    "no_denoise" chỉ 4/52, "strong_contrast" thắng ĐÚNG 0/52 lần — bỏ 2 biến thể gần như vô
    dụng đó để giảm ~1 nửa thời gian OCR "Phân tích lại" mà không mất tín hiệu thật.

    ĐÃ THÊM LẠI biến thể thứ 3 "plain" (gray thô sau deskew, KHÔNG denoise, KHÔNG CLAHE) —
    đo lại trên 218 trang / 86 tài liệu thật: "plain" thắng 88/218 trang (40%, nhiều nhất
    trong 3), tổng ký tự đọc được +4.5%, và quan trọng nhất là CỨU 4 trang mà cả 2 biến thể
    cũ đều ra ĐÚNG 0 ký tự — trong đó có 1 CCCD ("2. Phan Huy Di Dan - ID Card.pdf") mà hệ
    thống trước đây đọc ra HOÀN TOÀN RỖNG cả 2 trang, giờ đọc đúng cả họ tên lẫn số định
    danh. Đã kiểm tra tận nội dung (không chỉ đếm ký tự) để chắc chắn phần tăng thêm là chữ
    thật chứ không phải nhiễu thắng oan tiêu chí "nhiều ký tự nhất".

    Lưu ý "plain" KHÁC "no_denoise" đã bị loại trước đây: "no_denoise" vẫn có CLAHE, còn
    "plain" bỏ luôn CLAHE. Đó chính là điểm mấu chốt — CLAHE (tăng tương phản cục bộ) khuếch
    đại watermark nhạt màu (hoa văn/bản đồ chìm trên giấy khai sinh, CCCD) lên ngang mức chữ
    thật, khiến Tesseract dò ra vùng chữ nhưng không đọc nổi ký tự nào (xác nhận: 81 vùng dò
    được, 0 ký tự đọc được). Giữ CLAHE cho ảnh scan mờ/thiếu sáng (vẫn thắng 67/218), thêm
    "plain" cho ảnh có watermark — best-of tự chọn đúng cách cho từng ảnh, không phải đánh
    đổi nhóm này lấy nhóm kia.

    Biến thể thứ 4 "denoise_only" (khử nhiễu, KHÔNG CLAHE) thêm theo yêu cầu chạy đủ 4 lượt.
    Đo trên cùng 218 trang đó, so với bộ 3 ở trên: mức bù thêm KHIÊM TỐN hơn hẳn — +1947 ký
    tự (+1.1%, so với +4.5% khi thêm "plain"), thắng 71/218 trang nhưng CỨU 0 trang rỗng
    (không trang nào cần tới nó mới đọc được chữ). Đã đo cả 3 ứng viên khác cho suất này:
    "otsu" (nhị phân toàn cục) +0.4%, "no_denoise" +0.3%, "strong_contrast" +0.2% — tức 2
    biến thể từng bị loại đúng là không đáng quay lại, quyết định loại chúng trước đây chính
    xác. Nếu cần giảm tải VM, đây là biến thể NÊN BỎ TRƯỚC (bỏ 1 dòng, mất 1.1% ký tự, không
    mất trang nào).

    Biến thể thứ 5 "dropout" (khử MÀU thay vì chuyển xám — xem _colour_dropout) thêm sau khi
    gặp loại giấy mà CẢ 4 biến thể trên đều bó tay: giấy in kín nền hoa văn bảo an MÀU ĐỎ
    (chứng nhận kết hôn, giấy khai sinh bản gốc). Cả 4 biến thể trên đều bắt đầu từ cùng 1
    ảnh xám, mà chính bước chuyển xám đã trộn hoa văn đỏ lẫn vào chữ — nên thêm biến thể nào
    dựa trên `gray` cũng vô ích, phải đổi cách tách ngay từ đầu.

    Đo trên toàn bộ 222 trang / 88 tài liệu thật trong DB: tổng ký tự +2.0%, thắng 52/222
    trang. Con số tổng khiêm tốn nhưng KHÔNG phản ánh giá trị thật — nó cứu đúng loại giấy
    mà trước đây gần như không đọc nổi chữ nào (2 trang duy nhất trong cả corpus tăng >1.5
    lần đều nhờ biến thể này, và cả 2 đều là giấy nền hoa văn đỏ):
    - "5. Trần Văn Hùng - GKS (Bản gốc).pdf" trang 1: 22 -> 988 ký tự, từ chỗ chỉ ra được
      mỗi "là an Lộc, tỉnh Hà Tĩnh" thành đọc đủ họ tên, ngày sinh (cả số lẫn chữ), nơi
      sinh, quê quán, họ tên + năm sinh cha mẹ, và số CCCD người đi khai sinh.
    - "6. Trần Văn Hùng - ĐKKH.pdf" trang 2: 526 ký tự RÁC -> 819 ký tự đọc được (họ tên vợ
      chồng, quốc tịch, tỉnh, số CMND, nơi đăng ký).
    - "30. Trần An Phước - GKS (Bản gốc).pdf" trang 1: 944 -> 1014, phần thêm chính là dòng
      "Số định danh cá nhân: 042217009487" mà biến thể cũ bỏ sót hoàn toàn.
    Đã đọc tận nội dung từng trang "dropout" thắng (không chỉ đếm ký tự) để chắc chắn không
    có trang nào thắng oan bằng nhiễu.

    ĐÃ THỬ VÀ LOẠI "dropout_clahe" (khử màu rồi CLAHE): chỉ +0.8% tổng, và tệ hơn là trên
    trang 2 của GKS Trần An Phước nó thắng với 1085 ký tự RÁC thuần tuý trong khi "dropout"
    thuần chỉ ra 72 ký tự nhưng là chữ thật — tức thêm nó vào sẽ làm HỎNG tiêu chí best-of
    ("nhiều ký tự nhất") ở đúng những trang khó. Đây là cùng cái bẫy CLAHE + hoa văn nền đã
    nói ở trên, chỉ đổi cách vào.

    Cái giá tổng cộng: mỗi trang chạy Tesseract 5 lần thay vì 2 — chậm ~2.5 lần so với trước.
    Áp lên CẢ lần upload PDF đầu tiên (case_documents.py dùng try_harder=True cho PDF), không
    chỉ nút "Phân tích lại"."""
    if not PREPROCESS_ENABLED:
        base = pil_img.convert("RGB")
        return {"raw": base}

    gray = _base_gray_deskewed(pil_img)
    variants: dict[str, Image.Image] = {}

    # default: giống hệt _preprocess() — khử nhiễu nhẹ + tăng tương phản vừa phải.
    denoised = cv2.fastNlMeansDenoising(gray, h=7, templateWindowSize=7, searchWindowSize=21)
    variants["default"] = _to_rgb_image(cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(denoised))

    # binary: nhị phân hoá thích ứng (adaptive threshold) — thường cho kết quả rất tốt với
    # chữ in rõ nét trên nền tương đối đồng đều (giấy khai sinh, bằng cấp scan phẳng), dù
    # có thể hỏng ảnh có watermark/hoạ tiết nền phức tạp (CCCD).
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15
    )
    variants["binary"] = _to_rgb_image(binary)

    # plain: gray thô sau deskew, không đụng gì thêm — dành cho ảnh có watermark/hoa văn nền
    # nhạt màu, nơi chính việc "tăng cường" ảnh ở 2 biến thể trên lại làm nền nổi lên ngang
    # chữ thật (xem đo đạc chi tiết ở docstring).
    variants["plain"] = _to_rgb_image(gray)

    # denoise_only: khử nhiễu nhưng KHÔNG CLAHE — nằm giữa "default" và "plain", hợp với ảnh
    # vừa có nhiễu hạt (scan cũ) vừa có nền hoa văn không chịu được CLAHE.
    # Dùng lại `denoised` ở trên thay vì khử nhiễu lần 2: cùng hàm, cùng tham số, cùng ảnh ->
    # kết quả y hệt. Trước đây gọi lại lần nữa — fastNlMeansDenoising là bước NẶNG NHẤT của cả
    # phần tiền xử lý (đo: 0.93s/lần với 72 luồng, ~6.5s/lần khi 1 luồng; mọi bước khác cộng
    # lại chưa tới 0.4s), nên lần gọi thừa này chiếm gần nửa thời gian tiền xử lý mỗi trang.
    variants["denoise_only"] = _to_rgb_image(denoised)

    # dropout: KHÔNG dùng `gray` chung ở trên — tự chuyển ảnh 1 kênh theo kiểu khử màu, dành
    # riêng cho giấy in nền hoa văn bảo an màu (chứng nhận kết hôn, giấy khai sinh bản gốc).
    # Xem _colour_dropout() để biết vì sao 4 biến thể trên đều bó tay với loại giấy này.
    variants["dropout"] = _to_rgb_image(_colour_dropout(pil_img))

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
    chạy Tesseract nhiều lần). Dùng cho PDF lúc upload và cho "Phân tích lại".

    Các biến thể chạy SONG SONG chứ không nối đuôi: số tiến trình Tesseract chạy thật đã bị
    chặn chung bằng _tesseract_slots, nên đẩy cả 5 biến thể một lúc không làm quá tải máy,
    chỉ để chúng xếp hàng vào đúng số slot còn trống. Đo trên máy dev 72 luồng với PDF 8 trang
    giấy tờ thật: nối đuôi 116.8s, song song (cùng song song hoá các trang ở extract_text) —
    xem số đo ở ghi chú TESSERACT_PARALLEL trong extract_text.

    MỘT biến thể hỏng/quá giờ KHÔNG làm hỏng cả trang: các biến thể còn lại vẫn đọc ra chữ
    thật, mà trước đây lỗi đầu tiên văng thẳng lên trên khiến CẢ TÀI LIỆU về ERROR với 0 ký
    tự — đúng kịch bản đã xảy ra thật trên production. Chỉ báo lỗi khi KHÔNG biến thể nào
    chạy nổi. Cả trang cũng có trần thời gian chung (TESSERACT_PAGE_BUDGET_SECONDS)."""
    variants = _preprocess_variants(img)
    deadline = time.monotonic() + TESSERACT_PAGE_BUDGET_SECONDS

    def run(item):
        name, processed = item
        # Chặn theo CẢ HAI: trần của từng lần gọi, và phần ngân sách trang còn lại. Tối thiểu
        # 10s để biến thể nào cũng có cơ hội chạy xong thay vì bị cắt ngay khi vừa bắt đầu.
        remaining = max(10, int(deadline - time.monotonic()))
        return name, _lines_from_preprocessed(
            processed, timeout=min(TESSERACT_TIMEOUT_SECONDS, remaining)
        )

    results: list[tuple[str, list[OcrLine]]] = []
    last_error: Exception | None = None

    def collect(finished) -> None:
        nonlocal last_error
        for fut in finished:
            try:
                results.append(fut.result())
            except ValueError as e:
                last_error = e
                logger.warning("Một biến thể không đọc được (%s) — dùng các biến thể khác.", e)

    pool = ThreadPoolExecutor(max_workers=len(variants))
    try:
        futures = [pool.submit(run, item) for item in variants.items()]
        done, pending = wait(futures, timeout=max(0.0, deadline - time.monotonic()))
        collect(done)
        # Hết ngân sách mà CHƯA có biến thể nào xong (máy đang quá tải, cả 5 còn xếp hàng chờ
        # slot) thì vẫn chờ tới khi có một cái xong — bản nối đuôi cũ luôn chạy trọn ít nhất
        # một biến thể, không được đổi thành "trả về trang rỗng" chỉ vì chuyển sang song song.
        while not results and pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            collect(done)
        if pending:
            logger.warning(
                "Hết ngân sách %ds cho 1 trang — dùng %d/%d biến thể đã xong, bỏ phần còn lại.",
                TESSERACT_PAGE_BUDGET_SECONDS, len(results), len(variants),
            )
    finally:
        # Không chờ biến thể bị bỏ: chúng tự dừng theo timeout riêng của từng lần gọi Tesseract.
        pool.shutdown(wait=False, cancel_futures=True)

    if not results:
        # Không biến thể nào chạy nổi — giờ mới thật sự là lỗi của trang này.
        raise last_error or ValueError("Không đọc được nội dung trang tài liệu.")

    # Hoà số ký tự thì lấy biến thể ĐỨNG TRƯỚC trong _preprocess_variants — đúng như bản chạy
    # nối đuôi cũ (so `>` nên giữ cái gặp trước). Không có khoá phụ này thì max() chọn theo
    # thứ tự CHẠY XONG, vốn đổi mỗi lần: đã bắt được thật — cùng 1 PDF chạy 2 lần ra 2 văn
    # bản khác nhau (cùng 7196 ký tự, khác nội dung).
    order = {name: i for i, name in enumerate(variants)}
    best_name, best_lines = max(
        results, key=lambda r: (sum(len(l.text) for l in r[1]), -order[r[0]])
    )
    best_len = sum(len(l.text) for l in best_lines)
    ran = len(results)

    logger.info(
        "Best-of preprocessing: chọn '%s' (%d ký tự) trong %d/%d phương án chạy được.",
        best_name, best_len, ran, len(variants),
    )
    return best_lines


def _lines_from_preprocessed(
    processed: Image.Image, timeout: int | None = None
) -> list[OcrLine]:
    load_models()

    limit = max(1, timeout if timeout is not None else TESSERACT_TIMEOUT_SECONDS)

    try:
        # CỐ Ý xếp hàng NGOÀI lời gọi chứ không tính thời gian chờ vào `timeout`: `timeout`
        # của pytesseract chỉ đo tiến trình con, nên thời gian nằm chờ tới lượt không bao giờ
        # bị tính là "xử lý quá lâu" — nếu không tách, chính cơ chế xếp hàng này sẽ tự gây ra
        # timeout giả mỗi khi có nhiều file cùng lúc (xem TESSERACT_MAX_WORKERS).
        with _tesseract_slots:
            data = pytesseract.image_to_data(
                processed,
                lang=TESSERACT_LANG,
                config=f"--psm {TESSERACT_PSM}",
                output_type=Output.DICT,
                timeout=limit,
            )
    except RuntimeError as e:
        # pytesseract chỉ raise RuntimeError THUẦN (không phải TesseractError/
        # TesseractNotFoundError) đúng lúc subprocess bị timeout — đã tự kill process con
        # (xem pytesseract.pytesseract.timeout_manager), không để lại tiến trình treo trên
        # máy. Đổi thành ValueError để đi đúng đường lỗi đã có sẵn (extract_text → status=
        # ERROR, xem case_documents.py/documents.py), thay vì văng lỗi 500 không rõ nguyên
        # nhân và để document đứng mãi ở OCR_RUNNING.
        #
        # Thông báo KHÔNG nhắc tên công cụ nội bộ và KHÔNG đoán "ảnh lỗi hoặc quá khổ": lần
        # sự cố thật đầu tiên đã chứng minh phỏng đoán đó SAI (file hoàn toàn bình thường,
        # đọc mất 1.5s/lần trên máy rảnh — xem TESSERACT_MAX_WORKERS), làm người dùng đi mở
        # lại file gốc kiểm tra vô ích trong khi nguyên nhân thật là máy đang quá tải.
        raise ValueError(
            f"Đọc tài liệu quá {limit}s chưa xong nên đã dừng lại — thường do máy chủ đang "
            "xử lý quá nhiều file cùng lúc. Bấm \"Thử lại\" sau ít phút."
        ) from e

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
    gần sát nội dung — chỉ áp dụng cho trang PDF render ra.

    XÁC NHẬN BẰNG SỰ CỐ THẬT (3 tài liệu production treo Tesseract vô hạn — trước khi có
    timeout ở _lines_from_preprocessed): 1 số trang PDF render ra có 1 ĐƯỜNG VIỀN ĐEN MỎNG
    1px chạy sát mép ngoài cùng (artifact từ máy scan/PDF gốc, KHÔNG phải nội dung thật) —
    mật độ mực của viền này gần như 100% suốt chiều dài, trong khi nội dung thật (CCCD/vân
    tay/MRZ) chỉ ~13-15%. Ngưỡng tương đối bên dưới (15% so với đỉnh) bị chính viền 1px này
    kéo đỉnh lên 100%, khiến nội dung thật (chỉ ~15%) rơi NGAY DƯỚI ngưỡng — thuật toán tưởng
    nhầm viền 1px là toàn bộ nội dung, cắt ảnh xuống còn 9-12px bề ngang. Ảnh dị dạng gần như
    1 chiều đó khiến Tesseract xử lý cực chậm/treo vô hạn. Bỏ qua 1 viền nhỏ ngoài cùng TRƯỚC
    khi tính mật độ để loại artifact này mà không ảnh hưởng tới việc dò nội dung thật (nội
    dung thật không bao giờ nằm sát tuyệt đối mép ảnh — luôn còn padding_ratio bù lại sau)."""
    gray = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2GRAY)
    h, w = gray.shape

    # Downsample để tính mật độ nhanh và ổn định hơn (giảm ảnh hưởng nhiễu từng điểm ảnh lẻ).
    small_w = 200
    small = cv2.resize(gray, (small_w, max(1, int(small_w * h / w))), interpolation=cv2.INTER_AREA)

    # Bỏ viền ngoài cùng của ảnh downsample trước khi tính mật độ — xem giải thích artifact
    # viền 1px ở docstring. Chỉ trim khi ảnh đủ lớn để còn phần thật đáng kể sau khi bỏ viền.
    edge_margin = 3
    if small.shape[0] > 4 * edge_margin and small.shape[1] > 4 * edge_margin:
        trimmed = small[edge_margin:-edge_margin, edge_margin:-edge_margin]
    else:
        edge_margin = 0
        trimmed = small
    ink = trimmed < 200  # điểm ảnh tối = có nội dung (chữ/ảnh), điểm ảnh sáng = nền/lề trắng

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
    # Bù lại offset đã bỏ viền lúc trim, để toạ độ khớp lại đúng hệ quy chiếu của `small`.
    row_bounds = (row_bounds[0] + edge_margin, row_bounds[1] + edge_margin)
    col_bounds = (col_bounds[0] + edge_margin, col_bounds[1] + edge_margin)

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


# ---------------------------------------------------------------------------
# Đọc chữ bằng Gemini Vision — nguồn CHÍNH, Tesseract giờ là nguồn dự phòng
# ---------------------------------------------------------------------------
# VÌ SAO ĐỔI: toàn bộ phần tiền xử lý ảnh ở trên (deskew, CLAHE, khử nhiễu, khử màu, best-of
# 5 biến thể) là để bù cho việc Tesseract chỉ so KHỚP HÌNH DẠNG ký tự, không hiểu nội dung.
# Với giấy tờ khó, mức đó vẫn không đủ. Số đo trên đúng 1 trang thật (giấy chứng nhận kết
# hôn nền hoa văn bảo an đỏ — "6. Trần Văn Hùng - ĐKKH.pdf" trang 2):
#
#    trường            Tesseract (đã có biến thể dropout)   Gemini 3.7 Flash
#    tên vợ + chồng    MẤT HẲN CẢ HAI                       TRẦN VĂN HÙNG / TRẦN THỊ THUẬN
#    số CMND           "18372 3316" / "1 321 g373"          183725316 / 183910373
#    số + quyển số     "18/2015" (sai)                      18/2013, Quyển số 01
#    ngày sinh         mất                                  12/7/1989 / 02/4/1992
#    ngày đăng ký      mất                                  18/02/2013
#
# Gemini đọc đúng cả dòng chữ dọc cỡ nhỏ ở lề trang. Lý do bản chất: nó suy luận theo NGỮ
# CẢNH (biết đây là mẫu giấy chứng nhận kết hôn nên biết chỗ nào là tên, chỗ nào là số
# CMND), còn Tesseract chỉ nhìn hình dạng từng ký tự rời.
#
# RỦI RO PHẢI BIẾT: đây cũng chính là điểm yếu — model hiểu ngữ cảnh thì cũng có thể BỊA
# theo ngữ cảnh, kiểu "ảo giác" đã gặp với VietOCR (xem docstring đầu file, lý do bỏ
# VietOCR). Prompt dưới đây vì vậy nhấn mạnh KHÔNG ĐOÁN BỪA. Tesseract tuy đọc kém hơn
# nhưng không bao giờ bịa, nên vẫn giữ nguyên làm nguồn dự phòng chứ không xoá.
GEMINI_OCR_ENABLED = (os.getenv("GEMINI_OCR_ENABLED") or "1") != "0"

# 1600px cạnh dài + JPEG q85: đo thật trên trang khó ở trên — ảnh 528KB, tốn 1180 token, đọc
# đúng mọi trường kể cả chữ dọc bé ở lề, mất 9.0s. Render gốc 300 DPI là 3509x2481, gửi
# nguyên sẽ nặng gấp mấy lần mà không thêm thông tin (ảnh gốc trong PDF vốn chỉ 2340x1654).
GEMINI_OCR_MAX_DIM = llm._env_int("GEMINI_OCR_MAX_DIM", 1600)
GEMINI_OCR_JPEG_QUALITY = llm._env_int("GEMINI_OCR_JPEG_QUALITY", 85)
# Không còn hằng số trần token riêng cho OCR: llm.try_gemini luôn chạy KỊCH TRẦN của model
# (llm.GEMINI_MAX_OUTPUT_TOKENS = 65536). Với OCR đây là lựa chọn đúng — bị cắt ngang nghĩa
# là MẤT NỬA CUỐI TRANG mà API vẫn trả 200, không báo lỗi gì.

GEMINI_OCR_PROMPT = (
    "Trích xuất TOÀN BỘ văn bản trong ảnh tài liệu này, giữ nguyên bố cục theo dòng.\n"
    "- Chỉ trả về nội dung chữ đọc được, KHÔNG thêm lời dẫn, KHÔNG giải thích, "
    "KHÔNG mô tả hình ảnh.\n"
    "- TUYỆT ĐỐI KHÔNG BỊA: chỗ nào thực sự không đọc được thì bỏ qua, không suy đoán nội "
    "dung theo mẫu giấy tờ. Thà thiếu còn hơn sai.\n"
    "- Giữ nguyên chính xác mọi con số, ngày tháng, số giấy tờ đúng như trên ảnh.\n"
    "- Nếu ảnh không có chữ nào, trả về đúng chuỗi rỗng."
)


# Tài liệu bao nhiêu trang thì coi là "nhỏ" và ưu tiên model lite (15 RPM / 50 RPD, gấp 3
# hạn mức bản thường) — giữ suất của bản thường cho tài liệu dày/khó. Mặc định 1: đúng nhóm
# giấy tờ 1 trang (CCCD, giấy khai sinh, bằng cấp) vốn chiếm phần lớn hồ sơ. Nếu lite hết
# suất thì vẫn tự rơi xuống chuỗi model thường rồi mới tới Tesseract, không mất khả năng gì.
GEMINI_LITE_MAX_PAGES = llm._env_int("GEMINI_LITE_MAX_PAGES", 1)

# Số trang gọi Gemini song song trong 1 file. Không để quá cao: mỗi luồng là 1 request, gọi
# ồ ạt chạm hạn mức RPM nhanh hơn và phần thời gian tiết kiệm được lại mất vào việc dò
# key/model khác. Nhiều file cũng đang chạy song song sẵn (UploadDropzone gửi 4 file 1 lúc),
# nên con số này nhân lên theo số file đang xử lý.
OCR_PAGE_CONCURRENCY = llm._env_int("OCR_PAGE_CONCURRENCY", 4)


def gemini_ocr_page(
    page_img: Image.Image, page_no: int = 1, prefer_lite: bool = False
) -> str | None:
    """Đọc chữ 1 trang bằng Gemini Vision. Trả None khi KHÔNG dùng được (hết hạn mức mọi
    model x mọi key, hoặc lỗi ảnh) — nơi gọi tự chuyển sang nguồn kế tiếp (PaddleOCR-VL nếu
    có bật, rồi Tesseract).

    KHÔNG trả toạ độ dòng như Tesseract (Gemini chỉ trả text thuần), nên đường này không
    vẽ được khung debug ở /ocr/test — đó là lý do extract_text có tham số use_gemini.

    Dùng chung pool + logic xoay vòng key với các bước LLM khác (llm.try_gemini): mỗi lần
    gọi xáo ngẫu nhiên thứ tự key, duyệt hết model này tới model khác. Không có nhánh
    DeepSeek vì DeepSeek không đọc được ảnh — dự phòng ở đây là PaddleOCR-VL / Tesseract chạy
    tại chỗ."""
    try:
        img = page_img.convert("RGB")
        if max(img.size) > GEMINI_OCR_MAX_DIM:
            ratio = GEMINI_OCR_MAX_DIM / max(img.size)
            img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=GEMINI_OCR_JPEG_QUALITY)
        b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:  # noqa: BLE001
        logger.warning("Không mã hoá được ảnh trang %d để gửi Gemini (%s) — dùng Tesseract.",
                       page_no, type(e).__name__)
        return None

    text = llm.try_gemini(
        step=f"OCR trang {page_no}",
        prefer_lite=prefer_lite,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": GEMINI_OCR_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            }
        ],
    )
    if text is None:
        logger.info("OCR trang %d: hết lượt Gemini — chuyển sang nguồn kế tiếp.", page_no)
    return text


def _fill_missing_pages(texts, pages, source_name, read_page, concurrency) -> None:
    """Đọc SONG SONG bằng 1 nguồn AI những trang còn trống trong `texts` (ghi đè tại chỗ).

    Song song là chỗ tiết kiệm lớn nhất: đo thật trên file 2 trang, OCR bằng Gemini trang 1
    mất 11-22s còn trang 2 mất 48-72s — chạy nối đuôi là 60-95s, chạy song song chỉ còn bằng
    trang chậm nhất. File 7 trang thì chênh lệch gấp bội. Thời gian ở đây gần như toàn bộ là
    CHỜ phía nguồn AI xử lý, không phải CPU của tiến trình này, nên thread là đúng công cụ —
    GIL không cản."""
    todo = [i for i, t in enumerate(texts) if t is None]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=max(1, min(concurrency, len(todo)))) as pool:
        futures = {pool.submit(read_page, pages[i], i + 1): i for i in todo}
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                texts[i] = fut.result()
            except Exception as e:  # noqa: BLE001
                # Không để 1 trang lỗi làm hỏng cả file — trang đó tự rơi xuống nguồn sau.
                logger.warning("OCR trang %d lỗi ở %s (%s) — chuyển sang nguồn kế tiếp.",
                               i + 1, source_name, type(e).__name__)


def extract_text(
    content: bytes,
    filename: str,
    mime_type: str,
    try_harder: bool = False,
    use_gemini: bool = True,
    ocr_engine: str | None = None,
) -> tuple[str, int, list[OcrLine], list[Image.Image]]:
    """Trả về (text, pageCount, lines, pages). `lines` giữ toạ độ từng dòng (dùng cho vẽ
    khung debug ở /ocr/test — không còn dùng cho prompt LLM, xem ghi chú ở
    classify.correct_ocr_text). `pages` là ảnh từng trang đã render (PDF) hoặc ảnh gốc
    (non-PDF) — trả ra để nơi gọi lưu lại vào MinIO nếu cần (vd PDF nhiều trang), tránh
    phải render PDF lại lần 2 chỉ để lấy ảnh.

    Thứ tự đọc chữ TỪNG TRANG: GEMINI VISION trước, hết hạn mức free thì PADDLEOCR-VL chạy
    trên GPU của máy (chỉ khi có khai PADDLE_OCR_VL_URL — xem paddle_ocr_vl.py; đặt
    PADDLE_OCR_VL_FIRST=1 để nó đứng trước Gemini), cuối cùng mới về TESSERACT. Fallback tính
    theo TỪNG TRANG, không phải cả file — 1 trang lỗi/hết suất chỉ trang đó rơi xuống nguồn
    sau, các trang khác vẫn giữ kết quả của nguồn trước.

    `ocr_engine="paddle"`: BẮT BUỘC đọc bằng PaddleOCR-VL, bỏ hẳn Gemini. Dùng cho nút "Đọc
    lại bằng PaddleOCR-VL" — nhân viên bấm nút đó vì bản đọc tự động sai, nên phải đúng nguồn
    họ chọn chứ không phải nguồn nào rảnh trước. Không chỉ là đảo thứ tự: nguồn đứng trước đọc
    xong thì nguồn sau KHÔNG còn trang nào để đọc (xem _fill_missing_pages), nên để Gemini ở
    lại là nút bấm không có tác dụng gì. Tesseract vẫn giữ làm lưới cuối cho trang PaddleOCR-VL
    đọc không nổi — mất chữ hẳn còn tệ hơn đọc bằng nguồn kém.

    `use_gemini=False`: bỏ hẳn các nguồn AI (Gemini lẫn PaddleOCR-VL), chỉ chạy Tesseract.
    Dùng cho trang debug /ocr/test — nơi đó cần chính TOẠ ĐỘ từng dòng do Tesseract dò ra để
    vẽ khung, mà các nguồn AI không trả toạ độ (xem gemini_ocr_page), nên đi đường AI sẽ làm
    công cụ debug đó vô dụng.

    `try_harder=True`: mỗi trang chạy Tesseract với NHIỀU cách tiền xử lý khác nhau
    (_preprocess_variants), giữ lại kết quả đọc được nhiều ký tự nhất — chậm hơn hẳn (~5
    lần) nên chỉ bật cho "Phân tích lại" (nhân viên chủ động chờ để có kết quả tốt hơn),
    không bật cho lần OCR đầu lúc upload. CHỈ có tác dụng ở đường Tesseract.

    Raise ValueError CHỈ KHI không mở được file, hoặc không đọc nổi MỘT trang nào. Trang lẻ
    đọc hỏng thì giữ nguyên các trang còn lại và ghi chú "[Không đọc được trang N: ...]" vào
    đúng chỗ đó trong văn bản trả về."""
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

    force_paddle = ocr_engine == "paddle"
    want_gemini = use_gemini and GEMINI_OCR_ENABLED and not force_paddle
    # Chung công tắc với Gemini: /ocr/test (use_gemini=False) cần TOẠ ĐỘ từng dòng của
    # Tesseract để vẽ khung, mà PaddleOCR-VL cũng không trả toạ độ dòng.
    want_paddle = force_paddle or (
        use_gemini and paddle_ocr_vl.is_enabled() and not paddle_ocr_vl.PADDLE_OCR_VL_MANUAL_ONLY
    )

    # Khi đã có nguồn AI lo lần đọc đầu, Tesseract chỉ còn là PHƯƠNG ÁN CUỐI — lúc đó ưu tiên
    # đọc được nhiều nhất chứ không phải nhanh, nên luôn dùng best-of bất kể `try_harder`.
    # Đây là chỗ ĐÃ TỪNG hổng thật: nơi gọi lúc upload truyền try_harder=is_pdf
    # (case_documents.py), tức ẢNH jpg/png chỉ chạy 1 biến thể — đo trên giấy khai sinh nền
    # hoa văn đỏ, 1 biến thể đọc được ĐÚNG 2 KÝ TỰ trong khi best-of đọc được 1013. Trước
    # đây lỗ hổng đó ít lộ vì đường Tesseract là đường chính; giờ nó là lưới an toàn cuối
    # cùng nên đọc hỏng ở đây là mất hẳn nội dung.
    ocr_page = (
        _ocr_single_image_lines_best_of
        if (want_gemini or want_paddle or try_harder)
        else _ocr_single_image_lines
    )

    # Tài liệu ít trang -> ưu tiên model lite (xem GEMINI_LITE_MAX_PAGES). Quyết định 1 lần
    # cho cả file chứ không theo từng trang: 1 file là 1 loại giấy tờ, xử lý nửa trang bằng
    # lite nửa kia bằng bản thường chỉ làm kết quả khó lý giải khi soát lại.
    prefer_lite = len(pages) <= GEMINI_LITE_MAX_PAGES

    # Các nguồn AI theo THỨ TỰ ƯU TIÊN; nguồn sau chỉ đọc những trang nguồn trước bỏ trống.
    # Mặc định Gemini trước, PaddleOCR-VL sau — xem docstring paddle_ocr_vl.py vì sao.
    # Giới hạn luồng Gemini: gọi ồ ạt sẽ chạm hạn mức RPM nhanh hơn, mà chạm rồi thì phần
    # thắng được lại mất vào việc dò key/model khác. 4 là điểm cân bằng, chỉnh được qua .env.
    sources = []
    if want_gemini:
        sources.append(("Gemini", lambda img, n: gemini_ocr_page(img, n, prefer_lite),
                        OCR_PAGE_CONCURRENCY))
    if want_paddle:
        paddle = ("PaddleOCR-VL", paddle_ocr_vl.ocr_page, paddle_ocr_vl.PAGE_CONCURRENCY)
        if paddle_ocr_vl.PADDLE_OCR_VL_FIRST or force_paddle:
            sources.insert(0, paddle)
        else:
            sources.append(paddle)

    ai_texts: list[str | None] = [None] * len(pages)
    for name, read_page, concurrency in sources:
        _fill_missing_pages(ai_texts, pages, name, read_page, concurrency)

    # Trang nào các nguồn AI không đọc được thì đọc bằng Tesseract — các trang chạy SONG SONG.
    #
    # TESSERACT_PARALLEL: trước đây CỐ Ý chạy tuần tự vì sợ nhiều trang giành CPU với request
    # khác trên VM. Nỗi lo đó giờ đã do _tesseract_slots lo (chặn TỔNG số tiến trình Tesseract
    # của cả backend), nên song song ở đây chỉ để các trang xếp hàng vào slot trống chứ không
    # làm quá tải máy. Số trang đọc cùng lúc cũng chặn bằng TESSERACT_MAX_WORKERS, để PDF vài
    # chục trang không bung hàng trăm ảnh biến thể vào bộ nhớ một lúc.
    #
    # Đo trên máy dev 72 luồng, PDF 8 trang giấy tờ thật (đọc kỹ 5 biến thể/trang), văn bản ra
    # GIỐNG HỆT nhau (cùng md5) giữa các cách:
    #   trang + biến thể nối đuôi, khử nhiễu 2 lần/trang (bản cũ)   116.8s
    #   bỏ lần khử nhiễu thừa, vẫn nối đuôi                          85.8s
    #   bỏ khử nhiễu thừa + trang và biến thể song song              ~20s
    tesseract_results: dict[int, list[OcrLine] | ValueError] = {}
    todo = [i for i, t in enumerate(ai_texts) if t is None]
    if todo:
        with ThreadPoolExecutor(max_workers=max(1, min(len(todo), TESSERACT_MAX_WORKERS))) as pool:
            futures = {pool.submit(ocr_page, pages[i]): i for i in todo}
            for fut in as_completed(futures):
                try:
                    tesseract_results[futures[fut]] = fut.result()
                except ValueError as e:
                    tesseract_results[futures[fut]] = e

    page_texts = []
    all_lines: list[OcrLine] = []
    read_ok = 0
    last_error: Exception | None = None
    for i in range(len(pages)):
        text = ai_texts[i]
        if text is None:
            try:
                result = tesseract_results[i]
                if isinstance(result, ValueError):
                    raise result
                page_lines = result
            except ValueError as e:
                # 1 trang hỏng KHÔNG được làm mất luôn các trang đọc tốt — đường AI phía
                # trên đã theo nguyên tắc này từ đầu, đường Tesseract thì chưa: file 5 trang
                # mà trang 3 quá giờ là cả tài liệu về ERROR với 0 ký tự (sự cố thật). Ghi
                # thẳng chỗ hỏng vào văn bản để người soát biết trang nào thiếu mà mở file
                # gốc đối chiếu, thay vì âm thầm bỏ trang.
                last_error = e
                logger.warning("Trang %d không đọc được (%s) — bỏ qua, giữ các trang khác.",
                               i + 1, e)
                text = f"[Không đọc được trang {i + 1}: {e}]"
            else:
                read_ok += 1
                all_lines.extend(page_lines)
                text = "\n".join(line.text for line in page_lines)
        else:
            read_ok += 1
        if len(pages) > 1:
            page_texts.append(f"--- Trang {i + 1} ---\n{text}")
        else:
            page_texts.append(text)

    # Không trang nào đọc được thì mới thật sự là tài liệu hỏng — báo lỗi như cũ để document
    # về ERROR, có nút "Thử lại". Chỉ MỘT SỐ trang hỏng thì vẫn trả kết quả (status bình
    # thường) vì phần đọc được vẫn đủ để phân loại và đối chiếu checklist.
    if read_ok == 0 and last_error is not None:
        raise last_error

    return "\n\n".join(page_texts), len(pages), all_lines, pages
