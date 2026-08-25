"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedDocumentText } from "@/components/FormattedDocumentText";
import { API_URL } from "@/lib/format";
import type {
  CaseAnalysisResponse,
  CaseDetailDTO,
  ChecklistItemStatusDTO,
  DocumentDTO,
} from "@/lib/client-types";

interface Props {
  caseId: string;
  items: ChecklistItemStatusDTO[];
  initialAnalysisStatus: string;
  initialAnalysisSummary: string | null;
  initialAnalysisError: string | null;
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

export function CaseSummary({
  caseId,
  items,
  initialAnalysisStatus,
  initialAnalysisSummary,
  initialAnalysisError,
}: Props) {
  const [previewDoc, setPreviewDoc] = useState<DocumentDTO | null>(null);
  const [status, setStatus] = useState(initialAnalysisStatus);
  const [analysis, setAnalysis] = useState(initialAnalysisSummary);
  const [analysisError, setAnalysisError] = useState(initialAnalysisError);
  const analyzing = status === "RUNNING";

  // Không có cách nào huỷ NGANG lệnh gọi DeepSeek đang chạy trong thread ở backend (blocking
  // I/O, không phải task async có thể cancel) — bấm "Huỷ" chỉ báo backend đừng ghi kết quả
  // trễ nữa (POST .../analyze/cancel) và bỏ qua ngay tại UI. Cờ này đánh dấu lượt phân tích
  // hiện tại đã bị huỷ, để khi promise của runAnalysis() cuối cùng cũng resolve (có thể vài
  // phút sau), không ghi đè state đã trở về trạng thái nghỉ bằng kết quả không còn ai chờ.
  const cancelledRef = useRef(false);

  const refetchStatus = useCallback(async () => {
    const res = await fetch(`${API_URL}/cases/${caseId}`, { cache: "no-store" });
    if (!res.ok || cancelledRef.current) return;
    const data: CaseDetailDTO = await res.json();
    if (cancelledRef.current) return;
    setStatus(data.case.aiAnalysisStatus);
    setAnalysis(data.case.aiAnalysisSummary);
    setAnalysisError(data.case.aiAnalysisError);
  }, [caseId]);

  // Bước phân tích chạy 1-4+ phút và được backend lưu vào DB ngay khi xong (kể cả khi
  // client đã ngắt kết nối giữa chừng — xem comment ở analyze_case trong cases.py) — nếu
  // trang được tải lại (F5) đúng lúc status đã lưu là RUNNING (từ initialAnalysisStatus,
  // SSR fetch), tự poll lại định kỳ tới khi xong thay vì hiện lại nút mặc định như thể
  // chưa bấm gì, đây chính là lỗi trước đây khi F5 làm mất trắng tiến trình đang chạy.
  useEffect(() => {
    if (status !== "RUNNING") return;
    const interval = setInterval(refetchStatus, 4000);
    return () => clearInterval(interval);
  }, [status, refetchStatus]);

  async function runAnalysis() {
    cancelledRef.current = false;
    setStatus("RUNNING");
    setAnalysisError(null);
    try {
      const res = await fetch(`${API_URL}/cases/${caseId}/analyze`, { method: "POST" });
      if (cancelledRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setStatus("ERROR");
        setAnalysisError(body?.detail || `Không phân tích được (HTTP ${res.status})`);
        return;
      }
      const data: CaseAnalysisResponse = await res.json();
      setStatus("DONE");
      setAnalysis(data.summary);
    } catch {
      if (cancelledRef.current) return;
      // Mất kết nối phía trình duyệt (đóng tab, mất mạng...) không có nghĩa backend đã
      // dừng — request vẫn chạy tiếp trong threadpool riêng và tự lưu kết quả vào DB khi
      // xong. Refetch để lấy status thật thay vì báo lỗi khi có thể vẫn đang chạy bình
      // thường; effect polling ở trên sẽ tự tiếp quản nếu refetch cho thấy vẫn RUNNING.
      await refetchStatus();
    }
  }

  async function cancelAnalysis() {
    cancelledRef.current = true;
    setStatus(analysis ? "DONE" : "IDLE");
    try {
      await fetch(`${API_URL}/cases/${caseId}/analyze/cancel`, { method: "POST" });
    } catch {
      // Không kết nối được để báo huỷ — không sao, UI đã thoát trạng thái chờ ngay tại
      // đây rồi; backend cứ để lượt phân tích cũ chạy xong tự nhiên (chỉ tốn thêm ít token
      // gọi API, không ảnh hưởng gì tới nhân viên vì cancelledRef đã chặn không ghi đè UI).
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
        <div className="flex items-center gap-2">
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
            <button
              onClick={cancelAnalysis}
              className="text-sm font-semibold px-4 py-2.5 rounded-xl bg-neutral-100 text-neutral-600 hover:bg-neutral-200 transition-colors"
            >
              Huỷ
            </button>
          )}
          <a
            href={`${API_URL}/cases/${caseId}/download-all`}
            className="text-sm font-semibold px-4 py-2.5 rounded-xl bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
          >
            ⬇️ Tải tất cả hồ sơ
          </a>
        </div>
        {analyzing && (
          <p className="text-xs text-neutral-400 mt-2">
            AI đang đọc toàn bộ thông tin đã trích xuất để phân tích chi tiết và đối chiếu chéo
            giữa các giấy tờ — có thể mất vài phút, cứ để trang mở hoặc tải lại (F5) bất cứ lúc
            nào cũng không mất tiến trình, vui lòng chờ...
          </p>
        )}
        {status === "ERROR" && analysisError && (
          <p className="text-sm text-red-600 mt-2">{analysisError}</p>
        )}
        {analysis && (
          <div className="mt-4 border-2 border-indigo-200 rounded-2xl p-4 bg-indigo-50">
            <p className="text-xs font-bold uppercase tracking-wide text-indigo-600 mb-2">
              Phân tích AI chuyên sâu
            </p>
            <FormattedDocumentText
              text={analysis}
              emptyLabel=""
              className="text-sm text-neutral-800 leading-relaxed"
            />
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
                      const text = doc.manualCorrectedText || doc.correctedText || doc.ocrText;
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
                          <FormattedDocumentText
                            text={text}
                            emptyLabel="(không đọc được nội dung text từ file này)"
                            className="text-sm text-neutral-700 leading-relaxed"
                          />
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
