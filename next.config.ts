import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cho phép truy cập dev server qua tunnel cloudflared (subdomain đổi mỗi lần chạy lại
  // tunnel) — không có dòng này thì Next.js chặn cross-origin request tới _next/hmr và
  // các asset dev-only, khiến JS phía client không chạy được (nút bấm không phản hồi).
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Chỉ ảnh hưởng "next build" (không ảnh hưởng "next dev") — gom output thành 1 thư mục
  // .next/standalone tự chứa node_modules cần thiết, giúp Docker image production nhỏ và
  // gọn hơn nhiều so với copy nguyên node_modules đầy đủ. Dùng cho Dockerfile ở root.
  output: "standalone",
};

export default nextConfig;
