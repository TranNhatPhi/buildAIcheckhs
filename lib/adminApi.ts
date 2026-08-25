import { API_URL } from "@/lib/format";
import { getAdminPassword } from "@/lib/adminAuth";

export class AdminUnauthorizedError extends Error {
  constructor() {
    super("Sai mật khẩu admin");
    this.name = "AdminUnauthorizedError";
  }
}

// Wrapper quanh fetch tự gắn header X-Admin-Password — ném AdminUnauthorizedError riêng khi
// 401 để component tự xoá mật khẩu sai khỏi localStorage và quay lại màn hình đăng nhập,
// thay vì hiện lỗi chung chung.
export async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const password = getAdminPassword();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      "X-Admin-Password": password ?? "",
    },
  });
  if (res.status === 401) throw new AdminUnauthorizedError();
  return res;
}
