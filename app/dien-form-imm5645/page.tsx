import type { Metadata } from "next";
import { DienFormImm5645 } from "@/components/DienFormImm5645";

export const metadata: Metadata = {
  title: "Điền form IMM5645e — Checklist Hồ Sơ Canada",
  description: "Điền form Family Information (IMM 5645E) từ giấy tờ trong hồ sơ.",
};

export default function DienFormImm5645Page() {
  return <DienFormImm5645 />;
}
