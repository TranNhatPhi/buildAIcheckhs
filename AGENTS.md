<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# Checklist Hồ Sơ Canada

Công cụ nội bộ cho công ty tư vấn định cư: nhân viên upload giấy tờ của khách, hệ thống
đọc chữ bằng AI, tự phân loại vào đúng mục checklist, và báo còn thiếu gì.

**Mọi comment và văn bản giao diện đều bằng tiếng Việt.** Giữ đúng như vậy khi sửa code.

## Kiến trúc

| Phần | Công nghệ | Ghi chú |
|---|---|---|
| Frontend | Next.js 16 + Tailwind | `app/`, `components/`, `lib/` |
| Backend | FastAPI + SQLAlchemy, Python 3.9 | `backend/` |
| Database | MySQL 8.4 | Schema quản lý TAY, xem bên dưới |
| Lưu file | MinIO (S3) | Tài liệu gốc + ảnh từng trang PDF |
| Reverse proxy | Caddy | Tự lo HTTPS, 4 tên miền |

## Đường xử lý một file (đọc kỹ trước khi sửa)

```
upload → OCR → sửa lỗi chính tả → phân loại vào mục checklist → lưu
```

Cả bốn bước chạy ĐỒNG BỘ BÊN TRONG request upload, mất 30–150 giây mỗi file. Đây là
nguyên nhân đã biết của lỗi "Failed to fetch" khi mạng chậm hoặc qua proxy có timeout
ngắn. Tách bước OCR ra chạy nền là việc còn treo, chưa làm.

**Thứ tự nhà cung cấp AI — mọi bước đều theo đúng thứ tự này:**
`GEMINI trước` (nhiều key × nhiều model, dùng hạn mức miễn phí) → hết suất mới về
`DeepSeek` (tốn tiền). Riêng OCR thì dự phòng là `Tesseract` chạy tại chỗ, vì DeepSeek
không đọc được ảnh. Xem `backend/llm.py` và `backend/ocr.py`.

## Những chỗ dễ sai — đã trả giá để biết

- **Schema DB quản lý bằng tay.** `Base.metadata.create_all()` chỉ tạo BẢNG còn thiếu, KHÔNG
  bao giờ thêm CỘT vào bảng đã có. Thêm `Column` trong `models.py` mà quên khai vào
  `ADDED_COLUMNS` của `backend/seed.py` là production chết ngay ở query đầu tiên với
  "Unknown column".
- **`seed.py` tự chạy mỗi lần deploy** (service `seed` / Job k8s) — đó là nơi đặt cả việc nạp
  checklist lẫn việc thêm cột.
- **`.env.prod` bọc giá trị trong nháy đơn.** Docker Compose tự bỏ nháy, `kubectl
  --from-env-file` thì KHÔNG. Đã làm Caddy chết hẳn và mất cả 4 tên miền một lần.
- **Tesseract ngốn CPU thật** (khác phần gọi Gemini vốn chỉ chờ mạng). Số tiến trình chạy
  song song bị giới hạn bằng semaphore trong `ocr.py`; `os.cpu_count()` trong container trả
  về số vCPU của CẢ NODE chứ không phải hạn mức của container.
- **Thứ gì có ổ đĩa riêng thì không nhân bản.** MySQL/MinIO luôn 1 bản. Nhân đôi bằng
  `replicas` sẽ tạo ổ đĩa rỗng thứ hai và làm hỏng dữ liệu âm thầm.
- **Đừng ghi nội dung dự án vào `CLAUDE.md`** — `next dev` ghi đè toàn bộ file đó. Viết vào
  chính `AGENTS.md` này, phía dưới marker `END:nextjs-agent-rules`.

## Vận hành

Production chạy trên một VM GCP (`instance-20260825-021254`, 8 vCPU / 31 GB).

```bash
cd ~/buildAIcheckhs && ./deploy.sh      # đường deploy ĐANG DÙNG (Docker Compose)
```

Có sẵn bộ manifest k3s trong `k8s/` đã chạy thử thật và `k8s/deploy-k8s.sh`, nhưng
**production hiện KHÔNG chạy trên k8s** — k3s đã cài, các pod hạ về 0. Muốn chuyển sang phải
chạy `k8s/migrate-data.sh` để đồng bộ dữ liệu trước, không được chỉ bật pod lên.

Tên miền: `app.` (giao diện) · `api.` (backend) · `db.` (phpMyAdmin) · `storage.` (MinIO
Console), đều thuộc `lncglobal.io.vn`.

## Quy ước khi sửa code

- Comment giải thích **vì sao**, không phải **làm gì** — nhất là ở những chỗ đã từng sai;
  ghi rõ đã đo được gì để người sau không lặp lại.
- Đo trước khi kết luận về hiệu năng. Repo này có nhiều chỗ phỏng đoán ban đầu đã bị số liệu
  thật bác bỏ.
- Không đưa bí mật vào git. `.env.local` và `.env.prod` đều đã gitignore.
