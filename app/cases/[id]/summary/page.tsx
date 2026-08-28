import Link from "next/link";
import { notFound } from "next/navigation";
import { CaseSummary } from "@/components/CaseSummary";
import { API_URL } from "@/lib/format";
import type { CaseDetailDTO } from "@/lib/client-types";

export const dynamic = "force-dynamic";

export default async function CaseSummaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const res = await fetch(`${API_URL}/cases/${id}`, { cache: "no-store" });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Không tải được hồ sơ (HTTP ${res.status})`);

  const data: CaseDetailDTO = await res.json();
  const { case: c } = data;

  return (
    <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-10 flex flex-col gap-7">
      <Link
        href={`/cases/${id}`}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-500 hover:text-indigo-600 transition-colors self-start"
      >
        ← Quay lại chi tiết hồ sơ
      </Link>

      <div>
        <h1 className="text-3xl font-bold text-neutral-800">Tổng hợp thông tin — {c.clientName}</h1>
        <p className="text-sm text-neutral-500 mt-1.5">
          Gom toàn bộ nội dung đã đọc được (đã sửa lỗi) từ các file khách hàng đã gửi, theo
          từng mục checklist — không cần mở từng file để xem.
        </p>
      </div>

      <CaseSummary
        caseId={id}
        items={data.checklist.items}
        initialAnalysisStatus={c.aiAnalysisStatus}
        initialAnalysisSummary={c.aiAnalysisSummary}
        initialAnalysisError={c.aiAnalysisError}
        initialAnalysisUpdatedAt={c.aiAnalysisUpdatedAt}
      />
    </main>
  );
}
