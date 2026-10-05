import type { Metadata } from "next";
import { AdminActivity } from "@/components/AdminActivity";

export const metadata: Metadata = {
  title: "Theo dõi Docs — Quản lý Hồ Sơ Canada",
  description: "Lịch sử thao tác của nhân viên Docs: ai làm gì, trên hồ sơ nào, lúc nào.",
};

// Cùng lý do với app/admin/thong-ke: trang admin đọc mật khẩu phía trình duyệt, không dựng tĩnh.
export const dynamic = "force-dynamic";

export default function AdminActivityPage() {
  return <AdminActivity />;
}
