"use client";

import Link from "next/link";
import { useState } from "react";
import { EditCaseModal } from "@/components/EditCaseModal";
import { API_URL } from "@/lib/format";
import type { CaseListItemDTO } from "@/lib/client-types";

interface Props {
  initialCases: CaseListItemDTO[];
}

export function CaseList({ initialCases }: Props) {
  const [cases, setCases] = useState(initialCases);
  const [editingCase, setEditingCase] = useState<CaseListItemDTO | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(c: CaseListItemDTO) {
    if (!confirm(`Xoá hồ sơ "${c.clientName}"? Toàn bộ file đã upload sẽ bị xoá vĩnh viễn.`)) return;
    setDeletingId(c.id);
    const res = await fetch(`${API_URL}/cases/${c.id}`, { method: "DELETE" });
    setDeletingId(null);
    if (!res.ok) {
      alert("Xoá hồ sơ thất bại.");
      return;
    }
    setCases((prev) => prev.filter((x) => x.id !== c.id));
  }

  if (cases.length === 0) {
    return <p className="text-neutral-500">Chưa có hồ sơ nào.</p>;
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
        {cases.map((c) => {
          const isComplete = c.percent === 100;
          return (
            <li key={c.id}>
              <div
                className={`flex items-center gap-2 border-2 rounded-2xl p-5 hover:shadow-sm transition-all ${
                  isComplete
                    ? "border-green-300 bg-green-50 hover:border-green-400"
                    : "border-neutral-200 bg-white hover:border-indigo-300"
                }`}
              >
                <Link
                  href={`/cases/${c.id}`}
                  className="flex-1 min-w-0 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-neutral-800 truncate">{c.clientName}</p>
                    <p className="text-sm text-neutral-500 mt-0.5">
                      {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
                      {c.numberOfChildren > 0 ? ` · ${c.numberOfChildren} con` : ""}
                    </p>
                    {isComplete && (
                      <p className="text-sm text-green-700 font-medium mt-1">
                        ✓ Hồ sơ này đã hoàn thành
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    {c.needsReviewCount > 0 && (
                      <span className="text-xs font-semibold bg-amber-100 text-amber-800 px-2.5 py-1 rounded-full">
                        {c.needsReviewCount} cần review
                      </span>
                    )}
                    <span
                      className={`text-sm font-bold px-3 py-1.5 rounded-full ${
                        isComplete ? "bg-green-500 text-white" : "bg-indigo-100 text-indigo-700"
                      }`}
                    >
                      {c.percent}%
                    </span>
                  </div>
                </Link>

                <div className="flex items-center gap-1.5 shrink-0 pl-3 ml-1 border-l border-neutral-200">
                  <button
                    onClick={() => setEditingCase(c)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                  >
                    Sửa
                  </button>
                  <button
                    onClick={() => handleDelete(c)}
                    disabled={deletingId === c.id}
                    className="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
                  >
                    {deletingId === c.id ? "Đang xoá..." : "Xoá"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {editingCase && (
        <EditCaseModal
          caseItem={editingCase}
          onClose={() => setEditingCase(null)}
          onSaved={(updated) => {
            setCases((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
            setEditingCase(null);
          }}
        />
      )}
    </>
  );
}
