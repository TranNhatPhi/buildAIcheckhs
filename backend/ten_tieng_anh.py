"""Tên file TIẾNG ANH, KHÔNG DẤU cho "hồ sơ hoàn thành" (14/10/2026, Docs yêu cầu: đẩy file sang hoàn thành
thì tên file phải tiếng Anh, không dấu).

    "<số mục>. <Họ tên không dấu> - <tên giấy tiếng Anh><đuôi>"   vd "4. Phan Huy Di Dan - Confirmation of residence information.pdf"

Tên tiếng Anh theo ĐÚNG bộ file mẫu công ty đang dùng (docs/test: "Birth certificate", "Criminal record certificate
No2", "Certificate of employment", "Letter of re-offer", "Request for certification", "Saving book"...). Bảng
TEN_TIENG_ANH tra theo tên mục đã bỏ "(nếu có)"; mục chưa có trong bảng thì bỏ dấu tên tiếng Việt (seed thêm mục
mới thì nhớ thêm vào đây). Ô "Giấy tờ khác N" mang tên do nhân viên tự đặt (ten_giay_to_khac.py) -> nhờ DeepSeek
dịch (nhớ trong bộ nhớ), lỗi thì bỏ dấu.
"""
from __future__ import annotations

import logging
import os
import re
import unicodedata

from tach_file import KY_TU_CAM

logger = logging.getLogger(__name__)

TEN_TIENG_ANH = {
    "Phiếu TT khách hàng": "Customer information form",
    "Passport": "Passport",
    "Căn cước công dân": "ID Card",
    "Căn cước công dân bố": "Father's ID Card",
    "Căn cước công dân mẹ": "Mother's ID Card",
    "Căn cước công dân vợ/chồng": "Spouse's ID Card",
    "Chứng minh nhân dân": "Old ID Card",
    "Chứng minh nhân dân cũ": "Old ID Card",
    "Giấy xác nhận cư trú, mẫu CT07/CT08": "Confirmation of residence information",
    "Giấy khai sinh": "Birth certificate",
    "Giấy khai sinh vợ/chồng": "Spouse's Birth certificate",
    "Giấy khai sinh - con 1": "Child 1's Birth certificate",
    "Giấy khai sinh - con 2": "Child 2's Birth certificate",
    "Giấy khai sinh - con 3": "Child 3's Birth certificate",
    "Giấy khai sinh con 1": "Child 1's Birth certificate",
    "Giấy khai sinh con 2": "Child 2's Birth certificate",
    "Giấy đăng ký kết hôn": "Marriage certificate",
    "Giấy quyết định ly hôn": "Divorce decision",
    "Ảnh thẻ phông trắng": "Photo",
    "Hình thẻ trắng": "Photo",
    "Lý lịch tư pháp số 2": "Criminal record certificate No2",
    "Lý lịch tư pháp tại nước ngoài": "Foreign criminal record certificate",
    "Giấy khám sức khoẻ tại nơi chỉ định": "Emedical",
    "Giấy xác nhận quá trình học tập": "Certificate of study",
    "Bằng tốt nghiệp THCS / THPT": "High school diploma",
    "Học bạ THCS/ THPT": "High school record",
    "Bằng Trung Cấp": "Intermediate diploma",
    "Bằng Cao Đẳng/ Đại học": "College - University degree",
    "Bằng Trung Cấp / Cao Đẳng/ Đại học": "Intermediate - College - University degree",
    "Bảng điểm Trung Cấp": "Intermediate transcript",
    "Bảng điểm Cao Đẳng/ Đại học": "College - University transcript",
    "Bảng điểm Trung Cấp / Cao Đẳng/ Đại học": "Intermediate - College - University transcript",
    "Bằng cấp cao nhất": "Highest degree",
    "Học bạ/ bảng điểm cao nhất": "Highest academic transcript",
    "Các bằng cấp/chứng chỉ nghề khác": "Other vocational certificates",
    "Chứng chỉ thi tiếng Anh": "English Certificate",
    "Giấy xác nhận học tiếng Anh": "English course confirmation",
    "Resume/ CV": "Resume",
    "Thư xác nhận kinh nghiệm làm việc": "Certificate of employment",
    "Thư xác nhận tái tuyển dụng": "Letter of re-offer",
    "Thư xác nhận của UBND": "Request for certification",
    "Hợp đồng lao động": "Labor contract",
    "Hợp đồng lao động 2": "Labor contract 2",
    "Hợp đồng lao động 3": "Labor contract 3",
    "Hợp đồng lao động 4": "Labor contract 4",
    "Hợp đồng lao động 5": "Labor contract 5",
    "Phiếu lương / sao kê lương": "Payslip",
    "Sổ tiết kiệm": "Saving book",
    "Giấy xác nhận số dư sổ tiết kiệm": "Savings balance confirmation",
    "Quyền sử dụng đất": "Certificate of land use right",
    "Thư hỗ trợ từ bố mẹ": "Letter of support from parents",
}

_NEU_CO = re.compile(r"\s*\((?:n|N)ếu có\)\s*$")
_O_KHAC = re.compile(r"^Giấy tờ khác (\d+)$")
_cache_dich: dict[str, str] = {}


def bo_dau(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "").replace("đ", "d").replace("Đ", "D")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = "".join("-" if c in KY_TU_CAM else c for c in unicodedata.normalize("NFC", s))
    return " ".join(s.split()).strip(" .-")


def _dich_deepseek(ten: str) -> str:
    """Tên giấy tự đặt (ô Giấy tờ khác) -> tiếng Anh ngắn gọn. Lỗi thì trả bản bỏ dấu."""
    if ten in _cache_dich:
        return _cache_dich[ten]
    try:
        import llm

        kq = llm.get_deepseek_client().chat.completions.create(
            model=os.environ["DEEPSEEK_MODEL"],
            messages=[
                {"role": "system", "content": (
                    "Translate the Vietnamese immigration document name into a short English document name "
                    "(Sentence case, no quotes, no explanation). Keep numbers. Example: 'Giấy khai sinh con 3' -> "
                    "\"Child 3's Birth certificate\"; 'Sổ hộ khẩu' -> 'Household registration book'.")},
                {"role": "user", "content": ten},
            ],
            # Model có thể "nghĩ" trước khi trả lời (đo thật: 40 token -> nội dung RỖNG) — chừa đủ chỗ.
            max_tokens=1000,
            timeout=60,
        )
        dong = [x.strip().strip("\"'") for x in (kq.choices[0].message.content or "").splitlines() if x.strip()]
        en = bo_dau(dong[0])[:100] if dong else ""
    except Exception:  # noqa: BLE001
        logger.exception("Không dịch được tên giấy '%s' — dùng bản bỏ dấu", ten)
        en = ""
    en = en or bo_dau(ten)
    _cache_dich[ten] = en
    return en


def ten_giay(ten_muc_goc: str, ten_hien_thi: str | None = None) -> str:
    """Tên giấy tiếng Anh của một mục. `ten_hien_thi` = tên riêng nhân viên đặt cho ô "Giấy tờ khác"."""
    goc = _NEU_CO.sub("", ten_muc_goc or "").strip()
    if ten_hien_thi and ten_hien_thi != ten_muc_goc:
        return _dich_deepseek(ten_hien_thi)
    if goc in TEN_TIENG_ANH:
        return TEN_TIENG_ANH[goc]
    o = _O_KHAC.match(goc)
    if o:
        return f"Other document {o.group(1)}"
    return bo_dau(goc)


# "<số>. <Họ tên> - <loại>" — tên file theo quy ước công ty.
_TEN_QUY_UOC = re.compile(r"^\s*\d{1,3}(?:\.\d{1,2})?\.?\s+(?P<nguoi>[^-]+?)\s+-\s+(?P<loai>.+)$")
# "Father's ID Card" -> "ID Card": khi tên file đã có họ tên CHÍNH NGƯỜI ĐÓ thì quy ước chỉ ghi loại giấy chung
# (bộ mẫu docs/test: "50. Phan Van Chinh - ID Card.pdf" là CCCD của bố).
_SO_HUU = re.compile(r"^(?:Father's|Mother's|Spouse's|Child \d+'s)\s+")


def la_ho_ten(s: str) -> bool:
    """Phần giữa "<số>." và " - " có phải họ tên người không: 2-6 chữ, chữ nào cũng viết hoa đầu, không chứa
    loại giấy tờ — loại "0. Phiếu thông tin - gửi lại.pdf" (không có tên người)."""
    from filename_rules import detect_kinds

    tu = s.split()
    return 2 <= len(tu) <= 6 and all(w[:1].isupper() and w.isalpha() for w in tu) and not detect_kinds(s)


def ten_file(so: str | None, ten_khach: str, ten_muc_goc: str | None, duoi: str,
             ten_hien_thi: str | None = None, ten_goc_file: str | None = None) -> str:
    """Tên file hoàn thành. Không có mục (chưa xếp) -> bỏ dấu tên file gốc.

    Tên file gốc đúng quy ước "<số>. <Họ tên> - <loại>" thì GIỮ họ tên trong đó (CCCD của bố ghi tên bố, không
    phải tên khách) + loại giấy tiếng Anh CHUNG ("ID Card"); không đọc được họ tên thì dùng tên khách + loại
    cụ thể ("Father's ID Card") để không mất thông tin giấy của ai."""
    duoi = (duoi or ".pdf").lower()
    if not ten_muc_goc or not so:
        return bo_dau(os.path.splitext(ten_goc_file or "file")[0]) + duoi
    loai = ten_giay(ten_muc_goc, ten_hien_thi)
    qu = _TEN_QUY_UOC.match(os.path.splitext(unicodedata.normalize("NFC", ten_goc_file or ""))[0])
    nguoi = bo_dau(qu.group("nguoi")) if qu else ""
    if nguoi and la_ho_ten(nguoi):
        return f"{so}. {nguoi} - {_SO_HUU.sub('', loai)}{duoi}"
    return f"{so}. {bo_dau(ten_khach)} - {loai}{duoi}"


def danh_so_trung(ten_list: list[str]) -> list[str]:
    """Trùng tên trong cùng một lượt -> thêm " (2)", " (3)" (giống tach_file.ten_cac_file)."""
    da_dung: dict[str, int] = {}
    ra = []
    for ten in ten_list:
        lan = da_dung.get(ten.casefold(), 0) + 1
        da_dung[ten.casefold()] = lan
        if lan > 1:
            stem, duoi = os.path.splitext(ten)
            ten = f"{stem} ({lan}){duoi}"
        ra.append(ten)
    return ra
