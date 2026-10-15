"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL, normalizeSearchText } from "@/lib/format";
import { FORM_HINT, FORM_INPUT, FORM_LABEL } from "@/lib/formStyles";
import { RoUpload } from "@/components/RoUpload";
import { docFiles, docJson, ghiJson, luuFiles } from "@/lib/luuTam";
import type { CaseListItemDTO } from "@/lib/client-types";

interface MucTach {
  id: string;
  number: string;
  name: string;
  section: string;
  label: string;
}

interface Doan {
  from: number;
  to: number;
  itemId: string | null;
  reason?: string;
  // Bước DUYỆT trước khi đưa vào hồ sơ: chỉ file đã duyệt mới được đưa vào. Sửa trang/mục là mất
  // duyệt — duyệt phải ứng với đúng bản cuối cùng.
  duyet?: boolean;
  dangDua?: boolean;
  daDua?: string; // đã vào hồ sơ: mô tả kết quả (khớp mục nào)
  loiDua?: string;
}

const CHI_GUI = ({ from, to, itemId }: Doan) => ({ from, to, itemId });

interface KetQuaPhanTich {
  jobId: string;
  fileName: string;
  pageCount: number;
  caseId: string;
  clientName: string;
  loai?: "goc" | "dich";
  items: MucTach[];
  segments: Doan[];
  aiNote: string | null;
  // File ZIP: file gốc nào bắt đầu ở trang nào + file bị bỏ qua (không phải PDF/Word/ảnh, hỏng).
  sourceFiles?: { page: number; name: string }[];
  skipped?: { file: string; lyDo: string }[];
}

// Giống tach_file._sach_ten ở backend — chỉ để XEM TRƯỚC tên; tên thật do backend đặt lúc tải ZIP.
function sachTen(s: string) {
  return (
    s
      .normalize("NFC")
      .replace(/[<>:"/\\|?*]/g, "-")
      .split(/\s+/)
      .join(" ")
      .replace(/^[\s.-]+|[\s.-]+$/g, "") || "khong-ten"
  );
}

/**
 * Trang "Tách file" (/tach-file): một file PDF/Word scan gộp nhiều giấy tờ -> tách thành từng file,
 * đặt tên theo quy ước "<số mục>. <Họ tên> - <loại>.pdf" để upload vào hồ sơ là tự khớp đúng mục.
 * DeepSeek đề xuất cách chia (backend tach_file.py); nhân viên xem ảnh từng trang, sửa trang từ–đến
 * và mục, rồi tải ZIP — backend tách theo ĐÚNG bảng đã sửa.
 *
 * `banDich` = trang "Tách hồ sơ dịch thuật PDF / Excel" (/tach-ban-dich): file gộp các BẢN DỊCH tiếng
 * Anh, nhận thêm Excel, tên file đuôi " - translated" (như bộ mẫu hosodichthuat/). File đã DUYỆT đưa
 * vào "HỒ SƠ HOÀN THÀNH" (POST /split-tool/{job}/to-final, tab /ho-so-hoan-thanh) — KHÔNG vào giấy tờ
 * của hồ sơ thô: ở đó bản dịch khớp cùng mục với bản gốc và bị cộng vào tiến độ / số trang dịch.
 */
export function TachFile({ banDich = false }: { banDich?: boolean }) {
  const DUOI = banDich ? " - translated" : "";
  // Nơi nhận file đã duyệt: hồ sơ thô (trang gốc) hoặc hồ sơ hoàn thành (trang bản dịch).
  const NOI_NHAN = banDich ? "hồ sơ hoàn thành" : "hồ sơ thô";
  const [hoSo, setHoSo] = useState<CaseListItemDTO[]>([]);
  const [caseId, setCaseId] = useState("");
  const [timHoSo, setTimHoSo] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  const [dangXuLy, setDangXuLy] = useState(false);
  const [giay, setGiay] = useState(0);
  const [loi, setLoi] = useState<string | null>(null);
  const [kq, setKq] = useState<KetQuaPhanTich | null>(null);
  const [doan, setDoan] = useState<Doan[]>([]);
  const [dangTai, setDangTai] = useState(false);
  const [dangDuaVao, setDangDuaVao] = useState(false);
  // Khung xem MỘT file đã tách: chỉ hiện đúng các trang của file đó (không mở cả file gốc).
  const [xem, setXem] = useState<number | null>(null);
  useEffect(() => {
    if (xem === null) return;
    const dong = (e: KeyboardEvent) => e.key === "Escape" && setXem(null);
    window.addEventListener("keydown", dong);
    return () => window.removeEventListener("keydown", dong);
  }, [xem]);
  // Tên file đang có trong hồ sơ — file tách ra trùng tên sẽ THAY bản cũ (đúng quy tắc upload).
  const [tenDaCo, setTenDaCo] = useState<Set<string>>(new Set());
  // Hồ sơ hoàn thành đặt tên TIẾNG ANH (khác tên xem trước ở đây) -> so theo MỤC thay vì tên.
  const caseKq = kq?.caseId;
  useEffect(() => {
    if (!caseKq) return;
    fetch(banDich ? `${API_URL}/final/cases/${caseKq}` : `${API_URL}/cases/${caseKq}`)
      .then((x) => (x.ok ? x.json() : null))
      .then((ct) =>
        setTenDaCo(
          new Set(
            banDich
              ? (ct?.files ?? []).map((f: { itemId: string | null }) => `muc:${f.itemId}`)
              : (ct?.case?.documents ?? []).map((doc: { originalFilename: string }) =>
                  doc.originalFilename.normalize("NFC").toLocaleLowerCase("vi"),
                ),
          ),
        ),
      )
      .catch(() => setTenDaCo(new Set()));
  }, [caseKq, banDich]);

  // F5 KHÔNG MẤT VIỆC (14/10/2026, Docs yêu cầu): nhớ hồ sơ đã chọn + bảng kết quả (localStorage) và file
  // đã chọn (IndexedDB — file scan vài chục MB) theo từng trang; mở lại thì khôi phục. Bảng kết quả chỉ
  // khôi phục khi lượt tách còn trên máy chủ (file tạm tự xoá sau 24 giờ). "Tách file khác" / "Bỏ hết" xoá.
  const KHOA = banDich ? "tach-ban-dich" : "tach-file";
  const [daKhoiPhuc, setDaKhoiPhuc] = useState(false);

  // TÁCH CHẠY NỀN (14/10/2026): POST /split-tool trả ngay jobId (202), phần đọc chữ + AI chạy trên máy chủ.
  // Hỏi GET /{job}/result mỗi 3 giây tới khi xong. Lượt đang chờ nhớ ở localStorage `${KHOA}:dangTach` — F5
  // thì hỏi tiếp ĐÚNG lượt đó (không tách lại). `luotCho` = lượt đang được chờ; bấm Dừng / lượt mới thì vòng
  // hỏi cũ tự thôi.
  const luotCho = useRef<string | null>(null);
  const choKetQua = useCallback(
    async (job: string) => {
      luotCho.current = job;
      setDangXuLy(true);
      while (luotCho.current === job) {
        const r = await fetch(`${API_URL}/split-tool/${job}/result`).catch(() => null);
        if (luotCho.current !== job) return;
        if (r && r.status === 202) {
          await new Promise((ok) => setTimeout(ok, 3000));
          continue;
        }
        const d = r ? await r.json().catch(() => null) : null;
        if (luotCho.current !== job) return;
        if (!r) {
          // Mất mạng chốc lát — hỏi lại, lượt vẫn đang chạy trên máy chủ.
          await new Promise((ok) => setTimeout(ok, 5000));
          continue;
        }
        luotCho.current = null;
        ghiJson(`${KHOA}:dangTach`, null);
        setDangXuLy(false);
        if (r.ok) {
          setKq(d);
          setDoan(d.segments);
        } else if (!d?.cancelled) {
          setLoi(typeof d?.detail === "string" ? d.detail : "Không tách được file — thử lại sau.");
        }
        return;
      }
    },
    [KHOA],
  );

  async function dungTach() {
    const job = luotCho.current;
    luotCho.current = null;
    ghiJson(`${KHOA}:dangTach`, null);
    setDangXuLy(false);
    setLoi("Đã dừng tách file — file đã chọn vẫn giữ, bấm Tách file để chạy lại.");
    if (job) await fetch(`${API_URL}/split-tool/${job}/cancel`, { method: "POST" }).catch(() => null);
  }
  useEffect(() => {
    let huy = false;
    (async () => {
      const ma = docJson<string>(`${KHOA}:caseId`);
      if (ma && !huy) setCaseId(ma);
      const fs = await docFiles(`${KHOA}:files`);
      if (fs.length && !huy) setFiles(fs);
      const luu = docJson<{ kq: KetQuaPhanTich; doan: Doan[] }>(`${KHOA}:ketQua`);
      if (luu?.kq?.jobId) {
        const conSong = await fetch(`${API_URL}/split-tool/${luu.kq.jobId}/pages/1?dpi=40`)
          .then((r) => r.ok)
          .catch(() => false);
        if (conSong && !huy) {
          setKq(luu.kq);
          // Đang đưa dở lúc F5 thì coi như chưa đưa — bấm lại được.
          setDoan(luu.doan.map((d) => ({ ...d, dangDua: false })));
        } else ghiJson(`${KHOA}:ketQua`, null);
      }
      // Đang tách dở lúc F5 -> chờ tiếp đúng lượt đó, đồng hồ tính từ lúc bấm Tách.
      const dang = docJson<{ jobId: string; startedAt: number }>(`${KHOA}:dangTach`);
      if (dang?.jobId && !huy) {
        setGiay(Math.max(0, Math.round(Date.now() / 1000 - (dang.startedAt || Date.now() / 1000))));
        choKetQua(dang.jobId);
      }
      if (!huy) setDaKhoiPhuc(true);
    })();
    return () => {
      huy = true;
    };
  }, [KHOA, choKetQua]);
  useEffect(() => {
    if (daKhoiPhuc) ghiJson(`${KHOA}:caseId`, caseId);
  }, [daKhoiPhuc, KHOA, caseId]);
  useEffect(() => {
    if (daKhoiPhuc) luuFiles(`${KHOA}:files`, files);
  }, [daKhoiPhuc, KHOA, files]);
  useEffect(() => {
    if (daKhoiPhuc) ghiJson(`${KHOA}:ketQua`, kq ? { kq, doan } : null);
  }, [daKhoiPhuc, KHOA, kq, doan]);

  useEffect(() => {
    fetch(`${API_URL}/cases`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: CaseListItemDTO[]) =>
        setHoSo([...d].sort((a, b) => a.clientName.localeCompare(b.clientName, "vi"))),
      )
      .catch(() => setHoSo([]));
  }, []);

  useEffect(() => {
    if (!dangXuLy) return;
    const t = setInterval(() => setGiay((g) => g + 1), 1000);
    return () => clearInterval(t);
  }, [dangXuLy]);

  const hoSoLoc = useMemo(() => {
    const q = normalizeSearchText(timHoSo.trim());
    return q
      ? hoSo.filter((c) => normalizeSearchText(`${c.clientName} ${c.partner ?? ""}`).includes(q))
      : hoSo;
  }, [hoSo, timHoSo]);

  function phanTich(e: React.FormEvent) {
    e.preventDefault();
    batDauTach();
  }

  // "🔄 Tách lại" (14/10/2026, Docs yêu cầu): bỏ kết quả hiện tại (cách chia / mục / dấu duyệt) và tách lại
  // NGAY đúng file + hồ sơ đó — vd lượt trước AI lỗi. File đã đưa vào hồ sơ thì vẫn ở đó.
  function tachLai() {
    if (
      !confirm(
        "Tách lại từ đầu với đúng file này?\n\nCách chia, mục đã chọn và dấu duyệt hiện tại sẽ mất " +
          "(file đã đưa vào hồ sơ vẫn giữ).",
      )
    )
      return;
    setKq(null);
    setDoan([]);
    setXem(null);
    if (!files.length) {
      setLoi("Không còn file đã chọn trên trình duyệt — chọn lại file rồi bấm Tách file.");
      return;
    }
    batDauTach();
  }

  async function batDauTach() {
    if (!caseId) return setLoi("Chọn hồ sơ trước — số thứ tự trong tên file lấy theo checklist của hồ sơ đó.");
    if (!files.length)
      return setLoi(`Kéo thả hoặc chọn file PDF, Word, ${banDich ? "Excel, " : ""}ảnh hoặc ZIP cần tách.`);
    if (files.reduce((t, f) => t + f.size, 0) > 80 * 1024 * 1024)
      return setLoi("Tổng dung lượng các file vượt 80MB — bỏ bớt file rồi tách làm nhiều lần.");
    setLoi(null);
    setKq(null);
    setGiay(0);
    setDangXuLy(true);
    try {
      const body = new FormData();
      body.append("caseId", caseId);
      body.append("loai", banDich ? "dich" : "goc");
      for (const f of files) body.append("file", f);
      const r = await fetch(`${API_URL}/split-tool`, { method: "POST", body });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setLoi(typeof d?.detail === "string" ? d.detail : "Không tách được file — thử lại sau.");
        setDangXuLy(false);
        return;
      }
      ghiJson(`${KHOA}:dangTach`, { jobId: d.jobId, startedAt: d.startedAt });
      await choKetQua(d.jobId);
    } catch {
      setLoi("Không kết nối được máy chủ — thử lại sau.");
      setDangXuLy(false);
    }
  }

  const mucTheoId = useMemo(() => new Map((kq?.items ?? []).map((m) => [m.id, m])), [kq]);

  // ZIP: trang `p` thuộc file gốc nào trong ZIP (file cuối cùng bắt đầu ở trang <= p).
  function fileGoc(p: number): string | null {
    let ten: string | null = null;
    for (const f of kq?.sourceFiles ?? []) if (f.page <= p) ten = f.name;
    return ten;
  }

  // Tên file xem trước — trùng tên thì thêm " (2)", giống backend.
  const tenFiles = useMemo(() => {
    const daDung = new Map<string, number>();
    return doan.map((d) => {
      const m = d.itemId ? mucTheoId.get(d.itemId) : undefined;
      const khach = sachTen(kq?.clientName ?? "");
      let ten = m
        ? `${m.number}. ${khach} - ${m.label}${DUOI}.pdf`
        : `${khach} - Chua xac dinh (${d.from === d.to ? `trang ${d.from}` : `trang ${d.from}-${d.to}`})${DUOI}.pdf`;
      const k = ten.toLocaleLowerCase("vi");
      const lan = (daDung.get(k) ?? 0) + 1;
      daDung.set(k, lan);
      if (lan > 1) ten = ten.replace(/\.pdf$/, ` (${lan}).pdf`);
      return ten;
    });
  }, [doan, mucTheoId, kq, DUOI]);

  // Cảnh báo: trang chưa thuộc file nào / trang nằm trong 2 file / số trang sai.
  const canhBao = useMemo(() => {
    if (!kq) return [];
    const dem = new Array(kq.pageCount + 1).fill(0);
    const loiDong: string[] = [];
    doan.forEach((d, i) => {
      if (!(d.from >= 1 && d.to <= kq.pageCount && d.from <= d.to)) {
        loiDong.push(`Dòng ${i + 1}: trang ${d.from}–${d.to} không hợp lệ (file có ${kq.pageCount} trang).`);
        return;
      }
      for (let p = d.from; p <= d.to; p++) dem[p]++;
    });
    const thieu = dem.map((n, p) => (p > 0 && n === 0 ? p : 0)).filter(Boolean);
    const trung = dem.map((n, p) => (n > 1 ? p : 0)).filter(Boolean);
    if (thieu.length) loiDong.push(`Trang chưa thuộc file nào: ${thieu.join(", ")}.`);
    if (trung.length) loiDong.push(`Trang nằm trong nhiều file: ${trung.join(", ")}.`);
    const chuaChon = doan.filter((d) => !d.itemId).length;
    if (chuaChon)
      loiDong.push(
        `${chuaChon} file chưa chọn mục — tên sẽ là "Chua xac dinh"` + (banDich ? "." : ", không tự vào hồ sơ được."),
      );
    return loiDong;
  }, [doan, kq, banDich]);

  function sua(i: number, thayDoi: Partial<Doan>) {
    setDoan((cu) => cu.map((d, k) => (k === i ? { ...d, ...thayDoi, duyet: false } : d)));
  }

  // Duyệt được khi: đã chọn mục, trang hợp lệ, chưa đưa vào hồ sơ.
  function duyetDuoc(d: Doan) {
    return !!kq && !!d.itemId && d.from >= 1 && d.to <= kq.pageCount && d.from <= d.to && !d.daDua;
  }

  const soDaDuyet = doan.filter((d) => d.duyet && !d.daDua).length;

  // Nơi nhận đã có file này chưa (sẽ THAY bản cũ). Hồ sơ hoàn thành đặt tên tiếng Anh nên so theo MỤC.
  function daCo(d: Doan, i: number) {
    return banDich
      ? !!d.itemId && tenDaCo.has(`muc:${d.itemId}`)
      : tenDaCo.has(tenFiles[i].normalize("NFC").toLocaleLowerCase("vi"));
  }

  async function duaVaoHoSo() {
    if (!kq || !soDaDuyet) return;
    const thay = doan.filter((d, i) => d.duyet && !d.daDua && daCo(d, i)).length;
    if (
      !confirm(
        `Đưa ${soDaDuyet} file đã duyệt vào ${NOI_NHAN} "${kq.clientName}"?\n\n` +
          (banDich ? "" : "• Mỗi file được đọc chữ và xếp mục như upload thường — có thể mất vài phút.\n") +
          (thay ? `• ${thay} file trùng tên file đã có trong hồ sơ sẽ THAY bản cũ.\n` : "") +
          "• File chưa duyệt không được đưa vào.",
      )
    )
      return;
    setDangDuaVao(true);
    const bang = doan.map(CHI_GUI);
    const viTri = doan.map((d, i) => (d.duyet && !d.daDua ? i : -1)).filter((i) => i >= 0);
    const capNhat = (i: number, thayDoi: Partial<Doan>) =>
      setDoan((cu) => cu.map((d, k) => (k === i ? { ...d, ...thayDoi } : d)));
    // 2 file một lúc: mỗi file OCR vài chục giây, chạy hết một lượt dễ làm nghẽn máy chủ.
    const hang = [...viTri];
    const chay = async () => {
      for (let i = hang.shift(); i !== undefined; i = hang.shift()) {
        capNhat(i, { dangDua: true, loiDua: undefined });
        try {
          if (banDich) {
            const r = await fetch(`${API_URL}/split-tool/${kq.jobId}/to-final`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ segments: bang, index: i }),
            });
            const kqDua = await r.json().catch(() => null);
            if (!r.ok) throw new Error(typeof kqDua?.detail === "string" ? kqDua.detail : "Không đưa được file này.");
            capNhat(i, { dangDua: false, daDua: kqDua?.replaced ? "Đã thay bản cũ trong hồ sơ hoàn thành" : "Đã vào hồ sơ hoàn thành" });
            continue;
          }
          const r = await fetch(`${API_URL}/split-tool/${kq.jobId}/file`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ segments: bang, index: i }),
          });
          if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? "Không tách được file này.");
          const ten = decodeURIComponent(r.headers.get("X-File-Name") ?? "") || tenFiles[i];
          const fd = new FormData();
          fd.append("file", new File([await r.blob()], ten, { type: "application/pdf" }));
          const up = await fetch(`${API_URL}/cases/${kq.caseId}/documents`, { method: "POST", body: fd });
          const doc = await up.json().catch(() => null);
          if (!up.ok) throw new Error(typeof doc?.detail === "string" ? doc.detail : "Upload vào hồ sơ thất bại.");
          capNhat(i, {
            dangDua: false,
            daDua:
              (up.status === 200 ? "Đã thay bản cũ" : "Đã vào hồ sơ") +
              (doc?.matchedChecklistItem ? ` → ${doc.matchedChecklistItem.nameVi}` : " → chưa khớp mục (cần review)"),
          });
        } catch (e) {
          capNhat(i, { dangDua: false, loiDua: e instanceof Error ? e.message : "Lỗi không rõ" });
        }
      }
    };
    await Promise.all([chay(), chay()]);
    setDangDuaVao(false);
  }

  function tachDoi(i: number) {
    const d = doan[i];
    if (d.from >= d.to) return;
    const giua = d.from;
    setDoan((cu) => [
      ...cu.slice(0, i),
      { ...d, to: giua, duyet: false },
      { from: giua + 1, to: d.to, itemId: null, reason: "Tách tay" },
      ...cu.slice(i + 1),
    ]);
  }

  function gopXuong(i: number) {
    if (i >= doan.length - 1) return;
    setDoan((cu) => [
      ...cu.slice(0, i),
      { ...cu[i], to: Math.max(cu[i].to, cu[i + 1].to), duyet: false },
      ...cu.slice(i + 2),
    ]);
  }

  async function taiZip() {
    if (!kq) return;
    setDangTai(true);
    try {
      const r = await fetch(`${API_URL}/split-tool/${kq.jobId}/zip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: doan.map(CHI_GUI) }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        alert(typeof d?.detail === "string" ? d.detail : "Không tạo được file ZIP.");
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sachTen(kq.clientName)} - ${banDich ? "tach ban dich" : "tach file"}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDangTai(false);
    }
  }

  function lamLai() {
    setKq(null);
    setDoan([]);
    setFiles([]);
  }

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{banDich ? "Tách hồ sơ dịch thuật PDF / Excel" : "Tách file PDF / Word gốc"}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {banDich ? (
            <>
              Một file gộp nhiều BẢN DỊCH (PDF / Word / Excel) → tách thành từng bộ: trang dịch + trang công chứng + bản
              gốc tiếng Việt (LLTP số 2 và phiếu lương không cần trang công chứng), đặt tên “số mục. Họ tên - loại giấy -
              translated”. Đọc chữ (OCR) + AI (DeepSeek) đề xuất cách chia — bạn xem lại, sửa rồi tải ZIP.
            </>
          ) : (
            <>
              Một file scan gộp nhiều giấy tờ → tách thành từng file, đặt tên đúng quy ước “số mục. Họ tên - loại giấy”
              để upload vào hồ sơ là tự vào đúng mục. AI (DeepSeek) đề xuất cách chia — bạn xem lại, sửa rồi tải ZIP.
            </>
          )}
        </p>
      </div>

      {!kq && (
        <form onSubmit={phanTich} className="rounded-2xl border-2 border-neutral-200 bg-white p-6 flex flex-col gap-5">
          <div>
            <label className={FORM_LABEL} htmlFor="tach-ho-so">
              1. Hồ sơ của khách
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={timHoSo}
                onChange={(e) => setTimHoSo(e.target.value)}
                placeholder="🔍 Tìm tên khách / nguồn"
                className={`${FORM_INPUT} sm:w-64`}
                aria-label="Tìm hồ sơ"
              />
              <select
                id="tach-ho-so"
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
                className={`${FORM_INPUT} flex-1`}
              >
                <option value="">— Chọn hồ sơ ({hoSoLoc.length}) —</option>
                {hoSoLoc.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.clientName}
                    {c.partner ? ` · ${c.partner}` : ""} · {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"} ·{" "}
                    {c.skillLevel === "HIGH_SKILL" ? "High" : "Low"} Skilled
                  </option>
                ))}
              </select>
            </div>
            <p className={FORM_HINT}>Số thứ tự trong tên file lấy theo checklist của hồ sơ này (độc thân / có gia đình khác số).</p>
          </div>
          <div>
            <label className={FORM_LABEL}>
              2. File cần tách
            </label>
            {/* Vùng kéo thả kiểu "ném vào rổ" (components/RoUpload.tsx). */}
            <RoUpload files={files} onFiles={setFiles} nhanExcel={banDich} />
            <p className={FORM_HINT}>Trang scan sẽ được đọc chữ (OCR) trước.</p>
          </div>
          {loi && <p className="text-sm text-red-600">{loi}</p>}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={dangXuLy}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
            >
              {dangXuLy ? "Đang đọc chữ & phân tích…" : "✂️ Tách file"}
            </button>
            {dangXuLy && (
              <>
                <span className="text-sm text-neutral-500 tabular-nums">
                  {giay} giây — file scan nhiều trang có thể mất vài phút. Đang chạy trên máy chủ: F5 / tắt trang
                  không mất, mở lại là chờ tiếp.
                </span>
                <button
                  type="button"
                  onClick={dungTach}
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
                >
                  ⏹ Dừng tách file
                </button>
              </>
            )}
          </div>
        </form>
      )}

      {kq && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-lg font-semibold text-neutral-900">
                {kq.fileName}: {kq.pageCount} trang → {doan.length} file
              </p>
              <p className="text-sm text-neutral-500">Hồ sơ: {kq.clientName}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`${API_URL}/split-tool/${kq.jobId}/source.pdf`}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                Xem file gốc
              </a>
              <button
                type="button"
                onClick={tachLai}
                disabled={dangDuaVao}
                title="Bỏ kết quả này và tách lại ngay đúng file + hồ sơ đã chọn"
                className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100"
              >
                🔄 Tách lại
              </button>
              <button
                type="button"
                onClick={lamLai}
                disabled={dangDuaVao}
                className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                Tách file khác
              </button>
              <button
                type="button"
                onClick={taiZip}
                disabled={dangTai || doan.length === 0}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {dangTai ? "Đang tạo ZIP…" : `⬇ Tải ${doan.length} file (ZIP)`}
              </button>
            </div>
          </div>

          {/* Bước DUYỆT: chỉ file đã duyệt mới được đưa vào hồ sơ (trang bản dịch: hồ sơ hoàn thành). */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="mr-auto text-sm text-emerald-900">
              Đã duyệt <span className="font-semibold tabular-nums">{soDaDuyet}</span> /{" "}
              {doan.filter((d) => !d.daDua).length} file — xem lại từng file rồi bấm <b>✓ Duyệt</b>; chỉ file đã duyệt
              mới được đưa vào {NOI_NHAN}.
            </p>
            <button
              type="button"
              disabled={dangDuaVao}
              onClick={() => setDoan((cu) => cu.map((d) => (duyetDuoc(d) ? { ...d, duyet: true } : d)))}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
              title="Duyệt mọi file đã chọn mục"
            >
              Duyệt tất cả
            </button>
            <button
              type="button"
              onClick={duaVaoHoSo}
              disabled={dangDuaVao || soDaDuyet === 0}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40"
            >
              {dangDuaVao ? `Đang đưa vào ${NOI_NHAN}…` : `⤴ Đưa ${soDaDuyet} file đã duyệt vào ${NOI_NHAN}`}
            </button>
            {doan.some((d) => d.daDua) && !dangDuaVao && (
              <a
                href={banDich ? `/ho-so-hoan-thanh/${kq.caseId}` : `/cases/${kq.caseId}`}
                className="text-sm font-semibold text-emerald-800 underline"
              >
                Mở {NOI_NHAN} {kq.clientName} →
              </a>
            )}
          </div>

          {(kq.sourceFiles?.length ?? 0) > 1 && (
            <p className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-600">
              📦 Đã ghép {kq.sourceFiles!.length} file trong ZIP theo thứ tự tên file thành {kq.pageCount} trang.
            </p>
          )}
          {(kq.skipped?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">Bỏ qua {kq.skipped!.length} file trong ZIP:</p>
              <ul className="mt-1 list-disc list-inside text-xs">
                {kq.skipped!.map((b) => (
                  <li key={b.file}>
                    {b.file} — {b.lyDo}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {kq.aiNote && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{kq.aiNote}</p>
          )}
          {canhBao.length > 0 && (
            <ul className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 list-disc list-inside">
              {canhBao.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}

          <ol className="flex flex-col gap-3">
            {doan.map((d, i) => {
              const khoa = dangDuaVao || !!d.daDua || !!d.dangDua;
              const trungTen = daCo(d, i);
              return (
              <li
                key={i}
                className={`rounded-2xl border-2 p-4 ${
                  d.daDua ? "border-emerald-300 bg-emerald-50/50" : d.duyet ? "border-emerald-400 bg-white" : "border-neutral-200 bg-white"
                }`}
              >
                <div className="flex flex-wrap items-start gap-4">
                  <button
                    type="button"
                    onClick={() => setXem(i)}
                    title={`Xem trang ${d.from}${d.to > d.from ? `–${d.to}` : ""} của file này`}
                    className="relative shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${API_URL}/split-tool/${kq.jobId}/pages/${d.from}`}
                      alt={`Trang ${d.from}`}
                      loading="lazy"
                      className="h-28 w-20 rounded border border-neutral-200 bg-neutral-50 object-contain hover:ring-2 hover:ring-indigo-300"
                    />
                    {d.to > d.from && (
                      <span className="absolute bottom-1 right-1 rounded bg-neutral-900/70 px-1 text-[10px] font-semibold text-white">
                        {d.to - d.from + 1} tr
                      </span>
                    )}
                  </button>
                  <div className="flex-1 min-w-0 flex flex-col gap-2">
                    <p className="text-sm font-semibold text-neutral-900 break-all">
                      <span className="text-neutral-400 mr-1">{i + 1}.</span>
                      <button type="button" onClick={() => setXem(i)} className="text-left hover:text-indigo-700 hover:underline">
                        {tenFiles[i]}
                      </button>
                      {trungTen && !d.daDua && (
                        <span
                          className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                          title={
                            banDich
                              ? "Hồ sơ hoàn thành đã có file ở mục này — đưa vào sẽ THAY bản cũ"
                              : "Hồ sơ đã có file cùng tên — đưa vào sẽ THAY bản cũ"
                          }
                        >
                          {banDich ? "Mục đã có file — sẽ thay bản cũ" : "Trùng tên — sẽ thay bản cũ"}
                        </span>
                      )}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-neutral-500">Trang</span>
                      <input
                        type="number"
                        min={1}
                        max={kq.pageCount}
                        value={d.from}
                        onChange={(e) => sua(i, { from: Number(e.target.value) })}
                        disabled={khoa}
                        className="w-16 rounded border border-neutral-300 px-2 py-1"
                        aria-label="Từ trang"
                      />
                      <span className="text-neutral-500">–</span>
                      <input
                        type="number"
                        min={1}
                        max={kq.pageCount}
                        value={d.to}
                        onChange={(e) => sua(i, { to: Number(e.target.value) })}
                        disabled={khoa}
                        className="w-16 rounded border border-neutral-300 px-2 py-1"
                        aria-label="Đến trang"
                      />
                      <select
                        value={d.itemId ?? ""}
                        onChange={(e) => sua(i, { itemId: e.target.value || null })}
                        disabled={khoa}
                        className={`min-w-0 flex-1 rounded border px-2 py-1 ${
                          d.itemId ? "border-neutral-300" : "border-amber-400 bg-amber-50"
                        }`}
                        aria-label="Mục checklist"
                      >
                        <option value="">— Chưa xác định —</option>
                        {kq.items.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.number}. {m.name} · {m.section}
                          </option>
                        ))}
                      </select>
                    </div>
                    {fileGoc(d.from) && (
                      <p className="text-xs text-neutral-500">
                        📎 Từ file: <span className="font-medium">{fileGoc(d.from)}</span>
                      </p>
                    )}
                    {d.reason && <p className="text-xs text-neutral-400">AI: {d.reason}</p>}
                    {d.dangDua && (
                      <p className="text-xs font-semibold text-indigo-700">
                        ⏳ {banDich ? "Đang đưa vào hồ sơ hoàn thành…" : "Đang đưa vào hồ sơ thô (đọc chữ, xếp mục)…"}
                      </p>
                    )}
                    {d.daDua && <p className="text-xs font-semibold text-emerald-700">✓ {d.daDua}</p>}
                    {d.loiDua && <p className="text-xs font-semibold text-red-600">✕ {d.loiDua}</p>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDoan((cu) => cu.map((x, k) => (k === i ? { ...x, duyet: !x.duyet } : x)))}
                      disabled={khoa || (!d.duyet && !duyetDuoc(d))}
                      title={d.itemId ? `Duyệt file này để đưa vào ${NOI_NHAN}` : "Chọn mục checklist trước khi duyệt"}
                      className={`rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40 ${
                        d.duyet || d.daDua
                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                          : "border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"
                      }`}
                    >
                      {d.daDua ? "✓ Đã vào hồ sơ" : d.duyet ? "✓ Đã duyệt" : "✓ Duyệt"}
                    </button>
                    {/* "Tách trang đầu" / "Gộp với file dưới": có ở CẢ 2 trang (trang bản dịch bỏ 13/10, Docs bật lại 14/10/2026). */}
                    <button
                      type="button"
                      onClick={() => tachDoi(i)}
                      disabled={khoa || d.from >= d.to}
                      title="Trang đầu thành 1 file riêng, các trang sau thành file khác"
                      className="rounded-lg px-3 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-30"
                    >
                      ✂ Tách trang đầu
                    </button>
                    <button
                      type="button"
                      onClick={() => gopXuong(i)}
                      disabled={khoa || i >= doan.length - 1 || !!doan[i + 1]?.daDua}
                      title="Gộp với file ngay dưới thành 1 file"
                      className="rounded-lg px-3 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-30"
                    >
                      ⤓ Gộp với file dưới
                    </button>
                    <button
                      type="button"
                      onClick={() => setDoan((cu) => cu.filter((_, k) => k !== i))}
                      disabled={khoa}
                      className="rounded-lg px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-30"
                    >
                      Bỏ file này
                    </button>
                  </div>
                </div>
              </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* Khung xem một file đã tách — CHỈ các trang from..to của file đó, theo bảng đang sửa. */}
      {kq && xem !== null && doan[xem] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/70 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setXem(null)}
        >
          <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-neutral-100 shadow-2xl">
            <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-neutral-900">{tenFiles[xem]}</p>
                <p className="text-xs text-neutral-500">
                  Trang {doan[xem].from}
                  {doan[xem].to > doan[xem].from ? `–${doan[xem].to}` : ""} của file gốc ·{" "}
                  {doan[xem].to - doan[xem].from + 1} trang
                </p>
              </div>
              <button
                type="button"
                disabled={xem <= 0}
                onClick={() => setXem(xem - 1)}
                className="rounded-lg px-3 py-1.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-100 disabled:opacity-30"
              >
                ‹ File trước
              </button>
              <button
                type="button"
                disabled={xem >= doan.length - 1}
                onClick={() => setXem(xem + 1)}
                className="rounded-lg px-3 py-1.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-100 disabled:opacity-30"
              >
                File sau ›
              </button>
              <button
                type="button"
                onClick={() => setXem(null)}
                aria-label="Đóng"
                className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col items-center gap-4 overflow-y-auto p-5">
              {Array.from(
                { length: Math.max(0, Math.min(doan[xem].to, kq.pageCount) - doan[xem].from + 1) },
                (_, k) => doan[xem].from + k,
              ).map((p) => (
                <figure key={p} className="w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${API_URL}/split-tool/${kq.jobId}/pages/${p}?dpi=110`}
                    alt={`Trang ${p}`}
                    className="mx-auto w-full max-w-2xl rounded bg-white shadow"
                  />
                  <figcaption className="mt-1 text-center text-xs text-neutral-500">
                    Trang {p} (file gốc)
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
