import type { CaseListItemDTO } from "@/lib/client-types";

// Tiêu chí của từng thẻ thống kê ở trang tổng quan admin — khai MỘT chỗ, dùng cho cả con số
// trên thẻ (AdminDashboard) lẫn bộ lọc của trang thống kê hồ sơ (AdminCaseReport). Hai nơi tự
// viết riêng thì sớm muộn sẽ lệch: bấm thẻ "Đã nộp: 5" mở ra bảng 6 dòng.
//
// Chỉ áp cho hồ sơ ĐANG HOẠT ĐỘNG — nơi gọi tự lọc bỏ hồ sơ đã xoá mềm trước.

// Đã có kết quả = Đậu, Rớt, hoặc đã Thanh lý (bước khép lại sau khi rớt).
const coKetQua = (c: CaseListItemDTO) =>
  c.applicationStatus === "APPROVED" ||
  c.applicationStatus === "REJECTED" ||
  c.applicationStatus === "LIQUIDATED";

export const BO_LOC_HO_SO = {
  tatCa: { nhan: "Tất cả hồ sơ", dat: () => true },
  // "Đã nộp" = mọi hồ sơ ĐÃ nộp đi, kể cả đã có kết quả; "Đang xử lý" = đã nộp, đang chờ kết quả.
  daNop: {
    nhan: "Hồ sơ đã nộp",
    dat: (c) => c.applicationStatus === "SUBMITTED" || coKetQua(c),
  },
  // Theo TRẠNG THÁI "Hoàn thành" chứ không theo % giấy tờ: thẻ tên "Hồ sơ hoàn thành" nằm cạnh
  // ô chọn trạng thái cũng tên "Hoàn thành" — hai con số khác nhau là người xem hiểu lầm ngay.
  hoanThanh: { nhan: "Hồ sơ hoàn thành", dat: (c) => c.applicationStatus === "COMPLETED" },
  // Theo trạng thái cùng tên "Đang xử lý" — thẻ và ô chọn trùng tên thì phải đếm cùng một thứ.
  dangXuLy: { nhan: "Hồ sơ đang xử lý", dat: (c) => c.applicationStatus === "SUBMITTED" },
  dau: { nhan: "Hồ sơ được chấp thuận (đậu)", dat: (c) => c.applicationStatus === "APPROVED" },
  // Rớt và Thanh lý là HAI thẻ riêng, không đếm trùng: Đã nộp = Đang xử lý + Đậu + Rớt + Thanh lý.
  rot: { nhan: "Hồ sơ không thành công (rớt)", dat: (c) => c.applicationStatus === "REJECTED" },
  thanhLy: { nhan: "Hồ sơ thanh lý", dat: (c) => c.applicationStatus === "LIQUIDATED" },
  nhacDaNop: {
    nhan: "Cần nhắc kiểm tra trạng thái (đang xử lý)",
    dat: (c) => c.applicationStatus === "SUBMITTED" && c.statusReminderDue,
  },
  chuaKetQua: { nhan: "Chưa có kết quả", dat: (c) => !coKetQua(c) },
  // Cùng quy tắc với chuông Docs — backend tính sẵn idleDays (thong_bao.ngay_chua_cap_nhat).
  chuaCapNhat: { nhan: "7 ngày chưa cập nhật hồ sơ", dat: (c) => c.idleDays != null },
  nopLan2: { nhan: "Hồ sơ nộp lần 2", dat: (c) => (c.submissionRound ?? 1) >= 2 },
  // Thẻ giấy tờ trên trang tổng quan đếm SỐ GIẤY TỜ; bộ lọc ở đây lọc HỒ SƠ có giấy tờ đó. "hetHan"
  // không còn thẻ riêng (chỗ đó giờ là "Hồ sơ thanh lý") nhưng vẫn là một bộ lọc ở trang Thống kê.
  hetHan: { nhan: "Có giấy tờ đã hết hạn", dat: (c) => c.expiredDocCount > 0 },
  sapHetHan: { nhan: "Có giấy tờ sắp hết hạn", dat: (c) => c.expiringSoonDocCount > 0 },
} as const satisfies Record<string, { nhan: string; dat: (c: CaseListItemDTO) => boolean }>;

export type KhoaLoc = keyof typeof BO_LOC_HO_SO;

export function laKhoaLoc(v: string | null): v is KhoaLoc {
  return v !== null && v in BO_LOC_HO_SO;
}
