import type { Metadata } from "next";
import { ContractTemplateDetail } from "@/components/ContractTemplateDetail";

export const metadata: Metadata = {
  title: "Xem mẫu thư xác nhận kinh nghiệm — Checklist Hồ Sơ Canada",
  description: "Xem từng trang mẫu thư xác nhận kinh nghiệm, tải bản Word hoặc PDF.",
};

export default async function MauXacNhanKinhNghiemChiTietPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContractTemplateDetail id={id} loai="XNKN" />;
}
