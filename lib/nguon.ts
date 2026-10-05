import type { CaseListItemDTO } from "@/lib/client-types";

// Gom hồ sơ theo NGUỒN (ô "Nguồn / đối tác", vd "Ms. Thanh") — dùng CHUNG cho biểu đồ "Hồ sơ theo
// nguồn" (AdminDashboard) và nút "Nhóm theo nguồn" (AdminCaseReport), để hai nơi luôn đếm khớp.
//
// Nguồn là ô tự gõ nên cùng một người có thể bị gõ khác hoa/thường hoặc dư khoảng trắng
// ("Ms. Thanh" / "ms. thanh "): gộp theo dạng chuẩn hoá, hiện tên của cách gõ phổ biến nhất.

export const CHUA_NHAP_NGUON = "Chưa nhập nguồn";

export interface NhomNguon {
  ten: string;
  chuaNhap: boolean;
  cases: CaseListItemDTO[];
}

/** Nhóm nhiều hồ sơ trước; "Chưa nhập nguồn" luôn ở cuối. Trong mỗi nhóm giữ nguyên thứ tự đầu vào. */
export function nhomTheoNguon(cases: CaseListItemDTO[]): NhomNguon[] {
  const nhom = new Map<string, { cases: CaseListItemDTO[]; cachGo: Map<string, number> }>();
  const chuaNhap: CaseListItemDTO[] = [];
  for (const c of cases) {
    const ten = (c.partner ?? "").trim().replace(/\s+/g, " ");
    if (!ten) {
      chuaNhap.push(c);
      continue;
    }
    const khoa = ten.normalize("NFC").toLocaleLowerCase("vi");
    const g = nhom.get(khoa) ?? { cases: [], cachGo: new Map<string, number>() };
    g.cases.push(c);
    g.cachGo.set(ten, (g.cachGo.get(ten) ?? 0) + 1);
    nhom.set(khoa, g);
  }
  const ketQua: NhomNguon[] = [...nhom.values()]
    .map((g) => ({
      ten: [...g.cachGo.entries()].sort((x, y) => y[1] - x[1])[0][0],
      chuaNhap: false,
      cases: g.cases,
    }))
    .sort((x, y) => y.cases.length - x.cases.length || x.ten.localeCompare(y.ten, "vi"));
  if (chuaNhap.length) ketQua.push({ ten: CHUA_NHAP_NGUON, chuaNhap: true, cases: chuaNhap });
  return ketQua;
}
