"use client";

import { useState } from "react";
import { API_URL } from "@/lib/format";
import type { CaseListItemDTO } from "@/lib/client-types";

interface Props {
  caseItem: CaseListItemDTO;
  onClose: () => void;
  onSaved: (updated: CaseListItemDTO) => void;
}

export function EditCaseModal({ caseItem, onClose, onSaved }: Props) {
  const [clientName, setClientName] = useState(caseItem.clientName);
  const [maritalStatus, setMaritalStatus] = useState<"SINGLE" | "MARRIED">(
    caseItem.maritalStatus as "SINGLE" | "MARRIED",
  );
  const [numberOfChildren, setNumberOfChildren] = useState(caseItem.numberOfChildren);
  const [skillLevel, setSkillLevel] = useState<"LOW_SKILL" | "HIGH_SKILL">(
    caseItem.skillLevel as "LOW_SKILL" | "HIGH_SKILL",
  );
  const [notes, setNotes] = useState(caseItem.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/cases/${caseItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName, maritalStatus, numberOfChildren, skillLevel, notes }),
      });

      if (!res.ok) {
        setError("Không lưu được thay đổi.");
        return;
      }

      onSaved(await res.json());
    } catch {
      setError("Không kết nối được máy chủ. Vui lòng thử lại.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col gap-5 bg-white border-2 border-neutral-200 rounded-2xl p-7 shadow-lg w-full max-w-md"
      >
        <h2 className="text-lg font-bold text-neutral-800">Sửa hồ sơ</h2>

        <div>
          <label className="block text-sm font-semibold mb-1.5">Tên khách hàng</label>
          <input
            required
            maxLength={191}
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            className="w-full border-2 border-neutral-200 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1.5">Tình trạng hôn nhân</label>
          <div className="flex gap-3">
            <label
              className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
                maritalStatus === "SINGLE"
                  ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                  : "border-neutral-200 text-neutral-500"
              }`}
            >
              <input
                type="radio"
                className="hidden"
                checked={maritalStatus === "SINGLE"}
                onChange={() => setMaritalStatus("SINGLE")}
              />
              Độc thân
            </label>
            <label
              className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
                maritalStatus === "MARRIED"
                  ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                  : "border-neutral-200 text-neutral-500"
              }`}
            >
              <input
                type="radio"
                className="hidden"
                checked={maritalStatus === "MARRIED"}
                onChange={() => setMaritalStatus("MARRIED")}
              />
              Đã kết hôn
            </label>
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1.5">Trình độ kỹ năng (skill)</label>
          <div className="flex gap-3">
            <label
              className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
                skillLevel === "LOW_SKILL"
                  ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                  : "border-neutral-200 text-neutral-500"
              }`}
            >
              <input
                type="radio"
                className="hidden"
                checked={skillLevel === "LOW_SKILL"}
                onChange={() => setSkillLevel("LOW_SKILL")}
              />
              Low Skilled
            </label>
            <label
              className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
                skillLevel === "HIGH_SKILL"
                  ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                  : "border-neutral-200 text-neutral-500"
              }`}
            >
              <input
                type="radio"
                className="hidden"
                checked={skillLevel === "HIGH_SKILL"}
                onChange={() => setSkillLevel("HIGH_SKILL")}
              />
              High Skilled
            </label>
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1.5">Số con</label>
          <input
            type="number"
            min={0}
            max={20}
            value={numberOfChildren}
            onChange={(e) => setNumberOfChildren(Number(e.target.value))}
            className="w-32 border-2 border-neutral-200 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1.5">Ghi chú (tuỳ chọn)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full border-2 border-neutral-200 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none transition-colors"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-full text-sm font-semibold text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            Huỷ
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="bg-indigo-600 text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 shadow-sm transition-colors"
          >
            {submitting ? "Đang lưu..." : "Lưu thay đổi"}
          </button>
        </div>
      </form>
    </div>
  );
}
