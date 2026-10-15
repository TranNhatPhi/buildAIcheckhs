import type { ApplicationStatus } from "@/lib/client-types";

export interface ApplicationStatusDefinition {
  value: ApplicationStatus;
  label: string;
  description: string;
}

// Thứ tự phản ánh luồng xử lý — khớp CASE_STATUS_DEFINITIONS ở backend/case_status.py.
// 4 bước đầu là phần nhân viên (trang checklist), 4 bước sau là phần admin (trang quản trị).
// Giữ MÃ cũ dù đổi tên hiển thị (SUBMITTED: "Đã nộp" -> "Đang xử lý" -> 12/10/2026 "CP đang xử lý",
// CP = Chính phủ đang xét): mã nằm trong
// DB và nhật ký email.
export const APPLICATION_STATUSES: readonly ApplicationStatusDefinition[] = [
  { value: "PENDING", label: "Chờ tiếp nhận", description: "Hồ sơ mới, chưa bắt đầu xử lý" },
  {
    value: "COLLECTING_DOCUMENTS",
    label: "Đang thu thập giấy tờ",
    // Đã gộp "Đang kiểm tra hồ sơ" vào trạng thái này (13/10/2026).
    description: "Đang nhận và kiểm tra giấy tờ của khách hàng",
  },
  {
    value: "COMPLETED",
    label: "Hoàn thành",
    description: "Đủ 100% giấy tờ bắt buộc (tự chuyển) — bàn giao cho admin",
  },
  { value: "READY_TO_SUBMIT", label: "Sẵn sàng nộp", description: "Admin đã nhận hồ sơ, chuẩn bị nộp" },
  { value: "SUBMITTED", label: "CP đang xử lý", description: "Đã nộp, Chính phủ đang xét duyệt — chờ trả kết quả" },
  { value: "APPROVED", label: "Được chấp thuận", description: "Hồ sơ được chấp thuận" },
  { value: "REJECTED", label: "Không thành công", description: "Hồ sơ không được chấp thuận" },
  {
    value: "LIQUIDATED",
    label: "Thanh lý hồ sơ",
    description: "Khép hồ sơ sau khi không thành công — chỉ chuyển được từ Không thành công",
  },
] as const;

export const FINAL_APPLICATION_STATUSES = new Set<ApplicationStatus>(["APPROVED", "REJECTED", "LIQUIDATED"]);

export const APPLICATION_STATUS_BADGE_CLASS: Record<ApplicationStatus, string> = {
  PENDING: "border-neutral-200 bg-neutral-100 text-neutral-700",
  COLLECTING_DOCUMENTS: "border-amber-200 bg-amber-100 text-amber-800",
  COMPLETED: "border-teal-200 bg-teal-100 text-teal-800",
  READY_TO_SUBMIT: "border-sky-200 bg-sky-100 text-sky-800",
  SUBMITTED: "border-blue-200 bg-blue-100 text-blue-800",
  APPROVED: "border-emerald-200 bg-emerald-100 text-emerald-800",
  REJECTED: "border-red-200 bg-red-100 text-red-800",
  LIQUIDATED: "border-slate-300 bg-slate-200 text-slate-700",
};

// Bảng màu hex dùng cho khu vực admin (component Tag nhận màu trực tiếp). Mỗi trạng thái
// có một màu riêng, đồng bộ về sắc độ với badge Tailwind phía giao diện nhân viên.
export const APPLICATION_STATUS_HEX_COLOR: Record<ApplicationStatus, string> = {
  PENDING: "#6B7280",
  COLLECTING_DOCUMENTS: "#D97706",
  COMPLETED: "#0D9488",
  READY_TO_SUBMIT: "#0284C7",
  SUBMITTED: "#2563EB",
  APPROVED: "#059669",
  REJECTED: "#DC2626",
  LIQUIDATED: "#475569",
};

const STATUS_BY_VALUE = new Map(APPLICATION_STATUSES.map((status) => [status.value, status]));

export function getApplicationStatus(value: ApplicationStatus): ApplicationStatusDefinition {
  return STATUS_BY_VALUE.get(value) ?? APPLICATION_STATUSES[0];
}

// Chia quyền theo GIAI ĐOẠN — khớp STAFF_STATUSES/ADMIN_STATUSES ở backend/case_status.py.
// "Hoàn thành" là điểm bàn giao: nhân viên đưa hồ sơ tới đó, admin nhận từ đó.
export const STAFF_STATUSES: readonly ApplicationStatus[] = [
  "PENDING", "COLLECTING_DOCUMENTS", "COMPLETED",
];
export const ADMIN_STATUSES: readonly ApplicationStatus[] = [
  "READY_TO_SUBMIT", "SUBMITTED", "APPROVED", "REJECTED", "LIQUIDATED",
];

// "Nộp lại lần N" là THAO TÁC (POST /cases/{id}/resubmit), không phải trạng thái lưu trong DB.
// Khớp RESUBMIT_FROM_STATUSES ở backend.
// 15/10/2026: CHỈ sau khi rớt (CP đang xử lý -> Đậu / Rớt; Rớt -> Thanh lý / Nộp lại).
export const RESUBMIT_FROM_STATUSES: readonly ApplicationStatus[] = ["REJECTED"];
// Chỉ được nộp lại MỘT lần — khớp MAX_SUBMISSION_ROUND ở backend. Không có lần nộp thứ 3.
export const MAX_SUBMISSION_ROUND = 2;
// Tiến độ <= mốc này là "Chờ tiếp nhận", trên mốc dưới 100% là "Đang thu thập giấy tờ", 100% là
// "Hoàn thành" — tự chuyển ở backend (case_auto_status). Khớp NGUONG_CHO_TIEP_NHAN ở case_status.py.
export const NGUONG_CHO_TIEP_NHAN = 20;

/** Nhân viên còn đổi được trạng thái không — hồ sơ đã sang phần admin thì khoá. */
export function staffCanEditStatus(hienTai: ApplicationStatus): boolean {
  return !ADMIN_STATUSES.includes(hienTai);
}

/**
 * Các trạng thái HIỆN trong ô chọn của từng bên — chỉ phần của mình, không hiện phần bên kia
 * rồi làm mờ (11 dòng mà một nửa bấm không được thì rối). Luôn kèm trạng thái hiện tại, không
 * thì <select> không có option nào khớp value và hiện sai.
 *
 * Admin thấy thêm "Hoàn thành" để TRẢ hồ sơ về khi lỡ nhận nhầm — xem lý do ở
 * ly_do_khong_chuyen_duoc (backend).
 */
export function statusOptionsFor(
  vaiTro: "staff" | "admin",
  hienTai: ApplicationStatus,
): readonly ApplicationStatusDefinition[] {
  // Admin luôn thấy ĐỦ các trạng thái — bước không hợp lệ (vd Sẵn sàng nộp chỉ sang CP đang xử lý; CP đang xử lý
  // chỉ sang Đậu / Rớt; Rớt chỉ sang Thanh lý) hiện MỜ kèm lý do qua statusChangeBlockedReason, không ẩn đi
  // (Docs yêu cầu 15/10/2026: thấy cả luồng, chỉ không chọn được).
  const cho = new Set<ApplicationStatus>(vaiTro === "staff" ? STAFF_STATUSES : ["COMPLETED", ...ADMIN_STATUSES]);
  cho.add(hienTai);
  return APPLICATION_STATUSES.filter((s) => cho.has(s.value));
}

/**
 * Lý do KHÔNG được chuyển sang trạng thái `den`; null = được phép. Dùng để làm mờ sẵn lựa chọn
 * không hợp lệ ở MỌI ô chọn trạng thái (bảng admin, trang hồ sơ, hộp sửa).
 *
 * Bản song sinh của ly_do_khong_chuyen_duoc ở backend/case_status.py — backend mới là nơi CHẶN
 * THẬT; hàm này chỉ để giao diện không cho bấm vào thứ chắc chắn bị từ chối. Sửa quy tắc thì sửa
 * CẢ HAI chỗ.
 */
export function statusChangeBlockedReason(
  den: ApplicationStatus,
  hienTai: ApplicationStatus,
  tienDo: number,
  laAdmin = false,
): string | null {
  if (den === hienTai) return null;
  if (hienTai === "READY_TO_SUBMIT" && den !== "SUBMITTED") {
    return "chỉ được chuyển sang CP đang xử lý";
  }
  if (hienTai === "SUBMITTED" && den !== "APPROVED" && den !== "REJECTED") return "chỉ sang Đậu hoặc Rớt";
  if (hienTai === "REJECTED" && den !== "LIQUIDATED") return "chỉ sang Thanh lý hoặc Nộp lại";
  if (!laAdmin) {
    if (ADMIN_STATUSES.includes(hienTai)) return "admin cập nhật";
    if (!STAFF_STATUSES.includes(den)) return "admin cập nhật";
  } else if (den === "COMPLETED") {
    if (!ADMIN_STATUSES.includes(hienTai)) return "nhân viên cập nhật";
  } else if (!ADMIN_STATUSES.includes(den)) {
    return "nhân viên cập nhật";
  }
  if (den === "PENDING" && tienDo > NGUONG_CHO_TIEP_NHAN) return `chỉ khi ≤${NGUONG_CHO_TIEP_NHAN}%, đang ${tienDo}%`;
  if (den === "COLLECTING_DOCUMENTS" && tienDo <= NGUONG_CHO_TIEP_NHAN) return `cần trên ${NGUONG_CHO_TIEP_NHAN}%, đang ${tienDo}%`;
  if (den === "COLLECTING_DOCUMENTS" && tienDo >= 100) return "đã đủ 100%";
  if (den === "COMPLETED" && tienDo < 100) return `cần đủ 100%, đang ${tienDo}%`;
  if (ADMIN_STATUSES.includes(den) && !ADMIN_STATUSES.includes(hienTai)) {
    if (hienTai !== "COMPLETED") return "phải Hoàn thành trước";
    if (den !== "READY_TO_SUBMIT") return "phải qua Sẵn sàng nộp trước";
  }
  if (den === "LIQUIDATED" && hienTai !== "REJECTED") return "chỉ từ Không thành công";
  if (hienTai === "LIQUIDATED" && den !== "REJECTED") return "đã thanh lý";
  return null;
}
