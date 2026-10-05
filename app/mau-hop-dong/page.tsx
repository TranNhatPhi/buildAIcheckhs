import type { Metadata } from "next";
import { ContractTemplates } from "@/components/ContractTemplates";

export const metadata: Metadata = {
  title: "Mẫu hợp đồng lao động — Checklist Hồ Sơ Canada",
  description: "Mẫu hợp đồng lao động tương ứng với từng công ty (đơn vị xác nhận kinh nghiệm).",
};

export default function MauHopDongPage() {
  return <ContractTemplates />;
}
