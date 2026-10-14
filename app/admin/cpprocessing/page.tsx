import type { Metadata } from "next";
import { AdminCpProcessing } from "@/components/AdminCpProcessing";

export const metadata: Metadata = {
  title: "CP đang xử lý — Quản lý Hồ Sơ Canada",
  description: "Hồ sơ đã nộp, Chính phủ đang xét: ngày nộp, ngày lăn tay và kết quả.",
};

// Cùng lý do với app/admin/thong-ke: trang admin đọc mật khẩu phía trình duyệt, không dựng tĩnh.
export const dynamic = "force-dynamic";

export default function AdminCpProcessingPage() {
  return <AdminCpProcessing />;
}
