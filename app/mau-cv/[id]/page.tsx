import type { Metadata } from "next";
import { ContractTemplateDetail } from "@/components/ContractTemplateDetail";

export const metadata: Metadata = {
  title: "Xem mẫu CV — Checklist Hồ Sơ Canada",
  description: "Xem từng trang mẫu CV, tải bản Word hoặc PDF.",
};

export default async function MauCvChiTietPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContractTemplateDetail id={id} loai="CV" />;
}
