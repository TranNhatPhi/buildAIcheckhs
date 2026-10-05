import type { Metadata } from "next";
import { ContractTemplates } from "@/components/ContractTemplates";

export const metadata: Metadata = {
  title: "Mẫu phiếu lương — Checklist Hồ Sơ Canada",
  description: "Mẫu phiếu lương (file Excel) tương ứng với từng công ty.",
};

export default function MauPhieuLuongPage() {
  return <ContractTemplates loai="PL" />;
}
