import type { Metadata } from "next";
import "./globals.css";
import { ConfigBanner } from "@/components/ConfigBanner";

export const metadata: Metadata = {
  title: "Checklist Hồ Sơ Canada",
  description: "Kiểm tra đủ/thiếu hồ sơ giấy tờ định cư Canada",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900 font-sans">
        <ConfigBanner />
        {children}
      </body>
    </html>
  );
}
