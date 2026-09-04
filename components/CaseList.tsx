"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChecklistOverview3D } from "@/components/ChecklistOverview3D";
import { EditCaseModal } from "@/components/EditCaseModal";
import { API_URL } from "@/lib/format";
import type { CaseListItemDTO } from "@/lib/client-types";

interface Props {
  initialCases: CaseListItemDTO[];
}

type StatusFilter = "ALL" | "NEEDS_REVIEW" | "INCOMPLETE" | "COMPLETE";
type SkillFilter = "ALL" | "HIGH_SKILL" | "LOW_SKILL";
type MaritalFilter = "ALL" | "MARRIED" | "SINGLE";
type SortOption = "NEWEST" | "OLDEST" | "NEEDS_ATTENTION" | "NAME";

const VIETNAMESE_COLLATOR = new Intl.Collator("vi", { sensitivity: "base" });

function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export function CaseList({ initialCases }: Props) {
  const [cases, setCases] = useState(initialCases);
  const [editingCase, setEditingCase] = useState<CaseListItemDTO | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [skillFilter, setSkillFilter] = useState<SkillFilter>("ALL");
  const [maritalFilter, setMaritalFilter] = useState<MaritalFilter>("ALL");
  const [sortOption, setSortOption] = useState<SortOption>("NEWEST");

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    statusFilter !== "ALL" ||
    skillFilter !== "ALL" ||
    maritalFilter !== "ALL" ||
    sortOption !== "NEWEST";

  const visibleCases = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery.trim());

    return cases
      .filter((caseItem) => {
        const searchableText = normalizeSearchText(
          `${caseItem.clientName} ${caseItem.notes ?? ""}`,
        );
        const matchesSearch = normalizedQuery === "" || searchableText.includes(normalizedQuery);
        const matchesStatus =
          statusFilter === "ALL" ||
          (statusFilter === "NEEDS_REVIEW" && caseItem.needsReviewCount > 0) ||
          (statusFilter === "INCOMPLETE" && caseItem.percent < 100) ||
          (statusFilter === "COMPLETE" && caseItem.percent === 100);
        const matchesSkill = skillFilter === "ALL" || caseItem.skillLevel === skillFilter;
        const matchesMarital = maritalFilter === "ALL" || caseItem.maritalStatus === maritalFilter;

        return matchesSearch && matchesStatus && matchesSkill && matchesMarital;
      })
      .sort((a, b) => {
        if (sortOption === "OLDEST") {
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        }
        if (sortOption === "NEEDS_ATTENTION") {
          return (
            b.needsReviewCount - a.needsReviewCount ||
            a.percent - b.percent ||
            VIETNAMESE_COLLATOR.compare(a.clientName, b.clientName)
          );
        }
        if (sortOption === "NAME") {
          return VIETNAMESE_COLLATOR.compare(a.clientName, b.clientName);
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [cases, maritalFilter, searchQuery, skillFilter, sortOption, statusFilter]);

  const overview = useMemo(() => {
    const daHoanThanh = cases.filter((caseItem) => caseItem.percent === 100).length;
    const canXemLai = cases.reduce((tong, caseItem) => tong + caseItem.needsReviewCount, 0);
    const tienDoTrungBinh = cases.length
      ? Math.round(cases.reduce((tong, caseItem) => tong + caseItem.percent, 0) / cases.length)
      : 0;
    return { daHoanThanh, canXemLai, tienDoTrungBinh };
  }, [cases]);

  function resetFilters() {
    setSearchQuery("");
    setStatusFilter("ALL");
    setSkillFilter("ALL");
    setMaritalFilter("ALL");
    setSortOption("NEWEST");
  }

  async function handleDelete(c: CaseListItemDTO) {
    if (!confirm(`Xoá hồ sơ "${c.clientName}"? Hồ sơ sẽ bị ẩn khỏi danh sách này (không xoá vĩnh viễn).`))
      return;
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
    return (
      <>
        <ChecklistOverview3D
          tongHoSo={0}
          daHoanThanh={0}
          canXemLai={0}
          tienDoTrungBinh={0}
        />
        <p className="text-neutral-500">Chưa có hồ sơ nào.</p>
      </>
    );
  }

  return (
    <>
      <ChecklistOverview3D tongHoSo={cases.length} {...overview} />

      <section className="mb-5 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <label className="md:col-span-2 lg:col-span-4">
            <span className="mb-1.5 block text-sm font-medium text-neutral-700">
              Tìm hồ sơ
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Nhập tên khách hàng hoặc ghi chú..."
              className="w-full rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <label>
            <span className="mb-1.5 block text-sm font-medium text-neutral-700">Trạng thái</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="ALL">Tất cả trạng thái</option>
              <option value="NEEDS_REVIEW">Có tài liệu cần review</option>
              <option value="INCOMPLETE">Chưa hoàn thành</option>
              <option value="COMPLETE">Đã hoàn thành</option>
            </select>
          </label>

          <label>
            <span className="mb-1.5 block text-sm font-medium text-neutral-700">Diện hồ sơ</span>
            <select
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value as SkillFilter)}
              className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="ALL">Tất cả diện hồ sơ</option>
              <option value="HIGH_SKILL">High Skilled</option>
              <option value="LOW_SKILL">Low Skilled</option>
            </select>
          </label>

          <label>
            <span className="mb-1.5 block text-sm font-medium text-neutral-700">
              Tình trạng hôn nhân
            </span>
            <select
              value={maritalFilter}
              onChange={(event) => setMaritalFilter(event.target.value as MaritalFilter)}
              className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="ALL">Tất cả</option>
              <option value="MARRIED">Đã kết hôn</option>
              <option value="SINGLE">Độc thân</option>
            </select>
          </label>

          <label>
            <span className="mb-1.5 block text-sm font-medium text-neutral-700">Sắp xếp</span>
            <select
              value={sortOption}
              onChange={(event) => setSortOption(event.target.value as SortOption)}
              className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="NEWEST">Mới tạo gần đây</option>
              <option value="OLDEST">Tạo lâu nhất</option>
              <option value="NEEDS_ATTENTION">Cần xử lý trước</option>
              <option value="NAME">Tên A–Z</option>
            </select>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-100 pt-3">
          <p className="text-sm text-neutral-500">
            Hiển thị <span className="font-semibold text-neutral-700">{visibleCases.length}</span>/{cases.length} hồ sơ
          </p>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={resetFilters}
              className="text-sm font-semibold text-indigo-700 hover:text-indigo-900"
            >
              Xoá bộ lọc
            </button>
          )}
        </div>
      </section>

      {visibleCases.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 text-center">
          <p className="font-medium text-neutral-700">Không tìm thấy hồ sơ phù hợp.</p>
          <p className="mt-1 text-sm text-neutral-500">Thử đổi từ khoá hoặc xoá bộ lọc.</p>
          <button
            type="button"
            onClick={resetFilters}
            className="mt-4 rounded-full bg-indigo-100 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-200"
          >
            Xoá bộ lọc
          </button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {visibleCases.map((c) => {
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
                        {" · "}
                        {c.skillLevel === "HIGH_SKILL" ? "High Skilled" : "Low Skilled"}
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
      )}

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
