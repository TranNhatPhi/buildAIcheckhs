"use client";

import { useState } from "react";
import type { DocChecksDTO, DocExpiryDTO } from "@/lib/client-types";
import { API_URL } from "@/lib/format";

type Props = {
  checks: DocChecksDTO;
  onChanged: () => void;
};

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

function DongHan({ han, onChanged }: { han: DocExpiryDTO; onChanged: () => void }) {
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
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-neutral-800">
            {han.itemName ?? han.filename}
          </p>
          <p className="mt-0.5 text-xs text-neutral-600">
            {han.itemName && <span className="text-neutral-500">{han.filename} · </span>}
            Hết hạn {ngayVN(han.expiresAt)} —{" "}
            <strong className={quaHan ? "text-red-700" : "text-amber-700"}>
              {moTaConLai(han.daysLeft)}
            </strong>
            {/* Nói rõ ngày này từ đâu ra: một ngày do AI đọc từ ảnh mờ không đáng tin bằng
                ngày nhân viên đã tự đối chiếu với bản gốc. */}
            {han.source === "AI" ? " · AI đọc từ giấy tờ" : " · nhân viên đã sửa tay"}
          </p>
        </div>

        {!dangSua && (
          <button
            type="button"
            onClick={() => setDangSua(true)}
            className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-neutral-700 shadow-sm transition-colors hover:bg-neutral-100"
          >
            Sửa ngày
          </button>
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
export function DocChecksPanel({ checks, onChanged }: Props) {
  const coHan = checks.expiries.length > 0;
  const coBatNhat = checks.conflicts.length > 0;
  if (!coHan && !coBatNhat) return null;

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      {coHan && (
        <div>
          <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-base font-bold text-neutral-800">Hạn giấy tờ</h2>
            <span className="text-xs text-neutral-500">
              {checks.expiredCount > 0 && (
                <strong className="text-red-700">{checks.expiredCount} đã quá hạn</strong>
              )}
              {checks.expiredCount > 0 && checks.expiringSoonCount > 0 && " · "}
              {checks.expiringSoonCount > 0 && (
                <span className="text-amber-700">
                  {checks.expiringSoonCount} sắp hết hạn (trong {checks.warnDays} ngày)
                </span>
              )}
            </span>
          </div>
          <ul className="space-y-2">
            {checks.expiries.map((h) => (
              <DongHan key={h.documentId} han={h} onChanged={onChanged} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            Chỉ liệt kê giấy tờ đọc được ngày hết hạn. File không có ngày, hoặc AI không đọc
            chắc chắn, sẽ không hiện ở đây — mở file để tự kiểm tra.
          </p>
        </div>
      )}

      {coBatNhat && (
        <div className={coHan ? "border-t border-neutral-200 pt-4" : undefined}>
          <h2 className="mb-2.5 text-base font-bold text-neutral-800">
            Thông tin lệch nhau giữa các giấy tờ
          </h2>
          <ul className="space-y-2">
            {checks.conflicts.map((x) => (
              <li
                key={`${x.owner}-${x.fieldLabel}`}
                className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2.5"
              >
                <p className="text-sm font-semibold text-neutral-800">
                  {x.ownerLabel} · {x.fieldLabel}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {x.values.map((v) => (
                    <li key={v.filename + v.value} className="text-xs text-neutral-700">
                      <strong className="text-orange-800">{hienGiaTri(v.value)}</strong>
                      <span className="text-neutral-500"> — {v.filename}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            Chỉ so giữa các giấy tờ của cùng một người, và số CCCD chỉ so với số CCCD (số hộ
            chiếu của cùng người vốn khác số CCCD, không phải mâu thuẫn).
          </p>
        </div>
      )}
    </section>
  );
}
