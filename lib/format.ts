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
// bằng số đo THẬT, KHÔNG đoán.
//
// HIỆU CHỈNH LẠI sau khi backend đổi nhà cung cấp: phân tích chuyên sâu giờ chạy GEMINI
// trước (miễn phí), hết hạn mức mới quay về DeepSeek (xem summarize_case_profile trong
// backend/classify.py). Gemini nhanh hơn HẲN nên công thức cũ (hiệu chỉnh theo DeepSeek:
// 20 + 12n) giờ ước quá lâu — vd 20 tài liệu nó báo ~4 phút trong khi Gemini chạy xong
// trong 38s.
//
// Số đo Gemini (gemini-3.6-flash), 8 hồ sơ thật x lặp 3 lần = 24 phép đo, cột giữa là TRUNG VỊ:
//    n= 2   12.8 / 15.9 / 17.4
//    n= 4   12.0 / 13.7 / 14.8
//    n= 6   20.4 / 22.3 / 22.8
//    n=11   22.3 / 29.9 / 30.0
//    n=12   23.4 / 28.4 / 31.1     (3 hồ sơ khác nhau cùng n=12: trung vị 28.4 / 27.1 / 28.1
//    n=12   25.1 / 27.1 / 30.1      — rất ổn định giữa các hồ sơ, không chỉ giữa các lần đo)
//    n=12   25.8 / 28.1 / 28.4
//    n=20   30.4 / 38.4 / 40.2
// Dao động giữa các lần đo CÙNG hồ sơ chỉ ~1.1-1.35 lần, khác hẳn DeepSeek (đo được tới 4
// LẦN chênh lệch trên cùng input) — nên ước tính lần này đáng tin hơn nhiều.
//
// Vẫn CỐ Ý dùng dạng TUYẾN TÍNH đơn giản, không khớp sát từng điểm: điểm n=4 (13.7s) còn
// NHANH HƠN n=2 (15.9s), tức vẫn có nhiễu, và bài học cũ vẫn đúng — khớp vào nhiễu thì tệ
// hơn ước hơi lệch. 13 + 1.3n bám trung vị tốt ở mọi mức trừ đúng điểm nhiễu đó:
//    n=2 -> 15.6 (đo 15.9)   n=6 -> 20.8 (22.3)   n=12 -> 28.6 (27.9)   n=20 -> 39 (38.4)
export function estimateAnalysisSeconds(documentCount: number): number {
  const n = Math.max(1, documentCount);
  return Math.round(13 + 1.3 * n);
}

// Khoảng dao động — hiển thị dạng KHOẢNG ("khoảng 1–2 phút") thay vì con số chính xác tới
// từng giây, vì con số lẻ tạo cảm giác chắc chắn mà dữ liệu thật không có.
//
// Khoảng này CỐ Ý rộng lệch hẳn về phía trên (0.8x - 4.5x, không đối xứng) vì thời gian giờ
// PHỤ THUỘC NHÀ CUNG CẤP NÀO PHỤC VỤ, mà lúc hiện thanh tiến trình thì chưa biết được:
//   - đường thường gặp (Gemini, còn hạn mức free): sát ước tính, hệ số ~0.8-1.35
//   - đường dự phòng (đã hết cả 4 model x 3 key Gemini -> DeepSeek): chậm hơn ~3-4 lần, đo
//     thật 12 tài liệu mất 108s và 166.7s so với ~28s của Gemini
// Cận trên 4.5x để cả trường hợp rơi về DeepSeek vẫn nằm TRONG khoảng đã báo, thay vì báo
// "sắp xong" rồi bắt nhân viên chờ gấp mấy lần — đúng lỗi đã sửa ở bản trước.
export function analysisRangeSeconds(documentCount: number): [number, number] {
  const mid = estimateAnalysisSeconds(documentCount);
  return [Math.round(mid * 0.8), Math.round(mid * 4.5)];
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
