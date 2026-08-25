"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { adminFetch, AdminUnauthorizedError } from "@/lib/adminApi";
import { getAdminPassword, setAdminPassword, clearAdminPassword } from "@/lib/adminAuth";
import { API_URL } from "@/lib/format";
import { downloadFile } from "@/lib/download";
import { EL, STATUS_LABEL, STATUS_COLOR, Tag, AdminSidebar } from "@/components/adminUi";
import type { AdminDocumentDTO, AdminStatsDTO, CaseListItemDTO } from "@/lib/client-types";

type LoadState = "checking" | "needs-login" | "loading" | "ready" | "error";
type Tab = "overview" | "documents";

export function AdminDashboard() {
  const [state, setState] = useState<LoadState>("checking");
  // activeTab đọc từ URL (?tab=documents), không phải state cục bộ — để sidebar dùng chung
  // (components/adminUi.tsx) điều hướng bằng Link thật hoạt động nhất quán từ mọi trang
  // admin, kể cả từ AdminCaseDetail quay lại đúng tab.
  const searchParams = useSearchParams();
  const activeTab: Tab = searchParams.get("tab") === "documents" ? "documents" : "overview";
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStatsDTO | null>(null);
  const [cases, setCases] = useState<CaseListItemDTO[]>([]);
  const [documents, setDocuments] = useState<AdminDocumentDTO[]>([]);
  const [actionId, setActionId] = useState<string | null>(null);
  // null = đang hiện danh sách khách hàng (bước 1); có id = đang hiện file của khách hàng
  // đó (bước 2, bấm "← Danh sách khách hàng" để quay lại bước 1).
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  // Về lại danh sách khách hàng mỗi khi đổi tab (vd rời tab rồi quay lại qua sidebar) — tránh
  // kẹt ở màn hình chi tiết của lần xem trước.
  useEffect(() => {
    setSelectedCaseId(null);
  }, [activeTab]);

  const load = useCallback(async () => {
    setState("loading");
    setLoginError(null);
    try {
      const [statsRes, casesRes, documentsRes] = await Promise.all([
        adminFetch("/admin/stats"),
        adminFetch("/admin/cases"),
        adminFetch("/admin/documents"),
      ]);
      if (!statsRes.ok || !casesRes.ok || !documentsRes.ok)
        throw new Error("Không tải được dữ liệu admin");
      setStats(await statsRes.json());
      setDocuments(await documentsRes.json());
      setCases(await casesRes.json());
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
    if (getAdminPassword()) {
      load();
    } else {
      setState("needs-login");
    }
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
      <AdminSidebar activeTab={activeTab} />

      <div className="flex-1 min-w-0">
        <header className="h-14 bg-white border-b border-neutral-200 flex items-center px-6">
          <p className="text-sm text-neutral-400">
            Quản trị <span className="mx-1.5 text-neutral-300">/</span>
            <span className={activeTab === "documents" && selectedCaseId ? "text-neutral-500" : "text-neutral-700 font-medium"}>
              {activeTab === "overview" ? "Tổng quan" : "Hồ sơ đã nộp"}
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
          ) : activeTab === "documents" ? (
            <CaseDocumentsBrowser
              cases={cases}
              documents={documents}
              selectedCaseId={selectedCaseId}
              onSelectCase={setSelectedCaseId}
            />
          ) : (
            <>
              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
                  <StatPanel icon="🗂️" label="Tổng hồ sơ" value={stats.totalCases} color={EL.primary} />
                  <StatPanel icon="✅" label="Đang hoạt động" value={stats.activeCases} color={EL.success} />
                  <StatPanel icon="🗑️" label="Đã xoá mềm" value={stats.deletedCases} color={EL.info} />
                  <StatPanel icon="⏳" label="Cần review" value={stats.needsReviewDocuments} color={EL.warning} />
                  <StatPanel icon="⚠️" label="File lỗi" value={stats.errorDocuments} color={EL.danger} />
                </div>
              )}

              {(cases.length > 0 || documents.length > 0) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                  <CaseCompletionChart cases={cases} />
                  <DocumentStatusChart documents={documents} />
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
                                </p>
                              </td>
                              <td className="px-4 py-3">
                                <Tag color={isDeleted ? EL.danger : EL.success}>
                                  {isDeleted ? "Đã xoá" : "Hoạt động"}
                                </Tag>
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
                  </p>
                </td>
                <td className="px-4 py-3">
                  <Tag color={c.deletedAt ? EL.danger : EL.success}>
                    {c.deletedAt ? "Đã xoá" : "Hoạt động"}
                  </Tag>
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
  if (documents.length === 0) {
    return <p className="text-neutral-500 text-sm">Khách hàng này chưa nộp file nào.</p>;
  }

  return (
    <div className="bg-white rounded shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
              <th className="px-4 py-3">Tên file</th>
              <th className="px-4 py-3">Loại giấy tờ</th>
              <th className="px-4 py-3">Trạng thái</th>
              <th className="px-4 py-3">Ngày nộp</th>
              <th className="px-4 py-3 text-right">Hành động</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {documents.map((d) => (
              <tr key={d.id} className="hover:bg-neutral-50 transition-colors">
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
        <p className="text-xs text-neutral-400 mt-0.5 truncate">{label}</p>
      </div>
    </div>
  );
}
