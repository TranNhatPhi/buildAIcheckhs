// Lưu mật khẩu admin ở localStorage — chỉ dùng phía client, chưa từng dùng Web Storage ở
// đâu khác trong app này (guard typeof window vì Next.js render trang này ở server trước).
const STORAGE_KEY = "admin_password";

export function getAdminPassword(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminPassword(password: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, password);
  } catch {
    // Private browsing / storage bị chặn — bỏ qua, người dùng sẽ phải nhập lại mật khẩu.
  }
}

export function clearAdminPassword(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}
