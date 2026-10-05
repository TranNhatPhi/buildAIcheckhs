"""Xếp giấy tờ vào mục checklist THEO TÊN FILE — cách DUY NHẤT app chọn mục; AI không còn
tham gia bước này (người dùng chốt bỏ hẳn AI phân loại).

Quy ước đặt tên file của công ty: số đứng đầu = số của mục trên bản checklist giấy, vd
"1. Tran Van Hung - Passport.pdf", "27. ... - QSDĐ.pdf". Số trên app là VỊ TRÍ của mục trong
danh sách áp dụng cho hồ sơ (lib/format.ts buildChecklistNumbers), và danh sách đó được giữ
khớp từng dòng với bản giấy (seed.py) — nên số trong tên file trỏ thẳng được vào mục, không
cần AI đọc nội dung để đoán. Nhanh hơn, và không nhầm kiểu AI từng nhầm: CCCD của mẹ khớp
thành CCCD đương đơn 3/4 lần, confidence vẫn 0.9-1.0 nên sai âm thầm.

Vì sao KHÔNG tin số một mình: số trên giấy đổi theo phiên bản checklist và theo tình trạng hôn
nhân — bản LOW độc thân mới bỏ "Đăng ký kết hôn" nên mọi mục từ số 6 lùi 1. File đặt tên theo
bản khác sẽ trỏ nhầm mục mà không ai hay. Có thật trong dữ liệu test: hồ sơ độc thân có
"6. ... - ĐKKH.pdf" và "8. ... - Photo.jpg"; theo bản độc thân mới, số 6 là "Giấy quyết định ly
hôn", số 8 là "Lý lịch tư pháp số 2". Vì vậy đối chiếu thêm LOẠI giấy tờ đọc được từ chữ
trong tên file: số và chữ mâu thuẫn thì không tin số.

Không quyết được (không có số, số không trỏ vào mục nào, mâu thuẫn mà chữ lại khớp nhiều mục)
thì KHÔNG đoán — để nhân viên chọn tay, kèm lý do cụ thể để họ biết sửa tên file thế nào.
"""
from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass

from models import ChecklistItem

# LOẠI giấy tờ và các cụm chữ nhận ra nó — áp cho CẢ tên file lẫn tên mục checklist, để hai
# bên so được với nhau. Chữ đã bỏ dấu, viết thường (xem _norm).
#
# THỨ TỰ CÓ Ý NGHĨA: cụm dài/cụ thể đứng trước và bị XOÁ khỏi chuỗi ngay khi khớp, để cụm
# ngắn nằm bên trong nó không khớp thêm lần nữa. Bỏ dấu làm "Bằng" và "Bảng" cùng thành "bang"
# — "bang diem" phải khớp (và bị xoá) trước, thì "Bảng điểm trung cấp" mới không bị nhận thêm
# là "bằng trung cấp". Cùng lý do: "xac nhan so du so tiet kiem" trước "so tiet kiem".
#
# Mục "ID Card" nhận là CẢ căn cước lẫn chứng minh nhân dân — tiếng Anh không phân biệt hai loại.
_KINDS: list[tuple[frozenset[str], tuple[str, ...]]] = [
    (frozenset({"so_du"}), ("xac nhan so du so tiet kiem", "xac nhan so du", "so du")),
    (frozenset({"bang_diem"}), ("bang diem", "transcript")),
    (frozenset({"xac_nhan_hoc_tieng_anh"}), ("xac nhan hoc tieng anh", "hoc tieng anh")),
    (frozenset({"chung_chi_tieng_anh"}), ("chung chi thi tieng anh", "chung chi tieng anh", "ielts",
                                          "toeic", "toefl", "aptis", "pte", "vstep", "cambridge")),
    (frozenset({"qua_trinh_hoc"}), ("xac nhan qua trinh hoc tap", "qua trinh hoc tap", "qua trinh hoc")),
    (frozenset({"chung_chi_nghe"}), ("chung chi nghe",)),
    (frozenset({"bang_tot_nghiep_pt"}), ("bang tot nghiep thcs", "bang tot nghiep thpt", "tot nghiep thcs",
                                         "tot nghiep thpt", "bang thcs", "bang thpt", "bang c2", "bang c3")),
    (frozenset({"hoc_ba"}), ("hoc ba",)),
    (frozenset({"bang_cap"}), ("bang trung cap", "bang cao dang", "bang dai hoc", "bang cap cao nhat",
                               "bang tc", "bang cd", "bang dh", "degree", "diploma")),
    (frozenset({"ly_lich_tu_phap"}), ("ly lich tu phap", "lltp", "police check", "criminal record")),
    (frozenset({"xac_nhan_kinh_nghiem"}), ("xac nhan kinh nghiem", "kinh nghiem lam viec", "xnkn",
                                           "certificate of employment", "coe")),
    (frozenset({"tai_tuyen_dung"}), ("tai tuyen dung", "tai tuyen")),
    (frozenset({"ubnd"}), ("uy ban nhan dan", "ubnd")),
    (frozenset({"hop_dong_lao_dong"}), ("hop dong lao dong", "hdld", "labor contract", "labour contract")),
    (frozenset({"phieu_luong"}), ("phieu luong", "sao ke luong", "bang luong", "payslip", "pay slip")),
    (frozenset({"so_tiet_kiem"}), ("so tiet kiem", "savings book")),
    (frozenset({"quyen_su_dung_dat"}), ("quyen su dung dat", "qsdd", "so do", "so hong", "nha dat")),
    (frozenset({"thu_ho_tro"}), ("thu ho tro", "support letter")),
    (frozenset({"resume"}), ("resume", "cv")),
    (frozenset({"ket_hon"}), ("dang ky ket hon", "ket hon", "dkkh", "marriage")),
    (frozenset({"ly_hon"}), ("quyet dinh ly hon", "ly hon", "divorce")),
    (frozenset({"khai_sinh"}), ("giay khai sinh", "khai sinh", "gks", "birth certificate", "birth")),
    (frozenset({"cu_tru"}), ("xac nhan cu tru", "cu tru", "tam tru", "thuong tru", "ct07", "ct08")),
    (frozenset({"anh_the"}), ("anh the phong trang", "anh the", "hinh the", "phong trang", "photo")),
    (frozenset({"kham_suc_khoe"}), ("kham suc khoe", "suc khoe", "health check", "medical", "iom")),
    (frozenset({"cccd", "cmnd"}), ("id card", "idcard")),
    (frozenset({"cmnd"}), ("chung minh nhan dan", "cmnd")),
    (frozenset({"cccd"}), ("can cuoc cong dan", "can cuoc", "cccd")),
    (frozenset({"passport"}), ("ho chieu", "passport")),
]

# Số đầu tên file: "1. ...", "01_...", "18.1 ..." (mục có số phụ, xem numberGroup). Tối đa 3 chữ
# số và BẮT BUỘC có dấu ngăn phía sau, để tên kiểu "2023 CCCD.pdf" không bị hiểu là mục 202.
_LEADING_NUMBER_RE = re.compile(r"^\s*(\d{1,3})(?:\.(\d{1,2}))?(?=[\s._\-)])")


@dataclass
class FilenameMatch:
    item: ChecklistItem | None  # None = tên file không đủ để quyết, nhân viên chọn tay
    reason: str  # hiện cho nhân viên ở mục "Lý do" trong khung chi tiết tài liệu


def _norm(text: str) -> str:
    """Bỏ dấu, viết thường, gom dấu câu thành khoảng trắng, đệm 2 đầu bằng khoảng trắng để so
    nguyên từ. NFD trước khi bỏ dấu: tên file từ macOS là dạng Unicode TÁCH DẤU (NFD) — thấy
    rõ trong DB ("Tra??n Va?n Hu?ng"), so theo dạng dựng sẵn (NFC) là trượt hết."""
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = text.replace("đ", "d").replace("Đ", "D").lower()
    text = re.sub(r"[_\-.,/()+&:;]+", " ", text)
    return f" {' '.join(text.split())} "


def detect_kinds(text: str) -> frozenset[str]:
    s = _norm(text)
    found: set[str] = set()
    for kinds, phrases in _KINDS:
        for phrase in phrases:
            needle = f" {phrase} "
            if needle in s:
                found |= kinds
                s = s.replace(needle, " ")
    return frozenset(found)


def _checklist_numbers(items: list[ChecklistItem]) -> list[str]:
    """Đánh số y hệt buildChecklistNumbers ở lib/format.ts — hai bên PHẢI ra cùng kết quả,
    lệch là số trong tên file trỏ sai mục so với số nhân viên thấy trên màn hình."""
    numbers: list[str] = []
    major = 0
    i = 0
    while i < len(items):
        major += 1
        group = getattr(items[i], "numberGroup", None)
        if not group:
            numbers.append(str(major))
            i += 1
            continue
        end = i
        while end < len(items) and getattr(items[end], "numberGroup", None) == group:
            end += 1
        # Mục ĐẦU của cụm giữ số trơn, các mục sau mới có số con — phải khớp từng ký tự với
        # buildChecklistNumbers ở lib/format.ts, vì số này dùng để đối chiếu với số ở đầu TÊN
        # FILE. Lệch một nhịp là file "23.1 HĐLĐ.pdf" bị xếp vào mục khác hẳn.
        numbers.extend(str(major) if k == i else f"{major}.{k - i}" for k in range(i, end))
        i = end
    return numbers


def match_by_filename(filename: str, applicable_items: list[ChecklistItem]) -> FilenameMatch:
    """Mục checklist cho file này theo tên file. `item` là None khi tên file không đủ để
    quyết — `reason` khi đó nói rõ thiếu gì.

    `applicable_items`: các mục áp dụng cho hồ sơ (thứ tự bất kỳ — tự sắp lại theo `order`
    cho giống hệt danh sách nhân viên đang nhìn)."""
    items = sorted(applicable_items, key=lambda it: it.order)
    stem = unicodedata.normalize("NFC", os.path.splitext(os.path.basename(filename or ""))[0])

    number = None
    m = _LEADING_NUMBER_RE.match(stem)
    if m:
        number = str(int(m.group(1))) + (f".{int(m.group(2))}" if m.group(2) else "")
    name_kinds = detect_kinds(stem[m.end():] if m else stem)

    by_number = dict(zip(_checklist_numbers(items), items))
    candidate = by_number.get(number) if number else None

    if candidate is not None:
        item_kinds = detect_kinds(candidate.nameVi)
        # Chỉ gạt số đi khi CHẮC mâu thuẫn: cả tên file lẫn tên mục đều nhận ra loại giấy tờ,
        # và không có loại nào chung. Tên file không có chữ gì nhận ra được ("1. scan.pdf")
        # thì tin số — đúng quy ước đặt tên.
        if not name_kinds or not item_kinds or (name_kinds & item_kinds):
            return FilenameMatch(candidate, f'Theo tên file: số {number} là mục "{candidate.nameVi}".')

    # Tới đây là số không dùng được: không có số, số không trỏ vào mục nào, hoặc số mâu thuẫn
    # với loại giấy tờ ghi trong tên file. Nói rõ trường hợp nào — dùng cho cả lý do xếp theo
    # chữ lẫn lý do không xếp được.
    if candidate is not None:
        number_note = (f'số {number} trong tên file là mục "{candidate.nameVi}", không phải loại giấy '
                       f"tờ ghi trong tên file (có thể tên file đánh số theo bản checklist khác)")
    elif number:
        number_note = (f"số {number} trong tên file không trỏ vào mục nào — hồ sơ này có "
                       f"{len(items)} mục (1-{len(items)})")
    else:
        number_note = "tên file không có số thứ tự mục ở đầu"

    same_kind = [it for it in items if detect_kinds(it.nameVi) & name_kinds] if name_kinds else []
    if len(same_kind) == 1:
        return FilenameMatch(same_kind[0], f'Theo tên file: loại giấy tờ khớp mục "{same_kind[0].nameVi}" ({number_note}).')

    if len(same_kind) > 1:
        # Kèm SỐ của từng mục: nhiều mục trùng hẳn tên ("Passport" của đương đơn, vợ/chồng,
        # từng con) — chỉ liệt kê tên thì nhân viên không biết đổi tên file thành số mấy.
        number_of = {id(it): num for num, it in by_number.items()}
        what = (f"loại giấy tờ trong tên file khớp {len(same_kind)} mục ("
                + ", ".join(f'số {number_of[id(it)]} "{it.nameVi}"' for it in same_kind[:4])
                + (", ..." if len(same_kind) > 4 else "") + ") nên cần số thứ tự đúng để biết là mục nào")
    elif name_kinds:
        what = "loại giấy tờ trong tên file không có trong checklist của hồ sơ này"
    else:
        what = "tên file không có chữ nào cho biết loại giấy tờ"
    return FilenameMatch(None, f"Không xếp được theo tên file: {number_note}; {what}. Chọn mục bằng tay, "
                               f'hoặc đổi tên file theo quy ước "<số mục>. <Họ tên> - <loại giấy tờ>" rồi upload lại.')
