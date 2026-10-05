"use client";

import { useEffect, useState } from "react";
import type { ExperienceUnit } from "@/lib/client-types";
import { API_URL } from "@/lib/format";
import { FORM_HINT, FORM_INPUT, FORM_LABEL } from "@/lib/formStyles";

const TOI_DA = 10;

/** Dòng trống để nhập — form luôn có sẵn ít nhất đơn vị 1. */
export const DON_VI_TRONG: ExperienceUnit = { name: "", confirmedDate: null };

/** Bỏ dòng không có tên công ty trước khi gửi lên — backend cũng bỏ, làm ở đây cho gọn body.
 *  Không gửi ngày: máy chủ tự ghi ngày lúc bấm Tạo/Lưu (giữ ngày cũ cho đơn vị không đổi). */
export function donViDeGui(ds: ExperienceUnit[]): { name: string }[] {
  return ds.filter((u) => u.name.trim()).map((u) => ({ name: u.name.trim() }));
}

/** "YYYY-MM-DD" -> "dd/mm/yyyy", đọc thẳng từ chuỗi (Date đọc ngày trần theo UTC, dễ lệch 1 ngày). */
function ngayVN(iso: string | null): string | null {
  const [y, m, d] = (iso ?? "").split("-");
  return iso && y && m && d ? `${d}/${m}/${y}` : null;
}

/**
 * "Đơn vị xác nhận kinh nghiệm" — CHỈ nhập tên công ty; ngày tháng năm máy chủ tự ghi lúc bấm
 * "Tạo hồ sơ" / "Lưu". Ở form sửa, đơn vị đã có hiện kèm ngày đã ghi (chỉ để xem).
 * Đơn vị 1 hiện sẵn; nút "+" thêm đơn vị 2, 3… (nếu có). Dùng chung cho form TẠO và form SỬA.
 *
 * `idPrefix` phải khác nhau giữa hai form (cùng lý do với CasePeopleFields).
 */
export function ExperienceUnitsField({
  value,
  onChange,
  idPrefix,
}: {
  value: ExperienceUnit[];
  onChange: (v: ExperienceUnit[]) => void;
  idPrefix: string;
}) {
  const ds = value.length ? value : [DON_VI_TRONG];
  // Công ty đã nhập ở mọi hồ sơ — gõ vài chữ là trình duyệt lọc ra để chọn (datalist).
  const [goiY, setGoiY] = useState<string[]>([]);
  useEffect(() => {
    fetch(`${API_URL}/cases/experience-units`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: unknown) => setGoiY(Array.isArray(d) ? (d as string[]) : []))
      .catch(() => setGoiY([]));
  }, []);
  const idGoiY = `${idPrefix}-goi-y-don-vi-kn`;

  function sua(i: number, thayDoi: Partial<ExperienceUnit>) {
    onChange(ds.map((u, k) => (k === i ? { ...u, ...thayDoi } : u)));
  }

  return (
    <div className="flex flex-col gap-3">
      <datalist id={idGoiY}>
        {goiY.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      {ds.map((u, i) => (
        <div key={i}>
          <label className={FORM_LABEL} htmlFor={`${idPrefix}-don-vi-kn-${i}`}>
            {i === 0 ? "Đơn vị xác nhận kinh nghiệm" : `Đơn vị xác nhận kinh nghiệm ${i + 1}`}{" "}
            <span className="font-normal text-neutral-400">{i === 0 ? "(tuỳ chọn)" : "(nếu có)"}</span>
          </label>
          <div className="flex gap-2">
            <input
              id={`${idPrefix}-don-vi-kn-${i}`}
              list={idGoiY}
              autoComplete="off"
              value={u.name}
              onChange={(e) => sua(i, { name: e.target.value })}
              maxLength={191}
              className={FORM_INPUT}
              placeholder="Tên công ty xác nhận kinh nghiệm"
            />
            {i > 0 && (
              <button
                type="button"
                onClick={() => onChange(ds.filter((_, k) => k !== i))}
                className="shrink-0 rounded-lg px-2.5 text-sm text-neutral-400 hover:bg-red-50 hover:text-red-600"
                aria-label={`Bỏ đơn vị xác nhận kinh nghiệm ${i + 1}`}
                title="Bỏ đơn vị này"
              >
                ✕
              </button>
            )}
          </div>
          {ngayVN(u.confirmedDate) && (
            <p className="mt-1 text-xs text-neutral-500">Ngày nhập: {ngayVN(u.confirmedDate)}</p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={FORM_HINT}>
          Gõ vài chữ để chọn công ty đã nhập ở hồ sơ khác, hoặc nhập tên mới. Ngày tháng năm tự lấy lúc bấm
          “Tạo hồ sơ” / “Lưu”.
        </p>
        {ds.length < TOI_DA && (
          <button
            type="button"
            onClick={() => onChange([...ds, { ...DON_VI_TRONG }])}
            className="inline-flex items-center gap-1 rounded-lg border border-dashed border-indigo-300 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
          >
            <span aria-hidden className="text-sm leading-none">+</span>
            Thêm đơn vị xác nhận kinh nghiệm {ds.length + 1}
          </button>
        )}
      </div>
    </div>
  );
}

/** "Thời gian cung cấp" ở bảng thống kê: ngày của đơn vị ĐẦU TIÊN (đơn vị 1), dd/mm/yyyy. */
export function ngayCungCap(ds: ExperienceUnit[] | undefined): string | null {
  return ngayVN(ds?.[0]?.confirmedDate ?? null);
}

/** "Cty A (30/09/2026) · Cty B (01/10/2026)" — dòng tóm tắt ở trang hồ sơ. */
export function tomTatDonVi(ds: ExperienceUnit[] | undefined): string {
  return (ds ?? []).map((u) => (ngayVN(u.confirmedDate) ? `${u.name} (${ngayVN(u.confirmedDate)})` : u.name)).join(" · ");
}
