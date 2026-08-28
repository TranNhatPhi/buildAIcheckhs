"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL, estimateProcessingSeconds, formatRemaining, parseUtcDate } from "@/lib/format";
import type { DocumentDTO } from "@/lib/client-types";

interface Props {
  caseId: string;
  // Danh sách document hiện có của case — dùng để tra trạng thái OCR/AI thật (theo tên
  // file) cho từng file đang trong hàng đợi upload, thay vì chỉ hiện chữ "đang xử lý..."
  // chung chung không rõ đang ở bước nào.
  documents: DocumentDTO[];
  onUploaded: () => void;
}

// Export để CaseDetail.tsx dùng chung — tránh lặp lại chuỗi ở 2 nơi cho cùng 1 khái niệm.
export const STAGE_LABEL: Partial<Record<DocumentDTO["status"], string>> = {
  OCR_RUNNING: "Bước 1/2 — đang đọc tài liệu...",
  CLASSIFYING: "Bước 2/2 — đang phân loại AI...",
};

interface FileProgress {
  id: string;
  name: string;
  // "duplicate" tách riêng khỏi "error": file trùng KHÔNG phải lỗi (không có gì hỏng, không
  // cần người dùng sửa gì) — hiện màu đỏ như lỗi thật sẽ làm nhân viên tưởng hồ sơ có vấn đề
  // và đi tìm cách khắc phục một việc vốn đã đúng như mong đợi.
  status: "uploading" | "done" | "error" | "cancelled" | "duplicate";
  error?: string;
}

// Khớp đúng số lượng DeepSeek API key đang round-robin (classify.py: DEEPSEEK_API_KEY +
// LLM_API_KEY_2/3/4 = 4 key) — đây là giới hạn tài nguyên "cứng" hơn cả (mỗi key có rate
// limit riêng), nên nâng lên bao nhiêu cũng vô ích nếu vượt quá số key sẵn có. Trước đây
// để 2 dù đã có 4 key, khiến 1 đợt upload nhiều file chỉ tận dụng được nửa số key.
const MAX_CONCURRENT = 4;

export function UploadDropzone({ caseId, documents, onUploaded }: Props) {
  const [queue, setQueue] = useState<FileProgress[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Chỉ chặn các file CHƯA bắt đầu upload (chưa gọi fetch) — file đang xử lý dở (đã gửi lên
  // backend, đang OCR/phân loại) vẫn để chạy tiếp tự nhiên, vì không có endpoint huỷ upload
  // giữa chừng (khác với huỷ phân tích AI ở CaseSummary.tsx) — dừng nửa chừng dễ để lại
  // document kẹt ở trạng thái OCR_RUNNING/CLASSIFYING mãi mãi.
  const cancelledRef = useRef(false);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      cancelledRef.current = false;
      const list = Array.from(files);
      const entries: FileProgress[] = list.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        status: "uploading",
      }));
      setQueue((prev) => [...prev, ...entries]);

      let cursor = 0;
      async function worker() {
        while (cursor < list.length && !cancelledRef.current) {
          const index = cursor++;
          const file = list[index];
          const entry = entries[index];
          // Nudge sớm để CaseDetail bắt được document vừa tạo (status OCR_RUNNING backend
          // đã commit ngay khi bắt đầu xử lý) — từ đó tự polling và hiện tiến trình thật
          // (OCR → phân loại AI) ở phần "File đã upload" bên dưới, không phải đợi hết cả
          // request (30-60s) mới thấy gì.
          const nudgeTimer = setTimeout(onUploaded, 1200);
          try {
            const form = new FormData();
            form.append("file", file);
            const res = await fetch(`${API_URL}/cases/${caseId}/documents`, {
              method: "POST",
              body: form,
            });
            if (!res.ok) {
              // Backend trả lỗi dạng {"detail": "..."} (chuẩn FastAPI) — lấy đúng câu tiếng
              // Việt bên trong thay vì ném nguyên chuỗi JSON thô lên giao diện.
              const raw = await res.text();
              let message = raw;
              try {
                message = JSON.parse(raw).detail ?? raw;
              } catch {
                // Không phải JSON (vd 502 do Caddy tự trả lúc backend đang khởi động lại) —
                // giữ nguyên nội dung thô, vẫn hơn là không hiện gì.
              }
              // 409 = file trùng, backend đã bỏ qua có chủ đích (xem case_documents.py:
              // _find_duplicate) — không phải lỗi cần báo động.
              if (res.status === 409) {
                setQueue((prev) =>
                  prev.map((q) =>
                    q.id === entry.id ? { ...q, status: "duplicate", error: message } : q
                  )
                );
                // `continue` (KHÔNG phải `return`): chỉ bỏ qua file này rồi lấy file kế
                // tiếp — `return` sẽ kết thúc luôn cả worker, mất 1 trong 4 luồng xử lý
                // song song mỗi khi gặp 1 file trùng. Khối `finally` vẫn chạy trước khi
                // sang vòng lặp kế tiếp, nên timer/nudge vẫn được dọn đúng.
                continue;
              }
              throw new Error(message);
            }
            setQueue((prev) =>
              prev.map((q) => (q.id === entry.id ? { ...q, status: "done" } : q))
            );
          } catch (e) {
            setQueue((prev) =>
              prev.map((q) =>
                q.id === entry.id
                  ? { ...q, status: "error", error: e instanceof Error ? e.message : "Lỗi upload" }
                  : q
              )
            );
          } finally {
            clearTimeout(nudgeTimer);
            onUploaded();
          }
        }
      }

      await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));

      if (cancelledRef.current) {
        setQueue((prev) =>
          prev.map((q) => (q.status === "uploading" ? { ...q, status: "cancelled" } : q))
        );
      }
    },
    [caseId, onUploaded]
  );

  const stopUpload = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const pendingCount = useMemo(() => queue.filter((q) => q.status === "uploading").length, [queue]);
  const doneCount = useMemo(() => queue.filter((q) => q.status !== "uploading").length, [queue]);
  const uploadPercent = queue.length > 0 ? Math.round((doneCount / queue.length) * 100) : 0;
  const successCount = useMemo(() => queue.filter((q) => q.status === "done").length, [queue]);
  const errorCount = useMemo(() => queue.filter((q) => q.status === "error").length, [queue]);
  const cancelledCount = useMemo(() => queue.filter((q) => q.status === "cancelled").length, [queue]);
  const duplicateCount = useMemo(() => queue.filter((q) => q.status === "duplicate").length, [queue]);
  const isProcessing = pendingCount > 0;

  // F5/đóng tab giữa chừng sẽ HUỶ NGANG các file CHƯA kịp gửi lên — trình duyệt không giữ
  // được nội dung file đã chọn (File object) qua 1 lần reload, đây là giới hạn bảo mật của
  // trình duyệt chứ không phải lỗi code, KHÔNG thể khắc phục hoàn toàn phía frontend (không
  // có cách "phục hồi" file đã chọn sau reload mà không cần người dùng chọn lại). Các file ĐÃ
  // gửi lên rồi (đang ở "Bước 1/2"/"Bước 2/2", đã có dòng Document phía backend) thì AN TOÀN
  // — backend xử lý độc lập với kết nối trình duyệt, F5 xong quay lại trang vẫn thấy chạy tiếp
  // (banner ở CaseDetail.tsx tự nhận lại đúng các file đó qua dữ liệu server, không cần
  // queue này). Để tránh mất OAN các file CHƯA kịp gửi, cảnh báo trước khi rời trang.
  useEffect(() => {
    if (!isProcessing) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isProcessing]);

  // Đồng hồ đếm ngược riêng (1s/lần) để tính lại "còn khoảng bao lâu" cho từng file — xem
  // giải thích chi tiết ở CaseDetail.tsx (dùng chung logic, khác chỗ hiển thị). Khởi tạo bằng
  // 0 (không phải Date.now()) dù component này thực ra không dính lỗi hydration mismatch như
  // CaseDetail.tsx (isProcessing chỉ true sau khi người dùng tự thao tác upload, luôn xảy ra
  // SAU khi trang đã hydrate xong) — vẫn giữ cùng pattern an toàn cho nhất quán, tránh rủi ro
  // nếu sau này component đổi cách dùng.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (!isProcessing) return;
    setNowTick(Date.now());
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  // Ước tính tổng thời gian còn lại cho CẢ ĐỢT upload — gồm 2 phần: (1) thời gian của file
  // ĐANG CHẠY lâu nhất (chạy song song, đợt chỉ xong khi file chậm nhất trong nhóm đang chạy
  // xong), cộng (2) thời gian cho các file CÒN XẾP HÀNG chưa tới lượt (chưa có dòng Document
  // — nghĩa là chưa có worker nào rảnh để nhận), ước tính theo số "đợt" cần chờ thêm
  // (waitingCount / MAX_CONCURRENT, làm tròn lên) nhân với thời gian trung bình 1 file.
  const totalRemainingEstimate = useMemo(() => {
    let activeMax = 0;
    let waitingCount = 0;
    for (const q of queue) {
      if (q.status !== "uploading") continue;
      const doc = documents.find((d) => d.originalFilename === q.name);
      if (doc && STAGE_LABEL[doc.status]) {
        const elapsedSeconds = Math.floor((nowTick - parseUtcDate(doc.uploadedAt).getTime()) / 1000);
        const remaining = Math.max(0, estimateProcessingSeconds(doc.pageCount) - elapsedSeconds);
        activeMax = Math.max(activeMax, remaining);
      } else {
        waitingCount++;
      }
    }
    const queueWaves = Math.ceil(waitingCount / MAX_CONCURRENT);
    return activeMax + queueWaves * estimateProcessingSeconds(null);
  }, [queue, documents, nowTick]);

  // Hiện popup thông báo kết quả khi vừa xử lý xong 1 đợt upload (chuyển từ đang xử lý ->
  // hết), tự ẩn sau 5 giây — không hiện lại nếu trang chỉ re-render bình thường, và tắt
  // ngay nếu người dùng bắt đầu thả thêm file mới trong lúc thông báo còn đang hiện.
  const [showResult, setShowResult] = useState(false);
  useEffect(() => {
    if (isProcessing) {
      setShowResult(false);
      return;
    }
    if (queue.length === 0) return;
    setShowResult(true);
    const timer = setTimeout(() => setShowResult(false), 5000);
    return () => clearTimeout(timer);
  }, [isProcessing, queue.length]);

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors ${
          dragOver ? "border-indigo-400 bg-indigo-50" : "border-neutral-300 hover:border-indigo-300 hover:bg-neutral-50"
        }`}
      >
        <p className="text-sm font-medium text-neutral-600">
          Kéo thả file vào đây, hoặc{" "}
          <span className="text-indigo-600 font-semibold underline">bấm để chọn file</span>
        </p>
        <p className="text-xs text-neutral-400 mt-1">Ảnh (jpg, png) hoặc PDF — có thể chọn nhiều file cùng lúc</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {isProcessing && (
        <div className="mt-3 bg-amber-50 border-2 border-amber-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="h-4 w-4 shrink-0 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
            <p className="text-sm text-amber-800 flex-1">
              <span className="font-semibold">
                Đang xử lý {doneCount}/{queue.length} file...
              </span>{" "}
              Mỗi file cần đọc nội dung + AI phân loại — thời gian tuỳ độ khó từng file, đừng tắt
              trang, trang sẽ tự cập nhật.
              {totalRemainingEstimate > 0 && (
                <>
                  {" "}Dự kiến toàn bộ <span className="font-bold">{formatRemaining(totalRemainingEstimate)}</span>.
                </>
              )}
            </p>
            <span className="text-xs font-bold text-amber-700 shrink-0">{uploadPercent}%</span>
            <button
              onClick={stopUpload}
              className="shrink-0 rounded-full bg-white border border-amber-300 text-amber-800 text-xs font-semibold px-3 py-1.5 hover:bg-amber-100"
            >
              Dừng tải lên
            </button>
          </div>
          <div className="mt-2 h-2 rounded-full bg-amber-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-400 transition-all"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
        </div>
      )}

      {showResult && !isProcessing && (
        <div
          className={`fixed top-6 right-6 z-50 flex items-start gap-3 border-2 rounded-xl px-4 py-3 shadow-lg max-w-sm animate-[fadeIn_0.2s_ease-out] ${
            errorCount > 0 || cancelledCount > 0 ? "bg-amber-50 border-amber-200" : "bg-green-50 border-green-200"
          }`}
        >
          <span className={errorCount > 0 || cancelledCount > 0 ? "text-amber-600" : "text-green-600"}>
            {errorCount > 0 || cancelledCount > 0 ? "⚠" : "✓"}
          </span>
          <p className={`text-sm flex-1 ${errorCount > 0 || cancelledCount > 0 ? "text-amber-800" : "text-green-800"}`}>
            {cancelledCount > 0
              ? `Đã dừng — ${successCount}/${queue.length} file đã tải lên xong, ${cancelledCount} file chưa tải (${errorCount} lỗi).`
              : errorCount > 0
              ? `Đã xử lý xong ${successCount}/${queue.length} file — ${errorCount} file bị lỗi, kiểm tra lại bên dưới.`
              : duplicateCount > 0
              ? `Đã tải lên và phân tích xong ${successCount} file — ${duplicateCount} file đã có sẵn trong hồ sơ nên được bỏ qua.`
              : `Đã tải lên và phân tích xong ${successCount} file thành công.`}
          </p>
          <button
            onClick={() => setShowResult(false)}
            className={`shrink-0 text-lg leading-none ${errorCount > 0 || cancelledCount > 0 ? "text-amber-500 hover:text-amber-700" : "text-green-500 hover:text-green-700"}`}
            aria-label="Đóng thông báo"
          >
            ×
          </button>
        </div>
      )}

      {queue.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {queue.map((q) => (
            <li key={q.id} className="flex items-center gap-2">
              {q.status === "uploading" && (
                <span className="h-3 w-3 shrink-0 rounded-full border-2 border-neutral-300 border-t-indigo-500 animate-spin" />
              )}
              {q.status === "done" && <span className="text-green-600">✓</span>}
              {q.status === "error" && <span className="text-red-600">✗</span>}
              {q.status === "cancelled" && <span className="text-neutral-400">⏸</span>}
              {q.status === "duplicate" && <span className="text-neutral-400">⊘</span>}
              <span className="truncate">{q.name}</span>
              {q.status === "uploading" && (
                <span className="text-xs text-neutral-400">
                  {(() => {
                    const doc = documents.find((d) => d.originalFilename === q.name);
                    if (!doc || !STAGE_LABEL[doc.status]) return "đang tải file lên...";
                    const elapsedSeconds = Math.floor((nowTick - parseUtcDate(doc.uploadedAt).getTime()) / 1000);
                    const remaining = Math.max(0, estimateProcessingSeconds(doc.pageCount) - elapsedSeconds);
                    return `${STAGE_LABEL[doc.status]} · ${formatRemaining(remaining)}`;
                  })()}
                </span>
              )}
              {q.status === "error" && <span className="text-red-600 text-xs">{q.error}</span>}
              {q.status === "cancelled" && (
                <span className="text-neutral-400 text-xs">đã dừng, chưa tải lên</span>
              )}
              {q.status === "duplicate" && (
                <span className="text-neutral-500 text-xs">đã có sẵn trong hồ sơ — bỏ qua</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
