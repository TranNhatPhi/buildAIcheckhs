"""Kiểm tra bộ hồ sơ DỊCH THUẬT (bản dịch tiếng Anh của giấy tờ khách) bằng QUY TẮC trong code
— không gọi AI, cùng tinh thần với filename_rules.py: luôn cho cùng một kết quả, chạy tức thì,
và nói rõ được vì sao báo lỗi.

Quy tắc rút ra từ bộ hồ sơ dịch thuật thật trong hosodichthuat/ (13 bản dịch hồ sơ "Hồ Sỹ Trọng"):
  - Họ tên người trong bản dịch viết HOA, BỎ DẤU: "Hồ Sỹ Trọng" -> "HO SY TRONG". Cả 13 bản đều
    theo quy ước này, và KHÔNG bản nào còn sót chữ tiếng Việt có dấu.
  - Lỗi đáng giá nhất là CÙNG MỘT NGƯỜI mà mỗi bản ghi một kiểu — chính bộ mẫu đó có thật: tên
    bố ghi "HO XUAN TINH" (CT07, LLTP), "HO SY TINH" (giấy khai sinh), "HO SI TINH" (học bạ);
    tên đương đơn ghi "HO SI TRONG" riêng ở học bạ trong khi 12 bản còn lại là "HO SY TRONG".
    Người soát tay rất dễ lướt qua vì mỗi bản đứng riêng đều trông hợp lý.
Tên người ký của cơ quan (vd "Nguyen Van Quy") viết kiểu Title Case — quy ước chỉ áp cho tên
đương sự, nên chỉ nhận diện tên viết HOA để khỏi báo oan.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import date
from xml.etree import ElementTree as ET

import fitz  # PyMuPDF

import ocr

# ---------------------------------------------------------------------------
# Chuẩn hoá tên
# ---------------------------------------------------------------------------


def fix_mojibake(text: str) -> str:
    """Sửa tên file kiểu "Ho╠é╠Ç Sy╠â Tro╠úng" về "Hồ Sỹ Trọng".

    Gặp thật ở chính bộ mẫu: file nén trên macOS (tên dạng Unicode TÁCH DẤU) rồi giải nén bằng
    Windows — byte UTF-8 bị đọc nhầm thành bảng mã CP437 ("╠é" là 2 byte của dấu mũ tách
    rời). Dữ liệu không mất, chỉ đọc sai bảng mã, nên đọc lại đúng bảng mã là khôi phục được.
    Không sửa được thì trả nguyên văn — thà giữ tên lạ còn hơn đoán bừa.

    Chỉ ra tay khi có ký tự kẻ khung (U+2500-U+257F): dấu tách rời (U+0300-U+036F) và chữ Đ
    trong UTF-8 luôn mở đầu bằng byte 0xCC/0xCD/0xC4, mà CP437 hiện các byte đó thành ký tự kẻ
    khung — tên tiếng Việt viết đúng không bao giờ chứa loại ký tự này.

    Làm TỪNG KÝ TỰ chứ không cả chuỗi: tên thật trong bộ mẫu lẫn cả phần hỏng và phần đúng
    ("Ho╠é╠Ç Sy╠â ... - Thư XNKN(dịch)" — chữ "ị" viết đúng, không có trong CP437), đổi cả chuỗi
    sang CP437 là hỏng ngay ở chữ đó. Ký tự nào không thuộc CP437 thì vốn đã đúng — giữ nguyên
    byte UTF-8 của nó."""
    if not any(0x2500 <= ord(c) <= 0x257F for c in text):
        return text
    raw = bytearray()
    for c in text:
        try:
            raw += c.encode("cp437")
        except UnicodeEncodeError:
            raw += c.encode("utf-8")
    try:
        return unicodedata.normalize("NFC", bytes(raw).decode("utf-8"))
    except UnicodeDecodeError:
        return text


def to_translation_form(name: str) -> str:
    """Dạng tên chuẩn trong bản dịch: bỏ dấu, viết hoa, gọn khoảng trắng."""
    s = unicodedata.normalize("NFD", name)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("đ", "d").replace("Đ", "D").upper()
    return " ".join(re.sub(r"[^A-Z ]", " ", s).split())


# Họ phổ biến của người Việt (dạng bỏ dấu). Tên người trong bản dịch được nhận diện là chuỗi
# chữ HOA bắt đầu bằng một họ ở đây — cộng thêm họ của đương đơn và của chủ từng file, để họ
# hiếm vẫn nhận ra được.
_SURNAMES = set(
    "NGUYEN TRAN LE PHAM HOANG HUYNH PHAN VU VO DANG BUI DO HO NGO DUONG LY DINH TRINH DAO LAM "
    "MAI TA CHU CAO LUONG LUU TRUONG HA TONG THAI KIEU LA QUACH TANG VUONG KHUC DOAN HUA TIEU "
    "LU TO MAC PHUNG BACH NONG CU DIEP GIANG LAI QUAN THAN TON UNG VI VIEN KHONG KIM".split()
)

# Địa danh viết HOA ở tiêu đề bản dịch ("HA TINH PROVINCE PUBLIC SECURITY") trùng khuôn tên
# người vì bắt đầu bằng một họ — loại ra để không bị coi là người.
_PLACE_NAMES = {
    "HA NOI", "HA TINH", "HA NAM", "HA GIANG", "HO CHI MINH", "CAO BANG", "THAI BINH",
    "THAI NGUYEN", "LAI CHAU", "LAM DONG", "LANG SON", "VINH LONG", "HAI PHONG",
}

# Một âm tiết tiếng Việt khi đã bỏ dấu: phụ âm đầu (tuỳ chọn) + 1-3 nguyên âm + âm cuối (tuỳ
# chọn). Dùng để biết chuỗi chữ HOA sau họ còn là TÊN hay đã sang chữ tiếng Anh: "HO SY TRONG SEX"
# dừng trước "SEX" (x không làm âm cuối được), "HO SY TRONG DATE OF" dừng trước "DATE".
_SYLLABLE = re.compile(r"^(NGH|NG|NH|CH|KH|PH|TH|TR|GI|GH|QU|[BCDGHKLMNPRSTVX])?[AEIOUY]{1,3}(NG|NH|CH|[CMNPT])?$")

_VIETNAMESE_CHARS = re.compile(
    r"[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]", re.IGNORECASE
)


# Vai trò của người đứng sau nhãn, đọc từ chính nhãn trong bản dịch. Có vai trò thì nhân viên
# mới đánh giá được một tên lệch là lỗi hay là người khác: trong bộ mẫu, "HO XUAN TINH" ở CT07
# nằm ở dòng "of the householder" (chủ hộ) còn ở lý lịch tư pháp lại là "Full name of father" —
# chủ hộ với bố không nhất thiết là một người.
# XẾP THEO THỨ TỰ ƯU TIÊN: "Full name of father" chứa cả "name" lẫn "father", phải ra "bố".
_ROLES: list[tuple[str, str]] = [
    ("bố", r"father"),
    ("mẹ", r"mother"),
    ("chủ hộ", r"householder|head of (the )?household"),
    ("vợ", r"\bwife\b"),
    ("chồng", r"\bhusband\b"),
    ("vợ/chồng", r"spouse"),
    ("con", r"\bson\b|\bdaughter\b|\bchild\b"),
    ("người khai", r"declarant|informant"),
    ("học sinh", r"student"),
    ("người ký/cán bộ", r"signed|signatory|chairman|registrar|on behalf|lt\.|col\.|head of division"),
]


def _role_from_context(context: str) -> str | None:
    """Vai trò đọc từ phần chữ ĐỨNG TRƯỚC tên trên cùng một dòng."""
    low = context.lower()
    for role, pattern in _ROLES:
        if re.search(pattern, low):
            return role
    return None


# "Relationship with the householder: Son" trong CT07/sổ hộ khẩu nói ĐƯƠNG SỰ là con CỦA chủ hộ
# -> chủ hộ chính là bố hoặc mẹ. Không đọc dòng này thì tên chủ hộ ghi lệch so với tên bố ở giấy
# khác chỉ bị xem là "hai người khác nhau" và lọt lưới — đúng bộ mẫu thật: CT07 ghi chủ hộ
# "HO XUAN TINH" còn giấy khai sinh ghi bố "HO SY TINH", cùng một người.
# Lấy lần xuất hiện ĐẦU TIÊN: đó là mục 12 nói về chính đương sự, các dòng sau là quan hệ của
# những người khác trong hộ (mục II).
_HOUSEHOLDER_RELATION = re.compile(
    r"relationship\s+with\s+(?:the\s+)?(?:householder|head\s+of\s+(?:the\s+)?household)\s*[:.]?\s*([^\n]{0,40})",
    re.IGNORECASE)

# Quan hệ của ĐƯƠNG SỰ với chủ hộ -> chủ hộ là ai. Giấy không ghi chủ hộ là nam hay nữ nên
# "Son/Daughter" chỉ ra được tới mức "bố/mẹ".
_HOUSEHOLDER_IS: list[tuple[str, str]] = [
    (r"\b(son|daughter|child)\b", "bố/mẹ"),
    (r"\b(wife|husband|spouse)\b", "vợ/chồng"),
    (r"\b(father|mother|parent)\b", "con"),
]


def householder_role(text: str) -> str | None:
    """Chủ hộ là ai trong nhà, suy từ dòng "Relationship with the householder"."""
    m = _HOUSEHOLDER_RELATION.search(text)
    if not m:
        return None
    value = m.group(1).lower()
    # "grandson" có chữ "son", "brother-in-law" có "brother" — họ hàng thì không suy ra bố mẹ
    # được, để nguyên "chủ hộ" còn hơn đoán sai rồi báo đỏ oan.
    if re.search(r"grand|nephew|niece|brother|sister|uncle|aunt|cousin|in[- ]law", value):
        return None
    for pattern, role in _HOUSEHOLDER_IS:
        if re.search(pattern, value):
            return role
    return None


# Vai trò CHỈ ĐÍCH DANH một người trong nhà -> hai tên khác nhau cùng đứng ở đó là sai thật
# (báo đỏ). Các vai trò còn lại ("con", "học sinh", "người khai", "người ký/cán bộ") mỗi bản một
# người là chuyện bình thường: nhà nhiều con, mỗi giấy một người khai và một cán bộ ký.
_IDENTITY_ROLE_SLOTS: dict[str, frozenset[str]] = {
    "bố": frozenset({"bố"}),
    "mẹ": frozenset({"mẹ"}),
    "vợ": frozenset({"vợ/chồng"}),
    "chồng": frozenset({"vợ/chồng"}),
    "vợ/chồng": frozenset({"vợ/chồng"}),
    "chủ hộ": frozenset({"chủ hộ"}),
    # Chủ hộ đã tra ra là bố/mẹ thì đụng CẢ ô "bố" lẫn ô "mẹ": ghi lệch so với bố hay mẹ đều sai
    # như nhau, mà giấy lại không nói chủ hộ là nam hay nữ.
    "chủ hộ = bố/mẹ": frozenset({"bố", "mẹ", "chủ hộ"}),
    "chủ hộ = vợ/chồng": frozenset({"vợ/chồng", "chủ hộ"}),
    "chủ hộ = con": frozenset({"con", "chủ hộ"}),
}


def _case_style(token: str) -> str | None:
    if len(token) < 2 or not token.isalpha():
        return "upper" if token.isupper() and token.isalpha() else None
    if token.isupper():
        return "upper"
    if token[0].isupper() and token[1:].islower():
        return "title"
    return None


@dataclass
class NameHit:
    name: str          # đã đưa về chữ HOA để so sánh
    is_upper: bool     # có được VIẾT HOA sẵn trong bản dịch không
    role: str | None   # bố / mẹ / chủ hộ... đọc từ nhãn đứng trước tên; None = không rõ


def find_names(text: str, extra_surnames: set[str]) -> list[NameHit]:
    """Các họ tên người trong văn bản theo thứ tự gặp, có lặp.

    Nhận CẢ tên viết HOA ("HO SY TRONG") lẫn viết kiểu Title Case ("Ho Si Tinh"): bộ mẫu thật
    có học bạ ghi tên bố là "Ho Si Tinh" trong khi các bản khác ghi "HO XUAN TINH" — chỉ bắt
    tên viết HOA là bỏ lọt đúng chỗ lệch đó. Tên phải cùng MỘT kiểu chữ từ đầu tới cuối, nên
    "HO SY TRONG Sex" dừng trước "Sex".

    Đi TỪNG DÒNG để còn lấy được nhãn đứng trước tên ("Full name of father:", "of the
    householder:") — đó là thứ cho biết tên đó là của ai trong nhà."""
    surnames = _SURNAMES | extra_surnames
    hits: list[NameHit] = []
    for line in unicodedata.normalize("NFC", text).splitlines():
        # Mỗi cụm chỉ gồm chữ cái và khoảng trắng đơn: tên không bao giờ vắt qua dấu ":", ","
        # hay "|" (ô bảng), nên cắt ở đó là đủ tách nhãn khỏi tên.
        for chunk in re.finditer(r"[A-Za-z]+(?: [A-Za-z]+)*", line):
            tokens = chunk.group().split()
            i = 0
            while i < len(tokens):
                style = _case_style(tokens[i])
                if style and tokens[i].upper() in surnames:
                    j = i + 1
                    while (j < len(tokens) and j - i < 5 and _case_style(tokens[j]) == style
                           and _SYLLABLE.match(tokens[j].upper())):
                        j += 1
                    if j - i >= 2:
                        name = " ".join(tokens[i:j]).upper()
                        if name not in _PLACE_NAMES:
                            # Nhãn = chữ trước cụm này trên cùng dòng, cộng phần chữ trong cụm
                            # đứng trước tên (vd "Student s full name HO SY TRONG").
                            context = line[: chunk.start()] + " " + " ".join(tokens[:i])
                            hits.append(NameHit(name, style == "upper", _role_from_context(context)))
                        i = j
                        continue
                i += 1
    return hits


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def variant_kind(a: str, b: str) -> str | None:
    """Hai tên có phải CÙNG MỘT NGƯỜI bị ghi khác nhau không.

    "middle": cùng họ, cùng tên, khác tên đệm — HO XUAN TINH / HO SY TINH / HO SI TINH.
    "given":  cùng họ + tên đệm, tên lệch đúng 1 chữ cái (gõ nhầm: TRONG / TRONH) — để mức cảnh
              báo vì anh em ruột thỉnh thoảng có tên chỉ khác 1 chữ thật.
    Anh em cùng họ + tên đệm nhưng khác hẳn tên (HO SY TRONG / HO SY TRUYEN) KHÔNG tính."""
    if a == b:
        return None
    ta, tb = a.split(), b.split()
    if len(ta) < 2 or len(tb) < 2 or ta[0] != tb[0]:
        return None
    if ta[-1] == tb[-1] and ta[1:-1] != tb[1:-1]:
        return "middle"
    if ta[:-1] == tb[:-1] and len(ta[-1]) >= 3 and _edit_distance(ta[-1], tb[-1]) == 1:
        return "given"
    return None


# ---------------------------------------------------------------------------
# Đọc chữ từ file
# ---------------------------------------------------------------------------

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_part_text(xml: bytes) -> str:
    """Chữ HIỂN THỊ của một phần .docx, tính cả định dạng "All Caps": người dịch gõ thường rồi
    bật caps thì trên giấy là chữ HOA — đọc chữ thô sẽ thành chữ thường và báo oan."""
    out: list[str] = []
    caps = False
    for event, el in ET.iterparse(io.BytesIO(xml), events=("start", "end")):
        tag = el.tag
        if event == "start":
            if tag == _W + "r":
                caps = False
            elif tag in (_W + "caps", _W + "smallCaps"):
                caps = el.get(_W + "val", "true") not in ("false", "0", "off")
        else:
            if tag == _W + "t" and el.text:
                out.append(el.text.upper() if caps else el.text)
            elif tag == _W + "tab":
                out.append("\t")
            elif tag in (_W + "br", _W + "p"):
                out.append("\n")
            elif tag == _W + "tc":
                out.append(" | ")
    return "".join(out)


def _docx_text(content: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        # Tiêu đề/chân trang có tiêu ngữ, tên cơ quan — nằm ở file riêng, không có trong
        # document.xml.
        parts = sorted(n for n in z.namelist() if re.match(r"word/(document|header\d*|footer\d*)\.xml$", n))
        return "\n".join(_docx_part_text(z.read(n)) for n in parts)


ANTIWORD = os.getenv("ANTIWORD_PATH") or shutil.which("antiword") or "antiword"


def _doc_text(content: bytes) -> str:
    """File Word đời cũ (.doc) — dùng antiword. Ghi ra file tạm tên ASCII: antiword trên Windows
    không mở được đường dẫn có chữ tiếng Việt (đã gặp thật với chính bộ mẫu)."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "input.doc")
        with open(path, "wb") as f:
            f.write(content)
        try:
            r = subprocess.run([ANTIWORD, "-m", "UTF-8.txt", "-w", "0", path],
                               capture_output=True, timeout=60)
        except FileNotFoundError as e:
            raise ValueError("Máy chủ chưa cài antiword để đọc file .doc — lưu lại thành .docx rồi upload.") from e
        if r.returncode != 0:
            raise ValueError("Không đọc được file .doc (có thể file hỏng hoặc thực ra không phải .doc).")
        return r.stdout.decode("utf-8", "replace")


def extract_text(content: bytes, filename: str) -> str:
    ext = os.path.splitext(filename.lower())[1]
    if ext == ".docx":
        text = _docx_text(content)
    elif ext == ".doc":
        text = _doc_text(content)
    elif ext == ".pdf":
        with fitz.open(stream=content, filetype="pdf") as doc:
            text = "\n".join(page.get_text() for page in doc)
        # PDF scan không có lớp chữ -> đọc ảnh bằng Tesseract (không gọi AI).
        if len(text.strip()) < 50:
            text, *_ = ocr.extract_text(content, filename, "application/pdf", use_gemini=False)
    elif ext in (".jpg", ".jpeg", ".png", ".webp"):
        text, *_ = ocr.extract_text(content, filename, "image/jpeg", use_gemini=False)
    else:
        raise ValueError("Chỉ nhận file .docx, .doc, .pdf hoặc ảnh (.jpg, .png, .webp).")
    return unicodedata.normalize("NFC", text)


# ---------------------------------------------------------------------------
# Quy tắc
# ---------------------------------------------------------------------------


@dataclass
class FileReport:
    filename: str
    owner_name: str | None = None      # chủ giấy tờ, đọc từ tên file theo quy ước "<số>. <Họ tên> - <loại>"
    owner_form: str | None = None
    names: list[str] = field(default_factory=list)       # mọi tên, đã đưa về chữ HOA
    upper_names: set[str] = field(default_factory=set)   # tên được VIẾT HOA sẵn trong bản dịch
    roles: dict[str, set[str]] = field(default_factory=dict)  # tên -> vai trò (bố, mẹ, chủ hộ...)
    id_numbers: list[str] = field(default_factory=list)
    chars: int = 0
    error: str | None = None
    text: str = ""


@dataclass
class Finding:
    severity: str          # "ERROR" | "WARNING"
    rule: str
    title: str
    message: str
    files: list[str] = field(default_factory=list)


def owner_from_filename(filename: str) -> str | None:
    """"26.1 Nguyễn Thị Thuý - GKS (Bản gốc).doc" -> "Nguyễn Thị Thuý". None nếu tên file không
    theo quy ước (thiếu " - ", hoặc phần trước " - " không giống họ tên)."""
    stem = os.path.splitext(fix_mojibake(unicodedata.normalize("NFC", filename)))[0]
    stem = re.sub(r"^\s*[\d.]+\s*[._\-)]?\s*", "", stem)
    stem = re.sub(r"\((?:dịch|dich|bản dịch|translated)\)", "", stem, flags=re.IGNORECASE).strip()
    if " - " not in stem:
        return None
    candidate = stem.split(" - ", 1)[0].strip()
    words = candidate.split()
    if not 2 <= len(words) <= 5 or not all(re.fullmatch(r"[^\W\d_]+", w) for w in words):
        return None
    return candidate


_DATE = re.compile(r"(?<!\d)(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?!\d)")
_ID = re.compile(r"(?<!\d)(\d{12}|\d{9})(?!\d)")


def check_translation_set(applicant_name: str, files: list[FileReport]) -> list[Finding]:
    expected = to_translation_form(applicant_name)
    extra_surnames = {expected.split()[0]} | {f.owner_form.split()[0] for f in files if f.owner_form}
    readable = [f for f in files if not f.error]
    for f in readable:
        found = find_names(f.text, extra_surnames)
        f.names = [h.name for h in found]
        f.upper_names = {h.name for h in found if h.is_upper}
        f.roles = {}
        # Chủ hộ trong giấy này thực ra là bố/mẹ (hay vợ/chồng, con) của đương sự thì ghi thẳng
        # như vậy, để so tên với các giấy khác và để nhân viên đọc báo cáo hiểu ngay là ai.
        chu_ho = householder_role(f.text)
        for h in found:
            if h.role:
                f.roles.setdefault(h.name, set()).add(
                    f"chủ hộ = {chu_ho}" if h.role == "chủ hộ" and chu_ho else h.role)
        f.id_numbers = sorted(set(_ID.findall(f.text)))
    findings: list[Finding] = []

    # 1. Tên đương đơn bị ghi thành tên khác (lệch tên đệm / gõ nhầm tên).
    for f in readable:
        seen = set()
        for n in f.names:
            kind = variant_kind(expected, n)
            if kind and n not in seen:
                seen.add(n)
                findings.append(Finding(
                    "ERROR" if kind == "middle" else "WARNING", "APPLICANT_NAME_VARIANT",
                    "Tên đương đơn bị ghi khác",
                    f'Bản dịch ghi "{n}" — tên đương đơn phải là "{expected}".', [f.filename]))

    # 2. Cùng một người (không phải đương đơn) mà mỗi bản ghi một kiểu.
    where: dict[str, set[str]] = {}
    for f in readable:
        for n in set(f.names):
            where.setdefault(n, set()).add(f.filename)
    groups: list[set[str]] = []
    for n in sorted(where):
        if n == expected or variant_kind(expected, n):
            continue  # đã báo ở quy tắc 1
        for g in groups:
            if any(variant_kind(n, m) for m in g):
                g.add(n)
                break
        else:
            groups.append({n})
    for g in groups:
        if len(g) < 2:
            continue
        kinds = {variant_kind(a, b) for a in g for b in g if a != b} - {None}
        # Ghi rõ tên đó đứng ở vai trò nào trong TỪNG bản: cùng một ô (bố, mẹ, vợ/chồng, chủ hộ)
        # mà mấy tên khác nhau thì chắc chắn sai, còn "chủ hộ" không rõ là ai với "bố" ở bản kia
        # thì có thể là hai người thật — chỉ cảnh báo.
        parts = []
        by_slot: dict[str, set[str]] = {}
        for n in sorted(g, key=lambda n: -len(where[n])):
            noi = []
            for fname in sorted(where[n]):
                roles = next((f.roles.get(n, set()) for f in readable if f.filename == fname), set())
                for r in roles:
                    for slot in _IDENTITY_ROLE_SLOTS.get(r, ()):
                        by_slot.setdefault(slot, set()).add(n)
                noi.append(f"{', '.join(sorted(roles))} ở {fname}" if roles else fname)
            parts.append(f'"{n}" ({"; ".join(noi)})')
        conflicting = {r: names for r, names in by_slot.items() if len(names) > 1}
        if conflicting:
            them = " Cùng vai trò " + ", ".join(f'"{r}"' for r in sorted(conflicting)) + " mà tên lại khác nhau."
        else:
            them = (" Các bản ghi ở vai trò khác nhau nên CÓ THỂ là hai người khác nhau — xem lại "
                    "trước khi sửa.")
        findings.append(Finding(
            "ERROR" if conflicting and "middle" in kinds else "WARNING", "NAME_INCONSISTENT",
            "Cùng một người nhưng các bản ghi tên khác nhau",
            "Có vẻ là cùng một người nhưng tên không thống nhất: " + "; ".join(parts) + "."
            + them + " Đối chiếu với bản gốc (CCCD/khai sinh) để sửa cho đúng.",
            sorted(set().union(*(where[n] for n in g)))))

    # 3. Còn chữ tiếng Việt có dấu (chưa dịch hết / quên bỏ dấu).
    for f in readable:
        words = sorted({w for w in re.findall(r"\S+", f.text) if _VIETNAMESE_CHARS.search(w)})
        if words:
            shown = ", ".join(f'"{w}"' for w in words[:10]) + (f" và {len(words) - 10} từ khác" if len(words) > 10 else "")
            findings.append(Finding("ERROR", "UNTRANSLATED_VIETNAMESE", "Còn chữ tiếng Việt có dấu",
                                    f"Bản dịch còn {len(words)} từ tiếng Việt có dấu: {shown}.", [f.filename]))

    # 4. Tên chủ giấy tờ (theo tên file) phải có trong bản dịch, viết HOA không dấu. Chỉ cần
    # viết HOA ở ÍT NHẤT MỘT chỗ: tên của chính đương sự dưới dòng "(Signed)" viết kiểu Title
    # Case là đúng quy ước bộ mẫu (vd "Ho Sy Trong" ở chữ ký trên giấy đăng ký kết hôn).
    for f in readable:
        if not f.owner_form or f.owner_form in f.upper_names:
            continue
        upper_text = " ".join(re.sub(r"[^A-Za-z ]+", " ", f.text).split())
        if f.owner_form in f.names or re.search(rf"\b{re.escape(f.owner_form)}\b", upper_text.upper()):
            findings.append(Finding("WARNING", "OWNER_NAME_NOT_UPPERCASE", "Họ tên chưa viết HOA",
                                    f'"{f.owner_name}" có trong bản dịch nhưng không viết HOA như quy ước '
                                    f'("{f.owner_form}").', [f.filename]))
        elif not any(variant_kind(f.owner_form, n) for n in f.names):
            findings.append(Finding("WARNING", "OWNER_NAME_MISSING", "Không thấy tên chủ giấy tờ",
                                    f'Tên file cho biết đây là giấy tờ của "{f.owner_name}" nhưng bản dịch không có '
                                    f'"{f.owner_form}".', [f.filename]))
        else:
            variants = sorted({n for n in f.names if variant_kind(f.owner_form, n)})
            if f.owner_form != expected:  # tên đương đơn đã báo ở quy tắc 1
                findings.append(Finding("ERROR", "OWNER_NAME_VARIANT", "Tên chủ giấy tờ bị ghi khác",
                                        f'Bản dịch ghi {", ".join(chr(34) + v + chr(34) for v in variants)} — tên theo '
                                        f'tên file là "{f.owner_form}".', [f.filename]))

    # 5. Số định danh gần giống nhau giữa các bản (lệch 1-2 chữ số) — nhiều khả năng gõ nhầm.
    id_where: dict[str, set[str]] = {}
    for f in readable:
        for n in f.id_numbers:
            id_where.setdefault(n, set()).add(f.filename)
    ids = sorted(id_where)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if len(a) == len(b) and 0 < sum(x != y for x, y in zip(a, b)) <= 2:
                findings.append(Finding(
                    "WARNING", "ID_NEAR_DUPLICATE", "Số giấy tờ gần giống nhau",
                    f'"{a}" ({", ".join(sorted(id_where[a]))}) và "{b}" ({", ".join(sorted(id_where[b]))}) '
                    f"chỉ lệch {sum(x != y for x, y in zip(a, b))} chữ số — kiểm tra có gõ nhầm không.",
                    sorted(id_where[a] | id_where[b])))

    # 6. Ngày tháng không tồn tại (31/02, tháng 13...).
    for f in readable:
        bad = []
        for d, m, y in _DATE.findall(f.text):
            try:
                date(int(y), int(m), int(d))
            except ValueError:
                bad.append(f"{d}/{m}/{y}")
        if bad:
            findings.append(Finding("ERROR", "INVALID_DATE", "Ngày tháng không hợp lệ",
                                    f"Ngày không tồn tại: {', '.join(sorted(set(bad)))}.", [f.filename]))

    order = {"ERROR": 0, "WARNING": 1}
    findings.sort(key=lambda x: (order[x.severity], x.rule, x.files))
    return findings
