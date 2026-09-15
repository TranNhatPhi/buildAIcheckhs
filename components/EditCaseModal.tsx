"use client";

import { useEffect, useMemo, useState } from "react";
import { API_URL, splitExperience } from "@/lib/format";
import {
  EXPERIENCE_UNITS,
  FORM_HINT,
  FORM_INPUT,
  FORM_LABEL,
  FORM_PILL_BASE,
  FORM_PILL_OFF,
  FORM_PILL_ON,
  FORM_SECTION,
  FORM_SECTION_ROSE,
  FORM_SECTION_SKY,
  FORM_SECTION_TITLE,
  FORM_SECTION_VIOLET,
  FORM_SUBMIT,
  toExperienceMonths,
} from "@/lib/formStyles";
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
  const [partner, setPartner] = useState(caseItem.partner ?? "");
  const [partnerSuggestions, setPartnerSuggestions] = useState<string[]>([]);
  const [occupation, setOccupation] = useState(caseItem.occupation ?? "");
  const [occupationSuggestions, setOccupationSuggestions] = useState<string[]>([]);
  // Tách số tháng đã lưu ngược lại thành (số, đơn vị) để form mở ra đúng như lúc nhập.
  const [experienceValue, setExperienceValue] = useState(
    () => splitExperience(caseItem.experienceMonths).value,
  );
  const [experienceUnit, setExperienceUnit] = useState<"YEAR" | "MONTH">(
    () => splitExperience(caseItem.experienceMonths).unit,
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
    // Gợi ý đối tác/nghề nghiệp đã có, để sửa hồ sơ cũ cũng gõ ra đúng tên như lúc tạo.
    const nap = (duong: string, set: (v: string[]) => void) =>
      fetch(`${API_URL}/cases/${duong}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(set)
        .catch(() => {});
    nap("partners", setPartnerSuggestions);
    nap("occupations", setOccupationSuggestions);
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
          partner,
          occupation,
          experienceMonths: toExperienceMonths(experienceValue, experienceUnit),
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
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-violet-100 bg-white shadow-xl"
      >
        {/* Dải pastel dính đỉnh khi cuộn — modal khá dài, cuộn giữa chừng mà không còn tiêu
            đề thì dễ quên mình đang sửa hồ sơ nào. */}
        <div className="sticky top-0 z-10 bg-gradient-to-r from-violet-100 via-sky-100 to-rose-100 px-7 py-5">
          <p className="text-lg font-bold text-neutral-800">Sửa hồ sơ</p>
          <p className="mt-0.5 truncate text-sm text-neutral-600">{caseItem.clientName}</p>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto p-7">
          <div>
            <label className={FORM_LABEL} htmlFor="trang-thai-ho-so">
              Trạng thái hồ sơ
            </label>
            <select
              id="trang-thai-ho-so"
              value={applicationStatus}
              onChange={(e) => setApplicationStatus(e.target.value as ApplicationStatus)}
              className={`w-full rounded-xl border px-4 py-2.5 text-sm font-semibold outline-none transition focus:ring-4 focus:ring-violet-100 ${APPLICATION_STATUS_BADGE_CLASS[applicationStatus]}`}
            >
              {APPLICATION_STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
            <p className={FORM_HINT}>
              Hồ sơ chưa đậu hoặc rớt sẽ được tính mốc nhắc admin sau mỗi 14 ngày.
            </p>
          </div>

          {/* ── Nhóm 1: khách hàng ───────────────────────────────────────────────── */}
          <section className={`${FORM_SECTION} ${FORM_SECTION_VIOLET}`}>
            <p className={FORM_SECTION_TITLE}>
              <span aria-hidden="true">👤</span> Thông tin khách hàng
            </p>

            <div className="flex flex-col gap-5">
              <div>
                <label className={FORM_LABEL} htmlFor="sua-ten-khach-hang">
                  Tên khách hàng
                </label>
                <input
                  id="sua-ten-khach-hang"
                  required
                  maxLength={191}
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className={FORM_INPUT}
                />
              </div>

              <div>
                <span className={FORM_LABEL}>Tình trạng hôn nhân</span>
                <div className="flex flex-wrap gap-3">
                  {(
                    [
                      ["SINGLE", "Độc thân"],
                      ["MARRIED", "Đã kết hôn"],
                    ] as const
                  ).map(([value, label]) => (
                    <label
                      key={value}
                      className={`${FORM_PILL_BASE} ${
                        maritalStatus === value ? FORM_PILL_ON : FORM_PILL_OFF
                      }`}
                    >
                      <input
                        type="radio"
                        name="sua-tinh-trang-hon-nhan"
                        className="sr-only"
                        checked={maritalStatus === value}
                        onChange={() => setMaritalStatus(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className={FORM_LABEL} htmlFor="sua-so-con">
                  Số con
                </label>
                <input
                  id="sua-so-con"
                  type="number"
                  min={0}
                  max={20}
                  value={numberOfChildren}
                  onChange={(e) => setNumberOfChildren(Number(e.target.value))}
                  className={`${FORM_INPUT} w-32`}
                />
              </div>
            </div>
          </section>

          {/* ── Nhóm 2: nghề nghiệp & kinh nghiệm ────────────────────────────────── */}
          <section className={`${FORM_SECTION} ${FORM_SECTION_SKY}`}>
            <p className={FORM_SECTION_TITLE}>
              <span aria-hidden="true">💼</span> Nghề nghiệp &amp; kinh nghiệm
            </p>

            <div className="flex flex-col gap-5">
              <div>
                <span className={FORM_LABEL}>Trình độ kỹ năng (skill)</span>
                <div className="flex flex-wrap gap-3">
                  {(
                    [
                      ["LOW_SKILL", "Low Skilled"],
                      ["HIGH_SKILL", "High Skilled"],
                    ] as const
                  ).map(([value, label]) => (
                    <label
                      key={value}
                      className={`${FORM_PILL_BASE} ${
                        skillLevel === value ? FORM_PILL_ON : FORM_PILL_OFF
                      }`}
                    >
                      <input
                        type="radio"
                        name="sua-trinh-do-ky-nang"
                        className="sr-only"
                        checked={skillLevel === value}
                        onChange={() => setSkillLevel(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className={FORM_LABEL} htmlFor="sua-nghe-nghiep">
                  Nghề nghiệp <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
                </label>
                <input
                  id="sua-nghe-nghiep"
                  list="goi-y-nghe-nghiep-sua"
                  maxLength={191}
                  value={occupation}
                  onChange={(e) => setOccupation(e.target.value)}
                  className={FORM_INPUT}
                  placeholder="Ví dụ: Xây dựng, Chế biến hải sản"
                />
                <datalist id="goi-y-nghe-nghiep-sua">
                  {occupationSuggestions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>

              <div>
                <label className={FORM_LABEL} htmlFor="sua-kinh-nghiem">
                  Kinh nghiệm làm việc{" "}
                  <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    id="sua-kinh-nghiem"
                    type="number"
                    min={0}
                    step={1}
                    value={experienceValue}
                    onChange={(e) => setExperienceValue(e.target.value)}
                    className={`${FORM_INPUT} w-32`}
                    placeholder="0"
                  />
                  <select
                    aria-label="Đơn vị kinh nghiệm"
                    value={experienceUnit}
                    onChange={(e) => setExperienceUnit(e.target.value as "YEAR" | "MONTH")}
                    className={`${FORM_INPUT} w-28`}
                  >
                    {EXPERIENCE_UNITS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className={FORM_HINT}>Ghi số năm hoặc số tháng, chọn đơn vị tương ứng.</p>
              </div>
            </div>
          </section>

          {/* ── Nhóm 3: nguồn & ghi chú ──────────────────────────────────────────── */}
          <section className={`${FORM_SECTION} ${FORM_SECTION_ROSE}`}>
            <p className={FORM_SECTION_TITLE}>
              <span aria-hidden="true">🏢</span> Nguồn &amp; ghi chú
            </p>

            <div className="flex flex-col gap-5">
              <div>
                <label className={FORM_LABEL} htmlFor="sua-doi-tac">
                  Đối tác / nguồn{" "}
                  <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
                </label>
                <input
                  id="sua-doi-tac"
                  list="goi-y-doi-tac-sua"
                  maxLength={191}
                  value={partner}
                  onChange={(e) => setPartner(e.target.value)}
                  className={FORM_INPUT}
                  placeholder="Ví dụ: Ms. Thanh"
                />
                {/* id khác datalist ở NewCaseForm: hai form có thể cùng nằm trên một trang,
                    trùng id thì trình duyệt chỉ dùng cái đầu tiên. */}
                <datalist id="goi-y-doi-tac-sua">
                  {partnerSuggestions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>

              <div>
                <label className={FORM_LABEL} htmlFor="sua-ghi-chu">
                  Ghi chú <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
                </label>
                <textarea
                  id="sua-ghi-chu"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className={FORM_INPUT}
                />
              </div>
            </div>
          </section>

          {tagDefs.length > 0 && (
            <div>
              <span className={FORM_LABEL}>Nhãn (tag)</span>
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

          {error && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
              {error}
            </p>
          )}
        </div>

        {/* Thanh nút dính đáy: modal dài, cuộn xuống giữa chừng vẫn bấm Lưu được ngay. */}
        <div className="flex justify-end gap-3 border-t border-violet-100 bg-white/80 px-7 py-4 backdrop-blur">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-5 py-2.5 text-sm font-semibold text-neutral-600 transition-colors hover:bg-neutral-100"
          >
            Huỷ
          </button>
          <button type="submit" disabled={submitting} className={FORM_SUBMIT}>
            {submitting ? "Đang lưu..." : "Lưu thay đổi"}
          </button>
        </div>
      </form>
    </div>
  );
}
