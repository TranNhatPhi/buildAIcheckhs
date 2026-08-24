"use client";

import { useState } from "react";
import { FormattedDocumentText } from "@/components/FormattedDocumentText";
import { API_URL } from "@/lib/format";
import type { ChecklistItemDTO, DocumentDTO } from "@/lib/client-types";

interface Props {
  documents: DocumentDTO[];
  applicableItems: ChecklistItemDTO[];
  onChanged: () => void;
}

const STATUS_LABEL: Record<DocumentDTO["status"], string> = {
  PENDING: "Đang chờ",
  OCR_RUNNING: "Đang đọc OCR...",
  CLASSIFYING: "Đang phân loại...",
  CLASSIFIED: "Đã phân loại",
  NEEDS_REVIEW: "Cần xem lại",
  MANUALLY_SET: "Đã chỉnh tay",
  ERROR: "Lỗi",
};

const STATUS_COLOR: Record<DocumentDTO["status"], string> = {
  PENDING: "bg-neutral-100 text-neutral-600",
  OCR_RUNNING: "bg-sky-100 text-sky-700",
  CLASSIFYING: "bg-sky-100 text-sky-700",
  CLASSIFIED: "bg-green-100 text-green-700",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800",
  MANUALLY_SET: "bg-blue-100 text-blue-700",
  ERROR: "bg-red-100 text-red-700",
};

export function DocumentList({ documents, applicableItems, onChanged }: Props) {
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentDTO | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingText, setSavingText] = useState(false);

  function startEditingText(doc: DocumentDTO) {
    setEditingTextId(doc.id);
    setEditValue(doc.manualCorrectedText ?? doc.correctedText ?? "");
  }

  function cancelEditingText() {
    setEditingTextId(null);
    setEditValue("");
  }

  async function saveEditedText(docId: string) {
    setSavingText(true);
    try {
      await fetch(`${API_URL}/documents/${docId}/corrected-text`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualCorrectedText: editValue }),
      });
    } catch {
      setSavingText(false);
      alert("Không kết nối được server — không lưu được, thử lại sau.");
      return;
    }
    setSavingText(false);
    setEditingTextId(null);
    setEditValue("");
    onChanged();
  }

  async function reassign(docId: string, checklistItemId: string) {
    try {
      await fetch(`${API_URL}/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchedChecklistItemId: checklistItemId || null }),
      });
    } catch {
      alert("Không kết nối được server — kiểm tra lại kết nối và thử lại.");
      return;
    }
    onChanged();
  }

  async function reclassify(docId: string) {
    setAnalyzingId(docId);
    // Nudge sớm để lấy trạng thái OCR_RUNNING vừa được backend commit ngay khi bắt đầu xử
    // lý — không đợi hết cả request (30-60s) mới thấy cập nhật. Sau nudge này,
    // CaseDetail tự polling định kỳ vì thấy có document đang xử lý, nên badge trạng thái
    // (STATUS_LABEL) sẽ tự chuyển "Đang đọc OCR..." → "Đang phân loại..." theo tiến trình
    // thật ở backend, không phải % giả lập.
    const nudgeTimer = setTimeout(onChanged, 1200);
    try {
      await fetch(`${API_URL}/documents/${docId}/reclassify`, { method: "POST" });
    } catch {
      // Mất kết nối server giữa chừng (vd server restart lúc đang chạy OCR/AI) — bắt lỗi
      // ở đây thay vì để "Failed to fetch" văng thẳng lên UI thành lỗi chưa xử lý. Vẫn
      // refetch ở finally bên dưới vì server có thể đã xử lý xong trước khi mất kết nối.
      alert("Mất kết nối tới server trong lúc phân tích lại — thử bấm lại sau.");
    } finally {
      clearTimeout(nudgeTimer);
      setAnalyzingId(null);
      onChanged();
    }
  }

  async function remove(docId: string) {
    if (!confirm("Xoá file này khỏi hồ sơ?")) return;
    try {
      await fetch(`${API_URL}/documents/${docId}`, { method: "DELETE" });
    } catch {
      alert("Không kết nối được server — không xoá được file, thử lại sau.");
      return;
    }
    onChanged();
  }

  if (documents.length === 0) {
    return <p className="text-sm text-neutral-400">Chưa có file nào được upload.</p>;
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
      {documents.map((doc) => {
        const isExpanded = expandedId === doc.id;
        // Còn đang chạy OCR/AI — khoá dropdown khớp mục lại: nếu cho chọn tay lúc này,
        // request OCR/AI đang chạy dở có thể hoàn tất ngay sau đó và ghi đè mất lựa chọn
        // tay vừa chọn (race condition), gây nhầm lẫn khó chịu cho nhân viên.
        const isProcessing = ["PENDING", "OCR_RUNNING", "CLASSIFYING"].includes(doc.status);
        return (
          <li key={doc.id} className="border-2 border-neutral-200 rounded-2xl p-4 bg-white">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              {doc.mimeType.startsWith("image/") ? (
                <button
                  onClick={() => setPreviewDoc(doc)}
                  className="text-sm font-semibold underline decoration-neutral-300 truncate max-w-xs text-left"
                >
                  {doc.originalFilename}
                </button>
              ) : (
                <a
                  href={`${API_URL}/documents/${doc.id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold underline decoration-neutral-300 truncate max-w-xs"
                >
                  {doc.originalFilename}
                </a>
              )}
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLOR[doc.status]}`}>
                {STATUS_LABEL[doc.status]}
              </span>
            </div>

            <div className="mt-3 flex items-center gap-2 flex-wrap text-sm">
              <span className="text-neutral-500">Khớp mục:</span>
              <select
                className="border-2 border-neutral-200 rounded-lg px-2.5 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-neutral-50"
                value={doc.matchedChecklistItemId ?? ""}
                onChange={(e) => reassign(doc.id, e.target.value)}
                disabled={isProcessing}
                title={isProcessing ? "Đang xử lý OCR/AI, chưa chọn tay được lúc này" : undefined}
              >
                <option value="">Chưa xác định</option>
                {applicableItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.nameVi}
                  </option>
                ))}
              </select>
              {doc.isManualOverride && (
                <span className="text-[11px] font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                  đã chỉnh tay
                </span>
              )}
              {doc.aiConfidence != null && (
                <span className="text-xs text-neutral-400">
                  AI tin cậy: {Math.round(doc.aiConfidence * 100)}%
                </span>
              )}
            </div>

            {doc.classificationError && (
              <p className="text-xs text-red-600 mt-2">{doc.classificationError}</p>
            )}

            <div className="mt-3 flex gap-2 flex-wrap">
              <button
                onClick={() => setExpandedId(isExpanded ? null : doc.id)}
                className="text-xs font-semibold px-3 py-1.5 rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
              >
                {isExpanded ? "Ẩn chi tiết OCR & AI" : "Xem chi tiết OCR & AI"}
              </button>
              <button
                onClick={() => reclassify(doc.id)}
                disabled={analyzingId === doc.id || isProcessing}
                className="text-xs font-semibold px-3 py-1.5 rounded-full bg-sky-50 text-sky-700 hover:bg-sky-100 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {(analyzingId === doc.id || isProcessing) && (
                  <span className="h-3 w-3 shrink-0 rounded-full border-2 border-sky-300 border-t-sky-700 animate-spin" />
                )}
                {analyzingId === doc.id || isProcessing
                  ? doc.status === "CLASSIFYING"
                    ? "Đang phân loại AI..."
                    : doc.status === "OCR_RUNNING"
                      ? "Đang đọc OCR..."
                      : "Đang bắt đầu..."
                  : doc.status === "ERROR"
                    ? "Thử lại"
                    : "Phân tích lại"}
              </button>
              {(analyzingId === doc.id || isProcessing) && (
                <span className="text-xs text-neutral-400 self-center">
                  {doc.status === "CLASSIFYING"
                    ? "Bước 2/2 — AI đang phân loại vào đúng mục checklist, sắp xong..."
                    : doc.status === "OCR_RUNNING"
                      ? "Bước 1/2 — đang đọc chữ từ ảnh (OCR), có thể mất khoảng 10–20 giây..."
                      : "Đang chạy OCR + AI, có thể mất khoảng 30–60 giây, vui lòng chờ một chút..."}
                </span>
              )}
              <button
                onClick={() => remove(doc.id)}
                className="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
              >
                Xoá
              </button>
            </div>

            {isExpanded && (
              <div className="mt-3 flex flex-col gap-3 border-t border-neutral-100 pt-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 mb-1.5">
                    1. Văn bản OCR trích xuất được
                  </p>
                  <FormattedDocumentText
                    text={doc.ocrText}
                    emptyLabel="(chưa có / không đọc được nội dung)"
                    className="text-xs bg-neutral-50 border border-neutral-200 rounded-xl p-3 max-h-56 overflow-y-auto font-mono"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-400">
                      2. Văn bản sau khi DeepSeek sửa chính tả & sắp xếp lại
                    </p>
                    {editingTextId !== doc.id && (
                      <button
                        onClick={() => startEditingText(doc)}
                        disabled={isProcessing}
                        title={isProcessing ? "Đang xử lý OCR/AI, chưa sửa tay được lúc này" : undefined}
                        className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        ✏️ Sửa
                      </button>
                    )}
                  </div>
                  {editingTextId === doc.id ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        rows={12}
                        className="text-xs font-mono w-full border-2 border-neutral-200 rounded-xl p-3 focus:outline-none focus:border-indigo-400"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveEditedText(doc.id)}
                          disabled={savingText}
                          className="text-xs font-semibold px-3 py-1.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
                        >
                          {savingText ? "Đang lưu..." : "Lưu"}
                        </button>
                        <button
                          onClick={cancelEditingText}
                          disabled={savingText}
                          className="text-xs font-semibold px-3 py-1.5 rounded-full bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors disabled:opacity-50"
                        >
                          Huỷ
                        </button>
                      </div>
                    </div>
                  ) : (
                    <FormattedDocumentText
                      text={doc.correctedText}
                      emptyLabel="(chưa sửa được / giữ nguyên văn bản OCR thô)"
                      className="text-xs bg-emerald-50 border border-emerald-200 rounded-xl p-3 max-h-56 overflow-y-auto font-mono"
                    />
                  )}
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 mb-1.5">
                    3. Kết quả phân loại DeepSeek
                  </p>
                  <div className="text-xs bg-indigo-50 border border-indigo-200 rounded-xl p-3 flex flex-col gap-1">
                    <p>
                      <span className="font-semibold">Mục AI chọn:</span>{" "}
                      {doc.aiRawLabel === "unmatched" || !doc.aiRawLabel
                        ? "Không khớp mục nào"
                        : (applicableItems.find((i) => i.id === doc.aiRawLabel)?.nameVi ?? doc.aiRawLabel)}
                    </p>
                    {doc.aiConfidence != null && (
                      <p>
                        <span className="font-semibold">Độ tin cậy:</span>{" "}
                        {Math.round(doc.aiConfidence * 100)}%
                      </p>
                    )}
                    {doc.aiReasoning && (
                      <p>
                        <span className="font-semibold">Lý do AI đưa ra:</span> {doc.aiReasoning}
                      </p>
                    )}
                  </div>
                </div>
                {doc.manualCorrectedText && (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wide text-neutral-400 mb-1.5">
                      4. Văn bản final (đã chỉnh sửa tay)
                    </p>
                    <FormattedDocumentText
                      text={doc.manualCorrectedText}
                      emptyLabel=""
                      className="text-xs bg-amber-50 border border-amber-200 rounded-xl p-3 max-h-56 overflow-y-auto font-mono"
                    />
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
      </ul>

      {previewDoc && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
          onClick={() => setPreviewDoc(null)}
        >
          <div className="relative max-w-4xl max-h-full" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setPreviewDoc(null)}
              className="absolute -top-3 -right-3 h-9 w-9 flex items-center justify-center rounded-full bg-white text-neutral-700 shadow-lg hover:bg-neutral-100 text-lg font-bold"
              aria-label="Đóng"
            >
              ×
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh từ backend MinIO, không phải asset tĩnh nên không dùng next/image được */}
            <img
              src={`${API_URL}/documents/${previewDoc.id}/file`}
              alt={previewDoc.originalFilename}
              className="max-w-full max-h-[85vh] rounded-xl shadow-2xl object-contain"
            />
            <p className="text-center text-white text-sm mt-2">{previewDoc.originalFilename}</p>
          </div>
        </div>
      )}
    </>
  );
}
