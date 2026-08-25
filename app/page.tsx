import { CaseList } from "@/components/CaseList";
import { API_URL } from "@/lib/format";
import type { CaseListItemDTO } from "@/lib/client-types";

export const dynamic = "force-dynamic";

async function getCases(): Promise<CaseListItemDTO[]> {
  const res = await fetch(`${API_URL}/cases`, { cache: "no-store" });
  if (!res.ok) return [];
  return res.json();
}

export default async function CaseListPage() {
  const cases = await getCases();

  return (
    <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold mb-8">Danh sách hồ sơ</h1>
      <CaseList initialCases={cases} />
    </main>
  );
}
