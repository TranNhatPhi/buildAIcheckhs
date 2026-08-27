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
// bằng số đo THẬT, KHÔNG đoán. Đo theo số tài liệu: 4 → 39s, 12 → 108s, 20 → 241s.
//
// QUAN TRỌNG — độ dao động rất lớn, đây là điều quyết định cách thiết kế hàm này: đo LẶP LẠI
// 5 lần trên CÙNG 1 hồ sơ (6 tài liệu, nội dung y hệt) ra 46.7s / 68.5s / 89.0s / 108s /
// 186.7s — chênh nhau 4 LẦN. Độ trễ của model reasoning phụ thuộc tải phía DeepSeek và độ dài
// suy luận model tự chọn, không phải hàm xác định theo input.
//
// Vì vậy CỐ Ý KHÔNG khớp công thức chính xác vào các điểm đo lẻ: bản đầu tiên viết theo dạng
// bậc hai khớp được sai số trung bình 2.8% trên 4 điểm — nhưng đó là khớp vào NHIỄU, và tệ hơn
// là khớp trúng lần đo NHANH NHẤT (47s cho 6 tài liệu, trong khi trung vị thật ~89s), nên sẽ
// liên tục báo "sắp xong" rồi bắt nhân viên chờ thêm gấp mấy lần — trải nghiệm tệ hơn hẳn so
// với việc báo lâu hơn thực tế. Giờ dùng dạng TUYẾN TÍNH đơn giản, nhắm vào TRUNG VỊ và
// nghiêng về phía thận trọng (ước lâu hơn): khớp trung vị đo được ở 6 tài liệu (92s vs 89s) và
// ở 20 tài liệu (260s vs 241s).
export function estimateAnalysisSeconds(documentCount: number): number {
  const n = Math.max(1, documentCount);
  return Math.round(20 + 12 * n);
}

// Khoảng dao động quanh ước tính trung vị — hiển thị dạng KHOẢNG ("khoảng 1–3 phút") thay vì
// một con số cụ thể, vì với mức dao động 4 lần đã đo được thì một con số chính xác tới từng
// giây là thông tin SAI LỆCH: nó tạo cảm giác chắc chắn mà dữ liệu thật không hề có. Hệ số
// 0.6–2.0 lấy từ chính khoảng đo lặp lại (46.7s–186.7s quanh trung vị 89s ≈ 0.52–2.1 lần).
export function analysisRangeSeconds(documentCount: number): [number, number] {
  const mid = estimateAnalysisSeconds(documentCount);
  return [Math.round(mid * 0.6), Math.round(mid * 2.0)];
}

// Làm tròn sang phút cho dễ đọc — với sai số hàng chục giây thì hiện "1–3 phút" trung thực hơn
// hẳn "còn 1p 47s" (con số lẻ tới giây ngụ ý độ chính xác không có thật).
export function formatMinuteRange(lowSeconds: number, highSeconds: number): string {
  const toMinutes = (s: number) => Math.max(1, Math.round(s / 60));
  const low = toMinutes(lowSeconds);
  const high = toMinutes(highSeconds);
  return low === high ? `khoảng ${low} phút` : `khoảng ${low}–${high} phút`;
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
