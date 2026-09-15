"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/format";
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

export function NewCaseForm() {
  const router = useRouter();
  const [clientName, setClientName] = useState("");
  const [maritalStatus, setMaritalStatus] = useState<"SINGLE" | "MARRIED">("SINGLE");
  const [numberOfChildren, setNumberOfChildren] = useState(0);
  const [skillLevel, setSkillLevel] = useState<"LOW_SKILL" | "HIGH_SKILL">("LOW_SKILL");
  const [partner, setPartner] = useState("");
  const [occupation, setOccupation] = useState("");
  const [experienceValue, setExperienceValue] = useState("");
  const [experienceUnit, setExperienceUnit] = useState<"YEAR" | "MONTH">("YEAR");
  const [notes, setNotes] = useState("");
  // Gợi ý sinh từ dữ liệu đã nhập. Không có bảng riêng cho đối tác/nghề nghiệp, nên đây là
  // thứ duy nhất kéo mọi người gõ giống nhau thay vì đẻ ra "Xây dựng" / "xay dung" / "XD".
  const [partnerSuggestions, setPartnerSuggestions] = useState<string[]>([]);
  const [occupationSuggestions, setOccupationSuggestions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Gợi ý hỏng thì ô vẫn gõ tay được bình thường — không báo lỗi, không chặn tạo hồ sơ.
    const nap = (duong: string, set: (v: string[]) => void) =>
      fetch(`${API_URL}/cases/${duong}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(set)
        .catch(() => {});
    nap("partners", setPartnerSuggestions);
    nap("occupations", setOccupationSuggestions);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/cases`, {
        method: "POST",
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
        }),
      });

      if (!res.ok) {
        setError("Không tạo được hồ sơ. Kiểm tra lại thông tin.");
        return;
      }

      const created = await res.json();
      router.push(`/cases/${created.id}`);
    } catch {
      setError("Không kết nối được máy chủ. Vui lòng thử lại.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="overflow-hidden rounded-3xl border border-violet-100 bg-white shadow-sm"
    >
      {/* Dải pastel đầu form — thay cho tiêu đề chữ trơn, để form có điểm bắt đầu rõ ràng. */}
      <div className="bg-gradient-to-r from-violet-100 via-sky-100 to-rose-100 px-7 py-5">
        <p className="text-lg font-bold text-neutral-800">Tạo hồ sơ mới</p>
        <p className="mt-0.5 text-sm text-neutral-600">
          Điền thông tin khách hàng để hệ thống dựng đúng checklist tương ứng.
        </p>
      </div>

      <div className="flex flex-col gap-5 p-7">
        {/* ── Nhóm 1: khách hàng ─────────────────────────────────────────────────── */}
        <section className={`${FORM_SECTION} ${FORM_SECTION_VIOLET}`}>
          <p className={FORM_SECTION_TITLE}>
            <span aria-hidden="true">👤</span> Thông tin khách hàng
          </p>

          <div className="flex flex-col gap-5">
            <div>
              <label className={FORM_LABEL} htmlFor="ten-khach-hang">
                Tên khách hàng
              </label>
              <input
                id="ten-khach-hang"
                required
                maxLength={191}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                className={FORM_INPUT}
                placeholder="Nguyễn Văn A"
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
                      name="tinh-trang-hon-nhan"
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
              <label className={FORM_LABEL} htmlFor="so-con">
                Số con
              </label>
              <input
                id="so-con"
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

        {/* ── Nhóm 2: nghề nghiệp & kinh nghiệm ──────────────────────────────────── */}
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
                      name="trinh-do-ky-nang"
                      className="sr-only"
                      checked={skillLevel === value}
                      onChange={() => setSkillLevel(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className={FORM_HINT}>Quyết định checklist giấy tờ nào được áp dụng.</p>
            </div>

            <div>
              <label className={FORM_LABEL} htmlFor="nghe-nghiep">
                Nghề nghiệp <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
              </label>
              <input
                id="nghe-nghiep"
                list="goi-y-nghe-nghiep"
                maxLength={191}
                value={occupation}
                onChange={(e) => setOccupation(e.target.value)}
                className={FORM_INPUT}
                placeholder="Ví dụ: Xây dựng, Chế biến hải sản"
              />
              <datalist id="goi-y-nghe-nghiep">
                {occupationSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>

            <div>
              <label className={FORM_LABEL} htmlFor="kinh-nghiem">
                Thời gian làm việc{" "}
                <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
              </label>
              {/* Nhập theo năm HOẶC tháng tuỳ nhân viên; backend luôn lưu quy về tháng. */}
              <div className="flex gap-2">
                <input
                  id="kinh-nghiem"
                  type="number"
                  min={0}
                  step={1}
                  value={experienceValue}
                  onChange={(e) => setExperienceValue(e.target.value)}
                  className={`${FORM_INPUT} w-32`}
                  placeholder="0"
                />
                <select
                  aria-label="Đơn vị thời gian làm việc"
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

        {/* ── Nhóm 3: nguồn & ghi chú ────────────────────────────────────────────── */}
        <section className={`${FORM_SECTION} ${FORM_SECTION_ROSE}`}>
          <p className={FORM_SECTION_TITLE}>
            <span aria-hidden="true">🏢</span> Nguồn &amp; ghi chú
          </p>

          <div className="flex flex-col gap-5">
            <div>
              <label className={FORM_LABEL} htmlFor="doi-tac">
                Đối tác / nguồn <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
              </label>
              <input
                id="doi-tac"
                list="goi-y-doi-tac"
                maxLength={191}
                value={partner}
                onChange={(e) => setPartner(e.target.value)}
                className={FORM_INPUT}
                placeholder="Ví dụ: Ms. Thanh"
              />
              <datalist id="goi-y-doi-tac">
                {partnerSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <p className={FORM_HINT}>
                Dùng để phân biệt khi hai đối tác có khách trùng tên, và để lọc hồ sơ theo nguồn.
              </p>
            </div>

            <div>
              <label className={FORM_LABEL} htmlFor="ghi-chu">
                Ghi chú <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
              </label>
              <textarea
                id="ghi-chu"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className={FORM_INPUT}
              />
            </div>
          </div>
        </section>

        {error && (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className={`${FORM_SUBMIT} self-start`}>
          {submitting ? "Đang tạo..." : "Tạo hồ sơ"}
        </button>
      </div>
    </form>
  );
}
