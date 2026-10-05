import type { Metadata } from "next";
import { ContractTemplateDetail } from "@/components/ContractTemplateDetail";

export const metadata: Metadata = {
  title: "Xem mẫu hợp đồng — Checklist Hồ Sơ Canada",
  description: "Xem từng trang mẫu hợp đồng lao động, tải bản Word hoặc PDF.",
};

export default async function MauHopDongChiTietPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContractTemplateDetail id={id} />;
}
