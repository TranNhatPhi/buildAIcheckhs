import type { Metadata } from "next";
import { AdminCaseReport } from "@/components/AdminCaseReport";

export const metadata: Metadata = {
  title: "Thống kê hồ sơ — Quản lý Hồ Sơ Canada",
  description: "Số hồ sơ tạo mới theo 12 tháng và bảng chi tiết, lọc theo năm, tháng, tiêu chí.",
};

// BẮT BUỘC "force-dynamic": AdminCaseReport dùng useSearchParams() (?nam=&thang=&loc=) — thiếu
// dòng này "next build" cố dựng trang tĩnh và lỗi thẳng, dù "next dev" không báo (xem
// app/admin/page.tsx, đã gặp đúng lỗi này).
export const dynamic = "force-dynamic";

export default function AdminCaseReportPage() {
  return <AdminCaseReport />;
}
