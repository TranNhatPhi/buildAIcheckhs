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

import json
import logging
import os
import re
import unicodedata
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import fitz

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
    }
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


def dien_pdf(d: dict) -> bytes:
    o = _gia_tri_o(d)
    doc = fitz.open(MAU)
    try:
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
        return doc.tobytes(garbage=1, deflate=True)
    finally:
        doc.close()
