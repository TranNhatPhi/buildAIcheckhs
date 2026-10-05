"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { adminFetch, AdminUnauthorizedError } from "@/lib/adminApi";
import { getAdminPassword, setAdminPassword, clearAdminPassword } from "@/lib/adminAuth";
import { API_URL, documentPageCount, formatExperience, parseUtcDate } from "@/lib/format";
import { downloadFile } from "@/lib/download";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_HEX_COLOR,
  getApplicationStatus,
  MAX_SUBMISSION_ROUND,
  RESUBMIT_FROM_STATUSES,
  statusChangeBlockedReason,
  statusOptionsFor,
} from "@/lib/application-status";
import { ResubmitBadge } from "@/components/ResubmitBadge";
import { CHUA_NHAP_NGUON, nhomTheoNguon } from "@/lib/nguon";

// Giá trị giả trong ô chọn trạng thái cho thao tác "Nộp lại lần N" — không phải ApplicationStatus.
const NOP_LAI = "__NOP_LAI__";
import { EL, STATUS_LABEL, STATUS_COLOR, Tag, AdminSidebar, NutNhomTheoNguon, DongTieuDeNhom } from "@/components/adminUi";
import { ChuongThongBao } from "@/components/ChuongThongBao";
import { BO_LOC_HO_SO, type KhoaLoc } from "@/lib/adminCaseFilters";
import type {
  AdminDocumentDTO,
  EmailLogDTO,
  AdminStatsDTO,
  ApplicationStatus,
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
  const router = useRouter();
  const tabParam = searchParams.get("tab");
  // ?nhom=nguon: bảng hồ sơ chia nhóm theo nguồn — trên URL giống trang Thống kê, F5 không mất.
  const nhomNguon = searchParams.get("nhom") === "nguon";
  function doiNhomNguon() {
    const p = new URLSearchParams(searchParams.toString());
    if (nhomNguon) p.delete("nhom");
    else p.set("nhom", "nguon");
    router.replace(`/admin${p.toString() ? `?${p}` : ""}`, { scroll: false });
  }
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

  // Xếp theo TIẾN ĐỘ GIẢM DẦN thay vì theo ngày tạo như backend trả về: nhìn danh sách là
  // thấy ngay hồ sơ nào sắp xong. Cùng % thì xếp theo tên để thứ tự không đổi lung tung mỗi
  // lần tải lại (hiện có 3 hồ sơ cùng 45%).
  //
  // Sắp xếp ở đây chứ không sửa ORDER BY của backend: /admin/cases còn dùng cho các biểu đồ
  // và cho tab "Hồ sơ đã nộp", mà thứ tự theo ngày tạo vẫn là mặc định hợp lý của API.
  // Số liệu cho 10 thẻ tổng quan. Tính ngay từ danh sách hồ sơ đã tải (có sẵn trạng thái, % hoàn
  // thành, số giấy tờ hết hạn) chứ không thêm endpoint: thêm một nguồn nữa là có lúc hai nguồn
  // lệch nhau — thẻ báo 5 mà bảng bên dưới đếm ra 6.
  //
  // CHỈ tính hồ sơ đang hoạt động: hồ sơ đã xoá mềm vẫn nằm trong danh sách admin (để khôi
  // phục), đếm vào "Tổng hồ sơ" là số liệu phình ra vô nghĩa.
  const soLieu = useMemo(() => {
    const song = cases.filter((c) => !c.deletedAt);
    // Đếm hồ sơ bằng CHÍNH bộ lọc mà trang thống kê dùng (lib/adminCaseFilters.ts) — bấm thẻ
    // "Đã nộp: 5" mở ra đúng 5 dòng, không lệch.
    const dem = (k: KhoaLoc) => song.filter(BO_LOC_HO_SO[k].dat).length;
    return {
      tong: song.length,
      daNop: dem("daNop"),
      hoanThanh: dem("hoanThanh"),
      dangXuLy: dem("dangXuLy"),
      dau: dem("dau"),
      rot: dem("rot"),
      thanhLy: dem("thanhLy"),
      nhacDaNop: dem("nhacDaNop"),
      chuaKetQua: dem("chuaKetQua"),
      nopLan2: dem("nopLan2"),
      chuaCapNhat: dem("chuaCapNhat"),
      // Cùng cách gộp tên nguồn với biểu đồ "Hồ sơ theo nguồn" (lib/nguon.ts).
      nguon: nhomTheoNguon(song).filter((g) => !g.chuaNhap).length,
      // Thẻ giấy tờ sắp hết hạn đếm SỐ GIẤY TỜ, không phải số hồ sơ.
      sapHetHan: song.reduce((t, c) => t + c.expiringSoonDocCount, 0),
    };
  }, [cases]);

  // Admin đổi trạng thái ngay tại bảng tổng quan (vd nhận hồ sơ "Hoàn thành" sang "Sẵn sàng nộp"). Trước
  // đây chỉ trang nhân viên đổi được, admin phải mở trang khác.
  const [dangDoiTrangThai, setDangDoiTrangThai] = useState<string | null>(null);
  const [thongBaoEmail, setThongBaoEmail] = useState<string | null>(null);

  async function doiTrangThai(c: CaseListItemDTO, trangThai: ApplicationStatus) {
    if (trangThai === c.applicationStatus) return;
    setDangDoiTrangThai(c.id);
    try {
      const res = await adminFetch(`/cases/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationStatus: trangThai }),
      }).catch(() => null);
      if (!res || !res.ok) {
        // Backend trả lý do cụ thể khi vi phạm quy tắc (vd "chỉ hồ sơ Hoàn thành mới chuyển cho admin").
        const chiTiet = res ? (await res.json().catch(() => null))?.detail : null;
        alert(chiTiet ?? "Không đổi được trạng thái — thử lại sau.");
        return;
      }
      const kq = await res.json().catch(() => null);
      // Backend tự quyết trạng thái nào gửi email (INSTANT_EMAIL_STATUSES) — chỉ báo lại.
      setThongBaoEmail(
        kq?.statusEmailQueued
          ? `Đã chuyển "${c.clientName}" sang "${getApplicationStatus(trangThai).label}" — đã gửi email báo.`
          : null
      );
      await load();
    } finally {
      setDangDoiTrangThai(null);
    }
  }

  // "Nộp lại lần N": không phải trạng thái mà là thao tác xoá hết file + đưa hồ sơ về đầu —
  // nên đi endpoint riêng và phải hỏi lại, vì file đã xoá là không lấy lại được.
  async function nopLai(c: CaseListItemDTO) {
    const lan = (c.submissionRound ?? 1) + 1;
    if (
      !confirm(
        `Nộp lại lần ${lan} cho hồ sơ "${c.clientName}"?\n\n` +
          "• XOÁ VĨNH VIỄN toàn bộ file đã nộp — không khôi phục được\n" +
          "• Xoá số dư tiết kiệm và bản phân tích AI\n" +
          `• Hồ sơ về "Chờ tiếp nhận" (0%), hiện nhãn "Nộp lại lần ${lan}" — nhân viên làm lại từ đầu ở trang checklist`
      )
    )
      return;
    setDangDoiTrangThai(c.id);
    try {
      const res = await adminFetch(`/cases/${c.id}/resubmit`, { method: "POST" }).catch(() => null);
      if (!res || !res.ok) {
        const chiTiet = res ? (await res.json().catch(() => null))?.detail : null;
        alert(chiTiet ?? "Không chuyển nộp lại được — thử lại sau.");
        return;
      }
      setThongBaoEmail(null);
      await load();
    } finally {
      setDangDoiTrangThai(null);
    }
  }

  const casesTheoTienDo = useMemo(
    () =>
      [...cases].sort(
        (a, b) => b.percent - a.percent || a.clientName.localeCompare(b.clientName, "vi")
      ),
    [cases]
  );

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

  // Một dòng của bảng hồ sơ — dùng chung cho bảng liền và bảng nhóm theo nguồn.
  function dongTongQuan(c: CaseListItemDTO) {
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
          {c.submissionRound > 1 && (
            <span className="ml-2 align-middle">
              <ResubmitBadge round={c.submissionRound} />
            </span>
          )}
          <p className="text-xs text-neutral-400 mt-0.5">
            {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
            {c.numberOfChildren > 0 ? ` · ${c.numberOfChildren} con` : ""}
            {" · "}
            {c.skillLevel === "HIGH_SKILL" ? "High Skilled" : "Low Skilled"}
            {c.occupation ? ` · ${c.occupation}` : ""}
            {formatExperience(c.experienceMonths)
              ? ` · ${formatExperience(c.experienceMonths)}`
              : ""}
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
        <td className="px-4 py-3 text-neutral-700">
          {c.partner ?? <span className="text-xs text-neutral-300">—</span>}
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-col items-start gap-1.5">
            {isDeleted ? (
              <Tag color={APPLICATION_STATUS_HEX_COLOR[c.applicationStatus]}>
                {getApplicationStatus(c.applicationStatus).label}
              </Tag>
            ) : (
              <select
                value={c.applicationStatus}
                disabled={dangDoiTrangThai === c.id}
                onChange={(e) =>
                  e.target.value === NOP_LAI
                    ? nopLai(c)
                    : doiTrangThai(c, e.target.value as ApplicationStatus)
                }
                className="text-xs font-semibold rounded px-2 py-1 border bg-white disabled:opacity-50 cursor-pointer"
                style={{
                  color: APPLICATION_STATUS_HEX_COLOR[c.applicationStatus],
                  borderColor: APPLICATION_STATUS_HEX_COLOR[c.applicationStatus],
                }}
                title="Đổi trạng thái hồ sơ"
              >
                {statusOptionsFor("admin", c.applicationStatus).map((st) => {
                  const lyDo = statusChangeBlockedReason(st.value, c.applicationStatus, c.percent, true);
                  return (
                    <option key={st.value} value={st.value} disabled={!!lyDo} style={{ color: lyDo ? "#9ca3af" : "#111827" }}>
                      {st.label}{lyDo ? ` (${lyDo})` : ""}
                    </option>
                  );
                })}
                {/* Đã nộp lần 2 thì không còn lựa chọn này — không có lần nộp thứ 3. */}
                {(c.submissionRound ?? 1) < MAX_SUBMISSION_ROUND && (
                  <option
                    value={NOP_LAI}
                    disabled={!RESUBMIT_FROM_STATUSES.includes(c.applicationStatus)}
                    style={{ color: RESUBMIT_FROM_STATUSES.includes(c.applicationStatus) ? "#C2410C" : "#9ca3af" }}
                  >
                    🔁 Nộp lại lần {(c.submissionRound ?? 1) + 1}
                    {RESUBMIT_FROM_STATUSES.includes(c.applicationStatus) ? "" : " (sau khi đã nộp)"}
                  </option>
                )}
              </select>
            )}
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
        <td className="px-4 py-3 text-neutral-500 text-xs whitespace-nowrap">
          {parseUtcDate(c.createdAt).toLocaleDateString("vi-VN")}
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
          <ChuongThongBao />
        </header>

        <div className="p-6">
          {state === "loading" && !stats ? (
            <p className="text-neutral-500 text-sm">Đang tải...</p>
          ) : activeTab === "emails" ? (
            <EmailLogTable logs={emailLogs} />
          ) : activeTab === "documents" ? (
            <CaseDocumentsBrowser
              cases={casesTheoTienDo}
              documents={documents}
              selectedCaseId={selectedCaseId}
              onSelectCase={setSelectedCaseId}
            />
          ) : (
            <>
              {/* 12 thẻ, 2 hàng x 6: ép hết vào một hàng thì nhãn bị cắt cụt ("Đến hạn nhắc 14
                  ngày" thành "Đến hạn ..."), đọc không ra nghĩa. */}
              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
                  <StatPanel icon="🗂️" label="Tổng hồ sơ" href="/admin/thong-ke" value={soLieu.tong} color={EL.primary}
                    hint="Hồ sơ đang hoạt động (không tính hồ sơ đã xoá)" />
                  <StatPanel icon="🤝" label="Số nguồn" href="/admin/thong-ke?nhom=nguon" value={soLieu.nguon} color={EL.primary}
                    hint="Số nguồn / đối tác khác nhau đang có hồ sơ — bấm để xem bảng nhóm theo nguồn" />
                  <StatPanel icon="📨" label="Hồ sơ đã nộp" href="/admin/thong-ke?loc=daNop" value={soLieu.daNop} color={EL.primary}
                    hint='Đã nộp đi: "Đang xử lý" + "Được chấp thuận" + "Không thành công" + "Thanh lý hồ sơ"' />
                  <StatPanel icon="✅" label="Hồ sơ hoàn thành" href="/admin/thong-ke?loc=hoanThanh" value={soLieu.hoanThanh} color={EL.success}
                    hint='Trạng thái "Hoàn thành" (đủ 100% giấy tờ, chờ admin nhận)' />
                  <StatPanel icon="🔄" label="Hồ sơ đang xử lý" href="/admin/thong-ke?loc=dangXuLy" value={soLieu.dangXuLy} color={EL.warning}
                    hint='Trạng thái "Đang xử lý" — đã nộp, đang chờ kết quả' />
                  <StatPanel icon="🎉" label="Hồ sơ thành công (đậu)" href="/admin/thong-ke?loc=dau" value={soLieu.dau} color={EL.success}
                    hint='Trạng thái "Được chấp thuận"' />
                  <StatPanel icon="❌" label="Hồ sơ rớt" href="/admin/thong-ke?loc=rot" value={soLieu.rot}
                    color={soLieu.rot > 0 ? EL.danger : EL.info} hint='Trạng thái "Không thành công" (chưa thanh lý)' />
                  <StatPanel icon="🔁" label="Hồ sơ nộp lần 2" href="/admin/thong-ke?loc=nopLan2" value={soLieu.nopLan2}
                    color={soLieu.nopLan2 > 0 ? EL.warning : EL.info}
                    hint="Hồ sơ admin đã cho nộp lại — lần nộp cuối, không có lần 3" />
                  {/* Thay chỗ thẻ "Nhắc kiểm tra trạng thái (đang xử lý)". Loại nhắc này đã BỎ khỏi chuông
                      admin (vì có thẻ riêng ở đây) nhưng vẫn ở chuông trang Docs. */}
                  <StatPanel icon="🔔" label="7 ngày chưa cập nhật hồ sơ" href="/admin/thong-ke?loc=chuaCapNhat" value={soLieu.chuaCapNhat}
                    color={soLieu.chuaCapNhat > 0 ? EL.warning : EL.info}
                    hint="Không có file mới 7 ngày mà còn thiếu giấy tờ bắt buộc (chưa tới Hoàn thành)" />
                  <StatPanel icon="⌛" label="Chưa có kết quả" href="/admin/thong-ke?loc=chuaKetQua" value={soLieu.chuaKetQua} color={EL.primary}
                    hint='Chưa có kết quả "Được chấp thuận" / "Không thành công"' />
                  <StatPanel icon="🗃️" label="Hồ sơ thanh lý" href="/admin/thong-ke?loc=thanhLy" value={soLieu.thanhLy}
                    color={soLieu.thanhLy > 0 ? "#475569" : EL.info}
                    hint='Trạng thái "Thanh lý hồ sơ" — hồ sơ đã khép lại sau khi không thành công' />
                  <StatPanel icon="🕒" label="Giấy tờ sắp hết hạn" href="/admin/thong-ke?loc=sapHetHan" value={soLieu.sapHetHan}
                    color={soLieu.sapHetHan > 0 ? EL.warning : EL.info} hint="Số giấy tờ sắp hết hạn hiệu lực" />
                </div>
              )}
              {thongBaoEmail && (
                <p className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                  {thongBaoEmail}
                </p>
              )}

              {(cases.length > 0 || documents.length > 0) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                  <CaseCompletionChart cases={cases} />
                  <CaseSourceChart cases={cases} />
                  {stats && <CaseStatusChart counts={stats.casesByStatus} />}
                  {stats && <CaseTagChart counts={stats.casesByTag} />}
                </div>
              )}

              {cases.length === 0 ? (
                <p className="text-neutral-500 text-sm">Chưa có hồ sơ nào.</p>
              ) : (
                <div className="bg-white rounded shadow-sm overflow-hidden">
                  <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100">
                    <p className="text-xs text-neutral-500">
                      {cases.length} hồ sơ
                      {nhomNguon ? ` · ${nhomTheoNguon(cases).filter((g) => !g.chuaNhap).length} nguồn` : ""}
                    </p>
                    <NutNhomTheoNguon bat={nhomNguon} onToggle={doiNhomNguon} />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
                          <th className="px-4 py-3">Khách hàng</th>
                          <th className="px-4 py-3">Nguồn</th>
                          <th className="px-4 py-3">Trạng thái</th>
                          <th className="px-4 py-3">Hoàn thành</th>
                          <th className="px-4 py-3">Cần review</th>
                          <th className="px-4 py-3 whitespace-nowrap">Ngày nhận HS</th>
                          <th className="px-4 py-3 text-right">Hành động</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {nhomNguon
                          ? nhomTheoNguon(casesTheoTienDo).map((g) => (
                              <Fragment key={g.ten}>
                                <DongTieuDeNhom ten={g.ten} soHoSo={g.cases.length} chuaNhap={g.chuaNhap} colSpan={7} />
                                {g.cases.map((c) => dongTongQuan(c))}
                              </Fragment>
                            ))
                          : casesTheoTienDo.map((c) => dongTongQuan(c))}
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
                  <p className="font-medium text-neutral-800">
                    {c.clientName}{" "}
                    <ResubmitBadge round={c.submissionRound} />
                  </p>
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
                  <span className="ml-2 text-xs font-normal text-neutral-400">{c.percent}%</span>
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
  // Tổng số trang của cả bộ hồ sơ — nhân viên cần con số này để biết in/nộp dày bao nhiêu.
  // File OCR hỏng thì pageCount để trống: đếm riêng và nói rõ, để tổng không âm thầm thiếu
  // trang mà nhìn vào lại tưởng là đủ (giống cách làm ở CaseDetail.tsx).
  const tongSoTrang = documents.reduce((tong, d) => tong + (documentPageCount(d) ?? 0), 0);
  const soFileChuaRoTrang = documents.filter((d) => documentPageCount(d) == null).length;
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
          {selected.size > 0
            ? `Đã chọn ${selected.size}/${documents.length} file`
            : `${documents.length} file${tongSoTrang > 0 ? ` · ${tongSoTrang} trang` : ""}${
                soFileChuaRoTrang > 0 ? ` (${soFileChuaRoTrang} file chưa đọc được số trang)` : ""
              }`}
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
              <th className="px-4 py-3 text-right whitespace-nowrap">Số trang</th>
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
                <td className="px-4 py-3 text-right font-medium text-neutral-700 whitespace-nowrap">
                  {/* "—" chứ không phải 0: file OCR hỏng thì KHÔNG BIẾT nó mấy trang, ghi 0 là
                      nói sai và cộng vào tổng cũng sai. */}
                  {documentPageCount(d) ?? <span className="text-neutral-300">—</span>}
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
// Số dòng mặc định của các biểu đồ thanh ngang ở trang tổng quan — "Tiến độ hồ sơ" và "Hồ sơ
// theo nguồn" dùng CHUNG để hai panel cạnh nhau cao bằng nhau.
const SO_DONG_BIEU_DO = 8;

// Nút "▾ Xem thêm N … / ▴ Thu gọn" ở chân các biểu đồ có giới hạn SO_DONG_BIEU_DO dòng.
function NutXemThem({ moRong, soAn, donVi, onToggle }: {
  moRong: boolean;
  soAn: number;
  donVi: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={moRong}
      className="mt-3 w-full flex items-center justify-center gap-1.5 rounded py-1.5 text-xs font-semibold transition-colors hover:bg-neutral-50"
      style={{ color: EL.primary }}
    >
      <span aria-hidden className={`inline-block transition-transform ${moRong ? "rotate-180" : ""}`}>▾</span>
      {moRong ? "Thu gọn" : `Xem thêm ${soAn} ${donVi}`}
    </button>
  );
}

function CaseCompletionChart({ cases }: { cases: CaseListItemDTO[] }) {
  const [moRong, setMoRong] = useState(false);
  const tatCa = cases
    .filter((c) => !c.deletedAt)
    .sort((a, b) => b.percent - a.percent || a.clientName.localeCompare(b.clientName, "vi"));
  const rows = moRong ? tatCa : tatCa.slice(0, SO_DONG_BIEU_DO);

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
      {tatCa.length > SO_DONG_BIEU_DO && (
        <NutXemThem
          moRong={moRong}
          soAn={tatCa.length - SO_DONG_BIEU_DO}
          donVi="hồ sơ"
          onToggle={() => setMoRong((v) => !v)}
        />
      )}
    </div>
  );
}

// Số hồ sơ theo NGUỒN (ô "Nguồn / đối tác" của hồ sơ, vd "Ms. Thanh"). Chỉ hồ sơ đang hoạt
// động. Cách gộp tên gõ lệch nằm ở lib/nguon.ts — dùng chung với "Nhóm theo nguồn" ở trang thống kê.
// Một màu duy nhất: đây là MỘT chuỗi số liệu (đếm), tên nguồn đã nằm ngay cạnh thanh, tô mỗi
// nguồn một màu chỉ thêm nhiễu.

function CaseSourceChart({ cases }: { cases: CaseListItemDTO[] }) {
  const [moRong, setMoRong] = useState(false);
  const song = cases.filter((c) => !c.deletedAt);
  const cacNhom = nhomTheoNguon(song);
  const tatCa = cacNhom.filter((g) => !g.chuaNhap).map((g) => ({ ten: g.ten, dem: g.cases.length }));
  const chuaNhap = cacNhom.find((g) => g.chuaNhap)?.cases.length ?? 0;
  // Mặc định SO_DONG_BIEU_DO dòng như "Tiến độ hồ sơ"; dòng "Chưa nhập nguồn" luôn hiện ở cuối
  // (tính vào số dòng) — nó là việc cần làm, không được bị giấu sau nút "Xem thêm".
  const gioiHan = Math.max(0, SO_DONG_BIEU_DO - (chuaNhap ? 1 : 0));
  const coNutXemThem = tatCa.length > gioiHan;
  const rows: { ten: string; dem: number; phu?: boolean }[] = moRong ? [...tatCa] : tatCa.slice(0, gioiHan);
  if (chuaNhap) rows.push({ ten: CHUA_NHAP_NGUON, dem: chuaNhap, phu: true });
  const max = Math.max(1, ...rows.map((r) => r.dem));

  return (
    <div className="bg-white rounded shadow-sm p-4">
      <p className="text-sm font-semibold text-neutral-700 mb-1">Hồ sơ theo nguồn</p>
      <p className="text-xs text-neutral-400 mb-4">
        {song.length} hồ sơ · {tatCa.length} nguồn
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-400">Chưa có hồ sơ đang hoạt động.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.ten} className="flex items-center gap-3" title={`${r.ten}: ${r.dem} hồ sơ`}>
              <span
                className={`w-28 shrink-0 text-xs truncate ${r.phu ? "italic text-neutral-400" : "text-neutral-600"}`}
              >
                {r.ten}
              </span>
              <div className="flex-1 h-5 rounded-full bg-neutral-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${(r.dem / max) * 100}%`, backgroundColor: r.phu ? "#c0c4cc" : EL.primary }}
                />
              </div>
              <span className="w-10 shrink-0 text-xs font-semibold text-neutral-600 text-right tabular-nums">
                {r.dem}
              </span>
            </div>
          ))}
        </div>
      )}
      {coNutXemThem && (
        <NutXemThem
          moRong={moRong}
          soAn={tatCa.length - gioiHan}
          donVi="nguồn"
          onToggle={() => setMoRong((v) => !v)}
        />
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
          Nhật ký sẽ tự ghi khi hồ sơ chuyển sang “Đang xử lý”, khi tới
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
  hint,
  href,
}: {
  icon: string;
  label: string;
  value: number;
  color: string;
  /** Có thì cả thẻ là một liên kết — bấm mở trang thống kê với đúng bộ lọc của thẻ. */
  href?: string;
  /** Đếm CÁI GÌ — hiện khi rê chuột. Mấy thẻ như "Hoàn thành" với "Đã nộp" nghe na ná nhau,
      không ghi rõ tiêu chí thì mỗi người hiểu một kiểu. */
  hint?: string;
}) {
  const lop = "bg-white rounded shadow-sm p-4 flex items-center gap-4";
  const noiDung = (
    <>
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
    </>
  );
  return href ? (
    <Link href={href} className={`${lop} transition-shadow hover:shadow-md hover:ring-1 hover:ring-blue-200`} title={hint}>
      {noiDung}
    </Link>
  ) : (
    <div className={lop} title={hint}>
      {noiDung}
    </div>
  );
}
