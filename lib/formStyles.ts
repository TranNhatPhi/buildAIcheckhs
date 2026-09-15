/**
 * Lớp CSS dùng chung cho form tạo & sửa hồ sơ.
 *
 * Gom về một chỗ vì hai form đó hiển thị gần như cùng một bộ trường — trước đây mỗi form tự
 * chép chuỗi class riêng, sửa một bên là lệch ngay bên kia.
 *
 * Tông màu: pastel (violet/rose/sky nhạt) theo yêu cầu "dịu dịu" của khách. Chữ vẫn để
 * neutral-800 trên nền rất nhạt để giữ đủ tương phản — pastel là ở NỀN, không phải ở CHỮ.
 */

export const FORM_LABEL = "mb-2 block text-sm font-semibold text-neutral-700";

export const FORM_HINT = "mt-1.5 text-xs text-neutral-400";

/** Ô nhập: nền pastel rất nhạt, khi focus thì sáng lên trắng + viền đậm hơn. */
export const FORM_INPUT =
  "w-full rounded-xl border border-violet-100 bg-violet-50/40 px-4 py-2.5 text-sm text-neutral-800 " +
  "placeholder:text-neutral-400 outline-none transition " +
  "focus:border-violet-300 focus:bg-white focus:ring-4 focus:ring-violet-100";

/** Nút chọn dạng viên thuốc — trạng thái BẬT. */
export const FORM_PILL_ON =
  "border-violet-300 bg-violet-100 text-violet-800 shadow-sm";

/** Trạng thái TẮT. Giữ viền rõ để vẫn thấy đây là nút bấm được, không phải chữ suông. */
export const FORM_PILL_OFF =
  "border-neutral-200 bg-white text-neutral-500 hover:border-violet-200 hover:bg-violet-50/50";

export const FORM_PILL_BASE =
  "flex cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors";

/** Khối nhóm các trường liên quan, mỗi nhóm một sắc pastel khác nhau để mắt bám nhóm. */
export const FORM_SECTION = "rounded-2xl border p-5";
export const FORM_SECTION_VIOLET = "border-violet-100 bg-violet-50/40";
export const FORM_SECTION_SKY = "border-sky-100 bg-sky-50/40";
export const FORM_SECTION_ROSE = "border-rose-100 bg-rose-50/30";

export const FORM_SECTION_TITLE =
  "mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-neutral-500";

/** Nút gửi form. */
export const FORM_SUBMIT =
  "rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 px-7 py-3 text-sm font-semibold " +
  "text-white shadow-sm transition hover:from-violet-600 hover:to-indigo-600 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** Đơn vị kinh nghiệm — dùng chung để hai form không lệch nhau. */
export const EXPERIENCE_UNITS = [
  { value: "YEAR", label: "năm" },
  { value: "MONTH", label: "tháng" },
] as const;

/** Đổi (số, đơn vị) người dùng nhập thành SỐ THÁNG để gửi lên API. */
export function toExperienceMonths(value: string, unit: "YEAR" | "MONTH"): number | null {
  const n = Number(value.trim());
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) return null;
  return unit === "YEAR" ? Math.round(n * 12) : Math.round(n);
}
