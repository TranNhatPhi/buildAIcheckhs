"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { API_URL, gioNgayVN, normalizeSearchText } from "@/lib/format";
import { FORM_INPUT, FORM_LABEL } from "@/lib/formStyles";
import { docJson, ghiJson } from "@/lib/luuTam";
import type { CaseListItemDTO } from "@/lib/client-types";

interface NuocTruoc {
  country: string;
  status: string;
  from: string;
  to: string;
}

interface ViecLam {
  from: string;
  to: string;
  occupation: string;
  employer: string;
  city: string;
  country: string;
}

// Dữ liệu PHẲNG như backend imm1295.chuan_hoa — ô chữ / ngày / Y-N truy cập theo khoá.
type DuLieu = {
  previousCOR: NuocTruoc[];
  occupations: ViecLam[];
  canhBao: string[];
  nguon: string[];
  nguonGiayTo: string[];
  // Backend `imm1295.kiem_tra`: chỗ cần xem lại (đã tự sửa lỗi chắc chắn).
  kiemTra?: string[];
} & Record<string, unknown>;

type Loai = "chu" | "ngay" | "thang" | "ck" | "chon" | "quocgia";
interface O {
  k: string;
  nhan: string;
  loai?: Loai;
  chon?: readonly (readonly [string, string])[];
  rong?: boolean; // chiếm 2 cột
  hien?: (d: DuLieu) => boolean;
}

// Giống các bảng mã trong backend imm1295.py.
const dsChon = (...v: string[]) => v.map((x) => [x, x] as const);
const TINH_TRANG_CU_TRU = dsChon("Citizen", "Permanent resident", "Visitor", "Worker", "Student", "Other", "Foreign National");
const TINH_CANADA = dsChon("AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT");
const co = (d: DuLieu, k: string) => d[k] === "Y";
const coVoChong = (d: DuLieu) => d.maritalStatus === "Married" || d.maritalStatus === "Common-Law";

// Một CÂU HỎI trên form: số câu + tên đúng như IMM 1295E, các ô theo thứ tự trái -> phải trên form.
// `dac` = khối đặc biệt (bảng dòng), `ghi` = câu cố định chỉ hiện giá trị điền sẵn.
interface Cau {
  so: string;
  ten: string;
  o?: O[];
  dac?: "nuocTruoc" | "viecLam";
  ghi?: string;
  cot?: 1 | 2 | 3 | 4; // độ rộng khối trên lưới 4 cột (mặc định = số ô, tối đa 4)
  hien?: (d: DuLieu) => boolean;
}

const CO_HOC = (d: DuLieu) => co(d, "hasEducation");
const CO_TEN_KHAC = (d: DuLieu) => co(d, "aliasUsed");
const CO_HON_NHAN_TRUOC = (d: DuLieu) => co(d, "prevMarried");
const CO_CCCD = (d: DuLieu) => co(d, "hasNationalId");

// THỨ TỰ + SỐ CÂU y như form IMM 1295E (10-2019): trang 1 -> 4, trên xuống, trái qua phải.
const PHAN: { tieuDe: string; cau: Cau[] }[] = [
  {
    tieuDe: "Đầu form (trang 1)",
    cau: [
      { so: "1", ten: "UCI", o: [{ k: "uci", nhan: "UCI (nếu đã có)" }] },
      {
        so: "2",
        ten: "I want service in",
        o: [{ k: "serviceIn", nhan: "Ngôn ngữ phục vụ", loai: "chon", chon: dsChon("English", "French") }],
      },
    ],
  },
  {
    tieuDe: "PERSONAL DETAILS — Thông tin cá nhân",
    cau: [
      {
        so: "1",
        ten: "Full name — Họ tên (theo hộ chiếu)",
        o: [
          { k: "familyName", nhan: "Family name — Họ" },
          { k: "givenName", nhan: "Given name(s) — Tên đệm + tên" },
        ],
      },
      {
        so: "2",
        ten: "Have you ever used any other name? — Từng dùng tên khác?",
        o: [
          { k: "aliasUsed", nhan: "2A. Yes / No", loai: "ck" },
          { k: "aliasFamilyName", nhan: "2B. Family name", hien: CO_TEN_KHAC },
          { k: "aliasGivenName", nhan: "Given name(s)", hien: CO_TEN_KHAC },
        ],
        cot: 3,
      },
      {
        so: "3",
        ten: "Sex — Giới tính",
        o: [{ k: "sex", nhan: "Sex", loai: "chon", chon: [["Male", "Male — Nam"], ["Female", "Female — Nữ"]] }],
      },
      { so: "4", ten: "Date of birth — Ngày sinh", o: [{ k: "dob", nhan: "YYYY-MM-DD", loai: "ngay" }] },
      {
        so: "5",
        ten: "Place of birth — Nơi sinh",
        o: [
          { k: "birthCity", nhan: "City/Town — Thành phố / tỉnh" },
          { k: "birthCountry", nhan: "Country or Territory", loai: "quocgia" },
        ],
      },
      { so: "6", ten: "Citizenship — Quốc tịch", o: [{ k: "citizenship", nhan: "Citizenship", loai: "quocgia" }] },
      {
        so: "7",
        ten: "Current country or territory of residence — Nơi cư trú hiện tại",
        o: [
          { k: "corCountry", nhan: "Country or Territory", loai: "quocgia" },
          { k: "corStatus", nhan: "Status", loai: "chon", chon: TINH_TRANG_CU_TRU },
          { k: "corFrom", nhan: "From (chỉ cần khi 'Other')", loai: "ngay" },
          { k: "corTo", nhan: "To", loai: "ngay" },
        ],
      },
      {
        so: "8",
        ten: "Previous countries of residence (5 năm qua, > 6 tháng) — 8A tự là Yes khi có dòng",
        dac: "nuocTruoc",
        cot: 4,
      },
      {
        so: "9",
        ten: "Country where applying — Nơi nộp đơn",
        ghi: "9A: Yes — cùng nước cư trú hiện tại (giữ như file mẫu)",
        cot: 4,
      },
      {
        so: "10",
        ten: "Marital status — Hôn nhân",
        o: [
          {
            k: "maritalStatus",
            nhan: "10A. Current marital status",
            loai: "chon",
            chon: dsChon("Single", "Married", "Common-Law", "Divorced", "Separated", "Widowed", "Annulled Marriage"),
          },
          { k: "marriageDate", nhan: "10B. Date of marriage / common-law", loai: "ngay", hien: coVoChong },
          { k: "spouseFamilyName", nhan: "10C. Spouse family name", hien: coVoChong },
          { k: "spouseGivenName", nhan: "Spouse given name(s)", hien: coVoChong },
        ],
        cot: 4,
      },
    ],
  },
  {
    tieuDe: "PERSONAL DETAILS (tiếp — trang 2)",
    cau: [
      {
        so: "11",
        ten: "Previously married or in a common-law relationship? — Hôn nhân trước",
        o: [
          { k: "prevMarried", nhan: "11A. Yes / No", loai: "ck" },
          { k: "pmFamilyName", nhan: "11B. Family name", hien: CO_HON_NHAN_TRUOC },
          { k: "pmGivenName", nhan: "Given name(s)", hien: CO_HON_NHAN_TRUOC },
          { k: "pmDob", nhan: "Date of birth", loai: "ngay", hien: CO_HON_NHAN_TRUOC },
          { k: "pmType", nhan: "11C. Type of relationship", loai: "chon", chon: dsChon("Married", "Common-Law"), hien: CO_HON_NHAN_TRUOC },
          { k: "pmFrom", nhan: "11D. From", loai: "ngay", hien: CO_HON_NHAN_TRUOC },
          { k: "pmTo", nhan: "To", loai: "ngay", hien: CO_HON_NHAN_TRUOC },
        ],
        cot: 4,
      },
    ],
  },
  {
    tieuDe: "LANGUAGES — Ngôn ngữ",
    cau: [
      {
        so: "1",
        ten: "Languages",
        o: [
          { k: "nativeLanguage", nhan: "1A. Native language" },
          { k: "communicate", nhan: "1B. Communicate in English / French", loai: "chon", chon: dsChon("English", "French", "Both", "Neither") },
          { k: "languageTest", nhan: "1D. Test by designated agency (IELTS, CELPIP, TEF…)?", loai: "ck", rong: true },
        ],
        cot: 4,
      },
    ],
  },
  {
    tieuDe: "PASSPORT — Hộ chiếu",
    cau: [
      { so: "1", ten: "Passport number", o: [{ k: "passportNumber", nhan: "Số hộ chiếu" }] },
      { so: "2", ten: "Country or territory of issue", o: [{ k: "passportCountry", nhan: "Nước cấp", loai: "quocgia" }] },
      { so: "3", ten: "Issue date", o: [{ k: "passportIssue", nhan: "Ngày cấp", loai: "ngay" }] },
      { so: "4", ten: "Expiry date", o: [{ k: "passportExpiry", nhan: "Ngày hết hạn", loai: "ngay" }] },
    ],
  },
  {
    tieuDe: "NATIONAL IDENTITY DOCUMENT — CCCD",
    cau: [
      { so: "1", ten: "Do you have a national identity document?", o: [{ k: "hasNationalId", nhan: "Yes / No", loai: "ck" }] },
      { so: "2", ten: "Document number", o: [{ k: "nationalIdNumber", nhan: "Số CCCD" }], hien: CO_CCCD },
      { so: "3", ten: "Country or territory of issue", o: [{ k: "nationalIdCountry", nhan: "Nước cấp", loai: "quocgia" }], hien: CO_CCCD },
      { so: "4", ten: "Issue date", o: [{ k: "nationalIdIssue", nhan: "Ngày cấp", loai: "ngay" }], hien: CO_CCCD },
      { so: "5", ten: "Expiry date", o: [{ k: "nationalIdExpiry", nhan: "Có giá trị đến", loai: "ngay" }], hien: CO_CCCD },
    ],
  },
  {
    tieuDe: "US PR CARD",
    cau: [{ so: "1", ten: "Lawful permanent resident of the United States?", ghi: "No (giữ như file mẫu)", cot: 4 }],
  },
  {
    tieuDe: "CONTACT INFORMATION — Liên hệ (địa chỉ ưu tiên CT07 rồi CCCD)",
    cau: [
      {
        so: "1",
        ten: "Current mailing address — Địa chỉ nhận thư",
        o: [
          { k: "aptUnit", nhan: "Apt/Unit — Căn hộ" },
          { k: "streetNum", nhan: "Street no. — Số nhà" },
          { k: "streetName", nhan: "Street name — Đường / thôn + xã", rong: true },
          { k: "cityTown", nhan: "City/Town — Tỉnh / thành phố" },
          { k: "addressCountry", nhan: "Country or Territory", loai: "quocgia" },
          { k: "postalCode", nhan: "Postal code" },
          { k: "district", nhan: "District — Huyện / quận" },
        ],
        cot: 4,
      },
      { so: "2", ten: "Residential address same as mailing address?", ghi: "Yes (giữ như file mẫu)", cot: 4 },
      {
        so: "3",
        ten: "Telephone no. — Điện thoại (tick Other, country code 84 tự điền)",
        o: [
          { k: "phoneType", nhan: "Type", loai: "chon", chon: dsChon("Cellular", "Residence", "Business") },
          { k: "phoneNumber", nhan: "No. — bỏ số 0 đầu" },
        ],
      },
      { so: "6", ten: "E-mail address", o: [{ k: "email", nhan: "Email", rong: true }], cot: 2 },
    ],
  },
  {
    tieuDe: "DETAILS OF INTENDED WORK IN CANADA — Việc làm ở Canada (thường nhập tay)",
    cau: [
      {
        so: "1",
        ten: "Type of work permit",
        o: [
          {
            k: "workPermitType",
            nhan: "Loại giấy phép",
            loai: "chon",
            chon: [
              ["ELMO", "Exemption from LMIA (ELMO)"],
              ["LMOS", "LMIA stream (LMOS)"],
              ["OWP", "Open Work Permit (OWP)"],
              ["SAWP", "Seasonal Agricultural (SAWP)"],
              ["SBC", "Start-up Business Class (SBC)"],
              ["Other", "Other"],
            ],
          },
        ],
        cot: 2,
      },
      {
        so: "2",
        ten: "Employer",
        o: [
          { k: "employerName", nhan: "2A. Name of employer" },
          { k: "employerAddress", nhan: "2B. Address of employer" },
        ],
        cot: 4,
      },
      {
        so: "3",
        ten: "Intended location of employment",
        o: [
          { k: "workProvince", nhan: "Province/Territory", loai: "chon", chon: TINH_CANADA },
          { k: "workCity", nhan: "City/Town" },
          { k: "workAddress", nhan: "Address", rong: true },
        ],
        cot: 4,
      },
      {
        so: "4",
        ten: "Job",
        o: [
          { k: "jobTitle", nhan: "Job title — Chức danh" },
          { k: "jobDuties", nhan: "Brief description of duties (≤ 100 ký tự)", rong: true },
        ],
        cot: 3,
      },
      {
        so: "5",
        ten: "Duration of expected employment",
        o: [
          { k: "workFrom", nhan: "From", loai: "ngay" },
          { k: "workTo", nhan: "To", loai: "ngay" },
        ],
      },
      { so: "6", ten: "LMIA no. / Offer of employment (LMIA exempt) no.", o: [{ k: "lmia", nhan: "Số LMIA" }], cot: 2 },
    ],
  },
  {
    tieuDe: "EDUCATION — Học vấn sau THPT (bằng cao nhất)",
    cau: [
      {
        so: "1",
        ten: "Any post-secondary education (university, college, apprenticeship)?",
        o: [
          { k: "hasEducation", nhan: "Yes / No", loai: "ck" },
          { k: "eduFrom", nhan: "From (YYYY-MM)", loai: "thang", hien: CO_HOC },
          { k: "eduTo", nhan: "To (YYYY-MM)", loai: "thang", hien: CO_HOC },
          { k: "eduField", nhan: "Field of study (≤ 30)", hien: CO_HOC },
          { k: "eduSchool", nhan: "School/Facility name", rong: true, hien: CO_HOC },
          { k: "eduCity", nhan: "City/Town", hien: CO_HOC },
          { k: "eduCountry", nhan: "Country or Territory", loai: "quocgia", hien: CO_HOC },
        ],
        cot: 4,
      },
    ],
  },
  {
    tieuDe: "EMPLOYMENT — Việc làm 10 năm gần đây (dòng 1 = hiện tại)",
    cau: [{ so: "", ten: "", dac: "viecLam", cot: 4 }],
  },
  {
    tieuDe: "BACKGROUND INFORMATION — Lý lịch (trang 4)",
    cau: [
      {
        so: "1",
        ten: "Health",
        o: [
          { k: "bgTb", nhan: "1A. Lao phổi (bản thân / gia đình) hoặc tiếp xúc người lao trong 2 năm qua?", loai: "ck", rong: true },
          { k: "bgDisorder", nhan: "1B. Bệnh thể chất / tâm thần cần dịch vụ y tế, xã hội ở Canada?", loai: "ck", rong: true },
          { k: "bgMedicalDetails", nhan: "1C. Details", rong: true, hien: (d) => co(d, "bgTb") || co(d, "bgDisorder") },
        ],
        cot: 4,
      },
      {
        so: "2",
        ten: "Immigration history",
        o: [
          { k: "bgOverstay", nhan: "2A. Từng ở quá hạn / học, làm trái phép ở Canada?", loai: "ck", rong: true },
          { k: "bgRefused", nhan: "2B. Từng bị từ chối visa / nhập cảnh / bị trục xuất (Canada hoặc nước khác)?", loai: "ck", rong: true },
          { k: "bgApplied", nhan: "2C. Từng nộp đơn vào / ở lại Canada?", loai: "ck", rong: true },
          {
            k: "bgRefusedDetails",
            nhan: "2D. Details (nước, năm, loại visa)",
            rong: true,
            hien: (d) => co(d, "bgOverstay") || co(d, "bgRefused") || co(d, "bgApplied"),
          },
        ],
        cot: 4,
      },
      {
        so: "3",
        ten: "Criminal",
        o: [
          { k: "bgCriminal", nhan: "3A. Từng phạm tội / bị bắt / bị buộc tội ở bất kỳ nước nào?", loai: "ck", rong: true },
          { k: "bgCriminalDetails", nhan: "3B. Details", rong: true, hien: (d) => co(d, "bgCriminal") },
        ],
        cot: 4,
      },
      {
        so: "4",
        ten: "Military / police",
        o: [
          { k: "bgMilitary", nhan: "4A. Phục vụ quân đội, dân quân, công an (kể cả nghĩa vụ quân sự)?", loai: "ck", rong: true },
          { k: "bgMilitaryDetails", nhan: "4B. Details (đơn vị, cấp bậc, từ - đến)", rong: true, hien: (d) => co(d, "bgMilitary") },
        ],
        cot: 4,
      },
      {
        so: "5",
        ten: "Violent organization",
        o: [{ k: "bgViolentOrg", nhan: "Thành viên tổ chức / đảng phái chủ trương bạo lực?", loai: "ck", rong: true }],
        cot: 2,
      },
      {
        so: "6",
        ten: "Ill treatment",
        o: [{ k: "bgIllTreatment", nhan: "Chứng kiến / tham gia ngược đãi tù nhân, cướp bóc, xúc phạm nơi thờ tự?", loai: "ck", rong: true }],
        cot: 2,
      },
    ],
  },
];

// Lớp Tailwind tĩnh (không ghép chuỗi động) cho độ rộng khối câu / lưới ô bên trong.
const COT_KHOI = { 1: "lg:col-span-1", 2: "sm:col-span-2 lg:col-span-2", 3: "sm:col-span-2 lg:col-span-3", 4: "sm:col-span-2 lg:col-span-4" };
const COT_TRONG = { 1: "grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" };
const SO_NUOC_TRUOC = 2;
const SO_VIEC_LAM = 3;
const o = "w-full rounded-lg border border-neutral-300 px-2 py-1 text-sm";
const sai = (loai: Loai | undefined, v: string) =>
  !!v &&
  ((loai === "ngay" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) || (loai === "thang" && !/^\d{4}-\d{2}$/.test(v)));

/** Một ô trên form theo khai báo `O`. */
function OInput({
  loai,
  chon,
  v,
  doi,
}: {
  loai?: Loai;
  chon?: O["chon"];
  v: string;
  doi: (v: string) => void;
}) {
  if (loai === "ck") {
    return (
      <select className={o} value={v} onChange={(e) => doi(e.target.value)}>
        <option value="N">Không (No)</option>
        <option value="Y">Có (Yes)</option>
      </select>
    );
  }
  if (loai === "chon") {
    return (
      <select className={o} value={v} onChange={(e) => doi(e.target.value)}>
        <option value="">—</option>
        {chon?.map(([gt, nhan]) => (
          <option key={gt} value={gt}>
            {nhan}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className={`${o} ${sai(loai, v) ? "border-amber-400 bg-amber-50" : ""}`}
      value={v}
      list={loai === "quocgia" ? "imm1295-quoc-gia" : undefined}
      placeholder={loai === "ngay" ? "YYYY-MM-DD" : loai === "thang" ? "YYYY-MM" : undefined}
      onChange={(e) => doi(e.target.value)}
    />
  );
}

/**
 * Tab "Điền form IMM1295e" (/dien-form-imm1295): chọn hồ sơ -> AI đọc Phiếu TT khách hàng, hộ chiếu, CCCD, CT07, đăng
 * ký kết hôn, bằng cấp, CV… (backend imm1295.py) -> nhân viên xem / sửa -> lưu -> tải PDF đã điền (mở bằng Adobe Reader
 * — form XFA thuần). Dữ liệu lưu theo HỒ SƠ (Case.imm1295Data) nên F5 / mở máy khác vẫn còn. Làm giống tab IMM5645e.
 */
export function DienFormImm1295() {
  const [hoSo, setHoSo] = useState<CaseListItemDTO[]>([]);
  const [tim, setTim] = useState("");
  const [caseId, setCaseId] = useState("");
  const [data, setData] = useState<DuLieu | null>(null);
  const [giayTo, setGiayTo] = useState<string[]>([]);
  const [quocGia, setQuocGia] = useState<string[]>([]);
  const [capNhat, setCapNhat] = useState<string | null>(null);
  const [daSua, setDaSua] = useState(false);
  const [dangDoc, setDangDoc] = useState(false);
  const [giay, setGiay] = useState(0);
  const [dangLuu, setDangLuu] = useState(false);
  const [loi, setLoi] = useState<string | null>(null);

  // Chọn hồ sơ: nhớ lựa chọn (F5 vẫn còn) và tải dữ liệu form đã lưu của hồ sơ đó.
  function chonHoSo(id: string) {
    if (daSua && !confirm("Bỏ các thay đổi chưa lưu của hồ sơ đang mở?")) return;
    setCaseId(id);
    ghiJson("imm1295:caseId", id);
    setData(null);
    setGiayTo([]);
    setLoi(null);
    setDaSua(false);
    setCapNhat(null);
    if (!id) return;
    fetch(`${API_URL}/imm1295/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setData(d.data);
        setGiayTo(d.giayTo ?? []);
        setQuocGia(d.quocGia ?? []);
        setCapNhat(d.updatedAt);
      })
      .catch(() => setLoi("Không tải được dữ liệu — thử lại sau."));
  }

  useEffect(() => {
    fetch(`${API_URL}/cases`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: CaseListItemDTO[]) => {
        setHoSo([...d].sort((a, b) => a.clientName.localeCompare(b.clientName, "vi")));
        const ma = docJson<string>("imm1295:caseId");
        if (ma && d.some((c) => c.id === ma)) chonHoSo(ma);
      })
      .catch(() => setHoSo([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy 1 lần lúc mở trang
  }, []);

  useEffect(() => {
    if (!dangDoc) return;
    const t = setInterval(() => setGiay((g) => g + 1), 1000);
    return () => clearInterval(t);
  }, [dangDoc]);

  // Rời trang khi còn sửa chưa lưu -> hỏi lại.
  useEffect(() => {
    if (!daSua) return;
    const chan = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", chan);
    return () => window.removeEventListener("beforeunload", chan);
  }, [daSua]);

  const hoSoLoc = useMemo(() => {
    const q = normalizeSearchText(tim.trim());
    return q ? hoSo.filter((c) => normalizeSearchText(`${c.clientName} ${c.partner ?? ""}`).includes(q)) : hoSo;
  }, [hoSo, tim]);

  async function docBangAi() {
    if (!caseId) return;
    if (data && !confirm("Đọc lại bằng AI? Các chỗ bạn đã sửa trên form sẽ bị thay bằng kết quả mới.")) return;
    setLoi(null);
    setGiay(0);
    setDangDoc(true);
    try {
      const r = await fetch(`${API_URL}/imm1295/${caseId}/extract`, { method: "POST" });
      const d = await r.json().catch(() => null);
      if (!r.ok) return setLoi(typeof d?.detail === "string" ? d.detail : "AI không đọc được — thử lại.");
      setData(d.data);
      setCapNhat(d.updatedAt);
      setDaSua(false);
    } catch {
      setLoi("Không kết nối được máy chủ — thử lại sau.");
    } finally {
      setDangDoc(false);
    }
  }

  async function luu(): Promise<boolean> {
    if (!data) return false;
    setDangLuu(true);
    try {
      const r = await fetch(`${API_URL}/imm1295/${caseId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setLoi(typeof d?.detail === "string" ? d.detail : "Không lưu được — thử lại.");
        return false;
      }
      setData(d.data);
      setCapNhat(d.updatedAt);
      setDaSua(false);
      return true;
    } finally {
      setDangLuu(false);
    }
  }

  async function taiPdf() {
    if (daSua && !(await luu())) return;
    // TẢI VỀ (không mở tab): trình duyệt không vẽ được form XFA, phải mở bằng Adobe Reader.
    const a = document.createElement("a");
    a.href = `${API_URL}/imm1295/${caseId}/pdf`;
    a.download = "";
    a.click();
  }

  const doi = (thayDoi: Partial<DuLieu>) => {
    setData((cu) => (cu ? ({ ...cu, ...thayDoi } as DuLieu) : cu));
    setDaSua(true);
  };
  const doiDong = <K extends "previousCOR" | "occupations">(khoa: K, i: number, t: Partial<DuLieu[K][number]>) =>
    data && doi({ [khoa]: data[khoa].map((x, k) => (k === i ? { ...x, ...t } : x)) } as Partial<DuLieu>);

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Điền form IMM1295e</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Application for Work Permit (IMM 1295E). AI (DeepSeek Pro) đọc Phiếu TT khách hàng, hộ chiếu, CCCD, CT07, đăng
          ký kết hôn, bằng cấp, CV / xác nhận kinh nghiệm… của hồ sơ. Phần việc làm ở Canada (nhà tuyển dụng, LMIA)
          thường phải nhập tay. Bạn xem lại, sửa rồi tải PDF —{" "}
          <b className="text-neutral-700">mở bằng Adobe Acrobat Reader</b> (form XFA, trình duyệt chỉ hiện “Please
          wait…”), kiểm tra rồi bấm Validate trong form để tạo mã vạch.
        </p>
      </div>

      <div className="rounded-2xl border-2 border-neutral-200 bg-white p-5 flex flex-col gap-3">
        <span className={FORM_LABEL}>1. Hồ sơ của khách</span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={tim}
            onChange={(e) => setTim(e.target.value)}
            placeholder="🔍 Tìm tên khách / nguồn"
            className={`${FORM_INPUT} sm:w-64`}
            aria-label="Tìm hồ sơ"
          />
          <select value={caseId} onChange={(e) => chonHoSo(e.target.value)} className={`${FORM_INPUT} flex-1`}>
            <option value="">— Chọn hồ sơ ({hoSoLoc.length}) —</option>
            {hoSoLoc.map((c) => (
              <option key={c.id} value={c.id}>
                {c.clientName}
                {c.partner ? ` · ${c.partner}` : ""} · {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
              </option>
            ))}
          </select>
        </div>
        {caseId && (
          <>
            <p className="text-xs text-neutral-500">
              Giấy tờ AI sẽ đọc ({giayTo.length}):{" "}
              {giayTo.length ? giayTo.join(" · ") : "chưa có — hồ sơ cần Phiếu TT khách hàng / Passport / CCCD / CT07"}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={docBangAi}
                disabled={dangDoc || giayTo.length === 0}
                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {dangDoc ? "Đang đọc…" : data ? "🤖 Đọc lại từ hồ sơ" : "🤖 Đọc thông tin từ hồ sơ"}
              </button>
              {dangDoc && <span className="text-sm text-neutral-500 tabular-nums">{giay} giây — model DeepSeek Pro, thường 1-3 phút</span>}
              {capNhat && !dangDoc && (
                <span className="text-xs text-neutral-400">Lưu lần cuối: {gioNgayVN(capNhat)}</span>
              )}
            </div>
          </>
        )}
        {loi && <p className="text-sm text-red-600">{loi}</p>}
      </div>

      {data && (
        <>
          {(data.kiemTra?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-semibold">🔎 Kiểm tra tự động — cần xem lại ({data.kiemTra!.length}):</p>
              <ul className="mt-1 list-disc list-inside text-xs">
                {data.kiemTra!.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-red-700">Sửa trên bảng rồi bấm Lưu — danh sách này tự kiểm tra lại.</p>
            </div>
          )}
          {data.kiemTra?.length === 0 && (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
              ✓ Kiểm tra tự động: không thấy lỗi định dạng / thiếu thông tin.
            </p>
          )}
          {data.canhBao.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">⚠ AI lưu ý — kiểm tra lại trước khi tải ({data.canhBao.length}):</p>
              <ul className="mt-1 list-disc list-inside text-xs">
                {data.canhBao.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {data.nguon.length > 0 && (
            <details className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-xs text-neutral-500">
              <summary className="cursor-pointer font-semibold text-neutral-600">Nguồn AI đã lấy</summary>
              <ul className="mt-1 list-disc list-inside">
                {data.nguon.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </details>
          )}

          <datalist id="imm1295-quoc-gia">
            {quocGia.map((q) => (
              <option key={q} value={q} />
            ))}
          </datalist>

          {PHAN.map((phan) => (
            <section key={phan.tieuDe} className="flex flex-col gap-2">
              <h2 className="text-base font-bold uppercase tracking-wide text-neutral-800">{phan.tieuDe}</h2>
              <div className="grid grid-cols-1 gap-2 rounded-xl border border-neutral-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-4">
                {phan.cau
                  .filter((c) => !c.hien || c.hien(data))
                  .map((c) => {
                    const oHien = (c.o ?? []).filter((x) => !x.hien || x.hien(data));
                    const rongKhoi = c.cot ?? (Math.min(4, Math.max(1, oHien.length)) as 1 | 2 | 3 | 4);
                    const soCot = Math.min(rongKhoi, oHien.reduce((n, x) => n + (x.rong ? 2 : 1), 0) || 1) as 1 | 2 | 3 | 4;
                    return (
                      <div key={`${c.so}-${c.ten}`} className={`rounded-lg bg-neutral-50 p-2 ${COT_KHOI[rongKhoi]}`}>
                        {(c.so || c.ten) && (
                          <p className="mb-1 text-xs font-semibold text-neutral-700">
                            {c.so && <span className="mr-1 rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-700">{c.so}</span>}
                            {c.ten}
                          </p>
                        )}
                        {c.ghi && <p className="text-sm text-neutral-500">{c.ghi}</p>}
                        {oHien.length > 0 && (
                          <div className={`grid grid-cols-1 gap-2 ${COT_TRONG[soCot]}`}>
                            {oHien.map((x) => (
                              <label key={x.k} className={`text-xs text-neutral-500 ${x.rong && soCot > 1 ? "sm:col-span-2" : ""}`}>
                                {x.nhan}
                                <OInput loai={x.loai} chon={x.chon} v={String(data[x.k] ?? "")} doi={(v) => doi({ [x.k]: v })} />
                              </label>
                            ))}
                          </div>
                        )}
                        {c.dac === "nuocTruoc" && (
                          <DanhSachDong
                            tieuDe="Row"
                            luoi="sm:grid-cols-2 lg:grid-cols-4"
                            ds={data.previousCOR}
                            toiDa={SO_NUOC_TRUOC}
                            them={() => doi({ previousCOR: [...data.previousCOR, { country: "", status: "Worker", from: "", to: "" }] })}
                            bo={(i) => doi({ previousCOR: data.previousCOR.filter((_, k) => k !== i) })}
                            o={(r, i) => (
                              <>
                                <label className="text-xs text-neutral-500">
                                  Country or Territory
                                  <OInput loai="quocgia" v={r.country} doi={(v) => doiDong("previousCOR", i, { country: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  Status
                                  <OInput loai="chon" chon={TINH_TRANG_CU_TRU} v={r.status} doi={(v) => doiDong("previousCOR", i, { status: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  From
                                  <OInput loai="ngay" v={r.from} doi={(v) => doiDong("previousCOR", i, { from: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  To
                                  <OInput loai="ngay" v={r.to} doi={(v) => doiDong("previousCOR", i, { to: v })} />
                                </label>
                              </>
                            )}
                          />
                        )}
                        {c.dac === "viecLam" && (
                          <DanhSachDong
                            tieuDe="Record"
                            luoi="sm:grid-cols-3 lg:grid-cols-6"
                            ds={data.occupations}
                            toiDa={SO_VIEC_LAM}
                            them={() =>
                              doi({
                                occupations: [
                                  ...data.occupations,
                                  { from: "", to: "", occupation: "", employer: "", city: "", country: "Vietnam" },
                                ],
                              })
                            }
                            bo={(i) => doi({ occupations: data.occupations.filter((_, k) => k !== i) })}
                            o={(r, i) => (
                              <>
                                <label className="text-xs text-neutral-500">
                                  From (YYYY-MM)
                                  <OInput loai="thang" v={r.from} doi={(v) => doiDong("occupations", i, { from: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  To (trống = đến nay)
                                  <OInput loai="thang" v={r.to} doi={(v) => doiDong("occupations", i, { to: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  Activity/Occupation
                                  <OInput v={r.occupation} doi={(v) => doiDong("occupations", i, { occupation: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  Company/Employer
                                  <OInput v={r.employer} doi={(v) => doiDong("occupations", i, { employer: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  City/Town
                                  <OInput v={r.city} doi={(v) => doiDong("occupations", i, { city: v })} />
                                </label>
                                <label className="text-xs text-neutral-500">
                                  Country or Territory
                                  <OInput loai="quocgia" v={r.country} doi={(v) => doiDong("occupations", i, { country: v })} />
                                </label>
                              </>
                            )}
                          />
                        )}
                      </div>
                    );
                  })}
              </div>
            </section>
          ))}
          <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-2xl border-2 border-indigo-200 bg-white/95 px-4 py-3 shadow-lg">
            <span className="mr-auto text-sm text-neutral-600">
              {daSua ? "Có thay đổi chưa lưu." : "Đã lưu."} PDF mở bằng Adobe Acrobat Reader.
            </span>
            <button
              type="button"
              onClick={luu}
              disabled={dangLuu || !daSua}
              className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
            >
              {dangLuu ? "Đang lưu…" : "💾 Lưu"}
            </button>
            <button
              type="button"
              onClick={taiPdf}
              disabled={dangLuu}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              ⬇ Tải PDF đã điền
            </button>
          </div>
        </>
      )}
    </main>
  );
}

/** Danh sách dòng thêm / bỏ được (nước từng cư trú, việc làm). */
function DanhSachDong<T>({
  tieuDe,
  luoi,
  ds,
  toiDa,
  them,
  bo,
  o: oDong,
}: {
  tieuDe: string;
  luoi: string;
  ds: T[];
  toiDa: number;
  them: () => void;
  bo: (i: number) => void;
  o: (r: T, i: number) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-neutral-500">
          {ds.length}/{toiDa} dòng
        </p>
        <button
          type="button"
          disabled={ds.length >= toiDa}
          onClick={them}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
        >
          + Thêm dòng
        </button>
      </div>
      {ds.length === 0 && <p className="text-sm text-neutral-400">Không có.</p>}
      {ds.map((r, i) => (
        <div key={i} className="rounded-lg border border-neutral-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-bold text-neutral-800">
              {tieuDe} {i + 1}
            </p>
            <button type="button" onClick={() => bo(i)} className="text-xs font-semibold text-red-600 hover:underline">
              Bỏ dòng này
            </button>
          </div>
          <div className={`grid grid-cols-1 gap-2 ${luoi}`}>{oDong(r, i)}</div>
        </div>
      ))}
    </div>
  );
}
