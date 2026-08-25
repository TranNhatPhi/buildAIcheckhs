"use client";

// Thành phần UI dùng chung giữa các trang trong khu vực /admin (AdminDashboard.tsx,
// AdminCaseDetail.tsx) — theo phong cách vue-element-admin (xem AdminDashboard.tsx để biết
// lý do chọn template này).
import Link from "next/link";
import { clearAdminPassword } from "@/lib/adminAuth";
import type { DocumentDTO } from "@/lib/client-types";

// Bảng màu theo đúng Element UI — dùng nguyên hex để giữ đúng tinh thần template tham khảo,
// không map qua palette Tailwind mặc định.
export const EL = {
  sidebarBg: "#304156",
  sidebarBgActive: "#1f2d3d",
  primary: "#409EFF",
  success: "#67C23A",
  warning: "#E6A23C",
  danger: "#F56C6C",
  info: "#909399",
};

export const STATUS_LABEL: Record<DocumentDTO["status"], string> = {
  PENDING: "Chờ xử lý",
  OCR_RUNNING: "Đang OCR",
  CLASSIFYING: "Đang phân loại",
  CLASSIFIED: "Đã phân loại",
  NEEDS_REVIEW: "Cần review",
  MANUALLY_SET: "Đã gán tay",
  ERROR: "Lỗi",
};

export const STATUS_COLOR: Record<DocumentDTO["status"], string> = {
  PENDING: EL.info,
  OCR_RUNNING: EL.primary,
  CLASSIFYING: EL.primary,
  CLASSIFIED: EL.success,
  NEEDS_REVIEW: EL.warning,
  MANUALLY_SET: EL.success,
  ERROR: EL.danger,
};

export function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="text-xs font-semibold px-2.5 py-1 rounded"
      style={{ backgroundColor: `${color}1a`, color }}
    >
      {children}
    </span>
  );
}

// Sidebar dùng chung cho MỌI trang trong /admin — điều hướng bằng Link thật (không phải
// state cục bộ) để bấm từ bất kỳ trang admin nào (kể cả AdminCaseDetail) cũng quay lại đúng
// tab trên AdminDashboard. activeTab để trống (undefined) ở các trang không phải 2 tab chính
// (vd trang chi tiết 1 hồ sơ) — khi đó không mục nào được tô sáng.
export function AdminSidebar({ activeTab }: { activeTab?: "overview" | "documents" }) {
  function handleLogout() {
    clearAdminPassword();
    window.location.href = "/admin";
  }

  return (
    <aside
      className="w-56 shrink-0 h-screen sticky top-0 flex flex-col"
      style={{ backgroundColor: EL.sidebarBg }}
    >
      <div className="h-14 flex items-center gap-2 px-5 text-white font-semibold border-b border-white/10">
        <span>🛠</span> Quản trị
      </div>
      <nav className="flex-1 px-2 py-3 flex flex-col gap-1">
        <Link
          href="/admin"
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "overview" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          📊 Tổng quan
        </Link>
        <Link
          href="/admin?tab=documents"
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "documents" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          📄 Hồ sơ đã nộp
        </Link>
      </nav>
      <button
        onClick={handleLogout}
        className="m-3 text-xs font-semibold text-neutral-300 hover:text-white hover:bg-white/10 rounded px-3.5 py-2.5 text-left transition-colors"
      >
        ⏻ Đăng xuất
      </button>
    </aside>
  );
}
