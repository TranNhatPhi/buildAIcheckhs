// Tải file thật xuống máy (khác với mở xem "Xem file" — link đó dùng
// Content-Disposition: inline nên trình duyệt cố hiển thị thay vì tải). Không thể chỉ thêm
// thuộc tính <a download> vào link gốc vì API ở khác origin với frontend — trình duyệt bỏ
// qua "download" với link cross-origin. Phải fetch về blob rồi tải từ blob URL (cùng origin).
export async function downloadFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Tải file thất bại");
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}
