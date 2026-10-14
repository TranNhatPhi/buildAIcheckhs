import type { Metadata } from "next";
import { HoSoHoanThanh } from "@/components/HoSoHoanThanh";

export const metadata: Metadata = {
  title: "Hồ sơ hoàn thành — Checklist Hồ Sơ Canada",
  description: "Hồ sơ đã có bản dịch được duyệt ở trang Tách hồ sơ dịch thuật.",
};

export default function HoSoHoanThanhPage() {
  return <HoSoHoanThanh />;
}
