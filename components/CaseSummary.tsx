"use client";

import { useState } from "react";
import { API_URL } from "@/lib/format";
import type { CaseAnalysisResponse, ChecklistItemStatusDTO, DocumentDTO } from "@/lib/client-types";

interface Props {
  caseId: string;
  items: ChecklistItemStatusDTO[];
}

function groupBy(items: ChecklistItemStatusDTO[]) {
  const map = new Map<string, ChecklistItemStatusDTO[]>();
  for (const s of items) {
    const key = `${s.item.section}::${s.item.group}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return map;
}

export function CaseSummary({ caseId, items }: Props) {
  const [previewDoc, setPreviewDoc] = useState<DocumentDTO | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  async function runAnalysis() {
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const res = await fetch(`${API_URL}/cases/${caseId}/analyze`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setAnalysisError(body?.detail || `Không phân tích được (HTTP ${res.status})`);
        return;
      }
      const data: CaseAnalysisResponse = await res.json();
      setAnalysis(data.summary);
    } catch {
      setAnalysisError("Mất kết nối tới server trong lúc phân tích — thử bấm lại sau.");
    } finally {
      setAnalyzing(false);
    }
  }

  // Chỉ hiện mục ĐÃ có ít nhất 1 file khớp — đây là trang tổng hợp thông tin khách ĐÃ GỬI,
  // khác với trang checklist chính (hiện cả mục còn thiếu).
  const itemsWithDocs = items.filter((s) => s.matchedDocuments.length > 0);

  if (itemsWithDocs.length === 0) {
    return (
      <p className="text-neutral-500">
        Chưa có file nào được phân loại — chưa có thông tin để tổng hợp.
      </p>
    );
  }

  const grouped = groupBy(itemsWithDocs);

  return (
    <div className="flex flex-col gap-7">
      <div>
        <button
          onClick={runAnalysis}
          disabled={analyzing}
          className="text-sm font-semibold px-4 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {analyzing && (
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-white/40 border-t-white animate-spin" />
          )}
          🧠 {analyzing ? "Đang phân tích..." : analysis ? "Phân tích lại" : "Phân tích AI chuyên sâu"}
        </button>
        {analyzing && (
          <p className="text-xs text-neutral-400 mt-2">
            AI đang đọc toàn bộ thông tin đã trích xuất để tóm tắt và đối chiếu chéo giữa các
            giấy tờ — có thể mất khoảng 30–60 giây, vui lòng chờ...
          </p>
        )}
        {analysisError && <p className="text-sm text-red-600 mt-2">{analysisError}</p>}
        {analysis && (
          <div className="mt-4 border-2 border-indigo-200 rounded-2xl p-4 bg-indigo-50">
            <p className="text-xs font-bold uppercase tracking-wide text-indigo-600 mb-2">
              Tóm tắt phân tích AI
            </p>
            <p className="text-sm text-neutral-800 leading-relaxed whitespace-pre-wrap">
              {analysis}
            </p>
          </div>
        )}
      </div>

      {[...grouped.entries()].map(([key, statuses]) => {
        const [section, group] = key.split("::");
        return (
          <div key={key}>
            <h3 className="text-xs font-bold uppercase tracking-wide text-indigo-600 mb-3">
              {section === "A" ? "Hồ sơ đương đơn" : "Hồ sơ người phụ thuộc"} — {group}
            </h3>
            <div className="flex flex-col gap-4">
              {statuses.map((s) => (
                <div key={s.item.id}>
                  <h4 className="text-sm font-semibold text-neutral-800 mb-2">{s.item.nameVi}</h4>
                  <div className="flex flex-col gap-2">
                    {s.matchedDocuments.map((doc) => {
                      const text = doc.correctedText || doc.ocrText;
                      return (
                        <div key={doc.id} className="border-2 border-neutral-200 rounded-xl p-3.5 bg-white">
                          <div className="flex items-center gap-2 mb-2">
                            {doc.mimeType.startsWith("image/") ? (
                              <button
                                onClick={() => setPreviewDoc(doc)}
                                className="text-xs font-semibold text-neutral-500 hover:text-indigo-600 underline decoration-neutral-300 truncate text-left"
                              >
                                {doc.originalFilename}
                              </button>
                            ) : (
                              <a
                                href={`${API_URL}/documents/${doc.id}/file`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs font-semibold text-neutral-500 hover:text-indigo-600 underline decoration-neutral-300 truncate"
                              >
                                {doc.originalFilename}
                              </a>
                            )}
                            {doc.isManualOverride && (
                              <span className="text-[11px] font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full shrink-0">
                                đã chỉnh tay
                              </span>
                            )}
                          </div>
                          <pre className="text-sm whitespace-pre-wrap font-sans text-neutral-700 leading-relaxed">
                            {text || "(không đọc được nội dung text từ file này)"}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

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
    </div>
  );
}
