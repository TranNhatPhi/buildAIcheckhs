"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL, gioNgayVN, normalizeSearchText } from "@/lib/format";
import { APPLICATION_STATUS_BADGE_CLASS, getApplicationStatus } from "@/lib/application-status";
import { FORM_INPUT } from "@/lib/formStyles";
import { ChecklistSection } from "@/components/ChecklistSection";
import type { ApplicationStatus, ChecklistItemStatusDTO } from "@/lib/client-types";

interface HoSoHT {
  caseId: string;
  clientName: string;
  partner: string | null;
  maritalStatus: string;
  skillLevel: string;
  applicationStatus: ApplicationStatus;
  fileCount: number;
  pageCount: number;
  lastUploadAt: string | null;
  // Tiến độ bản dịch: số mục bắt buộc CẦN DỊCH đã có file / tổng số mục đó.
  doneItems: number;
  totalItems: number;
}

type MucHT = ChecklistItemStatusDTO & { files: { id: string; fileName: string }[] };

interface FileHT {
  id: string;
  fileName: string;
  number: string | null;
  itemName: string | null;
  pageCount: number | null;
  fileSizeBytes: number;
  uploadedAt: string;
  uploadedBy: string | null;
}

interface ChiTietHT {
  case: {
    id: string;
    clientName: string;
    partner: string | null;
    maritalStatus: string;
    skillLevel: string;
    applicationStatus: ApplicationStatus;
    autoDeleteAt: string | null;
  };
  files: FileHT[];
  checklist: MucHT[];
  progress: { done: number; total: number; percent: number };
}

function moTa(c: { maritalStatus: string; skillLevel: string }) {
  return `${c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"} · ${c.skillLevel === "HIGH_SKILL" ? "High" : "Low"} Skilled`;
}

function NhanTrangThai({ status }: { status: ApplicationStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${APPLICATION_STATUS_BADGE_CLASS[status]}`}>
      {getApplicationStatus(status).label}
    </span>
  );
}

/**
 * Tab "Danh sách hồ sơ hoàn thành" (/ho-so-hoan-thanh): hồ sơ đã có file trong KHO RIÊNG "hồ sơ hoàn
 * thành" — bản dịch đã duyệt ở trang "Tách hồ sơ dịch thuật" (backend routers/final_docs.py).
 */
export function HoSoHoanThanh() {
  const [ds, setDs] = useState<HoSoHT[] | null>(null);
  const [loi, setLoi] = useState<string | null>(null);
  const [tim, setTim] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/final/cases`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setDs)
      .catch(() => setLoi("Không tải được danh sách — thử lại sau."));
  }, []);

  const loc = useMemo(() => {
    const q = normalizeSearchText(tim.trim());
    return (ds ?? []).filter((c) => !q || normalizeSearchText(`${c.clientName} ${c.partner ?? ""}`).includes(q));
  }, [ds, tim]);

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Danh sách hồ sơ hoàn thành</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Bản dịch đã duyệt ở trang{" "}
          <Link href="/tach-ban-dich" className="font-semibold text-indigo-700 hover:underline">
            Tách hồ sơ dịch thuật
          </Link>
          . Lưu riêng, không tính vào tiến độ của hồ sơ thô.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={tim}
          onChange={(e) => setTim(e.target.value)}
          placeholder="🔍 Tìm tên khách / nguồn"
          className={`${FORM_INPUT} sm:w-72`}
          aria-label="Tìm hồ sơ"
        />
        {ds && (
          <span className="text-sm text-neutral-500">
            Hiển thị <b>{loc.length}</b>/{ds.length} hồ sơ
          </span>
        )}
      </div>

      {loi && <p className="text-sm text-red-600">{loi}</p>}
      {!ds && !loi && <p className="text-neutral-400">Đang tải...</p>}
      {ds && ds.length === 0 && (
        <p className="rounded-2xl border-2 border-dashed border-neutral-200 bg-white px-6 py-10 text-center text-neutral-500">
          Chưa có hồ sơ hoàn thành nào — duyệt bản dịch ở trang “Tách hồ sơ dịch thuật” rồi bấm “Đưa vào hồ sơ hoàn thành”.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {loc.map((c) => (
          <li key={c.caseId}>
            <Link
              href={`/ho-so-hoan-thanh/${c.caseId}`}
              className="flex flex-wrap items-center gap-4 rounded-2xl border-2 border-neutral-200 bg-white px-5 py-4 transition-colors hover:border-indigo-300"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-neutral-900">
                  {c.clientName}
                  {c.partner && (
                    <span className="ml-2 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800">{c.partner}</span>
                  )}
                </p>
                <p className="text-sm text-neutral-500">{moTa(c)}</p>
                {c.lastUploadAt && <p className="text-xs text-neutral-400">Cập nhật: {gioNgayVN(c.lastUploadAt)}</p>}
              </div>
              <NhanTrangThai status={c.applicationStatus} />
              <span
                className="rounded-full bg-indigo-50 px-3 py-1 text-sm font-semibold text-indigo-800 tabular-nums"
                title="Số mục bắt buộc cần dịch đã có bản dịch"
              >
                Bản dịch {c.doneItems}/{c.totalItems} mục
              </span>
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-800 tabular-nums">
                {c.fileCount} file · {c.pageCount} trang
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

/** Trang một hồ sơ hoàn thành (/ho-so-hoan-thanh/[id]): file xếp theo số mục, xem / tải / xoá, tải ZIP. */
export function HoSoHoanThanhChiTiet({ id }: { id: string }) {
  const [d, setD] = useState<ChiTietHT | null>(null);
  const [loi, setLoi] = useState<string | null>(null);
  const [dangXoa, setDangXoa] = useState<string | null>(null);
  // Chọn nhiều file để xoá một lần (14/10/2026, Docs yêu cầu) — giống trang hồ sơ thô.
  const [chon, setChon] = useState<Set<string>>(new Set());
  const [dangXoaNhieu, setDangXoaNhieu] = useState(false);

  const tai = useCallback(() => {
    fetch(`${API_URL}/final/cases/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setD)
      .catch((s) => setLoi(s === 404 ? "Không tìm thấy hồ sơ." : "Không tải được hồ sơ — thử lại sau."));
  }, [id]);
  useEffect(tai, [tai]);

  async function xoa(f: FileHT) {
    if (!confirm(`Xoá file "${f.fileName}" khỏi hồ sơ hoàn thành?\n\nFile xoá rồi KHÔNG khôi phục được.`)) return;
    setDangXoa(f.id);
    try {
      const r = await fetch(`${API_URL}/final/files/${f.id}`, { method: "DELETE" }).catch(() => null);
      if (!r || !r.ok) alert("Không xoá được file — thử lại sau.");
      tai();
    } finally {
      setDangXoa(null);
    }
  }

  async function xoaDaChon(ids: string[]) {
    if (!ids.length || !confirm(`Xoá ${ids.length} file đã chọn khỏi hồ sơ hoàn thành?\n\nFile xoá rồi KHÔNG khôi phục được.`))
      return;
    setDangXoaNhieu(true);
    let hong = 0;
    for (const fid of ids) {
      const r = await fetch(`${API_URL}/final/files/${fid}`, { method: "DELETE" }).catch(() => null);
      if (!r || !r.ok) hong++;
    }
    setDangXoaNhieu(false);
    setChon(new Set());
    if (hong) alert(`Không xoá được ${hong}/${ids.length} file — thử lại sau.`);
    tai();
  }

  if (loi) return <p className="px-6 py-10 text-neutral-500">{loi}</p>;
  if (!d) return <p className="px-6 py-10 text-neutral-400">Đang tải...</p>;
  const tongTrang = d.files.reduce((s, f) => s + (f.pageCount ?? 0), 0);
  // File đã xoá mà id còn trong bộ chọn thì bỏ qua — số trên nút luôn khớp danh sách đang hiện.
  const idChon = d.files.filter((f) => chon.has(f.id)).map((f) => f.id);
  const doiChon = (fid: string) =>
    setChon((cu) => {
      const moi = new Set(cu);
      if (moi.has(fid)) moi.delete(fid);
      else moi.add(fid);
      return moi;
    });

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
      <div>
        <Link href="/ho-so-hoan-thanh" className="text-sm font-semibold text-indigo-700 hover:underline">
          ← Danh sách hồ sơ hoàn thành
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{d.case.clientName}</h1>
          <NhanTrangThai status={d.case.applicationStatus} />
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          {d.case.partner ? `${d.case.partner} · ` : ""}
          {moTa(d.case)} ·{" "}
          <Link href={`/cases/${d.case.id}`} className="font-semibold text-indigo-700 hover:underline">
            Mở hồ sơ thô →
          </Link>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-indigo-100 bg-white px-5 py-4">
        <span className="text-3xl font-bold text-indigo-700 tabular-nums">{d.progress.percent}%</span>
        <div className="min-w-48 flex-1">
          <div className="h-2.5 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full bg-indigo-600" style={{ width: `${d.progress.percent}%` }} />
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            Đã có bản dịch <b>{d.progress.done}</b>/{d.progress.total} mục bắt buộc cần dịch (không tính hộ chiếu,
            căn cước, ảnh thẻ… — mục không cần dịch).
          </p>
        </div>
      </div>

      {d.case.autoDeleteAt && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Hồ sơ đã bấm Hoàn tất — TOÀN BỘ file (cả hồ sơ thô lẫn hồ sơ hoàn thành) sẽ tự xoá lúc{" "}
          <b>{gioNgayVN(d.case.autoDeleteAt)}</b>. Tải về trước nếu còn cần.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-lg font-bold text-neutral-800">
          File hoàn thành
          <span className="ml-2 text-sm font-medium text-neutral-500">
            {d.files.length} file · {tongTrang} trang
          </span>
        </p>
        {d.files.length > 0 && (
          <a
            href={`${API_URL}/final/cases/${d.case.id}/zip`}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            ⬇ Tải tất cả (ZIP)
          </a>
        )}
      </div>

      {d.files.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-neutral-600">
            <input
              type="checkbox"
              checked={idChon.length === d.files.length}
              ref={(el) => {
                if (el) el.indeterminate = idChon.length > 0 && idChon.length < d.files.length;
              }}
              onChange={() => setChon(idChon.length === d.files.length ? new Set() : new Set(d.files.map((f) => f.id)))}
              className="h-4 w-4 rounded border-neutral-300"
            />
            {idChon.length > 0 ? `Đã chọn ${idChon.length}/${d.files.length} file` : "Chọn tất cả"}
          </label>
          <button
            type="button"
            onClick={() => xoaDaChon(idChon)}
            disabled={idChon.length === 0 || dangXoaNhieu}
            className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            {dangXoaNhieu ? "Đang xoá..." : idChon.length > 0 ? `Xoá ${idChon.length} file đã chọn` : "Xoá file đã chọn"}
          </button>
        </div>
      )}

      {d.files.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-neutral-200 bg-white px-6 py-10 text-center text-neutral-500">
          Hồ sơ chưa có file hoàn thành nào.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {d.files.map((f) => (
            <li
              key={f.id}
              className={`flex flex-wrap items-center gap-3 rounded-2xl border-2 bg-white px-4 py-3 ${
                chon.has(f.id) ? "border-indigo-300" : "border-neutral-200"
              }`}
            >
              <input
                type="checkbox"
                checked={chon.has(f.id)}
                onChange={() => doiChon(f.id)}
                className="h-4 w-4 shrink-0 rounded border-neutral-300"
                aria-label={`Chọn ${f.fileName}`}
              />
              <div className="min-w-0 flex-1">
                <a
                  href={`${API_URL}/final/files/${f.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-sm font-semibold text-neutral-900 hover:text-indigo-700 hover:underline"
                >
                  {f.fileName}
                </a>
                <p className="text-xs text-neutral-500">
                  {f.itemName ? `Mục ${f.number ?? "?"}. ${f.itemName}` : "Chưa gán mục"}
                  {f.pageCount ? ` · ${f.pageCount} trang` : ""} · {gioNgayVN(f.uploadedAt)}
                  {f.uploadedBy ? ` · ${f.uploadedBy}` : ""}
                </p>
              </div>
              <a
                href={`${API_URL}/final/files/${f.id}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
              >
                Xem
              </a>
              <a
                href={`${API_URL}/final/files/${f.id}?download=1`}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
              >
                Tải
              </a>
              <button
                type="button"
                onClick={() => xoa(f)}
                disabled={dangXoa === f.id}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                {dangXoa === f.id ? "Đang xoá..." : "Xoá"}
              </button>
            </li>
          ))}
        </ol>
      )}

      <div>
        <h2 className="mb-3 text-lg font-bold text-neutral-800">Checklist</h2>
        <ChecklistSection
          items={d.checklist}
          nhanMo={(s) => (s.item.needsTranslation === false ? "Không cần dịch" : null)}
          phuLuc={(s) =>
            s.files.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {s.files.map((f) => (
                  <li key={f.id}>
                    <a
                      href={`${API_URL}/final/files/${f.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-xs font-medium text-emerald-800 hover:underline"
                    >
                      📄 {f.fileName}
                    </a>
                  </li>
                ))}
              </ul>
            )
          }
        />
      </div>
    </main>
  );
}
