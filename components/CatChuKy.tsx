"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/format";

type Vung = { page: number; x: number; y: number; w: number; h: number };

/** "Hùng" -> "Hùng 2", "Hùng 2" -> "Hùng 3" — cắt liên tiếp nhiều chữ ký khỏi trùng tên. */
const tenKe = (ten: string) => {
  const m = ten.match(/^(.*?)(\d+)$/);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${ten} 2`;
};

/**
 * CẮT chữ ký từ ảnh / PDF / Word (Docs 16/10/2026: "bôi 1 chữ ký trong ảnh hoặc pdf hoặc word thì lấy chữ ký đó ra"):
 * chọn file -> ảnh từng trang (POST /signature-tools/preview) -> KÉO CHUỘT bôi khung quanh 1 chữ ký -> "Cắt & thêm"
 * (POST /signature-tools/crop cắt ở độ phân giải cao) -> `them(ảnh, tên)` gửi vào thư viện như ảnh tải lên (xoá nền,
 * cắt sát ở đó). Khung KHÔNG đóng sau khi thêm để cắt tiếp chữ ký khác trên cùng file. File gốc không được lưu.
 */
export function CatChuKy({ dong, them }: { dong: () => void; them: (anh: Blob, ten: string) => Promise<boolean> }) {
  const [file, setFile] = useState<File | null>(null);
  const [trang, setTrang] = useState<string[]>([]);
  const [tongTrang, setTongTrang] = useState(0);
  const [dangTai, setDangTai] = useState(false);
  const [dangCat, setDangCat] = useState(false);
  const [loi, setLoi] = useState<string | null>(null);
  const [vung, setVung] = useState<Vung | null>(null);
  const [ten, setTen] = useState("Chữ ký 1");
  const [daThem, setDaThem] = useState<string[]>([]);
  const khung = useRef<(HTMLDivElement | null)[]>([]);
  const keo = useRef<{ page: number; x0: number; y0: number } | null>(null);

  useEffect(() => {
    const thoat = (e: KeyboardEvent) => e.key === "Escape" && dong();
    window.addEventListener("keydown", thoat);
    return () => window.removeEventListener("keydown", thoat);
  }, [dong]);

  async function chonFile(f: File | undefined) {
    if (!f) return;
    setFile(f);
    setTrang([]);
    setVung(null);
    setLoi(null);
    setDangTai(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`${API_URL}/signature-tools/preview`, { method: "POST", body: fd });
      const d = await r.json().catch(() => null);
      if (!r.ok) return setLoi(typeof d?.detail === "string" ? d.detail : "Không mở được file.");
      setTrang(d.pages ?? []);
      setTongTrang(d.count ?? 0);
    } catch {
      setLoi("Không kết nối được máy chủ — thử lại.");
    } finally {
      setDangTai(false);
    }
  }

  const tiLe = (page: number, e: React.PointerEvent | PointerEvent) => {
    const r = khung.current[page]!.getBoundingClientRect();
    return { x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) };
  };

  function batDau(e: React.PointerEvent, page: number) {
    e.preventDefault();
    const { x, y } = tiLe(page, e);
    keo.current = { page, x0: x, y0: y };
    setVung({ page, x, y, w: 0, h: 0 });
    const di = (ev: PointerEvent) => {
      const k = keo.current;
      if (!k) return;
      const p = tiLe(k.page, ev);
      setVung({ page: k.page, x: Math.min(k.x0, p.x), y: Math.min(k.y0, p.y), w: Math.abs(p.x - k.x0), h: Math.abs(p.y - k.y0) });
    };
    const tha = () => {
      keo.current = null;
      window.removeEventListener("pointermove", di);
      window.removeEventListener("pointerup", tha);
    };
    window.addEventListener("pointermove", di);
    window.addEventListener("pointerup", tha);
  }

  const vungDung = !!vung && vung.w > 0.01 && vung.h > 0.005;

  async function catVaThem() {
    if (!file || !vung || !vungDung) return;
    setLoi(null);
    setDangCat(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("page", String(vung.page));
      (["x", "y", "w", "h"] as const).forEach((k) => fd.append(k, String(vung[k])));
      const r = await fetch(`${API_URL}/signature-tools/crop`, { method: "POST", body: fd });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        return setLoi(typeof d?.detail === "string" ? d.detail : "Không cắt được — thử lại.");
      }
      const tenDung = ten.trim() || "Chữ ký";
      if (await them(await r.blob(), tenDung)) {
        setDaThem((cu) => [...cu, tenDung]);
        setTen(tenKe(tenDung));
        setVung(null);
      }
    } catch {
      setLoi("Không kết nối được máy chủ — thử lại.");
    } finally {
      setDangCat(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && dong()}
    >
      <div className="flex h-full max-h-[94vh] w-full max-w-5xl flex-col gap-3 overflow-hidden rounded-2xl bg-white p-4 shadow-2xl">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h3 className="text-lg font-bold text-neutral-800">✂ Cắt chữ ký từ ảnh / PDF / Word</h3>
            <p className="text-xs text-neutral-500">
              Chọn file → <b>kéo chuột bôi khung quanh MỘT chữ ký</b> → “Cắt & thêm”. Cắt tiếp chữ ký khác được ngay. File
              gốc không được lưu — chỉ lưu vùng chữ ký đã cắt.
            </p>
          </div>
          <label className="cursor-pointer rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">
            {dangTai ? "Đang mở file…" : file ? "Chọn file khác" : "📂 Chọn file"}
            <input
              type="file"
              accept="image/*,.pdf,.doc,.docx,.odt,.rtf"
              className="hidden"
              disabled={dangTai}
              onChange={(e) => {
                chonFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <button type="button" onClick={dong} className="rounded-full px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100">
            ✕ Đóng
          </button>
        </div>

        {file && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-neutral-50 px-3 py-2 text-sm">
            <span className="truncate text-neutral-600" title={file.name}>
              📄 {file.name}
              {tongTrang > trang.length && ` (hiện ${trang.length}/${tongTrang} trang đầu)`}
            </span>
            <span className="mr-auto" />
            <label className="text-neutral-600">
              Tên:{" "}
              <input
                value={ten}
                onChange={(e) => setTen(e.target.value)}
                maxLength={40}
                className="ml-1 w-36 rounded-lg border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={catVaThem}
              disabled={!vungDung || dangCat}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-40"
              title={vungDung ? "" : "Kéo chuột bôi khung quanh chữ ký trước"}
            >
              {dangCat ? "Đang cắt…" : "✂ Cắt & thêm vào thư viện"}
            </button>
          </div>
        )}
        {loi && <p className="text-sm text-red-600">{loi}</p>}
        {daThem.length > 0 && (
          <p className="text-sm text-emerald-700">
            ✓ Đã thêm {daThem.length} chữ ký: {daThem.join(", ")} — bôi chữ ký khác để cắt tiếp, hoặc Đóng.
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-y-auto rounded-xl bg-neutral-100 p-4">
          {!file && <p className="mt-10 text-sm text-neutral-500">Chọn ảnh, PDF hoặc Word có chữ ký.</p>}
          {dangTai && <p className="mt-10 text-sm text-neutral-500">Đang mở file…</p>}
          {trang.map((src, i) => (
            <figure key={i} className="w-full max-w-4xl">
              <div
                ref={(el) => {
                  khung.current[i] = el;
                }}
                onPointerDown={(e) => batDau(e, i)}
                className="relative cursor-crosshair touch-none select-none"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`Trang ${i + 1}`} className="block w-full rounded bg-white shadow" draggable={false} />
                {vung && vung.page === i && (
                  <div
                    className="pointer-events-none absolute border-2 border-indigo-600 bg-indigo-500/15"
                    style={{ left: `${vung.x * 100}%`, top: `${vung.y * 100}%`, width: `${vung.w * 100}%`, height: `${vung.h * 100}%` }}
                  />
                )}
              </div>
              {trang.length > 1 && <figcaption className="mt-1 text-center text-xs text-neutral-500">Trang {i + 1}</figcaption>}
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
