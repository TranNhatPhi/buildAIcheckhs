import type { Metadata } from "next";
import { ContractTemplates } from "@/components/ContractTemplates";

export const metadata: Metadata = {
  title: "Mẫu template CV — Checklist Hồ Sơ Canada",
  description: "Thư viện mẫu CV (Resume) theo từng công ty.",
};

export default function MauCvPage() {
  return <ContractTemplates loai="CV" />;
}
