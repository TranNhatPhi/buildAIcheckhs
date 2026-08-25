"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL } from "@/lib/format";
import type { DocumentDTO } from "@/lib/client-types";

interface Props {
  caseId: string;
  // Danh sách document hiện có của case — dùng để tra trạng thái OCR/AI thật (theo tên
  // file) cho từng file đang trong hàng đợi upload, thay vì chỉ hiện chữ "đang xử lý..."
  // chung chung không rõ đang ở bước nào.
  documents: DocumentDTO[];
  onUploaded: () => void;
}

const STAGE_LABEL: Partial<Record<DocumentDTO["status"], string>> = {
  OCR_RUNNING: "Bước 1/2 — đang đọc OCR...",
  CLASSIFYING: "Bước 2/2 — đang phân loại AI...",
};

interface FileProgress {
  id: string;
  name: string;
  status: "uploading" | "done" | "error" | "cancelled";
  error?: string;
}

const MAX_CONCURRENT = 2;

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
            if (!res.ok) throw new Error(await res.text());
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
  const successCount = useMemo(() => queue.filter((q) => q.status === "done").length, [queue]);
  const errorCount = useMemo(() => queue.filter((q) => q.status === "error").length, [queue]);
  const cancelledCount = useMemo(() => queue.filter((q) => q.status === "cancelled").length, [queue]);
  const isProcessing = pendingCount > 0;

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
        <div className="mt-3 flex items-center gap-3 bg-amber-50 border-2 border-amber-200 rounded-xl px-4 py-3">
          <span className="h-4 w-4 shrink-0 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
          <p className="text-sm text-amber-800 flex-1">
            <span className="font-semibold">
              Đang xử lý {doneCount}/{queue.length} file...
            </span>{" "}
            Mỗi file cần chạy OCR + AI phân loại, có thể mất khoảng 30–60 giây (đôi khi lâu hơn)
            — vui lòng chờ một chút, đừng tắt trang.
          </p>
          <button
            onClick={stopUpload}
            className="shrink-0 rounded-full bg-white border border-amber-300 text-amber-800 text-xs font-semibold px-3 py-1.5 hover:bg-amber-100"
          >
            Dừng tải lên
          </button>
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
              <span className="truncate">{q.name}</span>
              {q.status === "uploading" && (
                <span className="text-xs text-neutral-400">
                  {(() => {
                    const doc = documents.find((d) => d.originalFilename === q.name);
                    if (doc && STAGE_LABEL[doc.status]) return STAGE_LABEL[doc.status];
                    return "đang tải file lên...";
                  })()}
                </span>
              )}
              {q.status === "error" && <span className="text-red-600 text-xs">{q.error}</span>}
              {q.status === "cancelled" && (
                <span className="text-neutral-400 text-xs">đã dừng, chưa tải lên</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
