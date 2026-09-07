import type { ApplicationStatus } from "@/lib/client-types";

export interface ApplicationStatusDefinition {
  value: ApplicationStatus;
  label: string;
  description: string;
}

// Thứ tự phản ánh luồng xử lý thông thường. "Cần bổ sung giấy tờ" có thể quay lại nhiều
// lần sau khi đã nộp, nên giao diện cho phép nhân viên chọn linh hoạt thay vì khoá tuyến tính.
export const APPLICATION_STATUSES: readonly ApplicationStatusDefinition[] = [
  { value: "PENDING", label: "Chờ tiếp nhận", description: "Hồ sơ mới, chưa bắt đầu xử lý" },
  {
    value: "COLLECTING_DOCUMENTS",
    label: "Đang thu thập giấy tờ",
    description: "Đang nhận tài liệu từ khách hàng",
  },
  {
    value: "REVIEWING_DOCUMENTS",
    label: "Đang kiểm tra hồ sơ",
    description: "Đang kiểm tra tính đầy đủ và hợp lệ",
  },
  {
    value: "READY_TO_SUBMIT",
    label: "Sẵn sàng nộp",
    description: "Đã hoàn thiện và chờ nộp",
  },
  { value: "SUBMITTED", label: "Đã nộp", description: "Đã gửi hồ sơ đến cơ quan xét duyệt" },
  {
    value: "UNDER_REVIEW",
    label: "Đang xét duyệt",
    description: "Cơ quan tiếp nhận đang xử lý",
  },
  {
    value: "ADDITIONAL_DOCUMENTS_REQUIRED",
    label: "Cần bổ sung giấy tờ",
    description: "Có yêu cầu cung cấp thêm tài liệu",
  },
  {
    value: "AWAITING_DECISION",
    label: "Chờ kết quả",
    description: "Đã hoàn tất các yêu cầu và đang chờ quyết định",
  },
  { value: "APPROVED", label: "Đã đậu", description: "Hồ sơ được chấp thuận" },
  { value: "REJECTED", label: "Đã rớt", description: "Hồ sơ bị từ chối" },
] as const;

export const FINAL_APPLICATION_STATUSES = new Set<ApplicationStatus>(["APPROVED", "REJECTED"]);

export const APPLICATION_STATUS_BADGE_CLASS: Record<ApplicationStatus, string> = {
  PENDING: "border-neutral-200 bg-neutral-100 text-neutral-700",
  COLLECTING_DOCUMENTS: "border-amber-200 bg-amber-100 text-amber-800",
  REVIEWING_DOCUMENTS: "border-indigo-200 bg-indigo-100 text-indigo-800",
  READY_TO_SUBMIT: "border-sky-200 bg-sky-100 text-sky-800",
  SUBMITTED: "border-blue-200 bg-blue-100 text-blue-800",
  UNDER_REVIEW: "border-violet-200 bg-violet-100 text-violet-800",
  ADDITIONAL_DOCUMENTS_REQUIRED: "border-orange-200 bg-orange-100 text-orange-800",
  AWAITING_DECISION: "border-cyan-200 bg-cyan-100 text-cyan-800",
  APPROVED: "border-emerald-200 bg-emerald-100 text-emerald-800",
  REJECTED: "border-red-200 bg-red-100 text-red-800",
};

// Bảng màu hex dùng cho khu vực admin (component Tag nhận màu trực tiếp). Mỗi trạng thái
// có một màu riêng, đồng bộ về sắc độ với badge Tailwind phía giao diện nhân viên.
export const APPLICATION_STATUS_HEX_COLOR: Record<ApplicationStatus, string> = {
  PENDING: "#6B7280",
  COLLECTING_DOCUMENTS: "#D97706",
  REVIEWING_DOCUMENTS: "#4F46E5",
  READY_TO_SUBMIT: "#0284C7",
  SUBMITTED: "#2563EB",
  UNDER_REVIEW: "#7C3AED",
  ADDITIONAL_DOCUMENTS_REQUIRED: "#EA580C",
  AWAITING_DECISION: "#0891B2",
  APPROVED: "#059669",
  REJECTED: "#DC2626",
};

const STATUS_BY_VALUE = new Map(APPLICATION_STATUSES.map((status) => [status.value, status]));

export function getApplicationStatus(value: ApplicationStatus): ApplicationStatusDefinition {
  return STATUS_BY_VALUE.get(value) ?? APPLICATION_STATUSES[0];
}
