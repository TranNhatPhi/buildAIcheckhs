"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChecklistSection } from "@/components/ChecklistSection";
import { DocumentList } from "@/components/DocumentList";
import { GeneralNotesBanner } from "@/components/GeneralNotesBanner";
import { SavingsCard } from "@/components/SavingsCard";
import { STAGE_LABEL, UploadDropzone } from "@/components/UploadDropzone";
import { API_URL, estimateProcessingSeconds, formatRemaining, parseUtcDate } from "@/lib/format";
import type { CaseDetailDTO } from "@/lib/client-types";

interface Props {
  caseId: string;
  // Dữ liệu fetch sẵn từ server (app/cases/[id]/page.tsx) — có ngay khi trang render
  // lần đầu / F5, không phải qua màn "Đang tải..." rồi mới fetch lại phía client.
  initialData: CaseDetailDTO;
}

export function CaseDetail({ caseId, initialData }: Props) {
  const [data, setData] = useState<CaseDetailDTO | null>(initialData);
  const [notFound, setNotFound] = useState(false);

  const refetch = useCallback(async () => {
    const res = await fetch(`${API_URL}/cases/${caseId}`, { cache: "no-store" });
    if (res.status === 404) {
      setNotFound(true);
      return;
    }
    setData(await res.json());
  }, [caseId]);

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
  // QUAN TRỌNG: khởi tạo bằng Date.now() ngay trong useState (vd `useState(() => Date.now())`)
  // gây lỗi hydration mismatch — server render 1 lúc gọi Date.now(), client hydrate lúc SAU đó
  // vài trăm ms gọi Date.now() LẦN NỮA ra số khác, khiến text hiển thị (vd "còn khoảng 59s" vs
  // "1 phút") khác nhau giữa server/client, React coi là lỗi. Khởi tạo bằng giá trị CỐ ĐỊNH
  // (0) — giống nhau tuyệt đối ở cả server lẫn lần render đầu của client — rồi dùng `mounted`
  // để CHỈ hiển thị phần đếm giờ SAU khi đã qua khỏi lần hydrate đầu tiên (trong useEffect,
  // không chạy trên server và không tính vào lần so khớp hydrate).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (!hasProcessingDocs) return;
    setNowTick(Date.now());
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
  // Mục bắt buộc còn thiếu — liệt kê ngay đầu trang để nhân viên biết cần làm gì tiếp mà
  // không phải kéo xuống dò cả checklist dài bên dưới.
  const missingRequiredItems = checklist.items.filter((s) => !s.item.isOptional && !s.complete);
  // Đánh số theo đúng vị trí trong checklist đầy đủ bên dưới (khớp với số hiển thị ở
  // ChecklistSection) — để nhân viên đối chiếu nhanh từ banner này xuống đúng mục trong
  // checklist dài bên dưới, không phải dò tên bằng mắt.
  const checklistNumberById = new Map(checklist.items.map((s, i) => [s.item.id, i + 1]));

  return (
    <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-10 flex flex-col gap-7">
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
        {isComplete && (
          <p className="text-sm text-green-700 font-semibold mt-2">✓ Hồ sơ này đã hoàn thành</p>
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
