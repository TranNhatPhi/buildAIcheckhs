/**
 * Các thư viện mẫu giấy tờ của Docs — cùng giao diện (components/ContractTemplates.tsx,
 * ContractTemplateDetail.tsx), cùng API /contract-templates, chỉ khác `kind` và chữ hiển thị.
 * Thêm loại mới: thêm một mục ở đây + ở LOAI_MAU (backend/routers/contract_templates.py) + một
 * trang dưới app/ + một link ở Sidebar.
 */
export type LoaiMau = "HDLD" | "XNKN" | "PL";

export interface CauHinhMau {
  kind: LoaiMau;
  /** Đường dẫn trang thư viện; trang xem một mẫu là `${duongDan}/[id]`. */
  duongDan: string;
  /** Tiêu đề trang / tên link ở sidebar. */
  tieuDe: string;
  moTa: string;
  /** Tên dùng giữa câu, viết thường: "Xoá 3 {tenMau} đã chọn?". */
  tenMau: string;
  /** Tên thư viện cho link quay lại: "← Thư viện {tenThuVien}". */
  tenThuVien: string;
  viDuTenMau: string;
  viDuGhiChu: string;
  bieuTuong: string;
  /** Thuộc tính accept của ô chọn file — khớp LOAI_MAU[...]["duoi"] ở backend. */
  accept: string;
  /** Cách gọi các loại file nhận, dùng trong gợi ý / thông báo: "Word (.doc, .docx) hoặc PDF". */
  dinhDang: string;
}

const WORD_PDF = { accept: ".doc,.docx,.pdf", dinhDang: "Word (.doc, .docx) hoặc PDF" };

export const CAU_HINH_MAU: Record<LoaiMau, CauHinhMau> = {
  HDLD: {
    kind: "HDLD",
    duongDan: "/mau-hop-dong",
    tieuDe: "Mẫu hợp đồng lao động",
    moTa: "Thư viện mẫu hợp đồng lao động theo từng công ty — bấm vào mẫu để xem đầy đủ và tải về.",
    tenMau: "mẫu hợp đồng",
    tenThuVien: "mẫu hợp đồng",
    viDuTenMau: "VD: HĐLĐ công nhân nuôi trồng thuỷ sản",
    viDuGhiChu: "VD: dùng cho lao động nông nghiệp, ký năm 2024",
    bieuTuong: "📄",
    ...WORD_PDF,
  },
  XNKN: {
    kind: "XNKN",
    duongDan: "/mau-xac-nhan-kinh-nghiem",
    tieuDe: "Mẫu thư xác nhận kinh nghiệm",
    moTa: "Thư viện mẫu thư xác nhận kinh nghiệm làm việc theo từng công ty — bấm vào mẫu để xem đầy đủ và tải về.",
    tenMau: "mẫu thư xác nhận kinh nghiệm",
    tenThuVien: "mẫu thư XNKN",
    viDuTenMau: "VD: Thư XNKN thợ hàn — bản tiếng Anh",
    viDuGhiChu: "VD: in trên giấy tiêu đề công ty, giám đốc ký và đóng dấu",
    bieuTuong: "📝",
    ...WORD_PDF,
  },
  PL: {
    kind: "PL",
    duongDan: "/mau-phieu-luong",
    tieuDe: "Mẫu phiếu lương",
    moTa: "Thư viện mẫu phiếu lương (file Excel) theo từng công ty — bấm vào mẫu để xem đầy đủ và tải về.",
    tenMau: "mẫu phiếu lương",
    tenThuVien: "mẫu phiếu lương",
    viDuTenMau: "VD: Phiếu lương tháng — công nhân sản xuất",
    viDuGhiChu: "VD: mỗi tháng một sheet",
    bieuTuong: "💵",
    accept: ".xls,.xlsx",
    dinhDang: "Excel (.xls, .xlsx)",
  },
};
