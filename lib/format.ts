export const API_URL = process.env.NEXT_PUBLIC_API_URL!;

// Backend trả datetime dạng ISO KHÔNG có hậu tố "Z"/offset (Python isoformat() của datetime
// naive) dù giá trị thực chất luôn là UTC (models.py: default=now_utc) — parse thẳng bằng
// `new Date()` khiến trình duyệt hiểu nhầm là giờ ĐỊA PHƯƠNG, lệch hẳn theo múi giờ (VD lệch
// 7 tiếng ở VN) làm mọi phép tính "đã trôi qua bao lâu" sai hoàn toàn.
export function parseUtcDate(iso: string): Date {
  return new Date(/[Zz]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
}

// Ước tính thời gian xử lý OCR + AI còn lại cho 1 file — CHỈ là ước tính mềm dựa trên số liệu
// đo thật (xem backend/classify.py): correction đã tắt reasoning nên rất nhanh (~2-10s), còn
// bước phân loại (giữ reasoning) dao động rất rộng tuỳ độ khó/mù mờ của tài liệu (đã đo từ
// vài giây đến hơn 200s). Baseline 60s cho 1 trang, cộng thêm cho file nhiều trang (AI phải
// đọc/đối chiếu nhiều nội dung hơn — khớp với cảnh báo "cần phân tích kỹ hơn" đã thêm).
export function estimateProcessingSeconds(pageCount: number | null): number {
  const pages = pageCount ?? 1;
  return Math.round(60 * (1 + 0.5 * Math.max(0, pages - 1)));
}

// Vì đây chỉ là ước tính mềm (thời gian thật có thể lệch nhiều), khi ước tính đã hết mà file
// vẫn chưa xong thì hiện "sắp xong..." thay vì số 0 hoặc số âm — tránh trông như bị đứng/lỗi.
export function formatRemaining(remainingSeconds: number): string {
  if (remainingSeconds <= 3) return "sắp xong...";
  if (remainingSeconds < 60) return `còn khoảng ${remainingSeconds}s`;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return seconds > 0 ? `còn khoảng ${minutes}p ${seconds}s` : `còn khoảng ${minutes} phút`;
}
