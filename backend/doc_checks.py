"""Hai phép kiểm tra chạy TRÊN thông tin AI đã bóc ra từ giấy tờ (xem models.Document):

1. Hạn giấy tờ — giấy tờ đã hết hạn hoặc sắp hết hạn.
2. Đối chiếu chéo — cùng một người mà các giấy tờ ghi khác nhau họ tên/ngày sinh/số định danh.

Cả hai đều là PHÉP TÍNH TRONG CODE, không gọi LLM. Phần "điểm bất nhất" trước đây phụ thuộc
hoàn toàn vào việc model tự nhìn ra khi chạy "Phân tích AI chuyên sâu" — tức mỗi lần chạy có
thể ra một kết quả khác, và chỉ có khi nhân viên bấm nút. Tính bằng code thì luôn giống nhau,
luôn có sẵn, và không tốn token.
"""
from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import date

from models import ChecklistItem, Document

# Chỉ xét giấy tờ đang thực sự được tính vào checklist — giống FULFILLED_STATUSES của
# completeness.py. File chưa gán vào mục nào thì chưa phải thứ hồ sơ đang dựa vào, cảnh báo
# hạn cho nó chỉ làm nhiễu.
FULFILLED_STATUSES = {"CLASSIFIED", "MANUALLY_SET"}

# Bao nhiêu ngày trước hạn thì bắt đầu cảnh báo. Để ở ENV vì đây là QUY ĐỊNH NGHIỆP VỤ, không
# phải hằng số kỹ thuật — mỗi loại giấy tờ một khác (ghi chú trong seed.py yêu cầu hộ chiếu
# còn khoảng 1 năm, trong khi giấy khám sức khoẻ lại ngắn hơn nhiều). Mức chung 180 ngày chỉ
# là điểm khởi đầu an toàn; bước tiếp theo đúng đắn là thêm ngưỡng RIÊNG cho từng mục
# checklist, KHÔNG phải cứng hoá các con số đoán được vào đây.
NGAY_CANH_BAO_HAN = int(os.getenv("DOC_EXPIRY_WARN_DAYS", "180"))


@dataclass
class HanGiayTo:
    document_id: str
    filename: str
    item_name: str | None
    expires_at: date
    source: str  # "MANUAL" (nhân viên sửa tay) | "AI"
    days_left: int  # âm nghĩa là đã quá hạn
    state: str  # "EXPIRED" | "EXPIRING_SOON"


def han_hieu_luc(doc: Document) -> tuple[date | None, str]:
    """Ngày hết hạn ĐANG CÓ HIỆU LỰC và nguồn của nó. Nhân viên sửa tay thì ưu tiên số của
    họ — cùng quy tắc đã dùng cho savingsManualVnd/savingsAiVnd."""
    if doc.manualExpiresAt:
        return doc.manualExpiresAt, "MANUAL"
    return doc.aiExpiresAt, "AI"


def danh_gia_han(
    documents: list[Document],
    items_by_id: dict[str, ChecklistItem],
    hom_nay: date | None = None,
) -> list[HanGiayTo]:
    """Danh sách giấy tờ đã hết hạn hoặc sắp hết hạn, sắp xếp gấp nhất lên đầu.

    Giấy tờ KHÔNG đọc được ngày hết hạn thì không xuất hiện ở đây — cố tình như vậy: bịa ra
    một cảnh báo "không rõ hạn" cho mọi file sẽ nhấn chìm mấy cái cảnh báo thật."""
    hom_nay = hom_nay or date.today()
    ket_qua: list[HanGiayTo] = []

    for doc in documents:
        if doc.status not in FULFILLED_STATUSES:
            continue
        het_han, nguon = han_hieu_luc(doc)
        if not het_han:
            continue

        con_lai = (het_han - hom_nay).days
        if con_lai < 0:
            trang_thai = "EXPIRED"
        elif con_lai <= NGAY_CANH_BAO_HAN:
            trang_thai = "EXPIRING_SOON"
        else:
            continue

        muc = items_by_id.get(doc.matchedChecklistItemId or "")
        ket_qua.append(
            HanGiayTo(
                document_id=doc.id,
                filename=doc.originalFilename,
                item_name=muc.nameVi if muc else None,
                expires_at=het_han,
                source=nguon,
                days_left=con_lai,
                state=trang_thai,
            )
        )

    ket_qua.sort(key=lambda h: h.days_left)
    return ket_qua


# ---------------------------------------------------------------------------
# Đối chiếu chéo giữa các giấy tờ của CÙNG một người
# ---------------------------------------------------------------------------

# "OTHER" là giấy tờ không của riêng ai (hợp đồng công ty, sổ đỏ...) nên gom nhóm để so tên
# là vô nghĩa. None là AI không xác định được chủ giấy tờ — so bừa còn tệ hơn không so.
NHOM_KHONG_DOI_CHIEU = {None, "OTHER"}

TEN_NHOM = {
    "APPLICANT": "Đương đơn",
    "SPOUSE": "Vợ/chồng",
    "CHILD_1": "Con 1",
    "CHILD_2": "Con 2",
    "CHILD_3": "Con 3",
    "FATHER": "Bố",
    "MOTHER": "Mẹ",
}


@dataclass
class GiaTriLech:
    value: str  # nguyên văn như trên giấy tờ, KHÔNG phải bản đã chuẩn hoá
    filename: str


@dataclass
class DiemBatNhat:
    owner: str  # mã nhóm, vd "APPLICANT"
    owner_label: str  # tên tiếng Việt để hiện lên giao diện
    field_label: str  # "Họ tên" | "Ngày sinh" | "Số định danh"
    values: list[GiaTriLech]


def chuan_hoa_ten(ten: str) -> str:
    """Bỏ dấu, bỏ khoảng trắng thừa, viết hoa hết.

    BẮT BUỘC bỏ dấu: OCR trên giấy tờ thật rất hay mất dấu tiếng Việt, nên cùng một người sẽ
    ra "NGUYỄN VĂN A" ở file này và "NGUYEN VAN A" ở file kia. So thẳng thì mọi hồ sơ đều
    báo lệch — cảnh báo sai hàng loạt còn tệ hơn không có cảnh báo, vì nhân viên sẽ học cách
    bỏ qua nó rồi bỏ sót luôn cái lệch thật."""
    khong_dau = unicodedata.normalize("NFD", ten)
    khong_dau = "".join(c for c in khong_dau if not unicodedata.combining(c))
    khong_dau = khong_dau.replace("đ", "d").replace("Đ", "D")
    return re.sub(r"\s+", " ", khong_dau).strip().upper()


def chuan_hoa_so(so: str) -> str:
    """Chỉ giữ chữ số và chữ cái: số CCCD hay bị OCR chèn thêm khoảng trắng hoặc dấu chấm
    ("034 090 001 234"), còn số hộ chiếu thì có chữ đầu ("P05557482")."""
    return re.sub(r"[^0-9A-Za-z]", "", so).upper()


def _gom_lech(
    docs_trong_nhom: list[Document],
    lay_gia_tri,
    chuan_hoa,
    nhan_truong: str,
    owner: str,
) -> DiemBatNhat | None:
    theo_khoa: dict[str, GiaTriLech] = {}
    for doc in docs_trong_nhom:
        tho = lay_gia_tri(doc)
        if not tho:
            continue
        khoa = chuan_hoa(str(tho))
        if not khoa:
            continue
        # Giữ file ĐẦU TIÊN gặp cho mỗi giá trị khác nhau — mục đích là chỉ ra CÓ hai giá trị
        # khác nhau và xem ở đâu, không phải liệt kê hết mọi file trùng lặp.
        theo_khoa.setdefault(khoa, GiaTriLech(value=str(tho), filename=doc.originalFilename))

    if len(theo_khoa) < 2:
        return None
    return DiemBatNhat(
        owner=owner,
        owner_label=TEN_NHOM.get(owner, owner),
        field_label=nhan_truong,
        values=list(theo_khoa.values()),
    )


def doi_chieu_cheo(documents: list[Document]) -> list[DiemBatNhat]:
    """Tìm chỗ các giấy tờ của cùng một người ghi khác nhau.

    Gom nhóm theo aiDocOwner chứ KHÔNG theo mục checklist: checklist không cho biết chủ giấy
    tờ (mục "Căn cước công dân mẹ" vẫn là appliesTo="ALWAYS"), gom theo nó sẽ đặt CCCD của mẹ
    chung nhóm với hộ chiếu đương đơn rồi báo lệch oan ở mọi hồ sơ có giấy tờ của bố mẹ."""
    theo_nhom: dict[str, list[Document]] = {}
    for doc in documents:
        if doc.status not in FULFILLED_STATUSES:
            continue
        if doc.aiDocOwner in NHOM_KHONG_DOI_CHIEU:
            continue
        theo_nhom.setdefault(doc.aiDocOwner, []).append(doc)

    ket_qua: list[DiemBatNhat] = []
    for owner, docs in theo_nhom.items():
        if len(docs) < 2:
            continue
        for lay, chuan, nhan in (
            (lambda d: d.aiHolderName, chuan_hoa_ten, "Họ tên"),
            (lambda d: d.aiHolderDob.isoformat() if d.aiHolderDob else None, lambda v: v, "Ngày sinh"),
        ):
            lech = _gom_lech(docs, lay, chuan, nhan, owner)
            if lech:
                ket_qua.append(lech)

        # Số định danh so RIÊNG TỪNG LOẠI. Số CCCD và số hộ chiếu của cùng một người vốn dĩ
        # khác nhau — dồn chung một rổ thì hồ sơ nào có đủ cả hai giấy tờ cũng bị báo lệch.
        # Loại "OTHER" (số sổ tiết kiệm, số hợp đồng...) không so: mỗi sổ một số là chuyện
        # bình thường, không phải mâu thuẫn.
        for loai, nhan in (("CCCD", "Số CCCD/CMND"), ("PASSPORT", "Số hộ chiếu")):
            cung_loai = [d for d in docs if d.aiIdType == loai]
            lech = _gom_lech(cung_loai, lambda d: d.aiIdNumber, chuan_hoa_so, nhan, owner)
            if lech:
                ket_qua.append(lech)

    ket_qua.sort(key=lambda d: (d.owner_label, d.field_label))
    return ket_qua


def dem_han_tai_lieu(documents) -> tuple[int, int]:
    """(số đã quá hạn, số sắp hết hạn) — dùng cho các danh sách hồ sơ.

    Truyền items_by_id rỗng vì danh sách chỉ cần con số, không cần tên mục checklist của
    từng file. Đặt ở đây thay vì trong router để /cases và /admin/cases đếm y hệt nhau —
    trước đó admin không đếm gì cả nên luôn hiện 0, trông như mọi giấy tờ đều còn hạn.
    """
    han = danh_gia_han(list(documents), {})
    return (
        sum(1 for h in han if h.state == "EXPIRED"),
        sum(1 for h in han if h.state == "EXPIRING_SOON"),
    )
