import { notFound } from "next/navigation";
import { AdminCaseDetail } from "@/components/AdminCaseDetail";
import { API_URL } from "@/lib/format";
import type { CaseDetailDTO } from "@/lib/client-types";

export const dynamic = "force-dynamic";

export default async function AdminCaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // GET /cases/{id} không cần header X-Admin-Password (endpoint công khai, CaseDetail.tsx ở
  // trang chính cũng dùng chung endpoint này) — chỉ phần UI ở đây mới thuộc khu vực admin,
  // AdminCaseDetail (client component) tự kiểm tra đã đăng nhập admin chưa trước khi hiện.
  const res = await fetch(`${API_URL}/cases/${id}`, { cache: "no-store" });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Không tải được hồ sơ (HTTP ${res.status})`);

  const data: CaseDetailDTO = await res.json();

  return (
    <main className="flex-1 w-full bg-neutral-100">
      <AdminCaseDetail data={data} />
    </main>
  );
}
