"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/format";
import { ThuVienChuKy, type AnhChuKy, type KetQuaThuVien } from "@/components/ThuVienChuKy";

/** Chỗ ký DUY NHẤT của IMM1295 (SIGNATURE, trang 4) — MM trong subform Page4.Consent0 (backend imm1295.chuKy). */
export interface ViTriKy {
  anh: string;
  x: number;
  y: number;
  w: number;
}

type HinhMm = { x: number; y: number; w: number; h: number };
/** Khung mô phỏng (mm) do backend gửi: vùng kéo được, ô ký, ô ngày ký. */
export interface VungKy {
  vung: HinhMm;
  oKy: HinhMm & { chuThich: number };
  oNgay: HinhMm;
}

type Goc = "move" | "nw" | "ne" | "sw" | "se";
const kep = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
const W_MIN = 8;
const W_MAX = 120;
const BUOC_MM = 2;

/**
 * Chữ ký trên IMM1295e (Docs 16/10/2026 "đưa chức năng chữ ký qua bên 1295"): dùng chung THƯ VIỆN ảnh với IMM5645e
 * (ThuVienChuKy) + nút lấy chữ ký từ IMM5645e. Form XFA thuần — máy chủ không dựng được ảnh trang, nên giao diện vẽ
 * MÔ PHỎNG đúng kích thước (mm) vùng SIGNATURE trang 4: ô ký, ô đồng ý Yes/No, ô ngày ký. Kéo / kéo 4 góc / −/+ như
 * IMM5645; PDF tải xuống chèn ảnh vào template XFA đúng chỗ (backend imm1295._chen_chu_ky). Chỉ MỘT chỗ ký.
 */
export function ChuKyImm1295({
  caseId,
  anhChuKy,
  chuKy,
  signDate,
  soChuKy5645,
  vungKy,
  doiChuKy,
  doiAnh,
  doiNgay,
  daLuu,
}: {
  caseId: string;
  anhChuKy: AnhChuKy[];
  chuKy: ViTriKy | null;
  signDate: string;
  soChuKy5645: number;
  vungKy: VungKy | null;
  doiChuKy: (v: ViTriKy | null) => void;
  doiAnh: (ds: AnhChuKy[]) => void;
  doiNgay: (v: string) => void;
  daLuu: (kq: KetQuaThuVien) => void;
}) {
  const [anhChon, setAnhChon] = useState<string | null>(null);
  const [dangChon, setDangChon] = useState(false);
  const khung = useRef<HTMLDivElement | null>(null);
  const chuKyRef = useRef(chuKy);
  useEffect(() => {
    chuKyRef.current = chuKy;
  }, [chuKy]);

  const apiGoc = `${API_URL}/imm1295/${caseId}`;
  const anhDung = anhChuKy.some((a) => a.id === anhChon) ? anhChon : (anhChuKy[0]?.id ?? null);
  const tenAnh = (id: string) => anhChuKy.find((a) => a.id === id)?.ten ?? "?";
  const V = vungKy?.vung;

  function sua(thayDoi: Partial<ViTriKy>) {
    if (chuKyRef.current) doiChuKy({ ...chuKyRef.current, ...thayDoi });
  }

  function doiCo(buoc: number) {
    if (!chuKy || !V) return;
    const w = kep(chuKy.w + buoc, W_MIN, W_MAX);
    sua({ w, x: kep(chuKy.x - (w - chuKy.w) / 2, V.x, V.x + V.w - w) });
  }

  /** Kéo (di chuyển) hoặc kéo 1 trong 4 góc (đổi cỡ, góc đối diện đứng yên, giữ tỉ lệ ảnh) — đổi px ra mm theo khung. */
  function batDauKeo(e: React.PointerEvent, goc: Goc) {
    e.preventDefault();
    e.stopPropagation();
    setDangChon(true);
    const c0 = chuKyRef.current;
    const kh = khung.current?.getBoundingClientRect();
    const o = (e.currentTarget as HTMLElement).closest("[data-cho-ky]")?.getBoundingClientRect();
    if (!c0 || !kh || !o || !V) return;
    const mmMoiPx = V.w / kh.width;
    const h0 = o.height * mmMoiPx;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const di = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * mmMoiPx;
      const dy = (ev.clientY - y0) * mmMoiPx;
      if (goc === "move") {
        sua({ x: kep(c0.x + dx, V.x, V.x + V.w - c0.w), y: kep(c0.y + dy, V.y, V.y + V.h - 2) });
        return;
      }
      const trai = goc === "nw" || goc === "sw";
      const w = kep(c0.w + (trai ? -dx : dx), W_MIN, Math.min(W_MAX, trai ? c0.x + c0.w - V.x : V.x + V.w - c0.x));
      const x = trai ? c0.x + c0.w - w : c0.x;
      const tren = goc === "nw" || goc === "ne"; // kéo góc trên -> giữ CHÂN chữ ký đứng yên
      const y = tren ? c0.y + h0 * (1 - w / c0.w) : c0.y;
      sua({ w, x, y: kep(y, V.y, V.y + V.h - 2) });
    };
    const tha = () => {
      window.removeEventListener("pointermove", di);
      window.removeEventListener("pointerup", tha);
    };
    window.addEventListener("pointermove", di);
    window.addEventListener("pointerup", tha);
  }

  // mm -> % của khung mô phỏng.
  const pt = (h: HinhMm) =>
    V
      ? {
          left: `${((h.x - V.x) / V.w) * 100}%`,
          top: `${((h.y - V.y) / V.h) * 100}%`,
          width: `${(h.w / V.w) * 100}%`,
          height: `${(h.h / V.h) * 100}%`,
        }
      : {};

  const GOC: { g: Goc; lop: string }[] = [
    { g: "nw", lop: "-left-1.5 -top-1.5 cursor-nwse-resize" },
    { g: "ne", lop: "-right-1.5 -top-1.5 cursor-nesw-resize" },
    { g: "sw", lop: "-left-1.5 -bottom-1.5 cursor-nesw-resize" },
    { g: "se", lop: "-right-1.5 -bottom-1.5 cursor-nwse-resize" },
  ];

  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border-2 border-neutral-200 bg-white p-4"
      onPointerDown={(e) => !(e.target as HTMLElement).closest("[data-cho-ky]") && setDangChon(false)}
    >
      <h2 className="text-lg font-bold text-neutral-800">✍ Chữ ký (SIGNATURE — trang 4)</h2>
      <p className="text-xs text-neutral-500">
        Tải ảnh chụp / scan chữ ký (tự xoá nền, cắt sát) hoặc lấy từ thư viện IMM5645e của hồ sơ. Ảnh đầu tiên tự đặt vào
        ô ký và điền ngày ký hôm nay. Khung dưới là <b>mô phỏng đúng kích thước</b> phần SIGNATURE của form (form XFA nên
        máy chủ không dựng được ảnh trang thật): <b>kéo chữ ký</b> để đổi chỗ, <b>kéo 4 góc</b> hoặc −/+ để to nhỏ. Xong
        bấm <b>Lưu</b> rồi tải PDF, mở bằng Adobe để xem.
      </p>
      <ThuVienChuKy
        apiGoc={apiGoc}
        anhChuKy={anhChuKy}
        soChoDung={(id) => (chuKy?.anh === id ? 1 : 0)}
        anhDung={anhDung}
        chonAnh={setAnhChon}
        doiAnh={doiAnh}
        daLuu={(kq) => {
          setDangChon(false);
          daLuu(kq);
        }}
        nutThem={(chay, dangTai) =>
          soChuKy5645 > 0 ? (
            <button
              type="button"
              disabled={dangTai}
              onClick={() => chay(() => fetch(`${apiGoc}/signature/from-5645`, { method: "POST" }).catch(() => null))}
              className="rounded-xl border border-indigo-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
              title="Chép các ảnh chữ ký đã tải bên tab Điền IMM5645e của hồ sơ này (bỏ qua ảnh trùng tên)"
            >
              ⤵ Lấy chữ ký từ IMM5645e ({soChuKy5645})
            </button>
          ) : null
        }
      />

      {anhChuKy.length > 0 && V && vungKy && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-neutral-600">
              Ngày ký (YYYY-MM-DD):{" "}
              <input
                value={signDate}
                onChange={(e) => doiNgay(e.target.value)}
                placeholder="2026-10-16"
                className={`ml-1 rounded-lg border px-2 py-1 text-sm ${
                  signDate && !/^\d{4}-\d{2}-\d{2}$/.test(signDate) ? "border-amber-400 bg-amber-50" : "border-neutral-300"
                }`}
              />
            </label>
            <span className="mr-auto" />
            {!chuKy && (
              <button
                type="button"
                disabled={!anhDung}
                onClick={() => {
                  doiChuKy({ anh: anhDung!, x: vungKy.oKy.x + 6, y: vungKy.oKy.y + vungKy.oKy.chuThich + 0.3, w: 20 });
                  setDangChon(true);
                }}
                className="rounded-lg px-3 py-1.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
              >
                + Đặt chữ ký “{anhDung ? tenAnh(anhDung) : ""}” vào ô ký
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <div
              ref={khung}
              className="relative min-w-[640px] select-none border border-neutral-300 bg-white font-sans text-neutral-800"
              style={{ aspectRatio: `${V.w} / ${V.h}` }}
            >
              <span className="absolute left-1 top-0.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-400">
                Mô phỏng phần SIGNATURE (trang 4)
              </span>
              {/* Ô đồng ý Yes / No (Consent, form đặt sẵn Yes) — chỉ để định vị. */}
              <div className="absolute flex items-center gap-[1%] text-[10px]" style={{ ...pt({ x: 111.126, y: 20.489, w: 28, h: 5.08 }) }}>
                <span className="flex h-3 w-3 items-center justify-center border border-neutral-500" />
                <span>No</span>
                <span className="ml-2 flex h-3 w-3 items-center justify-center border border-neutral-500 text-[9px]">✓</span>
                <span>Yes</span>
              </div>
              {/* Ô ký: chú thích trên, đường kẻ dưới. */}
              <div className="absolute flex flex-col" style={pt(vungKy.oKy)}>
                <p
                  className="text-center text-[8px] leading-tight text-neutral-600"
                  style={{ height: `${(vungKy.oKy.chuThich / vungKy.oKy.h) * 100}%` }}
                >
                  Signature of Applicant or Parent/Legal Guardian’s for a person under 18 years of age.
                </p>
                <div className="flex-1 border-b border-l border-r border-neutral-500" />
              </div>
              {/* Ô ngày ký. */}
              <div className="absolute flex items-end justify-center border-b border-neutral-500 pb-0.5 text-xs" style={pt(vungKy.oNgay)}>
                {signDate || <span className="text-neutral-400">YYYY-MM-DD</span>}
              </div>

              {chuKy && (
                <div
                  data-cho-ky
                  onPointerDown={(e) => batDauKeo(e, "move")}
                  className={`group absolute cursor-move touch-none rounded ${
                    dangChon ? "outline outline-2 outline-indigo-600" : "outline outline-1 outline-dashed outline-indigo-400 hover:outline-2"
                  }`}
                  style={{
                    left: `${((chuKy.x - V.x) / V.w) * 100}%`,
                    top: `${((chuKy.y - V.y) / V.h) * 100}%`,
                    width: `${(chuKy.w / V.w) * 100}%`,
                    zIndex: 10,
                  }}
                  title={`${tenAnh(chuKy.anh)} — kéo để đổi chỗ, kéo góc để to nhỏ`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`${apiGoc}/signature/${chuKy.anh}`} alt={tenAnh(chuKy.anh)} className="pointer-events-none block w-full" draggable={false} />
                  {GOC.map(({ g, lop }) => (
                    <span
                      key={g}
                      onPointerDown={(e) => batDauKeo(e, g)}
                      className={`absolute h-3.5 w-3.5 touch-none rounded-sm border-2 border-white bg-indigo-600 shadow ${lop} ${
                        dangChon ? "block" : "hidden group-hover:block"
                      }`}
                      title="Kéo để to / nhỏ"
                    />
                  ))}
                  {dangChon && (
                    <div
                      onPointerDown={(e) => e.stopPropagation()}
                      className="absolute left-1/2 top-full mt-2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-lg border border-neutral-200 bg-white px-1.5 py-1 text-xs shadow-lg"
                    >
                      <select
                        value={chuKy.anh}
                        onChange={(e) => sua({ anh: e.target.value })}
                        className="max-w-28 rounded border border-neutral-300 px-1 py-0.5 text-xs"
                        title="Đổi sang chữ ký khác"
                      >
                        {anhChuKy.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.ten}
                          </option>
                        ))}
                      </select>
                      <button type="button" onClick={() => doiCo(-BUOC_MM)} className="h-6 w-6 rounded font-bold text-neutral-700 hover:bg-neutral-100" title="Nhỏ lại">
                        −
                      </button>
                      <span className="tabular-nums text-neutral-500">{Math.round(chuKy.w)} mm</span>
                      <button type="button" onClick={() => doiCo(BUOC_MM)} className="h-6 w-6 rounded font-bold text-neutral-700 hover:bg-neutral-100" title="To lên">
                        +
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          doiChuKy(null);
                          setDangChon(false);
                        }}
                        className="h-6 rounded px-1.5 font-semibold text-red-600 hover:bg-red-50"
                        title="Bỏ chữ ký"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
