"use client";

import { useState } from "react";
import { API_URL } from "@/lib/format";
import type { FinancialThresholdDTO, SavingsAssessmentDTO } from "@/lib/client-types";

type Props = {
  caseId: string;
  threshold: FinancialThresholdDTO;
  savings: SavingsAssessmentDTO;
  onChanged: () => void;
};

/** 265000000 -> "265.000.000 đ". Dấu chấm ngăn nghìn theo cách viết tiền Việt Nam. */
function formatVnd(n: number): string {
  return `${n.toLocaleString("vi-VN")} đ`;
}

/** 265000000 -> "265 triệu"; 1250000000 -> "1,25 tỷ". Dòng phụ giúp đọc nhanh con số dài,
 *  vì đếm số 0 bằng mắt chính là chỗ dễ nhầm nhất khi nhìn tiền tỉ. */
function formatShortVnd(n: number): string {
  if (n >= 1_000_000_000) {
    const ty = n / 1_000_000_000;
    return `${(Math.round(ty * 100) / 100).toLocaleString("vi-VN")} tỷ`;
  }
  return `${Math.round(n / 1_000_000).toLocaleString("vi-VN")} triệu`;
}

/** Chỉ giữ chữ số rồi parse — nhân viên gõ "400.000.000", "400,000,000" hay "400 000 000"
 *  đều ra cùng một số, thay vì bắt họ gõ đúng một kiểu. */
function parseVndInput(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return Number(digits);
}

const VERDICT_STYLE: Record<
  SavingsAssessmentDTO["verdict"],
  { border: string; badge: string; label: string }
> = {
  ENOUGH: {
    border: "border-emerald-200 bg-emerald-50",
    badge: "bg-emerald-100 text-emerald-800",
    label: "Đủ điều kiện tài chính",
  },
  BORDERLINE: {
    border: "border-amber-200 bg-amber-50",
    badge: "bg-amber-100 text-amber-800",
    label: "Đạt mức tối thiểu",
  },
  SHORT: {
    border: "border-red-200 bg-red-50",
    badge: "bg-red-100 text-red-800",
    label: "Chưa đủ tiền",
  },
  UNKNOWN: {
    border: "border-neutral-200 bg-neutral-50",
    badge: "bg-neutral-200 text-neutral-700",
    label: "Chưa có số dư",
  },
};

export function SavingsCard({ caseId, threshold, savings, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNote, setShowNote] = useState(false);

  const style = VERDICT_STYLE[savings.verdict];
  const hasRange = threshold.minVND !== threshold.maxVND;

  async function call(path: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/cases/${caseId}${path}`, init);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || `Lỗi máy chủ (HTTP ${res.status})`);
      }
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không gọi được máy chủ.");
    } finally {
      setBusy(false);
    }
  }

  const saveManual = (value: number | null) =>
    call("/savings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manualVnd: value }),
    });

  return (
    <div className={`rounded-2xl border-2 p-5 ${style.border}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-neutral-800">Chứng minh tài chính</h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Mức yêu cầu tính theo tình trạng hôn nhân và số con của hồ sơ này.
          </p>
        </div>
        <span className={`text-xs font-bold px-3 py-1.5 rounded-full ${style.badge}`}>
          {style.label}
        </span>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <div>
          <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">
            Cần có
          </div>
          <div className="text-2xl font-bold text-neutral-800 mt-1">
            {hasRange
              ? `${formatShortVnd(threshold.minVND)} – ${formatShortVnd(threshold.maxVND)}`
              : formatShortVnd(threshold.minVND)}
          </div>
          <div className="text-xs text-neutral-500 mt-0.5">
            {hasRange
              ? `${formatVnd(threshold.minVND)} – ${formatVnd(threshold.maxVND)}`
              : formatVnd(threshold.minVND)}
          </div>
          {threshold.isEstimated && (
            <div className="text-xs text-amber-700 mt-1.5">
              ⚠ Mức ước tính — checklist gốc không ghi rõ trường hợp này, cần xác nhận lại.
            </div>
          )}
        </div>

        <div>
          <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">
            Khách đang có
          </div>

          {editing ? (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <input
                autoFocus
                inputMode="numeric"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="vd 400000000"
                className="w-44 px-3 py-1.5 rounded-lg border-2 border-neutral-300 focus:border-indigo-500 outline-none text-sm font-semibold"
              />
              <button
                disabled={busy}
                onClick={() => saveManual(parseVndInput(draft))}
                className="text-xs font-semibold px-3 py-1.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                Lưu
              </button>
              <button
                disabled={busy}
                onClick={() => setEditing(false)}
                className="text-xs font-semibold px-3 py-1.5 rounded-full bg-neutral-200 text-neutral-700 hover:bg-neutral-300 disabled:opacity-50 transition-colors"
              >
                Huỷ
              </button>
            </div>
          ) : (
            <>
              <div className="text-2xl font-bold text-neutral-800 mt-1">
                {savings.effectiveVnd === null ? (
                  <span className="text-neutral-400">Chưa có</span>
                ) : (
                  formatShortVnd(savings.effectiveVnd)
                )}
              </div>
              <div className="text-xs text-neutral-500 mt-0.5">
                {savings.effectiveVnd === null
                  ? "Chưa đọc được số dư từ giấy tờ đã nộp."
                  : formatVnd(savings.effectiveVnd)}
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-xs text-neutral-500">
                  {savings.source === "MANUAL"
                    ? "✎ Nhân viên nhập tay"
                    : savings.source === "AI"
                      ? "AI đọc từ giấy tờ"
                      : ""}
                </span>
                <button
                  disabled={busy}
                  onClick={() => {
                    setDraft(savings.manualVnd != null ? String(savings.manualVnd) : "");
                    setEditing(true);
                  }}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  Sửa
                </button>
                {savings.manualVnd !== null && (
                  <button
                    disabled={busy}
                    onClick={() => saveManual(null)}
                    className="text-xs font-semibold text-neutral-500 hover:text-neutral-700 disabled:opacity-50"
                    title="Xoá số nhập tay, quay lại dùng số AI đọc được"
                  >
                    Dùng lại số AI
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {savings.verdict === "SHORT" && (
        <div className="mt-4 text-sm font-semibold text-red-800">
          {`Còn thiếu ${formatVnd(savings.shortOfMinVnd)} so với mức tối thiểu` +
            (hasRange && savings.shortOfMaxVnd > savings.shortOfMinVnd
              ? ` (thiếu ${formatVnd(savings.shortOfMaxVnd)} so với mức an toàn)`
              : "") +
            "."}
        </div>
      )}
      {savings.verdict === "BORDERLINE" && (
        <div className="mt-4 text-sm font-semibold text-amber-800">
          Đã qua mức tối thiểu, nhưng còn thiếu {formatVnd(savings.shortOfMaxVnd)} nữa mới tới
          mức {formatVnd(threshold.maxVND)} mà checklist khuyên nên có.
        </div>
      )}

      {/* Số AI đọc mà khác số nhân viên nhập thì phải nói rõ — nếu không, nhân viên tưởng con
          số đang hiển thị là do AI đọc ra, trong khi thật ra AI đọc ra số khác hẳn. */}
      {savings.source === "MANUAL" && savings.aiVnd !== null && savings.aiVnd !== savings.manualVnd && (
        <div className="mt-2 text-xs text-neutral-500">
          AI đọc được {formatVnd(savings.aiVnd)} — đang dùng số nhân viên nhập thay thế.
        </div>
      )}

      <div className="flex items-center gap-3 mt-4 flex-wrap">
        <button
          disabled={busy}
          onClick={() => call("/savings/detect", { method: "POST" })}
          className="text-xs font-semibold px-3 py-1.5 rounded-full bg-white border-2 border-neutral-300 text-neutral-700 hover:border-indigo-400 hover:text-indigo-700 disabled:opacity-50 transition-colors"
        >
          {busy ? "Đang đọc..." : "Đọc lại số dư từ giấy tờ"}
        </button>
        {savings.aiNote && (
          <button
            onClick={() => setShowNote((v) => !v)}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
          >
            {showNote ? "Ẩn chi tiết AI đọc" : "Xem chi tiết AI đọc"}
          </button>
        )}
      </div>

      {showNote && savings.aiNote && (
        <pre className="mt-3 text-xs text-neutral-700 whitespace-pre-wrap bg-white/70 rounded-lg p-3 border border-neutral-200">
          {savings.aiNote}
        </pre>
      )}

      {error && <div className="mt-3 text-sm font-semibold text-red-700">{error}</div>}
    </div>
  );
}
