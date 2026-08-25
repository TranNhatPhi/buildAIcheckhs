import { AdminDashboard } from "@/components/AdminDashboard";

// Không fetch server-side như các trang khác (xem app/page.tsx) — mật khẩu admin chỉ có ở
// client (localStorage), nên toàn bộ việc gọi API phải chờ tới lúc render ở trình duyệt.
export default function AdminPage() {
  return (
    <main className="flex-1 w-full bg-neutral-100">
      <AdminDashboard />
    </main>
  );
}
