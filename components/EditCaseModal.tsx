"use client";

import { useEffect, useMemo, useState } from "react";
import { API_URL } from "@/lib/format";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_BADGE_CLASS,
} from "@/lib/application-status";
import type { ApplicationStatus, CaseListItemDTO, TagDefinition } from "@/lib/client-types";

/** Ánh xạ tên màu từ API sang Tailwind class. */
const TAG_COLOR_MAP: Record<string, string> = {
  red: "bg-red-100 text-red-800 border-red-200",
  yellow: "bg-amber-100 text-amber-800 border-amber-200",
  green: "bg-emerald-100 text-emerald-800 border-emerald-200",
  orange: "bg-orange-100 text-orange-800 border-orange-200",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
  gray: "bg-neutral-100 text-neutral-600 border-neutral-200",
  purple: "bg-purple-100 text-purple-800 border-purple-200",
};

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
  const [applicationStatus, setApplicationStatus] = useState<ApplicationStatus>(
    caseItem.applicationStatus,
  );
  const [selectedTags, setSelectedTags] = useState<string[]>(caseItem.tags ?? []);
  const [tagDefs, setTagDefs] = useState<TagDefinition[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/cases/tags`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: TagDefinition[]) => setTagDefs(data))
      .catch(() => {});
  }, []);

  const tagColorByName = useMemo(
    () => new Map(tagDefs.map((t) => [t.name, t.color])),
    [tagDefs],
  );

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/cases/${caseItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          maritalStatus,
          numberOfChildren,
          skillLevel,
          notes,
          applicationStatus,
        }),
      });

      if (!res.ok) {
        setError("Không lưu được thay đổi.");
        return;
      }

      // Lưu tag riêng — không gộp vào PATCH /cases/{id} vì endpoint đó dùng UpdateCaseRequest
      // không có field tags (tag là endpoint riêng PATCH /cases/{id}/tags).
      await fetch(`${API_URL}/cases/${caseItem.id}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: selectedTags }),
      });

      const saved = await res.json();
      // Gắn lại tag vào DTO trước khi trả về — vì PATCH /cases/{id} không trả tags mới nhất.
      saved.tags = selectedTags;
      onSaved(saved);
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
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col gap-5 overflow-y-auto rounded-2xl border-2 border-neutral-200 bg-white p-7 shadow-lg"
      >
        <h2 className="text-lg font-bold text-neutral-800">Sửa hồ sơ</h2>

        <div>
          <label className="block text-sm font-semibold mb-1.5">Trạng thái hồ sơ</label>
          <select
            value={applicationStatus}
            onChange={(e) => setApplicationStatus(e.target.value as ApplicationStatus)}
            className={`w-full rounded-xl border-2 px-4 py-2.5 text-sm outline-none transition-colors focus:border-indigo-400 ${APPLICATION_STATUS_BADGE_CLASS[applicationStatus]}`}
          >
            {APPLICATION_STATUSES.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-neutral-500">
            Hồ sơ chưa đậu hoặc rớt sẽ được tính mốc nhắc admin sau mỗi 14 ngày.
          </p>
        </div>

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

        {tagDefs.length > 0 && (
          <div>
            <label className="block text-sm font-semibold mb-1.5">Nhãn (tag)</label>
            <div className="flex flex-wrap gap-2">
              {tagDefs.map((t) => {
                const active = selectedTags.includes(t.name);
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => toggleTag(t.name)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition-all ${
                      active
                        ? TAG_COLOR_MAP[tagColorByName.get(t.name) ?? ""] ?? TAG_COLOR_MAP.gray
                        : "border-neutral-200 text-neutral-400 hover:border-neutral-300"
                    }`}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
