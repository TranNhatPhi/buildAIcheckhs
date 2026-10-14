import type { Metadata } from "next";
import { HoSoHoanThanhChiTiet } from "@/components/HoSoHoanThanh";

export const metadata: Metadata = {
  title: "Hồ sơ hoàn thành — Checklist Hồ Sơ Canada",
  description: "Các file hoàn thành của một hồ sơ: xem, tải, xoá, tải tất cả (ZIP).",
};

export default async function HoSoHoanThanhChiTietPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HoSoHoanThanhChiTiet id={id} />;
}
