import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cho phép truy cập dev server qua tunnel cloudflared (subdomain đổi mỗi lần chạy lại
  // tunnel) — không có dòng này thì Next.js chặn cross-origin request tới _next/hmr và
  // các asset dev-only, khiến JS phía client không chạy được (nút bấm không phản hồi).
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
