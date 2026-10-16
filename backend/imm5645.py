"""Điền form IMM 5645E (Family Information) từ giấy tờ trong hồ sơ — tab "Điền form IMM5645e" (14/10/2026).

Quy tắc lấy thông tin theo yêu cầu Docs (imm5645/yc.txt):
  - Đương đơn: họ tên, tình trạng hôn nhân, ngày sinh (YYYY-MM-DD), nước sinh Vietnam; ĐỊA CHỈ ưu tiên ① CT07
    (xác nhận cư trú) ② CCCD — KHÔNG lấy địa chỉ từ phiếu thông tin.
  - Mẹ (và bố, vợ/chồng — form có ô, cùng cách): họ tên, tình trạng hôn nhân, ngày sinh, nước sinh Vietnam,
    địa chỉ ① CT07 ② CCCD.
  - Con: từ Giấy khai sinh. Anh chị em: từ Phiếu thông tin khách hàng.
Loại hồ sơ (Visitor / Worker) theo "Mục đích đi" của hồ sơ.

CÁCH GHI theo file mẫu Docs đã nộp (imm5645/2.1 file so khop.pdf, 14/10/2026): họ tên Chữ Hoa Đầu Từ không dấu
("Ho Sy Hoi"); địa chỉ tiếng Anh KHÔNG thêm ", Vietnam" ("Hamlet 8, Dong Thanh Commune, Nghe An Province"); tình
trạng hôn nhân ghi gọn "Single" / "Married"; CÓ ghi nghề nghiệp (kể cả đương đơn, vd "Farm worker"); quan hệ anh chị
em "Older brother" / "Younger sister"...; người thân tick "NO" ở cột đi cùng; có ngày ký. Chữ Courier New 8pt (ô tình
trạng hôn nhân 6,1pt) — đúng font form khai báo.

Các bước: gom CHỮ ĐÃ ĐỌC của giấy tờ liên quan -> DeepSeek trích JSON -> `kiem_tra` LỌC / sửa các lỗi hay gặp và
liệt kê chỗ cần xem -> nhân viên xem / sửa trên giao diện (lưu Case.imm5645Data) -> điền PDF.

PDF mẫu (mau_form/imm5645e.pdf) là form LAI AcroForm + XFA: Adobe Reader vẽ theo lớp XFA, trình duyệt / máy in
theo AcroForm — nên điền CẢ HAI (`dien_pdf`), không thì mở bằng Adobe thấy trống.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import unicodedata
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import fitz
import numpy as np
from PIL import Image, ImageOps

import llm

logger = logging.getLogger(__name__)

MAU = Path(__file__).parent / "mau_form" / "imm5645e.pdf"
# Model DeepSeek RIÊNG cho form này: bản PRO (Docs yêu cầu 14/10/2026 — điền form nộp chính phủ cần đọc kỹ hơn bản
# flash dùng chung ở DEEPSEEK_MODEL). Đổi qua biến môi trường IMM5645_DEEPSEEK_MODEL nếu cần.
MODEL_AI = os.getenv("IMM5645_DEEPSEEK_MODEL", "deepseek-v4-pro")
SO_CON = 4  # Section B
SO_ANH_CHI_EM = 7  # Section C

# Tình trạng hôn nhân trên form: mã lưu XFA (items save) -> chữ. "Married" (cách ghi gọn trong file mẫu Docs) không có
# mã — XFA lưu nguyên chữ, Adobe hiện đúng chữ đó.
TINH_TRANG = {
    "1": "Annulled marriage", "2": "Common-law", "3": "Divorced", "4": "Legally separated",
    "5": "Married-physically present", "6": "Married-not physically present", "7": "Single", "8": "Widowed",
}
TINH_TRANG_HIEN = ["Single", "Married", *[v for k, v in TINH_TRANG.items() if v != "Single"]]
_MA_TINH_TRANG = {v.lower(): k for k, v in TINH_TRANG.items()}
LOAI_HO_SO = ("Visitor", "Worker", "Student", "Other")

# Giấy tờ đưa cho AI — theo TÊN MỤC checklist (đủ cho cả LOW/HIGH, vợ chồng, con, bố mẹ).
_MUC_LIEN_QUAN = re.compile(r"phiếu tt|cư trú|ct07|căn cước|chứng minh|khai sinh|kết hôn|ly hôn", re.IGNORECASE)
CHU_TOI_DA_PHIEU = 14000
CHU_TOI_DA_GIAY = 3000
_NGAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def bo_dau(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "").replace("đ", "d").replace("Đ", "D")
    return " ".join("".join(c for c in s if unicodedata.category(c) != "Mn").split())


def ten_chuan(s: str) -> str:
    """"TRẦN VĂN HÙNG" -> "Tran Van Hung" (cách ghi trong file mẫu Docs)."""
    return " ".join(w[:1].upper() + w[1:].lower() for w in bo_dau(s).split())


def hom_nay_vn() -> str:
    return datetime.now(timezone(timedelta(hours=7))).date().isoformat()


# ---------------------------------------------------------------------------
# 1. Gom chữ giấy tờ
# ---------------------------------------------------------------------------

def giay_to_lien_quan(case) -> list[dict]:
    """[{ten_muc, file, chu}] các giấy tờ dùng để điền form, phiếu TT đứng đầu."""
    ra = []
    for d in case.documents:
        muc = d.matchedChecklistItem
        if muc is None or not _MUC_LIEN_QUAN.search(muc.nameVi or ""):
            continue
        chu = (d.manualCorrectedText or d.correctedText or d.ocrText or "").strip()
        if not chu:
            continue
        la_phieu = "phiếu tt" in (muc.nameVi or "").lower()
        ra.append({"ten_muc": muc.nameVi, "file": d.originalFilename, "phieu": la_phieu,
                   "chu": chu[: CHU_TOI_DA_PHIEU if la_phieu else CHU_TOI_DA_GIAY]})
    ra.sort(key=lambda x: (not x["phieu"], x["ten_muc"], x["file"]))
    return ra


# ---------------------------------------------------------------------------
# 2. DeepSeek trích thông tin
# ---------------------------------------------------------------------------

_NGUOI = '"name": "", "gender": "M|F", "dob": "YYYY-MM-DD", "cob": "Vietnam", "maritalStatus": "", "address": "", "occupation": "", "nguon": ""'

HE_THONG = f"""Bạn là nhân viên hồ sơ định cư Canada, điền form IMM 5645E (Family Information) bằng TIẾNG ANH.
Bạn nhận chữ đọc được (OCR, có thể sai chính tả) của các giấy tờ: Phiếu thông tin khách hàng (PTTKH), CT07 (xác
nhận cư trú), CCCD/CMND, Giấy khai sinh (GKS), đăng ký kết hôn. Trích thông tin theo ĐÚNG quy tắc:

- ĐƯƠNG ĐƠN: họ tên, giới tính, ngày sinh, nước sinh "Vietnam", tình trạng hôn nhân. ĐỊA CHỈ theo thứ tự ưu tiên
  ① CT07 (nơi thường trú / nơi ở hiện tại) ② CCCD (nơi thường trú / nơi cư trú). KHÔNG lấy địa chỉ từ PTTKH.
  Nghề nghiệp hiện tại: công việc HIỆN TẠI trong PTTKH (lịch sử công việc, dòng "đến nay"), dịch sang tiếng Anh ngắn
  gọn (vd "Farm worker", "Factory worker", "Construction worker"); không có thì lấy "Nghề nghiệp trong hồ sơ".
- MẸ, BỐ: họ tên, ngày sinh, nước sinh "Vietnam", tình trạng hôn nhân, nghề nghiệp (PTTKH, tiếng Anh); địa chỉ ① CT07
  (dòng mẹ/bố trong danh sách thành viên hộ, cùng hộ thì dùng địa chỉ hộ) ② CCCD của mẹ/bố ③ PTTKH. Đã mất: occupation
  "Deceased", address ghi "Deceased - <ngày YYYY-MM-DD>, <tỉnh/thành>" nếu có.
- VỢ/CHỒNG (chỉ khi đương đơn đã kết hôn): nguồn PTTKH, CCCD vợ/chồng, đăng ký kết hôn.
- CON: từ GKS của con (họ tên, ngày sinh, nơi sinh -> "Vietnam"), giới tính; tình trạng hôn nhân thường "Single";
  địa chỉ theo PTTKH, không có thì địa chỉ đương đơn; nghề nghiệp (vd "Student") theo PTTKH.
- ANH CHỊ EM: từ PTTKH (gồm cả cùng cha khác mẹ / cùng mẹ khác cha); giới tính (anh/em trai = M, chị/em gái = F).
  THÊM những người trong danh sách thành viên hộ ở CT07 là CON của bố/mẹ đương đơn (quan hệ "con", "con đẻ" với chủ
  hộ khi chủ hộ là bố/mẹ đương đơn) mà PTTKH bỏ sót — và ghi vào "canhBao" để nhân viên xác nhận. KHÔNG đưa chính
  đương đơn, cháu, con dâu/rể vào danh sách anh chị em.
- ĐỊA CHỈ CON / ANH CHỊ EM: ở cùng hộ CT07, hoặc PTTKH ghi cùng xóm/xã với gia đình (kể cả tên xã CŨ trước sáp nhập,
  vd PTTKH "Xóm 8 - Thọ Thành" mà CT07 đã đổi thành "Xóm 8, Xã Đông Thành") -> dùng ĐÚNG địa chỉ đương đơn theo CT07
  (tên đơn vị hành chính mới). Ở nơi khác hẳn (tỉnh / xã khác) thì dịch địa chỉ theo PTTKH.

Định dạng (giống form Docs đã nộp):
- Họ tên: không dấu, Chữ Hoa Đầu Từ (vd "Ho Sy Hoi", "Nguyen Thi The").
- Ngày sinh: YYYY-MM-DD. Giấy tờ chỉ ghi năm thì để "YYYY" (không bịa ngày tháng) và ghi vào "canhBao".
- maritalStatus: một trong {TINH_TRANG_HIEN}. Đang có vợ/chồng ghi "Married".
- Địa chỉ: tiếng Anh, không dấu, từ nhỏ đến lớn, KHÔNG thêm ", Vietnam" ở cuối (Thôn/Xóm -> Hamlet, Xã -> Commune,
  Phường -> Ward, Thị trấn -> Town, Huyện/Quận -> District, Tỉnh -> Province, Thành phố -> City). Vd "Hamlet 8, Dong
  Thanh Commune, Nghe An Province".
- occupation là NGHỀ NGHIỆP (chữ), không bao giờ là ngày tháng hay số.
- Không tìm thấy thì để "" — KHÔNG bịa. Mâu thuẫn giữa các giấy thì chọn theo quy tắc ưu tiên và ghi vào "canhBao".
- "nguon": mỗi người ghi ngắn lấy từ giấy nào, vd "Tên, ngày sinh: PTTKH; địa chỉ: CT07".
TỰ KIỂM TRA LẠI trước khi trả: đúng người, đúng ô (tên mẹ không lẫn sang bố), ngày sinh đúng định dạng, không trùng
người, số con / anh chị em khớp PTTKH.

Chỉ trả JSON:
{{"applicant": {{{_NGUOI}}}, "spouse": {{{_NGUOI}}} hoặc null, "mother": {{{_NGUOI}}}, "father": {{{_NGUOI}}},
 "children": [{{{_NGUOI}}}], "siblings": [{{{_NGUOI}}}], "canhBao": ["..."]}}"""


def trich_thong_tin(case) -> dict:
    """Gọi DeepSeek -> dữ liệu form đã chuẩn hoá + kiểm tra. Ném lỗi nếu không có giấy tờ / AI hỏng."""
    giay = giay_to_lien_quan(case)
    if not giay:
        raise ValueError("Hồ sơ chưa có giấy tờ nào dùng được (Phiếu TT khách hàng, CT07, CCCD, Giấy khai sinh...).")
    nguoi_dung = (
        f"Tên đương đơn trong hồ sơ: {case.clientName}\n"
        f"Tình trạng hôn nhân trong hồ sơ: {'Đã kết hôn' if case.maritalStatus == 'MARRIED' else 'Độc thân'}; "
        f"số con: {case.numberOfChildren}; nghề nghiệp trong hồ sơ: {case.occupation or '(không ghi)'}\n\n"
        + "\n\n".join(f"===== {g['ten_muc']} — file \"{g['file']}\" =====\n{g['chu']}" for g in giay)
    )
    du_lieu = None
    for lan in range(2):
        # max_tokens gồm cả phần model "nghĩ" — để thấp là nội dung trả về RỖNG (xem tach_file.chia_bang_deepseek).
        kq = llm.get_deepseek_client().chat.completions.create(
            model=MODEL_AI,
            messages=[{"role": "system", "content": HE_THONG}, {"role": "user", "content": nguoi_dung}],
            response_format={"type": "json_object"},
            max_tokens=64000,
            timeout=600,
        )
        noi_dung = (kq.choices[0].message.content or "").strip()
        if noi_dung and kq.choices[0].finish_reason != "length":
            du_lieu = json.loads(noi_dung)
            break
        logger.warning("IMM5645: DeepSeek lần %d rỗng / bị cắt (finish=%s)", lan + 1, kq.choices[0].finish_reason)
    if du_lieu is None:
        raise ValueError("AI không trả về kết quả — thử lại.")
    du_lieu["applicationType"] = "Visitor" if getattr(case, "travelPurpose", "WORK") == "TRAVEL" else "Worker"
    du_lieu["nguonGiayTo"] = [f"{g['ten_muc']}: {g['file']}" for g in giay]
    ra = chuan_hoa(du_lieu)
    # Mặc định theo file mẫu Docs: người thân KHÔNG đi cùng (tick NO), ngày ký = hôm nay. Chỉ đặt lúc AI đọc —
    # khi nhân viên lưu thì giữ đúng lựa chọn của họ.
    for p in [ra["spouse"], ra["mother"], ra["father"], *ra["children"], *ra["siblings"]]:
        if p["name"] and not p["accompany"]:
            p["accompany"] = "no"
    ra["signDate"] = ra["signDate"] or hom_nay_vn()
    ra["canhBao"] = [str(x) for x in (du_lieu.get("canhBao") or [])][:20]
    ra["kiemTra"] = kiem_tra(ra)  # tính lại sau khi đặt mặc định
    return ra


# ---------------------------------------------------------------------------
# 3. Chuẩn hoá + LỌC thông tin
# ---------------------------------------------------------------------------

def _tinh_trang(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    for t in TINH_TRANG_HIEN:
        if v.lower() == t.lower():
            return t
    if v.lower().startswith("married"):
        return "Married"
    return ""


def _dia_chi(v: str) -> str:
    v = bo_dau(v).strip(" ,.")
    return re.sub(r",?\s*(viet\s*nam|vietnam)\s*$", "", v, flags=re.IGNORECASE).strip(" ,")


def _nguoi(x: dict | None, co_quan_he: bool = False) -> dict:
    x = x if isinstance(x, dict) else {}
    ra = {
        "name": ten_chuan(str(x.get("name") or "")),
        "gender": str(x.get("gender") or "").strip().upper()[:1] if str(x.get("gender") or "").strip().upper()[:1] in ("M", "F") else "",
        "dob": str(x.get("dob") or "").strip(),
        "cob": bo_dau(str(x.get("cob") or "")).strip() or ("Vietnam" if x.get("name") else ""),
        "maritalStatus": _tinh_trang(str(x.get("maritalStatus") or "")),
        "address": _dia_chi(str(x.get("address") or "")),
        "occupation": bo_dau(str(x.get("occupation") or "")).strip(),
        "accompany": x.get("accompany") if x.get("accompany") in ("yes", "no") else "",
        "nguon": str(x.get("nguon") or ""),
    }
    if co_quan_he:
        ra["relationship"] = bo_dau(str(x.get("relationship") or "")).strip()
    return ra


def _quan_he_anh_chi_em(p: dict, dob_dd: str) -> str:
    """"Older brother" / "Younger sister"... theo ngày sinh so với đương đơn (cách ghi file mẫu Docs)."""
    gioi = {"M": "brother", "F": "sister"}.get(p.get("gender") or "")
    if not gioi:
        cu = (p.get("relationship") or "").lower()
        gioi = "brother" if "brother" in cu else "sister" if "sister" in cu else ""
    if not gioi:
        return p.get("relationship") or ""
    if _NGAY.match(p.get("dob") or "") and _NGAY.match(dob_dd or ""):
        return ("Older " if p["dob"] < dob_dd else "Younger ") + gioi
    return gioi.capitalize()


def chuan_hoa(d: dict) -> dict:
    """Dữ liệu form về đúng khuôn (từ AI hoặc từ giao diện gửi lên) — chặn rác, cắt số dòng theo form."""
    ra = {
        "applicationType": d.get("applicationType") if d.get("applicationType") in LOAI_HO_SO else "",
        "applicant": _nguoi(d.get("applicant")),
        "spouse": _nguoi(d.get("spouse")),
        "mother": _nguoi(d.get("mother")),
        "father": _nguoi(d.get("father")),
        "children": [_nguoi(c, True) for c in (d.get("children") or []) if isinstance(c, dict)][:SO_CON],
        "siblings": [_nguoi(c, True) for c in (d.get("siblings") or []) if isinstance(c, dict)][:SO_ANH_CHI_EM],
        "canhBao": [str(x) for x in (d.get("canhBao") or [])][:20],
        "nguonGiayTo": [str(x) for x in (d.get("nguonGiayTo") or [])][:40],
        "signDate": str(d.get("signDate") or "").strip(),
        "anhChuKy": chuan_hoa_anh_chu_ky(d.get("anhChuKy")),
    }
    ra["chuKy"] = chuan_hoa_chu_ky(d.get("chuKy"), [a["id"] for a in ra["anhChuKy"]])
    ra["applicant"]["accompany"] = ""
    for c in ra["children"]:
        if not c["relationship"]:
            c["relationship"] = {"M": "Son", "F": "Daughter"}.get(c["gender"], "")
    # Quan hệ anh chị em luôn tính lại theo giới tính + tuổi — AI hay ghi "Brother" chung chung.
    for s in ra["siblings"]:
        s["relationship"] = _quan_he_anh_chi_em(s, ra["applicant"]["dob"])
    ra["kiemTra"] = kiem_tra(ra)
    return ra


def kiem_tra(d: dict) -> list[str]:
    """LỌC thông tin trước khi điền (Docs yêu cầu "lọc thật kỹ" 14/10/2026). SỬA LUÔN lỗi chắc chắn (xoá nghề
    nghiệp là ngày tháng — lỗi có thật trong file mẫu đã nộp; bỏ anh chị em trùng / trùng đương đơn) và trả danh sách
    chỗ cần người xem lại."""
    loi: list[str] = []
    dd = d["applicant"]

    def ten_nguoi(nhan: str, p: dict) -> str:
        return f"{nhan} ({p['name']})" if p.get("name") else nhan

    # Bỏ anh chị em trùng tên đương đơn / trùng nhau.
    da_co = {dd["name"].lower()} if dd["name"] else set()
    con_lai = []
    for s in d["siblings"]:
        k = s["name"].lower()
        if k and k in da_co:
            loi.append(f"Đã bỏ anh chị em trùng tên '{s['name']}' (trùng đương đơn hoặc trùng dòng khác).")
            continue
        da_co.add(k)
        con_lai.append(s)
    d["siblings"] = con_lai

    nhom = [("Đương đơn", dd, True), ("Vợ/chồng", d["spouse"], False), ("Mẹ", d["mother"], True), ("Bố", d["father"], True)]
    nhom += [(f"Con {i + 1}", c, True) for i, c in enumerate(d["children"])]
    nhom += [(f"Anh chị em {i + 1}", s, True) for i, s in enumerate(d["siblings"])]
    for nhan, p, bat_buoc in nhom:
        co_thong_tin = any(p.get(k) for k in ("name", "dob", "address", "occupation"))
        if not co_thong_tin:
            if bat_buoc and nhan in ("Đương đơn", "Mẹ", "Bố"):
                loi.append(f"{nhan}: chưa có thông tin.")
            continue
        t = ten_nguoi(nhan, p)
        if not p["name"]:
            loi.append(f"{t}: thiếu họ tên.")
        if not p["dob"]:
            loi.append(f"{t}: thiếu ngày sinh.")
        elif not _NGAY.match(p["dob"]):
            loi.append(f"{t}: ngày sinh '{p['dob']}' chưa đúng dạng YYYY-MM-DD.")
        else:
            try:
                ngay = date.fromisoformat(p["dob"])
                if not (1900 <= ngay.year <= date.today().year) or ngay > date.today():
                    loi.append(f"{t}: ngày sinh {p['dob']} không hợp lý.")
            except ValueError:
                loi.append(f"{t}: ngày sinh {p['dob']} không có thật.")
        if re.search(r"\d{4}-\d{2}-\d{2}|^\d[\d/.-]*$", p["occupation"]):
            loi.append(f"{t}: nghề nghiệp '{p['occupation']}' là ngày/số — đã xoá, nhập lại.")
            p["occupation"] = ""
        if not p["maritalStatus"]:
            loi.append(f"{t}: thiếu tình trạng hôn nhân.")
        if not p["address"]:
            loi.append(f"{t}: thiếu địa chỉ.")
        if not p["cob"]:
            loi.append(f"{t}: thiếu nước sinh.")
        if nhan != "Đương đơn" and not p["accompany"]:
            loi.append(f"{t}: chưa chọn đi cùng sang Canada (YES/NO).")

    # Tuổi hợp lý so với đương đơn.
    if _NGAY.match(dd["dob"]):
        for nhan, p in (("Mẹ", d["mother"]), ("Bố", d["father"])):
            if _NGAY.match(p["dob"]) and int(dd["dob"][:4]) - int(p["dob"][:4]) < 13:
                loi.append(f"{nhan} chỉ hơn đương đơn {int(dd['dob'][:4]) - int(p['dob'][:4])} tuổi — kiểm tra lại ngày sinh.")
        for i, c in enumerate(d["children"]):
            if _NGAY.match(c["dob"]) and int(c["dob"][:4]) - int(dd["dob"][:4]) < 13:
                loi.append(f"Con {i + 1} chỉ kém đương đơn {int(c['dob'][:4]) - int(dd['dob'][:4])} tuổi — kiểm tra lại.")
    for i, s in enumerate(d["siblings"]):
        if s["name"] and s["relationship"] not in ("Older brother", "Younger brother", "Older sister", "Younger sister"):
            loi.append(f"Anh chị em {i + 1} ({s['name']}): chưa rõ quan hệ — chọn giới tính / kiểm tra ngày sinh.")
    if d["applicant"]["maritalStatus"] == "Single" and d["spouse"]["name"]:
        loi.append("Đương đơn 'Single' nhưng có thông tin vợ/chồng — kiểm tra lại.")
    if d["applicant"]["maritalStatus"] == "Married" and not d["spouse"]["name"]:
        loi.append("Đương đơn 'Married' nhưng chưa có thông tin vợ/chồng.")
    if d["signDate"] and not _NGAY.match(d["signDate"]):
        loi.append(f"Ngày ký '{d['signDate']}' chưa đúng dạng YYYY-MM-DD.")
    return loi


# ---------------------------------------------------------------------------
# 4. Điền PDF (AcroForm + XFA)
# ---------------------------------------------------------------------------

def _gia_tri_o(d: dict) -> dict:
    """{đường dẫn ô (bỏ "IMM_5645[0].") : giá trị}. Chuỗi = ô chữ; True/False = ô tick; ("tt", chữ) = tình trạng."""
    o: dict = {}
    for loai in LOAI_HO_SO:
        o[f"page1[0].Subform1[0].{loai}[0]"] = d.get("applicationType") == loai

    def nguoi(goc: str, tien_to: str, p: dict, co_di_cung: bool = True):
        o[f"{goc}.{tien_to}Name[0]"] = p.get("name", "")
        o[f"{goc}.{tien_to}DOB[0]"] = p.get("dob", "")
        o[f"{goc}.{tien_to}COB[0]"] = p.get("cob", "")
        o[f"{goc}.{tien_to}Address[0]"] = p.get("address", "")
        o[f"{goc}.{tien_to}Occupation[0]"] = p.get("occupation", "")
        o[f"{goc}.ChildMStatus[0]"] = ("tt", p.get("maritalStatus") or "")
        if co_di_cung:
            o[f"{goc}.{tien_to}Yes[0]"] = p.get("accompany") == "yes"
            o[f"{goc}.{tien_to}No[0]"] = p.get("accompany") == "no"

    a = "page1[0].SectionA[0]"
    nguoi(f"{a}.Applicant[0]", "App", d.get("applicant") or {}, co_di_cung=False)
    nguoi(f"{a}.Spouse[0]", "Spouse", d.get("spouse") or {})
    nguoi(f"{a}.Mother[0]", "Mother", d.get("mother") or {})
    nguoi(f"{a}.Father[0]", "Father", d.get("father") or {})
    for sec, ds, so in (("SectionB", d.get("children") or [], SO_CON), ("SectionC", d.get("siblings") or [], SO_ANH_CHI_EM)):
        for i in range(so):
            p = ds[i] if i < len(ds) else {}
            goc = f"page1[0].{sec}[0].Child[{i}]"
            nguoi(goc, "Child", p)
            o[f"{goc}.ChildRelationship[0]"] = p.get("relationship", "")
    # Ngày ký: NOTE 1 (không có vợ/chồng), NOTE 2 (không có con) chỉ ký khi đúng là KHÔNG có; Section D luôn ký.
    ngay = d.get("signDate") or ""
    o["page1[0].SectionA[0].#subform[5].SectionAdate[0]"] = "" if (d.get("spouse") or {}).get("name") else ngay
    o["page1[0].SectionB[0].#subform[5].#subform[6].SectionBdate[0]"] = "" if d.get("children") else ngay
    o["page1[0].SectionC[0].#subform[8].SectionCdate[0]"] = ngay
    return o


_XFA_NS = "{http://www.xfa.org/schema/xfa-data/1.0/}"

# Nút "Save / Reset Form / Print Form" đầu mỗi trang của form IRCC — Docs yêu cầu bỏ khỏi file tải xuống (16/10/2026).
_NUT_BAM = re.compile(r"^(Save|Reset|Print)Button\d+$")


def _bo_nut_bam(doc) -> None:
    """Gỡ 3 nút ở CẢ HAI lớp: xoá widget AcroForm (trình duyệt vẽ theo lớp này) và ẩn field trong template XFA (Adobe
    vẽ theo lớp này — chỉ xoá widget thì mở Adobe vẫn thấy nút)."""
    for trang in doc:
        for w in [w for w in trang.widgets() if _NUT_BAM.match(w.field_name.split(".")[-1].split("[")[0])]:
            trang.delete_widget(w)
    acro = int(doc.xref_get_key(doc.pdf_catalog(), "AcroForm")[1].split()[0])
    phan = dict(re.findall(r"\((\w+)\)\s*(\d+) 0 R", doc.xref_get_key(acro, "XFA")[1]))
    x_tpl = int(phan["template"])
    tpl = doc.xref_stream(x_tpl).decode("utf-8")
    moi, so = re.subn(
        r'<field(?![^>]*\bpresence=)([^>]*\bname="(?:Save|Reset|Print)Button\d+")',
        r'<field presence="hidden"\1',
        tpl,
    )
    if so:
        doc.update_stream(x_tpl, moi.encode("utf-8"))


def dien_pdf(d: dict, anh_chu_ky: dict[str, bytes] | None = None) -> bytes:
    """`anh_chu_ky` = {id ảnh: PNG} — chèn chữ ký ở các chỗ d["chuKy"] (mỗi chỗ dùng ảnh của nó)."""
    o = _gia_tri_o(d)
    doc = fitz.open(MAU)
    try:
        _bo_nut_bam(doc)
        # --- AcroForm (trình duyệt, máy in). Form khai báo Courier New 8pt (tình trạng 6,1pt) nhưng PyMuPDF không có
        # Courier New -> vẽ bằng Helvetica; ép Courier (cùng mặt chữ) để giống bản Adobe / file mẫu Docs.
        for trang in doc:
            for w in trang.widgets():
                k = w.field_name.replace("IMM_5645[0].", "", 1)
                if k not in o:
                    continue
                v = o[k]
                if w.field_type_string == "CheckBox":
                    w.field_value = w.on_state() if v else "Off"
                else:
                    co = w.text_fontsize or 8
                    w.text_font = "Cour"
                    w.text_fontsize = co
                    w.field_value = (v[1] if isinstance(v, tuple) else v) or ""
                w.update()
        # --- XFA datasets (Adobe Reader vẽ theo lớp này)
        acro = int(doc.xref_get_key(doc.pdf_catalog(), "AcroForm")[1].split()[0])
        phan = dict(re.findall(r"\((\w+)\)\s*(\d+) 0 R", doc.xref_get_key(acro, "XFA")[1]))
        x_ds = int(phan["datasets"])
        ET.register_namespace("xfa", _XFA_NS[1:-1])
        goc = ET.fromstring(doc.xref_stream(x_ds))
        form = goc.find(f"{_XFA_NS}data").find("IMM_5645")
        for k, v in o.items():
            nut = form
            for phan_duong in k.split("."):
                m = re.match(r"(.+)\[(\d+)\]$", phan_duong)
                ten, so = m.group(1), int(m.group(2))
                if ten.startswith("#subform"):
                    continue  # subform không tên không có nút dữ liệu riêng
                cung_ten = [c for c in nut if c.tag == ten]
                nut = cung_ten[so] if so < len(cung_ten) else None
                if nut is None:
                    break
            if nut is None:
                continue
            if isinstance(v, bool):
                nut.text = "1" if v else "0"
            elif isinstance(v, tuple):
                # Chọn đúng 1 trong 8 lựa chọn -> lưu MÃ; "Married" (cách ghi gọn) -> lưu nguyên chữ.
                nut.text = _MA_TINH_TRANG.get(v[1].lower(), v[1]) or None
            else:
                nut.text = v or None
        doc.update_stream(x_ds, ET.tostring(goc, encoding="utf-8"))
        if anh_chu_ky and d.get("chuKy"):
            _chen_chu_ky(doc, anh_chu_ky, d["chuKy"])
        return doc.tobytes(garbage=1, deflate=True)
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# 5. Chữ ký (Docs yêu cầu 16/10/2026: chọn ảnh chữ ký, kéo tới đúng chỗ rồi đưa vào PDF)
# ---------------------------------------------------------------------------
# NHIỀU ảnh chữ ký mỗi hồ sơ (Docs 16/10/2026: "úp nhiều file và nhiều chữ ký khác nhau" — đương đơn, bố, mẹ...).
# Ảnh ở MinIO "<caseId>/imm5645-chu-ky/<id>.png" (PNG nền TRONG SUỐT, đã cắt sát nét) — trong thư mục hồ sơ nên xoá /
# dọn hồ sơ là mất theo. Dữ liệu form: anhChuKy = [{id, ten}] (thư viện ảnh, tên sửa được); chuKy = [{page, x, y, w,
# anh}] — page 0/1, x, y = góc trên trái, w = bề rộng, TỈ LỆ theo khổ trang (0..1), chiều cao suy từ tỉ lệ ảnh; anh = id.
# Bản đầu (16/10 sáng) chỉ 1 ảnh "<caseId>/imm5645-chu-ky.png", chỗ ký không có "anh" — `KHOA_CU` để chuyển sang.

def khoa_chu_ky(case_id: str, anh_id: str) -> str:
    return f"{case_id}/imm5645-chu-ky/{anh_id}.png"


def khoa_cu(case_id: str) -> str:
    return f"{case_id}/imm5645-chu-ky.png"


SO_CHU_KY_TOI_DA = 12
SO_ANH_TOI_DA = 10
_ID_ANH = re.compile(r"^[a-z0-9]{1,16}$")


def chuan_hoa_anh_chu_ky(ds) -> list[dict]:
    ra, da_co = [], set()
    for x in ds if isinstance(ds, list) else []:
        if isinstance(x, dict) and _ID_ANH.match(str(x.get("id", ""))) and x["id"] not in da_co:
            da_co.add(x["id"])
            ra.append({"id": x["id"], "ten": str(x.get("ten") or "").strip()[:40] or f"Chữ ký {len(ra) + 1}"})
    return ra[:SO_ANH_TOI_DA]


def chuan_hoa_chu_ky(ds, cac_anh: list[str]) -> list[dict]:
    """Chỗ ký hợp lệ; bỏ chỗ dùng ảnh đã xoá. Chỗ ký đời đầu (không có "anh") -> ảnh đầu tiên."""
    ra = []
    for x in ds if isinstance(ds, list) else []:
        if not isinstance(x, dict):
            continue
        try:
            page, cx, cy, w = int(x.get("page", 0)), float(x["x"]), float(x["y"]), float(x["w"])
        except (KeyError, TypeError, ValueError):
            continue
        anh = str(x.get("anh") or (cac_anh[0] if cac_anh else ""))
        if page not in (0, 1) or anh not in cac_anh:
            continue
        w = min(max(w, 0.03), 0.6)
        ra.append({"page": page, "x": round(min(max(cx, 0.0), 1 - w), 4), "y": round(min(max(cy, 0.0), 0.98), 4),
                   "w": round(w, 4), "anh": anh})
    return ra[:SO_CHU_KY_TOI_DA]


def xu_ly_chu_ky(content: bytes) -> bytes:
    """Ảnh chữ ký (chụp / scan, nền giấy trắng hoặc xám, có thể lệch sáng) -> PNG nền TRONG SUỐT, cắt sát nét, giữ màu
    mực. Nền ước lượng TỪNG VÙNG (lấy sáng nhất quanh mỗi điểm) nên ảnh chụp điện thoại bị tối góc vẫn sạch."""
    import cv2

    try:
        anh = ImageOps.exif_transpose(Image.open(io.BytesIO(content)))
        # PNG nền trong suốt (vd chữ ký VẼ trên giao diện): lót nền TRẮNG — convert("RGB") thẳng thì nền thành đen.
        if anh.mode in ("RGBA", "LA", "P"):
            anh = anh.convert("RGBA")
            nen_trang = Image.new("RGBA", anh.size, (255, 255, 255, 255))
            anh = Image.alpha_composite(nen_trang, anh)
        anh = anh.convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise ValueError("Không đọc được ảnh — chọn file JPG / PNG.") from e
    if max(anh.size) > 2000:
        anh.thumbnail((2000, 2000))
    rgb = np.asarray(anh).astype(np.float32)
    xam = rgb.mean(axis=2)
    co = max(15, (min(xam.shape) // 15) | 1)
    nen = cv2.dilate(xam, np.ones((co, co), np.uint8))  # nét mực mảnh bị "lấp" bởi nền sáng xung quanh
    nen = cv2.GaussianBlur(nen, (co, co), 0)
    muc = np.clip(nen - xam, 0, 255)
    alpha = np.clip((muc - 18) * (255.0 / 70), 0, 255)
    if (alpha > 80).sum() < 30:
        raise ValueError("Không thấy nét chữ ký trong ảnh — chụp rõ hơn, nền sáng, mực đậm.")
    ys, xs = np.where(alpha > 60)
    dem = max(4, int(0.04 * max(np.ptp(xs), np.ptp(ys))))
    y0, y1 = max(0, ys.min() - dem), min(xam.shape[0], ys.max() + dem + 1)
    x0, x1 = max(0, xs.min() - dem), min(xam.shape[1], xs.max() + dem + 1)
    # Mực đậm lên một chút (ảnh chụp thường nhạt) — giữ sắc màu (xanh / đen) của bút.
    mau = np.clip(rgb * 0.75, 0, 255)
    rgba = np.dstack([mau, alpha]).astype(np.uint8)[y0:y1, x0:x1]
    out = Image.fromarray(rgba, "RGBA")
    if out.width > 1000:
        out = out.resize((1000, max(1, round(out.height * 1000 / out.width))), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def ti_le_anh(png: bytes) -> float:
    """rộng / cao."""
    w, h = Image.open(io.BytesIO(png)).size
    return w / max(1, h)


# Dòng "Signature:" trên form (đo trên mau_form/imm5645e.pdf, khổ 612 x 792 pt): (trang, y của dòng kẻ).
# "sectionC" = dòng ký Section D (CERTIFICATION) trang 2 — tên theo ô ngày SectionCdate của form.
DONG_KY = {"note1": (0, 438.0), "note2": (0, 720.5), "sectionC": (1, 475.0)}
RONG_MAC_DINH = 0.13  # ~80 pt — cỡ chữ ký trong file mẫu Docs đã nộp


def chu_ky_mac_dinh(d: dict, ti_le: float, anh: str) -> list[dict]:
    """Đặt chữ ký ở đúng các dòng KÝ như quy tắc ngày ký (_gia_tri_o): NOTE 1 khi không có vợ/chồng, NOTE 2 khi không có
    con, Section C luôn ký — chân chữ ký chạm dòng kẻ, lệch trái như file mẫu Docs."""
    dong = []
    if not (d.get("spouse") or {}).get("name"):
        dong.append("note1")
    if not d.get("children"):
        dong.append("note2")
    dong.append("sectionC")
    cao = RONG_MAC_DINH * 612 / ti_le  # pt
    ra = []
    for k in dong:
        trang, y = DONG_KY[k]
        ra.append({"page": trang, "x": 0.3, "y": round(max(0.0, (y - cao * 0.75) / 792), 4), "w": RONG_MAC_DINH,
                   "anh": anh})
    return ra


def _chen_chu_ky(doc, anh_chu_ky: dict[str, bytes], cac_cho: list[dict]) -> None:
    ti_le = {k: ti_le_anh(v) for k, v in anh_chu_ky.items()}
    for c in cac_cho:
        png = anh_chu_ky.get(c.get("anh", ""))
        if png is None or c["page"] >= len(doc):
            continue
        trang = doc[c["page"]]
        W, H = trang.rect.width, trang.rect.height
        x, y, w = c["x"] * W, c["y"] * H, c["w"] * W
        trang.insert_image(fitz.Rect(x, y, x + w, y + w / ti_le[c["anh"]]), stream=png, overlay=True)


def anh_trang(d: dict, so_trang: int, dpi: int = 100) -> bytes:
    """Ảnh 1 trang PDF đã điền (KHÔNG có chữ ký — giao diện tự đặt chữ ký lên trên để kéo)."""
    doc = fitz.open(stream=dien_pdf(d), filetype="pdf")
    try:
        if not 0 <= so_trang < len(doc):
            raise ValueError("Không có trang này.")
        return doc[so_trang].get_pixmap(dpi=max(40, min(dpi, 150))).tobytes("png")
    finally:
        doc.close()
