import type { Metadata } from "next";
import { AdminDashboard } from "@/components/AdminDashboard";

// Tiêu đề/link-preview RIÊNG cho trang admin — mặc định sẽ lấy chung tiêu đề "Checklist Hồ
// Sơ Canada" từ app/layout.tsx (root), khiến link gửi qua Zalo/WhatsApp/Messenger hiện y hệt
// link trang chính, không phân biệt được cái nào là admin. Ghi đè riêng ở đây.
export const metadata: Metadata = {
  title: "Quản lý hồ sơ — Checklist Canada",
  description: "Trang quản trị nội bộ: thống kê, khôi phục hồ sơ đã xoá, quản lý tài liệu.",
};

// Không fetch server-side như các trang khác (xem app/page.tsx) — mật khẩu admin chỉ có ở
// client (localStorage), nên toàn bộ việc gọi API phải chờ tới lúc render ở trình duyệt.
// BẮT BUỘC "force-dynamic": AdminDashboard dùng useSearchParams() (đọc ?tab=...) — nếu
// không có dòng này, "next build" cố prerender trang tĩnh lúc build và lỗi thẳng ("should be
// wrapped in a suspense boundary"), dù "next dev" không hề báo lỗi này (dev không prerender).
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <main className="flex-1 w-full bg-neutral-100">
      <AdminDashboard />
    </main>
  );
}
