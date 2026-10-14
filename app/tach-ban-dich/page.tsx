import type { Metadata } from "next";
import { TachFile } from "@/components/TachFile";

export const metadata: Metadata = {
  title: "Tách hồ sơ dịch thuật PDF / Excel — Checklist Hồ Sơ Canada",
  description: "Tách một file gộp nhiều bản dịch tiếng Anh thành từng bản dịch, đặt tên đúng quy ước.",
};

export default function TachBanDichPage() {
  return <TachFile banDich />;
}
