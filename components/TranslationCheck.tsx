"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/format";
import type { TranslationCheckResponse, TranslationFindingDTO } from "@/lib/client-types";
import {
  FORM_HINT,
  FORM_INPUT,
  FORM_LABEL,
  FORM_SECTION,
  FORM_SECTION_SKY,
  FORM_SECTION_TITLE,
  FORM_SECTION_VIOLET,
  FORM_SUBMIT,
} from "@/lib/formStyles";

const SUPPORTED_EXTENSIONS = [".doc", ".docx", ".pdf", ".jpg", ".jpeg", ".png", ".webp"];
const ACCEPT = SUPPORTED_EXTENSIONS.join(",");

function isSupported(file: File): boolean {
  const name = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Lấy file từ thao tác KÉO THẢ, đi vào cả THƯ MỤC.
 *
 * Kéo nguyên thư mục là cách tự nhiên nhất với bộ hồ sơ dịch thuật (cả bộ nằm chung 1 thư mục),
 * nhưng `dataTransfer.files` khi đó RỖNG — trình duyệt chỉ đưa thư mục qua `items`, phải tự đọc
 * từng mục bên trong. Không xử lý thì người dùng thả vào mà màn hình không có gì, tưởng hỏng.
 */
async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  // Phải lấy entry NGAY trong handler, trước bất kỳ `await` nào: xong handler là trình duyệt
  // xoá sạch danh sách items, await trước rồi đọc sau sẽ ra rỗng.
  const entries = Array.from(dataTransfer.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (entries.length === 0) return Array.from(dataTransfer.files);

  const out: File[] = [];
  async function walk(entry: FileSystemEntry, depth: number): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      );
      if (file) out.push(file);
    } else if (entry.isDirectory && depth < 5) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries chỉ trả tối đa ~100 mục mỗi lần gọi — phải gọi lặp tới khi rỗng, gọi 1 lần
      // là mất file ở thư mục nhiều hơn 100 mục.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  }
  for (const entry of entries) await walk(entry, 0);
  return out;
}

/** Dạng tên chuẩn trong bản dịch — PHẢI giống to_translation_form ở backend/translation_check.py
 *  (bỏ dấu, đ->d, viết HOA). Chỉ để xem trước; kết quả kiểm tra luôn dùng bản tính ở backend. */
function toTranslationForm(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Các quy tắc đang áp dụng — hiện cho nhân viên biết app kiểm tra gì (và KHÔNG kiểm tra gì). */
const RULES = [
  "Tên đương đơn phải ghi đúng dạng viết HOA, bỏ dấu ở mọi bản dịch — bắt lệch tên đệm (HO SY / HO SI) và gõ nhầm 1 chữ.",
  "Cùng một người (bố, mẹ, vợ/chồng, con...) phải ghi cùng một tên ở mọi bản dịch.",
  "Không còn chữ tiếng Việt có dấu trong bản dịch.",
  "Tên chủ giấy tờ (đọc từ tên file \"<số>. <Họ tên> - <loại>\") phải có trong bản dịch, viết HOA.",
  "Số giấy tờ (CCCD 12 số / CMND 9 số) không được lệch 1–2 chữ số giữa các bản.",
  "Ngày tháng phải là ngày có thật (không có 31/02, tháng 13...).",
];

/** Tô vàng đúng những chỗ bị báo lỗi trong văn bản (tên ghi sai, số giấy tờ lệch...). Không tô
 *  thì nhân viên phải tự dò trong vài nghìn ký tự đúng cái chữ app vừa nhắc tới. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const pattern = terms
    .slice()
    .sort((a, b) => b.length - a.length) // dài trước: "HO SY TRONG" phải thắng "HO SY"
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const lower = new Set(terms.map((t) => t.toLowerCase()));
  return (
    <>
      {text.split(new RegExp(`(${pattern})`, "gi")).map((part, i) =>
        lower.has(part.toLowerCase()) ? (
          <mark key={i} className="rounded bg-amber-200 px-0.5 font-semibold">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** Các chuỗi trong dấu ngoặc kép của thông báo lỗi — chính là thứ cần tô trong văn bản. */
function highlightTerms(findings: TranslationFindingDTO[]): string[] {
  const terms = new Set<string>();
  for (const f of findings) {
    for (const m of f.message.matchAll(/"([^"]{3,})"/g)) terms.add(m[1]);
  }
  return [...terms];
}

function FileChip({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Bấm để xem nội dung file"
      className="text-[11px] rounded-full bg-white border border-neutral-200 px-2 py-0.5 text-neutral-600 hover:border-indigo-300 hover:text-indigo-700 hover:underline"
    >
      {name}
    </button>
  );
}

function FindingCard({ f, onOpenFile }: { f: TranslationFindingDTO; onOpenFile: (name: string) => void }) {
  const isError = f.severity === "ERROR";
  return (
    <div
      className={`rounded-2xl border p-4 ${isError ? "border-rose-200 bg-rose-50/60" : "border-amber-200 bg-amber-50/60"}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
            isError ? "bg-rose-600 text-white" : "bg-amber-500 text-white"
          }`}
        >
          {isError ? "Lỗi" : "Cảnh báo"}
        </span>
        <span className="text-sm font-semibold text-neutral-800">{f.title}</span>
      </div>
      <p className="mt-2 text-sm text-neutral-700">{f.message}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {f.files.map((name) => (
          <FileChip key={name} name={name} onOpen={() => onOpenFile(name)} />
        ))}
      </div>
    </div>
  );
}

export function TranslationCheck() {
  const [applicantName, setApplicantName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TranslationCheckResponse | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [viewName, setViewName] = useState<string | null>(null);
  // Mở lại trang kèm ?id=... (F5, hoặc gửi link cho đồng nghiệp) -> đang đi lấy kết quả cũ.
  const [dangTaiLai, setDangTaiLai] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const preview = toTranslationForm(applicantName);

  // Khung xem file. Kết quả kiểm tra trả về các file ĐÚNG THỨ TỰ đã gửi lên, nên khớp được với
  // File gốc trong `files` theo vị trí — cần thế để mở được file thật (tên trả về có thể đã được
  // sửa lỗi mã hoá nên không còn khớp tên gốc). Mọi thao tác đổi danh sách file đều xoá kết quả
  // cũ (xem addFiles / nút xoá), nên vị trí luôn còn đúng.
  const viewIndex = result ? result.files.findIndex((f) => f.filename === viewName) : -1;
  const viewFile = viewIndex >= 0 && result ? result.files[viewIndex] : null;
  const viewFindings = viewFile && result ? result.findings.filter((f) => f.files.includes(viewFile.filename)) : [];

  useEffect(() => {
    if (!viewName) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewName(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewName]);

  function addFiles(incoming: File[]) {
    const supported = incoming.filter(isSupported);
    // Chọn cả thư mục thì dính cả file rác (.DS_Store, bản gốc tiếng Việt...) — bỏ qua nhưng
    // PHẢI nói ra, nếu không người dùng tưởng app đã kiểm tra cả những file đó.
    setSkipped(incoming.filter((f) => !isSupported(f)).map((f) => f.name));
    // Chọn thêm lần 2 thì CỘNG vào danh sách, bỏ file trùng (cùng tên + dung lượng) — bộ dịch
    // thuật hay có bản sao y hệt trong thư mục con, và không nên bắt chọn lại từ đầu.
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}|${f.size}`));
      return [...prev, ...supported.filter((f) => !seen.has(`${f.name}|${f.size}`))];
    });
    setError(supported.length === 0 && incoming.length > 0
      ? "Không có file nào dùng được — chỉ nhận Word (.doc, .docx), PDF hoặc ảnh."
      : null);
    xoaKetQua();
  }

  // Kết quả nằm trên MinIO chứ không phải trong bộ nhớ trình duyệt, nên F5 vẫn lấy lại được,
  // và gửi link cho người khác họ cũng mở được đúng báo cáo đó.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    let huy = false;
    setDangTaiLai(true);
    fetch(`${API_URL}/translation-check/${id}`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (huy) return;
        if (!r.ok) {
          setError(data?.detail ?? "Không mở lại được lượt kiểm tra này.");
          // Bỏ ?id= hỏng khỏi thanh địa chỉ, để F5 lần nữa không lặp lại đúng lỗi đó.
          window.history.replaceState(null, "", window.location.pathname);
          return;
        }
        setResult(data as TranslationCheckResponse);
        setApplicantName(data.applicantName ?? "");
      })
      .catch(() => {
        if (!huy) setError("Không kết nối được backend.");
      })
      .finally(() => {
        if (!huy) setDangTaiLai(false);
      });
    return () => {
      huy = true;
    };
  }, []);

  // Bỏ kết quả đang hiện VÀ xoá ?id= trên thanh địa chỉ. Phải làm cùng lúc: xoá kết quả mà
  // để id lại thì F5 dựng lại đúng báo cáo vừa bỏ đi, trông như nút bấm không ăn.
  function xoaKetQua() {
    setResult(null);
    window.history.replaceState(null, "", window.location.pathname);
  }

  // Đọc lại kết quả đã lưu, thử vài lần — dùng khi phần thân của lượt POST bị mất giữa đường.
  async function docLaiKetQua(id: string): Promise<TranslationCheckResponse | null> {
    for (let lan = 0; lan < 3; lan++) {
      if (lan > 0) await new Promise((r) => setTimeout(r, 1500));
      const r = await fetch(`${API_URL}/translation-check/${id}`).catch(() => null);
      const d = r?.ok ? await r.json().catch(() => null) : null;
      if (d?.checkId) return d as TranslationCheckResponse;
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Bắt buộc họ tên: mọi quy tắc tên đều so với tên này — thiếu thì không biết tên "đúng".
    if (preview.split(" ").filter(Boolean).length < 2) {
      setNameError("Bắt buộc nhập đầy đủ họ và tên của hồ sơ (ít nhất họ và tên).");
      return;
    }
    setNameError(null);
    if (files.length === 0) {
      setError("Chưa chọn file bản dịch nào.");
      return;
    }

    setChecking(true);
    xoaKetQua();
    try {
      const body = new FormData();
      body.append("applicantName", applicantName);
      files.forEach((f) => body.append("files", f));
      const res = await fetch(`${API_URL}/translation-check`, { method: "POST", body });
      let data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail ?? `Kiểm tra thất bại (HTTP ${res.status})`);
      // Máy chủ trả 200 mà phần thân không đọc được: đã gặp thật (28/09, bộ 34 file) — máy chủ
      // kiểm tra + lưu kết quả xong, trình duyệt lại mất phần thân trên đường về. Kết quả đã nằm
      // trên MinIO, mã lượt kiểm tra có ở header -> đọc lại bằng một request nhỏ riêng.
      const maHeader = res.headers.get("X-Check-Id");
      if (!data?.checkId && maHeader) data = await docLaiKetQua(maHeader);
      if (!data?.checkId) {
        throw new Error(
          "Máy chủ đã kiểm tra xong nhưng trình duyệt không nhận được kết quả (mạng chập chờn lúc " +
            "tải kết quả về). Bấm \"Kiểm tra bản dịch\" lần nữa."
        );
      }
      setResult(data as TranslationCheckResponse);
      // replaceState chứ không phải pushState: không tạo thêm một mục trong lịch sử, để bấm
      // Back vẫn quay về trang trước đó chứ không mắc kẹt ở chính trang này.
      window.history.replaceState(null, "", `?id=${data.checkId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không kết nối được backend.");
    } finally {
      setChecking(false);
    }
  }

  const errors = result?.findings.filter((f) => f.severity === "ERROR") ?? [];
  const warnings = result?.findings.filter((f) => f.severity === "WARNING") ?? [];

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <section className={`${FORM_SECTION} ${FORM_SECTION_VIOLET}`}>
          <h2 className={FORM_SECTION_TITLE}>1. Hồ sơ</h2>
          <label className={FORM_LABEL} htmlFor="applicantName">
            Họ và tên của hồ sơ <span className="text-rose-500">*</span>
          </label>
          <input
            id="applicantName"
            className={`${FORM_INPUT} ${nameError ? "border-rose-300 bg-rose-50/40" : ""}`}
            placeholder="Vd: Hồ Sỹ Trọng"
            value={applicantName}
            onChange={(e) => {
              setApplicantName(e.target.value);
              if (nameError) setNameError(null);
              xoaKetQua();
            }}
            autoComplete="off"
          />
          {nameError ? (
            <p className="mt-1.5 text-xs font-medium text-rose-600">{nameError}</p>
          ) : (
            <p className={FORM_HINT}>
              Gõ đúng như trên CCCD, có dấu.{" "}
              {preview && (
                <>
                  Tên chuẩn trong bản dịch: <span className="font-mono font-semibold text-neutral-700">{preview}</span>
                </>
              )}
            </p>
          )}
        </section>

        <section className={`${FORM_SECTION} ${FORM_SECTION_SKY}`}>
          <h2 className={FORM_SECTION_TITLE}>2. Bộ hồ sơ dịch thuật</h2>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              // Không await trực tiếp trong handler: filesFromDrop đã tự lấy entry ngay từ đầu,
              // phần còn lại đọc bất đồng bộ rồi mới cập nhật danh sách.
              filesFromDrop(e.dataTransfer).then((dropped) => {
                if (dropped.length > 0) addFiles(dropped);
                else setError("Không đọc được file nào từ thứ vừa thả — thử bấm chọn file hoặc chọn cả thư mục.");
              });
            }}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors ${
              dragOver ? "border-indigo-400 bg-indigo-50" : "border-neutral-300 bg-white hover:border-indigo-300"
            }`}
          >
            <p className="text-sm font-medium text-neutral-600">
              Kéo thả các file bản dịch (hoặc cả thư mục) vào đây, hoặc{" "}
              <span className="text-indigo-600 font-semibold underline">bấm để chọn file</span>
            </p>
            <p className="text-xs text-neutral-400 mt-1">
              Word (.doc, .docx), PDF hoặc ảnh — chọn nhiều file cùng lúc. Đặt tên theo quy ước
              &quot;&lt;số&gt;. &lt;Họ tên&gt; - &lt;loại giấy tờ&gt;&quot; để kiểm tra được tên chủ giấy tờ.
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation(); // không để bubble lên div, kẻo mở luôn hộp chọn FILE
                folderRef.current?.click();
              }}
              className="mt-3 rounded-full border border-indigo-200 bg-white px-4 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
            >
              Chọn cả thư mục hồ sơ dịch thuật
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) addFiles(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              // webkitdirectory: cho chọn NGUYÊN thư mục. Chưa có trong kiểu của React nên phải
              // truyền qua object; trình duyệt vẫn nhận đúng thuộc tính này.
              {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) addFiles(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </div>

          {skipped.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              Bỏ qua {skipped.length} file không phải bản dịch (chỉ nhận Word, PDF, ảnh):{" "}
              {skipped.slice(0, 5).join(", ")}
              {skipped.length > 5 ? `, và ${skipped.length - 5} file khác` : ""}.
            </p>
          )}

          {files.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold text-neutral-500">{files.length} file đã chọn</p>
                <button
                  type="button"
                  onClick={() => {
                    setFiles([]);
                    setSkipped([]);
                    xoaKetQua();
                  }}
                  className="text-xs text-neutral-400 hover:text-rose-600"
                >
                  Bỏ hết
                </button>
              </div>
              <ul className="flex flex-col gap-1 max-h-56 overflow-y-auto">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}|${f.size}`}
                    className="flex items-center justify-between gap-3 rounded-lg bg-white border border-neutral-100 px-3 py-1.5 text-xs"
                  >
                    <span className="truncate text-neutral-700">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setFiles((prev) => prev.filter((_, j) => j !== i));
                        xoaKetQua();
                      }}
                      className="shrink-0 text-neutral-400 hover:text-rose-600"
                      aria-label={`Bỏ ${f.name}`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {error && <p className="text-sm font-medium text-rose-600">{error}</p>}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={checking} className={FORM_SUBMIT}>
            {checking ? "Đang kiểm tra..." : "Kiểm tra bản dịch"}
          </button>
          {checking && <span className="text-xs text-neutral-400">Đang đọc và đối chiếu {files.length} file...</span>}
        </div>
      </form>

      {result && (
        <section className="flex flex-col gap-4">
          <div
            className={`rounded-2xl border p-5 ${
              result.summary.errors > 0
                ? "border-rose-200 bg-rose-50"
                : result.summary.warnings > 0
                  ? "border-amber-200 bg-amber-50"
                  : "border-emerald-200 bg-emerald-50"
            }`}
          >
            <p className="text-base font-semibold text-neutral-800">
              {result.summary.errors > 0
                ? `Có ${result.summary.errors} lỗi cần sửa`
                : result.summary.warnings > 0
                  ? "Không có lỗi, còn vài điểm cần xem lại"
                  : "Không phát hiện lỗi theo các quy tắc hiện có"}
            </p>
            <p className="mt-1 text-sm text-neutral-600">
              {result.summary.errors} lỗi · {result.summary.warnings} cảnh báo · đọc được {result.summary.readable}/
              {result.summary.files} file · tên chuẩn{" "}
              <span className="font-mono font-semibold">{result.expectedName}</span>
            </p>
          </div>

          {[...errors, ...warnings].map((f, i) => (
            <FindingCard key={`${f.rule}-${i}`} f={f} onOpenFile={setViewName} />
          ))}

          <div className="rounded-2xl border border-neutral-200 bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">File</th>
                  <th className="text-left font-semibold px-3 py-2">Chủ giấy tờ (theo tên file)</th>
                  <th className="text-left font-semibold px-3 py-2">Họ tên đọc được</th>
                  <th className="text-left font-semibold px-3 py-2">Kết quả</th>
                </tr>
              </thead>
              <tbody>
                {result.files.map((f) => {
                  const count = result.findings.filter((x) => x.files.includes(f.filename)).length;
                  return (
                    <tr key={f.filename} className="border-t border-neutral-100 align-top">
                      <td className="px-3 py-2 max-w-[16rem] break-words">
                        <button
                          type="button"
                          onClick={() => setViewName(f.filename)}
                          title="Bấm để xem nội dung file"
                          className="text-left text-indigo-700 hover:underline"
                        >
                          {f.filename}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-neutral-600">
                        {f.ownerName ?? <span className="text-neutral-300">Tên file không theo quy ước</span>}
                      </td>
                      <td className="px-3 py-2 text-neutral-500 max-w-[16rem]">{f.names.join(", ") || "—"}</td>
                      <td className="px-3 py-2">
                        {f.error ? (
                          <span className="text-rose-600">{f.error}</span>
                        ) : count > 0 ? (
                          <span className="text-amber-700 font-medium">{count} điểm cần xem</span>
                        ) : (
                          <span className="text-emerald-600 font-medium">Đạt</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {viewFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setViewName(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-neutral-200 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-neutral-800">{viewFile.filename}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {viewFile.ownerName ? `Chủ giấy tờ: ${viewFile.ownerName} · ` : ""}
                  {viewFile.chars.toLocaleString("vi-VN")} ký tự đọc được
                  {viewFile.url ? " · file gốc chỉ giữ 7 ngày" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* Mở bản ĐÃ LƯU TRÊN MINIO chứ không phải bản trong bộ nhớ trình duyệt: link
                    này còn dùng được sau khi tải lại trang và mở được từ máy khác. Gửi kèm tên
                    file để lúc tải về đúng tên — trên MinIO key chỉ là số thứ tự. */}
                {viewFile.url && (
                  <a
                    href={`${API_URL}${viewFile.url}?filename=${encodeURIComponent(viewFile.filename)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                  >
                    Mở file gốc
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setViewName(null)}
                  className="rounded-full border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-50"
                >
                  Đóng
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {viewFindings.length > 0 && (
                <ul className="mb-3 flex flex-col gap-1.5">
                  {viewFindings.map((f, i) => (
                    <li
                      key={`${f.rule}-${i}`}
                      className={`rounded-xl px-3 py-2 text-xs ${
                        f.severity === "ERROR" ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-800"
                      }`}
                    >
                      <span className="font-semibold">{f.title}:</span> {f.message}
                    </li>
                  ))}
                </ul>
              )}
              {viewFile.error ? (
                <p className="text-sm font-medium text-rose-600">{viewFile.error}</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-neutral-700">
                  <Highlighted text={viewFile.text} terms={highlightTerms(viewFindings)} />
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      <details className="rounded-2xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
        <summary className="cursor-pointer font-semibold text-neutral-700">Các quy tắc đang kiểm tra</summary>
        <ul className="mt-2 list-disc pl-5 flex flex-col gap-1">
          {RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-neutral-400">
          Kiểm tra bằng quy tắc trong code, không dùng AI. Chưa đối chiếu với bản gốc tiếng Việt — tên &quot;đúng&quot;
          lấy theo họ tên nhập ở trên và theo chính các bản dịch khác trong bộ.
        </p>
      </details>
    </div>
  );
}
