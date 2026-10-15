"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { adminFetch, AdminUnauthorizedError } from "@/lib/adminApi";
import { getAdminPassword } from "@/lib/adminAuth";
import { getApplicationStatus } from "@/lib/application-status";
import { normalizeSearchText, parseUtcDate } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import { EL, AdminSidebar, baoSidebarDemLai } from "@/components/adminUi";
import { ChuongThongBao } from "@/components/ChuongThongBao";
import { ResubmitBadge } from "@/components/ResubmitBadge";
import type { CaseListItemDTO } from "@/lib/client-types";

type CotNgay = "submittedDate" | "biometricsDate";
const API_NGAY: Record<CotNgay, string> = {
  submittedDate: "submitted-date",
  biometricsDate: "biometrics-date",
};

type KetQua = "DAU" | "ROT";

function ngayTiepNhan(iso: string) {
  return parseUtcDate(iso).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Ho_Chi_Minh",
  });
}

/**
 * Trang "CP đang xử lý" (/admin/cpprocessing): hồ sơ ở trạng thái SUBMITTED ("CP đang xử lý" — đã
 * nộp, Chính phủ đang xét). Admin ghi NGÀY NỘP và NGÀY LĂN TAY (ô chọn ngày, đổi là lưu ngay) và chọn
 * KẾT QUẢ: Đậu -> "Được chấp thuận", Rớt -> "Không thành công". Có kết quả là hồ sơ rời khỏi danh sách này.
 * "Nộp lại" KHÔNG còn ở đây (15/10/2026): chỉ sau khi rớt, chọn ở trang chi tiết hồ sơ (cùng "Thanh lý").
 * Ngày lăn tay dùng CHUNG cột với bảng hồ sơ ở trang tổng quan.
 */
export function AdminCpProcessing() {
  const router = useRouter();
  const hydrated = useHydrated();
  const authorized = hydrated ? !!getAdminPassword() : null;

  const [cases, setCases] = useState<CaseListItemDTO[] | null>(null);
  const [loi, setLoi] = useState<string | null>(null);
  const [dangLuu, setDangLuu] = useState<string | null>(null);
  const [thongBao, setThongBao] = useState<string | null>(null);
  // Form tìm kiếm: tên KH / nguồn (không phân biệt dấu) + lọc hồ sơ còn thiếu ngày.
  const [tim, setTim] = useState("");
  const [loc, setLoc] = useState<"ALL" | "CHUA_NGAY_NOP" | "CHUA_LAN_TAY">("ALL");

  const tai = useCallback(async () => {
    try {
      const r = await adminFetch("/admin/cases");
      if (!r.ok) throw new Error();
      const ds: CaseListItemDTO[] = await r.json();
      setCases(ds.filter((c) => !c.deletedAt && c.applicationStatus === "SUBMITTED"));
      setLoi(null);
    } catch (e) {
      if (e instanceof AdminUnauthorizedError) router.replace("/admin");
      else setLoi("Không tải được danh sách hồ sơ.");
    }
  }, [router]);

  useEffect(() => {
    if (authorized) tai();
  }, [authorized, tai]);

  // Nộp lâu nhất lên đầu (đang chờ lâu nhất); chưa ghi ngày nộp xếp cuối, theo ngày tiếp nhận.
  const hienThi = useMemo(
    () =>
      [...(cases ?? [])].sort(
        (a, b) =>
          (a.submittedDate ?? "9999").localeCompare(b.submittedDate ?? "9999") ||
          a.createdAt.localeCompare(b.createdAt),
      ),
    [cases],
  );

  async function doiNgay(c: CaseListItemDTO, cot: CotNgay, giaTri: string) {
    const moi = giaTri || null;
    const cu = c[cot] ?? null;
    if (moi === cu) return;
    setCases((prev) => prev && prev.map((x) => (x.id === c.id ? { ...x, [cot]: moi } : x)));
    setDangLuu(`${c.id}:${cot}`);
    try {
      const res = await adminFetch(`/admin/cases/${c.id}/${API_NGAY[cot]}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [cot]: moi }),
      }).catch(() => null);
      if (!res || !res.ok) {
        setCases((prev) => prev && prev.map((x) => (x.id === c.id ? { ...x, [cot]: cu } : x)));
        alert("Không lưu được ngày — thử lại sau.");
      }
    } finally {
      setDangLuu(null);
    }
  }

  async function chonKetQua(c: CaseListItemDTO, kq: KetQua) {
    const xacNhan =
      kq === "DAU"
        ? `Hồ sơ "${c.clientName}" ĐẬU?\n\nChuyển sang "${getApplicationStatus("APPROVED").label}" — hồ sơ rời khỏi danh sách CP đang xử lý.`
        : `Hồ sơ "${c.clientName}" RỚT?\n\nChuyển sang "${getApplicationStatus("REJECTED").label}" — hồ sơ rời khỏi danh sách CP đang xử lý. ` +
          "Sau đó chọn Thanh lý hoặc Nộp lại ở trang chi tiết hồ sơ.";
    if (!confirm(xacNhan)) return;
    setDangLuu(`${c.id}:kq`);
    try {
      const res = await adminFetch(`/cases/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationStatus: kq === "DAU" ? "APPROVED" : "REJECTED" }),
      }).catch(() => null);
      if (!res || !res.ok) {
        const chiTiet = res ? (await res.json().catch(() => null))?.detail : null;
        alert(chiTiet ?? "Không cập nhật được kết quả — thử lại sau.");
        return;
      }
      setCases((prev) => prev && prev.filter((x) => x.id !== c.id));
      baoSidebarDemLai();
      setThongBao(
        kq === "DAU"
          ? `🎉 "${c.clientName}" — Được chấp thuận.`
          : `"${c.clientName}" — Không thành công. Chọn Thanh lý hoặc Nộp lại ở trang chi tiết hồ sơ (nút Xem ở Tổng quan).`,
      );
    } finally {
      setDangLuu(null);
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

  const q = normalizeSearchText(tim.trim());
  const ketQuaTim = hienThi.filter(
    (c) =>
      (!q || normalizeSearchText(`${c.clientName} ${c.partner ?? ""}`).includes(q)) &&
      (loc === "ALL" || (loc === "CHUA_NGAY_NOP" ? !c.submittedDate : !c.biometricsDate)),
  );
  const dangLoc = !!q || loc !== "ALL";
  const chuaNgayNop = hienThi.filter((c) => !c.submittedDate).length;
  const chuaLanTay = hienThi.filter((c) => !c.biometricsDate).length;
  const oNgay = (c: CaseListItemDTO, cot: CotNgay, nhan: string) => (
    <input
      type="date"
      value={c[cot] ?? ""}
      disabled={dangLuu === `${c.id}:${cot}`}
      onChange={(e) => doiNgay(c, cot, e.target.value)}
      aria-label={`${nhan} của ${c.clientName}`}
      title={`Chọn ${nhan.toLowerCase()} — xoá trắng ô để bỏ ngày`}
      className={`rounded border px-2 py-1 text-xs outline-none focus:border-blue-400 disabled:opacity-50 ${
        c[cot] ? "border-blue-300 bg-blue-50 font-semibold text-blue-800" : "border-neutral-200 bg-white text-neutral-500"
      }`}
    />
  );

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: "#f0f2f5" }}>
      <AdminSidebar activeTab="cpProcessing" />
      <main className="flex-1 min-w-0">
        <div className="h-14 bg-white border-b border-neutral-200 flex items-center px-6 text-sm">
          <span className="text-neutral-400">Quản trị</span>
          <span className="mx-2 text-neutral-300">/</span>
          <span className="font-medium text-neutral-700">CP đang xử lý</span>
          <ChuongThongBao />
        </div>

        <div className="p-6 flex flex-col gap-4">
          {thongBao && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 flex items-start justify-between gap-3">
              <span>{thongBao}</span>
              <button type="button" onClick={() => setThongBao(null)} className="text-green-700/70 hover:text-green-900" aria-label="Đóng">
                ✕
              </button>
            </p>
          )}
          {loi && <p className="text-sm text-red-600">{loi}</p>}

          <div className="bg-white rounded shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-100">
              <h1 className="text-sm font-semibold text-neutral-800">Hồ sơ Chính phủ đang xử lý</h1>
              <p className="mt-0.5 text-xs text-neutral-500">
                {cases === null
                  ? "Đang tải…"
                  : `${hienThi.length} hồ sơ đang chờ kết quả` +
                    (chuaNgayNop ? ` · ${chuaNgayNop} chưa ghi ngày nộp` : "") +
                    (chuaLanTay ? ` · ${chuaLanTay} chưa có ngày lăn tay` : "") +
                    " · chọn KQ là hồ sơ rời khỏi danh sách này"}
              </p>
              {/* Form tìm kiếm */}
              <form
                role="search"
                onSubmit={(e) => e.preventDefault()}
                className="mt-3 flex flex-wrap items-center gap-2"
              >
                <input
                  type="search"
                  value={tim}
                  onChange={(e) => setTim(e.target.value)}
                  placeholder="🔍 Tìm tên khách hàng hoặc nguồn (gõ không dấu cũng được)"
                  aria-label="Tìm hồ sơ"
                  className="w-full sm:w-80 rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-400"
                />
                <select
                  value={loc}
                  onChange={(e) => setLoc(e.target.value as typeof loc)}
                  aria-label="Lọc hồ sơ"
                  className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-700"
                >
                  <option value="ALL">Tất cả hồ sơ</option>
                  <option value="CHUA_NGAY_NOP">Chưa ghi ngày nộp ({chuaNgayNop})</option>
                  <option value="CHUA_LAN_TAY">Chưa có ngày lăn tay ({chuaLanTay})</option>
                </select>
                {dangLoc && (
                  <>
                    <span className="text-xs text-neutral-500">
                      Hiển thị {ketQuaTim.length}/{hienThi.length} hồ sơ
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setTim("");
                        setLoc("ALL");
                      }}
                      className="rounded px-2 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50"
                    >
                      Xoá tìm kiếm
                    </button>
                  </>
                )}
              </form>
            </div>

            {cases !== null && hienThi.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-neutral-500">
                Không có hồ sơ nào ở trạng thái “CP đang xử lý”.
              </p>
            ) : cases !== null && ketQuaTim.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-neutral-500">
                Không có hồ sơ nào khớp tìm kiếm.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
                      <th className="px-4 py-3 w-12">STT</th>
                      <th className="px-4 py-3 whitespace-nowrap">Ngày tiếp nhận</th>
                      <th className="px-4 py-3">Tên KH</th>
                      <th className="px-4 py-3 whitespace-nowrap">Ngày nộp</th>
                      <th className="px-4 py-3 whitespace-nowrap">Ngày lăn tay</th>
                      <th className="px-4 py-3">KQ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {ketQuaTim.map((c, i) => {
                      return (
                        <tr key={c.id} className="hover:bg-neutral-50">
                          <td className="px-4 py-3 text-neutral-500 tabular-nums">{i + 1}</td>
                          <td className="px-4 py-3 text-xs text-neutral-600 whitespace-nowrap tabular-nums">
                            {ngayTiepNhan(c.createdAt)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Link href={`/admin/cases/${c.id}`} className="font-medium text-neutral-800 hover:underline">
                                {c.clientName}
                              </Link>
                              <ResubmitBadge round={c.submissionRound} />
                            </div>
                            {c.partner && <p className="mt-0.5 text-xs text-neutral-400">{c.partner}</p>}
                          </td>
                          <td className="px-4 py-3">{oNgay(c, "submittedDate", "Ngày nộp")}</td>
                          <td className="px-4 py-3">{oNgay(c, "biometricsDate", "Ngày lăn tay")}</td>
                          <td className="px-4 py-3">
                            <select
                              value=""
                              disabled={dangLuu === `${c.id}:kq`}
                              onChange={(e) => e.target.value && chonKetQua(c, e.target.value as KetQua)}
                              aria-label={`Kết quả của ${c.clientName}`}
                              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs font-semibold text-neutral-700 cursor-pointer disabled:opacity-50"
                            >
                              <option value="">— Chờ kết quả —</option>
                              <option value="DAU">🎉 Đậu</option>
                              <option value="ROT">❌ Rớt</option>
                              {/* Không còn "Nộp lại" ở đây (15/10/2026): CP đang xử lý -> Đậu / Rớt; Rớt rồi mới
                                  Thanh lý / Nộp lại ở trang chi tiết hồ sơ. */}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
