"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/format";

// Tên nhân viên Docs đang dùng máy này — để backend ghi lịch sử "ai làm gì" (backend/activity.py,
// admin xem ở tab "Theo dõi Docs"). Nằm trong COOKIE chứ không phải localStorage: trình duyệt tự
// gửi cookie kèm mọi request cùng tên miền — fetch, upload, cả link tải file/ZIP — nên không phải
// sửa từng nút bấm để gắn tên. Không phải đăng nhập: chọn tên người khác vẫn được.
const COOKIE = "docs_staff";
const MOT_NAM = 60 * 60 * 24 * 365;

function docTen(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)docs_staff=([^;]*)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}

function ghiTen(ten: string) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  // encodeURIComponent: tên tiếng Việt có dấu không được phép nằm trần trong cookie.
  document.cookie = `${COOKIE}=${encodeURIComponent(ten)}; path=/; max-age=${MOT_NAM}; SameSite=Lax${secure}`;
}

/**
 * Ô "👤 Tên · Đổi người" ở chân sidebar + hộp "Bạn là ai?".
 *
 * Chưa chọn tên thì hộp tự bật và KHÔNG đóng được — thiếu tên là lịch sử ghi "không rõ ai", mất
 * đúng thứ admin cần. Máy dùng chung: bấm "Đổi người" khi đổi ca.
 */
export function StaffIdentity() {
  const [ten, setTen] = useState<string | null>(null);
  const [daDoc, setDaDoc] = useState(false);
  const [moHop, setMoHop] = useState(false);
  const [nhap, setNhap] = useState("");
  const [goiY, setGoiY] = useState<string[]>([]);
  const [loi, setLoi] = useState<string | null>(null);

  // Đọc cookie SAU khi mount: server không biết cookie phía trình duyệt, đọc lúc render là lệch
  // nội dung giữa server và trình duyệt (lỗi hydration).
  useEffect(() => {
    const t = docTen();
    setTen(t);
    setDaDoc(true);
    if (!t) setMoHop(true);
  }, []);

  useEffect(() => {
    if (!moHop) return;
    fetch(`${API_URL}/activity/staff-names`)
      .then((r) => (r.ok ? r.json() : []))
      .then((ds: string[]) => setGoiY(Array.isArray(ds) ? ds : []))
      .catch(() => setGoiY([]));
  }, [moHop]);

  function batDauDoi() {
    setNhap(ten ?? "");
    setLoi(null);
    setMoHop(true);
  }

  function luu(e: React.FormEvent) {
    e.preventDefault();
    const sach = nhap.normalize("NFC").split(/\s+/).filter(Boolean).join(" ").slice(0, 60);
    if (sach.length < 2) {
      setLoi("Nhập tên của bạn (ít nhất 2 ký tự).");
      return;
    }
    ghiTen(sach);
    setTen(sach);
    setMoHop(false);
  }

  if (!daDoc) return null;

  return (
    <>
      <div className="mx-3 mb-3 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm">
          👤
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] leading-tight text-neutral-500">Đang làm việc</p>
          <p className="truncate text-sm font-semibold text-neutral-800" title={ten ?? undefined}>
            {ten ?? "Chưa chọn tên"}
          </p>
        </div>
        <button
          type="button"
          onClick={batDauDoi}
          className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
        >
          Đổi người
        </button>
      </div>

      {moHop && (
        // z-[55]: dưới màn hình giới thiệu (IntroOverlay, z-[60]) — hiện ra ngay sau khi nó tắt.
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-neutral-900/50 px-4">
          <form
            onSubmit={luu}
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            aria-labelledby="ban-la-ai"
          >
            <h2 id="ban-la-ai" className="text-lg font-semibold text-neutral-900">
              Bạn là ai?
            </h2>
            <p className="mt-1 text-sm text-neutral-600">
              Chọn tên của bạn để hệ thống ghi lại thao tác trên hồ sơ. Máy dùng chung thì bấm
              “Đổi người” ở góc dưới bên trái khi đổi ca.
            </p>
            <label htmlFor="ten-nhan-vien" className="mt-4 block text-xs font-semibold text-neutral-700">
              Tên nhân viên
            </label>
            <input
              id="ten-nhan-vien"
              list="goi-y-ten-nhan-vien"
              autoFocus
              value={nhap}
              onChange={(e) => setNhap(e.target.value)}
              placeholder="VD: Thu Phương"
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <datalist id="goi-y-ten-nhan-vien">
              {goiY.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            {loi && <p className="mt-2 text-xs text-red-600">{loi}</p>}
            <div className="mt-5 flex justify-end gap-2">
              {ten && (
                <button
                  type="button"
                  onClick={() => setMoHop(false)}
                  className="rounded-lg px-3 py-2 text-sm font-semibold text-neutral-600 hover:bg-neutral-100"
                >
                  Huỷ
                </button>
              )}
              <button
                type="submit"
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
              >
                {ten ? "Đổi người" : "Bắt đầu làm việc"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
