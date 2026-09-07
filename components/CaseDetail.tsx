"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChecklistSection } from "@/components/ChecklistSection";
import { DocumentScene3D } from "@/components/DocumentScene3D";
import { DocumentList } from "@/components/DocumentList";
import { DocChecksPanel } from "@/components/DocChecksPanel";
import { GeneralNotesBanner } from "@/components/GeneralNotesBanner";
import { SavingsCard } from "@/components/SavingsCard";
import { STAGE_LABEL, UploadDropzone } from "@/components/UploadDropzone";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_BADGE_CLASS,
  APPLICATION_STATUS_HEX_COLOR,
  FINAL_APPLICATION_STATUSES,
  getApplicationStatus,
} from "@/lib/application-status";
import { API_URL, estimateProcessingSeconds, formatRemaining, parseUtcDate } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import type {
  ApplicationStatus,
  CaseDetailDTO,
  CaseListItemDTO,
  TagDefinition,
} from "@/lib/client-types";

/** Ánh xạ tên màu từ API sang Tailwind class. */
const TAG_COLOR_MAP: Record<string, string> = {
  red: "bg-red-100 text-red-800 border-red-200",
  yellow: "bg-amber-100 text-amber-800 border-amber-200",
  green: "bg-emerald-100 text-emerald-800 border-emerald-200",
  orange: "bg-orange-100 text-orange-800 border-orange-200",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
  gray: "bg-neutral-100 text-neutral-600 border-neutral-200",
  purple: "bg-purple-100 text-purple-800 border-purple-200",
};

const REMINDER_DATE_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "long",
  timeZone: "Asia/Ho_Chi_Minh",
});

interface Props {
  caseId: string;
  // Dữ liệu fetch sẵn từ server (app/cases/[id]/page.tsx) — có ngay khi trang render
  // lần đầu / F5, không phải qua màn "Đang tải..." rồi mới fetch lại phía client.
  initialData: CaseDetailDTO;
}

export function CaseDetail({ caseId, initialData }: Props) {
  const [data, setData] = useState<CaseDetailDTO | null>(initialData);
  const [notFound, setNotFound] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Thông báo "đã gửi email" tự tắt sau 5 giây. Giữ id timer trong ref để lần đổi trạng thái
  // kế tiếp huỷ được timer cũ — không huỷ thì timer của lần trước sẽ tắt sớm thông báo mới.
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  const emailNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Tag management ---
  const [caseTags, setCaseTags] = useState<string[]>(initialData.case.tags ?? []);
  const [tagDefs, setTagDefs] = useState<TagDefinition[]>([]);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [tagSaving, setTagSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/cases/tags`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: TagDefinition[]) => setTagDefs(data))
      .catch(() => {});
  }, []);

  const tagColorByName = useMemo(
    () => new Map(tagDefs.map((t) => [t.name, t.color])),
    [tagDefs],
  );

  async function updateTags(newTags: string[]) {
    setTagSaving(true);
    setCaseTags(newTags);
    try {
      const res = await fetch(`${API_URL}/cases/${caseId}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: newTags }),
      });
      if (res.ok) {
        const saved: string[] = await res.json();
        setCaseTags(saved);
      }
    } catch { /* bỏ qua lỗi mạng, tag vẫn hiển theo state client */ }
    setTagSaving(false);
  }

  function addTag(tag: string) {
    if (!caseTags.includes(tag)) updateTags([...caseTags, tag]);
    setShowTagPicker(false);
  }

  function removeTag(tag: string) {
    updateTags(caseTags.filter((t) => t !== tag));
  }

  const refetch = useCallback(async () => {
    const res = await fetch(`${API_URL}/cases/${caseId}`, { cache: "no-store" });
    if (res.status === 404) {
      setNotFound(true);
      return;
    }
    setData(await res.json());
  }, [caseId]);

  function showEmailNotice(message: string) {
    if (emailNoticeTimer.current) clearTimeout(emailNoticeTimer.current);
    setEmailNotice(message);
    emailNoticeTimer.current = setTimeout(() => setEmailNotice(null), 5000);
  }

  // Huỷ timer khi rời trang, tránh setState trên component đã unmount.
  useEffect(() => () => {
    if (emailNoticeTimer.current) clearTimeout(emailNoticeTimer.current);
  }, []);

  async function updateApplicationStatus(applicationStatus: ApplicationStatus) {
    setStatusSaving(true);
    setStatusError(null);
    try {
      const res = await fetch(`${API_URL}/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationStatus }),
      });
      if (!res.ok) {
        setStatusError("Không cập nhật được trạng thái hồ sơ.");
        return;
      }
      // Backend quyết định trạng thái nào gửi email (INSTANT_EMAIL_STATUSES) và trả về cờ
      // này — frontend chỉ hiển thị, không tự dựng lại danh sách để khỏi lệch nhau.
      const updated: CaseListItemDTO = await res.json();
      if (updated.statusEmailQueued) {
        showEmailNotice(
          `Đã gửi email thông báo hồ sơ chuyển sang “${getApplicationStatus(applicationStatus).label}”.`,
        );
      }
      await refetch();
    } catch {
      setStatusError("Không kết nối được máy chủ. Vui lòng thử lại.");
    } finally {
      setStatusSaving(false);
    }
  }

  // Nếu còn document đang chờ OCR/AI xử lý (vd trang vừa được F5 lại giữa lúc đang xử
  // lý, hoặc nhân viên rời trang rồi quay lại), tự động poll lại định kỳ cho đến khi
  // xong — không bắt nhân viên phải tự F5 để biết kết quả.
  const hasProcessingDocs = data
    ? data.case.documents.some((d) => ["PENDING", "OCR_RUNNING", "CLASSIFYING"].includes(d.status))
    : false;
  // Đồng hồ đếm ngược riêng (1s/lần, KHÔNG gọi lại server — chỉ để tính lại "còn khoảng bao
  // lâu" mỗi giây cho mượt) — tách khỏi interval refetch 4s ở dưới vì mục đích khác nhau: cái
  // dưới lấy DỮ LIỆU THẬT, cái này chỉ ép re-render để cập nhật số giây hiển thị.
  //
  // Date.now() ở server và client chắc chắn lệch nhau, nên mọi phần dùng giá trị này chỉ được
  // hiện sau khi useHydrated() trả true. Nhờ vậy lần hydrate đầu vẫn khớp HTML từ server mà
  // đồng hồ có ngay mốc hợp lệ, không cần setState đồng bộ thêm một lượt trong effect.
  const mounted = useHydrated();
  const [nowTick, setNowTick] = useState(Date.now);
  useEffect(() => {
    if (!hasProcessingDocs) return;
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasProcessingDocs]);
  // Tiến độ hiển thị = tỉ lệ file ĐÃ xong / tổng số file trong hồ sơ (không chỉ riêng đợt
  // đang chạy, vì trang này không biết ranh giới "đợt upload" — khác UploadDropzone.tsx tự
  // theo dõi được đúng đợt vì đang là nơi khởi tạo). Vẫn đủ dùng: thanh sẽ đầy dần lên khi
  // các file đang xử lý lần lượt xong.
  const totalTrackedDocs = data?.case.documents.length ?? 0;
  const processingDocs = data
    ? data.case.documents.filter((d) => ["PENDING", "OCR_RUNNING", "CLASSIFYING"].includes(d.status))
    : [];
  const processedCount = totalTrackedDocs - processingDocs.length;
  const processedPercent = totalTrackedDocs > 0 ? Math.round((processedCount / totalTrackedDocs) * 100) : 0;
  // Ước tính tổng thời gian còn lại cho CẢ ĐỢT = thời gian của file LÂU NHẤT (không phải
  // cộng dồn) — vì các file này đều đang chạy SONG SONG thật sự (mỗi file đã có dòng Document
  // riêng, backend xử lý qua threadpool), cả đợt chỉ xong khi file chậm nhất xong.
  const totalRemainingEstimate = processingDocs.reduce((max, d) => {
    const elapsedSeconds = Math.floor((nowTick - parseUtcDate(d.uploadedAt).getTime()) / 1000);
    const remaining = Math.max(0, estimateProcessingSeconds(d.pageCount) - elapsedSeconds);
    return Math.max(max, remaining);
  }, 0);

  useEffect(() => {
    if (!hasProcessingDocs) return;
    const interval = setInterval(refetch, 4000);
    return () => clearInterval(interval);
  }, [hasProcessingDocs, refetch]);

  if (notFound) return <p className="text-neutral-500 px-6 py-10">Không tìm thấy hồ sơ.</p>;
  if (!data) return <p className="text-neutral-400 px-6 py-10">Đang tải...</p>;

  const { case: c, checklist } = data;
  const isComplete = checklist.percent === 100;
  const applicationStatus = getApplicationStatus(c.applicationStatus);
  // Mục bắt buộc còn thiếu — liệt kê ngay đầu trang để nhân viên biết cần làm gì tiếp mà
  // không phải kéo xuống dò cả checklist dài bên dưới.
  const missingRequiredItems = checklist.items.filter((s) => !s.item.isOptional && !s.complete);
  // Đánh số theo đúng vị trí trong checklist đầy đủ bên dưới (khớp với số hiển thị ở
  // ChecklistSection) — để nhân viên đối chiếu nhanh từ banner này xuống đúng mục trong
  // checklist dài bên dưới, không phải dò tên bằng mắt.
  const checklistNumberById = new Map(checklist.items.map((s, i) => [s.item.id, i + 1]));

  return (
    <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-10 flex flex-col gap-7">
      {/* Thông báo nổi góc dưới phải, tự tắt sau 5 giây. Đặt fixed để không đẩy layout —
          nội dung trang không được nhảy chỗ ngay lúc nhân viên vừa thao tác xong. */}
      {emailNotice ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-lg animate-[fadeInUp_.25s_ease-out]"
        >
          <span aria-hidden="true" className="text-lg leading-none">
            ✉️
          </span>
          <div>
            <p className="text-sm font-semibold text-emerald-900">{emailNotice}</p>
            <p className="mt-0.5 text-xs text-emerald-700">
              Gửi tới hộp thư quản trị. Thông báo này tự tắt sau 5 giây.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEmailNotice(null)}
            aria-label="Đóng thông báo"
            className="ml-1 text-emerald-600 hover:text-emerald-900 transition-colors"
          >
            ✕
          </button>
        </div>
      ) : null}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-500 hover:text-indigo-600 transition-colors"
        >
          ← Quay lại danh sách hồ sơ
        </Link>
        <Link
          href={`/cases/${caseId}/summary`}
          className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
        >
          📋 Xem tổng hợp thông tin
        </Link>
      </div>

      <section
        className="rounded-2xl border-2 border-neutral-200 bg-white p-5 shadow-sm"
        style={{
          borderLeftColor: APPLICATION_STATUS_HEX_COLOR[c.applicationStatus],
          borderLeftWidth: 6,
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-indigo-600">
              Trạng thái hồ sơ
            </p>
            <span
              className={`mt-2 inline-flex rounded-full border px-3 py-1 text-sm font-semibold ${APPLICATION_STATUS_BADGE_CLASS[c.applicationStatus]}`}
            >
              {applicationStatus.label}
            </span>
            <p className="mt-2 text-sm text-neutral-600">{applicationStatus.description}</p>
          </div>
          <label className="min-w-56">
            <span className="mb-1.5 block text-xs font-semibold text-neutral-600">
              Cập nhật trạng thái
            </span>
            <select
              value={c.applicationStatus}
              disabled={statusSaving}
              onChange={(event) =>
                void updateApplicationStatus(event.target.value as ApplicationStatus)
              }
              className={`w-full rounded-xl border-2 px-3 py-2 text-sm font-semibold outline-none transition focus:border-indigo-400 disabled:opacity-50 ${APPLICATION_STATUS_BADGE_CLASS[c.applicationStatus]}`}
            >
              {APPLICATION_STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {FINAL_APPLICATION_STATUSES.has(c.applicationStatus) ? (
          <p className="mt-3 text-xs font-medium text-neutral-500">
            Hồ sơ đã có kết quả cuối nên không còn tính lịch nhắc admin.
          </p>
        ) : (
          <p
            className={`mt-3 text-xs font-medium ${
              c.statusReminderDue ? "text-rose-700" : "text-neutral-500"
            }`}
          >
            {c.statusReminderDue ? "Đã đến hạn nhắc admin" : "Mốc nhắc admin tiếp theo"}
            {c.nextStatusReminderAt
              ? `: ${REMINDER_DATE_FORMATTER.format(parseUtcDate(c.nextStatusReminderAt))}`
              : ""}
            {` · chu kỳ ${c.statusReminderIntervalDays} ngày/lần cho đến khi đậu hoặc rớt.`}
          </p>
        )}
        {statusError && <p className="mt-2 text-sm text-red-600">{statusError}</p>}
      </section>

      {hasProcessingDocs && (
        <div className="bg-amber-50 border-2 border-amber-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="h-4 w-4 shrink-0 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
            <p className="text-sm text-amber-800 flex-1">
              Đang xử lý {processedCount}/{totalTrackedDocs} file — trang sẽ tự cập nhật khi xong, không cần F5.
              {mounted && totalRemainingEstimate > 0 && (
                <>
                  {" "}Dự kiến toàn bộ <span className="font-bold">{formatRemaining(totalRemainingEstimate)}</span>.
                </>
              )}
            </p>
            <span className="text-xs font-bold text-amber-700 shrink-0">{processedPercent}%</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-amber-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-400 transition-all"
              style={{ width: `${processedPercent}%` }}
            />
          </div>
          <DocumentScene3D
            cheDo="xu-ly"
            tienDo={processedPercent}
            className="mt-3 h-36 rounded-xl border border-indigo-200 shadow-inner"
          />
          {/* Ước tính "còn khoảng bao lâu" chỉ là ƯỚC TÍNH MỀM (xem estimateProcessingSeconds ở
              lib/format.ts) — thời gian thật đo được dao động từ vài giây đến hơn 7 phút tuỳ độ
              khó tài liệu, không thể chính xác tuyệt đối. Đếm lùi dần theo giây (nowTick) cho
              cảm giác trực quan "đang chạy", và tự chuyển sang "sắp xong..." khi ước tính đã hết
              mà file vẫn chưa xong, thay vì đứng ở số 0 hoặc chạy âm trông như bị lỗi.*/}
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {processingDocs.map((d) => {
              const elapsedSeconds = Math.floor((nowTick - parseUtcDate(d.uploadedAt).getTime()) / 1000);
              const remaining = Math.max(0, estimateProcessingSeconds(d.pageCount) - elapsedSeconds);
              return (
                <li key={d.id} className="text-xs text-amber-700 truncate">
                  <span className="font-semibold">{d.originalFilename}</span>
                  {" — "}
                  {STAGE_LABEL[d.status] ?? "đang chờ xử lý..."}
                  {mounted && (
                    <>
                      {" · "}
                      <span className="font-semibold">{formatRemaining(remaining)}</span>
                    </>
                  )}
                  {d.pageCount && d.pageCount > 1
                    ? ` (${d.pageCount} trang — cần phân tích kỹ hơn, có thể lâu hơn các file khác)`
                    : ""}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div
        className={isComplete ? "border-2 border-green-300 bg-green-50 rounded-2xl p-5" : ""}
      >
        <h1 className="text-3xl font-bold text-neutral-800">{c.clientName}</h1>
        <p className="text-sm text-neutral-500 mt-1.5">
          {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
          {c.numberOfChildren > 0 ? ` · ${c.numberOfChildren} con` : ""}
          {" · "}
          {c.skillLevel === "HIGH_SKILL" ? "High Skilled" : "Low Skilled"}
          {" · Hoàn thành "}
          <span className={`font-bold ${isComplete ? "text-green-700" : "text-indigo-600"}`}>
            {checklist.percent}%
          </span>
          {" ("}
          {checklist.completedRequiredItems}/{checklist.totalRequiredItems} mục bắt buộc)
        </p>
        {c.notes && <p className="text-sm text-neutral-500 mt-1">Ghi chú: {c.notes}</p>}

        {/* Tag badges + picker */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {caseTags.map((tag) => (
            <button
              key={tag}
              onClick={() => removeTag(tag)}
              disabled={tagSaving}
              title={`Bỏ nhãn "${tag}"`}
              className={`group rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-all hover:opacity-80 disabled:opacity-50 ${
                TAG_COLOR_MAP[tagColorByName.get(tag) ?? ""] ?? TAG_COLOR_MAP.gray
              }`}
            >
              {tag}
              <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity">×</span>
            </button>
          ))}
          <div className="relative">
            <button
              onClick={() => setShowTagPicker(!showTagPicker)}
              disabled={tagSaving}
              className="h-6 w-6 rounded-full border-2 border-dashed border-neutral-300 text-neutral-400 hover:border-indigo-400 hover:text-indigo-500 transition-colors text-sm font-bold leading-none disabled:opacity-50"
              title="Thêm nhãn"
            >
              +
            </button>
            {showTagPicker && (
              <div className="absolute left-0 top-8 z-20 min-w-[180px] rounded-xl border border-neutral-200 bg-white p-1.5 shadow-lg">
                {tagDefs
                  .filter((t) => !caseTags.includes(t.name))
                  .map((t) => (
                    <button
                      key={t.name}
                      onClick={() => addTag(t.name)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 transition-colors text-left"
                    >
                      <span
                        className={`inline-block h-2.5 w-2.5 rounded-full border ${
                          TAG_COLOR_MAP[t.color] ?? TAG_COLOR_MAP.gray
                        }`}
                      />
                      {t.name}
                    </button>
                  ))}
                {tagDefs.filter((t) => !caseTags.includes(t.name)).length === 0 && (
                  <p className="px-3 py-1.5 text-xs text-neutral-400">Đã gắn hết nhãn</p>
                )}
              </div>
            )}
          </div>
        </div>

        {isComplete && (
          <p className="text-sm text-green-700 font-semibold mt-2">
            ✓ Checklist giấy tờ đã hoàn thành
          </p>
        )}
      </div>

      {missingRequiredItems.length > 0 && (
        <div className="border-2 border-amber-200 bg-amber-50 rounded-2xl p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-700 mb-2">
            Còn thiếu {missingRequiredItems.length} mục bắt buộc
          </p>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            {missingRequiredItems.map((s) => (
              <li key={s.item.id} className="text-sm text-amber-900">
                <span className="font-semibold">{checklistNumberById.get(s.item.id)}.</span>{" "}
                {s.item.nameVi}
                {s.requiredCount > 1 && ` (${s.fulfilledCount}/${s.requiredCount} đã có)`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Đặt TRƯỚC mọi thứ khác trong phần thân: giấy tờ đã quá hạn làm hồ sơ trông đủ mà
          thực chất không dùng được — nhân viên phải thấy trước khi kịp nghĩ hồ sơ đã xong. */}
      <DocChecksPanel checks={data.docChecks} onChanged={refetch} />

      <GeneralNotesBanner />

      <SavingsCard
        caseId={caseId}
        threshold={data.financialThreshold}
        savings={data.savings}
        onChanged={refetch}
      />

      <div>
        <h2 className="text-lg font-bold text-neutral-800 mb-3">Upload hồ sơ</h2>
        <UploadDropzone caseId={caseId} documents={c.documents} onUploaded={refetch} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-neutral-800">File đã upload</h2>
          {c.documents.length > 0 && (
            <button
              onClick={async () => {
                if (!confirm(`Xoá tất cả ${c.documents.length} file đã upload của hồ sơ này?`)) return;
                await fetch(`${API_URL}/cases/${caseId}/documents`, { method: "DELETE" });
                refetch();
              }}
              className="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
            >
              Xoá tất cả
            </button>
          )}
        </div>
        <DocumentList
          documents={c.documents}
          applicableItems={checklist.items.map((s) => s.item)}
          onChanged={refetch}
        />
      </div>

      <div>
        <h2 className="text-lg font-bold text-neutral-800 mb-3">Checklist</h2>
        <ChecklistSection items={checklist.items} />
      </div>
    </main>
  );
}
