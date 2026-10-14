"use client";

// Thành phần UI dùng chung giữa các trang trong khu vực /admin (AdminDashboard.tsx,
// AdminCaseDetail.tsx) — theo phong cách vue-element-admin (xem AdminDashboard.tsx để biết
// lý do chọn template này).
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/lib/adminApi";
import { clearAdminPassword } from "@/lib/adminAuth";
import type { DocumentDTO } from "@/lib/client-types";

// Sự kiện báo sidebar đếm lại (số cạnh tab "CP đang xử lý") — gọi sau MỖI lần đổi trạng thái hồ sơ
// ở trang admin, vì sidebar chỉ tự đếm lúc mở trang.
const SU_KIEN_DEM_LAI = "admin-dem-lai";
export function baoSidebarDemLai() {
  window.dispatchEvent(new Event(SU_KIEN_DEM_LAI));
}

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
  OCR_RUNNING: "Đang đọc tài liệu",
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

// Nút bật/tắt "Nhóm theo nguồn" — dùng chung cho bảng hồ sơ ở trang Tổng quan và trang Thống kê.
export function NutNhomTheoNguon({ bat, onToggle }: { bat: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={bat}
      className="inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors"
      style={
        bat
          ? { backgroundColor: EL.primary, borderColor: EL.primary, color: "white" }
          : { borderColor: "#dcdfe6", color: "#606266" }
      }
      title={bat ? "Bỏ nhóm, xem danh sách liền" : "Chia bảng thành từng nhóm theo nguồn"}
    >
      <span aria-hidden>▤</span>
      {bat ? "Đang nhóm theo nguồn ✕" : "Nhóm theo nguồn"}
    </button>
  );
}

// Dòng tiêu đề của một nhóm nguồn trong bảng (tên nguồn + số hồ sơ).
export function DongTieuDeNhom({ ten, soHoSo, chuaNhap, colSpan }: {
  ten: string;
  soHoSo: number;
  chuaNhap: boolean;
  colSpan: number;
}) {
  return (
    <tr className="bg-neutral-50">
      <td colSpan={colSpan} className="px-3 py-2 border-t border-neutral-200">
        <span className={`text-sm font-semibold ${chuaNhap ? "italic text-neutral-500" : "text-neutral-800"}`}>{ten}</span>
        <span className="ml-2 text-xs text-neutral-500 tabular-nums">{soHoSo} hồ sơ</span>
      </td>
    </tr>
  );
}

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
export function AdminSidebar({
  activeTab,
  onNavigate,
  onLogout,
}: {
  activeTab?: "overview" | "report" | "cpProcessing" | "activity" | "documents" | "emails";
  onNavigate?: () => void;
  onLogout?: () => void;
}) {
  const router = useRouter();
  // Số hồ sơ "CP đang xử lý" hiện cạnh tab — GET /admin/sidebar-counts (1 câu COUNT). Đếm lúc mở
  // trang và mỗi khi có baoSidebarDemLai(); lỗi (chưa đăng nhập, mất mạng) thì chỉ ẩn số.
  const [soCp, setSoCp] = useState<number | null>(null);
  useEffect(() => {
    let huy = false;
    const dem = () =>
      adminFetch("/admin/sidebar-counts")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!huy && typeof d?.cpProcessing === "number") setSoCp(d.cpProcessing);
        })
        .catch(() => {});
    dem();
    window.addEventListener(SU_KIEN_DEM_LAI, dem);
    return () => {
      huy = true;
      window.removeEventListener(SU_KIEN_DEM_LAI, dem);
    };
  }, []);

  function handleLogout() {
    clearAdminPassword();
    onLogout?.();
    router.replace("/admin");
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
          onClick={onNavigate}
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "overview" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          📊 Tổng quan
        </Link>
        <Link
          href="/admin/thong-ke"
          onClick={onNavigate}
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "report" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          📈 Thống kê hồ sơ
        </Link>
        <Link
          href="/admin/cpprocessing"
          onClick={onNavigate}
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "cpProcessing" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          🏛️ CP đang xử lý
          {soCp !== null && (
            <span
              className="ml-auto min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-xs font-bold tabular-nums"
              style={
                activeTab === "cpProcessing"
                  ? { backgroundColor: "rgba(255,255,255,0.25)", color: "white" }
                  : soCp > 0
                    ? { backgroundColor: EL.primary, color: "white" }
                    : { backgroundColor: "rgba(255,255,255,0.1)", color: "#bfcbd9" }
              }
              title={`${soCp} hồ sơ Chính phủ đang xử lý`}
            >
              {soCp}
            </span>
          )}
        </Link>
        <Link
          href="/admin/theo-doi"
          onClick={onNavigate}
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "activity" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          🕵️ Theo dõi Docs
        </Link>
        <Link
          href="/admin?tab=documents"
          onClick={onNavigate}
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "documents" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          📄 Hồ sơ đã nộp
        </Link>
        <Link
          href="/admin?tab=emails"
          onClick={onNavigate}
          className="flex items-center gap-2.5 text-sm font-medium px-3.5 py-3 rounded text-left transition-colors"
          style={activeTab === "emails" ? { backgroundColor: EL.primary, color: "white" } : { color: "#bfcbd9" }}
        >
          ✉️ Nhật ký email
        </Link>
      </nav>
      {/* Mở trang checklist mà team Docs dùng hằng ngày. Thẻ <a> thường + tab MỚI chứ không phải
          Link: đây là rời khỏi khu quản trị, admin thường muốn xem song song rồi quay lại bảng
          đang lọc dở — mở đè lên tab này là mất chỗ đang xem. */}
      <a
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        className="mx-3 mb-1 flex items-center gap-2.5 rounded border border-white/20 px-3.5 py-2.5 text-sm font-medium text-white transition-colors hover:border-white/40 hover:bg-white/10"
        title="Mở trang checklist hồ sơ của team Docs ở tab mới"
      >
        <span aria-hidden>🌐</span>
        <span className="flex-1">Xem trang Docs</span>
        <span aria-hidden className="text-xs text-neutral-400">↗</span>
      </a>
      <button
        onClick={handleLogout}
        className="m-3 text-xs font-semibold text-neutral-300 hover:text-white hover:bg-white/10 rounded px-3.5 py-2.5 text-left transition-colors"
      >
        ⏻ Đăng xuất
      </button>
    </aside>
  );
}
