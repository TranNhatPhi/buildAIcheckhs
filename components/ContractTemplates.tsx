"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { API_URL } from "@/lib/format";
import { FORM_HINT, FORM_INPUT, FORM_LABEL } from "@/lib/formStyles";
import { CAU_HINH_MAU, type LoaiMau } from "@/lib/loaiMau";

export interface MauHopDong {
  id: string;
  kind: LoaiMau;
  companyName: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  notes: string | null;
  uploadedBy: string | null;
  createdAt: string;
  pageCount: number | null;
}

export function laPdf(m: MauHopDong) {
  return m.mimeType === "application/pdf" || m.originalFilename.toLowerCase().endsWith(".pdf");
}

/** Loại file gốc của mẫu, để ghi nhãn ("Excel") và chữ trên nút tải ("Tải file Excel"). */
export function loaiFile(m: MauHopDong): "PDF" | "Word" | "Excel" {
  if (laPdf(m)) return "PDF";
  return /\.xlsx?$/i.test(m.originalFilename) || m.mimeType.includes("spreadsheet") || m.mimeType.includes("ms-excel")
    ? "Excel"
    : "Word";
}

/** Biểu tượng thay ảnh khi mẫu chưa có ảnh xem trước. */
export const BIEU_TUONG_FILE = { PDF: "📕", Word: "📘", Excel: "📗" } as const;

const khoa = (s: string) => s.toLocaleLowerCase("vi");

/** Số thứ tự trong tên mẫu ("Mẫu số 17: …" -> 17); không có số thì xếp cuối. */
function soMau(tieuDe: string): number {
  const m = tieuDe.match(/Mẫu số\s*(\d+)/i);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Thư viện mẫu giấy tờ kiểu thư viện mẫu CV: lưới thẻ có ẢNH TRANG ĐẦU, lọc theo công ty bằng hàng
 * nút ở trên, bấm thẻ mở trang xem đầy đủ từng trang (`${duongDan}/[id]`). Ảnh xem trước do máy chủ
 * dựng lúc tải mẫu lên (contract_preview.py). Dùng cho cả "Mẫu hợp đồng lao động" và "Mẫu thư xác
 * nhận kinh nghiệm" — `loai` chọn loại mẫu và chữ hiển thị (lib/loaiMau.ts).
 *
 * Tên công ty gợi ý từ CHÍNH danh sách đơn vị xác nhận kinh nghiệm đã nhập ở các hồ sơ
 * (GET /cases/experience-units) — cùng một tên ở cả hai nơi thì sau này nối mẫu với hồ sơ được.
 */
export function ContractTemplates({ loai = "HDLD" }: { loai?: LoaiMau }) {
  const ch = CAU_HINH_MAU[loai];
  const [ds, setDs] = useState<MauHopDong[] | null>(null);
  const [loi, setLoi] = useState<string | null>(null);
  const [tim, setTim] = useState("");
  const [locCongTy, setLocCongTy] = useState<string | null>(null);
  const [congTyHoSo, setCongTyHoSo] = useState<string[]>([]);

  const [moForm, setMoForm] = useState(false);
  const [congTy, setCongTy] = useState("");
  const [tieuDe, setTieuDe] = useState("");
  const [ghiChu, setGhiChu] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dangLuu, setDangLuu] = useState(false);
  const [loiForm, setLoiForm] = useState<string | null>(null);
  const oFile = useRef<HTMLInputElement>(null);

  // Chọn nhiều mẫu để xoá một lần (POST /contract-templates/delete-many).
  const [cheDoChon, setCheDoChon] = useState(false);
  const [daChon, setDaChon] = useState<Set<string>>(new Set());
  const [dangXoaNhieu, setDangXoaNhieu] = useState(false);

  function batTatChon(id: string) {
    setDaChon((cu) => {
      const moi = new Set(cu);
      if (moi.has(id)) moi.delete(id);
      else moi.add(id);
      return moi;
    });
  }

  function thoatChon() {
    setCheDoChon(false);
    setDaChon(new Set());
  }

  async function xoaDaChon() {
    const ids = [...daChon];
    if (!ids.length) return;
    if (!confirm(`Xoá ${ids.length} ${ch.tenMau} đã chọn?

File mẫu, bản PDF và ảnh xem trước sẽ bị xoá vĩnh viễn.`)) return;
    setDangXoaNhieu(true);
    try {
      const r = await fetch(`${API_URL}/contract-templates/delete-many`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) alert("Không xoá được các mẫu đã chọn.");
      thoatChon();
      await tai();
    } finally {
      setDangXoaNhieu(false);
    }
  }

  // Thêm nhiều mẫu một lần từ file zip (POST /contract-templates/import-zip).
  const [moZip, setMoZip] = useState(false);
  const [zipCongTy, setZipCongTy] = useState("");
  const [zipGhiChu, setZipGhiChu] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [dangNhap, setDangNhap] = useState(false);
  const [loiZip, setLoiZip] = useState<string | null>(null);
  const [ketQuaZip, setKetQuaZip] = useState<{ them: number; boQua: { file: string; lyDo: string }[] } | null>(null);

  function moNhapZip() {
    setZipCongTy("");
    setZipGhiChu("");
    setZipFile(null);
    setLoiZip(null);
    setKetQuaZip(null);
    setMoZip(true);
  }

  async function nhapZip(e: React.FormEvent) {
    e.preventDefault();
    if (!zipFile) return setLoiZip("Chọn file zip.");
    setDangNhap(true);
    setLoiZip(null);
    try {
      const body = new FormData();
      body.append("companyName", zipCongTy);
      body.append("notes", zipGhiChu);
      body.append("kind", loai);
      body.append("file", zipFile);
      const r = await fetch(`${API_URL}/contract-templates/import-zip`, { method: "POST", body });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setLoiZip(typeof d?.detail === "string" ? d.detail : "Không nhập được file zip.");
        return;
      }
      setKetQuaZip({ them: d?.added?.length ?? 0, boQua: d?.skipped ?? [] });
      await tai();
    } finally {
      setDangNhap(false);
    }
  }

  const tai = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/contract-templates?kind=${loai}`);
      if (!r.ok) throw new Error();
      setDs(await r.json());
      setLoi(null);
    } catch {
      setLoi(`Không tải được danh sách ${ch.tenMau}.`);
      setDs((cu) => cu ?? []);
    }
  }, [loai, ch.tenMau]);

  useEffect(() => {
    tai();
    fetch(`${API_URL}/cases/experience-units`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: unknown) => setCongTyHoSo(Array.isArray(d) ? (d as string[]) : []))
      .catch(() => setCongTyHoSo([]));
  }, [tai]);

  // Hàng nút lọc: mỗi công ty một nút kèm số mẫu.
  const congTyCoMau = useMemo(() => {
    const m = new Map<string, { ten: string; so: number }>();
    for (const x of ds ?? []) {
      const g = m.get(khoa(x.companyName)) ?? { ten: x.companyName, so: 0 };
      g.so++;
      m.set(khoa(x.companyName), g);
    }
    return [...m.values()].sort((a, b) => a.ten.localeCompare(b.ten, "vi"));
  }, [ds]);

  const hienThi = useMemo(() => {
    const q = khoa(tim.trim());
    return (ds ?? [])
      .filter(
        (x) =>
          (!locCongTy || khoa(x.companyName) === khoa(locCongTy)) &&
          (!q || khoa(x.companyName).includes(q) || khoa(x.title).includes(q) || khoa(x.originalFilename).includes(q)),
      )
      // Số mẫu tăng dần ("Mẫu số 01" -> "Mẫu số 40"); mẫu không đánh số xếp sau, theo tên.
      .sort(
        (a, b) =>
          soMau(a.title) - soMau(b.title) || a.title.localeCompare(b.title, "vi", { numeric: true }),
      );
  }, [ds, tim, locCongTy]);

  // Công ty đang có trong hồ sơ mà CHƯA có mẫu nào — để biết còn thiếu mẫu cho công ty nào.
  const chuaCoMau = useMemo(() => {
    const coMau = new Set((ds ?? []).map((x) => khoa(x.companyName)));
    return congTyHoSo.filter((c) => !coMau.has(khoa(c)));
  }, [ds, congTyHoSo]);

  const goiYCongTy = useMemo(() => {
    const s = new Map<string, string>();
    for (const c of [...congTyHoSo, ...(ds ?? []).map((x) => x.companyName)]) s.set(khoa(c), c);
    return [...s.values()].sort((a, b) => a.localeCompare(b, "vi"));
  }, [congTyHoSo, ds]);

  function moThem(congTyMacDinh = "") {
    setCongTy(congTyMacDinh);
    setTieuDe("");
    setGhiChu("");
    setFile(null);
    setLoiForm(null);
    if (oFile.current) oFile.current.value = "";
    setMoForm(true);
  }

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    if (!congTy.trim()) return setLoiForm("Chọn hoặc nhập tên công ty.");
    if (!file) return setLoiForm(`Chọn file ${ch.tenMau} (${ch.dinhDang}).`);
    setDangLuu(true);
    setLoiForm(null);
    try {
      const body = new FormData();
      body.append("companyName", congTy);
      body.append("title", tieuDe);
      body.append("notes", ghiChu);
      body.append("kind", loai);
      body.append("file", file);
      const r = await fetch(`${API_URL}/contract-templates`, { method: "POST", body });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setLoiForm(typeof d?.detail === "string" ? d.detail : `Không lưu được ${ch.tenMau}.`);
        return;
      }
      setMoForm(false);
      await tai();
    } finally {
      setDangLuu(false);
    }
  }

  const nutLoc = (dangChon: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
      dangChon
        ? "border-indigo-600 bg-indigo-600 text-white shadow-sm"
        : "border-neutral-200 bg-white text-neutral-700 hover:border-indigo-300 hover:text-indigo-700"
    }`;

  // Ruột một thẻ mẫu (ảnh trang đầu, tên, nhãn) — dùng chung cho chế độ xem (Link) và chế độ chọn (button).
  function noiDungThe(m: MauHopDong) {
    return (
      <>
        <div className="relative aspect-[210/297] overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-black/5">
          {m.pageCount ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${API_URL}/contract-templates/${m.id}/pages/1`}
              alt={`Trang đầu mẫu ${m.title}`}
              loading="lazy"
              // contain chứ không cover: phiếu lương Excel hay in khổ NGANG — cover sẽ cắt mất hai bên.
              className="h-full w-full object-contain object-top"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-400">
              <span className="text-5xl" aria-hidden>
                {BIEU_TUONG_FILE[loaiFile(m)]}
              </span>
              <span className="text-xs">Chưa có ảnh xem trước</span>
            </div>
          )}
          {cheDoChon && (
            <span
              aria-hidden
              className={`absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-md border-2 text-sm font-bold shadow ${
                daChon.has(m.id) ? "border-red-600 bg-red-600 text-white" : "border-neutral-300 bg-white text-transparent"
              }`}
            >
              ✓
            </span>
          )}
          <div className={`absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/45 via-black/0 to-black/0 opacity-0 transition-opacity ${cheDoChon ? "" : "group-hover:opacity-100"}`}>
            <span className="mb-5 rounded-full bg-white px-5 py-2 text-sm font-semibold text-indigo-700 shadow">
              Xem mẫu
            </span>
          </div>
        </div>
        <p className="mt-3 line-clamp-2 text-lg font-semibold leading-snug text-neutral-900" title={m.title}>
          {m.title}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-neutral-600 ring-1 ring-neutral-200">
            🏢 {m.companyName}
          </span>
          <span className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-neutral-600 ring-1 ring-neutral-200">
            {loaiFile(m)}
          </span>
          {m.pageCount ? (
            <span className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-neutral-600 ring-1 ring-neutral-200">
              {m.pageCount} trang
            </span>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{ch.tieuDe}</h1>
          <p className="mt-1 text-sm text-neutral-500">{ch.moTa}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => (cheDoChon ? thoatChon() : setCheDoChon(true))}
            className={`rounded-xl border px-4 py-2 text-sm font-semibold shadow-sm ${
              cheDoChon
                ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
                : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
            }`}
          >
            {cheDoChon ? "✕ Thoát chọn" : "☑ Chọn mẫu"}
          </button>
          {/* Tải TẤT CẢ mẫu (file gốc) gói thành một zip, mỗi công ty/nhóm một thư mục. */}
          {!!ds?.length && (
            <a
              href={`${API_URL}/contract-templates/export/zip?kind=${loai}`}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 shadow-sm hover:bg-neutral-50"
            >
              ⬇ Tải tất cả (ZIP)
            </a>
          )}
          <button
            type="button"
            onClick={moNhapZip}
            className="rounded-xl border border-indigo-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50"
          >
            ⬆ Thêm nhiều mẫu (file zip)
          </button>
          <button
            type="button"
            onClick={() => moThem()}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            + Thêm mẫu
          </button>
        </div>
      </div>

      {/* Hàng nút lọc theo công ty + ô tìm — giống hàng danh mục của thư viện mẫu CV */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setLocCongTy(null)} className={nutLoc(locCongTy === null)}>
          Tất cả <span className="opacity-70 tabular-nums">{ds?.length ?? 0}</span>
        </button>
        {congTyCoMau.map((c) => (
          <button
            key={c.ten}
            type="button"
            onClick={() => setLocCongTy(locCongTy && khoa(locCongTy) === khoa(c.ten) ? null : c.ten)}
            className={nutLoc(!!locCongTy && khoa(locCongTy) === khoa(c.ten))}
          >
            🏢 {c.ten} <span className="opacity-70 tabular-nums">{c.so}</span>
          </button>
        ))}
        <input
          value={tim}
          onChange={(e) => setTim(e.target.value)}
          className="ml-auto w-full sm:w-72 rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
          placeholder="🔍 Tìm công ty, tên mẫu, tên file"
          aria-label={`Tìm ${ch.tenMau}`}
        />
      </div>

      {cheDoChon && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-3 shadow-md">
          <p className="mr-auto text-sm text-neutral-700">
            Đã chọn <span className="font-semibold tabular-nums">{daChon.size}</span> mẫu — bấm vào thẻ để chọn / bỏ chọn
          </p>
          <button
            type="button"
            onClick={() => setDaChon(new Set(hienThi.map((x) => x.id)))}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
          >
            Chọn tất cả đang hiển thị ({hienThi.length})
          </button>
          <button
            type="button"
            onClick={() => setDaChon(new Set())}
            disabled={!daChon.size}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold text-neutral-600 hover:bg-neutral-100 disabled:opacity-40"
          >
            Bỏ chọn
          </button>
          {daChon.size ? (
            <a
              href={`${API_URL}/contract-templates/export/zip?kind=${loai}&ids=${[...daChon].join(",")}`}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              ⬇ Tải {daChon.size} mẫu đã chọn (ZIP)
            </a>
          ) : (
            <span className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white opacity-40">
              ⬇ Tải mẫu đã chọn (ZIP)
            </span>
          )}
          <button
            type="button"
            onClick={xoaDaChon}
            disabled={!daChon.size || dangXoaNhieu}
            className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
          >
            {dangXoaNhieu ? "Đang xoá…" : `🗑 Xoá ${daChon.size} mẫu đã chọn`}
          </button>
        </div>
      )}

      {loi && <p className="text-sm text-red-600">{loi}</p>}

      {ds === null ? (
        <p className="text-sm text-neutral-400">Đang tải…</p>
      ) : hienThi.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-10 text-center">
          <p className="text-3xl" aria-hidden>
            {ch.bieuTuong}
          </p>
          <p className="mt-2 text-sm font-semibold text-neutral-700">
            {ds.length ? "Không có mẫu nào khớp bộ lọc." : `Chưa có ${ch.tenMau} nào.`}
          </p>
          {!ds.length && (
            <p className="mt-1 text-xs text-neutral-500">
              Bấm “+ Thêm mẫu” để tải {ch.tenMau} đầu tiên lên, hoặc “Thêm nhiều mẫu (file zip)”.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {hienThi.map((m) =>
            cheDoChon ? (
              <button
                key={m.id}
                type="button"
                onClick={() => batTatChon(m.id)}
                aria-pressed={daChon.has(m.id)}
                className={`group rounded-2xl p-4 text-left transition-colors ${
                  daChon.has(m.id) ? "bg-red-50 ring-2 ring-red-500" : "bg-neutral-100 hover:bg-neutral-200/70"
                }`}
              >
                {noiDungThe(m)}
              </button>
            ) : (
              <Link
                key={m.id}
                href={`${ch.duongDan}/${m.id}`}
                className="group rounded-2xl bg-neutral-100 p-4 transition-colors hover:bg-indigo-50"
              >
                {noiDungThe(m)}
              </Link>
            ),
          )}
        </div>
      )}

      {chuaCoMau.length > 0 && !tim && !locCongTy && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Công ty đang có trong hồ sơ nhưng chưa có mẫu ({chuaCoMau.length})
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {chuaCoMau.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => moThem(c)}
                className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                title="Thêm mẫu cho công ty này"
              >
                + {c}
              </button>
            ))}
          </div>
        </section>
      )}

      {moZip && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 px-4"
          onMouseDown={(e) => e.target === e.currentTarget && !dangNhap && setMoZip(false)}
        >
          <form
            onSubmit={nhapZip}
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl flex flex-col gap-4"
            aria-labelledby="tieu-de-nhap-zip"
          >
            <p id="tieu-de-nhap-zip" className="text-lg font-semibold text-neutral-900">
              Thêm nhiều mẫu từ file zip
            </p>
            {ketQuaZip ? (
              <>
                <p className="text-sm text-neutral-700">
                  Đã thêm <span className="font-semibold">{ketQuaZip.them}</span> mẫu
                  {ketQuaZip.boQua.length ? `, bỏ qua ${ketQuaZip.boQua.length} file:` : "."}
                </p>
                {ketQuaZip.boQua.length > 0 && (
                  <ul className="max-h-40 overflow-y-auto rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
                    {ketQuaZip.boQua.map((b) => (
                      <li key={b.file}>
                        {b.file} — {b.lyDo}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setMoZip(false)}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                  >
                    Xong
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className={FORM_LABEL} htmlFor="zip-cong-ty">
                    Công ty / nhóm <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
                  </label>
                  <input
                    id="zip-cong-ty"
                    list="goi-y-cong-ty-mau"
                    autoComplete="off"
                    value={zipCongTy}
                    onChange={(e) => setZipCongTy(e.target.value)}
                    className={FORM_INPUT}
                    placeholder="Áp dụng cho tất cả mẫu trong file zip"
                  />
                  <p className={FORM_HINT}>
                    Để trống thì các mẫu vào nhóm “Chưa gán công ty”; chọn công ty cho từng mẫu sau ở trang xem mẫu.
                  </p>
                </div>
                <div>
                  <label className={FORM_LABEL} htmlFor="zip-file">
                    File zip
                  </label>
                  <input
                    id="zip-file"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-neutral-700 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100"
                  />
                  <p className={FORM_HINT}>
                    Mỗi file {ch.dinhDang} trong zip thành một mẫu, tên mẫu lấy theo tên file; file loại khác bị bỏ qua. Tối đa 60 file, 100MB.
                  </p>
                </div>
                <div>
                  <label className={FORM_LABEL} htmlFor="zip-ghi-chu">
                    Ghi chú chung <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
                  </label>
                  <input
                    id="zip-ghi-chu"
                    value={zipGhiChu}
                    onChange={(e) => setZipGhiChu(e.target.value)}
                    className={FORM_INPUT}
                  />
                </div>
                {loiZip && <p className="text-sm text-red-600">{loiZip}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setMoZip(false)}
                    disabled={dangNhap}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                  >
                    Huỷ
                  </button>
                  <button
                    type="submit"
                    disabled={dangNhap}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {dangNhap ? "Đang thêm và tạo ảnh xem trước… (vài giây mỗi mẫu)" : "Thêm các mẫu"}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}

      {/* Datalist dùng chung cho hộp thêm 1 mẫu và hộp nhập zip */}
      {!moForm && (
        <datalist id="goi-y-cong-ty-mau">
          {goiYCongTy.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}

      {moForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 px-4"
          onMouseDown={(e) => e.target === e.currentTarget && !dangLuu && setMoForm(false)}
        >
          <form
            onSubmit={luu}
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl flex flex-col gap-4"
            aria-labelledby="tieu-de-them-mau"
          >
            <p id="tieu-de-them-mau" className="text-lg font-semibold text-neutral-900">
              Thêm {ch.tenMau}
            </p>
            <div>
              <label className={FORM_LABEL} htmlFor="mau-cong-ty">
                Công ty
              </label>
              <input
                id="mau-cong-ty"
                list="goi-y-cong-ty-mau"
                autoComplete="off"
                value={congTy}
                onChange={(e) => setCongTy(e.target.value)}
                className={FORM_INPUT}
                placeholder="Gõ để chọn công ty đã có, hoặc nhập tên mới"
              />
              <datalist id="goi-y-cong-ty-mau">
                {goiYCongTy.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <p className={FORM_HINT}>Nên chọn đúng tên đã nhập ở “Đơn vị xác nhận kinh nghiệm” của hồ sơ.</p>
            </div>
            <div>
              <label className={FORM_LABEL} htmlFor="mau-tieu-de">
                Tên mẫu <span className="font-normal text-neutral-400">(tuỳ chọn — để trống thì lấy tên file)</span>
              </label>
              <input
                id="mau-tieu-de"
                value={tieuDe}
                onChange={(e) => setTieuDe(e.target.value)}
                className={FORM_INPUT}
                placeholder={ch.viDuTenMau}
              />
            </div>
            <div>
              <label className={FORM_LABEL} htmlFor="mau-file">
                File mẫu
              </label>
              <input
                id="mau-file"
                ref={oFile}
                type="file"
                accept={ch.accept}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-neutral-700 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100"
              />
              <p className={FORM_HINT}>{ch.dinhDang}, tối đa 20MB. Ảnh xem trước tự tạo sau khi lưu.</p>
            </div>
            <div>
              <label className={FORM_LABEL} htmlFor="mau-ghi-chu">
                Ghi chú <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
              </label>
              <textarea
                id="mau-ghi-chu"
                rows={2}
                value={ghiChu}
                onChange={(e) => setGhiChu(e.target.value)}
                className={FORM_INPUT}
                placeholder={ch.viDuGhiChu}
              />
            </div>
            {loiForm && <p className="text-sm text-red-600">{loiForm}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMoForm(false)}
                disabled={dangLuu}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
              >
                Huỷ
              </button>
              <button
                type="submit"
                disabled={dangLuu}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {dangLuu ? "Đang tải lên và tạo ảnh xem trước…" : "Lưu mẫu"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
