import type { Metadata } from "next";
import "./globals.css";
import { ConfigBanner } from "@/components/ConfigBanner";
import { IntroOverlay } from "@/components/IntroOverlay";
import { Sidebar } from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Checklist Hồ Sơ Canada",
  description: "Kiểm tra đủ/thiếu hồ sơ giấy tờ định cư Canada",
};

// Bản chạy thật gọi API bằng đường dẫn TƯƠNG ĐỐI "/api" — chỉ Caddy (cổng 80/443) có /api, còn
// cổng 3000 là Next.js trực tiếp nên mở bằng "IP:3000" là mọi nút bấm hỏng ("Không kết nối được
// backend"). Người cũ quen gõ/lưu ":3000" -> tự chuyển sang cùng đường dẫn ở cổng 80, chạy trước
// khi trang kịp gọi API. Dev (npm run dev, API tuyệt đối http://localhost:8001) thì không chuyển.
const API_TUONG_DOI = (process.env.NEXT_PUBLIC_API_URL ?? "").startsWith("/");
const CHUYEN_KHOI_CONG_3000 =
  'if(location.port==="3000")location.replace(location.protocol+"//"+location.hostname+location.pathname+location.search+location.hash)';

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className="h-full antialiased" suppressHydrationWarning>
      {API_TUONG_DOI && (
        <head>
          <script dangerouslySetInnerHTML={{ __html: CHUYEN_KHOI_CONG_3000 }} />
        </head>
      )}
      <body className="min-h-full flex bg-neutral-50 text-neutral-900 font-sans">
        <IntroOverlay />
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <ConfigBanner />
          {children}
        </div>
      </body>
    </html>
  );
}
