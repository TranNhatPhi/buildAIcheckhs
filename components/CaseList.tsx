"use client";

import Link from "next/link";
import { ResubmitBadge } from "@/components/ResubmitBadge";
import { useEffect, useMemo, useState } from "react";
import { CanhCuonHoSo } from "@/components/CanhCuonHoSo";
import { ChecklistOverview3D } from "@/components/ChecklistOverview3D";
import { EditCaseModal } from "@/components/EditCaseModal";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_BADGE_CLASS,
  APPLICATION_STATUS_HEX_COLOR,
  getApplicationStatus,
} from "@/lib/application-status";
import { API_URL, formatExperience, parseUtcDate } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import type { ApplicationStatus, CaseListItemDTO, TagDefinition } from "@/lib/client-types";

/** Ánh xạ tên màu từ API ("red", "yellow"...) sang Tailwind class cụ thể. Đặt ở đây thay vì
 *  hardcode dài dòng Tailwind ở mỗi chỗ render tag. */
const TAG_COLOR_MAP: Record<string, string> = {
  red: "bg-red-100 text-red-800 border-red-200",
  yellow: "bg-amber-100 text-amber-800 border-amber-200",
  green: "bg-emerald-100 text-emerald-800 border-emerald-200",
  orange: "bg-orange-100 text-orange-800 border-orange-200",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
  gray: "bg-neutral-100 text-neutral-600 border-neutral-200",
  purple: "bg-purple-100 text-purple-800 border-purple-200",
};

interface Props {
  initialCases: CaseListItemDTO[];
}

type ChecklistStatusFilter = "ALL" | "NEEDS_REVIEW" | "EXPIRED_DOCS" | "INCOMPLETE" | "COMPLETE";
type ApplicationStatusFilter = "ALL" | ApplicationStatus;
type SkillFilter = "ALL" | "HIGH_SKILL" | "LOW_SKILL";
type MaritalFilter = "ALL" | "MARRIED" | "SINGLE";
type SortOption = "PERCENT_DESC" | "NEWEST" | "OLDEST" | "NEEDS_ATTENTION" | "NAME";

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
  const hydrated = useHydrated();
  // Hồ sơ "7 ngày chưa cập nhật" (không có file mới mà còn thiếu giấy tờ bắt buộc) — lấy đúng danh
  // sách của chuông thông báo (backend/thong_bao.py) để thẻ tô vàng khớp với chuông, không tự tính lại.
  const [chuaCapNhat, setChuaCapNhat] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    fetch(`${API_URL}/notifications`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.items) return;
        setChuaCapNhat(
          new Map(
            d.items
              .filter((x: { kind?: string }) => x.kind === "CHUA_CAP_NHAT")
              .map((x: { caseId: string; daysIdle: number }) => [x.caseId, x.daysIdle] as [string, number]),
          ),
        );
      })
      .catch(() => {});
  }, []);
  const [editingCase, setEditingCase] = useState<CaseListItemDTO | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [hoanTatId, setHoanTatId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [checklistStatusFilter, setChecklistStatusFilter] = useState<ChecklistStatusFilter>("ALL");
  const [applicationStatusFilter, setApplicationStatusFilter] =
    useState<ApplicationStatusFilter>("ALL");
  const [skillFilter, setSkillFilter] = useState<SkillFilter>("ALL");
  const [maritalFilter, setMaritalFilter] = useState<MaritalFilter>("ALL");
  // Mặc định xếp theo TIẾN ĐỘ GIẢM DẦN chứ không phải theo ngày tạo: việc hằng ngày là nhìn
  // hồ sơ nào sắp xong để đẩy nốt, mà xếp theo ngày tạo thì mấy con số % nhảy lộn xộn
  // (90, 85, 85, 95, 45...) nên phải dò từng dòng.
  const [sortOption, setSortOption] = useState<SortOption>("PERCENT_DESC");
  const [tagFilter, setTagFilter] = useState<string>("ALL");
  // "ALL" = mọi hồ sơ; "__NONE__" = hồ sơ chưa gán đối tác (khách tự tìm đến, hoặc hồ sơ
  // tạo trước khi có trường này). Dùng chuỗi riêng chứ không dùng "" vì "" là giá trị
  // hợp lệ của ô select khi chưa chọn gì, sẽ lẫn với nhau.
  const [partnerFilter, setPartnerFilter] = useState<string>("ALL");
  const [tagDefs, setTagDefs] = useState<TagDefinition[]>([]);

  // Fetch danh sách tag hợp lệ + màu hiển thị 1 lần khi mount — không hardcode lại ở frontend,
  // giữ backend làm single source of truth.
  useEffect(() => {
    fetch(`${API_URL}/cases/tags`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: TagDefinition[]) => setTagDefs(data))
      .catch(() => {});
  }, []);

  // Map nhanh tên tag → màu, dùng khi render badge.
  const tagColorByName = useMemo(
    () => new Map(tagDefs.map((t) => [t.name, t.color])),
    [tagDefs],
  );

  // Gom từ chính `cases` chứ không gọi /cases/partners: danh sách này chỉ cần khớp đúng
  // những hồ sơ đang có trên màn hình, và như vậy không phát sinh thêm một lượt gọi mạng.
  const partnerOptions = useMemo(() => {
    const names = new Set<string>();
    for (const c of cases) if (c.partner) names.add(c.partner);
    return Array.from(names).sort((a, b) => VIETNAMESE_COLLATOR.compare(a, b));
  }, [cases]);

  const hasPartnerlessCases = useMemo(() => cases.some((c) => !c.partner), [cases]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    checklistStatusFilter !== "ALL" ||
    applicationStatusFilter !== "ALL" ||
    skillFilter !== "ALL" ||
    maritalFilter !== "ALL" ||
    tagFilter !== "ALL" ||
    partnerFilter !== "ALL" ||
    sortOption !== "PERCENT_DESC";

  const visibleCases = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery.trim());

    return cases
      .filter((caseItem) => {
        const searchableText = normalizeSearchText(
          `${caseItem.clientName} ${caseItem.partner ?? ""} ${caseItem.notes ?? ""}`,
        );
        const matchesSearch = normalizedQuery === "" || searchableText.includes(normalizedQuery);
        const matchesTag =
          tagFilter === "ALL" || caseItem.tags.includes(tagFilter);
        const matchesChecklistStatus =
          checklistStatusFilter === "ALL" ||
          (checklistStatusFilter === "NEEDS_REVIEW" && caseItem.needsReviewCount > 0) ||
          (checklistStatusFilter === "EXPIRED_DOCS" &&
            (caseItem.expiredDocCount > 0 || caseItem.expiringSoonDocCount > 0)) ||
          (checklistStatusFilter === "INCOMPLETE" && caseItem.percent < 100) ||
          (checklistStatusFilter === "COMPLETE" && caseItem.percent === 100);
        const matchesApplicationStatus =
          applicationStatusFilter === "ALL" ||
          caseItem.applicationStatus === applicationStatusFilter;
        const matchesPartner =
          partnerFilter === "ALL" ||
          (partnerFilter === "__NONE__" ? !caseItem.partner : caseItem.partner === partnerFilter);
        const matchesSkill = skillFilter === "ALL" || caseItem.skillLevel === skillFilter;
        const matchesMarital = maritalFilter === "ALL" || caseItem.maritalStatus === maritalFilter;

        return (
          matchesSearch &&
          matchesTag &&
          matchesPartner &&
          matchesChecklistStatus &&
          matchesApplicationStatus &&
          matchesSkill &&
          matchesMarital
        );
      })
      .sort((a, b) => {
        if (sortOption === "PERCENT_DESC") {
          // Cùng % thì xếp theo tên để thứ tự không đổi lung tung mỗi lần tải lại — hiện có
          // tới 2-3 hồ sơ cùng 85%.
          return b.percent - a.percent || VIETNAMESE_COLLATOR.compare(a.clientName, b.clientName);
        }
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
  }, [
    applicationStatusFilter,
    cases,
    checklistStatusFilter,
    maritalFilter,
    partnerFilter,
    searchQuery,
    skillFilter,
    sortOption,
    tagFilter,
  ]);

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
    setChecklistStatusFilter("ALL");
    setApplicationStatusFilter("ALL");
    setSkillFilter("ALL");
    setMaritalFilter("ALL");
    setTagFilter("ALL");
    setSortOption("PERCENT_DESC");
  }

  // Phải khớp với CASE_AUTO_DELETE_DAYS ở backend/case_status.py — chỉ dùng cho câu hỏi xác
  // nhận; ngày xoá THẬT do backend tính và trả về trong autoDeleteAt.
  const SO_NGAY_TU_XOA = 14;

  // "Cập nhật: 01/10/2026 14:32 · hôm nay" — lần có FILE MỚI gần nhất (cùng mốc với cột "Ngày cập
  // nhật" trang thống kê và nhắc "7 ngày chưa cập nhật"). Chỉ dựng sau khi hydrate: server chạy giờ
  // UTC nên tự format sẽ ra giờ lệch 7 tiếng và lệch với lần render ở trình duyệt.
  function capNhatLuc(c: CaseListItemDTO): string | null {
    if (!hydrated) return null;
    const moc = c.lastDocumentAt ?? null;
    if (!moc) return `Chưa có file nào · tạo ${ngayVN(c.createdAt)}`;
    const d = parseUtcDate(moc);
    const gio = d.toLocaleString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const homNay = new Date();
    homNay.setHours(0, 0, 0, 0);
    const ngayFile = new Date(d);
    ngayFile.setHours(0, 0, 0, 0);
    const soNgay = Math.round((homNay.getTime() - ngayFile.getTime()) / 86400000);
    const tuongDoi = soNgay <= 0 ? "hôm nay" : soNgay === 1 ? "hôm qua" : `${soNgay} ngày trước`;
    return `Cập nhật: ${gio} · ${tuongDoi}`;
  }

  function ngayVN(iso: string) {
    return parseUtcDate(iso).toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  async function doiHoanTat(c: CaseListItemDTO, bat: boolean) {
    if (
      bat &&
      !confirm(
        `Đánh dấu hồ sơ "${c.clientName}" đã hoàn tất?\n\n` +
          `• Tiến độ hiển thị thành 100%\n` +
          `• Sau ${SO_NGAY_TU_XOA} ngày, hồ sơ bị XOÁ VĨNH VIỄN — cả thông tin khách hàng lẫn toàn bộ file\n` +
          `• KHÔNG khôi phục được. Tải file về trước nếu còn cần.`
      )
    )
      return;
    setHoanTatId(c.id);
    try {
      const res = await fetch(`${API_URL}/cases/${c.id}/complete`, {
        method: bat ? "POST" : "DELETE",
      }).catch(() => null);
      if (!res || !res.ok) {
        const chiTiet = res ? await res.json().catch(() => null) : null;
        alert(chiTiet?.detail ?? "Không đổi được trạng thái hoàn tất — thử lại sau.");
        return;
      }
      const kq = await res.json();
      // Cập nhật tại chỗ thay vì tải lại cả danh sách: danh sách này giữ sẵn bộ lọc/sắp xếp
      // người dùng đang đặt, tải lại là nhảy về đầu trang.
      setCases((prev) =>
        prev.map((x) =>
          x.id === c.id
            ? {
                ...x,
                completedAt: kq.completedAt,
                autoDeleteAt: kq.autoDeleteAt,
                percent: bat ? 100 : x.percent,
                // Backend tự đổi trạng thái theo tiến độ (100% -> "Hoàn thành").
                applicationStatus: kq.applicationStatus ?? x.applicationStatus,
              }
            : x
        )
      );
      // Bỏ đánh dấu thì tiến độ phải về SỐ THẬT, mà số đó chỉ backend tính được — hỏi lại
      // ĐÚNG hồ sơ đó thay vì tải lại cả danh sách, để bộ lọc/sắp xếp đang đặt không bị mất.
      if (!bat) {
        const ct = await fetch(`${API_URL}/cases/${c.id}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (ct?.checklist)
          setCases((prev) =>
            prev.map((x) => (x.id === c.id ? { ...x, percent: ct.checklist.percent } : x))
          );
      }
    } finally {
      setHoanTatId(null);
    }
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
      <CanhCuonHoSo tongHoSo={cases.length} {...overview} />

      <section
        id="danh-sach-ho-so"
        className="mb-5 scroll-mt-6 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm"
      >
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <label className="md:col-span-2 lg:col-span-5">
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
            <span className="mb-1.5 block text-sm font-medium text-neutral-700">
              Trạng thái hồ sơ
            </span>
            <select
              value={applicationStatusFilter}
              onChange={(event) =>
                setApplicationStatusFilter(event.target.value as ApplicationStatusFilter)
              }
              className={`w-full rounded-xl border px-3 py-2.5 text-sm font-semibold outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 ${
                applicationStatusFilter === "ALL"
                  ? "border-neutral-300 bg-white text-neutral-800"
                  : APPLICATION_STATUS_BADGE_CLASS[applicationStatusFilter]
              }`}
            >
              <option value="ALL">Tất cả trạng thái</option>
              {APPLICATION_STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="mb-1.5 block text-sm font-medium text-neutral-700">
              Tình trạng checklist
            </span>
            <select
              value={checklistStatusFilter}
              onChange={(event) =>
                setChecklistStatusFilter(event.target.value as ChecklistStatusFilter)
              }
              className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              <option value="ALL">Tất cả checklist</option>
              <option value="NEEDS_REVIEW">Có tài liệu cần review</option>
              <option value="EXPIRED_DOCS">Có giấy tờ quá hạn / sắp hết hạn</option>
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
              <option value="PERCENT_DESC">Tiến độ cao → thấp</option>
              <option value="NEWEST">Mới tạo gần đây</option>
              <option value="OLDEST">Tạo lâu nhất</option>
              <option value="NEEDS_ATTENTION">Cần xử lý trước</option>
              <option value="NAME">Tên A–Z</option>
            </select>
          </label>

          {/* Chỉ hiện ô lọc khi thật sự có đối tác để lọc — chưa ai nhập đối tác thì ô này
              rỗng, chỉ tổ làm rối hàng bộ lọc vốn đã dài. */}
          {(partnerOptions.length > 0 || hasPartnerlessCases) && (
            <label>
              <span className="mb-1.5 block text-sm font-medium text-neutral-700">
                Đối tác / nguồn
              </span>
              <select
                value={partnerFilter}
                onChange={(event) => setPartnerFilter(event.target.value)}
                className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="ALL">Tất cả đối tác</option>
                {partnerOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {hasPartnerlessCases && <option value="__NONE__">— Chưa gán đối tác —</option>}
              </select>
            </label>
          )}

          {tagDefs.length > 0 && (
            <label>
              <span className="mb-1.5 block text-sm font-medium text-neutral-700">Nhãn (tag)</span>
              <select
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
                className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              >
                <option value="ALL">Tất cả nhãn</option>
                {tagDefs.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
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
            const applicationStatus = getApplicationStatus(c.applicationStatus);
            const cardClass =
              c.applicationStatus === "APPROVED"
                ? "border-green-300 bg-green-50 hover:border-green-400"
                : c.applicationStatus === "REJECTED"
                  ? "border-red-300 bg-red-50 hover:border-red-400"
                  : c.applicationStatus === "LIQUIDATED"
                    ? "border-slate-300 bg-slate-100 hover:border-slate-400"
                    : chuaCapNhat.has(c.id)
                      // Vàng tươi kiểu bút dạ quang — cùng màu khung nhắc cũ trong trang hồ sơ, nay
                      // đưa ra ngoài danh sách để lướt là thấy hồ sơ nào đang bị bỏ quên.
                      ? "border-yellow-400 bg-[#FFFF00] hover:border-yellow-500"
                      : "border-neutral-200 bg-white hover:border-indigo-300";
            return (
              <li key={c.id}>
                <div
                  className={`flex items-center gap-2 border-2 rounded-2xl p-5 hover:shadow-sm transition-all ${cardClass}`}
                  style={{
                    borderLeftColor: APPLICATION_STATUS_HEX_COLOR[c.applicationStatus],
                    borderLeftWidth: 6,
                  }}
                >
                  <Link
                    href={`/cases/${c.id}`}
                    className="flex-1 min-w-0 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      {/* Đối tác nằm CÙNG DÒNG với tên khách, không đẩy xuống dòng phụ: đây
                          chính là thứ phân biệt hai khách trùng tên, mà lúc lướt danh sách
                          mắt chỉ dừng ở dòng tên. Để tuốt dưới thì coi như không có. */}
                      <p className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="font-semibold text-neutral-800 truncate">
                          {c.clientName}
                        </span>
                        <ResubmitBadge round={c.submissionRound} />
                        {c.partner && (
                          <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-800">
                            🏢 {c.partner}
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-neutral-500 mt-0.5">
                        {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
                        {c.numberOfChildren > 0 ? ` · ${c.numberOfChildren} con` : ""}
                        {" · "}
                        {c.skillLevel === "HIGH_SKILL" ? "High Skilled" : "Low Skilled"}
                        {c.occupation ? ` · ${c.occupation}` : ""}
                        {formatExperience(c.experienceMonths)
                          ? ` · ${formatExperience(c.experienceMonths)}`
                          : ""}
                      </p>
                      {/* Tên công ty xác nhận kinh nghiệm — nhiều đơn vị thì cách nhau dấu phẩy. Ngày nhập
                          từng đơn vị xem ở trang hồ sơ. Chưa nhập thì không hiện dòng này. */}
                      {c.experienceUnits?.length > 0 && (
                        <p className="mt-0.5 text-xs text-neutral-700">
                          <span aria-hidden>💼 </span>
                          <span className="text-neutral-500">Đơn vị XNKN:</span>{" "}
                          <span className="font-medium">{c.experienceUnits.map((u) => u.name).join(", ")}</span>
                        </p>
                      )}
                      {capNhatLuc(c) && (
                        <p className="mt-0.5 text-xs text-neutral-500">
                          <span aria-hidden>🕒 </span>
                          {capNhatLuc(c)}
                        </p>
                      )}
                      <p className="mt-1.5 flex flex-wrap gap-1.5">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${APPLICATION_STATUS_BADGE_CLASS[c.applicationStatus]}`}
                        >
                          {applicationStatus.label}
                        </span>
                        {chuaCapNhat.has(c.id) && (
                          <span className="rounded-full border border-black/20 bg-white px-2 py-0.5 text-[11px] font-semibold text-black">
                            ⏰ {chuaCapNhat.get(c.id)} ngày chưa cập nhật
                          </span>
                        )}
                        {c.statusReminderDue && (
                          <span className="rounded-full border border-rose-200 bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-800">
                            Đã đến hạn nhắc admin
                          </span>
                        )}
                      </p>
                      {/* Tag badge — hiển ngay dưới thông tin cơ bản, trước cảnh báo hạn. */}
                      {c.tags.length > 0 && (
                        <p className="mt-1.5 flex flex-wrap gap-1">
                          {c.tags.map((tag) => (
                            <span
                              key={tag}
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                                TAG_COLOR_MAP[tagColorByName.get(tag) ?? ""] ?? TAG_COLOR_MAP.gray
                              }`}
                            >
                              {tag}
                            </span>
                          ))}
                        </p>
                      )}
                      {/* Giấy tờ quá hạn làm hồ sơ trông đủ mà thực chất không dùng được —
                          phải thấy ngay ở danh sách, không đợi mở từng hồ sơ ra mới biết. */}
                      {(c.expiredDocCount > 0 || c.expiringSoonDocCount > 0) && (
                        <p className="mt-1.5 flex flex-wrap gap-1.5">
                          {c.expiredDocCount > 0 && (
                            <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                              {c.expiredDocCount} giấy tờ quá hạn
                            </span>
                          )}
                          {c.expiringSoonDocCount > 0 && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                              {c.expiringSoonDocCount} sắp hết hạn
                            </span>
                          )}
                        </p>
                      )}
                      {isComplete && (
                        <p className="text-sm text-green-700 font-medium mt-1">
                          ✓ Checklist giấy tờ đã hoàn thành
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
                    {c.completedAt ? (
                      <button
                        onClick={() => doiHoanTat(c, false)}
                        disabled={hoanTatId === c.id}
                        title={
                          c.autoDeleteAt
                            ? `Hồ sơ sẽ bị xoá vĩnh viễn ngày ${ngayVN(c.autoDeleteAt)} — bấm để huỷ`
                            : "Bấm để bỏ đánh dấu hoàn tất"
                        }
                        className="text-xs font-semibold px-3 py-1.5 rounded-full bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-50 transition-colors"
                      >
                        {hoanTatId === c.id
                          ? "Đang lưu..."
                          : c.autoDeleteAt
                            ? `✓ Xoá ${ngayVN(c.autoDeleteAt)}`
                            : "✓ Hoàn tất"}
                      </button>
                    ) : (
                      <button
                        onClick={() => doiHoanTat(c, true)}
                        disabled={hoanTatId === c.id}
                        title={`Đặt tiến độ thành 100% và hẹn XOÁ VĨNH VIỄN hồ sơ sau ${SO_NGAY_TU_XOA} ngày`}
                        className="text-xs font-semibold px-3 py-1.5 rounded-full bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-50 transition-colors"
                      >
                        {hoanTatId === c.id ? "Đang lưu..." : "Hoàn tất"}
                      </button>
                    )}
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
