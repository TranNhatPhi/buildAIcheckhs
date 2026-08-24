import { notFound } from "next/navigation";
import { CaseDetail } from "@/components/CaseDetail";
import { API_URL } from "@/lib/format";
import type { CaseDetailDTO } from "@/lib/client-types";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const res = await fetch(`${API_URL}/cases/${id}`, { cache: "no-store" });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Không tải được hồ sơ (HTTP ${res.status})`);

  const initialData: CaseDetailDTO = await res.json();

  return <CaseDetail caseId={id} initialData={initialData} />;
}
