import { notFound } from "next/navigation";
import { CaseDetail } from "@/components/CaseDetail";
import { SERVER_API_URL, staffForwardHeaders } from "@/lib/serverApi";
import type { CaseDetailDTO } from "@/lib/client-types";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const res = await fetch(`${SERVER_API_URL}/cases/${id}`, {
    cache: "no-store",
    headers: await staffForwardHeaders(),
  });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Không tải được hồ sơ (HTTP ${res.status})`);

  const initialData: CaseDetailDTO = await res.json();

  return <CaseDetail caseId={id} initialData={initialData} />;
}
