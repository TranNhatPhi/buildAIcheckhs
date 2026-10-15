"""Điền form IMM 1295E (Application for Work Permit Made Outside of Canada) từ giấy tờ trong hồ sơ — tab
"Điền form IMM1295e" (15/10/2026, Docs yêu cầu "làm giống như IMM5645").

Các bước giống imm5645.py: gom CHỮ ĐÃ ĐỌC của giấy tờ liên quan (Phiếu TT khách hàng, hộ chiếu, CCCD, CT07, đăng ký
kết hôn, bằng cấp, CV / xác nhận kinh nghiệm...) -> DeepSeek PRO trích JSON -> `chuan_hoa` + `kiem_tra` LỌC / sửa lỗi
hay gặp và liệt kê chỗ cần xem -> nhân viên xem / sửa trên giao diện (lưu Case.imm1295Data) -> điền PDF.

Cách ghi theo IMM5645 Docs đã duyệt: họ tên Chữ Hoa Đầu Từ không dấu, địa chỉ tiếng Anh không thêm ", Vietnam".

PDF mẫu (mau_form/imm1295e.pdf) là XFA THUẦN (không có ô AcroForm, trình duyệt chỉ hiện trang "Please wait...") ->
chỉ điền lớp XFA datasets, MỞ BẰNG ADOBE READER. Ô danh sách (quốc gia, giới tính, tình trạng hôn nhân...) lưu MÃ
của danh sách LOVFile nằm sẵn trong PDF (vd Vietnam = 270). File gốc có chữ ký chứng thực (DocMDP / UR3) — sửa dữ liệu
là chữ ký hỏng, Adobe báo "đã bị thay đổi" -> gỡ chữ ký đó (form vẫn điền / Validate bình thường trong Reader).

Phần VIỆC LÀM Ở CANADA (nhà tuyển dụng, chức danh, LMIA, nơi làm) thường KHÔNG có trong giấy tờ hồ sơ — AI để trống,
nhân viên nhập tay.
"""
from __future__ import annotations

import json
import logging
import os
import re
import xml.etree.ElementTree as ET
from datetime import date
from functools import lru_cache
from pathlib import Path

import fitz

import llm
from imm5645 import _dia_chi, bo_dau, ten_chuan

logger = logging.getLogger(__name__)

MAU = Path(__file__).parent / "mau_form" / "imm1295e.pdf"
MODEL_AI = os.getenv("IMM1295_DEEPSEEK_MODEL", os.getenv("IMM5645_DEEPSEEK_MODEL", "deepseek-v4-pro"))
SO_NUOC_TRUOC = 2  # Câu 8: 2 dòng nước từng cư trú
SO_VIEC_LAM = 3  # Employment: 3 dòng

# Giấy tờ đưa cho AI — theo TÊN MỤC checklist. Bỏ CCCD bố / mẹ (form không hỏi bố mẹ), bảng điểm / học bạ (đã có bằng).
_MUC_LIEN_QUAN = re.compile(
    r"phiếu tt|passport|hộ chiếu|căn cước|chứng minh|cư trú|kết hôn|ly hôn|bằng|resume|cv|kinh nghiệm|"
    r"hợp đồng lao động$|tư pháp tại nước ngoài|thi tiếng anh|khai sinh$",
    re.IGNORECASE,
)
_MUC_BO = re.compile(r"căn cước công dân (bố|mẹ)|bảng điểm|học bạ", re.IGNORECASE)
CHU_TOI_DA_PHIEU = 14000
CHU_TOI_DA_GIAY = 3500

_NGAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_THANG = re.compile(r"^\d{4}-\d{2}$")

# Lựa chọn hiện trên giao diện (chữ) -> mã LOVFile. Danh sách nào lấy được từ PDF thì đọc từ PDF (`_lov`).
GIOI_TINH = ("Male", "Female")
TINH_TRANG = {"Single": "02", "Married": "01", "Common-Law": "03", "Divorced": "04", "Separated": "05",
              "Widowed": "06", "Annulled Marriage": "09"}
QUAN_HE_TRUOC = {"Married": "01", "Common-Law": "03"}
TINH_TRANG_CU_TRU = {"Citizen": "01", "Permanent resident": "02", "Visitor": "03", "Worker": "04", "Student": "05",
                     "Other": "06", "Protected Person": "07", "Refugee Claimant": "08", "Foreign National": "09"}
LOAI_DIEN_THOAI = {"Residence": "01", "Cellular": "02", "Business": "03"}
GIAO_TIEP = ("English", "French", "Both", "Neither")
NGON_NGU_PHUC_VU = {"English": "01", "French": "02"}  # câu 2 đầu form "I want service in"
LOAI_GIAY_PHEP = {"ELMO": "Exemption from LMIA", "LMOS": "LMIA stream", "OWP": "Open Work Permit", "Other": "Other",
                  "SAWP": "Seasonal Agricultural Workers Program", "SBC": "Start-up Business Class"}
TINH_CANADA = {"AB": "09", "BC": "11", "MB": "07", "NB": "04", "NL": "01", "NS": "03", "NT": "10", "NU": "64",
               "ON": "06", "PE": "02", "QC": "05", "SK": "08", "YT": "12"}

# Độ dài tối đa của ô trên form (maxChars trong template XFA) — dài hơn là Adobe cắt / báo lỗi.
DO_DAI = {"familyName": 100, "givenName": 100, "birthCity": 30, "passportNumber": 20, "nationalIdNumber": 20,
          "aptUnit": 10, "streetNum": 10, "streetName": 100, "cityTown": 30, "district": 30, "postalCode": 10,
          "phoneNumber": 20, "email": 100, "employerName": 200, "employerAddress": 150, "workCity": 30,
          "jobTitle": 50, "jobDuties": 100, "eduField": 30, "eduSchool": 75, "eduCity": 30,
          "bgMedicalDetails": 200, "bgRefusedDetails": 200, "bgCriminalDetails": 200, "bgMilitaryDetails": 200,
          "uci": 10}

# Ô chữ / ngày / có-không ở cấp ngoài cùng (danh sách nước cư trú, việc làm xử lý riêng).
O_CHU = ("uci", "familyName", "givenName", "aliasFamilyName", "aliasGivenName", "birthCity",
         "spouseFamilyName", "spouseGivenName", "pmFamilyName", "pmGivenName", "passportNumber", "nationalIdNumber",
         "aptUnit", "streetNum", "streetName", "cityTown", "district", "postalCode", "phoneNumber", "email",
         "employerName", "employerAddress", "workCity", "workAddress", "jobTitle", "jobDuties", "lmia",
         "eduField", "eduSchool", "eduCity", "bgMedicalDetails", "bgRefusedDetails", "bgCriminalDetails",
         "bgMilitaryDetails")
O_NGAY = ("dob", "corFrom", "corTo", "marriageDate", "pmDob", "pmFrom", "pmTo", "passportIssue", "passportExpiry",
          "nationalIdIssue", "nationalIdExpiry", "workFrom", "workTo")
O_THANG = ("eduFrom", "eduTo")
O_QUOC_GIA = ("birthCountry", "citizenship", "corCountry", "passportCountry", "nationalIdCountry", "addressCountry",
              "eduCountry")
# Có / không -> mặc định (theo giá trị sẵn trong file mẫu).
O_CO_KHONG = {"aliasUsed": "N", "prevMarried": "N", "languageTest": "N", "hasNationalId": "Y", "hasEducation": "N",
              "bgTb": "N", "bgDisorder": "N", "bgOverstay": "N", "bgRefused": "N", "bgApplied": "N",
              "bgCriminal": "N", "bgMilitary": "N", "bgViolentOrg": "N", "bgIllTreatment": "N"}


# ---------------------------------------------------------------------------
# Danh sách mã (LOVFile trong PDF mẫu)
# ---------------------------------------------------------------------------

_XFA_NS = "{http://www.xfa.org/schema/xfa-data/1.0/}"


def _xfa_datasets(doc) -> int:
    acro = int(doc.xref_get_key(doc.pdf_catalog(), "AcroForm")[1].split()[0])
    return int(dict(re.findall(r"\((\w+)\)\s*(\d+) 0 R", doc.xref_get_key(acro, "XFA")[1]))["datasets"])


@lru_cache(maxsize=1)
def _lov() -> dict:
    """{tên danh sách: [(mã, chữ)]} đọc từ LOVFile trong PDF mẫu."""
    doc = fitz.open(MAU)
    try:
        goc = ET.fromstring(doc.xref_stream(_xfa_datasets(doc)))
    finally:
        doc.close()
    ra: dict = {}
    for e in goc.iter():
        ten = e.tag.split("}")[-1]
        if ten.endswith("List") and len(e) and e[0].get("lic") is not None:
            ra[ten] = [(c.get("lic"), (c.text or "").strip()) for c in e if c.get("lic") not in (None, "", "*")]
    return ra


def _khoa(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", bo_dau(s).lower())


_BIET_DANH_NUOC = {"vietnam": "Vietnam", "vn": "Vietnam", "southkorea": "Korea, South", "korea": "Korea, South",
                   "hanquoc": "Korea, South", "nhatban": "Japan", "dailoan": "Taiwan", "trungquoc": "China",
                   "usa": "United States of America", "us": "United States of America", "my": "United States of America",
                   "germany": "Germany, Federal Republic Of", "duc": "Germany, Federal Republic Of", "nga": "Russia"}


@lru_cache(maxsize=1)
def quoc_gia() -> dict:
    """{chữ quốc gia: mã} — gộp các danh sách quốc gia của form (cùng hệ mã)."""
    ra: dict = {}
    for ten in ("CountryOfBirthList", "CountryOfCitizenshipList", "CountryOfLastPermanentResidentList",
                "CountryTravelDocumentList", "CountryList"):
        for ma, chu in _lov().get(ten, []):
            ra.setdefault(chu, ma)
    return ra


def ten_quoc_gia(v: str) -> str:
    """Chữ AI / nhân viên gõ -> đúng tên trong danh sách form ("" nếu không có, giữ nguyên chữ nếu không khớp)."""
    v = bo_dau(v or "").strip()
    if not v:
        return ""
    k = _khoa(v)
    if k in _BIET_DANH_NUOC:
        return _BIET_DANH_NUOC[k]
    for chu in quoc_gia():
        if _khoa(chu) == k:
            return chu
    return v


def ma_quoc_gia(v: str) -> str:
    return quoc_gia().get(ten_quoc_gia(v), "")


@lru_cache(maxsize=1)
def _ngon_ngu() -> dict:
    return {chu: ma for ma, chu in _lov().get("ContactLanguageList", [])}


# ---------------------------------------------------------------------------
# 1. Gom chữ giấy tờ
# ---------------------------------------------------------------------------

def giay_to_lien_quan(case) -> list[dict]:
    """[{ten_muc, file, chu}] các giấy tờ dùng để điền form, phiếu TT đứng đầu."""
    ra = []
    for d in case.documents:
        muc = d.matchedChecklistItem
        ten = (muc.nameVi or "").strip() if muc is not None else ""
        # "(n?u có)" ở cuối tên mục không tính khi so "$".
        ten_so = re.sub(r"\s*\((n[ếe]u c[óo])\)\s*$", "", ten, flags=re.IGNORECASE)
        if not ten or not _MUC_LIEN_QUAN.search(ten_so) or _MUC_BO.search(ten):
            continue
        chu = (d.manualCorrectedText or d.correctedText or d.ocrText or "").strip()
        if not chu:
            continue
        la_phieu = "phiếu tt" in ten.lower()
        ra.append({"ten_muc": ten, "file": d.originalFilename, "phieu": la_phieu,
                   "chu": chu[: CHU_TOI_DA_PHIEU if la_phieu else CHU_TOI_DA_GIAY]})
    ra.sort(key=lambda x: (not x["phieu"], x["ten_muc"], x["file"]))
    return ra


# ---------------------------------------------------------------------------
# 2. DeepSeek trích thông tin
# ---------------------------------------------------------------------------

HE_THONG = f"""Bạn là nhân viên hồ sơ định cư Canada, điền form IMM 1295E (Application for Work Permit Made Outside of
Canada) bằng TIẾNG ANH cho người lao động Việt Nam. Bạn nhận chữ đọc được (OCR, có thể sai chính tả) của các giấy tờ:
Phiếu thông tin khách hàng (PTTKH), hộ chiếu (Passport), CCCD/CMND, CT07 (xác nhận cư trú), đăng ký kết hôn / quyết
định ly hôn, bằng cấp, CV, thư xác nhận kinh nghiệm, hợp đồng lao động, chứng chỉ tiếng Anh. Trích theo quy tắc:

- HỌ TÊN: theo HỘ CHIẾU (không có thì CCCD). familyName = họ (chữ đầu), givenName = tên đệm + tên. Không dấu, Chữ Hoa
  Đầu Từ (vd "Ho" / "Sy Hoi"). Tên khác từng dùng (aliasUsed "Y") chỉ khi giấy tờ ghi rõ.
- sex "Male"/"Female"; dob YYYY-MM-DD; birthCity = nơi sinh trên hộ chiếu (thường là tỉnh, vd "Nghe An"), không dấu;
  birthCountry, citizenship "Vietnam". corCountry "Vietnam", corStatus "Citizen" (corFrom/corTo để "").
- previousCOR: nước KHÁC Việt Nam đã sống > 6 tháng trong 5 năm gần đây (vd đi xuất khẩu lao động Nhật / Hàn / Đài
  Loan theo PTTKH, CV): {{"country", "status" (Worker/Student/Visitor/Other), "from", "to"}} YYYY-MM-DD; chỉ biết tháng
  thì ngày "01". Tối đa {SO_NUOC_TRUOC}, gần nhất trước.
- maritalStatus: một trong {list(TINH_TRANG)}. Married/Common-Law: marriageDate (ngày đăng ký kết hôn),
  spouseFamilyName / spouseGivenName. Từng kết hôn / sống chung trước đó (đã ly hôn, góa...): prevMarried "Y" + pmFamilyName,
  pmGivenName, pmDob, pmType ("Married"/"Common-Law"), pmFrom, pmTo.
- nativeLanguage "Vietnamese"; communicate: "English" nếu có chứng chỉ / ghi biết tiếng Anh, không thì "Neither";
  languageTest "Y" chỉ khi có chứng chỉ IELTS / CELPIP / TEF... (thi của tổ chức được IRCC chỉ định).
- Hộ chiếu: passportNumber, passportCountry "Vietnam", passportIssue, passportExpiry (YYYY-MM-DD).
- CCCD: hasNationalId "Y", nationalIdNumber (12 số), nationalIdCountry "Vietnam", nationalIdIssue, nationalIdExpiry
  (CCCD ghi "Có giá trị đến").
- ĐỊA CHỈ hiện tại ưu tiên ① CT07 ② CCCD (KHÔNG lấy từ PTTKH), tiếng Anh không dấu: streetNum = số nhà (nếu có),
  streetName = đường / thôn-xóm + xã-phường (vd "Hamlet 8, Dong Thanh Commune"), cityTown = tỉnh / thành phố (vd "Nghe An
  Province"), district = huyện / quận nếu địa chỉ còn ghi (vd "Yen Thanh District"), addressCountry "Vietnam",
  postalCode "". Thôn/Xóm -> Hamlet, Xã -> Commune, Phường -> Ward, Thị trấn -> Town, Huyện -> District, Tỉnh -> Province.
- phoneType "Cellular", phoneNumber, email theo PTTKH.
- Học vấn: hasEducation "Y" nếu có bằng SAU THPT (trung cấp, cao đẳng, đại học, nghề). Ghi bằng CAO NHẤT: eduFrom,
  eduTo (YYYY-MM), eduField (ngành, tiếng Anh, ngắn), eduSchool (tên trường tiếng Anh), eduCity, eduCountry "Vietnam".
  Chỉ có THPT/THCS -> hasEducation "N" và để trống.
- occupations: lịch sử việc làm / hoạt động 10 năm gần đây (PTTKH, CV, xác nhận kinh nghiệm, HĐLĐ), MỚI NHẤT trước,
  tối đa {SO_VIEC_LAM}: {{"from": "YYYY-MM", "to": "YYYY-MM" hoặc "" nếu đến nay, "occupation" (tiếng Anh ngắn, vd
  "Construction worker"), "employer" (tên công ty không dấu / "Self-employed" / "Family farm"), "city" (tỉnh/thành, tiếng
  Anh không dấu), "country"}}.
- Câu hỏi lý lịch (mặc định "N"): bgTb (lao phổi 2 năm qua), bgDisorder (bệnh cần chăm sóc), bgOverstay (từng ở quá hạn /
  làm, học trái phép ở Canada), bgRefused (từng bị từ chối visa / nhập cảnh / trục xuất nước nào — PTTKH hay ghi "trượt
  visa"), bgApplied (từng nộp đơn vào Canada), bgCriminal (tiền án), bgMilitary (đi nghĩa vụ quân sự, công an, dân quân),
  bgViolentOrg, bgIllTreatment. "Y" phải kèm chi tiết tiếng Anh: bgMedicalDetails, bgRefusedDetails (nước, năm, loại
  visa), bgCriminalDetails, bgMilitaryDetails (đơn vị, cấp bậc, từ - đến).
- Phần việc làm ở Canada (employerName, employerAddress, workProvince, workCity, jobTitle, jobDuties, lmia): chỉ điền khi
  giấy tờ ghi rõ — thường để "".

Định dạng: ô form tiếng Anh, không dấu. Ngày YYYY-MM-DD. Không tìm thấy thì "" — KHÔNG bịa. Địa chỉ / số điện
thoại / website ở CHÂN TRANG Phiếu TT (dòng "(A): ...", "(P): ...") là của CÔNG TY tư vấn — KHÔNG phải của khách.
Mâu thuẫn giữa giấy tờ thì chọn theo hộ chiếu > CCCD > CT07 > PTTKH và ghi vào "canhBao". "nguon": vài dòng ngắn lấy
mục nào từ giấy nào. "canhBao" và "nguon" viết TIẾNG VIỆT CÓ DẤU (cho nhân viên đọc).
TỰ KIỂM TRA LẠI trước khi trả: đúng người (không lẫn vợ/chồng với đương đơn), số hộ chiếu / CCCD đúng giấy, ngày đúng
định dạng, ngày hết hạn sau ngày cấp.

Chỉ trả JSON phẳng với các khoá: familyName, givenName, aliasUsed, aliasFamilyName, aliasGivenName, sex, dob, birthCity,
birthCountry, citizenship, corCountry, corStatus, previousCOR, maritalStatus, marriageDate, spouseFamilyName,
spouseGivenName, prevMarried, pmFamilyName, pmGivenName, pmDob, pmType, pmFrom, pmTo, nativeLanguage, communicate,
languageTest, passportNumber, passportCountry, passportIssue, passportExpiry, hasNationalId, nationalIdNumber,
nationalIdCountry, nationalIdIssue, nationalIdExpiry, aptUnit, streetNum, streetName, cityTown, district, addressCountry,
postalCode, phoneType, phoneNumber, email, employerName, employerAddress, workProvince, workCity, jobTitle, jobDuties,
lmia, hasEducation, eduFrom, eduTo, eduField, eduSchool, eduCity, eduCountry, occupations, bgTb, bgDisorder,
bgMedicalDetails, bgOverstay, bgRefused, bgApplied, bgRefusedDetails, bgCriminal, bgCriminalDetails, bgMilitary,
bgMilitaryDetails, bgViolentOrg, bgIllTreatment, nguon (mảng chuỗi), canhBao (mảng chuỗi)."""


def trich_thong_tin(case) -> dict:
    """Gọi DeepSeek -> dữ liệu form đã chuẩn hoá + kiểm tra. Ném lỗi nếu không có giấy tờ / AI hỏng."""
    giay = giay_to_lien_quan(case)
    if not giay:
        raise ValueError("Hồ sơ chưa có giấy tờ nào dùng được (Phiếu TT khách hàng, Passport, CCCD, CT07...).")
    nguoi_dung = (
        f"Tên đương đơn trong hồ sơ: {case.clientName}\n"
        f"Tình trạng hôn nhân trong hồ sơ: {'Đã kết hôn' if case.maritalStatus == 'MARRIED' else 'Độc thân'}; "
        f"nghề nghiệp trong hồ sơ: {case.occupation or '(không ghi)'}\n\n"
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
        logger.warning("IMM1295: DeepSeek lần %d rỗng / bị cắt (finish=%s)", lan + 1, kq.choices[0].finish_reason)
    if du_lieu is None:
        raise ValueError("AI không trả về kết quả — thử lại.")
    du_lieu["nguonGiayTo"] = [f"{g['ten_muc']}: {g['file']}" for g in giay]
    # Loại giấy phép mặc định theo file mẫu Docs (ELMO); việc làm ở Canada nhân viên nhập.
    du_lieu.setdefault("workPermitType", "ELMO")
    return chuan_hoa(du_lieu)


# ---------------------------------------------------------------------------
# 3. Chuẩn hoá + LỌC thông tin
# ---------------------------------------------------------------------------

def _ngay(v) -> str:
    """Nhận YYYY-MM-DD / DD/MM/YYYY / YYYY/MM/DD -> YYYY-MM-DD; không nhận ra thì giữ nguyên để kiem_tra báo."""
    v = str(v or "").strip()
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", v)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    m = re.match(r"^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$", v)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return v


def _thang(v) -> str:
    """YYYY-MM (nhận cả MM/YYYY, YYYY-MM-DD)."""
    v = str(v or "").strip()
    m = re.match(r"^(\d{1,2})[/.-](\d{4})$", v)
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    m = re.match(r"^(\d{4})[/.-](\d{1,2})(?:[/.-]\d{1,2})?$", v)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    return v


def _chon(v, cac_lua_chon, mac_dinh: str = "") -> str:
    v = str(v or "").strip()
    for c in cac_lua_chon:
        if v.lower() == c.lower():
            return c
    return mac_dinh


def _dien_thoai(v) -> str:
    """Số VN dạng quốc tế bỏ số 0 đầu (ô "Other" + mã nước 84): "0912 345 678" / "+84912345678" -> "912345678"."""
    so = re.sub(r"\D", "", str(v or ""))
    if so.startswith("84") and len(so) >= 11:
        so = so[2:]
    return so.lstrip("0")


def chuan_hoa(d: dict) -> dict:
    """Dữ liệu form về đúng khuôn (từ AI hoặc từ giao diện gửi lên) — chặn rác, cắt số dòng theo form."""
    d = d if isinstance(d, dict) else {}
    ra: dict = {}
    for k in O_CHU:
        ra[k] = bo_dau(str(d.get(k) or "")).strip()
    for k in ("familyName", "givenName", "aliasFamilyName", "aliasGivenName", "spouseFamilyName", "spouseGivenName",
              "pmFamilyName", "pmGivenName"):
        ra[k] = ten_chuan(ra[k])
    ra["passportNumber"] = re.sub(r"\s", "", ra["passportNumber"]).upper()
    ra["nationalIdNumber"] = re.sub(r"\s", "", ra["nationalIdNumber"])
    ra["phoneNumber"] = _dien_thoai(ra["phoneNumber"])
    ra["email"] = ra["email"].replace(" ", "").lower()
    for k in ("streetName", "cityTown", "district", "employerAddress", "workAddress"):
        ra[k] = _dia_chi(ra[k])
    for k in O_NGAY:
        ra[k] = _ngay(d.get(k))
    for k in O_THANG:
        ra[k] = _thang(d.get(k))
    for k in O_QUOC_GIA:
        ra[k] = ten_quoc_gia(str(d.get(k) or ""))
    for k in ("birthCountry", "citizenship", "corCountry", "passportCountry", "addressCountry"):
        ra[k] = ra[k] or "Vietnam"
    for k, mac_dinh in O_CO_KHONG.items():
        v = str(d.get(k) or "").strip().upper()[:1]
        ra[k] = v if v in ("Y", "N") else mac_dinh
    ra["sex"] = _chon(d.get("sex"), GIOI_TINH)
    ra["maritalStatus"] = _chon(d.get("maritalStatus"), TINH_TRANG)
    ra["pmType"] = _chon(d.get("pmType"), QUAN_HE_TRUOC)
    ra["corStatus"] = _chon(d.get("corStatus"), TINH_TRANG_CU_TRU, "Citizen")
    ra["nativeLanguage"] = _chon(d.get("nativeLanguage"), _ngon_ngu(), "Vietnamese")
    ra["communicate"] = _chon(d.get("communicate"), GIAO_TIEP, "Neither")
    ra["serviceIn"] = _chon(d.get("serviceIn"), NGON_NGU_PHUC_VU, "English")
    ra["phoneType"] = _chon(d.get("phoneType"), LOAI_DIEN_THOAI, "Cellular")
    ra["workPermitType"] = _chon(d.get("workPermitType"), LOAI_GIAY_PHEP, "ELMO")
    ra["workProvince"] = _chon(d.get("workProvince"), TINH_CANADA)
    ra["nationalIdCountry"] = ra["nationalIdCountry"] or ("Vietnam" if ra["nationalIdNumber"] else "")
    ra["eduCountry"] = ra["eduCountry"] or ("Vietnam" if ra["eduSchool"] else "")

    ra["previousCOR"] = []
    for x in (d.get("previousCOR") or [])[:SO_NUOC_TRUOC]:
        if isinstance(x, dict):
            ra["previousCOR"].append({"country": ten_quoc_gia(str(x.get("country") or "")),
                                      "status": _chon(x.get("status"), TINH_TRANG_CU_TRU),
                                      "from": _ngay(x.get("from")), "to": _ngay(x.get("to"))})
    ra["occupations"] = []
    for x in (d.get("occupations") or [])[:SO_VIEC_LAM]:
        if isinstance(x, dict):
            ra["occupations"].append({"from": _thang(x.get("from")), "to": _thang(x.get("to")),
                                      "occupation": bo_dau(str(x.get("occupation") or "")).strip(),
                                      "employer": bo_dau(str(x.get("employer") or "")).strip(),
                                      "city": _dia_chi(str(x.get("city") or "")),
                                      "country": ten_quoc_gia(str(x.get("country") or "")) or "Vietnam"})
    ra["nguon"] = [str(x) for x in (d.get("nguon") or []) if x][:30] if isinstance(d.get("nguon"), list) else []
    ra["canhBao"] = [str(x) for x in (d.get("canhBao") or [])][:20]
    ra["nguonGiayTo"] = [str(x) for x in (d.get("nguonGiayTo") or [])][:40]
    ra["kiemTra"] = kiem_tra(ra)
    return ra


def kiem_tra(d: dict) -> list[str]:
    """LỌC thông tin trước khi điền: SỬA LUÔN lỗi chắc chắn (nghề nghiệp là ngày tháng, câu "Có" mà trống chi tiết
    thì giữ nhưng báo...) và trả danh sách chỗ cần người xem lại."""
    loi: list[str] = []
    hom_nay = date.today().isoformat()

    def bat_buoc(k: str, nhan: str):
        if not d.get(k):
            loi.append(f"Thiếu {nhan}.")

    def ngay_dung(k: str, nhan: str) -> bool:
        v = d.get(k) or ""
        if not v:
            return False
        if not _NGAY.match(v):
            loi.append(f"{nhan} '{v}' chưa đúng dạng YYYY-MM-DD.")
            return False
        try:
            date.fromisoformat(v)
        except ValueError:
            loi.append(f"{nhan} {v} không có thật.")
            return False
        return True

    for k, nhan in (("familyName", "họ (Family name)"), ("givenName", "tên (Given name)"), ("sex", "giới tính"),
                    ("dob", "ngày sinh"), ("birthCity", "nơi sinh (thành phố / tỉnh)"),
                    ("maritalStatus", "tình trạng hôn nhân"), ("passportNumber", "số hộ chiếu"),
                    ("passportIssue", "ngày cấp hộ chiếu"), ("passportExpiry", "ngày hết hạn hộ chiếu"),
                    ("streetName", "địa chỉ (Street name)"), ("cityTown", "địa chỉ (City/Town)"),
                    ("phoneNumber", "số điện thoại"), ("email", "email")):
        bat_buoc(k, nhan)
    for k, nhan in (("dob", "Ngày sinh"), ("passportIssue", "Ngày cấp hộ chiếu"), ("passportExpiry", "Ngày hết hạn hộ chiếu"),
                    ("nationalIdIssue", "Ngày cấp CCCD"), ("nationalIdExpiry", "Ngày hết hạn CCCD"),
                    ("marriageDate", "Ngày kết hôn"), ("pmDob", "Ngày sinh vợ/chồng trước"), ("pmFrom", "Từ ngày (hôn nhân trước)"),
                    ("pmTo", "Đến ngày (hôn nhân trước)"), ("workFrom", "Ngày bắt đầu làm ở Canada"),
                    ("workTo", "Ngày kết thúc làm ở Canada")):
        ngay_dung(k, nhan)
    if _NGAY.match(d["dob"]) and not ("1900-01-01" <= d["dob"] <= hom_nay):
        loi.append(f"Ngày sinh {d['dob']} không hợp lý.")
    if _NGAY.match(d["passportExpiry"]):
        if d["passportExpiry"] <= hom_nay:
            loi.append(f"Hộ chiếu ĐÃ HẾT HẠN ({d['passportExpiry']}).")
        elif _NGAY.match(d["passportIssue"]) and d["passportExpiry"] <= d["passportIssue"]:
            loi.append("Ngày hết hạn hộ chiếu không sau ngày cấp — kiểm tra lại.")
    if _NGAY.match(d["passportIssue"]) and d["passportIssue"] > hom_nay:
        loi.append(f"Ngày cấp hộ chiếu {d['passportIssue']} ở tương lai.")
    if d["email"] and not re.match(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", d["email"]):
        loi.append(f"Email '{d['email']}' không hợp lệ.")
    if d["phoneNumber"] and not (8 <= len(d["phoneNumber"]) <= 11):
        loi.append(f"Số điện thoại '{d['phoneNumber']}' không đúng độ dài (ghi KHÔNG có số 0 đầu, mã nước 84 riêng).")
    if d["hasNationalId"] == "Y":
        bat_buoc("nationalIdNumber", "số CCCD")
        if d["nationalIdNumber"] and not re.match(r"^\d{9}$|^\d{12}$", d["nationalIdNumber"]):
            loi.append(f"Số CCCD/CMND '{d['nationalIdNumber']}' không phải 12 (hoặc 9) chữ số.")
    if d["aliasUsed"] == "Y" and not (d["aliasFamilyName"] or d["aliasGivenName"]):
        loi.append("Chọn 'Có tên khác' nhưng chưa ghi tên khác.")
    if d["maritalStatus"] in ("Married", "Common-Law"):
        bat_buoc("marriageDate", "ngày kết hôn / bắt đầu sống chung")
        if not (d["spouseFamilyName"] and d["spouseGivenName"]):
            loi.append("Đã kết hôn nhưng thiếu họ / tên vợ-chồng.")
    elif d["spouseFamilyName"] or d["spouseGivenName"]:
        loi.append(f"Tình trạng '{d['maritalStatus'] or '—'}' nhưng có tên vợ/chồng — kiểm tra lại.")
    if d["maritalStatus"] in ("Divorced", "Widowed", "Annulled Marriage", "Separated") and d["prevMarried"] != "Y":
        loi.append(f"Tình trạng '{d['maritalStatus']}' — thường phải khai hôn nhân trước (câu 11).")
    if d["prevMarried"] == "Y":
        for k, nhan in (("pmFamilyName", "họ vợ/chồng trước"), ("pmGivenName", "tên vợ/chồng trước"),
                        ("pmDob", "ngày sinh vợ/chồng trước"), ("pmType", "loại quan hệ trước"),
                        ("pmFrom", "từ ngày (hôn nhân trước)"), ("pmTo", "đến ngày (hôn nhân trước)")):
            bat_buoc(k, nhan)
    for i, r in enumerate(d["previousCOR"]):
        if not (r["country"] and r["status"] and r["from"] and r["to"]):
            loi.append(f"Nước cư trú trước {i + 1}: cần đủ nước, tình trạng, từ ngày, đến ngày.")
        if r["country"] and r["country"] not in quoc_gia():
            loi.append(f"Nước cư trú trước {i + 1}: '{r['country']}' không có trong danh sách của form.")
    for k, nhan in (("birthCountry", "Nước sinh"), ("citizenship", "Quốc tịch"), ("passportCountry", "Nước cấp hộ chiếu"),
                    ("nationalIdCountry", "Nước cấp CCCD"), ("addressCountry", "Nước (địa chỉ)"), ("eduCountry", "Nước (học vấn)")):
        if d[k] and d[k] not in quoc_gia():
            loi.append(f"{nhan} '{d[k]}' không có trong danh sách của form.")
    if d["hasEducation"] == "Y":
        for k, nhan in (("eduFrom", "học từ (YYYY-MM)"), ("eduTo", "học đến (YYYY-MM)"), ("eduField", "ngành học"),
                        ("eduSchool", "tên trường"), ("eduCity", "thành phố (trường)")):
            bat_buoc(k, nhan)
    for k in O_THANG:
        if d[k] and not _THANG.match(d[k]):
            loi.append(f"Học vấn: '{d[k]}' chưa đúng dạng YYYY-MM.")
    if not d["occupations"]:
        loi.append("Chưa có lịch sử việc làm (Employment, 10 năm gần đây).")
    for i, r in enumerate(d["occupations"]):
        t = f"Việc làm {i + 1}" + (f" ({r['occupation']})" if r["occupation"] else "")
        if re.search(r"\d{4}-\d{2}-\d{2}|^\d[\d/.-]*$", r["occupation"]):
            loi.append(f"{t}: nghề nghiệp là ngày/số — đã xoá, nhập lại.")
            r["occupation"] = ""
        if not r["occupation"]:
            loi.append(f"Việc làm {i + 1}: thiếu nghề nghiệp.")
        if not r["from"]:
            loi.append(f"{t}: thiếu thời gian bắt đầu.")
        for k in ("from", "to"):
            if r[k] and not _THANG.match(r[k]):
                loi.append(f"{t}: '{r[k]}' chưa đúng dạng YYYY-MM.")
        if _THANG.match(r["from"]) and _THANG.match(r["to"]) and r["to"] < r["from"]:
            loi.append(f"{t}: 'đến' trước 'từ'.")
        for k, toi_da in (("occupation", 75), ("employer", 75), ("city", 30)):
            if len(r[k]) > toi_da:
                loi.append(f"{t}: ô {k} dài {len(r[k])} ký tự (form tối đa {toi_da}).")
    for k, chi_tiet, nhan in (("bgTb", "bgMedicalDetails", "1A lao phổi"), ("bgDisorder", "bgMedicalDetails", "1B bệnh"),
                              ("bgOverstay", "bgRefusedDetails", "2A ở quá hạn"), ("bgRefused", "bgRefusedDetails", "2B bị từ chối visa"),
                              ("bgApplied", "bgRefusedDetails", "2C từng nộp đơn vào Canada"),
                              ("bgCriminal", "bgCriminalDetails", "3 tiền án"), ("bgMilitary", "bgMilitaryDetails", "4 quân đội")):
        if d[k] == "Y" and not d[chi_tiet]:
            loi.append(f"Lý lịch câu {nhan}: chọn 'Có' nhưng chưa ghi chi tiết.")
    if d["sex"] == "Male" and d["bgMilitary"] == "N":
        loi.append("Nam giới: hỏi lại khách đã đi nghĩa vụ quân sự / công an / dân quân chưa (câu 4) — đang để 'Không'.")
    if d["workPermitType"] == "LMOS" and not d["lmia"]:
        loi.append("Loại giấy phép LMIA nhưng chưa có số LMIA.")
    if not (d["employerName"] and d["jobTitle"]):
        loi.append("Phần việc làm ở Canada (nhà tuyển dụng, chức danh, LMIA, nơi làm) chưa đủ — nhập tay.")
    for k, toi_da in DO_DAI.items():
        if len(d.get(k) or "") > toi_da:
            loi.append(f"Ô '{k}' dài {len(d[k])} ký tự (form tối đa {toi_da}) — rút gọn.")
    return loi


# ---------------------------------------------------------------------------
# 4. Điền PDF (chỉ XFA datasets)
# ---------------------------------------------------------------------------

def _tach_ngay(goc: str, v: str, nam="FromYr", thang="FromMM", ngay="FromDD") -> dict:
    """Ô ẩn YYYY / MM / DD đi kèm ô ngày (form tự tách khi gõ tay trong Adobe — điền sẵn cho đủ)."""
    m = _NGAY.match(v or "") and v.split("-")
    return {f"{goc}.{nam}": m[0] if m else "", f"{goc}.{thang}": m[1] if m else "", f"{goc}.{ngay}": m[2] if m else ""}


def _gia_tri_o(d: dict) -> dict:
    """{đường dẫn dữ liệu (dưới form1, "[i]" = phần tử thứ i cùng tên) : giá trị chuỗi}."""
    qg = ma_quoc_gia
    o: dict = {}
    p1 = "Page1.PersonalDetails"
    o[f"{p1}.UCIClientID"] = d["uci"]
    o[f"{p1}.ServiceIn.ServiceIn"] = NGON_NGU_PHUC_VU.get(d["serviceIn"], "01")
    o[f"{p1}.Name.FamilyName"] = d["familyName"]
    o[f"{p1}.Name.GivenName"] = d["givenName"]
    o[f"{p1}.AliasName.AliasNameIndicator.AliasNameIndicator"] = d["aliasUsed"]
    o[f"{p1}.AliasName.AliasFamilyName"] = d["aliasFamilyName"] if d["aliasUsed"] == "Y" else ""
    o[f"{p1}.AliasName.AliasGivenName"] = d["aliasGivenName"] if d["aliasUsed"] == "Y" else ""
    o[f"{p1}.Sex.Sex"] = d["sex"]
    dob = d["dob"].split("-") if _NGAY.match(d["dob"]) else ["", "", ""]
    o[f"{p1}.DOBYear"], o[f"{p1}.DOBMonth"], o[f"{p1}.DOBDay"] = dob
    o[f"{p1}.PlaceBirthCity"] = d["birthCity"]
    o[f"{p1}.PlaceBirthCountry"] = qg(d["birthCountry"])
    o[f"{p1}.Citizenship.Citizenship"] = qg(d["citizenship"])
    o[f"{p1}.CurrentCOR.Row2.Country"] = qg(d["corCountry"])
    o[f"{p1}.CurrentCOR.Row2.Status"] = TINH_TRANG_CU_TRU.get(d["corStatus"], "")
    o[f"{p1}.CurrentCOR.Row2.FromDate"] = d["corFrom"]
    o[f"{p1}.CurrentCOR.Row2.ToDate"] = d["corTo"]
    o.update(_tach_ngay(f"{p1}.CORDates", d["corFrom"]))
    o.update(_tach_ngay(f"{p1}.CORDates", d["corTo"], "ToYr", "ToMM", "ToDD"))
    o[f"{p1}.PCRIndicator"] = "Y" if d["previousCOR"] else "N"
    for i in range(SO_NUOC_TRUOC):
        r = d["previousCOR"][i] if i < len(d["previousCOR"]) else {}
        hang, ngay = f"{p1}.PreviousCOR.Row{i + 2}", f"{p1}.PCRDatesR{i + 1}"
        o[f"{hang}.Country"] = qg(r.get("country", ""))
        o[f"{hang}.Status"] = TINH_TRANG_CU_TRU.get(r.get("status", ""), "")
        o[f"{hang}.FromDate"] = r.get("from", "")
        o[f"{hang}.ToDate"] = r.get("to", "")
        o.update(_tach_ngay(ngay, r.get("from", "")))
        o.update(_tach_ngay(ngay, r.get("to", ""), "ToYr", "ToMM", "ToDD"))

    m1 = "Page1.MaritalStatus.SectionA"
    co_vo_chong = d["maritalStatus"] in ("Married", "Common-Law")
    o[f"{m1}.MaritalStatus"] = TINH_TRANG.get(d["maritalStatus"], "")
    o[f"{m1}.DateOfMarriage"] = d["marriageDate"] if co_vo_chong else ""
    o.update(_tach_ngay(f"{m1}.MarriageDate", d["marriageDate"] if co_vo_chong else ""))
    o[f"{m1}.FamilyName"] = d["spouseFamilyName"] if co_vo_chong else ""
    o[f"{m1}.GivenName"] = d["spouseGivenName"] if co_vo_chong else ""

    m2 = "Page2.MaritalStatus.SectionA"
    truoc = d["prevMarried"] == "Y"
    o[f"{m2}.PrevMarriedIndicator"] = d["prevMarried"]
    o[f"{m2}.PMFamilyName"] = d["pmFamilyName"] if truoc else ""
    o[f"{m2}.GivenName.PMGivenName"] = d["pmGivenName"] if truoc else ""
    o.update(_tach_ngay(f"{m2}.PrevSpouseDOB", d["pmDob"] if truoc else "", "DOBYear", "DOBMonth", "DOBDay"))
    o[f"{m2}.TypeOfRelationship"] = QUAN_HE_TRUOC.get(d["pmType"], "") if truoc else ""
    o[f"{m2}.FromDate"] = d["pmFrom"] if truoc else ""
    o[f"{m2}.ToDate.ToDate"] = d["pmTo"] if truoc else ""
    o.update(_tach_ngay(f"{m2}.PreviouslyMarriedDates", d["pmFrom"] if truoc else ""))
    o.update(_tach_ngay(f"{m2}.PreviouslyMarriedDates", d["pmTo"] if truoc else "", "ToYr", "ToMM", "ToDD"))

    ln = f"{m2}.Languages"
    o[f"{ln}.languages.nativeLang.nativeLang"] = _ngon_ngu().get(d["nativeLanguage"], "")
    o[f"{ln}.languages.ableToCommunicate.ableToCommunicate"] = d["communicate"]
    o[f"{ln}.LanguageTest"] = d["languageTest"]

    pp = f"{m2}.Passport"
    o[f"{pp}.PassportNum.PassportNum"] = d["passportNumber"]
    o[f"{pp}.CountryofIssue.CountryofIssue"] = qg(d["passportCountry"])
    o[f"{pp}.IssueDate.IssueDate"] = d["passportIssue"]
    o[f"{pp}.ExpiryDate"] = d["passportExpiry"]
    o.update(_tach_ngay(pp, d["passportIssue"], "IssueYYYY", "IssueMM", "IssueDD"))
    o.update(_tach_ngay(pp, d["passportExpiry"], "expiryYYYY", "expiryMM", "expiryDD"))

    co_cccd = d["hasNationalId"] == "Y"
    o["Page2.natID.q1.natIDIndicator"] = d["hasNationalId"]
    o["Page2.natID.natIDdocs.DocNum.DocNum"] = d["nationalIdNumber"] if co_cccd else ""
    o["Page2.natID.natIDdocs.CountryofIssue.CountryofIssue"] = qg(d["nationalIdCountry"]) if co_cccd else ""
    o["Page2.natID.natIDdocs.IssueDate.IssueDate"] = d["nationalIdIssue"] if co_cccd else ""
    o["Page2.natID.natIDdocs.ExpiryDate"] = d["nationalIdExpiry"] if co_cccd else ""

    lh = "Page2.ContactInformation.contact"
    o[f"{lh}.AddressRow1.Apt.AptUnit"] = d["aptUnit"]
    o[f"{lh}.AddressRow1.StreetNum.StreetNum"] = d["streetNum"]
    o[f"{lh}.AddressRow1.Streetname.Streetname"] = d["streetName"]
    o[f"{lh}.AddressRow2.CityTow.CityTown"] = d["cityTown"]
    o[f"{lh}.AddressRow2.Country.Country"] = qg(d["addressCountry"])
    o[f"{lh}.AddressRow2.PostalCode.PostalCode"] = d["postalCode"]
    o[f"{lh}.AddressRow2.District"] = d["district"]
    o[f"{lh}.SameAsMailingIndicator"] = "Y"
    dt = f"{lh}.PhoneNumbers.Phone"
    co_so = bool(d["phoneNumber"])
    o[f"{dt}.Type"] = LOAI_DIEN_THOAI.get(d["phoneType"], "") if co_so else ""
    # Số ngoài Bắc Mỹ: tick "Other" (1) + mã nước + số; ô ActualNumber form tự tính lại khi mở.
    o[f"{dt}.CanadaUS"] = "0"
    o[f"{dt}.Other"] = "1" if co_so else "0"
    o[f"{dt}.NumberCountry"] = "84" if co_so else ""
    o[f"{dt}.IntlNumber.IntlNumber"] = d["phoneNumber"]
    o[f"{dt}.ActualNumber"] = d["phoneNumber"]
    o["Page3.FaxEmail.Email"] = d["email"]

    w = "Page3.DetailsOfIntendedWork.DetailsOfWork"
    o[f"{w}.TypeofWork.WorkPermitType"] = d["workPermitType"]
    o[f"{w}.PurposeRow1.EmployerName.EmployerName"] = d["employerName"]
    o[f"{w}.PurposeRow1.Address.Address"] = d["employerAddress"]
    o["Page3.IntendedLocationInCanada.intendedLocation.ProvinceState.ProvinceState"] = TINH_CANADA.get(d["workProvince"], "")
    o["Page3.IntendedLocationInCanada.intendedLocation.CityTown.CityTown"] = d["workCity"]
    o["Page3.IntendedLocationInCanada.intendedLocation.Address"] = d["workAddress"]
    ct = "Page3.DetailsOfWorkCont.details"
    o[f"{ct}.jobTitle"] = d["jobTitle"]
    o[f"{ct}.posDesc"] = d["jobDuties"]
    o[f"{ct}.HowLongStudy.FromDate"] = d["workFrom"]
    o[f"{ct}.HowLongStudy.ToDate"] = d["workTo"]
    o[f"{ct}.LMO.LMO"] = d["lmia"]

    hv = "Page3.PageWrapper.Education"
    co_hoc = d["hasEducation"] == "Y"
    o[f"{hv}.EducationIndicator"] = d["hasEducation"]
    tu = d["eduFrom"].split("-") if co_hoc and _THANG.match(d["eduFrom"]) else ["", ""]
    den = d["eduTo"].split("-") if co_hoc and _THANG.match(d["eduTo"]) else ["", ""]
    o[f"{hv}.Edu_Row1.FromYear"], o[f"{hv}.Edu_Row1.FromMonth"] = tu
    o[f"{hv}.Edu_Row1.ToYear"], o[f"{hv}.Edu_Row1.ToMonth"] = den
    o[f"{hv}.Edu_Row1.FieldOfStudy"] = d["eduField"] if co_hoc else ""
    o[f"{hv}.Edu_Row1.School"] = d["eduSchool"] if co_hoc else ""
    o[f"{hv}.Edu_Row1.CityTown"] = d["eduCity"] if co_hoc else ""
    o[f"{hv}.Edu_Row1.Country.Country"] = qg(d["eduCountry"]) if co_hoc else ""

    for i in range(SO_VIEC_LAM):
        r = d["occupations"][i] if i < len(d["occupations"]) else {}
        h = f"Page3.PageWrapper.Occupation.OccupationRow{i + 1}"
        tu = r.get("from", "").split("-") if _THANG.match(r.get("from", "")) else ["", ""]
        den = r.get("to", "").split("-") if _THANG.match(r.get("to", "")) else ["", ""]
        o[f"{h}.FromYear"], o[f"{h}.FromMonth"] = tu
        o[f"{h}.ToYear"], o[f"{h}.ToMonth"] = den
        o[f"{h}.Occupation.Occupation"] = r.get("occupation", "")
        o[f"{h}.Employer"] = r.get("employer", "")
        o[f"{h}.CityTown.CityTown"] = r.get("city", "")
        # Dòng trống thì xoá luôn mã Vietnam điền sẵn của file mẫu.
        o[f"{h}.Country.Country"] = qg(r.get("country", "")) if r else ""

    bg = "Page4"
    o[f"{bg}.BackgroundInfo.Choice[0]"] = d["bgTb"]
    o[f"{bg}.BackgroundInfo.Choice[1]"] = d["bgDisorder"]
    o[f"{bg}.BackgroundInfo.Details.MedicalDetails"] = d["bgMedicalDetails"]
    o[f"{bg}.BackgroundInfo2.VisaChoice1"] = d["bgOverstay"]
    o[f"{bg}.BackgroundInfo2.VisaChoice2"] = d["bgRefused"]
    o[f"{bg}.BackgroundInfo2.VisaChoice3"] = d["bgApplied"]
    o[f"{bg}.BackgroundInfo2.Details.refusedDetails"] = d["bgRefusedDetails"]
    o[f"{bg}.PageWrapper.BackgroundInfo3.Choice"] = d["bgCriminal"]
    o[f"{bg}.PageWrapper.BackgroundInfo3.militaryServiceDetails"] = d["bgCriminalDetails"]
    o[f"{bg}.PageWrapper.Military.Choice"] = d["bgMilitary"]
    o[f"{bg}.PageWrapper.Military.militaryServiceDetails"] = d["bgMilitaryDetails"]
    o[f"{bg}.PageWrapper.Occupation.Choice"] = d["bgViolentOrg"]
    o[f"{bg}.PageWrapper.GovPosition.Choice"] = d["bgIllTreatment"]
    return o


def _tim_nut(goc, duong: str):
    nut = goc
    for phan in duong.split("."):
        m = re.match(r"(.+?)(?:\[(\d+)\])?$", phan)
        ten, so = m.group(1), int(m.group(2) or 0)
        cung_ten = [c for c in nut if c.tag == ten]
        if so >= len(cung_ten):
            return None
        nut = cung_ten[so]
    return nut


def dien_pdf(d: dict) -> bytes:
    o = _gia_tri_o(d)
    doc = fitz.open(MAU)
    try:
        x_ds = _xfa_datasets(doc)
        ET.register_namespace("xfa", _XFA_NS[1:-1])
        goc = ET.fromstring(doc.xref_stream(x_ds))
        form = goc.find(f"{_XFA_NS}data").find("form1")
        thieu = []
        for k, v in o.items():
            nut = _tim_nut(form, k)
            if nut is None:
                thieu.append(k)
                continue
            nut.text = v or None
        if thieu:
            logger.warning("IMM1295: không thấy ô dữ liệu %s", thieu)
        doc.update_stream(x_ds, ET.tostring(goc, encoding="utf-8"))
        # Gỡ chữ ký chứng thực (DocMDP) + quyền mở rộng (UR3) của file gốc: dữ liệu đã đổi nên chữ ký chắc chắn hỏng,
        # để lại thì Adobe báo "tài liệu đã bị thay đổi sau khi chứng thực".
        cat = doc.pdf_catalog()
        doc.xref_set_key(cat, "Perms", "null")
        for trang in doc:
            for w in trang.widgets():
                if w.field_type_string == "Signature":
                    doc.xref_set_key(w.xref, "V", "null")
        acro = int(doc.xref_get_key(cat, "AcroForm")[1].split()[0])
        doc.xref_set_key(acro, "SigFlags", "null")
        return doc.tobytes(garbage=1, deflate=True)
    finally:
        doc.close()
