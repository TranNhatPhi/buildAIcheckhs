import Link from "next/link";
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
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">Danh sách hồ sơ</h1>
        <Link
          href="/cases/new"
          className="bg-indigo-600 text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-indigo-700 shadow-sm transition-colors"
        >
          + Tạo hồ sơ mới
        </Link>
      </div>

      <CaseList initialCases={cases} />
    </main>
  );
}
