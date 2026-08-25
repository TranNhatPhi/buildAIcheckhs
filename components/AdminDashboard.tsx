"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminFetch, AdminUnauthorizedError } from "@/lib/adminApi";
import { getAdminPassword, setAdminPassword, clearAdminPassword } from "@/lib/adminAuth";
import type { AdminStatsDTO, CaseListItemDTO } from "@/lib/client-types";

type LoadState = "checking" | "needs-login" | "loading" | "ready" | "error";

// Bảng màu theo đúng Element UI (nền tảng của vue-element-admin) — dùng nguyên hex để giữ
// đúng tinh thần template tham khảo, không map qua palette Tailwind mặc định.
const EL = {
  sidebarBg: "#304156",
  sidebarBgActive: "#1f2d3d",
  primary: "#409EFF",
  success: "#67C23A",
  warning: "#E6A23C",
  danger: "#F56C6C",
  info: "#909399",
};

export function AdminDashboard() {
  const [state, setState] = useState<LoadState>("checking");
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStatsDTO | null>(null);
  const [cases, setCases] = useState<CaseListItemDTO[]>([]);
  const [actionId, setActionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setLoginError(null);
    try {
      const [statsRes, casesRes] = await Promise.all([
        adminFetch("/admin/stats"),
        adminFetch("/admin/cases"),
      ]);
      if (!statsRes.ok || !casesRes.ok) throw new Error("Không tải được dữ liệu admin");
      setStats(await statsRes.json());
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

  function handleLogout() {
    clearAdminPassword();
    setStats(null);
    setCases([]);
    setState("needs-login");
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
      {/* Sidebar tối màu kiểu vue-element-admin — chỉ 1 mục vì admin hiện chỉ có 1 màn hình */}
      <aside
        className="w-56 shrink-0 h-screen sticky top-0 flex flex-col"
        style={{ backgroundColor: EL.sidebarBg }}
      >
        <div className="h-14 flex items-center gap-2 px-5 text-white font-semibold border-b border-white/10">
          <span>🛠</span> Quản trị
        </div>
        <nav className="flex-1 px-2 py-3">
          <div
            className="flex items-center gap-2.5 text-sm font-medium text-white px-3.5 py-3 rounded"
            style={{ backgroundColor: EL.primary }}
          >
            📊 Tổng quan
          </div>
        </nav>
        <button
          onClick={handleLogout}
          className="m-3 text-xs font-semibold text-neutral-300 hover:text-white hover:bg-white/10 rounded px-3.5 py-2.5 text-left transition-colors"
        >
          ⏻ Đăng xuất
        </button>
      </aside>

      <div className="flex-1 min-w-0">
        <header className="h-14 bg-white border-b border-neutral-200 flex items-center px-6">
          <p className="text-sm text-neutral-400">
            Quản trị <span className="mx-1.5 text-neutral-300">/</span>
            <span className="text-neutral-700 font-medium">Tổng quan</span>
          </p>
        </header>

        <div className="p-6">
          {state === "loading" && !stats ? (
            <p className="text-neutral-500 text-sm">Đang tải...</p>
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
                                  href={`/cases/${c.id}`}
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
                                      href={`/cases/${c.id}`}
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

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="text-xs font-semibold px-2.5 py-1 rounded"
      style={{ backgroundColor: `${color}1a`, color }}
    >
      {children}
    </span>
  );
}
