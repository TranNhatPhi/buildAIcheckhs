import type { Metadata } from "next";
import { TachFile } from "@/components/TachFile";

export const metadata: Metadata = {
  title: "Tách file PDF / Word gốc — Checklist Hồ Sơ Canada",
  description: "Tách một file scan gộp nhiều giấy tờ thành từng file, đặt tên đúng quy ước để upload vào hồ sơ.",
};

export default function TachFilePage() {
  return <TachFile />;
}
