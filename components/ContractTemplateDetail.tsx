"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_URL, parseUtcDate } from "@/lib/format";
import { BIEU_TUONG_FILE, laPdf, loaiFile, type MauHopDong } from "@/components/ContractTemplates";
import { CAU_HINH_MAU, type LoaiMau } from "@/lib/loaiMau";

function dungLuong(b: number) {
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/**
 * Trang xem một mẫu (hợp đồng lao động / thư xác nhận kinh nghiệm): các trang xếp dọc như đang lật
 * giấy (ảnh do máy chủ dựng), khung bên phải giữ cố định với thông tin + nút tải file gốc (Word /
 * Excel / PDF) / tải PDF / in.
 *
 * `loai` là loại của trang đang mở (theo đường dẫn); khi đã tải được mẫu thì theo `kind` của chính
 * mẫu — mở nhầm id của loại kia vẫn quay về đúng thư viện.
 */
export function ContractTemplateDetail({ id, loai = "HDLD" }: { id: string; loai?: LoaiMau }) {
  const router = useRouter();
  const [m, setM] = useState<MauHopDong | null>(null);
  const ch = CAU_HINH_MAU[m?.kind ?? loai] ?? CAU_HINH_MAU[loai];
  const [khongCo, setKhongCo] = useState(false);
  const [dangTao, setDangTao] = useState(false);
  const [dangXoa, setDangXoa] = useState(false);
  // Chọn / đổi công ty sở hữu mẫu — mỗi mẫu thuộc DUY NHẤT một công ty.
  const [doiCongTy, setDoiCongTy] = useState(false);
  const [congTyMoi, setCongTyMoi] = useState("");
  const [goiYCongTy, setGoiYCongTy] = useState<string[]>([]);
  const [dangDoi, setDangDoi] = useState(false);
  const [loiDoi, setLoiDoi] = useState<string | null>(null);

  const tai = useCallback(async () => {
    const r = await fetch(`${API_URL}/contract-templates/${id}`).catch(() => null);
    if (!r || r.status === 404) return setKhongCo(true);
    if (r.ok) setM(await r.json());
  }, [id]);

  useEffect(() => {
    tai();
  }, [tai]);

  // Gợi ý tên công ty: đơn vị XNKN đã nhập ở hồ sơ + công ty đang có mẫu.
  useEffect(() => {
    if (!doiCongTy) return;
    Promise.all([
      fetch(`${API_URL}/cases/experience-units`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${API_URL}/contract-templates?kind=${ch.kind}`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]).then(([dv, mau]: [string[], MauHopDong[]]) => {
      const s = new Map<string, string>();
      for (const c of [...(dv ?? []), ...(mau ?? []).map((x) => x.companyName)]) s.set(c.toLocaleLowerCase("vi"), c);
      setGoiYCongTy([...s.values()].sort((a, b) => a.localeCompare(b, "vi")));
    });
  }, [doiCongTy, ch.kind]);

  async function luuCongTy(e: React.FormEvent) {
    e.preventDefault();
    if (!m) return;
    if (!congTyMoi.trim()) return setLoiDoi("Chọn hoặc nhập tên công ty.");
    setDangDoi(true);
    setLoiDoi(null);
    try {
      const r = await fetch(`${API_URL}/contract-templates/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: congTyMoi }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setLoiDoi(typeof d?.detail === "string" ? d.detail : "Không đổi được công ty.");
        return;
      }
      setM(await r.json());
      setDoiCongTy(false);
    } finally {
      setDangDoi(false);
    }
  }

  async function taoXemTruoc() {
    setDangTao(true);
    try {
      const r = await fetch(`${API_URL}/contract-templates/${id}/preview`, { method: "POST" });
      if (!r.ok) alert("Không tạo được bản xem trước cho mẫu này.");
      await tai();
    } finally {
      setDangTao(false);
    }
  }

  async function xoa() {
    if (!m || !confirm(`Xoá mẫu "${m.title}" của ${m.companyName}?\n\nFile mẫu sẽ bị xoá vĩnh viễn.`)) return;
    setDangXoa(true);
    const r = await fetch(`${API_URL}/contract-templates/${id}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) router.push(ch.duongDan);
    else {
      setDangXoa(false);
      alert(`Không xoá được ${ch.tenMau}.`);
    }
  }

  if (khongCo) {
    return (
      <main className="flex-1 max-w-3xl w-full mx-auto px-6 py-10">
        <Link href={ch.duongDan} className="text-sm font-semibold text-indigo-700 hover:underline">
          ← Thư viện {ch.tenThuVien}
        </Link>
        <p className="mt-6 text-neutral-500">Không tìm thấy {ch.tenMau} này (có thể đã bị xoá).</p>
      </main>
    );
  }
  if (!m) return <p className="px-6 py-10 text-neutral-400">Đang tải…</p>;

  const trang = Array.from({ length: m.pageCount ?? 0 }, (_, i) => i + 1);
  const nut = "flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors";

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-8">
      <Link href={ch.duongDan} className="text-sm font-semibold text-indigo-700 hover:underline">
        ← Thư viện {ch.tenThuVien}
      </Link>

      <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Các trang của mẫu */}
        <div className="flex flex-col items-center gap-6 rounded-2xl bg-neutral-200/60 p-4 sm:p-8">
          {trang.length ? (
            trang.map((so) => (
              <figure key={so} className="w-full max-w-[720px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${API_URL}/contract-templates/${m.id}/pages/${so}`}
                  alt={`Trang ${so} / ${trang.length}`}
                  loading={so <= 2 ? "eager" : "lazy"}
                  className="w-full rounded-sm bg-white shadow-lg"
                />
                <figcaption className="mt-1.5 text-center text-xs text-neutral-500">
                  Trang {so} / {trang.length}
                </figcaption>
              </figure>
            ))
          ) : (
            <div className="flex aspect-[210/297] w-full max-w-[520px] flex-col items-center justify-center gap-3 rounded-sm bg-white text-neutral-500 shadow-lg">
              <span className="text-6xl" aria-hidden>
                {BIEU_TUONG_FILE[loaiFile(m)]}
              </span>
              <p className="text-sm">Mẫu này chưa có ảnh xem trước.</p>
              <button
                type="button"
                onClick={taoXemTruoc}
                disabled={dangTao}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {dangTao ? "Đang tạo…" : "Tạo bản xem trước"}
              </button>
            </div>
          )}
        </div>

        {/* Thông tin + thao tác — giữ cố định khi cuộn qua các trang */}
        <aside className="lg:sticky lg:top-6 h-fit rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
          <h1 className="text-xl font-semibold leading-snug text-neutral-900">{m.title}</h1>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
              🏢 {m.companyName}
            </span>
            <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
              {loaiFile(m)}
            </span>
            {m.pageCount ? (
              <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">
                {m.pageCount} trang
              </span>
            ) : null}
          </div>
          {/* Công ty sở hữu — mỗi mẫu chỉ thuộc MỘT công ty; đổi là chuyển hẳn sang công ty mới. */}
          <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
            <p className="text-xs font-medium text-neutral-500">Thuộc công ty</p>
            {!doiCongTy ? (
              <div className="mt-1 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-neutral-800">🏢 {m.companyName}</p>
                <button
                  type="button"
                  onClick={() => {
                    setCongTyMoi("");
                    setLoiDoi(null);
                    setDoiCongTy(true);
                  }}
                  className="shrink-0 text-xs font-semibold text-indigo-700 hover:underline"
                >
                  Chọn / đổi công ty
                </button>
              </div>
            ) : (
              <form onSubmit={luuCongTy} className="mt-2 flex flex-col gap-2">
                <input
                  list="goi-y-cong-ty-doi"
                  autoComplete="off"
                  autoFocus
                  value={congTyMoi}
                  onChange={(e) => setCongTyMoi(e.target.value)}
                  placeholder="Gõ để chọn công ty"
                  className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <datalist id="goi-y-cong-ty-doi">
                  {goiYCongTy.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <p className="text-[11px] text-neutral-500">
                  Mẫu sẽ chuyển hẳn sang công ty này (không còn thuộc “{m.companyName}”).
                </p>
                {loiDoi && <p className="text-xs text-red-600">{loiDoi}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setDoiCongTy(false)}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-100"
                  >
                    Huỷ
                  </button>
                  <button
                    type="submit"
                    disabled={dangDoi}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {dangDoi ? "Đang lưu…" : "Lưu"}
                  </button>
                </div>
              </form>
            )}
          </div>
          {m.notes && <p className="mt-4 text-sm leading-relaxed text-neutral-700">{m.notes}</p>}
          <p className="mt-4 text-xs text-neutral-500">
            {m.originalFilename} · {dungLuong(m.fileSizeBytes)}
            <br />
            Thêm ngày {parseUtcDate(m.createdAt).toLocaleDateString("vi-VN")}
            {m.uploadedBy ? ` bởi ${m.uploadedBy}` : ""}
          </p>

          <div className="mt-5 flex flex-col gap-2">
            <a
              href={`${API_URL}/contract-templates/${m.id}/file?download=true`}
              className={`${nut} bg-indigo-600 text-white shadow-sm hover:bg-indigo-700`}
            >
              ⬇ Tải file {loaiFile(m)}
            </a>
            {m.pageCount && !laPdf(m) ? (
              <a
                href={`${API_URL}/contract-templates/${m.id}/preview.pdf?download=true`}
                className={`${nut} bg-indigo-50 text-indigo-700 hover:bg-indigo-100`}
              >
                ⬇ Tải bản PDF
              </a>
            ) : null}
            {m.pageCount ? (
              <a
                href={`${API_URL}/contract-templates/${m.id}/preview.pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className={`${nut} bg-neutral-100 text-neutral-700 hover:bg-neutral-200`}
              >
                🖨 Mở PDF để in
              </a>
            ) : null}
            <button
              type="button"
              onClick={xoa}
              disabled={dangXoa}
              className={`${nut} mt-2 text-red-700 hover:bg-red-50 disabled:opacity-50`}
            >
              {dangXoa ? "Đang xoá…" : "Xoá mẫu"}
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
