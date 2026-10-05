"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { adminFetch, AdminUnauthorizedError } from "@/lib/adminApi";
import { getAdminPassword } from "@/lib/adminAuth";
import { parseUtcDate } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import { EL, Tag, AdminSidebar } from "@/components/adminUi";
import { ChuongThongBao } from "@/components/ChuongThongBao";

interface ActivityItem {
  id: number;
  createdAt: string;
  actorName: string | null;
  actorRole: "staff" | "admin";
  ip: string | null;
  device: string | null;
  action: string;
  caseId: string | null;
  caseClientName: string | null;
  documentId: string | null;
  detail: string | null;
}

interface PersonSummary {
  name: string | null;
  actionsToday: number;
  casesToday: number;
  lastAt: string | null;
}

interface ActivityResponse {
  items: ActivityItem[];
  hasMore: boolean;
  people: PersonSummary[];
  actions: Record<string, string>;
  retentionDays: number;
}

const KHONG_TEN = "__none__";
const LAM_MOI_GIAY = 30;
// Thao tác trong vòng bấy nhiêu phút thì coi là "đang hoạt động".
const DANG_HOAT_DONG_PHUT = 15;

// Màu theo LOẠI thao tác — nhìn lướt là tách được xoá (đỏ) khỏi upload (xanh lá) khỏi chỉ-xem (xám).
const MAU_THAO_TAC: Record<string, string> = {
  CASE_VIEW: EL.info,
  DOC_OPEN: EL.info,
  ZIP_DOWNLOAD: EL.info,
  DOC_UPLOAD: EL.success,
  CASE_CREATE: EL.success,
  CASE_RESTORE: EL.success,
  DOC_DELETE: EL.danger,
  DOC_DELETE_ALL: EL.danger,
  CASE_DELETE: EL.danger,
  CASE_PURGE: EL.danger,
  STATUS_CHANGE: EL.warning,
  CASE_COMPLETE: EL.warning,
  CASE_UNCOMPLETE: EL.warning,
  CASE_RESUBMIT: EL.warning,
};

function gio(iso: string) {
  return parseUtcDate(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function ngayGio(iso: string) {
  const d = parseUtcDate(iso);
  const homNay = new Date().toDateString() === d.toDateString();
  const ngay = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  return homNay ? `${gio(iso)} hôm nay` : `${gio(iso)} ${ngay}`;
}

function phutTruoc(iso: string) {
  return (Date.now() - parseUtcDate(iso).getTime()) / 60000;
}

/**
 * Tab "Theo dõi Docs": nhân viên Docs đang làm gì, trên hồ sơ nào, lúc nào.
 *
 * Tên người là tên TỰ CHỌN ở trang Docs (components/StaffIdentity.tsx), không phải đăng nhập —
 * đủ để nắm công việc hằng ngày, không đủ làm bằng chứng. Tự làm mới mỗi 30 giây.
 */
export function AdminActivity() {
  const router = useRouter();
  const hydrated = useHydrated();
  const authorized = hydrated ? !!getAdminPassword() : null;

  const [nguoi, setNguoi] = useState("");
  const [thaoTac, setThaoTac] = useState("");
  const [soNgay, setSoNgay] = useState(7);
  const [timNhap, setTimNhap] = useState("");
  const [tim, setTim] = useState("");
  const [tuLamMoi, setTuLamMoi] = useState(true);

  const [data, setData] = useState<ActivityResponse | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [conNua, setConNua] = useState(false);
  const [dangTai, setDangTai] = useState(false);
  const [loi, setLoi] = useState<string | null>(null);
  const [capNhatLuc, setCapNhatLuc] = useState<Date | null>(null);

  // Gõ ô tìm thì chờ người dùng ngừng gõ rồi mới hỏi máy chủ, không hỏi theo từng phím.
  useEffect(() => {
    const t = setTimeout(() => setTim(timNhap.trim()), 400);
    return () => clearTimeout(t);
  }, [timNhap]);

  const taoQuery = useCallback(
    (truocId?: number) => {
      const p = new URLSearchParams({ days: String(soNgay), limit: "200" });
      if (nguoi) p.set("actor", nguoi);
      if (thaoTac) p.set("action", thaoTac);
      if (tim) p.set("q", tim);
      if (truocId) p.set("before_id", String(truocId));
      return `/activity/log?${p}`;
    },
    [nguoi, thaoTac, soNgay, tim],
  );

  const tai = useCallback(async () => {
    setDangTai(true);
    try {
      const r = await adminFetch(taoQuery());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: ActivityResponse = await r.json();
      setData(d);
      setItems(d.items);
      setConNua(d.hasMore);
      setLoi(null);
      setCapNhatLuc(new Date());
    } catch (e) {
      if (e instanceof AdminUnauthorizedError) router.replace("/admin");
      else setLoi("Không tải được lịch sử thao tác.");
    } finally {
      setDangTai(false);
    }
  }, [taoQuery, router]);

  useEffect(() => {
    if (authorized) tai();
  }, [authorized, tai]);

  // Tự làm mới — giữ tham chiếu mới nhất của `tai` để interval không phải dựng lại mỗi lần lọc.
  const taiRef = useRef(tai);
  taiRef.current = tai;
  useEffect(() => {
    if (!authorized || !tuLamMoi) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") taiRef.current();
    }, LAM_MOI_GIAY * 1000);
    return () => clearInterval(t);
  }, [authorized, tuLamMoi]);

  async function taiThem() {
    const cuoi = items[items.length - 1];
    if (!cuoi) return;
    setDangTai(true);
    try {
      const r = await adminFetch(taoQuery(cuoi.id));
      const d: ActivityResponse = await r.json();
      setItems((cu) => [...cu, ...d.items]);
      setConNua(d.hasMore);
    } catch (e) {
      if (e instanceof AdminUnauthorizedError) router.replace("/admin");
    } finally {
      setDangTai(false);
    }
  }

  if (authorized === null) return null;
  if (!authorized) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ backgroundColor: EL.sidebarBgActive }}>
        <p className="text-white text-sm mb-4">Bạn cần đăng nhập Admin trước khi xem trang này.</p>
        <Link href="/admin" className="text-sm font-semibold text-white rounded px-4 py-2" style={{ backgroundColor: EL.primary }}>
          Đến trang đăng nhập Admin
        </Link>
      </div>
    );
  }

  const nhan = data?.actions ?? {};
  const nguoiLam = (data?.people ?? []).filter((p) => p.name);
  const coKhongTen = (data?.people ?? []).some((p) => !p.name);

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: "#f0f2f5" }}>
      <AdminSidebar activeTab="activity" />
      <main className="flex-1 min-w-0">
        <div className="h-14 bg-white border-b border-neutral-200 flex items-center px-6 text-sm">
          <span className="text-neutral-400">Quản trị</span>
          <span className="mx-2 text-neutral-300">/</span>
          <span className="font-medium text-neutral-700">Theo dõi Docs</span>
          <ChuongThongBao />
        </div>

        <div className="p-6 flex flex-col gap-5">
          {/* ---- Ai đang làm gì hôm nay ---- */}
          <section className="bg-white rounded shadow-sm p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
              <h2 className="text-sm font-semibold text-neutral-800">Nhân viên Docs hôm nay</h2>
              <p className="text-xs text-neutral-500">
                {capNhatLuc ? `Cập nhật lúc ${capNhatLuc.toLocaleTimeString("vi-VN")}` : "Đang tải…"}
                {tuLamMoi ? ` · tự làm mới mỗi ${LAM_MOI_GIAY} giây` : ""}
              </p>
            </div>
            {nguoiLam.length === 0 ? (
              <p className="text-sm text-neutral-500">
                Chưa có ai thao tác. Nhân viên chọn tên ở ô “Bạn là ai?” khi mở trang Docs — từ đó
                mọi thao tác sẽ hiện ở đây.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {nguoiLam.map((p) => {
                  const dangLam = p.lastAt !== null && phutTruoc(p.lastAt) <= DANG_HOAT_DONG_PHUT;
                  const chon = nguoi === p.name;
                  return (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => setNguoi(chon ? "" : (p.name as string))}
                      className="text-left rounded border px-4 py-3 transition-colors hover:bg-neutral-50"
                      style={{ borderColor: chon ? EL.primary : "#e5e7eb", boxShadow: chon ? `0 0 0 1px ${EL.primary}` : undefined }}
                      title={chon ? "Bỏ lọc theo người này" : "Chỉ xem thao tác của người này"}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: dangLam ? EL.success : "#d1d5db" }}
                        />
                        <span className="font-semibold text-sm text-neutral-800 truncate">{p.name}</span>
                      </div>
                      <p className="mt-1 text-xs" style={{ color: dangLam ? "#3f8f23" : "#6b7280" }}>
                        {dangLam ? "Đang hoạt động" : p.lastAt ? `Lần cuối: ${ngayGio(p.lastAt)}` : "—"}
                      </p>
                      <p className="mt-1.5 text-xs text-neutral-600">
                        <span className="font-semibold text-neutral-800 tabular-nums">{p.actionsToday}</span> thao tác ·{" "}
                        <span className="font-semibold text-neutral-800 tabular-nums">{p.casesToday}</span> hồ sơ hôm nay
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* ---- Bộ lọc ---- */}
          <section className="bg-white rounded shadow-sm p-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              Người
              <select value={nguoi} onChange={(e) => setNguoi(e.target.value)} className="border border-neutral-300 rounded px-2 py-1.5 text-sm text-neutral-800 min-w-40">
                <option value="">Tất cả</option>
                {nguoiLam.map((p) => (
                  <option key={p.name} value={p.name as string}>
                    {p.name}
                  </option>
                ))}
                {coKhongTen && <option value={KHONG_TEN}>(chưa chọn tên)</option>}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              Thao tác
              <select value={thaoTac} onChange={(e) => setThaoTac(e.target.value)} className="border border-neutral-300 rounded px-2 py-1.5 text-sm text-neutral-800 min-w-44">
                <option value="">Tất cả</option>
                {Object.entries(nhan).map(([ma, ten]) => (
                  <option key={ma} value={ma}>
                    {ten}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              Thời gian
              <select value={soNgay} onChange={(e) => setSoNgay(Number(e.target.value))} className="border border-neutral-300 rounded px-2 py-1.5 text-sm text-neutral-800">
                <option value={1}>24 giờ qua</option>
                <option value={7}>7 ngày qua</option>
                <option value={30}>30 ngày qua</option>
                <option value={0}>Tất cả (giữ {data?.retentionDays ?? 45} ngày)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 flex-1 min-w-48">
              Tìm theo tên khách / tên file
              <input
                value={timNhap}
                onChange={(e) => setTimNhap(e.target.value)}
                placeholder="VD: Nguyễn Văn Thanh"
                className="border border-neutral-300 rounded px-2 py-1.5 text-sm text-neutral-800"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-600 pb-2 cursor-pointer">
              <input type="checkbox" checked={tuLamMoi} onChange={(e) => setTuLamMoi(e.target.checked)} />
              Tự làm mới
            </label>
          </section>

          {/* ---- Dòng thời gian ---- */}
          <section className="bg-white rounded shadow-sm overflow-hidden">
            {loi && <p className="px-4 py-3 text-sm" style={{ color: EL.danger }}>{loi}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-neutral-500 bg-neutral-50 border-b border-neutral-200">
                    <th className="px-4 py-3 whitespace-nowrap">Thời gian</th>
                    <th className="px-4 py-3">Người</th>
                    <th className="px-4 py-3">Thao tác</th>
                    <th className="px-4 py-3">Hồ sơ</th>
                    <th className="px-4 py-3">Chi tiết</th>
                    <th className="px-4 py-3">Máy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {items.map((it) => (
                    <tr key={it.id} className="hover:bg-neutral-50 align-top">
                      <td className="px-4 py-2.5 whitespace-nowrap tabular-nums text-neutral-600" title={parseUtcDate(it.createdAt).toLocaleString("vi-VN")}>
                        {ngayGio(it.createdAt)}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span className={it.actorName ? "font-medium text-neutral-800" : "italic text-neutral-400"}>
                          {it.actorName ?? "(chưa chọn tên)"}
                        </span>
                        {it.actorRole === "admin" && (
                          <span className="ml-1.5 align-middle">
                            <Tag color={EL.primary}>Admin</Tag>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <Tag color={MAU_THAO_TAC[it.action] ?? EL.primary}>{nhan[it.action] ?? it.action}</Tag>
                      </td>
                      <td className="px-4 py-2.5">
                        {it.caseId ? (
                          <Link href={`/admin/cases/${it.caseId}`} target="_blank" className="text-neutral-800 hover:underline">
                            {it.caseClientName ?? "(hồ sơ)"}
                          </Link>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-700 break-words max-w-md">{it.detail ?? ""}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-neutral-500">
                        {[it.device, it.ip].filter(Boolean).join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 && !dangTai && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-sm text-neutral-500">
                        Không có thao tác nào khớp bộ lọc.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {conNua && (
              <div className="border-t border-neutral-100 px-4 py-3 text-center">
                <button
                  type="button"
                  onClick={taiThem}
                  disabled={dangTai}
                  className="text-sm font-semibold rounded px-4 py-1.5 border disabled:opacity-50"
                  style={{ color: EL.primary, borderColor: EL.primary }}
                >
                  {dangTai ? "Đang tải…" : "Tải thêm"}
                </button>
              </div>
            )}
          </section>
          <p className="text-xs text-neutral-500">
            Tên người là tên nhân viên tự chọn ở trang Docs, không phải đăng nhập — dùng để nắm công
            việc, không dùng làm bằng chứng. “Mở hồ sơ” và “Mở file” chỉ ghi 1 lần mỗi 30 / 10 phút
            cho cùng một người. Lịch sử tự xoá sau {data?.retentionDays ?? 45} ngày.
          </p>
        </div>
      </main>
    </div>
  );
}
