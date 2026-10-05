import type { Metadata } from "next";
import { ContractTemplateDetail } from "@/components/ContractTemplateDetail";

export const metadata: Metadata = {
  title: "Xem mẫu phiếu lương — Checklist Hồ Sơ Canada",
  description: "Xem từng trang mẫu phiếu lương, tải file Excel hoặc PDF.",
};

export default async function MauPhieuLuongChiTietPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContractTemplateDetail id={id} loai="PL" />;
}
