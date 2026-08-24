# Checklist Hồ Sơ Canada

Công cụ nội bộ để nhân viên tư vấn kiểm tra nhanh hồ sơ giấy tờ khách hàng (định cư
Canada) đã đủ hay còn thiếu so với danh mục chuẩn. Nhân viên tạo hồ sơ, upload ảnh/PDF
giấy tờ khách hàng; hệ thống tự OCR + phân loại từng file vào đúng mục checklist.

## Kiến trúc

- **Next.js** (`app/`, `components/`) — CHỈ LÀ FRONTEND, gọi thẳng sang backend FastAPI
  qua `NEXT_PUBLIC_API_URL` (không còn API route riêng, không còn Prisma).
- **`backend/`** (Python/FastAPI) — toàn bộ backend: quản lý hồ sơ (case), upload/quản
  lý document, tính đủ/thiếu checklist, lưu file lên MinIO, OCR (Tesseract local), phân
  loại + sửa lỗi OCR (DeepSeek). Có sẵn Swagger UI tại `http://localhost:8001/docs` để
  test API — kể cả `POST /ocr/test` để test riêng OCR không cần tạo case.
- **MySQL** (qua Docker) — lưu thông tin hồ sơ, checklist, metadata document (SQLAlchemy,
  không dùng ORM/migration tool riêng — schema quản lý thủ công qua `backend/models.py`
  + `backend/seed.py`).
- **MinIO** (qua Docker, S3-compatible) — lưu file gốc (ảnh/PDF) khách hàng upload. Xem
  trực tiếp qua console MinIO: `http://localhost:9001`.

OCR (`backend/ocr.py`): tiền xử lý ảnh (deskew, tăng tương phản) rồi đưa qua **Tesseract**
(gói ngôn ngữ `vie`) — đã thử qua PaddleOCR, VietOCR, và tổ hợp PaddleOCR+VietOCR trước đó
nhưng đều "ảo giác" (bịa nội dung) nặng trên giấy tờ thật có ảnh chân dung/watermark/QR
(CCCD); Tesseract cho kết quả bám sát nội dung thật nhất dù đôi khi sai vài ký tự — xem
docstring trong file để biết chi tiết thực nghiệm.

DeepSeek (`backend/classify.py`) dùng 2 bước sau OCR: (1) sửa chính tả + sắp xếp lại câu
— có kèm toạ độ từng dòng để LLM hiểu bố cục — rồi (2) phân loại vào đúng mục checklist.
**Lưu ý:** model cấu hình (`DEEPSEEK_MODEL`) là model có suy luận (reasoning) — với input
càng lộn xộn, model càng mất nhiều thời gian "suy nghĩ" trước khi trả lời (đã quan sát
thực tế >100s cho vài trường hợp). `max_tokens` phải để đủ cao (không cắt ngang lúc đang
suy luận) và dựa vào `timeout` của client làm giới hạn thời gian thực tế.

## Chạy lần đầu

1. Khởi động MySQL + MinIO:
   ```bash
   docker compose up -d
   ```
2. Cài dependency Node cho frontend:
   ```bash
   npm install
   ```
3. Cài Tesseract (hệ thống, không phải pip) + gói tiếng Việt:
   ```bash
   brew install tesseract tesseract-lang
   ```
4. Cài dependency Python cho backend (virtualenv riêng):
   ```bash
   cd backend
   python3 -m venv .venv
   ./.venv/bin/pip install -r requirements.txt
   ```
5. Tạo bảng + seed 29 mục checklist gốc:
   ```bash
   ./.venv/bin/python seed.py
   ```
6. Kiểm tra `.env.local` ở thư mục gốc — `DEEPSEEK_API_KEY` còn hiệu lực, `MINIO_*` khớp
   với `docker-compose.yml`.

## Chạy hằng ngày

Cách nhanh nhất — 1 lệnh chạy cả backend lẫn frontend cùng lúc (Ctrl+C để dừng cả 2):

```bash
./dev.sh
```

Hoặc chạy riêng từng cái nếu muốn xem log tách biệt / restart độc lập:

```bash
# Terminal 1 — Backend FastAPI
cd backend && ./.venv/bin/python -m uvicorn main:app --port 8001

# Terminal 2 — Next.js
npm run dev
```

MySQL/MinIO chạy nền qua Docker, không cần khởi động lại trừ khi máy restart
(`docker compose up -d` để bật lại).

Mở `http://localhost:3000` (hoặc port khác nếu 3000 đang bận, xem log terminal).

- Swagger UI (test API trực tiếp): `http://localhost:8001/docs`
- MinIO console (xem file đã upload): `http://localhost:9001`
- Test riêng độ chính xác OCR (không tạo case, không phân loại): `POST /ocr/test` — vào
  Swagger UI, thử endpoint này với 1 file bất kỳ để xem text + toạ độ + số dòng OCR đọc
  được (JSON). `POST /ocr/test/visualize` trả về 1 ảnh PNG ghép ảnh gốc (trên) + ảnh đã
  tiền xử lý kèm khung đỏ đánh số từng dòng Tesseract nhận diện (dưới) — xem trực tiếp
  vùng nào bị bỏ sót/đọc sai mà không cần đọc JSON.

## Cấu trúc chính

- `backend/models.py` — SQLAlchemy models (Case, ChecklistItem, Document).
- `backend/seed.py` — tạo bảng + 29 mục checklist gốc (chạy lại an toàn, idempotent).
- `backend/completeness.py` — tính đủ/thiếu từng mục, ngưỡng tài chính theo tình trạng
  hôn nhân/số con (đã tính sẵn ở backend nhưng hiện không hiển thị ở giao diện).
- `backend/classify.py` — gọi DeepSeek sửa lỗi OCR + phân loại vào đúng mục checklist.
- `backend/storage.py` — upload/xoá/đọc file trên MinIO (boto3).
- `backend/ocr.py` — tiền xử lý ảnh + OCR bằng Tesseract.
- `backend/routers/` — endpoint FastAPI (cases, case_documents, documents, ocr_test).
- `components/CaseDetail.tsx` — trang chi tiết hồ sơ (upload, checklist, danh sách file,
  xem chi tiết OCR/AI từng file).
