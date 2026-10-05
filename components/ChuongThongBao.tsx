"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { adminFetch } from "@/lib/adminApi";
import { API_URL } from "@/lib/format";
import { getApplicationStatus } from "@/lib/application-status";
import type { ApplicationStatus } from "@/lib/client-types";

interface ThongBaoChung {
  caseId: string;
  clientName: string;
  partner: string | null;
  applicationStatus: ApplicationStatus;
  percent: number;
}

/** Đã nhận đơn vị xác nhận kinh nghiệm quá N ngày mà chưa làm xong để gửi nguồn. */
export interface ThongBaoDonViKN extends ThongBaoChung {
  kind: "DON_VI_KN";
  units: string[];
  receivedDate: string;
  dueDate: string;
  daysOverdue: number;
}

/** N ngày không có file mới mà còn thiếu giấy tờ bắt buộc. */
interface ThongBaoChuaCapNhat extends ThongBaoChung {
  kind: "CHUA_CAP_NHAT";
  lastUpdate: string;
  neverUploaded: boolean;
  daysIdle: number;
  missingCount: number;
}

type ThongBao = ThongBaoDonViKN | ThongBaoChuaCapNhat;

const LAM_MOI_PHUT = 5;

/** Mỗi thông báo một khoá: cùng hồ sơ nhưng khác loại là hai thông báo khác nhau. */
const khoaTB = (x: { kind?: string; caseId: string }) => `${x.kind ?? "DON_VI_KN"}:${x.caseId}`;

/** Nơi nhớ "đã xem" — theo TỪNG tên nhân viên (cookie docs_staff): máy dùng chung đổi người thì
 *  người sau vẫn thấy số của mình. localStorage chỉ là tiện ích phía trình duyệt; hỏng/bị chặn thì
 *  chuông vẫn chạy, chỉ là số không tự tắt. */
function khoaLuuDaXem(vaiTro: string): string {
  let ten = "";
  try {
    const m = document.cookie.match(/(?:^|;\s*)docs_staff=([^;]*)/);
    ten = m ? decodeURIComponent(m[1]) : "";
  } catch {
    ten = "";
  }
  return `chuong-da-xem:${vaiTro}:${ten}`;
}

function docDaXem(vaiTro: string): Set<string> {
  try {
    const raw = localStorage.getItem(khoaLuuDaXem(vaiTro));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function ghiDaXem(vaiTro: string, s: Set<string>) {
  try {
    localStorage.setItem(khoaLuuDaXem(vaiTro), JSON.stringify([...s]));
  } catch {
    // bỏ qua — xem ghi chú ở khoaLuuDaXem
  }
}

function ngayVN(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Chuông thông báo — backend/thong_bao.py. Hai loại việc cần chú ý, chỉ xét hồ sơ chưa tới
 * "Hoàn thành" (chưa làm xong để gửi nguồn):
 *   - đã nhận "Đơn vị xác nhận kinh nghiệm" quá 7 ngày;
 *   - 7 ngày không có file mới mà còn thiếu giấy tờ bắt buộc.
 * Dùng ở HAI nơi, cùng một danh sách:
 *   - vaiTro="admin": thanh tiêu đề các trang admin (GET /admin/notifications, mở /admin/cases/…);
 *   - vaiTro="docs": sidebar trang Docs (GET /notifications, mở /cases/…).
 *
 * Không có "đánh dấu đã đọc": hồ sơ tự biến khỏi chuông khi việc xong (tới "Hoàn thành", có file
 * mới…). Thông báo còn đó chừng nào việc còn chưa xong — đọc rồi quên là đúng thứ cái chuông này
 * sinh ra để chặn.
 */
export function ChuongThongBao({ vaiTro = "admin" }: { vaiTro?: "admin" | "docs" }) {
  const [items, setItems] = useState<ThongBao[] | null>(null);
  const [soNgayDonVi, setSoNgayDonVi] = useState(7);
  const [soNgayImLang, setSoNgayImLang] = useState(7);
  const [mo, setMo] = useState(false);
  // Chuông trang Docs: mở ra xem là số đỏ tắt; số chỉ hiện lại khi có thông báo MỚI. `daXem` = các
  // thông báo đã thấy; `noiBat` = thông báo chưa xem lúc vừa mở (chấm "Mới" trong lần mở đó).
  // Chuông admin giữ nguyên: số = tổng việc còn tồn.
  const nhoDaXem = vaiTro === "docs";
  const [daXem, setDaXem] = useState<Set<string>>(new Set());
  const [noiBat, setNoiBat] = useState<Set<string>>(new Set());
  const khung = useRef<HTMLDivElement>(null);

  const tai = useCallback(async () => {
    try {
      const r =
        vaiTro === "admin" ? await adminFetch("/admin/notifications") : await fetch(`${API_URL}/notifications`);
      if (!r.ok) return;
      const d = await r.json();
      // Item cũ (máy chủ chưa cập nhật) không có "kind" = loại đơn vị xác nhận kinh nghiệm.
      // Chuông ADMIN bỏ loại "7 ngày chưa cập nhật" — admin đã có thẻ riêng ở trang tổng quan;
      // chuông trang Docs vẫn hiện đủ cả hai loại.
      setItems(
        (d.items ?? [])
          .map((x: ThongBao) => ({ ...x, kind: x.kind ?? "DON_VI_KN" }))
          .filter((x: ThongBao) => vaiTro === "docs" || x.kind !== "CHUA_CAP_NHAT"),
      );
      if (nhoDaXem) {
        const hienCo = new Set<string>((d.items ?? []).map(khoaTB));
        const conLai = new Set([...docDaXem(vaiTro)].filter((k) => hienCo.has(k)));
        ghiDaXem(vaiTro, conLai);
        setDaXem(conLai);
      }
      setSoNgayDonVi(d.reminderDays ?? 7);
      setSoNgayImLang(d.idleDays ?? 7);
    } catch {
      // Sai mật khẩu / mất mạng: trang chính tự xử lý đăng nhập, chuông chỉ im lặng.
    }
  }, [vaiTro, nhoDaXem]);

  useEffect(() => {
    tai();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") tai();
    }, LAM_MOI_PHUT * 60 * 1000);
    return () => clearInterval(t);
  }, [tai]);

  // Bấm ra ngoài hoặc nhấn Esc thì đóng.
  useEffect(() => {
    if (!mo) return;
    const ngoai = (e: MouseEvent) => {
      if (khung.current && !khung.current.contains(e.target as Node)) setMo(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMo(false);
    document.addEventListener("mousedown", ngoai);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", ngoai);
      document.removeEventListener("keydown", esc);
    };
  }, [mo]);

  // Đang mở mà danh sách tải lại có thêm thông báo: cũng tính là đã xem (đang nhìn thấy nó).
  useEffect(() => {
    if (!nhoDaXem || !mo || !items) return;
    const tatCa = new Set(items.map(khoaTB));
    ghiDaXem(vaiTro, tatCa);
    setDaXem(tatCa);
  }, [nhoDaXem, mo, items, vaiTro]);

  const so = items?.length ?? 0;
  const soMoi = nhoDaXem ? (items ?? []).filter((x) => !daXem.has(khoaTB(x))).length : so;
  const donVi = (items ?? []).filter((x): x is ThongBaoDonViKN => x.kind === "DON_VI_KN");
  const chuaCapNhat = (items ?? []).filter((x): x is ThongBaoChuaCapNhat => x.kind === "CHUA_CAP_NHAT");
  const lienKet = (id: string) => (vaiTro === "admin" ? `/admin/cases/${id}` : `/cases/${id}`);

  function dongHoSo(tb: ThongBao, nhan: React.ReactNode, nhanDo: boolean, dongPhu: React.ReactNode) {
    return (
      <li key={`${tb.kind}-${tb.caseId}`}>
        <Link href={lienKet(tb.caseId)} onClick={() => setMo(false)} className="block px-4 py-3 transition-colors hover:bg-neutral-50">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-semibold text-neutral-800">
              {nhoDaXem && noiBat.has(khoaTB(tb)) && (
                <span className="mr-1.5 inline-block rounded bg-blue-600 px-1.5 py-0.5 align-middle text-[10px] font-bold text-white">
                  Mới
                </span>
              )}
              {tb.clientName}
            </span>
            <span
              className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold ${
                nhanDo ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"
              }`}
            >
              {nhan}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-600">{dongPhu}</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {getApplicationStatus(tb.applicationStatus).label} · {tb.percent}%
            {tb.partner ? ` · Nguồn: ${tb.partner}` : ""}
          </p>
        </Link>
      </li>
    );
  }

  function tieuDeNhom(ten: string, soLuong: number, moTa: string) {
    return (
      <div className="sticky top-0 z-10 border-b border-neutral-100 bg-neutral-50 px-4 py-2">
        <p className="text-xs font-semibold text-neutral-700">
          {ten} <span className="ml-1 rounded-full bg-neutral-200 px-1.5 text-[11px] tabular-nums text-neutral-700">{soLuong}</span>
        </p>
        <p className="text-[11px] text-neutral-500">{moTa}</p>
      </div>
    );
  }

  return (
    <div ref={khung} className={vaiTro === "admin" ? "relative ml-auto" : "relative"}>
      <button
        type="button"
        onClick={() => {
          if (!mo) {
            // Ghi lại cái nào CHƯA xem trước khi đánh dấu đã xem — để còn tô "Mới" trong lần mở này.
            setNoiBat(new Set((items ?? []).map(khoaTB).filter((k) => !daXem.has(k))));
            tai();
          }
          setMo((v) => !v);
        }}
        aria-expanded={mo}
        aria-label={soMoi ? `Thông báo: ${soMoi} ${nhoDaXem ? "mới" : "việc cần chú ý"}` : "Thông báo"}
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-lg transition-colors hover:bg-neutral-100"
        title="Thông báo"
      >
        <span aria-hidden>🔔</span>
        {soMoi > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold leading-none text-white ring-2 ring-white tabular-nums">
            {soMoi > 99 ? "99+" : soMoi}
          </span>
        )}
      </button>

      {mo && (
        <div
          className={`absolute top-full z-50 mt-2 w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl ${
            vaiTro === "admin" ? "right-0" : "left-0"
          }`}
        >
          <div className="border-b border-neutral-100 px-4 py-3">
            <p className="text-sm font-semibold text-neutral-800">Thông báo</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              Hồ sơ chưa làm xong để gửi nguồn (chưa tới “Hoàn thành”) cần chú ý.
            </p>
          </div>
          <div className="max-h-[460px] overflow-y-auto">
            {items === null ? (
              <p className="px-4 py-6 text-center text-sm text-neutral-400">Đang tải…</p>
            ) : so === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-neutral-500">Không có hồ sơ nào cần chú ý.</p>
            ) : (
              <>
                {donVi.length > 0 && (
                  <section>
                    {tieuDeNhom(
                      "Quá hạn đơn vị xác nhận kinh nghiệm",
                      donVi.length,
                      `Đã nhận đơn vị xác nhận kinh nghiệm quá ${soNgayDonVi} ngày.`,
                    )}
                    <ul className="divide-y divide-neutral-100">
                      {donVi.map((tb) =>
                        dongHoSo(
                          tb,
                          tb.daysOverdue > 0 ? `Quá hạn ${tb.daysOverdue} ngày` : "Đến hạn hôm nay",
                          tb.daysOverdue > 0,
                          <>Nhận đơn vị {ngayVN(tb.receivedDate)} · {tb.units.join(", ")}</>,
                        ),
                      )}
                    </ul>
                  </section>
                )}
                {chuaCapNhat.length > 0 && (
                  <section>
                    {tieuDeNhom(
                      `${soNgayImLang} ngày chưa cập nhật`,
                      chuaCapNhat.length,
                      `Không có file mới ${soNgayImLang} ngày mà còn thiếu giấy tờ bắt buộc.`,
                    )}
                    <ul className="divide-y divide-neutral-100">
                      {chuaCapNhat.map((tb) =>
                        dongHoSo(
                          tb,
                          `${tb.daysIdle} ngày chưa cập nhật`,
                          tb.daysIdle >= soNgayImLang * 2,
                          <>
                            {tb.neverUploaded
                              ? `Chưa có file nào — tạo ngày ${ngayVN(tb.lastUpdate)}`
                              : `File mới nhất: ${ngayVN(tb.lastUpdate)}`}{" "}
                            · còn thiếu {tb.missingCount} mục bắt buộc
                          </>,
                        ),
                      )}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
