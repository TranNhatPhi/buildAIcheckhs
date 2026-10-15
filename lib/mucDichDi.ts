/** Mục đích đi của khách (Case.travelPurpose, 14/10/2026) — chỉ là thông tin hồ sơ, KHÔNG đổi checklist. */
export type MucDichDi = "WORK" | "TRAVEL";

export const MUC_DICH_DI: readonly (readonly [MucDichDi, string])[] = [
  ["WORK", "Làm việc"],
  ["TRAVEL", "Du lịch"],
];

export function nhanMucDichDi(v: string | null | undefined): string {
  return v === "TRAVEL" ? "Du lịch" : "Làm việc";
}
