"use client";

import { useEffect, useMemo, useState } from "react";
import { API_URL, gioNgayVN, normalizeSearchText } from "@/lib/format";
import { FORM_INPUT, FORM_LABEL } from "@/lib/formStyles";
import { docJson, ghiJson } from "@/lib/luuTam";
import type { CaseListItemDTO } from "@/lib/client-types";
import { ChuKyImm5645, type AnhChuKy, type ChoKy } from "@/components/ChuKyImm5645";

interface Nguoi {
  name: string;
  gender: "" | "M" | "F";
  dob: string;
  cob: string;
  maritalStatus: string;
  address: string;
  occupation: string;
  accompany: "" | "yes" | "no";
  nguon: string;
  relationship?: string;
}

interface DuLieu {
  applicationType: string;
  applicant: Nguoi;
  spouse: Nguoi;
  mother: Nguoi;
  father: Nguoi;
  children: Nguoi[];
  siblings: Nguoi[];
  canhBao: string[];
  nguonGiayTo: string[];
  signDate: string;
  // Thư viện ảnh chữ ký + chỗ đặt (ChuKyImm5645) — tỉ lệ theo khổ trang.
  anhChuKy?: AnhChuKy[];
  chuKy?: ChoKy[];
  // Backend `imm5645.kiem_tra`: chỗ cần xem lại (đã tự sửa lỗi chắc chắn).
  kiemTra?: string[];
}

// Giống backend imm5645.TINH_TRANG_HIEN — "Married" là cách ghi gọn trong file mẫu Docs đã nộp.
const TINH_TRANG = [
  "Single",
  "Married",
  "Annulled marriage",
  "Common-law",
  "Divorced",
  "Legally separated",
  "Married-physically present",
  "Married-not physically present",
  "Widowed",
];
const LOAI_HO_SO = ["Visitor", "Worker", "Student", "Other"];
const SO_CON = 4;
const SO_ANH_CHI_EM = 7;

const nguoiTrong = (quanHe?: string): Nguoi => ({
  name: "",
  gender: "",
  dob: "",
  cob: "Vietnam",
  maritalStatus: "",
  address: "",
  occupation: "",
  accompany: "no",
  nguon: "",
  ...(quanHe !== undefined ? { relationship: quanHe } : {}),
});

/** Một người trên form: các ô sửa được + nguồn AI đã lấy. */
function OnNguoi({
  tieuDe,
  p,
  doi,
  coDiCung = true,
  coQuanHe = false,
  laAnhChiEm = false,
  onXoa,
}: {
  tieuDe: string;
  p: Nguoi;
  doi: (thayDoi: Partial<Nguoi>) => void;
  coDiCung?: boolean;
  coQuanHe?: boolean;
  laAnhChiEm?: boolean;
  onXoa?: () => void;
}) {
  const o = "w-full rounded-lg border border-neutral-300 px-2 py-1 text-sm";
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-neutral-800">{tieuDe}</p>
        {onXoa && (
          <button type="button" onClick={onXoa} className="text-xs font-semibold text-red-600 hover:underline">
            Bỏ dòng này
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-neutral-500">
          Họ tên (không dấu, vd Ho Sy Hoi)
          <input className={o} value={p.name} onChange={(e) => doi({ name: e.target.value })} />
        </label>
        {coQuanHe && (
          <label className="text-xs text-neutral-500">
            Giới tính
            <select className={o} value={p.gender} onChange={(e) => doi({ gender: e.target.value as Nguoi["gender"] })}>
              <option value="">—</option>
              <option value="M">Nam</option>
              <option value="F">Nữ</option>
            </select>
          </label>
        )}
        {coQuanHe && (
          <label className="text-xs text-neutral-500">
            Quan hệ {laAnhChiEm ? "(tự tính theo giới tính + tuổi khi Lưu)" : "(Son / Daughter)"}
            <input
              className={`${o} ${laAnhChiEm ? "bg-neutral-50" : ""}`}
              value={p.relationship ?? ""}
              readOnly={laAnhChiEm}
              onChange={(e) => doi({ relationship: e.target.value })}
            />
          </label>
        )}
        <label className="text-xs text-neutral-500">
          Ngày sinh (YYYY-MM-DD)
          <input
            className={`${o} ${p.dob && !/^\d{4}-\d{2}-\d{2}$/.test(p.dob) ? "border-amber-400 bg-amber-50" : ""}`}
            value={p.dob}
            onChange={(e) => doi({ dob: e.target.value })}
            placeholder="1995-05-04"
          />
        </label>
        <label className="text-xs text-neutral-500">
          Nước sinh
          <input className={o} value={p.cob} onChange={(e) => doi({ cob: e.target.value })} />
        </label>
        <label className="text-xs text-neutral-500">
          Tình trạng hôn nhân
          <select className={o} value={p.maritalStatus} onChange={(e) => doi({ maritalStatus: e.target.value })}>
            <option value="">—</option>
            {TINH_TRANG.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-neutral-500 sm:col-span-2">
          Địa chỉ hiện tại (tiếng Anh)
          <input className={o} value={p.address} onChange={(e) => doi({ address: e.target.value })} />
        </label>
        <label className="text-xs text-neutral-500">
          Nghề nghiệp hiện tại
          <input className={o} value={p.occupation} onChange={(e) => doi({ occupation: e.target.value })} />
        </label>
        {coDiCung && (
          <label className="text-xs text-neutral-500">
            Đi cùng sang Canada?
            <select
              className={o}
              value={p.accompany}
              onChange={(e) => doi({ accompany: e.target.value as Nguoi["accompany"] })}
            >
              <option value="">— để trống —</option>
              <option value="yes">Có (YES)</option>
              <option value="no">Không (NO)</option>
            </select>
          </label>
        )}
      </div>
      {p.nguon && <p className="mt-1.5 text-xs text-neutral-400">Nguồn: {p.nguon}</p>}
    </div>
  );
}

/**
 * Tab "Điền form IMM5645e" (/dien-form-imm5645): chọn hồ sơ -> AI đọc Phiếu TT khách hàng, CT07, CCCD, Giấy khai
 * sinh... theo quy tắc imm5645/yc.txt (backend imm5645.py) -> nhân viên xem / sửa -> lưu -> tải PDF đã điền.
 * Dữ liệu lưu theo HỒ SƠ (Case.imm5645Data) nên F5 / mở máy khác vẫn còn.
 */
export function DienFormImm5645() {
  const [hoSo, setHoSo] = useState<CaseListItemDTO[]>([]);
  const [tim, setTim] = useState("");
  const [caseId, setCaseId] = useState("");
  const [data, setData] = useState<DuLieu | null>(null);
  const [giayTo, setGiayTo] = useState<string[]>([]);
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
    ghiJson("imm5645:caseId", id);
    setData(null);
    setGiayTo([]);
    setLoi(null);
    setDaSua(false);
    setCapNhat(null);
    if (!id) return;
    fetch(`${API_URL}/imm5645/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setData(d.data);
        setGiayTo(d.giayTo ?? []);
        setCapNhat(d.updatedAt);
      })
      .catch(() => setLoi("Không tải được dữ liệu — thử lại sau."));
  }

  useEffect(() => {
    fetch(`${API_URL}/cases`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: CaseListItemDTO[]) => {
        setHoSo([...d].sort((a, b) => a.clientName.localeCompare(b.clientName, "vi")));
        const ma = docJson<string>("imm5645:caseId");
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
      const r = await fetch(`${API_URL}/imm5645/${caseId}/extract`, { method: "POST" });
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
      const r = await fetch(`${API_URL}/imm5645/${caseId}`, {
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
    window.open(`${API_URL}/imm5645/${caseId}/pdf`, "_blank");
  }

  const doi = (thayDoi: Partial<DuLieu>) => {
    setData((cu) => (cu ? { ...cu, ...thayDoi } : cu));
    setDaSua(true);
  };
  const doiNguoi = (khoa: "applicant" | "spouse" | "mother" | "father") => (t: Partial<Nguoi>) =>
    data && doi({ [khoa]: { ...data[khoa], ...t } } as Partial<DuLieu>);
  const doiDong = (khoa: "children" | "siblings", i: number) => (t: Partial<Nguoi>) =>
    data && doi({ [khoa]: data[khoa].map((x, k) => (k === i ? { ...x, ...t } : x)) } as Partial<DuLieu>);

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Điền form IMM5645e</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Family Information (IMM 5645E). AI (DeepSeek) đọc Phiếu TT khách hàng, CT07, CCCD, Giấy khai sinh… của hồ
          sơ: địa chỉ ưu tiên CT07 rồi CCCD (không lấy từ phiếu), con lấy từ GKS, anh chị em từ Phiếu TT, nghề nghiệp
          đương đơn để trống. Bạn xem lại, sửa rồi tải PDF đã điền.
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
              {giayTo.length ? giayTo.join(" · ") : "chưa có — hồ sơ cần Phiếu TT khách hàng / CT07 / CCCD / GKS"}
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
              {dangDoc && <span className="text-sm text-neutral-500 tabular-nums">{giay} giây — model DeepSeek Pro, thường 1-2 phút</span>}
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

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-neutral-700">Type of application:</span>
              {LOAI_HO_SO.map((l) => (
                <label key={l} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="loai-ho-so"
                    checked={data.applicationType === l}
                    onChange={() => doi({ applicationType: l })}
                  />
                  {l}
                </label>
              ))}
            </div>
            <h2 className="text-lg font-bold text-neutral-800">Section A</h2>
            <OnNguoi tieuDe="Đương đơn (Applicant)" p={data.applicant} doi={doiNguoi("applicant")} coDiCung={false} />
            <OnNguoi tieuDe="Vợ / chồng (Spouse)" p={data.spouse} doi={doiNguoi("spouse")} />
            <OnNguoi tieuDe="Mẹ (Mother)" p={data.mother} doi={doiNguoi("mother")} />
            <OnNguoi tieuDe="Bố (Father)" p={data.father} doi={doiNguoi("father")} />

            {(
              [
                ["children", "Section B — Con", SO_CON, "Son"],
                ["siblings", "Section C — Anh chị em", SO_ANH_CHI_EM, "Brother"],
              ] as const
            ).map(([khoa, tieuDe, toiDa, quanHe]) => (
              <div key={khoa} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-neutral-800">
                    {tieuDe} <span className="text-sm font-medium text-neutral-500">({data[khoa].length}/{toiDa})</span>
                  </h2>
                  <button
                    type="button"
                    disabled={data[khoa].length >= toiDa}
                    onClick={() => doi({ [khoa]: [...data[khoa], nguoiTrong(quanHe)] } as Partial<DuLieu>)}
                    className="rounded-lg px-3 py-1.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
                  >
                    + Thêm dòng
                  </button>
                </div>
                {data[khoa].length === 0 && <p className="text-sm text-neutral-400">Không có.</p>}
                {data[khoa].map((p, i) => (
                  <OnNguoi
                    key={i}
                    tieuDe={`${khoa === "children" ? "Con" : "Anh chị em"} ${i + 1}`}
                    p={p}
                    doi={doiDong(khoa, i)}
                    coQuanHe
                    laAnhChiEm={khoa === "siblings"}
                    onXoa={() => doi({ [khoa]: data[khoa].filter((_, k) => k !== i) } as Partial<DuLieu>)}
                  />
                ))}
              </div>
            ))}

            <label className="text-sm text-neutral-600">
              Ngày ký (YYYY-MM-DD, để trống nếu khách tự ghi tay):{" "}
              <input
                className="ml-2 rounded-lg border border-neutral-300 px-2 py-1 text-sm"
                value={data.signDate}
                onChange={(e) => doi({ signDate: e.target.value })}
                placeholder="2026-10-14"
              />
            </label>
          </section>

          <ChuKyImm5645
            caseId={caseId}
            anhChuKy={data.anhChuKy ?? []}
            chuKy={data.chuKy ?? []}
            phienBan={capNhat}
            doiChuKy={(ds) => doi({ chuKy: ds })}
            doiAnh={(ds) => doi({ anhChuKy: ds })}
            daLuu={(kq) => {
              // Backend đã lưu thư viện ảnh + chỗ ký — chỉ cập nhật 2 phần đó, các ô khác đang sửa dở giữ nguyên.
              setData((cu) => (cu ? { ...cu, anhChuKy: kq.anhChuKy, chuKy: kq.chuKy } : cu));
              if (kq.updatedAt) setCapNhat(kq.updatedAt);
            }}
          />

          <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-2xl border-2 border-indigo-200 bg-white/95 px-4 py-3 shadow-lg">
            <span className="mr-auto text-sm text-neutral-600">
              {daSua ? "Có thay đổi chưa lưu." : "Đã lưu."}
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
