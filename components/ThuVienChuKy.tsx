"use client";

import { useState, type ReactNode } from "react";

/** Một ảnh trong thư viện chữ ký của hồ sơ (backend imm5645 / imm1295 .anhChuKy). */
export interface AnhChuKy {
  id: string;
  ten: string;
}

/** Kết quả backend trả sau khi thêm / xoá ảnh (đã LƯU): thư viện mới + phần riêng của từng form (chỗ ký, ngày ký...). */
export type KetQuaThuVien = { anhChuKy: AnhChuKy[]; updatedAt?: string; loi?: string[] } & Record<string, unknown>;

// Nền ô vuông để thấy rõ ảnh đã xoá nền (trong suốt).
export const NEN_O_VUONG = {
  backgroundImage:
    "linear-gradient(45deg,#e5e5e5 25%,transparent 25%),linear-gradient(-45deg,#e5e5e5 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e5e5 75%),linear-gradient(-45deg,transparent 75%,#e5e5e5 75%)",
  backgroundSize: "12px 12px",
  backgroundPosition: "0 0,0 6px,6px -6px,-6px 0",
};

/**
 * THƯ VIỆN chữ ký của hồ sơ — dùng chung cho IMM5645e (ChuKyImm5645) và IMM1295e (ChuKyImm1295): tải 1 / nhiều ảnh
 * (backend xoá nền, cắt sát), thẻ từng ảnh (sửa tên, xoá, số chỗ đang dùng), bấm thẻ để chọn ảnh dùng khi thêm chỗ ký.
 * `apiGoc` = `${API_URL}/imm5645/${caseId}` hoặc `/imm1295/...` — cùng bộ API signature.
 */
export function ThuVienChuKy({
  apiGoc,
  anhChuKy,
  soChoDung,
  anhDung,
  chonAnh,
  doiAnh,
  daLuu,
  nutThem,
}: {
  apiGoc: string;
  anhChuKy: AnhChuKy[];
  soChoDung: (id: string) => number;
  anhDung: string | null;
  chonAnh: (id: string) => void;
  doiAnh: (ds: AnhChuKy[]) => void; // đổi tên -> "chưa lưu"
  daLuu: (kq: KetQuaThuVien) => void; // backend đã lưu (thêm / xoá ảnh)
  nutThem?: (chay: (fn: () => Promise<Response | null>) => Promise<void>, dangTai: boolean) => ReactNode;
}) {
  const [dangTai, setDangTai] = useState(false);
  const [loi, setLoi] = useState<string[]>([]);

  /** Gọi 1 API thêm ảnh (tải file / lấy từ form khác) rồi cập nhật thư viện + chọn ảnh mới nhất. */
  async function chay(fn: () => Promise<Response | null>) {
    setLoi([]);
    setDangTai(true);
    try {
      const r = await fn();
      const d = r ? await r.json().catch(() => null) : null;
      if (!r?.ok || !d) {
        setLoi([typeof d?.detail === "string" ? d.detail : "Không thêm được ảnh chữ ký — thử lại."]);
        return;
      }
      daLuu(d);
      setLoi(d.loi ?? []);
      const moi = (d.anhChuKy as AnhChuKy[]).filter((a) => !anhChuKy.some((x) => x.id === a.id));
      if (moi.length) chonAnh(moi[moi.length - 1].id);
    } finally {
      setDangTai(false);
    }
  }

  function taiFile(files: File[]) {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    chay(() => fetch(`${apiGoc}/signature`, { method: "POST", body: fd }).catch(() => null));
  }

  async function xoaAnh(a: AnhChuKy) {
    const dung = soChoDung(a.id);
    if (!confirm(`Xoá ảnh chữ ký "${a.ten}"?` + (dung ? `\n\n${dung} chỗ đang dùng ảnh này cũng bị bỏ.` : ""))) return;
    const r = await fetch(`${apiGoc}/signature/${a.id}`, { method: "DELETE" }).catch(() => null);
    const d = r?.ok ? await r.json().catch(() => null) : null;
    if (!d) return setLoi(["Không xoá được — thử lại."]);
    daLuu(d);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">
          {dangTai ? "Đang xử lý ảnh…" : "📷 Thêm ảnh chữ ký (chọn được nhiều file)"}
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={dangTai}
            onChange={(e) => {
              taiFile(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </label>
        {nutThem?.(chay, dangTai)}
      </div>
      {loi.length > 0 && (
        <ul className="list-disc list-inside text-sm text-red-600">
          {loi.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {anhChuKy.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {anhChuKy.map((a) => {
            const chon = a.id === anhDung;
            return (
              <div
                key={a.id}
                onClick={() => chonAnh(a.id)}
                className={`flex w-44 cursor-pointer flex-col gap-1 rounded-xl border-2 p-2 ${
                  chon ? "border-indigo-500 bg-indigo-50" : "border-neutral-200 hover:border-neutral-300"
                }`}
                title="Bấm để chọn ảnh này khi thêm / đổi chữ ký"
              >
                <div className="flex h-14 items-center justify-center rounded" style={NEN_O_VUONG}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${apiGoc}/signature/${a.id}`} alt={a.ten} className="max-h-12 max-w-full" draggable={false} />
                </div>
                <input
                  value={a.ten}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => doiAnh(anhChuKy.map((x) => (x.id === a.id ? { ...x, ten: e.target.value } : x)))}
                  className="w-full rounded border border-neutral-300 px-1.5 py-0.5 text-xs"
                  aria-label="Tên chữ ký"
                />
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-neutral-500">{soChoDung(a.id)} chỗ ký</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      xoaAnh(a);
                    }}
                    className="font-semibold text-red-600 hover:underline"
                  >
                    Xoá ảnh
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
