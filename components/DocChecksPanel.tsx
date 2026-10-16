"use client";

import { useEffect, useState } from "react";
import type { DataConflictDTO, DocChecksDTO, DocExpiryDTO, DocumentDTO } from "@/lib/client-types";
import { API_URL, documentPageCount } from "@/lib/format";

type Props = {
  caseId: string;
  checks: DocChecksDTO;
  // Để bấm vào một dòng lệch là mở popup xem các file (cần số trang / loại file).
  documents: DocumentDTO[];
  onChanged: () => void;
};

const LA_ANH_TRANG = /\.(pdf|docx?|odt|rtf|xlsx?|ods)$/i;

/** Một file trong popup so sánh: giá trị đang lệch + ảnh từng trang (PDF / Word đã lưu ảnh trang) hoặc ảnh gốc. */
function CotFile({ v, doc }: { v: { value: string; filename: string; documentId: string }; doc?: DocumentDTO }) {
  const [loiTrang, setLoiTrang] = useState(false);
  const soTrang = doc ? documentPageCount(doc) ?? 1 : 1;
  const coAnhTrang = !!doc && (doc.mimeType === "application/pdf" || LA_ANH_TRANG.test(doc.originalFilename));
  const urlFile = `${API_URL}/documents/${v.documentId}/file`;
  return (
    <div className="flex min-h-0 min-w-[300px] flex-1 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
      <div className="border-b border-neutral-200 bg-white px-3 py-2">
        <p className="text-base font-bold text-orange-800">{hienGiaTri(v.value)}</p>
        <p className="truncate text-xs text-neutral-600" title={v.filename}>
          {v.filename}
        </p>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-neutral-400">
          <span className="truncate">
            {doc?.matchedChecklistItem?.nameVi ?? "Chưa xếp mục"} · {soTrang} trang
          </span>
          <a href={urlFile} target="_blank" rel="noreferrer" className="shrink-0 font-semibold text-indigo-600 hover:underline">
            Mở file gốc ↗
          </a>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto p-3">
        {!doc ? (
          <p className="text-sm text-neutral-500">File không còn trong hồ sơ.</p>
        ) : coAnhTrang && !loiTrang ? (
          Array.from({ length: soTrang }, (_, k) => (
            <figure key={k} className="w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${API_URL}/documents/${v.documentId}/pages/${k + 1}`}
                alt={`Trang ${k + 1}`}
                loading="lazy"
                onError={() => setLoiTrang(true)}
                className="w-full rounded bg-white shadow"
              />
              <figcaption className="mt-1 text-center text-[11px] text-neutral-400">Trang {k + 1}</figcaption>
            </figure>
          ))
        ) : coAnhTrang ? (
          <iframe src={urlFile} title={v.filename} className="h-[70vh] w-full rounded bg-white" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={urlFile} alt={v.filename} className="w-full rounded bg-white shadow" />
        )}
      </div>
    </div>
  );
}

type GiaTriFile = DataConflictDTO["values"][number];

/** Popup xem file, đặt cạnh nhau (file vừa bấm đứng đầu) — dùng cho cả mục LỆCH (nhiều file) và mục HẠN GIẤY TỜ (1
 *  file). 16/10/2026 Docs "bấm vào ra popup để check cho dễ". */
function PopupFile({
  tieuDe,
  moTa,
  ds: dsGoc,
  dau,
  documents,
  dong,
  daCheck,
}: {
  tieuDe: string;
  moTa: string;
  ds: GiaTriFile[];
  dau: string;
  documents: DocumentDTO[];
  dong: () => void;
  daCheck: () => void;
}) {
  useEffect(() => {
    const thoat = (e: KeyboardEvent) => e.key === "Escape" && dong();
    window.addEventListener("keydown", thoat);
    return () => window.removeEventListener("keydown", thoat);
  }, [dong]);
  const ds = [...dsGoc].sort((a, b) => Number(b.documentId === dau) - Number(a.documentId === dau));
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && dong()}
    >
      <div className="flex h-full max-h-[94vh] w-full max-w-7xl flex-col gap-3 overflow-hidden rounded-2xl bg-white p-4 shadow-2xl">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h3 className="text-lg font-bold text-neutral-800">{tieuDe}</h3>
            <p className="text-xs text-neutral-500">{moTa}</p>
          </div>
          <button
            type="button"
            onClick={daCheck}
            className="rounded-full border border-emerald-300 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
          >
            ✓ Đã check
          </button>
          <button type="button" onClick={dong} className="rounded-full px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100">
            ✕ Đóng
          </button>
        </div>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
          {ds.map((v) => (
            <CotFile key={v.documentId + v.value} v={v} doc={documents.find((d) => d.id === v.documentId)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** "2026-03-01" -> "01/03/2026". Cắt chuỗi chứ KHÔNG dùng new Date(): chuỗi chỉ có ngày được
 *  trình duyệt hiểu là nửa đêm giờ UTC, đem về giờ máy có thể lùi mất một ngày — sai đúng vào
 *  con số quyết định giấy tờ còn hạn hay không. */
function ngayVN(iso: string) {
  const [nam, thang, ngay] = iso.split("-");
  return `${ngay}/${thang}/${nam}`;
}

/** Giá trị lệch có thể là tên, số hộ chiếu, hoặc ngày sinh — chỉ đổi định dạng khi đúng là
 *  một ngày ISO, để không đụng vào hai loại còn lại. */
function hienGiaTri(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? ngayVN(value) : value;
}

function moTaConLai(daysLeft: number) {
  if (daysLeft < 0) return `đã quá hạn ${Math.abs(daysLeft)} ngày`;
  if (daysLeft === 0) return "hết hạn hôm nay";
  return `còn ${daysLeft} ngày`;
}

function DongHan({
  han,
  onChanged,
  onXem,
  onCheck,
}: {
  han: DocExpiryDTO;
  onChanged: () => void;
  onXem: () => void;
  onCheck: () => void;
}) {
  const [dangSua, setDangSua] = useState(false);
  const [ngay, setNgay] = useState(han.expiresAt);
  const [dangLuu, setDangLuu] = useState(false);
  const quaHan = han.state === "EXPIRED";

  async function luu(giaTri: string | null) {
    setDangLuu(true);
    const res = await fetch(`${API_URL}/documents/${han.documentId}/expires-at`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manualExpiresAt: giaTri }),
    });
    setDangLuu(false);
    if (!res.ok) {
      alert("Lưu ngày hết hạn thất bại.");
      return;
    }
    setDangSua(false);
    onChanged();
  }

  return (
    <li
      className={`rounded-xl border px-3 py-2.5 ${
        quaHan ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onXem}
          className="-mx-1 min-w-0 rounded px-1 text-left hover:bg-white/60"
          title="Bấm để mở file xem ngày hết hạn"
        >
          <p className="truncate text-sm font-semibold text-neutral-800">
            {han.itemName ?? han.filename} <span className="text-indigo-500">🔍</span>
          </p>
          <p className="mt-0.5 text-xs text-neutral-600">
            {han.itemName && (
              <span className="text-neutral-500 underline decoration-dotted underline-offset-2">{han.filename} · </span>
            )}
            Hết hạn {ngayVN(han.expiresAt)} —{" "}
            <strong className={quaHan ? "text-red-700" : "text-amber-700"}>
              {moTaConLai(han.daysLeft)}
            </strong>
            {/* Nói rõ ngày này từ đâu ra: một ngày do AI đọc từ ảnh mờ không đáng tin bằng
                ngày nhân viên đã tự đối chiếu với bản gốc. */}
            {han.source === "AI" ? " · AI đọc từ giấy tờ" : " · nhân viên đã sửa tay"}
          </p>
        </button>

        {!dangSua && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setDangSua(true)}
              className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-neutral-700 shadow-sm transition-colors hover:bg-neutral-100"
            >
              Sửa ngày
            </button>
            <button
              type="button"
              onClick={onCheck}
              title="Đã kiểm tra — ẩn mục này (sửa ngày / thay file thì tự hiện lại)"
              className="rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm transition-colors hover:bg-emerald-50"
            >
              ✓ Đã check
            </button>
          </div>
        )}
      </div>

      {dangSua && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={ngay}
            onChange={(e) => setNgay(e.target.value)}
            className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={dangLuu || !ngay}
            onClick={() => luu(ngay)}
            className="rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {dangLuu ? "Đang lưu..." : "Lưu"}
          </button>
          <button
            type="button"
            onClick={() => setDangSua(false)}
            className="rounded-full px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100"
          >
            Huỷ
          </button>
          {han.source === "MANUAL" && (
            <button
              type="button"
              disabled={dangLuu}
              onClick={() => luu(null)}
              className="rounded-full px-3 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
            >
              Xoá ngày sửa tay, dùng lại ngày AI đọc
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Cảnh báo hạn giấy tờ + điểm bất nhất giữa các giấy tờ.
 *
 * Cả hai đều tính bằng CODE trên thông tin AI đã bóc ra lúc phân loại, nên luôn có sẵn ngay
 * khi mở hồ sơ — khác với "Phân tích AI chuyên sâu" phải bấm nút, chạy vài phút, và mỗi lần
 * chạy có thể ra kết quả khác.
 *
 * Không có gì để báo thì KHÔNG hiện gì cả: một khung "mọi thứ đều ổn" nằm thường trực chỉ
 * làm nhân viên quen mắt bỏ qua đúng chỗ này, tới lúc có cảnh báo thật cũng không ai nhìn.
 */
export function DocChecksPanel({ caseId, checks, documents, onChanged }: Props) {
  // Popup xem file của một mục (lệch / hạn): khoá mục + các file + file vừa bấm (đứng đầu).
  const [xem, setXem] = useState<{ key: string; tieuDe: string; moTa: string; ds: GiaTriFile[]; dau: string } | null>(null);
  // Mục vừa bấm ✓ — ẩn NGAY trên màn hình, không chờ tải lại hồ sơ.
  const [daCheck, setDaCheck] = useState<string[]>([]);
  const conLech = checks.conflicts.filter((x) => !daCheck.includes(x.key));
  const conHan = checks.expiries.filter((h) => !daCheck.includes(h.key));
  const soQuaHan = conHan.filter((h) => h.state === "EXPIRED").length;
  const soSapHet = conHan.length - soQuaHan;
  const coHan = conHan.length > 0;
  const coBatNhat = conLech.length > 0;

  /** Bấm ✓: nhân viên đã đối chiếu xong mục này -> ẩn (lưu theo hồ sơ, máy khác / F5 cũng ẩn). File đổi làm giá
   *  trị lệch đổi thì backend coi là mục mới, tự hiện lại. */
  async function danhDauDaKiemTra(key: string) {
    setDaCheck((cu) => [...cu, key]);
    const res = await fetch(`${API_URL}/cases/${caseId}/conflicts/checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).catch(() => null);
    if (!res?.ok) {
      setDaCheck((cu) => cu.filter((k) => k !== key));
      alert("Không lưu được — thử lại.");
      return;
    }
    onChanged();
  }
  if (!coHan && !coBatNhat) return null;

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      {coHan && (
        <div>
          <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-base font-bold text-neutral-800">Hạn giấy tờ</h2>
            <span className="text-xs text-neutral-500">
              {soQuaHan > 0 && <strong className="text-red-700">{soQuaHan} đã quá hạn</strong>}
              {soQuaHan > 0 && soSapHet > 0 && " · "}
              {soSapHet > 0 && (
                <span className="text-amber-700">
                  {soSapHet} sắp hết hạn (trong {checks.warnDays} ngày)
                </span>
              )}
            </span>
          </div>
          <ul className="space-y-2">
            {conHan.map((h) => (
              <DongHan
                key={h.key}
                han={h}
                onChanged={onChanged}
                onCheck={() => danhDauDaKiemTra(h.key)}
                onXem={() =>
                  setXem({
                    key: h.key,
                    tieuDe: `Hạn giấy tờ · ${h.itemName ?? h.filename}`,
                    moTa: `Hết hạn ${ngayVN(h.expiresAt)} — ${moTaConLai(h.daysLeft)} (${h.source === "AI" ? "AI đọc" : "nhân viên sửa tay"}). Xem file để kiểm tra ngày.`,
                    ds: [{ value: `Hết hạn ${ngayVN(h.expiresAt)}`, filename: h.filename, documentId: h.documentId }],
                    dau: h.documentId,
                  })
                }
              />
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            Chỉ liệt kê giấy tờ đọc được ngày hết hạn. File không có ngày, hoặc AI không đọc
            chắc chắn, sẽ không hiện ở đây — mở file để tự kiểm tra. Bấm vào một mục (🔍) để mở file; “✓ Đã check” để ẩn
            mục đã kiểm tra (sửa ngày / thay file thì tự hiện lại).
          </p>
        </div>
      )}

      {coBatNhat && (
        <div className={coHan ? "border-t border-neutral-200 pt-4" : undefined}>
          <h2 className="mb-2.5 text-base font-bold text-neutral-800">
            Thông tin lệch nhau giữa các giấy tờ
          </h2>
          <ul className="space-y-2">
            {conLech.map((x) => (
              <li
                key={x.key}
                className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-neutral-800">
                    {x.ownerLabel} · {x.fieldLabel}
                  </p>
                  <button
                    type="button"
                    onClick={() => danhDauDaKiemTra(x.key)}
                    title="Đã kiểm tra — ẩn mục này"
                    className="shrink-0 rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm transition-colors hover:bg-emerald-50"
                  >
                    ✓ Đã check
                  </button>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {x.values.map((v) => (
                    <li key={v.filename + v.value} className="text-xs text-neutral-700">
                      <button
                        type="button"
                        onClick={() =>
                          setXem({
                            key: x.key,
                            tieuDe: `${x.ownerLabel} · ${x.fieldLabel}`,
                            moTa: `${x.values.length} file đang ghi khác nhau — đặt cạnh nhau để đối chiếu.`,
                            ds: x.values,
                            dau: v.documentId,
                          })
                        }
                        disabled={!v.documentId}
                        className="rounded px-1 -mx-1 text-left hover:bg-orange-100 disabled:hover:bg-transparent"
                        title="Bấm để mở các file của mục này cạnh nhau"
                      >
                        <strong className="text-orange-800">{hienGiaTri(v.value)}</strong>
                        <span className="text-neutral-500 underline decoration-dotted underline-offset-2"> — {v.filename}</span>
                        <span className="ml-1 text-indigo-500">🔍</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            Chỉ so giữa các giấy tờ của cùng một người, và số CCCD chỉ so với số CCCD (số hộ
            chiếu của cùng người vốn khác số CCCD, không phải mâu thuẫn). Bấm “✓ Đã check” khi đã đối chiếu xong —
            mục đó ẩn đi; nếu sau này file đổi làm giá trị lệch khác đi thì mục tự hiện lại. Bấm vào một dòng (🔍) để mở
            các file của mục đó cạnh nhau.
          </p>
        </div>
      )}
      {xem && !daCheck.includes(xem.key) && (
        <PopupFile
          tieuDe={xem.tieuDe}
          moTa={xem.moTa}
          ds={xem.ds}
          dau={xem.dau}
          documents={documents}
          dong={() => setXem(null)}
          daCheck={() => {
            const k = xem.key;
            setXem(null);
            danhDauDaKiemTra(k);
          }}
        />
      )}
    </section>
  );
}
