import { AdminDashboard } from "@/components/AdminDashboard";

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
