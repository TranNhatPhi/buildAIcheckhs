import { headers } from "next/headers";
import { API_URL } from "@/lib/format";

// URL API cho SERVER COMPONENT (code chạy trong tiến trình Node của container frontend), khác
// API_URL dùng trong trình duyệt. CHỈ import từ server component.
//
// VÌ SAO tách riêng: API_URL (https://candoc.info/api) bắt container phải hỏi DNS tên miền qua
// Docker -> router. Router chập chờn là trang chủ / trang hồ sơ lỗi dù backend vẫn khoẻ — đã gặp
// thật (28/09: "getaddrinfo EAI_AGAIN candoc.info"; 25/09: "lookup frontend: i/o timeout").
// Trong docker-compose.yml, SERVER_API_URL=http://lb:8001 — đi thẳng tới bộ cân tải trong mạng
// Docker, không qua DNS ngoài, không qua HTTPS.
//
// Đọc lúc CHẠY chứ không bake lúc build (không có tiền tố NEXT_PUBLIC_): các trang này đều
// force-dynamic. Không đặt biến (vd môi trường khác) thì dùng lại API_URL như trước.
export const SERVER_API_URL = process.env.SERVER_API_URL || API_URL;

/**
 * Header chuyển tiếp cho API khi trang server-render MỞ MỘT HỒ SƠ, để lịch sử "Mở hồ sơ" ghi đúng
 * ai / máy nào (backend/activity.py). Request này đi từ container frontend chứ không phải trình
 * duyệt, nên cookie tên nhân viên, IP thật và trình duyệt phải chép sang tay. Backend chỉ tin
 * x-docs-client-ip khi request đến từ mạng Docker nội bộ.
 *
 * KHÔNG dùng ở trang admin: admin xem hồ sơ không tính là việc của Docs.
 */
export async function staffForwardHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const out: Record<string, string> = {};
  const cookie = h.get("cookie");
  const ip = h.get("x-forwarded-for");
  const ua = h.get("user-agent");
  if (cookie) out["cookie"] = cookie;
  if (ip) out["x-docs-client-ip"] = ip;
  if (ua) out["x-docs-user-agent"] = ua;
  return out;
}
