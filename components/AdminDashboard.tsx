"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { adminFetch, AdminUnauthorizedError } from "@/lib/adminApi";
import { getAdminPassword, setAdminPassword, clearAdminPassword } from "@/lib/adminAuth";
import { API_URL, parseUtcDate } from "@/lib/format";
import { downloadFile } from "@/lib/download";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_HEX_COLOR,
  getApplicationStatus,
} from "@/lib/application-status";
import { EL, STATUS_LABEL, STATUS_COLOR, Tag, AdminSidebar } from "@/components/adminUi";
import type {
  AdminDocumentDTO,
  EmailLogDTO,
  AdminStatsDTO,
  CaseListItemDTO,
} from "@/lib/client-types";

type LoadState = "checking" | "needs-login" | "loading" | "ready" | "error";
type Tab = "overview" | "documents" | "emails";

// Màu hiển thị của nhãn hồ sơ. Tên màu do backend quy định (ALLOWED_TAGS trong
// backend/schemas.py); ở đây quy ra mã hex để dùng chung với component Tag/biểu đồ. Nhãn mới
// mà quên thêm vào đây thì rơi về màu xám của EL.info, không vỡ giao diện.
const TAG_HEX: Record<string, string> = {
  "GẤP": "#F56C6C",
  "ĐANG CHỜ KHÁCH": "#E6A23C",
  "ĐÃ NỘP IRCC": "#67C23A",
  "CẦN BỔ SUNG": "#EA580C",
  "ĐÃ HOÀN THÀNH": "#409EFF",
  "TẠM HOÃN": "#909399",
  VIP: "#7C3AED",
};

export function AdminDashboard() {
  const [state, setState] = useState<LoadState>("checking");
  // activeTab đọc từ URL (?tab=documents), không phải state cục bộ — để sidebar dùng chung
  // (components/adminUi.tsx) điều hướng bằng Link thật hoạt động nhất quán từ mọi trang
  // admin, kể cả từ AdminCaseDetail quay lại đúng tab.
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: Tab =
    tabParam === "documents" ? "documents" : tabParam === "emails" ? "emails" : "overview";
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStatsDTO | null>(null);
  const [cases, setCases] = useState<CaseListItemDTO[]>([]);
  const [documents, setDocuments] = useState<AdminDocumentDTO[]>([]);
  const [emailLogs, setEmailLogs] = useState<EmailLogDTO[]>([]);
  const [actionId, setActionId] = useState<string | null>(null);
  // null = đang hiện danh sách khách hàng (bước 1); có id = đang hiện file của khách hàng
  // đó (bước 2, bấm "← Danh sách khách hàng" để quay lại bước 1).
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setLoginError(null);
    try {
      const [statsRes, casesRes, documentsRes, emailLogsRes] = await Promise.all([
        adminFetch("/admin/stats"),
        adminFetch("/admin/cases"),
        adminFetch("/admin/documents"),
        adminFetch("/admin/email-logs"),
      ]);
      if (!statsRes.ok || !casesRes.ok || !documentsRes.ok)
        throw new Error("Không tải được dữ liệu admin");
      setStats(await statsRes.json());
      setDocuments(await documentsRes.json());
      setCases(await casesRes.json());
      // Nhật ký email KHÔNG nằm trong điều kiện throw ở trên: backend bản cũ chưa có endpoint
      // này sẽ trả 404, và mất nhật ký thì không đáng để hỏng cả trang admin.
      setEmailLogs(emailLogsRes.ok ? await emailLogsRes.json() : []);
      setState("ready");
    } catch (e) {
      if (e instanceof AdminUnauthorizedError) {
        clearAdminPassword();
        setLoginError("Sai mật khẩu.");
        setState("needs-login");
        return;
      }
      setState("error");
    }
  }, []);

  useEffect(() => {
    // localStorage là hệ thống bên ngoài React và chỉ đọc được sau khi hydrate. Chạy trong
    // callback bất đồng bộ để lần render đầu không phải setState dây chuyền ngay trong effect.
    const timer = window.setTimeout(() => {
      if (getAdminPassword()) {
        void load();
      } else {
        setState("needs-login");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAdminPassword(passwordInput);
    setPasswordInput("");
    load();
  }

  async function handleRestore(c: CaseListItemDTO) {
    setActionId(c.id);
    const res = await adminFetch(`/cases/${c.id}/restore`, { method: "POST" }).catch(() => null);
    setActionId(null);
    if (!res || !res.ok) {
      alert("Khôi phục thất bại.");
      return;
    }
    setCases((prev) => prev.map((x) => (x.id === c.id ? { ...x, deletedAt: null } : x)));
    setStats((prev) =>
      prev ? { ...prev, activeCases: prev.activeCases + 1, deletedCases: prev.deletedCases - 1 } : prev
    );
  }

  async function handlePermanentDelete(c: CaseListItemDTO) {
    if (
      !confirm(
        `XOÁ VĨNH VIỄN hồ sơ "${c.clientName}"?\n\nToàn bộ file đã upload sẽ mất hẳn, KHÔNG thể khôi phục lại được. Chỉ dùng khi chắc chắn.`
      )
    )
      return;
    setActionId(c.id);
    const res = await adminFetch(`/admin/cases/${c.id}/permanent`, { method: "DELETE" }).catch(
      () => null
    );
    setActionId(null);
    if (!res || !res.ok) {
      alert("Xoá vĩnh viễn thất bại.");
      return;
    }
    setCases((prev) => prev.filter((x) => x.id !== c.id));
    setStats((prev) =>
      prev
        ? { ...prev, totalCases: prev.totalCases - 1, deletedCases: prev.deletedCases - 1 }
        : prev
    );
  }

  if (state === "checking") return null;

  if (state === "needs-login") {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center px-6"
        style={{ backgroundColor: EL.sidebarBgActive }}
      >
        <div className="mb-6 text-center">
          <span className="inline-flex items-center gap-2 text-neutral-400 text-xs font-semibold uppercase tracking-widest">
            🛠 Khu vực quản trị
          </span>
        </div>
        <div className="w-full max-w-sm rounded-lg p-7" style={{ backgroundColor: EL.sidebarBg }}>
          <h1 className="text-lg font-semibold text-white">Đăng nhập Admin</h1>
          <p className="text-sm text-neutral-400 mt-1">
            Quản lý hồ sơ đã xoá, thống kê, xoá vĩnh viễn.
          </p>
          <form onSubmit={handleLogin} className="mt-5 flex flex-col gap-3">
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Mật khẩu admin"
              autoFocus
              className="w-full border rounded px-4 py-2.5 text-sm text-white placeholder:text-neutral-500 focus:outline-none"
              style={{ backgroundColor: EL.sidebarBgActive, borderColor: "#4a5c73" }}
            />
            {loginError && <p className="text-sm text-red-400">{loginError}</p>}
            <button
              type="submit"
              disabled={!passwordInput}
              className="text-white rounded px-5 py-2.5 text-sm font-semibold disabled:opacity-50 transition-colors"
              style={{ backgroundColor: EL.primary }}
            >
              Đăng nhập
            </button>
          </form>
        </div>
        <Link href="/" className="mt-6 text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
          ← Quay lại trang chính
        </Link>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="min-h-screen px-6 py-16" style={{ backgroundColor: EL.sidebarBgActive }}>
        <div
          className="max-w-sm mx-auto rounded-lg p-6 text-white"
          style={{ backgroundColor: EL.sidebarBg, border: `1px solid ${EL.danger}` }}
        >
          <p className="font-semibold">Không tải được dữ liệu admin.</p>
          <button
            onClick={load}
            className="mt-3 text-sm font-semibold text-white rounded px-4 py-1.5"
            style={{ backgroundColor: EL.danger }}
          >
            Thử lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: "#f0f2f5" }}>
      <AdminSidebar
        activeTab={activeTab}
        onNavigate={() => setSelectedCaseId(null)}
        onLogout={() => setState("needs-login")}
      />

      <div className="flex-1 min-w-0">
        <header className="h-14 bg-white border-b border-neutral-200 flex items-center px-6">
          <p className="text-sm text-neutral-400">
            Quản trị <span className="mx-1.5 text-neutral-300">/</span>
            <span className={activeTab === "documents" && selectedCaseId ? "text-neutral-500" : "text-neutral-700 font-medium"}>
              {activeTab === "overview"
                ? "Tổng quan"
                : activeTab === "emails"
                  ? "Nhật ký email"
                  : "Hồ sơ đã nộp"}
            </span>
            {activeTab === "documents" && selectedCaseId && (
              <>
                <span className="mx-1.5 text-neutral-300">/</span>
                <span className="text-neutral-700 font-medium">
                  {cases.find((c) => c.id === selectedCaseId)?.clientName ?? "..."}
                </span>
              </>
            )}
          </p>
        </header>

        <div className="p-6">
          {state === "loading" && !stats ? (
            <p className="text-neutral-500 text-sm">Đang tải...</p>
          ) : activeTab === "emails" ? (
            <EmailLogTable logs={emailLogs} />
          ) : activeTab === "documents" ? (
            <CaseDocumentsBrowser
              cases={cases}
              documents={documents}
              selectedCaseId={selectedCaseId}
              onSelectCase={setSelectedCaseId}
            />
          ) : (
            <>
              {/* Ép cả 9 thẻ vào một hàng thì nhãn bị cắt cụt ("Đến hạn nhắc 14 ngày" thành
                  "Đến hạn ..."), đọc không ra nghĩa. Cho xuống 2 hàng để nhãn hiện đủ chữ. */}
              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
                  <StatPanel icon="🗂️" label="Tổng hồ sơ" value={stats.totalCases} color={EL.primary} />
                  <StatPanel icon="✅" label="Đang hoạt động" value={stats.activeCases} color={EL.success} />
                  <StatPanel icon="🗑️" label="Đã xoá mềm" value={stats.deletedCases} color={EL.info} />
                  <StatPanel icon="⏳" label="Cần review" value={stats.needsReviewDocuments} color={EL.warning} />
                  <StatPanel icon="⚠️" label="File lỗi" value={stats.errorDocuments} color={EL.danger} />
                  <StatPanel
                    icon="⌛"
                    label="Chưa có kết quả"
                    value={stats.pendingDecisionCases}
                    color={EL.primary}
                  />
                  <StatPanel
                    icon="🔔"
                    label="Đến hạn nhắc 14 ngày"
                    value={stats.statusRemindersDue}
                    color={stats.statusRemindersDue > 0 ? EL.danger : EL.info}
                  />
                  <StatPanel
                    icon="📛"
                    label="Giấy tờ đã hết hạn"
                    value={stats.expiredDocuments}
                    color={stats.expiredDocuments > 0 ? EL.danger : EL.info}
                  />
                  <StatPanel
                    icon="🕒"
                    label="Giấy tờ sắp hết hạn"
                    value={stats.expiringSoonDocuments}
                    color={stats.expiringSoonDocuments > 0 ? EL.warning : EL.info}
                  />
                </div>
              )}

              {(cases.length > 0 || documents.length > 0) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                  <CaseCompletionChart cases={cases} />
                  <DocumentStatusChart documents={documents} />
                  {stats && <CaseStatusChart counts={stats.casesByStatus} />}
                  {stats && <CaseTagChart counts={stats.casesByTag} />}
                </div>
              )}

              {cases.length === 0 ? (
                <p className="text-neutral-500 text-sm">Chưa có hồ sơ nào.</p>
              ) : (
                <div className="bg-white rounded shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
                          <th className="px-4 py-3">Khách hàng</th>
                          <th className="px-4 py-3">Trạng thái</th>
                          <th className="px-4 py-3">Hoàn thành</th>
                          <th className="px-4 py-3">Cần review</th>
                          <th className="px-4 py-3">Ngày tạo</th>
                          <th className="px-4 py-3 text-right">Hành động</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {cases.map((c) => {
                          const isDeleted = c.deletedAt !== null;
                          return (
                            <tr key={c.id} className="hover:bg-neutral-50 transition-colors">
                              <td className="px-4 py-3">
                                <Link
                                  href={`/admin/cases/${c.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium text-neutral-800 hover:underline"
                                  style={{ color: "inherit" }}
                                  onMouseEnter={(e) => (e.currentTarget.style.color = EL.primary)}
                                  onMouseLeave={(e) => (e.currentTarget.style.color = "inherit")}
                                >
                                  {c.clientName}
                                </Link>
                                <p className="text-xs text-neutral-400 mt-0.5">
                                  {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
                                  {c.numberOfChildren > 0 ? ` · ${c.numberOfChildren} con` : ""}
                                  {" · "}
                                  {c.skillLevel === "HIGH_SKILL" ? "High Skilled" : "Low Skilled"}
                                </p>
                                {c.tags.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                    {c.tags.map((tag) => (
                                      <Tag key={tag} color={TAG_HEX[tag] ?? EL.info}>
                                        {tag}
                                      </Tag>
                                    ))}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex flex-col items-start gap-1.5">
                                  <Tag color={APPLICATION_STATUS_HEX_COLOR[c.applicationStatus]}>
                                    {getApplicationStatus(c.applicationStatus).label}
                                  </Tag>
                                  {c.statusReminderDue && !isDeleted && (
                                    <Tag color={EL.danger}>Đến hạn nhắc</Tag>
                                  )}
                                  {isDeleted && <Tag color={EL.danger}>Đã xoá</Tag>}
                                  {c.expiredDocCount > 0 && (
                                    <Tag color={EL.danger}>{c.expiredDocCount} giấy tờ hết hạn</Tag>
                                  )}
                                  {c.expiringSoonDocCount > 0 && (
                                    <Tag color={EL.warning}>
                                      {c.expiringSoonDocCount} sắp hết hạn
                                    </Tag>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <Tag color={c.percent === 100 ? EL.success : EL.primary}>{c.percent}%</Tag>
                              </td>
                              <td className="px-4 py-3">
                                {c.needsReviewCount > 0 ? (
                                  <Tag color={EL.warning}>{c.needsReviewCount}</Tag>
                                ) : (
                                  <span className="text-xs text-neutral-300">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-neutral-500 text-xs">
                                {new Date(c.createdAt).toLocaleDateString("vi-VN")}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-1.5">
                                  {isDeleted ? (
                                    <>
                                      <button
                                        onClick={() => handleRestore(c)}
                                        disabled={actionId === c.id}
                                        className="text-xs font-semibold px-3 py-1.5 rounded disabled:opacity-50 transition-colors text-white"
                                        style={{ backgroundColor: EL.primary }}
                                      >
                                        {actionId === c.id ? "..." : "Khôi phục"}
                                      </button>
                                      <button
                                        onClick={() => handlePermanentDelete(c)}
                                        disabled={actionId === c.id}
                                        className="text-xs font-semibold px-3 py-1.5 rounded disabled:opacity-50 transition-colors text-white"
                                        style={{ backgroundColor: EL.danger }}
                                      >
                                        {actionId === c.id ? "..." : "Xoá vĩnh viễn"}
                                      </button>
                                    </>
                                  ) : (
                                    <Link
                                      href={`/admin/cases/${c.id}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-xs font-semibold px-3 py-1.5 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
                                    >
                                      Xem
                                    </Link>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CaseDocumentsBrowser({
  cases,
  documents,
  selectedCaseId,
  onSelectCase,
}: {
  cases: CaseListItemDTO[];
  documents: AdminDocumentDTO[];
  selectedCaseId: string | null;
  onSelectCase: (caseId: string | null) => void;
}) {
  if (selectedCaseId) {
    const caseDocs = documents.filter((d) => d.caseId === selectedCaseId);
    return (
      <div>
        <button
          onClick={() => onSelectCase(null)}
          className="mb-4 text-xs font-semibold px-3 py-1.5 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
        >
          ← Danh sách khách hàng
        </button>
        <DocumentsTable documents={caseDocs} />
      </div>
    );
  }

  // Bước 1: danh sách khách hàng, mỗi dòng hiện số file đã nộp — bấm vào mới xem chi tiết.
  const docCountByCase = new Map<string, number>();
  for (const d of documents) {
    docCountByCase.set(d.caseId, (docCountByCase.get(d.caseId) ?? 0) + 1);
  }

  if (cases.length === 0) {
    return <p className="text-neutral-500 text-sm">Chưa có hồ sơ nào.</p>;
  }

  return (
    <div>
    <div className="bg-white rounded shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
              <th className="px-4 py-3">Khách hàng</th>
              <th className="px-4 py-3">Trạng thái</th>
              <th className="px-4 py-3">Số file đã nộp</th>
              <th className="px-4 py-3 text-right">Hành động</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {cases.map((c) => (
              <tr key={c.id} className="hover:bg-neutral-50 transition-colors">
                <td className="px-4 py-3">
                  <p className="font-medium text-neutral-800">{c.clientName}</p>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
                    {c.numberOfChildren > 0 ? ` · ${c.numberOfChildren} con` : ""}
                    {" · "}
                    {c.skillLevel === "HIGH_SKILL" ? "High Skilled" : "Low Skilled"}
                  </p>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1.5">
                    <Tag color={APPLICATION_STATUS_HEX_COLOR[c.applicationStatus]}>
                      {getApplicationStatus(c.applicationStatus).label}
                    </Tag>
                    {c.statusReminderDue && !c.deletedAt && (
                      <Tag color={EL.danger}>Đến hạn nhắc</Tag>
                    )}
                    {c.deletedAt && <Tag color={EL.danger}>Đã xoá</Tag>}
                  </div>
                </td>
                <td className="px-4 py-3 font-semibold" style={{ color: c.percent === 100 ? EL.success : EL.danger }}>
                  {docCountByCase.get(c.id) ?? 0}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => onSelectCase(c.id)}
                    className="text-xs font-semibold px-3 py-1.5 rounded text-white transition-colors"
                    style={{ backgroundColor: EL.primary }}
                  >
                    Xem file
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    <p className="mt-3 text-xs text-neutral-500 flex items-center gap-4">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: EL.success }} />
        Đã nộp đủ hồ sơ bắt buộc
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: EL.danger }} />
        Còn thiếu hồ sơ bắt buộc
      </span>
    </p>
    </div>
  );
}

function DocumentsTable({ documents }: { documents: AdminDocumentDTO[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  const caseId = documents[0]?.caseId;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = selected.size > 0 && selected.size < documents.length;
    }
  }, [selected, documents.length]);

  if (documents.length === 0) {
    return <p className="text-neutral-500 text-sm">Khách hàng này chưa nộp file nào.</p>;
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === documents.length ? new Set() : new Set(documents.map((d) => d.id))));
  }

  async function downloadSelected() {
    setBulkDownloading(true);
    for (const d of documents) {
      if (!selected.has(d.id)) continue;
      try {
        await downloadFile(`${API_URL}/documents/${d.id}/file`, d.originalFilename);
      } catch {
        alert(`Tải file "${d.originalFilename}" thất bại.`);
      }
    }
    setBulkDownloading(false);
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-neutral-500">
          {selected.size > 0 ? `Đã chọn ${selected.size}/${documents.length} file` : `${documents.length} file`}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            onClick={downloadSelected}
            disabled={selected.size === 0 || bulkDownloading}
            className="text-xs font-semibold px-3 py-1.5 rounded text-white disabled:opacity-40 transition-colors"
            style={{ backgroundColor: EL.primary }}
          >
            {bulkDownloading ? "Đang tải..." : `Tải xuống đã chọn (${selected.size})`}
          </button>
          {caseId && (
            <a
              href={`${API_URL}/cases/${caseId}/download-all`}
              className="text-xs font-semibold px-3 py-1.5 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
            >
              Tải tất cả (ZIP)
            </a>
          )}
        </div>
      </div>

      <div className="bg-white rounded shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
              <th className="px-4 py-3 w-10">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={selected.size === documents.length}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-neutral-300"
                />
              </th>
              <th className="px-4 py-3">Tên file</th>
              <th className="px-4 py-3">Loại giấy tờ</th>
              <th className="px-4 py-3">Trạng thái</th>
              <th className="px-4 py-3">Ngày nộp</th>
              <th className="px-4 py-3 text-right">Hành động</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {documents.map((d) => (
              <tr key={d.id} className={`hover:bg-neutral-50 transition-colors ${selected.has(d.id) ? "bg-blue-50/40" : ""}`}>
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={() => toggleOne(d.id)}
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-neutral-800 truncate max-w-xs">{d.originalFilename}</p>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    {(d.fileSizeBytes / 1024).toFixed(0)} KB
                  </p>
                </td>
                <td className="px-4 py-3 text-neutral-600">
                  {d.matchedChecklistItem?.nameVi ?? <span className="text-neutral-300">Chưa khớp</span>}
                </td>
                <td className="px-4 py-3">
                  <Tag color={STATUS_COLOR[d.status]}>{STATUS_LABEL[d.status]}</Tag>
                </td>
                <td className="px-4 py-3 text-neutral-500 text-xs">
                  {new Date(d.uploadedAt).toLocaleDateString("vi-VN")}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <a
                      href={`${API_URL}/documents/${d.id}/file`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold px-3 py-1.5 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
                    >
                      Xem file
                    </a>
                    <button
                      onClick={() =>
                        downloadFile(`${API_URL}/documents/${d.id}/file`, d.originalFilename).catch(() =>
                          alert("Tải file thất bại.")
                        )
                      }
                      className="text-xs font-semibold px-3 py-1.5 rounded text-white transition-colors"
                      style={{ backgroundColor: EL.primary }}
                    >
                      Tải xuống
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}

// So sánh độ lớn (% hoàn thành) giữa các hồ sơ — 1 hue duy nhất (EL.primary) đúng quy tắc
// "compare magnitude → sequential", không tô màu theo từng case (đó là việc của identity/
// categorical, không phải việc của biểu đồ này).
function CaseCompletionChart({ cases }: { cases: CaseListItemDTO[] }) {
  const rows = cases
    .filter((c) => !c.deletedAt)
    .slice()
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 8);

  return (
    <div className="bg-white rounded shadow-sm p-4">
      <p className="text-sm font-semibold text-neutral-700 mb-4">Tiến độ hồ sơ (% hoàn thành)</p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-400">Chưa có hồ sơ đang hoạt động.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((c) => (
            <div key={c.id} className="flex items-center gap-3" title={`${c.clientName}: ${c.percent}%`}>
              <span className="w-28 shrink-0 text-xs text-neutral-600 truncate">{c.clientName}</span>
              <div className="flex-1 h-5 rounded-full bg-neutral-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${c.percent}%`, backgroundColor: EL.primary }}
                />
              </div>
              <span className="w-10 shrink-0 text-xs font-semibold text-neutral-600 text-right">
                {c.percent}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Đếm tài liệu theo trạng thái — màu theo đúng bảng "status palette" đã dùng cho Tag ở nơi
// khác trong khu vực admin (không phải màu categorical tự do), luôn có nhãn tên trạng thái
// đi kèm nên không phụ thuộc màu sắc để phân biệt (bù cho việc vài cặp màu Element UI khá
// gần nhau với người mù màu — đã kiểm tra bằng script validate_palette.js).
function DocumentStatusChart({ documents }: { documents: AdminDocumentDTO[] }) {
  const counts = new Map<AdminDocumentDTO["status"], number>();
  for (const d of documents) {
    counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  }
  const rows = Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className="bg-white rounded shadow-sm p-4">
      <p className="text-sm font-semibold text-neutral-700 mb-4">Tài liệu theo trạng thái</p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-400">Chưa có tài liệu nào.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div
              key={r.status}
              className="flex items-center gap-3"
              title={`${STATUS_LABEL[r.status]}: ${r.count}`}
            >
              <span className="w-28 shrink-0 text-xs text-neutral-600 truncate">
                {STATUS_LABEL[r.status]}
              </span>
              <div className="flex-1 h-5 rounded-full bg-neutral-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${(r.count / max) * 100}%`, backgroundColor: STATUS_COLOR[r.status] }}
                />
              </div>
              <span className="w-10 shrink-0 text-xs font-semibold text-neutral-600 text-right">
                {r.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TRIGGER_LABEL: Record<string, string> = {
  STATUS_CHANGE: "Đổi trạng thái",
  PERIODIC_REMINDER: "Nhắc 14 ngày",
  TEST: "Email kiểm tra",
};

const TRIGGER_COLOR: Record<string, string> = {
  STATUS_CHANGE: EL.warning,
  PERIODIC_REMINDER: EL.primary,
  TEST: EL.info,
};

const EMAIL_LOG_DATE = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

// Nhật ký email đã gửi. Mỗi dòng mở ra được để xem ĐÚNG nội dung đã gửi hôm đó — nội dung
// lấy từ bản lưu trong DB chứ không dựng lại từ template hiện tại, vì câu chữ template sẽ
// còn đổi mà nhật ký thì phải phản ánh thứ khách thật sự nhận được.
function EmailLogTable({ logs }: { logs: EmailLogDTO[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("ALL");

  const rows = filter === "ALL" ? logs : logs.filter((l) => l.trigger === filter);

  if (logs.length === 0) {
    return (
      <div className="bg-white rounded shadow-sm p-8 text-center">
        <p className="text-4xl mb-3">✉️</p>
        <p className="text-sm font-semibold text-neutral-700">Chưa có email nào được gửi.</p>
        <p className="text-xs text-neutral-400 mt-1.5">
          Nhật ký sẽ tự ghi khi hồ sơ chuyển sang “Đã nộp” / “Cần bổ sung giấy tờ”, khi tới
          chu kỳ nhắc 14 ngày, hoặc khi chạy lệnh gửi email kiểm tra.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {[
          ["ALL", `Tất cả (${logs.length})`],
          ...Object.keys(TRIGGER_LABEL).map((k) => [
            k,
            `${TRIGGER_LABEL[k]} (${logs.filter((l) => l.trigger === k).length})`,
          ]),
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className="text-xs font-semibold px-3 py-1.5 rounded transition-colors"
            style={
              filter === value
                ? { backgroundColor: EL.primary, color: "white" }
                : { backgroundColor: "white", color: "#606266" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
                <th className="px-4 py-3">Thời điểm</th>
                <th className="px-4 py-3">Loại</th>
                <th className="px-4 py-3">Hồ sơ</th>
                <th className="px-4 py-3">Tiêu đề email</th>
                <th className="px-4 py-3">Kết quả</th>
                <th className="px-4 py-3 text-right">Nội dung</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((log) => {
                const isOpen = openId === log.id;
                return (
                  <Fragment key={log.id}>
                    <tr className="hover:bg-neutral-50 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-neutral-600">
                        {EMAIL_LOG_DATE.format(parseUtcDate(log.createdAt))}
                      </td>
                      <td className="px-4 py-3">
                        <Tag color={TRIGGER_COLOR[log.trigger] ?? EL.info}>
                          {TRIGGER_LABEL[log.trigger] ?? log.trigger}
                        </Tag>
                      </td>
                      <td className="px-4 py-3">
                        {log.caseId ? (
                          <Link
                            href={`/admin/cases/${log.caseId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium hover:underline"
                            style={{ color: EL.primary }}
                          >
                            {log.caseClientName ?? "Xem hồ sơ"}
                          </Link>
                        ) : (
                          <span className="text-neutral-400 text-xs">
                            {log.cases.length > 1 ? `${log.cases.length} hồ sơ` : "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-neutral-700">{log.title}</td>
                      <td className="px-4 py-3">
                        {log.status === "SENT" ? (
                          <Tag color={EL.success}>Đã gửi</Tag>
                        ) : (
                          <Tag color={EL.danger}>Gửi lỗi</Tag>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setOpenId(isOpen ? null : log.id)}
                          aria-expanded={isOpen}
                          className="text-xs font-semibold px-3 py-1.5 rounded border border-neutral-200 text-neutral-600 hover:bg-neutral-50 transition-colors"
                        >
                          {isOpen ? "Thu gọn" : "Xem"}
                        </button>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr>
                        <td colSpan={6} className="px-4 py-4 bg-neutral-50">
                          <div className="max-w-3xl">
                            <p className="text-xs font-semibold text-neutral-500 mb-1">
                              Gửi tới: {log.recipient ?? "—"}
                            </p>
                            <p className="text-base font-bold text-neutral-800 mb-2">{log.title}</p>
                            {log.intro && (
                              <p className="text-sm text-neutral-600 mb-3">{log.intro}</p>
                            )}

                            <div className="flex flex-col gap-2 mb-3">
                              {log.cases.map((row, i) => (
                                <div
                                  key={i}
                                  className="bg-white border border-neutral-200 rounded p-3"
                                  style={{ borderLeft: `4px solid ${row.status_color}` }}
                                >
                                  <p className="text-sm font-semibold text-neutral-800">
                                    {row.client_name}
                                  </p>
                                  <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                    <Tag color={row.status_color}>{row.status_label}</Tag>
                                    <span className="text-xs text-neutral-400">
                                      Cập nhật: {row.updated_at}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>

                            {log.footer && (
                              <p className="text-xs text-neutral-500">{log.footer}</p>
                            )}
                            {log.errorMessage && (
                              <p className="mt-3 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded p-2.5 break-words">
                                Lỗi khi gửi: {log.errorMessage}
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// Phân bố hồ sơ theo trạng thái nghiệp vụ. Số liệu lấy từ /admin/stats (backend GROUP BY)
// chứ không gom lại từ mảng `cases` — để khi danh sách hồ sơ được phân trang sau này, biểu đồ
// vẫn phản ánh TOÀN BỘ hồ sơ chứ không phải mỗi trang đang xem.
function CaseStatusChart({ counts }: { counts: Record<string, number> }) {
  const rows = APPLICATION_STATUSES.map((s) => ({
    value: s.value,
    label: s.label,
    count: counts?.[s.value] ?? 0,
  })).filter((r) => r.count > 0);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className="bg-white rounded shadow-sm p-4">
      <p className="text-sm font-semibold text-neutral-700 mb-4">Hồ sơ theo trạng thái</p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-400">Chưa có hồ sơ đang hoạt động.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.value} className="flex items-center gap-3" title={`${r.label}: ${r.count}`}>
              <span className="w-28 shrink-0 text-xs text-neutral-600 truncate">{r.label}</span>
              <div className="flex-1 h-5 rounded-full bg-neutral-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(r.count / max) * 100}%`,
                    backgroundColor: APPLICATION_STATUS_HEX_COLOR[r.value],
                  }}
                />
              </div>
              <span className="w-10 shrink-0 text-xs font-semibold text-neutral-600 text-right">
                {r.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Nhãn hồ sơ (GẤP, VIP...). Một hồ sơ có thể mang nhiều nhãn nên tổng các cột ở đây LỚN HƠN
// số hồ sơ — cố ý, vì câu hỏi cần trả lời là "đang có bao nhiêu việc gấp", không phải chia
// hồ sơ thành các nhóm rời nhau.
function CaseTagChart({ counts }: { counts: Record<string, number> }) {
  // `?? {}`: lúc rolling deploy, backend bản cũ chưa trả field này thì Object.entries(undefined)
  // sẽ ném lỗi và làm trắng cả trang admin.
  const rows = Object.entries(counts ?? {})
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className="bg-white rounded shadow-sm p-4">
      <p className="text-sm font-semibold text-neutral-700 mb-1">Nhãn hồ sơ</p>
      <p className="text-xs text-neutral-400 mb-4">Một hồ sơ có thể mang nhiều nhãn.</p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-400">Chưa hồ sơ nào được gắn nhãn.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.name} className="flex items-center gap-3" title={`${r.name}: ${r.count}`}>
              <span className="w-28 shrink-0 text-xs text-neutral-600 truncate">{r.name}</span>
              <div className="flex-1 h-5 rounded-full bg-neutral-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${(r.count / max) * 100}%`, backgroundColor: TAG_HEX[r.name] ?? EL.info }}
                />
              </div>
              <span className="w-10 shrink-0 text-xs font-semibold text-neutral-600 text-right">
                {r.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatPanel({
  icon,
  label,
  value,
  color,
}: {
  icon: string;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-white rounded shadow-sm p-4 flex items-center gap-4">
      <span
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-xl"
        style={{ backgroundColor: `${color}1a` }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-neutral-800 leading-tight">{value}</p>
        {/* KHÔNG dùng truncate: nhãn dài như "Đến hạn nhắc 14 ngày" bị cắt thành
            "Đến hạn ..." thì mất hẳn ý nghĩa. Cho xuống dòng, thẻ cao thêm chút. */}
        <p className="text-xs text-neutral-400 mt-0.5 leading-snug">{label}</p>
      </div>
    </div>
  );
}
