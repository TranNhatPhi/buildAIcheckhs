"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { ResubmitBadge } from "@/components/ResubmitBadge";
import { ngayCungCap } from "@/components/ExperienceUnitsField";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { adminFetch, AdminUnauthorizedError } from "@/lib/adminApi";
import { getAdminPassword } from "@/lib/adminAuth";
import { parseUtcDate } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import { APPLICATION_STATUS_HEX_COLOR, getApplicationStatus } from "@/lib/application-status";
import { BO_LOC_HO_SO, laKhoaLoc, type KhoaLoc } from "@/lib/adminCaseFilters";
import { nhomTheoNguon } from "@/lib/nguon";
import { EL, Tag, AdminSidebar, NutNhomTheoNguon, DongTieuDeNhom } from "@/components/adminUi";
import { ChuongThongBao } from "@/components/ChuongThongBao";
import type { CaseListItemDTO } from "@/lib/client-types";

const THANG = Array.from({ length: 12 }, (_, i) => i + 1);

/** Tháng/năm theo GIỜ VIỆT NAM của lúc tạo hồ sơ. Backend lưu UTC không kèm múi giờ — tính
 *  thẳng theo UTC là hồ sơ tạo 0h–7h sáng mùng 1 bị đếm sang tháng trước. */
function thangNam(iso: string): { nam: number; thang: number } {
  const d = parseUtcDate(iso);
  return { nam: d.getFullYear(), thang: d.getMonth() + 1 };
}

function ngayVN(iso: string) {
  return parseUtcDate(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

type CotSapXep = "tiepNhan" | "cungCap" | "capNhat" | "tyLe";
const COT_SAP_XEP: CotSapXep[] = ["tiepNhan", "cungCap", "capNhat", "tyLe"];

/** Giá trị để so khi sắp xếp; null = ô "—" (chưa có dữ liệu). */
function khoaSapXep(c: CaseListItemDTO, cot: CotSapXep): number | null {
  switch (cot) {
    case "tiepNhan":
      return parseUtcDate(c.createdAt).getTime();
    case "cungCap": {
      // "YYYY-MM-DD" — Date.parse đọc theo UTC, chỉ dùng để SO SÁNH nên không lệch múi giờ.
      const d = c.experienceUnits?.[0]?.confirmedDate;
      return d ? Date.parse(d) : null;
    }
    case "capNhat":
      return c.lastDocumentAt ? parseUtcDate(c.lastDocumentAt).getTime() : null;
    case "tyLe":
      return c.percent;
  }
}

/**
 * Trang thống kê hồ sơ của admin: biểu đồ số hồ sơ tạo mới theo 12 tháng + bảng chi tiết, lọc
 * theo năm / tháng / tiêu chí của từng thẻ trên trang tổng quan.
 *
 * Bộ lọc nằm trên THANH ĐỊA CHỈ (?nam=&thang=&loc=): bấm thẻ ở trang tổng quan là mở thẳng
 * trang này với đúng bộ lọc đó, F5 không mất, gửi link cho người khác cũng ra đúng góc nhìn.
 */
export function AdminCaseReport() {
  const router = useRouter();
  const params = useSearchParams();
  const hydrated = useHydrated();
  const authorized = hydrated ? !!getAdminPassword() : null;

  const [cases, setCases] = useState<CaseListItemDTO[] | null>(null);
  const [loi, setLoi] = useState<string | null>(null);
  const [dangTro, setDangTro] = useState<number | null>(null);

  const namNay = new Date().getFullYear();
  const nam = Number(params.get("nam")) || namNay;
  const thang = Number(params.get("thang")) || null;
  const locRaw = params.get("loc");
  const loc: KhoaLoc = laKhoaLoc(locRaw) ? locRaw : "tatCa";
  // Sắp xếp bảng: ?cot= (cột) + ?sx= (chiều). Mặc định: Ngày tiếp nhận, mới nhất trước — để mặc định
  // thì không ghi lên URL cho gọn. Bấm tiêu đề cột đang chọn = đảo chiều; bấm cột khác = sang cột đó,
  // mới nhất / cao nhất trước.
  const cotRaw = params.get("cot");
  const cot: CotSapXep = COT_SAP_XEP.includes(cotRaw as CotSapXep) ? (cotRaw as CotSapXep) : "tiepNhan";
  const tangDan = params.get("sx") === "asc";
  // ?nhom=nguon: bảng chia nhóm theo nguồn (mỗi nguồn một khối, có dòng tiêu đề + số hồ sơ).
  const nhomNguon = params.get("nhom") === "nguon";

  function datLoc(thayDoi: Record<string, string | number | null>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(thayDoi)) {
      if (v === null || v === "" || (k === "loc" && v === "tatCa") || (k === "sx" && v === "desc") || (k === "cot" && v === "tiepNhan")) p.delete(k);
      else p.set(k, String(v));
    }
    router.replace(`/admin/thong-ke${p.toString() ? `?${p}` : ""}`, { scroll: false });
  }

  useEffect(() => {
    if (!authorized) return;
    adminFetch("/admin/cases")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((ds: CaseListItemDTO[]) => setCases(ds.filter((c) => !c.deletedAt)))
      .catch((e) => {
        if (e instanceof AdminUnauthorizedError) router.replace("/admin");
        else setLoi("Không tải được danh sách hồ sơ.");
      });
  }, [authorized, router]);

  // Năm có trong dữ liệu + năm nay, để ô chọn năm không có năm trống trơn.
  const cacNam = useMemo(() => {
    const s = new Set<number>([namNay, nam]);
    for (const c of cases ?? []) s.add(thangNam(c.createdAt).nam);
    return [...s].sort((a, b) => b - a);
  }, [cases, namNay, nam]);

  // Hồ sơ của năm đang chọn, đã qua bộ lọc tiêu chí — nguồn cho CẢ biểu đồ lẫn bảng.
  const trongNam = useMemo(
    () => (cases ?? []).filter((c) => thangNam(c.createdAt).nam === nam && BO_LOC_HO_SO[loc].dat(c)),
    [cases, nam, loc],
  );
  const theoThang = useMemo(() => {
    const dem = new Array(12).fill(0) as number[];
    for (const c of trongNam) dem[thangNam(c.createdAt).thang - 1]++;
    return dem;
  }, [trongNam]);
  const bang = useMemo(
    () =>
      trongNam
        .filter((c) => !thang || thangNam(c.createdAt).thang === thang)
        .sort((a, b) => {
          const ka = khoaSapXep(a, cot);
          const kb = khoaSapXep(b, cot);
          // Không có giá trị ("—") luôn nằm CUỐI, dù xếp tăng hay giảm — không thì xếp tăng là cả
          // đống hồ sơ chưa nhập đẩy những dòng có dữ liệu xuống dưới.
          if (ka === null || kb === null) {
            if (ka !== kb) return ka === null ? 1 : -1;
          } else if (ka !== kb) {
            return tangDan ? ka - kb : kb - ka;
          }
          return a.clientName.localeCompare(b.clientName, "vi");
        }),
    [trongNam, thang, cot, tangDan],
  );
  const cacNhom = useMemo(() => (nhomNguon ? nhomTheoNguon(bang) : []), [nhomNguon, bang]);

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

  const max = Math.max(...theoThang, 0);
  const thangDinh = max > 0 ? theoThang.indexOf(max) : -1;
  // Trục dọc: 3 mốc tròn trịa, không để mốc lẻ kiểu 7.33.
  const buoc = max <= 4 ? 1 : Math.ceil(max / 4);
  const tran = Math.max(buoc * 4, 1);

  // Tiêu đề cột bấm để sắp xếp. Cột đang chọn tô xanh mũi tên theo chiều; cột khác để cả hai mũi tên xám.
  function tieuDeSapXep(ma: CotSapXep, nhan: string, goiY?: string, canhPhai = false) {
    const dangChon = cot === ma;
    return (
      <th
        className={`px-3 py-3 whitespace-nowrap ${canhPhai ? "text-right" : ""}`}
        aria-sort={dangChon ? (tangDan ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          onClick={() => datLoc(dangChon ? { sx: tangDan ? "desc" : "asc" } : { cot: ma, sx: "desc" })}
          className="inline-flex items-center gap-1 font-semibold hover:text-neutral-800"
          title={`${goiY ? `${goiY}. ` : ""}${
            dangChon ? (tangDan ? "Đang xếp tăng dần — bấm để xếp giảm dần" : "Đang xếp giảm dần — bấm để xếp tăng dần") : "Bấm để sắp xếp theo cột này"
          }`}
        >
          {nhan}
          <span aria-hidden className="inline-flex flex-col text-[8px] leading-[8px]">
            <span style={{ color: dangChon && tangDan ? EL.primary : "#c0c4cc" }}>▲</span>
            <span style={{ color: dangChon && !tangDan ? EL.primary : "#c0c4cc" }}>▼</span>
          </span>
        </button>
      </th>
    );
  }

  // Một dòng hồ sơ — dùng chung cho bảng liền và bảng nhóm theo nguồn (STT đếm lại từ 1 mỗi nhóm).
  function dongHoSo(c: CaseListItemDTO, stt: number) {
    return (
      <tr key={c.id} className="hover:bg-neutral-50">
        <td className="px-3 py-2.5 text-right text-neutral-400 tabular-nums">{stt}</td>
        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-neutral-600">{ngayVN(c.createdAt)}</td>
        <td className="px-3 py-2.5">
          <Link href={`/admin/cases/${c.id}`} target="_blank" className="font-medium text-neutral-800 hover:underline">
            {c.clientName}
          </Link>{" "}
          <ResubmitBadge round={c.submissionRound} />
        </td>
        {/* "—" cho ô chưa nhập: hồ sơ tạo trước khi có các trường này sẽ trống. Nhiều đơn vị thì
            cách nhau dấu phẩy; "Thời gian cung cấp" là ngày của đơn vị ĐẦU TIÊN. */}
        <td className="px-3 py-2.5 text-neutral-600">
          {c.experienceUnits?.length ? (
            c.experienceUnits.map((u) => u.name).join(", ")
          ) : (
            <span className="text-neutral-300">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-neutral-600">
          {ngayCungCap(c.experienceUnits) ?? <span className="text-neutral-300">—</span>}
        </td>
        <td className="px-3 py-2.5 text-neutral-600">{c.partner ?? <span className="text-neutral-300">—</span>}</td>
        <td className="px-3 py-2.5">
          <Tag color={APPLICATION_STATUS_HEX_COLOR[c.applicationStatus]}>
            {getApplicationStatus(c.applicationStatus).label}
          </Tag>
        </td>
        {/* Lần có file mới gần nhất — cùng mốc với nhắc "7 ngày chưa cập nhật". */}
        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-neutral-600">
          {c.lastDocumentAt ? ngayVN(c.lastDocumentAt) : <span className="text-neutral-300">—</span>}
        </td>
        <td className="px-3 py-2.5 text-right">
          <Tag color={c.percent === 100 ? EL.success : EL.primary}>{c.percent}%</Tag>
        </td>
      </tr>
    );
  }

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: "#f0f2f5" }}>
      <AdminSidebar activeTab="report" />

      <div className="flex-1 min-w-0">
        <header className="h-14 bg-white border-b border-neutral-200 flex items-center px-6">
          <p className="text-sm text-neutral-400">
            <Link href="/admin" className="hover:underline">Quản trị</Link>
            <span className="mx-1.5 text-neutral-300">/</span>
            <span className="text-neutral-700 font-medium">Thống kê hồ sơ</span>
          </p>
          <ChuongThongBao />
        </header>

        <main className="p-6 flex flex-col gap-5">
          {/* Bộ lọc: một hàng phía trên biểu đồ, cùng tác động lên biểu đồ lẫn bảng. */}
          <div className="bg-white rounded shadow-sm p-4 flex flex-wrap items-end gap-4">
            <label className="text-xs text-neutral-500">
              Năm
              <select
                value={nam}
                onChange={(e) => datLoc({ nam: e.target.value, thang: null })}
                className="mt-1 block border border-neutral-300 rounded px-2.5 py-1.5 text-sm text-neutral-800"
              >
                {cacNam.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="text-xs text-neutral-500">
              Tháng
              <select
                value={thang ?? ""}
                onChange={(e) => datLoc({ thang: e.target.value || null })}
                className="mt-1 block border border-neutral-300 rounded px-2.5 py-1.5 text-sm text-neutral-800"
              >
                <option value="">Cả năm</option>
                {THANG.map((t) => <option key={t} value={t}>Tháng {t}</option>)}
              </select>
            </label>
            <label className="text-xs text-neutral-500">
              Tiêu chí
              <select
                value={loc}
                onChange={(e) => datLoc({ loc: e.target.value })}
                className="mt-1 block border border-neutral-300 rounded px-2.5 py-1.5 text-sm text-neutral-800"
              >
                {(Object.keys(BO_LOC_HO_SO) as KhoaLoc[]).map((k) => (
                  <option key={k} value={k}>{BO_LOC_HO_SO[k].nhan}</option>
                ))}
              </select>
            </label>
            {(thang || loc !== "tatCa") && (
              <button
                onClick={() => datLoc({ thang: null, loc: null })}
                className="text-xs font-semibold px-3 py-1.5 rounded bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              >
                Bỏ lọc
              </button>
            )}
          </div>

          {loi && <p className="text-sm text-red-600">{loi}</p>}
          {!cases && !loi && <p className="text-sm text-neutral-500">Đang tải...</p>}

          {cases && (
            <>
              {/* ── Biểu đồ: số hồ sơ tạo mới theo tháng ── */}
              <section className="bg-white rounded shadow-sm p-5">
                <div className="flex items-baseline justify-between mb-4">
                  <h2 className="text-sm font-semibold text-neutral-800">
                    Hồ sơ tạo mới theo tháng — năm {nam}
                    {loc !== "tatCa" && <span className="font-normal text-neutral-500"> · {BO_LOC_HO_SO[loc].nhan}</span>}
                  </h2>
                  <p className="text-xs text-neutral-500">
                    Tổng cả năm: <span className="font-semibold text-neutral-800">{trongNam.length}</span> hồ sơ
                    · Bấm vào cột để xem tháng đó
                  </p>
                </div>

                <div className="flex gap-3">
                  {/* Trục dọc: lưới nhạt, chỉ 3 mốc để không tranh chú ý với cột. */}
                  <div className="relative w-6 h-48 shrink-0 text-[10px] text-neutral-400">
                    {[0, 2, 4].map((k) => (
                      <span key={k} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (k / 4) * 100}%` }}>
                        {(tran / 4) * k}
                      </span>
                    ))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="relative h-48">
                      {[0, 2, 4].map((k) => (
                        <div key={k} className="absolute inset-x-0 border-t border-neutral-100" style={{ top: `${100 - (k / 4) * 100}%` }} />
                      ))}
                      <div className="absolute inset-0 flex items-end gap-0.5">
                        {theoThang.map((so, i) => {
                          const t = i + 1;
                          const dangChon = thang === t;
                          const mo = thang !== null && !dangChon;
                          // Nhãn số CHỌN LỌC: chỉ tháng cao nhất, tháng đang chọn, tháng đang rê chuột
                          // — ghi số trên cả 12 cột thì biểu đồ thành bảng số khó đọc.
                          const hienSo = so > 0 && (i === thangDinh || dangChon || dangTro === i);
                          return (
                            <button
                              key={t}
                              type="button"
                              onClick={() => datLoc({ thang: dangChon ? null : t })}
                              onMouseEnter={() => setDangTro(i)}
                              onMouseLeave={() => setDangTro(null)}
                              onFocus={() => setDangTro(i)}
                              onBlur={() => setDangTro(null)}
                              className="relative flex-1 h-full flex flex-col justify-end items-center group focus:outline-none"
                              aria-label={`Tháng ${t}/${nam}: ${so} hồ sơ`}
                            >
                              {dangTro === i && (
                                <span className="absolute -top-1 -translate-y-full z-10 whitespace-nowrap rounded bg-neutral-800 px-2 py-1 text-[11px] text-white shadow">
                                  Tháng {t}/{nam}: <b>{so}</b> hồ sơ
                                </span>
                              )}
                              {hienSo && dangTro !== i && (
                                <span className="mb-1 text-[11px] font-semibold text-neutral-700">{so}</span>
                              )}
                              <span
                                className="w-full max-w-10 rounded-t transition-opacity"
                                style={{
                                  height: so > 0 ? `${(so / tran) * 100}%` : "2px",
                                  backgroundColor: so > 0 ? EL.primary : "#d4d4d4",
                                  opacity: mo ? 0.3 : 1,
                                }}
                              />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex gap-0.5 mt-1.5 border-t border-neutral-200 pt-1.5">
                      {THANG.map((t) => (
                        <span
                          key={t}
                          className={`flex-1 text-center text-[11px] ${thang === t ? "font-semibold text-neutral-800" : "text-neutral-400"}`}
                        >
                          T{t}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* ── Bảng chi tiết ── */}
              <section className="bg-white rounded shadow-sm overflow-hidden">
                <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100">
                  <p className="text-xs text-neutral-500">
                    {bang.length} hồ sơ · {thang ? `tháng ${thang}/${nam}` : `cả năm ${nam}`}
                    {nhomNguon && cacNhom.length > 0 ? ` · ${cacNhom.filter((g) => !g.chuaNhap).length} nguồn` : ""}
                  </p>
                  <NutNhomTheoNguon bat={nhomNguon} onToggle={() => datLoc({ nhom: nhomNguon ? null : "nguon" })} />
                </div>
                {bang.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-neutral-400">Không có hồ sơ nào khớp bộ lọc.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
                          <th className="px-3 py-3 w-12 text-right">STT</th>
                          {tieuDeSapXep("tiepNhan", "Ngày tiếp nhận")}
                          <th className="px-3 py-3">Tên KH</th>
                          <th className="px-3 py-3">Tên đơn vị XNKN</th>
                          {tieuDeSapXep("cungCap", "Ngày cung cấp", "Ngày ghi lúc nhập đơn vị XNKN đầu tiên")}
                          <th className="px-3 py-3">Nguồn</th>
                          <th className="px-3 py-3">Trạng thái</th>
                          {tieuDeSapXep("capNhat", "Ngày cập nhật", "Lần có file mới gần nhất")}
                          {tieuDeSapXep("tyLe", "Tỉ lệ %", undefined, true)}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {nhomNguon
                          ? cacNhom.map((g) => (
                              <Fragment key={g.ten}>
                                <DongTieuDeNhom ten={g.ten} soHoSo={g.cases.length} chuaNhap={g.chuaNhap} colSpan={9} />
                                {g.cases.map((c, i) => dongHoSo(c, i + 1))}
                              </Fragment>
                            ))
                          : bang.map((c, i) => dongHoSo(c, i + 1))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
