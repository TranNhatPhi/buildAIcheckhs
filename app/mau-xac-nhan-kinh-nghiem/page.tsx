import type { Metadata } from "next";
import { ContractTemplates } from "@/components/ContractTemplates";

export const metadata: Metadata = {
  title: "Mẫu thư xác nhận kinh nghiệm — Checklist Hồ Sơ Canada",
  description: "Mẫu thư xác nhận kinh nghiệm làm việc tương ứng với từng công ty (đơn vị xác nhận kinh nghiệm).",
};

export default function MauXacNhanKinhNghiemPage() {
  return <ContractTemplates loai="XNKN" />;
}
