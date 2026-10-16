"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/format";
import { ThuVienChuKy, type AnhChuKy, type KetQuaThuVien } from "@/components/ThuVienChuKy";

export type { AnhChuKy };

/** Một chỗ đặt chữ ký: trang 0/1; x, y = góc trên trái, w = bề rộng — TỈ LỆ theo khổ trang; anh = id ảnh dùng. */
export interface ChoKy {
  page: number;
  x: number;
  y: number;
  w: number;
  anh: string;
}

type Goc = "move" | "nw" | "ne" | "sw" | "se";

const kep = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
const SO_TRANG = 2;
const W_MIN = 0.03;
const W_MAX = 0.6;
const BUOC_CO = 0.01; // nút −/+ : 1% bề rộng trang mỗi lần

/**
 * Chữ ký trên IMM5645e (Docs 16/10/2026): THƯ VIỆN nhiều ảnh chữ ký của hồ sơ (đương đơn, bố, mẹ... — tải nhiều file
 * một lần; backend xoá nền, cắt sát), rồi KÉO từng chữ ký tới đúng chỗ trên ảnh trang, kéo 4 GÓC (hoặc −/+) để đổi cỡ.
 * Vị trí + tên ảnh nằm trong dữ liệu form (Lưu như ô thường); PDF tải xuống chèn đúng ảnh ở đúng chỗ. Ảnh trang là bản
 * ĐÃ LƯU, không có chữ ký — chữ ký vẽ đè lên để kéo.
 */
export function ChuKyImm5645({
  caseId,
  anhChuKy,
  chuKy,
  phienBan,
  doiChuKy,
  doiAnh,
  daLuu,
}: {
  caseId: string;
  anhChuKy: AnhChuKy[];
  chuKy: ChoKy[];
  phienBan: string | null;
  doiChuKy: (ds: ChoKy[]) => void; // kéo / thêm / bỏ chỗ ký -> "chưa lưu"
  doiAnh: (ds: AnhChuKy[]) => void; // đổi tên ảnh -> "chưa lưu"
  daLuu: (kq: { anhChuKy: AnhChuKy[]; chuKy: ChoKy[]; updatedAt?: string }) => void; // backend đã lưu (thêm / xoá ảnh)
}) {
  const [anhChon, setAnhChon] = useState<string | null>(null);
  const [dangChon, setDangChon] = useState<number | null>(null);
  const khung = useRef<(HTMLDivElement | null)[]>([]);
  // Bản mới nhất cho handler kéo (đang kéo thì props đổi liên tục).
  const chuKyRef = useRef(chuKy);
  useEffect(() => {
    chuKyRef.current = chuKy;
  }, [chuKy]);

  const anhDung = anhChuKy.some((a) => a.id === anhChon) ? anhChon : (anhChuKy[0]?.id ?? null);
  const tenAnh = (id: string) => anhChuKy.find((a) => a.id === id)?.ten ?? "?";
  const urlAnh = (id: string) => `${API_URL}/imm5645/${caseId}/signature/${id}`; // ảnh đè lên trang

  function sua(i: number, thayDoi: Partial<ChoKy>) {
    doiChuKy(chuKyRef.current.map((c, k) => (k === i ? { ...c, ...thayDoi } : c)));
  }

  /** Đổi cỡ quanh TÂM giữ nguyên (nút −/+). */
  function doiCo(i: number, buoc: number) {
    const c = chuKy[i];
    const w = kep(c.w + buoc, W_MIN, W_MAX);
    sua(i, { w, x: kep(c.x - (w - c.w) / 2, 0, 1 - w) });
  }

  /** Kéo để di chuyển, hoặc kéo 1 trong 4 góc để đổi cỡ (góc đối diện đứng yên, giữ tỉ lệ ảnh). Tính theo tỉ lệ khung
   *  trang nên đúng ở mọi cỡ màn hình. */
  function batDauKeo(e: React.PointerEvent, i: number, goc: Goc) {
    e.preventDefault();
    e.stopPropagation();
    setDangChon(i);
    const c0 = { ...chuKyRef.current[i] };
    const kh = khung.current[c0.page]?.getBoundingClientRect();
    const o = (e.currentTarget as HTMLElement).closest("[data-cho-ky]")?.getBoundingClientRect();
    if (!kh || !o) return;
    const h0 = o.height / kh.height; // chiều cao (tỉ lệ trang) lúc bắt đầu
    const x0 = e.clientX;
    const y0 = e.clientY;
    const di = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / kh.width;
      const dy = (ev.clientY - y0) / kh.height;
      if (goc === "move") {
        sua(i, { x: kep(c0.x + dx, 0, 1 - c0.w), y: kep(c0.y + dy, 0, 0.98) });
        return;
      }
      const trai = goc === "nw" || goc === "sw"; // kéo góc bên trái -> bề rộng tăng khi kéo sang trái
      const w = kep(c0.w + (trai ? -dx : dx), W_MIN, Math.min(W_MAX, trai ? c0.x + c0.w : 1 - c0.x));
      const x = trai ? c0.x + c0.w - w : c0.x;
      const tren = goc === "nw" || goc === "ne"; // kéo góc trên -> giữ CHÂN chữ ký đứng yên
      const y = tren ? c0.y + h0 * (1 - w / c0.w) : c0.y;
      sua(i, { w, x, y: kep(y, 0, 0.98) });
    };
    const tha = () => {
      window.removeEventListener("pointermove", di);
      window.removeEventListener("pointerup", tha);
    };
    window.addEventListener("pointermove", di);
    window.addEventListener("pointerup", tha);
  }

  const GOC: { g: Goc; lop: string }[] = [
    { g: "nw", lop: "-left-1.5 -top-1.5 cursor-nwse-resize" },
    { g: "ne", lop: "-right-1.5 -top-1.5 cursor-nesw-resize" },
    { g: "sw", lop: "-left-1.5 -bottom-1.5 cursor-nesw-resize" },
    { g: "se", lop: "-right-1.5 -bottom-1.5 cursor-nwse-resize" },
  ];

  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border-2 border-neutral-200 bg-white p-4"
      onPointerDown={(e) => !(e.target as HTMLElement).closest("[data-cho-ky]") && setDangChon(null)}
    >
      <h2 className="text-lg font-bold text-neutral-800">✍ Chữ ký</h2>
      <p className="text-xs text-neutral-500">
        Tải ảnh chụp / scan chữ ký trên giấy trắng (tự xoá nền, cắt sát nét). Mỗi người một ảnh (đặt tên để dễ phân biệt).
        Ảnh đầu tiên tự đặt ở các dòng “Signature” cần ký. <b>Kéo chữ ký</b> để đổi chỗ, <b>kéo 4 góc</b> (hoặc bấm vào
        chữ ký rồi dùng −/+) để to nhỏ, đổi sang chữ ký khác hoặc ✕ để bỏ. Xong bấm <b>Lưu</b> rồi tải PDF.
      </p>
      <ThuVienChuKy
        apiGoc={`${API_URL}/imm5645/${caseId}`}
        anhChuKy={anhChuKy}
        soChoDung={(id) => chuKy.filter((c) => c.anh === id).length}
        anhDung={anhDung}
        chonAnh={setAnhChon}
        doiAnh={doiAnh}
        daLuu={(kq: KetQuaThuVien) => {
          setDangChon(null);
          daLuu(kq as unknown as { anhChuKy: AnhChuKy[]; chuKy: ChoKy[]; updatedAt?: string });
        }}
      />

      {anhChuKy.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: SO_TRANG }, (_, trang) => (
            <div key={trang} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-neutral-700">Trang {trang + 1}</p>
                <button
                  type="button"
                  disabled={!anhDung || chuKy.length >= 12}
                  onClick={() => {
                    doiChuKy([...chuKy, { page: trang, x: 0.35, y: 0.45, w: 0.13, anh: anhDung! }]);
                    setDangChon(chuKy.length);
                  }}
                  className="rounded-lg px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
                >
                  + Thêm chữ ký “{anhDung ? tenAnh(anhDung) : ""}” vào trang {trang + 1}
                </button>
              </div>
              <div
                ref={(el) => {
                  khung.current[trang] = el;
                }}
                className="relative w-full select-none rounded-lg border border-neutral-300 bg-white shadow-sm"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${API_URL}/imm5645/${caseId}/page/${trang}?dpi=110&v=${encodeURIComponent(phienBan ?? "")}`}
                  alt={`Trang ${trang + 1}`}
                  className="block w-full rounded-lg"
                  draggable={false}
                />
                {chuKy.map((c, i) => {
                  if (c.page !== trang) return null;
                  const chon = dangChon === i;
                  return (
                    <div
                      key={i}
                      data-cho-ky
                      onPointerDown={(e) => batDauKeo(e, i, "move")}
                      className={`group absolute cursor-move touch-none rounded ${
                        chon ? "outline outline-2 outline-indigo-600" : "outline outline-1 outline-dashed outline-indigo-400 hover:outline-2"
                      }`}
                      style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, zIndex: chon ? 20 : 10 }}
                      title={`${tenAnh(c.anh)} — kéo để đổi chỗ, kéo góc để to nhỏ`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={urlAnh(c.anh)} alt={tenAnh(c.anh)} className="pointer-events-none block w-full" draggable={false} />
                      {GOC.map(({ g, lop }) => (
                        <span
                          key={g}
                          onPointerDown={(e) => batDauKeo(e, i, g)}
                          className={`absolute h-3.5 w-3.5 touch-none rounded-sm border-2 border-white bg-indigo-600 shadow ${lop} ${
                            chon ? "block" : "hidden group-hover:block"
                          }`}
                          title="Kéo để to / nhỏ"
                        />
                      ))}
                      {chon && (
                        <div
                          onPointerDown={(e) => e.stopPropagation()}
                          className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-lg border border-neutral-200 bg-white px-1.5 py-1 text-xs shadow-lg"
                        >
                          <select
                            value={c.anh}
                            onChange={(e) => sua(i, { anh: e.target.value })}
                            className="max-w-28 rounded border border-neutral-300 px-1 py-0.5 text-xs"
                            title="Đổi sang chữ ký khác"
                          >
                            {anhChuKy.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.ten}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => doiCo(i, -BUOC_CO)}
                            className="h-6 w-6 rounded font-bold text-neutral-700 hover:bg-neutral-100"
                            title="Nhỏ lại"
                          >
                            −
                          </button>
                          <span className="tabular-nums text-neutral-500">{Math.round(c.w * 612)}pt</span>
                          <button
                            type="button"
                            onClick={() => doiCo(i, BUOC_CO)}
                            className="h-6 w-6 rounded font-bold text-neutral-700 hover:bg-neutral-100"
                            title="To lên"
                          >
                            +
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              doiChuKy(chuKy.filter((_, k) => k !== i));
                              setDangChon(null);
                            }}
                            className="h-6 rounded px-1.5 font-semibold text-red-600 hover:bg-red-50"
                            title="Bỏ chữ ký ở chỗ này"
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
