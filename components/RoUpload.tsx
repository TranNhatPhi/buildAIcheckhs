"use client";

import { useRef, useState } from "react";

/**
 * Vùng kéo thả kiểu "ném vào rổ" (theo mẫu "Basketball upload animation" Docs gửi): khung nét đứt +
 * rổ bóng rổ phía dưới. Mỗi lần thả / chọn file, một biểu tượng file bay vòng cung vào rổ, lưới rung.
 * Chỉ là hiệu ứng — file thật vẫn do `onFiles` nhận. Tắt hẳn hiệu ứng khi máy bật "giảm chuyển động".
 */
// Cùng giới hạn backend (tach_file.MAX_BYTES) — báo trước khi gửi để khỏi chờ upload rồi mới bị từ chối.
const GIOI_HAN_MB = 80;

export function RoUpload({
  files,
  onFiles,
  nhanExcel = false,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  // Trang "Tách hồ sơ dịch thuật" nhận thêm Excel (.xls, .xlsx).
  nhanExcel?: boolean;
}) {
  const [keoVao, setKeoVao] = useState(false);
  const oChon = useRef<HTMLInputElement>(null);
  const onPick = () => oChon.current?.click();
  const [bong, setBong] = useState<{ id: number; duoi: string; tre: number }[]>([]);
  const [luoi, setLuoi] = useState(0);
  const dem = useRef(0);

  // CỘNG DỒN (14/10/2026, Docs yêu cầu upload nhiều file): chọn / thả thêm lần nữa thì THÊM vào danh sách
  // chứ không thay file đã chọn; cùng file (tên + dung lượng + ngày sửa) chọn lại thì bỏ qua.
  function nem(ds: File[]) {
    if (!ds.length) return;
    const khoa = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
    const daCo = new Set(files.map(khoa));
    const them = ds.filter((f) => !daCo.has(khoa(f)));
    if (them.length) onFiles([...files, ...them]);
    // Tối đa 5 quả bay nối nhau — thả 30 file cùng lúc thì không bay cả 30.
    const moi = ds.slice(0, 5).map((f, i) => ({
      id: ++dem.current,
      duoi: (f.name.split(".").pop() || "file").slice(0, 4).toUpperCase(),
      tre: i * 180,
    }));
    setBong((cu) => [...cu, ...moi]);
    moi.forEach((b) => {
      setTimeout(() => setLuoi((n) => n + 1), b.tre + 650);
      setTimeout(() => setBong((cu) => cu.filter((x) => x.id !== b.id)), b.tre + 1100);
    });
  }

  const tongMb = files.reduce((t, f) => t + f.size, 0) / 1024 / 1024;

  return (
    <div className="rounded-3xl bg-neutral-50 p-6 shadow-inner ring-1 ring-neutral-200">
      <style>{`
        @keyframes ro-bay {
          0%   { transform: translate(-150px, 150px) rotate(-20deg) scale(.9); opacity: 0; }
          10%  { opacity: 1; }
          45%  { transform: translate(-60px, -70px) rotate(160deg) scale(1); }
          75%  { transform: translate(0, 0) rotate(330deg) scale(.85); opacity: 1; }
          100% { transform: translate(0, 70px) rotate(360deg) scale(.7); opacity: 0; }
        }
        @keyframes ro-luoi {
          0%, 100% { transform: scaleY(1); }
          35% { transform: scaleY(1.22) scaleX(.9); }
          70% { transform: scaleY(.95); }
        }
        .ro-bay { animation: ro-bay 1.05s cubic-bezier(.35,.1,.3,1) both; }
        .ro-luoi { transform-origin: 50% 0; animation: ro-luoi .45s ease-out; }
        @media (prefers-reduced-motion: reduce) { .ro-bay, .ro-luoi { animation: none; display: none; } }
      `}</style>

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xl font-bold text-neutral-900">Upload files</p>
          <p className="mt-1 text-sm text-neutral-500">Kéo thả vào rổ, hoặc bấm để chọn file.</p>
        </div>
        <span className="rounded-full bg-neutral-200/70 px-4 py-1.5 text-sm font-semibold text-neutral-700">
          Đã chọn <span className="tabular-nums">{files.length}</span>
        </span>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={onPick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick()}
        onDragOver={(e) => {
          e.preventDefault();
          setKeoVao(true);
        }}
        onDragLeave={() => setKeoVao(false)}
        onDrop={(e) => {
          e.preventDefault();
          setKeoVao(false);
          nem(Array.from(e.dataTransfer.files));
        }}
        className={`relative mt-5 flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed px-6 pt-8 pb-36 text-center transition-colors ${
          keoVao ? "border-indigo-500 bg-indigo-50/70" : "border-neutral-300 bg-white/60 hover:border-indigo-300"
        }`}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-800" aria-hidden>
          <path d="M12 15V3m0 0-4 4m4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="mt-2 text-base font-semibold text-neutral-800">
          {keoVao ? "Thả vào rổ!" : "Thả file vào đây"}
        </p>
        <p className="text-sm text-neutral-400">
          PDF, Word, {nhanExcel ? "Excel, " : ""}ảnh, ZIP — nhiều file một lúc cũng được
        </p>

        {/* Rổ: bảng rổ + vành + lưới, nằm đè lên mép dưới khung nét đứt như mẫu */}
        <div className="pointer-events-none absolute left-1/2 bottom-[-64px] w-44 -translate-x-1/2" aria-hidden>
          <div className="relative mx-auto h-24 w-44 rounded-md border-2 border-neutral-300 bg-white shadow-sm">
            <div className="absolute left-1/2 top-4 h-14 w-20 -translate-x-1/2 rounded-sm border-[3px] border-indigo-600" />
          </div>
          {/* Quả bóng (file) bay vào vành */}
          {bong.map((b) => (
            <div
              key={b.id}
              className="ro-bay absolute left-1/2 top-[70px] -ml-5 flex h-12 w-10 flex-col items-center justify-end rounded-md bg-white pb-1.5 shadow-lg ring-1 ring-neutral-200"
              style={{ animationDelay: `${b.tre}ms` }}
            >
              <span className="rounded bg-indigo-600 px-1 text-[8px] font-bold text-white">{b.duoi}</span>
            </div>
          ))}
          <svg key={luoi} viewBox="0 0 120 80" className={`relative -mt-3 mx-auto w-32 ${luoi ? "ro-luoi" : ""}`}>
            {/* lưới */}
            <g stroke="#a3a3a3" strokeWidth="1.2" fill="none">
              {[14, 30, 46, 60, 74, 90, 106].map((x, i) => (
                <path key={`d${i}`} d={`M${x} 12 L${36 + i * 8} 76`} />
              ))}
              {[14, 30, 46, 60, 74, 90, 106].map((x, i) => (
                <path key={`c${i}`} d={`M${x} 12 L${60 + (i - 3) * 4} 76`} opacity=".7" />
              ))}
              <path d="M22 34 Q60 44 98 34" />
              <path d="M30 54 Q60 62 90 54" />
            </g>
            {/* vành */}
            <ellipse cx="60" cy="12" rx="54" ry="10" fill="none" stroke="#4f46e5" strokeWidth="6" />
            <rect x="52" y="4" width="16" height="8" rx="2" fill="#4338ca" />
          </svg>
        </div>
      </div>

      <input
        ref={oChon}
        type="file"
        multiple
        accept={`.pdf,.doc,.docx,${nhanExcel ? ".xls,.xlsx," : ""}.zip,.jpg,.jpeg,.png,.webp,.tif,.tiff,application/zip`}
        onChange={(e) => {
          nem(Array.from(e.target.files ?? []));
          e.target.value = ""; // chọn lại đúng file đó vẫn ném được
        }}
        className="hidden"
        aria-label="Chọn file cần tách"
      />
      {files.length > 0 ? (
        <div className="mt-20 rounded-xl bg-white ring-1 ring-neutral-200">
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2">
            <span
              className={`text-xs font-semibold ${tongMb > GIOI_HAN_MB ? "text-red-600" : "text-neutral-500"}`}
              title="Nhiều file sẽ được ghép thành một theo thứ tự tên file (số tự nhiên: 2. trước 10.)"
            >
              {files.length} file đã chọn · {tongMb.toFixed(1)} MB
              {tongMb > GIOI_HAN_MB && ` — vượt ${GIOI_HAN_MB} MB, bỏ bớt file`}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={onPick}
                className="rounded-lg px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
              >
                + Thêm file
              </button>
              <button
                type="button"
                onClick={() => onFiles([])}
                className="rounded-lg px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
              >
                Bỏ hết — chọn file khác
              </button>
            </span>
          </div>
          <ul className="max-h-40 overflow-y-auto px-2 py-1 text-left text-xs text-neutral-700">
            {files.map((f, i) => (
              <li key={f.name + f.size + i} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-neutral-50">
                <span className="min-w-0 flex-1 truncate">
                  📄 {f.name} <span className="text-neutral-400">· {(f.size / 1024 / 1024).toFixed(1)} MB</span>
                </span>
                <button
                  type="button"
                  onClick={() => onFiles(files.filter((_, k) => k !== i))}
                  aria-label={`Bỏ file ${f.name}`}
                  title="Bỏ file này"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-red-50 hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mt-20" />
      )}
      <p className="mt-4 text-center text-xs text-neutral-400">
        Kéo thả / chọn thêm bao nhiêu lần cũng được — các file cộng dồn, ghép theo thứ tự tên file. Tối đa 80MB / 150
        trang mỗi lần
      </p>
    </div>
  );
}
