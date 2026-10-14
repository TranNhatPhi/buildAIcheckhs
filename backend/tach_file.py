"""Trang "Tách file" (/tach-file): MỘT file PDF/Word scan gộp nhiều giấy tờ của khách -> tách thành
từng file, mỗi file một giấy tờ, ĐẶT TÊN theo đúng quy ước của công ty để upload vào hồ sơ là tự
vào đúng mục checklist:

    "<số mục>. <Họ tên khách> - <loại giấy tờ>.pdf"     vd "1. Hồ Sỹ Hội - Passport.pdf"

Số mục = vị trí của mục trong checklist ÁP DỤNG cho hồ sơ (độc thân/có gia đình, low/high skill)
— nên bắt buộc chọn hồ sơ trước khi tách. Tên file được KIỂM TRA LẠI bằng chính
filename_rules.match_by_filename: tên nào không trỏ ngược về đúng mục thì đổi sang tên đầy đủ của
mục — tách xong upload vào hồ sơ là khớp, không phải đoán.

Các bước:
  1. Word -> PDF (LibreOffice, contract_preview.word_sang_pdf).
  2. Chữ từng trang: trang có lớp chữ thì lấy thẳng (PyMuPDF, tức thì); trang scan mới OCR — gom
     các trang scan vào MỘT PDF phụ rồi gọi ocr.extract_text một lần (đọc song song từng trang).
  3. DeepSeek (Docs yêu cầu dùng DeepSeek) chia trang thành từng giấy tờ + gán mục -> JSON.
     Hỏng / hết tiền / trả rác thì KHÔNG chặn: mỗi trang một dòng "chưa xác định" để nhân viên tự
     chia tay — công cụ vẫn dùng được.
  4. Nhân viên sửa lại trên giao diện rồi tải ZIP — tách thật ở bước này, theo đúng bảng nhân viên
     gửi lên (không theo kết quả AI cũ).

File tạm ở MinIO tach-file/<job_id>/ — case_cleanup.don_tach_file xoá sau TACH_FILE_RETENTION_HOURS.

Chế độ BẢN DỊCH (`ban_dich=True`, trang /tach-ban-dich, 13/10/2026): file gộp các bản dịch tiếng Anh
(PDF / Word / EXCEL) -> cùng các bước, chỉ khác: nhận thêm Excel, prompt nói rõ là bản dịch công chứng
(trang lời chứng / bản sao tiếng Việt đi kèm thuộc cùng giấy), chỉ đưa AI các mục CẦN dịch, và tên
file thêm đuôi " - translated" như bộ mẫu `hosodichthuat/` ("12. Hồ Sỹ Trọng - Bằng C3 - translated").

Một BỘ bản dịch = [trang DỊCH tiếng Anh] + [trang CÔNG CHỨNG "Tôi, … cam đoan đã dịch chính xác…"] +
[BẢN GỐC tiếng Việt] — LLTP số 2 và phiếu lương thường KHÔNG có trang công chứng. Loại từng trang
đoán bằng chữ (`loai_trang`, không cần AI); bộ mới bắt đầu ở trang DỊCH đứng sau trang công chứng /
bản gốc (`theo_cau_truc`). Đo trên 9 bộ thật của Phan Huy Di Đan (docs/test, 49 trang): 9/9 ranh giới.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import unicodedata
import zipfile
from dataclasses import dataclass
from typing import Optional

import fitz  # PyMuPDF

import contract_preview
import filename_rules
import llm
import ocr
from completeness import is_item_applicable
from models import ChecklistItem

logger = logging.getLogger(__name__)

PREFIX = "tach-file"
RETENTION_HOURS = int(os.getenv("TACH_FILE_RETENTION_HOURS", "24"))
MAX_BYTES = 80 * 1024 * 1024
MAX_PAGES = 150
DUOI_NHAN = {".pdf", ".doc", ".docx"}
DUOI_EXCEL = {".xls", ".xlsx"}  # chỉ chế độ bản dịch
DUOI_BAN_DICH = " - translated"
# Trang có lớp chữ từ chừng này ký tự trở lên thì tin luôn, không OCR (PDF xuất từ Word/máy tính).
CHU_TOI_THIEU = 40
# Mỗi trang gửi DeepSeek tối đa chừng này ký tự — đủ nhận ra loại giấy (tiêu đề, cơ quan cấp nằm
# đầu trang), 100 trang vẫn nằm gọn trong ngữ cảnh.
CHU_MOI_TRANG = 1200

# Nhãn NGẮN quen dùng trong tên file của công ty (theo các file mẫu: "Passport", "ID Card", "CT07",
# "GKS", "Photo"). Mục khác dùng tên mục bỏ "(nếu có)". Mọi nhãn đều qua kiểm tra trỏ-ngược ở
# nhan_file() nên thêm nhãn ở đây không thể làm file vào nhầm mục.
NHAN_NGAN = {
    "Passport": "Passport",
    "Căn cước công dân": "ID Card",
    "Giấy xác nhận cư trú, mẫu CT07/CT08": "CT07",
    "Giấy khai sinh": "GKS",
    "Ảnh thẻ phông trắng": "Photo",
    "Hình thẻ trắng": "Photo",
    "Lý lịch tư pháp số 2": "LLTP số 2",
}
KY_TU_CAM = set('<>:"/|?*') | {chr(92)}


@dataclass
class MucChecklist:
    item: ChecklistItem
    so: str  # số thứ tự trên checklist của hồ sơ, vd "4" hoặc "18.1"
    nhan: str  # nhãn dùng trong tên file


def _sach_ten(s: str) -> str:
    """Bỏ ký tự cấm trong tên file của Windows/macOS, gom khoảng trắng."""
    s = "".join("-" if ch in KY_TU_CAM else ch for ch in unicodedata.normalize("NFC", s or ""))
    return " ".join(s.split()).strip(" .-") or "khong-ten"


def _ten_goc(name_vi: str) -> str:
    return _sach_ten(re.sub(r"\s*\((?:n|N)ếu có\)", "", name_vi))


def muc_cua_ho_so(tat_ca: list[ChecklistItem], marital: str, children: int, skill: str) -> list[MucChecklist]:
    """Các mục áp dụng cho hồ sơ, đúng thứ tự + đúng số như nhân viên thấy trên màn hình."""
    items = sorted(
        (i for i in tat_ca if is_item_applicable(i, marital, children, skill)), key=lambda i: i.order
    )
    so_list = filename_rules._checklist_numbers(items)
    ket_qua = []
    for item, so in zip(items, so_list):
        ket_qua.append(MucChecklist(item, so, nhan_file(item, so, items)))
    return ket_qua


def nhan_file(item: ChecklistItem, so: str, items: list[ChecklistItem]) -> str:
    """Nhãn loại giấy cho tên file — CHỈ dùng nhãn nào mà filename_rules trỏ ngược về đúng mục."""
    goc = _ten_goc(item.nameVi)
    ten_bo_neu_co = re.sub(r"\s*\((?:n|N)ếu có\)", "", item.nameVi).strip()
    for nhan in (NHAN_NGAN.get(ten_bo_neu_co), goc):
        if not nhan:
            continue
        khop = filename_rules.match_by_filename(f"{so}. Khach - {nhan}.pdf", items).item
        if khop is not None and khop.id == item.id:
            return nhan
    return goc


def ten_file(muc: Optional[MucChecklist], ten_khach: str, tu: int, den: int, ban_dich: bool = False) -> str:
    khach = _sach_ten(ten_khach)
    duoi = DUOI_BAN_DICH if ban_dich else ""
    if muc is None:
        trang = f"trang {tu}" if tu == den else f"trang {tu}-{den}"
        return f"{khach} - Chua xac dinh ({trang}){duoi}.pdf"
    return f"{muc.so}. {khach} - {muc.nhan}{duoi}.pdf"


# ---------------------------------------------------------------------------
# 1-2. Chuẩn bị PDF + đọc chữ từng trang
# ---------------------------------------------------------------------------

DUOI_ANH = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
# Giới hạn ZIP — chặn "zip bom" (nén nhỏ, bung ra khổng lồ) giống nhập zip mẫu hợp đồng.
ZIP_MAX_FILE = 150
ZIP_MAX_GIAI_NEN = 400 * 1024 * 1024


@dataclass
class FileGhep:
    """Kết quả chuẩn bị: MỘT PDF + mỗi file gốc bắt đầu ở trang nào (ZIP nhiều file) + file bỏ qua."""
    pdf: bytes
    dau_file: dict[int, str]  # trang (đếm từ 1) -> tên file gốc bắt đầu ở trang đó
    bo_qua: list[dict]


def _mot_file_sang_pdf(content: bytes, ten: str) -> bytes:
    duoi = os.path.splitext(ten.lower())[1]
    if duoi == ".pdf":
        return content
    if duoi in (".doc", ".docx") or duoi in DUOI_EXCEL:
        # LibreOffice chuyển được cả Excel (image có libreoffice-calc) — mỗi trang in thành 1 trang PDF.
        return contract_preview.word_sang_pdf(content, duoi)
    if duoi in DUOI_ANH:
        anh = fitz.open(stream=content, filetype=duoi.lstrip("."))
        try:
            return anh.convert_to_pdf()
        finally:
            anh.close()
    raise ValueError("không phải PDF / Word / ảnh")


def _ten_trong_zip(info: zipfile.ZipInfo) -> str:
    """Zip tạo trên Windows/Mac đời cũ không bật cờ UTF-8 -> tên tiếng Việt bị đọc theo cp437."""
    ten = info.filename
    if not info.flag_bits & 0x800:
        try:
            ten = ten.encode("cp437").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return unicodedata.normalize("NFC", os.path.basename(ten.replace(chr(92), "/")))


def _khoa_tu_nhien(ten: str):
    """Sắp "2. abc" trước "10. abc" (sắp chữ thường thì 10 đứng trước 2)."""
    return [int(x) if x.isdigit() else x.casefold() for x in re.split(r"(\d+)", ten)]


def chuan_bi_pdf(content: bytes, filename: str, ban_dich: bool = False) -> FileGhep:
    """PDF / Word / ảnh (+ Excel nếu `ban_dich`) -> PDF. ZIP -> mọi file nhận được bên trong, xếp theo
    tên (số tự nhiên), ghép thành MỘT PDF; file loại khác / hỏng thì bỏ qua và báo lại."""
    duoi = os.path.splitext((filename or "").lower())[1]
    nhan = DUOI_NHAN | DUOI_ANH | (DUOI_EXCEL if ban_dich else set())
    if duoi != ".zip":
        if duoi not in nhan:
            raise ValueError(
                "Chỉ nhận file PDF, Word (.doc, .docx), " + ("Excel (.xls, .xlsx), " if ban_dich else "") + "ảnh hoặc ZIP."
            )
        return FileGhep(_mot_file_sang_pdf(content, filename), {}, [])

    try:
        z = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as e:
        raise ValueError("File không phải ZIP hợp lệ.") from e
    cac_file = [i for i in z.infolist() if not i.is_dir() and not i.filename.startswith("__MACOSX/")]
    if len(cac_file) > ZIP_MAX_FILE:
        raise ValueError(f"ZIP có {len(cac_file)} file — tối đa {ZIP_MAX_FILE} file mỗi lần.")
    if sum(i.file_size for i in cac_file) > ZIP_MAX_GIAI_NEN:
        raise ValueError("ZIP giải nén ra quá lớn (tối đa 400MB).")

    gop = fitz.open()
    dau_file: dict[int, str] = {}
    bo_qua: list[dict] = []
    try:
        for info in sorted(cac_file, key=lambda i: _khoa_tu_nhien(_ten_trong_zip(i))):
            ten = _ten_trong_zip(info)
            if ten.startswith("."):
                continue
            if not ban_dich and os.path.splitext(ten.lower())[1] in DUOI_EXCEL:
                bo_qua.append({"file": ten, "lyDo": "không phải PDF / Word / ảnh"})
                continue
            try:
                pdf = _mot_file_sang_pdf(z.read(info), ten)
                src = fitz.open(stream=pdf, filetype="pdf")
            except Exception as e:  # noqa: BLE001
                bo_qua.append({"file": ten, "lyDo": str(e) if isinstance(e, ValueError) else "không mở được"})
                continue
            if src.page_count:
                dau_file[gop.page_count + 1] = ten
                gop.insert_pdf(src)
            src.close()
        if gop.page_count == 0:
            raise ValueError("Trong ZIP không có file PDF / Word / ảnh nào đọc được.")
        return FileGhep(gop.tobytes(garbage=3, deflate=True), dau_file, bo_qua)
    finally:
        gop.close()


_DAU_TRANG = re.compile(r"^--- Trang (\d+) ---$", re.MULTILINE)


_TU = re.compile(r"\w+", re.UNICODE)


def lop_chu_dung_duoc(t: str) -> bool:
    """Lớp chữ có sẵn trong PDF có dùng được không. Máy scan hay chèn lớp chữ RÁC ("o .Otzo o. x!r .L")
    — đủ dài nhưng toàn mẩu vụn; tin nó là AI không nhận ra trang (đo thật: bằng C3 bị nhận thành
    CCCD). Đòi phần lớn là "từ" thật (toàn chữ cái, dài 2+)."""
    if len(t.strip()) < CHU_TOI_THIEU:
        return False
    tu = _TU.findall(t)
    if not tu:
        return False
    tu_that = sum(1 for w in tu if len(w) >= 2 and w.isalpha())
    return tu_that / len(tu) >= 0.6


def doc_chu_tung_trang(pdf: bytes) -> list[str]:
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        chu = [p.get_text() or "" for p in doc]
        can_ocr = [i for i, t in enumerate(chu) if not lop_chu_dung_duoc(t)]
        if not can_ocr:
            return chu
        # Gom các trang scan vào MỘT PDF phụ: extract_text đọc song song từng trang của nó.
        phu = fitz.open()
        for i in can_ocr:
            phu.insert_pdf(doc, from_page=i, to_page=i)
        pdf_phu = phu.tobytes()
        phu.close()
    finally:
        doc.close()
    try:
        # try_harder=True BẮT BUỘC: CCCD scan chèn vào trang A4 mà đọc kiểu mặc định là RỖNG (đo thật
        # trên file 50 trang: 0 ký tự -> ~450 ký tự), cùng lý do đường upload hồ sơ cũng bật nó.
        van_ban, _, _, _ = ocr.extract_text(pdf_phu, "tach-file.pdf", "application/pdf", try_harder=True)
    except Exception:  # noqa: BLE001
        logger.exception("Tách file: OCR hỏng — giữ chữ sẵn có (có thể rỗng)")
        return chu
    # extract_text nối các trang bằng dòng "--- Trang N ---" (N đánh lại từ 1 trong PDF phụ).
    phan = _DAU_TRANG.split(van_ban)
    theo_trang = {int(phan[k]): phan[k + 1].strip() for k in range(1, len(phan) - 1, 2)}
    for vi_tri, i in enumerate(can_ocr, start=1):
        if theo_trang.get(vi_tri):
            chu[i] = theo_trang[vi_tri]
    return chu


# ---------------------------------------------------------------------------
# 3. DeepSeek chia trang thành giấy tờ
# ---------------------------------------------------------------------------

# --- Cấu trúc một bộ bản dịch -------------------------------------------------------------------

_CO_DAU = re.compile(r"[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùýỳ]", re.IGNORECASE)
# Trang lời chứng của người dịch / công chứng viên (song ngữ, phần tiếng Việt luôn có các cụm này).
_CONG_CHUNG = re.compile(
    r"cam\s*đoan\s*đã\s*dịch|lời\s*chứng|chứng\s*thực\s*chữ\s*ký\s*(của\s*)?người\s*dịch|công\s*chứng\s*viên",
    re.IGNORECASE,
)
# Mục KHÔNG cần trang công chứng (Docs 13/10/2026): LLTP số 2 và phiếu lương.
_KHONG_CAN_CONG_CHUNG = re.compile(r"lý lịch tư pháp số 2|phiếu lương", re.IGNORECASE)


def can_cong_chung(item: ChecklistItem) -> bool:
    return not _KHONG_CAN_CONG_CHUNG.search(item.nameVi or "")


def loai_trang(t: str) -> Optional[str]:
    """"dich" (tiếng Anh) | "cong_chung" | "goc" (tiếng Việt) | None (trang trắng / quá ít chữ).

    Đo trên bộ thật: trang dịch ≤ 0,08 chữ có dấu / từ, công chứng ~0,53, bản gốc 0,62–0,93 -> ngưỡng
    0,25. Trang dịch xét TRƯỚC từ khoá: bản dịch thư xác nhận cũng có "hereby certify"."""
    s = (t or "").strip()
    if len(s) < 30:
        return None
    tu = _TU.findall(s)
    if not tu:
        return None
    if len(_CO_DAU.findall(s)) / len(tu) < 0.25:
        return "dich"
    return "cong_chung" if _CONG_CHUNG.search(s) else "goc"


def co_cau_truc(loai: list[Optional[str]]) -> bool:
    """Áp quy tắc cấu trúc khi file BẮT ĐẦU bằng trang dịch và CÓ trang công chứng / bản gốc. File chỉ
    toàn bản dịch (Word xuất ra) hoặc thứ tự khác thường thì để AI tự chia."""
    biet = [x for x in loai if x]
    return bool(biet) and biet[0] == "dich" and any(x != "dich" for x in biet)


def theo_cau_truc(doan: list[dict], loai: list[Optional[str]]) -> list[dict]:
    """Sửa các đoạn AI chia theo cấu trúc bộ bản dịch:
    - BẮT BUỘC cắt ở trang dịch đứng sau trang công chứng / bản gốc (bắt đầu bộ mới);
    - BỎ chỗ cắt ở trang công chứng / bản gốc (chúng thuộc bộ đang mở — AI hay tách bản gốc ra riêng);
    - giữ chỗ cắt AI đặt giữa các trang dịch liền nhau (2 bản dịch không kèm gốc đứng sát nhau).
    Mục của đoạn mới = mục AI gán cho trang đầu của nó, không có thì mục đầu tiên AI gán trong đoạn."""
    if not doan or not co_cau_truc(loai):
        return doan
    so_trang = len(loai)
    cat_ai = {d["from"] for d in doan}
    cat: list[int] = [1]
    truoc = None  # loại của trang có chữ gần nhất phía trước
    for p in range(2, so_trang + 1):
        k = loai[p - 1]
        if k == "dich" and truoc in ("cong_chung", "goc"):
            cat.append(p)
        elif p in cat_ai and k in ("dich", None) and truoc in ("dich", None):
            cat.append(p)
        if k:
            truoc = k
    theo_trang = {}
    for d in doan:
        for p in range(d["from"], d["to"] + 1):
            theo_trang[p] = d
    ket_qua = []
    for i, tu in enumerate(cat):
        den = (cat[i + 1] - 1) if i + 1 < len(cat) else so_trang
        dau = theo_trang.get(tu) or {}
        item = dau.get("itemId") or next(
            (theo_trang[p].get("itemId") for p in range(tu, den + 1) if theo_trang.get(p, {}).get("itemId")), None
        )
        ly_do = dau.get("reason") or ""
        ket_qua.append({"from": tu, "to": den, "itemId": item, "reason": ly_do})
    return ket_qua


_NHAN_LOAI = {"dich": "TRANG DỊCH", "cong_chung": "TRANG CÔNG CHỨNG", "goc": "BẢN GỐC TIẾNG VIỆT"}


QUY_TAC_BAN_DICH = (
    "ĐÂY LÀ BẢN DỊCH: file gộp các BẢN DỊCH TIẾNG ANH (dịch thuật công chứng) giấy tờ của khách — tên người "
    "viết không dấu, tên giấy bằng tiếng Anh (Birth Certificate, Residence confirmation (CT07), Judicial "
    "record, Marriage certificate, Diploma / Transcript, Labour contract, Payslip, Work confirmation letter, "
    "Certificate of land use rights...). Đối chiếu sang tên mục tiếng Việt.\n"
    "- Một BỘ bản dịch = các TRANG DỊCH (tiếng Anh) + TRANG CÔNG CHỨNG (lời cam đoan của người dịch / "
    "công chứng viên) + BẢN GỐC tiếng Việt, theo đúng thứ tự đó. Cả bộ là MỘT đoạn, gán vào mục của giấy được "
    "dịch — KHÔNG tách trang công chứng hay bản gốc thành file riêng. LLTP số 2 và phiếu lương thường KHÔNG "
    "có trang công chứng: trang dịch rồi tới thẳng bản gốc.\n"
    "- Mỗi trang đã được gắn nhãn [TRANG DỊCH] / [TRANG CÔNG CHỨNG] / [BẢN GỐC TIẾNG VIỆT]: một TRANG DỊCH đứng "
    "sau trang công chứng hoặc bản gốc là ĐẦU một bộ mới.\n"
    "- Một bản dịch mới thường bắt đầu bằng quốc hiệu 'SOCIALIST REPUBLIC OF VIETNAM' / 'Independence - "
    "Freedom - Happiness' hoặc tiêu đề giấy tờ mới.\n"
    "- Bảng tính (Excel) phiếu lương / sao kê nhiều tháng là MỘT giấy tờ.\n"
)


def _prompt(
    ten_khach: str, muc: list[MucChecklist], chu: list[str], dau_file: Optional[dict] = None, ban_dich: bool = False
) -> list[dict]:
    loai = [loai_trang(t) for t in chu] if ban_dich else [None] * len(chu)
    danh_sach = "\n".join(f"{m.so} | {m.item.nameVi} | {m.item.section}" for m in muc)
    dau_file = dau_file or {}
    # ZIP nhiều file: ghi tên file gốc ở trang đầu của nó — đầu file gần như luôn là đầu một giấy tờ,
    # và tên file khách đặt ("CCCD me.jpg") thường nói luôn là giấy gì.
    trang = "\n\n".join(
        f"=== TRANG {i + 1} ==="
        + (f" [{_NHAN_LOAI[loai[i]]}]" if loai[i] else "")
        + (f" (BẮT ĐẦU FILE GỐC: {dau_file[i + 1]})" if (i + 1) in dau_file else "")
        + f"\n{(t or '').strip()[:CHU_MOI_TRANG] or '(trang trắng / không đọc được chữ)'}"
        for i, t in enumerate(chu)
    )
    he_thong = (
        "Bạn là nhân viên hồ sơ định cư Canada. Bạn nhận chữ đọc được (OCR) của TỪNG TRANG trong MỘT file "
        "scan gộp nhiều giấy tờ của khách hàng, và danh sách mục checklist của hồ sơ (số | tên mục | thuộc ai). "
        "Hãy chia các trang thành từng GIẤY TỜ và gán mỗi giấy tờ vào đúng MỘT mục.\n"
        "Quy tắc:\n"
        "- Các đoạn LIÊN TIẾP, phủ hết từ trang 1 tới trang cuối, không chồng nhau, theo thứ tự trang.\n"
        "- Một giấy tờ nhiều trang (mặt trước + mặt sau CCCD, hộ chiếu nhiều trang, hợp đồng nhiều trang) là MỘT đoạn.\n"
        "- Phân biệt người: giấy tờ của đương đơn, vợ/chồng, con, bố, mẹ thuộc các mục KHÁC nhau — dựa vào họ tên "
        "trên giấy so với tên đương đơn.\n"
        "- Hai giấy tờ cùng loại khác nhau (vd 2 hợp đồng lao động) thì gán vào các mục đánh số khác nhau "
        "(Hợp đồng lao động, Hợp đồng lao động 2...).\n"
        "- Trang gần như KHÔNG có chữ (vài ký tự rác) đứng riêng giữa hai giấy tờ thường là ẢNH THẺ (ảnh chân dung) "
        "— gán vào mục ảnh thẻ nếu có; KHÔNG gộp nó vào giấy tờ đứng trước.\n"
        "- Hai mặt CCCD (mặt có quốc huy/thông tin + mặt 'Đặc điểm nhân dạng') là MỘT giấy tờ; CCCD của bố/mẹ "
        "thì xem họ tên trên thẻ.\n"
        "- Phiếu lương / sao kê nhiều tháng liền nhau là MỘT giấy tờ (một file) — không tách mỗi tháng một file.\n"
        "- Trang phụ đi kèm thuộc về giấy tờ chính: biên lai / hoá đơn IOM đi cùng giấy khám sức khoẻ; đơn xin xác "
        "nhận + trang chứng thực của UBND là mục 'Thư xác nhận của UBND'.\n"
        "- Tài sản đứng tên bố mẹ (sổ đỏ / quyền sử dụng đất, sổ tiết kiệm của gia đình) VẪN thuộc mục tương ứng "
        "của hồ sơ — đó là tài sản gia đình đương đơn dùng để chứng minh tài chính.\n"
        "- Trang có ghi (BẮT ĐẦU FILE GỐC: ...) là đầu một file khách gửi — thường là đầu một giấy tờ mới; tên "
        "file gốc thường nói luôn là giấy gì.\n"
        "- Không chắc là mục nào thì để \"item\": null.\n"
        + (QUY_TAC_BAN_DICH if ban_dich else "")
        + 'Chỉ trả JSON: {"segments": [{"from": 1, "to": 2, "item": "<số mục>" hoặc null, "reason": "<vì sao, ngắn>"}]}'
    )
    nguoi_dung = (
        f"Tên đương đơn: {ten_khach}\nSố trang: {len(chu)}\n\nDANH SÁCH MỤC CHECKLIST:\n{danh_sach}\n\n"
        f"CHỮ TỪNG TRANG:\n{trang}"
    )
    return [{"role": "system", "content": he_thong}, {"role": "user", "content": nguoi_dung}]


def chia_bang_deepseek(
    ten_khach: str, muc: list[MucChecklist], chu: list[str], dau_file: Optional[dict] = None, ban_dich: bool = False
) -> list[dict]:
    """[{"from", "to", "itemId" | None, "reason"}] phủ đủ trang 1..N. Lỗi thì ném ra."""
    completion = llm.get_deepseek_client().chat.completions.create(
        model=os.environ["DEEPSEEK_MODEL"],
        messages=_prompt(ten_khach, muc, chu, dau_file, ban_dich),
        response_format={"type": "json_object"},
        max_tokens=16000,
        timeout=600,
    )
    noi_dung = completion.choices[0].message.content or ""
    du_lieu = json.loads(noi_dung)
    theo_so = {m.so: m for m in muc}
    tho = []
    for s in du_lieu.get("segments") or []:
        try:
            tu, den = int(s.get("from")), int(s.get("to"))
        except (TypeError, ValueError):
            continue
        so = s.get("item")
        so = str(so).strip().rstrip(".") if so not in (None, "", "null") else None
        m = theo_so.get(so) if so else None
        tho.append({"from": tu, "to": den, "itemId": m.item.id if m else None,
                    "reason": str(s.get("reason") or "")[:300]})
    doan = chuan_hoa_doan(tho, len(chu))
    return theo_cau_truc(doan, [loai_trang(t) for t in chu]) if ban_dich else doan


def chuan_hoa_doan(doan: list[dict], so_trang: int) -> list[dict]:
    """Ép về các đoạn liên tiếp, không chồng, phủ đủ 1..N: cắt phần chồng, trang bị bỏ sót thành
    đoạn "chưa xác định" riêng — AI trả thiếu/chồng thì nhân viên vẫn thấy đủ mọi trang."""
    ket_qua: list[dict] = []
    ke_tiep = 1
    for d in sorted(doan, key=lambda x: (x["from"], x["to"])):
        tu, den = max(d["from"], ke_tiep), min(d["to"], so_trang)
        if tu > den:
            continue
        if tu > ke_tiep:
            ket_qua.append({"from": ke_tiep, "to": tu - 1, "itemId": None, "reason": "AI không xếp trang này"})
        ket_qua.append({**d, "from": tu, "to": den})
        ke_tiep = den + 1
    if ke_tiep <= so_trang:
        ket_qua.append({"from": ke_tiep, "to": so_trang, "itemId": None, "reason": "AI không xếp trang này"})
    return ket_qua


def moi_trang_mot_doan(so_trang: int, ly_do: str) -> list[dict]:
    return [{"from": i, "to": i, "itemId": None, "reason": ly_do} for i in range(1, so_trang + 1)]


# ---------------------------------------------------------------------------
# 4. Tách thật + ZIP
# ---------------------------------------------------------------------------

def ten_cac_file(doan: list[dict], muc: list[MucChecklist], ten_khach: str, ban_dich: bool = False) -> list[str]:
    """Tên từng file theo bảng — trùng tên thì thêm " (2)", " (3)". MỘT chỗ duy nhất cho cả tải ZIP
    lẫn "Đưa vào hồ sơ", để file vào hồ sơ mang đúng tên nhân viên đã thấy."""
    theo_id = {m.item.id: m for m in muc}
    da_dung: dict[str, int] = {}
    ket_qua = []
    for d in doan:
        ten = ten_file(theo_id.get(d.get("itemId") or ""), ten_khach, int(d["from"]), int(d["to"]), ban_dich)
        lan = da_dung.get(ten.casefold(), 0) + 1
        da_dung[ten.casefold()] = lan
        if lan > 1:
            goc_ten, duoi = os.path.splitext(ten)
            ten = f"{goc_ten} ({lan}){duoi}"
        ket_qua.append(ten)
    return ket_qua


def cat_trang(goc: "fitz.Document", tu: int, den: int) -> bytes:
    if not (1 <= tu <= den <= goc.page_count):
        raise ValueError(f"Đoạn trang {tu}-{den} không hợp lệ (file có {goc.page_count} trang).")
    moi = fitz.open()
    try:
        moi.insert_pdf(goc, from_page=tu - 1, to_page=den - 1)
        return moi.tobytes(garbage=3, deflate=True)
    finally:
        moi.close()


def mot_file(
    pdf: bytes, doan: list[dict], vi_tri: int, muc: list[MucChecklist], ten_khach: str, ban_dich: bool = False
) -> tuple[bytes, str]:
    """File thứ `vi_tri` trong bảng (PDF + tên) — cho nút "Đưa vào hồ sơ"."""
    if not 0 <= vi_tri < len(doan):
        raise ValueError("Không có file này trong bảng.")
    ten = ten_cac_file(doan, muc, ten_khach, ban_dich)[vi_tri]
    goc = fitz.open(stream=pdf, filetype="pdf")
    try:
        return cat_trang(goc, int(doan[vi_tri]["from"]), int(doan[vi_tri]["to"])), ten
    finally:
        goc.close()


def tao_zip(
    pdf: bytes, doan: list[dict], muc: list[MucChecklist], ten_khach: str, ban_dich: bool = False
) -> tuple[bytes, list[str]]:
    ten_list = ten_cac_file(doan, muc, ten_khach, ban_dich)
    goc = fitz.open(stream=pdf, filetype="pdf")
    buf = io.BytesIO()
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for d, ten in zip(doan, ten_list):
                z.writestr(ten, cat_trang(goc, int(d["from"]), int(d["to"])))
    finally:
        goc.close()
    return buf.getvalue(), ten_list


def anh_trang(pdf: bytes, so: int, dpi: int = 60) -> bytes:
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        if not 1 <= so <= doc.page_count:
            raise IndexError
        return doc[so - 1].get_pixmap(dpi=dpi).tobytes("png")
    finally:
        doc.close()
