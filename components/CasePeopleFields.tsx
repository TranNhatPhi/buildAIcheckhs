"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/format";
import { FORM_HINT, FORM_INPUT, FORM_LABEL } from "@/lib/formStyles";

/** Ba người phụ trách một hồ sơ. Chuỗi rỗng = chưa nhập (backend lưu thành null). */
export interface CasePeople {
  receiverName: string;
  managerName: string;
  saleName: string;
}

const CAC_O: { key: keyof CasePeople; nhan: string; duong: string; viDu: string }[] = [
  { key: "receiverName", nhan: "Người nhận hồ sơ", duong: "receivers", viDu: "Người trực tiếp nhận hồ sơ từ khách" },
  { key: "managerName", nhan: "Nhân viên quản lý", duong: "managers", viDu: "Người theo dõi hồ sơ tới khi có kết quả" },
  { key: "saleName", nhan: "Sale phụ trách", duong: "sales", viDu: "Người chốt hợp đồng với khách" },
];

/**
 * Ba ô người phụ trách dùng chung cho form TẠO và form SỬA hồ sơ.
 *
 * Ô chữ TỰ DO có gợi ý từ giá trị đã nhập — cùng cách với ô "Đối tác / nguồn": không có bảng
 * nhân viên riêng, nên gợi ý chính là thứ kéo mọi người gõ giống nhau ("Ms. Thanh" chứ không
 * lẫn "ms thanh"). Gõ lệch một chữ là trang thống kê admin đếm thành hai người khác nhau.
 *
 * `idPrefix` phải khác nhau giữa hai form: cả hai có thể cùng nằm trên một trang (danh sách
 * hồ sơ + hộp sửa), trùng id datalist thì trình duyệt chỉ dùng cái đầu tiên.
 */
export function CasePeopleFields({
  value,
  onChange,
  idPrefix,
}: {
  value: CasePeople;
  onChange: (v: CasePeople) => void;
  idPrefix: string;
}) {
  const [goiY, setGoiY] = useState<Record<string, string[]>>({});

  useEffect(() => {
    // Gợi ý hỏng thì ô vẫn gõ tay được — không báo lỗi, không chặn lưu hồ sơ.
    for (const o of CAC_O) {
      fetch(`${API_URL}/cases/${o.duong}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((ds: string[]) => setGoiY((t) => ({ ...t, [o.key]: ds })))
        .catch(() => {});
    }
  }, []);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {CAC_O.map((o) => (
        <div key={o.key}>
          <label className={FORM_LABEL} htmlFor={`${idPrefix}-${o.key}`}>
            {o.nhan} <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
          </label>
          <input
            id={`${idPrefix}-${o.key}`}
            list={`${idPrefix}-goi-y-${o.key}`}
            maxLength={191}
            value={value[o.key]}
            onChange={(e) => onChange({ ...value, [o.key]: e.target.value })}
            className={FORM_INPUT}
          />
          <datalist id={`${idPrefix}-goi-y-${o.key}`}>
            {(goiY[o.key] ?? []).map((ten) => (
              <option key={ten} value={ten} />
            ))}
          </datalist>
          <p className={FORM_HINT}>{o.viDu}</p>
        </div>
      ))}
    </div>
  );
}
