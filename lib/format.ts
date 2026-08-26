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

// Ước tính thời gian "Phân tích AI chuyên sâu" (nút ở trang Tổng hợp thông tin) — hiệu chỉnh
// bằng số đo THẬT trên hồ sơ thật, KHÔNG đoán. Đo trên 4 hồ sơ (số tài liệu → thời gian thật):
// 4 → 39.0s, 6 → 46.7s, 12 → 108.3s, 20 → 240.8s.
//
// Thời gian tăng theo BÌNH PHƯƠNG số tài liệu, không phải tuyến tính — hợp lý vì việc chính là
// đối chiếu CHÉO: N tài liệu thì có ~N² cặp thông tin phải so với nhau (tên/ngày sinh/địa chỉ
// giữa từng cặp giấy tờ), và đây là model reasoning nên thời gian tỉ lệ với lượng suy luận
// sinh ra. Đã thử cả dạng tuyến tính lẫn các dạng pha trộn: dạng thuần bình phương dưới đây
// khớp sát nhất (sai số trung bình 2.8%, lệch nhiều nhất 6.5% ở hồ sơ nhỏ nhất) — các dạng có
// thêm số hạng tuyến tính đều kém hơn (3.4%) hoặc lệch hẳn ở hồ sơ lớn (8.4%, hụt tới 16.5%).
//
// Lưu ý: với hồ sơ rất nhiều tài liệu (>33), ước tính vượt quá timeout 600s của DeepSeek
// (classify.py) — lúc đó thực tế sẽ báo lỗi timeout chứ không chạy lâu như ước tính.
export function estimateAnalysisSeconds(documentCount: number): number {
  const n = Math.max(1, documentCount);
  return Math.round(28 + 0.53 * n * n);
}

// Thời gian ĐÃ TRÔI QUA (đếm lên) — khác formatRemaining bên dưới là ước tính đếm ngược. Đây
// là con số CHẮC CHẮN ĐÚNG (đo từ mốc thật trong DB), nên vẫn có ý nghĩa cả khi ước tính đã
// lệch: nhân viên luôn biết được đã chờ bao lâu dù phần "còn khoảng..." có sai.
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}p ${rest}s` : `${minutes} phút`;
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
