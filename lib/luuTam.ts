/**
 * Nhớ tạm trong TRÌNH DUYỆT để F5 không mất việc đang làm (trang Tách file, 14/10/2026 — Docs yêu cầu).
 *
 * - File đã chọn: IndexedDB (Blob) — localStorage chỉ vài MB, file scan 5-80 MB không vừa.
 * - Trạng thái nhỏ (hồ sơ đã chọn, bảng kết quả): localStorage (JSON).
 *
 * Mọi thao tác bọc try/catch và KHÔNG BAO GIỜ ném lỗi: chế độ ẩn danh, chặn lưu trữ, đầy ổ… thì chỉ là
 * không nhớ được — trang vẫn chạy bình thường như trước.
 */

const DB = "checklist-luu-tam";
const STORE = "files";

function moDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

interface FileLuu {
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
}

export async function luuFiles(khoa: string, files: File[]): Promise<void> {
  const db = await moDb();
  if (!db) return;
  try {
    const ds: FileLuu[] = files.map((f) => ({ name: f.name, type: f.type, lastModified: f.lastModified, blob: f }));
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      if (ds.length) tx.objectStore(STORE).put(ds, khoa);
      else tx.objectStore(STORE).delete(khoa);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* không nhớ được thì thôi */
  } finally {
    db.close();
  }
}

export async function docFiles(khoa: string): Promise<File[]> {
  const db = await moDb();
  if (!db) return [];
  try {
    const ds = await new Promise<FileLuu[] | undefined>((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(khoa);
      req.onsuccess = () => resolve(req.result as FileLuu[] | undefined);
      req.onerror = () => resolve(undefined);
    });
    return (ds ?? []).map((x) => new File([x.blob], x.name, { type: x.type, lastModified: x.lastModified }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function docJson<T>(khoa: string): T | null {
  try {
    const s = localStorage.getItem(khoa);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

export function ghiJson(khoa: string, giaTri: unknown): void {
  try {
    if (giaTri === null || giaTri === undefined || giaTri === "") localStorage.removeItem(khoa);
    else localStorage.setItem(khoa, JSON.stringify(giaTri));
  } catch {
    /* đầy / bị chặn — bỏ qua */
  }
}
