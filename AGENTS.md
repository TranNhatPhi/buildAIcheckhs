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
| Lưu file | MinIO (S3) | Tài liệu gốc + ảnh từng trang PDF. Hạn ngạch 100GB |
| Reverse proxy | Caddy | Prod: HTTPS + 4 tên miền. Dev: cân tải 3 replica backend |

## Đường xử lý một file (đọc kỹ trước khi sửa)

```
upload → OCR → sửa lỗi chính tả → phân loại vào mục checklist → lưu
```

Cả bốn bước chạy ĐỒNG BỘ BÊN TRONG request upload, mất 30–150 giây mỗi file. Đây là
nguyên nhân đã biết của lỗi "Failed to fetch" khi mạng chậm hoặc qua proxy có timeout
ngắn. Tách bước OCR ra chạy nền là việc còn treo, chưa làm.

**Hệ quả thứ hai của việc chạy trong request: khởi động lại backend lúc đang có người upload
là tài liệu KẸT VĨNH VIỄN** ở OCR_RUNNING/CLASSIFYING — request chết, không còn gì cập nhật
lại trạng thái. Đã xảy ra thật: build lại backend đúng lúc nhóm đang upload, 3 file kẹt 43
giờ, trang admin báo "đang phân loại" suốt mà không ai biết. Lưới an toàn: `case-cleanup`
chuyển tài liệu kẹt quá 30 phút (`STUCK_PROCESSING_MINUTES`) sang ERROR để hiện nút "Thử
lại". Tính theo `Document.processingStartedAt` chứ KHÔNG theo `uploadedAt` — bấm "Phân tích
lại" file nộp từ tuần trước thì uploadedAt đã cũ dù file đang chạy thật, dùng nó là bắt nhầm.
Production có thêm chốt chặn riêng: `deploy.sh` từ chối restart khi còn tài liệu đang xử lý.

**Bước phân loại xếp mục THEO TÊN FILE, KHÔNG có AI** (`backend/filename_rules.py`):
quy ước công ty đặt số mục trên checklist giấy ở đầu tên file ("1. ... - Passport.pdf"), và
danh sách mục trên app giữ khớp từng dòng với bản giấy (`backend/seed.py`, nguồn ở `docs/`)
— nên sửa checklist mà làm lệch số là quy tắc xếp nhầm mục. Chữ trong tên file (Passport,
GKS, ĐKKH...) được đối chiếu với số để bắt file đánh số theo bản checklist khác. Tên file
không quyết được thì file về "cần xem lại", kèm lý do, để nhân viên chọn tay — AI phân loại
đã BỎ HẲN theo quyết định của người dùng, đừng thêm lại làm đường dự phòng. OCR và bước sửa
lỗi chính tả giữ nguyên. Vẫn gọi AI một lượt nhẹ để đọc ngày hết hạn/số giấy tờ/chủ giấy
tờ (không chọn mục) — bỏ đi là cảnh báo hạn và đối chiếu chéo ngừng chạy.

**Thứ tự nhà cung cấp AI — mọi bước đều theo đúng thứ tự này:**
`GEMINI trước` (nhiều key × nhiều model, dùng hạn mức miễn phí) → hết suất mới về
`DeepSeek` (tốn tiền). Riêng OCR thì DeepSeek không đọc được ảnh, nên sau Gemini là
`PaddleOCR-VL` (chạy trên GPU của máy dev, compose riêng ở `C:\buildAIcheckhs\paddleOCRVl`)
rồi mới tới `Tesseract`. PaddleOCR-VL CHỈ bật khi có `PADDLE_OCR_VL_URL` — production không
khai nên vẫn là Gemini → Tesseract như cũ. Chất lượng tiếng Việt của nó chưa đo trên giấy tờ
thật, nên đứng sau Gemini; đo xong muốn cho lên trước thì đặt `PADDLE_OCR_VL_FIRST=1`. Xem
`backend/llm.py`, `backend/ocr.py`, `backend/paddle_ocr_vl.py`.

Mỗi file còn có nút **"Đọc lại bằng PaddleOCR-VL"** (`POST /documents/{id}/reclassify?engine=paddle`,
tham số `ocr_engine` của `ocr.extract_text`) cho nhân viên tự chọn khi bản đọc tự động sai chữ.
Nó BỎ HẲN Gemini chứ không chỉ đảo thứ tự: nguồn đứng trước đọc xong thì nguồn sau không còn
trang nào để đọc (`_fill_missing_pages`), nên để Gemini ở lại là bấm nút không có tác dụng gì.
Tesseract vẫn giữ làm lưới cuối cho trang PaddleOCR-VL đọc không nổi. Nút chỉ hiện khi
`GET /config` báo `hasPaddleOcrVl` — máy chủ không có service này thì hiện nút chỉ để báo lỗi.
Mọi kiểm tra phải xong TRƯỚC khi endpoint đặt `status="OCR_RUNNING"`: trả lỗi sau đó là
document kẹt vĩnh viễn ở trạng thái "đang đọc", không có tiến trình nền nào gỡ ra.

## Trang "Kiểm tra dịch thuật" (`/translation-check`)

Nhập họ tên (bắt buộc) + gửi cả bộ bản dịch tiếng Anh (.doc/.docx/.pdf/ảnh) -> báo cáo lỗi.
Bấm tên file ở bất kỳ đâu trong kết quả là mở khung xem chữ app đọc được, tô vàng đúng chỗ bị
báo lỗi, kèm nút mở file gốc. File gốc lưu trên MinIO ở `translation-checks/<id>/<stt>.<đuôi>`
— KHÔNG có bảng DB nào trỏ tới chúng, và **tự xoá HẲN sau 7 ngày**
(`TRANSLATION_CHECK_RETENTION_DAYS`, do service `case-cleanup` quét mỗi giờ).

Kết quả mỗi lượt được cất luôn thành `translation-checks/<id>/result.json`, và trang đưa
`?id=<checkId>` lên thanh địa chỉ — nên **F5 không mất báo cáo**, gửi link cho đồng nghiệp họ
cũng mở được đúng báo cáo đó. Cất bản JSON chứ không chạy lại: chạy lại tốn vài phút OCR và
có thể ra kết quả khác. File này nằm cùng thư mục nên hết hạn theo đúng cùng một lượt dọn. Xoá cứng chứ
không xoá mềm như hồ sơ: đây là file tạm để soát một lượt, không có bảng DB nào đánh dấu
"đã xoá" được, mà giữ lại là giấy tờ tuỳ thân của khách nằm mãi trên MinIO. Tuổi file lấy từ
`LastModified` của MinIO — id lượt kiểm tra là uuid4 nên không suy ra thời gian được. KHÔNG
dùng lifecycle rule của MinIO vì nó tính theo NGÀY và hết hạn lúc nửa đêm UTC, tức "1 ngày"
thực tế là 24-48 giờ.
KHÔNG lưu gì vào DB, KHÔNG dùng AI — toàn bộ là quy tắc trong `backend/translation_check.py`,
rút ra từ bộ bản dịch thật trong `hosodichthuat/`: họ tên bỏ dấu (viết HOA hay thường đều được —
đã bỏ cảnh báo "Họ tên chưa viết HOA" 07/10/2026 theo yêu cầu Docs), cùng một người phải
cùng một tên ở mọi bản (bộ mẫu có tên bố ghi 3 kiểu), số giấy tờ không lệch 1-2 chữ số, ngày
tháng có thật. ĐÃ BỎ (07/10/2026, Docs yêu cầu, vì báo oan): "Còn chữ tiếng Việt có dấu" (PDF
dịch thuật công chứng kèm cả phần tiếng Việt — bản gốc, lời chứng) và "Không thấy tên chủ giấy tờ"
(có giấy không nhắc tên chủ, PDF scan đọc không ra tên). Tên chủ giấy tờ chỉ còn báo khi bản dịch
CÓ ghi mà ghi KHÁC tên theo tên file.

Tên được đọc THEO TỪNG DÒNG để lấy cả chữ đứng trước nó (Father, Householder, Mother...) — nhờ
vậy báo lỗi nói rõ tên đó là của ai thay vì chỉ liệt kê tên trơn, và mức độ mới quyết được:
hai tên na ná nhau mà CÙNG vai trò thì chắc chắn sai (ERROR), khác vai trò thì chỉ cảnh báo vì
có thể là hai người thật sự khác nhau — bộ mẫu có hai anh em tên gần giống nhau, báo đỏ là sai.

"Chủ hộ" được tra tiếp ra là AI qua dòng "Relationship with the householder" của CT07 ("Son" =>
chủ hộ là bố hoặc mẹ), vì tên chủ hộ trong CT07 thường chính là tên bố/mẹ ở giấy khai sinh — bỏ
bước này thì tên bố ghi lệch giữa CT07 và GKS chỉ bị coi là "hai người khác nhau" và lọt lưới
khi bộ hồ sơ không có LLTP để ghi thẳng chữ "Father". Chữ "Grandson"/"in-law" bị loại trước vì
"grandson" có chứa "son" — đoán ẩu ở đây là báo đỏ oan cho ông cháu cùng họ. File `.doc` đời cũ đọc bằng `antiword` (có trong
image backend). Chưa đối chiếu với bản gốc tiếng Việt — chỉ so với tên nhập vào và giữa các bản
dịch với nhau.

## Những chỗ dễ sai — đã trả giá để biết

- **Pydantic trong container là Python 3.9, không viết được `datetime | None`.** Cú pháp PEP
  604 đó chỉ có từ 3.10; Pydantic dựng model ngay lúc import nên backend CHẾT THẲNG lúc khởi
  động với "unsupported operand type(s) for |". Dùng `Optional[...]`, hoặc thêm
  `from __future__ import annotations` đầu file như `schemas.py` đã làm. `python` trên máy dev
  là 3.11 nên chạy thử ngoài container KHÔNG phát hiện ra.
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
- **Hạn ngạch MinIO đặt bằng service `minio-init`, không phải trong code.** `mc quota set` là
  API quản trị riêng của MinIO, boto3/S3 gọi không được — nên phải chạy bằng chính image MinIO.
  Hạn ngạch nằm trong DỮ LIỆU MinIO, dựng lại volume là mất, vì vậy service đó chạy lại mỗi
  lần `docker compose up`. Hiện là **100GiB**; con số này phải KHỚP với dung lượng ổ thật (và
  với `storage:` trong `k8s/03-minio.yaml`) — ổ nhỏ hơn hạn ngạch thì ổ đầy trước và hạn ngạch
  thành vô nghĩa, đúng cái nó sinh ra để tránh. Đo 23/09/2026: 2,8GB / 1.199 object, trung bình
  **154 MB mỗi hồ sơ** -> 100GB đủ khoảng 650 hồ sơ. Gần một nửa dung lượng đang là file của hồ
  sơ ĐÃ XOÁ khỏi DB (xoá hồ sơ không xoá file trên MinIO).
- **Thứ gì có ổ đĩa riêng thì không nhân bản.** MySQL/MinIO luôn 1 bản. Nhân đôi bằng
  `replicas` sẽ tạo ổ đĩa rỗng thứ hai và làm hỏng dữ liệu âm thầm.
- **Thêm replica backend thì PHẢI sửa `BACKEND_REPLICAS`.** Mỗi container thấy đủ số CPU của
  cả máy (compose không giới hạn cgroup), nên tự nó mở số tiến trình Tesseract theo số nhân
  đó; `ocr.py` chia lại cho `BACKEND_REPLICAS` để tổng không vượt số nhân thật. Quên sửa là
  3 replica × 36 = 108 tiến trình Tesseract tranh nhau 72 nhân — không hỏng hẳn, chỉ chậm đi
  và rất khó lần ra. Đã kiểm: 3 replica × 24 = 72, đúng bằng số nhân.
- **Đừng commit `package-lock.json` sinh ra từ `npm install` trên Windows.** Lockfile đó
  vẫn còn entry `lightningcss-linux-x64-musl`, nhìn không thấy gì sai, nhưng `npm install`
  trong `node:25-alpine` lại không cài gói đó nữa → `next build` chết với "Cannot find
  module '../lightningcss.linux-x64-musl.node'", tức build Docker frontend hỏng cả local
  lẫn production. Đã tái hiện: cùng Dockerfile, lockfile bản git thì cài đủ, bản Windows
  ghi lại thì thiếu. Lỡ chạy rồi thì `git checkout -- package-lock.json`.
- **Đừng ghi nội dung dự án vào `CLAUDE.md`** — `next dev` ghi đè toàn bộ file đó. Viết vào
  chính `AGENTS.md` này, phía dưới marker `END:nextjs-agent-rules`.

## Sao lưu CSDL (dịch vụ `db-backup`, 13/10/2026)

`ops/backup-db.sh` chạy trong container `mysql:8.4`: mỗi giờ kiểm tra hôm nay (giờ VN) đã có bản sao lưu
chưa, chưa thì `mysqldump` -> `./backups/canada_checklist-YYYY-MM-DD_HHMM.sql.gz` trên ổ máy chủ, giữ 30
ngày (BACKUP_RETENTION_DAYS). Chỉ giữ file có dòng "-- Dump completed" (sh không có pipefail). Không hẹn
giờ ban đêm vì máy chủ tắt mỗi tối. `backups` nằm trong `.dockerignore` (frontend build từ thư mục gốc).
CHỈ có MySQL — file giấy tờ trên MinIO KHÔNG được sao lưu ở đây.

Khôi phục TOÀN BỘ (ghi đè dữ liệu hiện tại — dừng backend trước):
    gzip -cd backups/<file>.sql.gz | docker compose exec -T mysql mysql -uroot -p<ROOT_PW> canada_checklist
Lấy lại MỘT hồ sơ: khôi phục vào CSDL tạm (`CREATE DATABASE thu_khoi_phuc` rồi nạp file vào đó), chép
dòng `Case` (+ `Document` nếu file MinIO còn) sang canada_checklist bằng INSERT ... SELECT, rồi DROP CSDL
tạm. Đã thử khôi phục vào CSDL tạm 13/10/2026: mọi bảng khớp số dòng, tiếng Việt nguyên vẹn.

## Đánh dấu hồ sơ hoàn tất & tự xoá FILE

Trang **Danh sách hồ sơ** có nút **"Hoàn tất"** trên từng thẻ: `Case.completedAt = now`,
`Case.autoDeleteAt = now + CASE_AUTO_DELETE_DAYS` (**14 ngày**, `backend/case_status.py`). Tới hạn,
`case-cleanup` **CHỈ XOÁ FILE** (`case_delete.purge_case_files`): mọi file trên MinIO (gốc + ảnh từng
trang) và các dòng Document; **GIỮ hồ sơ khách**, ghi `filesPurgedAt` (trang hồ sơ hiện "File đã xoá
ngày …"), bỏ `autoDeleteAt`. File xoá rồi không khôi phục được.

- **Xoá file làm % giảm (14/10/2026, Docs yêu cầu).** Hồ sơ thường tự giảm vì % tính lại từ giấy tờ.
  Hồ sơ ĐÃ Hoàn tất bị ép 100% nên `case_auto_status.bo_hoan_tat_neu_tut` (gọi ở xoá 1 file, "Xoá file đã
  chọn" và "Xoá tất cả") so tiến độ THẬT trước/sau khi xoá: giảm thì TỰ BỎ Hoàn tất (completedAt +
  autoDeleteAt = NULL, lịch sử CASE_UNCOMPLETE "Tự bỏ Hoàn tất…") rồi trạng thái lùi theo %; xoá file không
  tính vào % (mục tuỳ chọn, file thừa) thì giữ Hoàn tất.

- **Lịch sử quy tắc:** 25/09/2026 đổi hai lần (xoá mềm cả hồ sơ -> chỉ xoá file -> xoá HẲN cả hồ sơ).
  **13/10/2026** tiến trình xoá hẳn 2 hồ sơ (Võ Thị Diễm Hương, Nguyễn Hoàng Long — cả thông tin khách,
  không có bản sao lưu nên mất luôn); Docs yêu cầu: "xoá là xoá file thôi, profile vẫn giữ" -> quay
  về chỉ xoá file. Đổi lại quy tắc này PHẢI hỏi người dùng và nói rõ hồ sơ nào sắp bị ảnh hưởng.
- `case_delete.hard_delete_case` (xoá hẳn cả hồ sơ) giờ CHỈ còn nút "Xoá vĩnh viễn" của admin trong
  thùng rác. Xoá theo CẢ thư mục `<case_id>/` (ảnh từng trang không có cột nào trỏ tới). MinIO trước,
  DB sau.
- **Nhật ký email không bị xoá theo** (chỉ lưu caseId dạng chữ).
- **Thùng rác (nút "Xoá" của nhân viên) vẫn là xoá mềm, giữ mãi** tới khi admin bấm tay "Xoá vĩnh viễn".
- **`completedAt` chỉ đổi con số phần trăm**, không đổi sự thật từng mục (`force_complete`).

## Công tắc "Đã gửi nguồn" (08/10/2026)

Trang hồ sơ có công tắc dưới ô "Cập nhật trạng thái": `POST /cases/{id}/sent-to-source` (bật) /
`DELETE` (tắt). Lưu `Case.sentToSourceAt` + `sentToSourceBy` (tên cookie `docs_staff`); bật lại khi
đang bật giữ mốc cũ. Danh sách hồ sơ hiện nhãn xanh "📤 Đã gửi nguồn dd/mm". Có trong mọi DTO hồ sơ
qua `case_status_fields`. Không đổi trạng thái. Bật thì hồ sơ RA KHỎI diện "7 ngày chưa cập
nhật" (`thong_bao.ngay_chua_cap_nhat` trả None): hết thẻ vàng ở danh sách, hết dòng ở chuông, không
tính vào thẻ admin. Từ 12/10/2026 cũng hết nhắc "đơn vị XNKN quá 7 ngày" (DON_VI_KN — khung đỏ
trong trang hồ sơ + chuông): `thong_bao.ho_so_qua_han` lọc bỏ hồ sơ có `sentToSourceAt`.
"Nộp lại lần N" xoá dấu này. Lịch sử: SOURCE_SENT / SOURCE_UNSENT.

## Trang "Tách file PDF / Word gốc" (`/tach-file`, 13/10/2026)

Một file scan gộp nhiều giấy tờ -> từng file, tên theo quy ước `"<số mục>. <Họ tên> - <loại>.pdf"`.
Logic `backend/tach_file.py`, API `routers/split_tool.py`, giao diện `components/TachFile.tsx`.
- PHẢI chọn hồ sơ: số mục = vị trí trong checklist ÁP DỤNG cho hồ sơ (dùng chung
  `filename_rules._checklist_numbers`). Nhãn ngắn (Passport, ID Card, CT07, GKS, Photo, LLTP số 2)
  hoặc tên mục bỏ "(nếu có)" — mỗi nhãn được KIỂM TRA TRỎ NGƯỢC bằng `filename_rules.match_by_filename`
  (`tach_file.nhan_file`), nên upload file đã tách vào hồ sơ là vào đúng mục (đã thử 186/186 mục).
- Nhận PDF / Word / ảnh / **ZIP** (`chuan_bi_pdf` -> `FileGhep`): ZIP giải nén, mọi PDF/Word/ảnh xếp theo
  tên (số tự nhiên: "2." trước "10."), ghép thành 1 PDF; file loại khác/hỏng bỏ qua và báo lại. Trang đầu
  mỗi file gốc được ghi "(BẮT ĐẦU FILE GỐC: tên)" trong prompt — gợi ý ranh giới + loại giấy.
- Chữ từng trang: lớp chữ PDF nếu có, trang scan mới OCR (gom thành 1 PDF phụ -> `ocr.extract_text`,
  tách lại theo dòng "--- Trang N ---").
- Chia trang: DEEPSEEK trực tiếp (Docs yêu cầu, không qua chuỗi Gemini), JSON `segments`; kết quả ép về
  đoạn liên tiếp phủ đủ trang (`chuan_hoa_doan`). DeepSeek lỗi thì mỗi trang 1 dòng "chưa xác định" —
  không chặn. Nhân viên sửa trang/mục trên giao diện; ZIP tách theo bảng GỬI LÊN, không theo AI.
- OCR trang scan PHẢI `try_harder=True` (CCCD chèn trang A4 đọc mặc định ra RỖNG) và lớp chữ PDF chỉ
  được tin khi phần lớn là từ thật (`lop_chu_dung_duoc` — máy scan hay chèn lớp chữ rác). Đo trên file
  gộp 50 trang thật (Hồ Sỹ Hội): thiếu 2 điều này AI gán sai 9/50 trang; có đủ + các quy tắc gộp trong prompt
  (phiếu lương nhiều tháng = 1 file, biên lai IOM theo giấy khám, sổ đỏ đứng tên bố mẹ vẫn là mục QSDĐ)
  -> 50/50 trang đúng mục, ~70 giây.
- BƯỚC DUYỆT: mỗi file có nút "✓ Duyệt" (chỉ duyệt được khi đã chọn mục; sửa trang/mục là mất duyệt).
  "Đưa N file đã duyệt vào hồ sơ": lấy từng file qua `POST /split-tool/{job}/file` (tên ở header
  X-File-Name, cùng hàm đặt tên với ZIP) rồi upload qua ĐÚNG `POST /cases/{id}/documents` — chống trùng,
  OCR, xếp mục theo tên file, ghi lịch sử như upload tay. File trùng tên file đã có trong hồ sơ sẽ THAY
  bản cũ (quy tắc upload sẵn có) — giao diện đánh dấu trước "Trùng tên — sẽ thay bản cũ".
- F5 KHÔNG MẤT VIỆC (14/10/2026, cả 2 trang tách): `lib/luuTam.ts` — file đã chọn ở IndexedDB (Blob, file scan
  vài chục MB không vừa localStorage), hồ sơ đã chọn + bảng kết quả (jobId, đoạn, đã duyệt) ở localStorage, khoá
  riêng mỗi trang ("tach-file:*" / "tach-ban-dich:*"). Bảng kết quả chỉ khôi phục khi lượt còn trên máy chủ (thử
  GET trang 1); "Tách file khác" / "Bỏ hết" xoá. Thử bằng Playwright thật: chọn file + hồ sơ, tách, duyệt -> F5
  đều còn. Mọi thao tác lưu nuốt lỗi (ẩn danh / chặn lưu trữ thì chỉ là không nhớ).
- CHẠY NỀN (14/10/2026): `POST /split-tool` chỉ kiểm tra + lưu source.pdf/meta.json rồi trả NGAY 202 `jobId`;
  đọc chữ + DeepSeek chạy sau (`BackgroundTasks` -> `_chay_tach`) và ghi `result.json` lên MinIO (backend nào
  trả lời cũng được). Giao diện hỏi `GET /{job}/result` mỗi 3 giây (202 đang chạy / 200 xong / 400 hỏng / 410 quá
  30 phút = gián đoạn), nhớ lượt ở localStorage `<trang>:dangTach` -> F5 / tắt trang rồi mở lại vẫn chờ tiếp đúng
  lượt. Nút "⏹ Dừng tách file" -> `POST /{job}/cancel` ghi cancel.json; `_chay_tach` kiểm tra trước đọc chữ và
  trước DeepSeek (bước đọc chữ đang dở thì chạy nốt). Đo thật (Playwright): F5 giữa chừng -> vẫn ra 9 trang → 3
  file; Dừng -> backend log "nhân viên bấm Dừng", không gọi DeepSeek.
- NHIỀU FILE (14/10/2026): `RoUpload` CỘNG DỒN — chọn / thả thêm lần nữa là thêm vào danh sách (trùng tên +
  dung lượng + ngày sửa thì bỏ qua), có nút "+ Thêm file", hiện tổng MB và chặn > 80MB trước khi gửi. Backend vẫn
  gói nhiều file thành một ZIP và ghép theo thứ tự tên file.
- Sửa 14/10/2026 theo file bản dịch Trần Văn Hùng 32 trang (GKS bị cắt sang "CMND"):
  (1) `lop_chu_dung_duoc` loại thêm lớp chữ RÁC "trông như chữ": ký tự lạ `* $ & # { } + €…` ≥1,5% hoặc từ lẫn
  chữ-số kiểu "Nguy6n"/"cu6c" ≥5% (đo: trang tốt ≤0,7% / ≤3,1%) -> OCR đọc lại từ ảnh. Bộ Word sạch Hồ Sỹ Trọng
  vẫn 34/34 trang dùng lớp chữ. (2) `loai_trang` nhận trang lời chứng TRƯỚC tỉ lệ dấu, trên chữ đã bỏ dấu + cụm
  tiếng Anh "Certification of Translator" (lời chứng hỏng mã hoá dấu bị tưởng là trang dịch). (3) Giấy KHÔNG CẦN
  DỊCH nằm nguyên bản gốc giữa các bộ (CCCD, sổ tiết kiệm…): AI được thấy ĐỦ mục (ghi `[không cần dịch]`, trước
  đây bị lọc bỏ nên CCCD bị ép vào "CMND cũ"), `theo_cau_truc(…, khong_dich)` giữ chỗ cắt quanh đoạn AI gán mục
  không cần dịch. (4) OCR `_cuu_trang_trong` (ocr.py): trang < 150 ký tự sau 5 biến thể -> thử median / thu nhỏ
  ~200 DPI (bản sao GKS nền chấm: 20 -> 1000+ ký tự). Kết quả: file 32 trang đúng 11/11 bộ; bộ 49 trang cũ vẫn 9/9.
- DeepSeek chia trang: `max_tokens` tính CẢ phần model nghĩ — 16.000 từng bị nghĩ hết -> nội dung RỖNG ("AI trả
  về nội dung không đúng định dạng", file 32 trang, 14/10/2026). Giờ `TOKEN_CHIA_TOI_DA = 64000` + thử lại 1 lần
  khi rỗng / finish=length. Nút "🔄 Tách lại" ở đầu bảng kết quả: bỏ kết quả, tách lại ngay đúng file + hồ sơ.
- File tạm `tach-file/<job>/` xoá sau 24 giờ
  (`case_cleanup.don_tach_file`). Lịch sử: SPLIT_FILE / SPLIT_ZIP.

## Trang "Tách hồ sơ dịch thuật PDF / Excel" (`/tach-ban-dich`, 13/10/2026)

CÙNG code với trang Tách file gốc — `<TachFile banDich />`, API `POST /split-tool` với `loai=dich`
(lưu vào meta.json của lượt, nên `/file` và `/zip` tự biết). Khác biệt:
- Nhận thêm Excel (.xls/.xlsx, LibreOffice -> PDF); trang gốc vẫn từ chối Excel (cả trong ZIP).
- Tên file thêm đuôi `" - translated"` như bộ mẫu `hosodichthuat/`: "4. Hồ Sỹ Trọng - CT07 - translated.pdf".
- Prompt thêm `tach_file.QUY_TAC_BAN_DICH` (trang lời chứng / công chứng / bản sao tiếng Việt đi kèm
  thuộc CÙNG bản dịch) và AI chỉ thấy các mục CẦN dịch (`needsTranslation`); ô chọn mục vẫn đủ.
- Có bước DUYỆT như trang gốc, nhưng "Đưa N file đã duyệt vào HỒ SƠ HOÀN THÀNH" (`POST
  /split-tool/{job}/to-final`) — KHÔNG vào giấy tờ hồ sơ thô (bản dịch sẽ khớp cùng mục với bản gốc và bị
  cộng vào tiến độ / "Hồ sơ dịch thuật: N trang"). Vẫn tải ZIP được ("<Họ tên> - tach ban dich.zip").

## Tab "Danh sách hồ sơ hoàn thành" (`/ho-so-hoan-thanh`, 13/10/2026)

KHO RIÊNG các bản dịch đã duyệt: bảng `FinalDocument` (tạo bằng create_all trong seed), file ở MinIO
`<caseId>/hoan-thanh/<id>.pdf`, API `routers/final_docs.py` (`/final/cases`, `/final/cases/{id}`, `/zip`,
`/final/files/{id}` xem/tải/xoá). Trùng tên file trong cùng hồ sơ -> THAY bản cũ. Danh sách chỉ gồm hồ sơ có
≥1 file; trang chi tiết xếp file theo số mục checklist. Nằm TRONG thư mục hồ sơ nên xoá vĩnh viễn hồ sơ và
tự xoá FILE 14 ngày sau "Hoàn tất" (`purge_case_files`, xoá cả dòng FinalDocument) cũng dọn luôn — trang
chi tiết báo trước ngày xoá. Lịch sử: FINAL_ADD / FINAL_DELETE / FINAL_ZIP.
CHECKLIST (13/10/2026): `final_docs._checklist` chạy ĐÚNG `compute_checklist_summary` của hồ sơ thô với file
hoàn thành giả làm giấy tờ (cùng mục, thứ tự, luật "1 trong 2"); dùng lại `ChecklistSection` (thêm prop
`nhanMo` / `phuLuc`: mục không cần dịch hiện mờ "Không cần dịch", dưới mục liệt kê file). Tiến độ ("Bản dịch
x/y mục") CHỈ tính mục BẮT BUỘC CẦN DỊCH — hộ chiếu, căn cước... không bao giờ có bản dịch.
NGUỒN THỨ HAI (13/10/2026): nút "📋 Chép hồ sơ tiếng Anh sang hồ sơ hoàn thành" ở trang hồ sơ thô (cạnh
"Tải hồ sơ tiếng Anh") -> `POST /final/cases/{id}/copy-english`: CHÉP (không chuyển) mọi file thuộc mục
`needsTranslation = False` — hồ sơ thô KHÔNG đổi gì. Giữ nguyên định dạng (ảnh thẻ vẫn .jpg — cột
`FinalDocument.mimeType`, key MinIO theo đuôi file gốc; mọi chỗ đọc file dùng `storedPath`). Trùng tên ->
thay, nên bấm lại không nhân đôi. Lịch sử FINAL_COPY.
TÊN FILE TIẾNG ANH, KHÔNG DẤU (14/10/2026): mọi file đưa vào hồ sơ hoàn thành (chép tiếng Anh + bản dịch đã duyệt)
đặt lại tên `"<số mục>. <Họ tên không dấu> - <tên giấy tiếng Anh>"` — `ten_tieng_anh.py`, theo ĐÚNG quy ước bộ
mẫu `docs/test` ("Birth certificate", "Criminal record certificate No2", "Certificate of employment", "Letter of
re-offer", "Saving book"...; bảng TEN_TIENG_ANH, thêm mục mới vào seed thì thêm vào đây). Tên file gốc đúng dạng
"<số>. <Họ tên> - <loại>" thì GIỮ họ tên trong đó (CCCD bố ghi tên bố) + loại chung ("ID Card"); không có họ tên
(bản dịch tách ra, "0. Phiếu thông tin - gửi lại") thì tên khách + loại cụ thể ("Father's ID Card"). Ô "Giấy tờ
khác" đặt tên riêng -> DeepSeek dịch (max_tokens 1000: model nghĩ trước, 40 token ra RỖNG), lỗi thì bỏ dấu.
Bản dịch KHÔNG còn đuôi " - translated" (giống bộ mẫu). Trang tách bản dịch báo "Mục đã có file" theo MỤC.

Trang tổng quan admin — 11 thẻ theo thứ tự (14/10/2026): Tổng hồ sơ, Số nguồn, Chờ tiếp nhận, Đang thu thập giấy tờ,
Hoàn thành, Đã sẵn sàng nộp, CP đang xử lý, Nộp lần 2, Đậu, Rớt, Thanh lý (bộ lọc mới choTiepNhan / dangThuThap). ĐÃ BỎ
thẻ "7 ngày chưa cập nhật", "Chưa có kết quả", và "Hồ sơ đã nộp", "Cần review" và "Ngày lăn tay" (14/10/2026 — bộ lọc daNop / canReview / lanTay vẫn ở trang
Thống kê, cột Ngày lăn tay vẫn ở bảng). Cũng ĐÃ BỎ biểu đồ "Tiến độ hồ sơ (% hoàn thành)" và "Nhãn hồ sơ" (admin yêu cầu
13/10/2026) — còn "Hồ sơ theo nguồn" và "Hồ sơ theo trạng thái". API vẫn trả `casesByTag`.
- CẤU TRÚC MỘT BỘ (Docs 13/10/2026): trang DỊCH (tiếng Anh) → trang CÔNG CHỨNG ("Tôi, … cam đoan đã
  dịch chính xác…") → BẢN GỐC tiếng Việt; LLTP số 2 và phiếu lương KHÔNG cần trang công chứng
  (`can_cong_chung`, regex theo tên mục -> `needsNotary` trong items DTO). `loai_trang` đoán loại từng trang
  bằng tỉ lệ chữ có dấu/từ (dịch ≤0,08, công chứng ~0,53, gốc ≥0,62 -> ngưỡng 0,25; xét "dịch" TRƯỚC từ khoá vì
  bản dịch thư XNKN có "hereby certify"), gắn nhãn vào prompt, rồi `theo_cau_truc` sửa kết quả AI: BẮT BUỘC
  cắt ở trang dịch đứng sau công chứng/gốc, BỎ chỗ cắt ở trang công chứng/gốc. Chỉ áp khi file bắt đầu bằng
  trang dịch VÀ có trang công chứng/gốc (`co_cau_truc`) — bộ chỉ toàn bản dịch Word thì để AI chia. AI lỗi vẫn
  chia theo cấu trúc (chỉ thiếu mục). Giao diện KHÔNG hiện thành phần Dịch / Công chứng / Bản gốc và
  CÓ nút "Tách trang đầu" / "Gộp với file dưới" (bỏ 13/10, Docs bật lại 14/10/2026);
  API vẫn trả pageKinds / structured nếu sau này cần. Đo 9 bộ thật của Phan Huy Di Đan (`docs/test`, gộp
  1 PDF 49 trang scan, OCR ~100 giây): loại trang 49/49, ranh giới + mục 9/9.
- Lịch sử SPLIT_FILE / SPLIT_ZIP có tiền tố "[Bản dịch]".
- Đo thật với bộ bản dịch Hồ Sỹ Trọng (13 file Word gộp thành 1 PDF 34 trang, không gợi ý tên file):
  13/13 ranh giới + mục đúng, ~6 giây (bản dịch có lớp chữ, không phải OCR).

## Thanh bên trang Docs — 2 nhóm cha (15/10/2026)

`components/Sidebar.tsx` mảng `NHOM`: **Hồ sơ thô** (Danh sách, Tạo mới, Tách file PDF/Word gốc, Mẫu HĐLĐ, Mẫu XNKN,
Mẫu lương; `them: ["/cases/"]` để trang một hồ sơ thuộc nhóm này) và **Hồ sơ hoàn thành** (Danh sách, Tách HS dịch,
Điền IMM5645e, Điền IMM1295e, Mẫu CV). "Kiểm tra dịch thuật" đứng RIÊNG ngoài nhóm (`LINK_RIENG`, dưới 2 nhóm). Bấm tiêu đề nhóm để thu gọn / mở; nhớ ở localStorage "sidebar:thuGon";
trước hydrate luôn mở (tránh lệch HTML). Nhóm chứa trang đang mở tô tím. Thêm trang mới -> thêm vào đúng nhóm.

## Mục "0. Phiếu TT khách hàng" (13/10/2026)

Đứng ĐẦU cả 4 bộ checklist (LOW/HIGH × độc thân/kết hôn): `phieu-tt-khach-hang` (LOW) và
`hs-phieu-tt-khach-hang` (HIGH), order=0, BẮT BUỘC (Docs chọn — 26 hồ sơ tụt 3–5%, 2 hồ sơ đang 100%
lùi về "Đang thu thập"), không cần dịch. Số "0" nhờ numberGroup đặc biệt `NHOM_SO_0 = "so-0"`
(filename_rules + lib/format.ts — hai hàm đánh số PHẢI giống nhau): mục mang số 0 và KHÔNG đẩy số mục
sau, nên file cũ "1. … - Passport" vẫn trỏ đúng. Tên file "0. <Họ tên> - Phiếu TT khách hàng" tự vào mục
(loại `phieu_tt_kh` trong `_KINDS`). 4 file `docs/CHECKLIST - *.md` đã thêm dòng 0.

## "Mục đích đi" của hồ sơ (14/10/2026)

`Case.travelPurpose` = "WORK" (Làm việc, mặc định — mọi hồ sơ cũ) | "TRAVEL" (Du lịch). Chọn ở form tạo hồ sơ +
form "Sửa" (cạnh Số con, `lib/mucDichDi.ts`), hiện trên thẻ danh sách và đầu trang hồ sơ. CHỈ là thông tin —
KHÔNG đổi checklist / % / trạng thái. Lịch sử sửa ghi "mục đích đi".
**Thêm trường cho hồ sơ phải sửa ĐỦ các chỗ dựng DTO** (đã sót 2 lần khi làm trường này): `cases.py` (tạo,
danh sách `c.`, chi tiết `"…": case.`, sửa, các `occupation=case.occupation`) và `admin.py` (danh sách admin).

## Upload file Word / Excel vào hồ sơ (14/10/2026)

Trước đây `ocr.extract_text` coi mọi thứ không phải PDF là ẢNH -> "0. Phiếu thông tin.docx" lỗi "Không nhận dạng
được định dạng ảnh". Giờ `DUOI_VAN_PHONG` (.doc/.docx/.odt/.rtf/.xls/.xlsx/.ods) chuyển sang PDF bằng LibreOffice
(`contract_preview.word_sang_pdf`) rồi đi đường PDF: lưu ảnh từng trang (`ocr.co_anh_trang`, cả upload lẫn "Phân
tích lại"), số trang thật, chữ lấy THẲNG từ file (≥20 ký tự/trang; ít hơn = file chỉ dán ảnh scan -> OCR như PDF).
File gốc giữ nguyên định dạng. Ô chọn file của UploadDropzone nhận thêm .doc/.docx/.xls/.xlsx.

## Tab "Điền form IMM5645e" (`/dien-form-imm5645`, 14/10/2026)

Family Information (IMM 5645E) từ giấy tờ hồ sơ, theo quy tắc `imm5645/yc.txt`. `backend/imm5645.py` +
`routers/imm5645.py` + `components/DienFormImm5645.tsx`; mẫu PDF `backend/mau_form/imm5645e.pdf`.
- Gom chữ (manualCorrectedText > correctedText > ocrText) các file thuộc mục có tên Phiếu TT / cư trú / CT07 /
  căn cước / CMND / khai sinh / kết hôn / ly hôn (phiếu tối đa 14k ký tự, giấy khác 3k) -> DeepSeek (max_tokens 64k,
  thử lại khi rỗng) -> JSON: applicant / spouse / mother / father / children (≤4) / siblings (≤7) + `canhBao` (mâu
  thuẫn giữa các giấy) + `nguon` từng người. Địa chỉ ① CT07 ② CCCD, KHÔNG lấy từ phiếu; nghề nghiệp đương đơn để trống;
  con từ GKS; anh chị em từ phiếu; tên VIẾT HOA không dấu; địa chỉ tiếng Anh. Loại hồ sơ = Worker / Visitor theo
  `travelPurpose`. Ô "đi cùng sang Canada" để trống cho nhân viên chọn.
- Lưu `Case.imm5645Data` (JSON, MEDIUMTEXT) — nhân viên sửa trên bảng rồi Lưu; "Tải PDF" tự lưu trước.
- PDF là form LAI AcroForm + XFA: `dien_pdf` điền CẢ widget PyMuPDF LẪN XFA datasets (Adobe vẽ theo XFA). Tình trạng
  hôn nhân: XFA lưu mã "1".."8", widget hiện chữ. Đo thật hồ sơ Lê Thị Hạnh (9 giấy): 28 giây, đủ 4 người + 1 con + 2
  anh chị em, 7 cảnh báo đúng (tên mẹ GKS khác CCCD, xã CT07 sau sáp nhập khác giấy cũ...).
- THEO FILE MẪU DOCS (`imm5645/2.1 file so khop.pdf` — Hồ Sỹ Hội, bản ảnh đã nộp, 14/10/2026): họ tên Chữ Hoa Đầu Từ
  không dấu; địa chỉ KHÔNG thêm ", Vietnam"; tình trạng "Single"/"Married" (Married không có mã XFA -> lưu nguyên
  chữ); CÓ nghề nghiệp đương đơn (khác yc.txt — làm theo file đã nộp); anh chị em "Older/Younger brother/sister" do
  CODE tính từ giới tính + ngày sinh so đương đơn (`_quan_he_anh_chi_em`); người thân mặc định NO; ngày ký = hôm nay,
  NOTE 1/NOTE 2 chỉ ghi ngày khi đúng là không có vợ/chồng / con. Anh chị em thêm người là con của bố/mẹ trong hộ
  CT07 mà PTTKH sót; địa chỉ con / anh chị em cùng nơi -> địa chỉ CT07 (tên xã mới sau sáp nhập).
- MODEL: bước đọc dùng `deepseek-v4-pro` (`imm5645.MODEL_AI`, đổi qua env IMM5645_DEEPSEEK_MODEL) — Docs yêu cầu 14/10/2026; mọi chỗ khác vẫn `DEEPSEEK_MODEL` (flash). Pro chậm hơn: Hồ Sỹ Hội 98 giây (flash 17 giây), kết quả tương đương.
- FONT: widget ép `text_font="Cour"` (PyMuPDF không có Courier New -> trước vẽ Helvetica), giữ cỡ form (8 / 6,1pt).
- LỌC `kiem_tra` (chạy mỗi lần đọc / lưu / xem / tải): TỰ SỬA nghề nghiệp là ngày/số (lỗi có thật trong file mẫu đã
  nộp: "Ho Sy Giao" occupation "2004-09-17"), bỏ anh chị em trùng đương đơn / trùng nhau; BÁO thiếu tên / ngày sinh /
  tình trạng / địa chỉ / đi cùng, ngày sai dạng / không có thật, bố mẹ hơn < 13 tuổi, Single mà có vợ/chồng... Giao
  diện hiện khung đỏ "Kiểm tra tự động". Hồ Sỹ Hội sau sửa: khớp file mẫu, bắt đúng "Ho Sy Truyen thiếu tình trạng".

## Tab "Điền form IMM1295e" (`/dien-form-imm1295`, 15/10/2026)

Application for Work Permit Made Outside of Canada (IMM 1295E) — làm giống IMM5645. `backend/imm1295.py` +
`routers/imm1295.py` + `components/DienFormImm1295.tsx`; mẫu `backend/mau_form/imm1295e.pdf` (bản gốc `imm1295e/`).
- Giấy tờ: mục Phiếu TT / Passport / căn cước (bỏ CCCD bố mẹ) / CMND / CT07 / kết hôn / ly hôn / bằng (bỏ bảng điểm,
  học bạ) / CV / XNKN / HĐLĐ / chứng chỉ tiếng Anh / GKS. Model `MODEL_AI` = env IMM1295_DEEPSEEK_MODEL, mặc định như
  IMM5645 (deepseek-v4-pro). Hồ Sỹ Hội (10 giấy): 89 giây.
- Dữ liệu PHẲNG (`familyName`, `passportIssue`, `bgRefused`...) + `previousCOR` (≤2) + `occupations` (≤3, mới nhất
  trước). Họ tên theo hộ chiếu, Chữ Hoa Đầu Từ; địa chỉ ① CT07 ② CCCD tách streetName / cityTown / district; số điện
  thoại lưu KHÔNG số 0 đầu, PDF tick "Other" + mã nước 84. Phần việc làm ở Canada (nhà tuyển dụng, LMIA...) AI để
  trống — nhân viên nhập. Loại giấy phép mặc định ELMO (giá trị sẵn trong file mẫu).
- PDF là XFA THUẦN (không có widget, trình duyệt chỉ hiện "Please wait...") -> `dien_pdf` chỉ sửa XFA datasets dưới
  `form1`; ô danh sách lưu MÃ LOVFile đọc từ chính PDF (`_lov`, `quoc_gia()`: Vietnam 270, Japan 207, Korea South
  258...); ô ngày điền kèm ô ẩn YYYY/MM/DD. File gốc có chữ ký chứng thực DocMDP + UR3 -> gỡ `/Perms`, `/V` ô chữ ký,
  `SigFlags` (không gỡ thì Adobe báo tài liệu bị sửa sau chứng thực). API tải PDF là `attachment`; nhân viên mở bằng
  Adobe Reader rồi bấm Validate trong form để tạo mã vạch.
- `kiem_tra`: thiếu ô bắt buộc, ngày sai dạng / không có thật, hộ chiếu hết hạn / hết hạn trước ngày cấp, CCCD không
  12 số, email / SĐT sai, kết hôn thiếu tên vợ chồng, câu lý lịch "Có" thiếu chi tiết, quá độ dài ô (maxChars của
  template, `DO_DAI`), quốc gia không có trong danh sách form, nam giới nhắc hỏi nghĩa vụ quân sự (câu 4), phần việc
  làm ở Canada chưa nhập. Nghề nghiệp là ngày/số -> tự xoá.
- GIAO DIỆN theo ĐÚNG thứ tự + số câu của form (Docs yêu cầu 15/10/2026): mảng `PHAN` -> `Cau` {so, ten, o[]}
  — đầu form (1 UCI, 2 Service in), Personal details 1-11, Languages, Passport 1-4, National ID 1-5, US PR card,
  Contact 1/2/3/6, Intended work 1-6, Education, Employment, Background 1-6; mỗi câu một khối có số câu, ô trái -> phải
  như trên form. Câu cố định (9A, US PR card, địa chỉ cư trú = nhận thư) hiện chữ `ghi`. Thêm ô `serviceIn`.

## "Thông tin lệch nhau giữa các giấy tờ" — nút ✓ Đã check (15/10/2026)

`components/DocChecksPanel.tsx`: mỗi mục lệch có nút "✓ Đã check" -> ẩn ngay, POST `/cases/{id}/conflicts/checked`
{key}. Lưu `Case.conflictsChecked` (JSON list khoá). Khoá = `doc_checks.khoa_bat_nhat` = owner + trường + CÁC GIÁ TRỊ
đang lệch -> upload / sửa file làm giá trị đổi thì mục tự hiện lại. Chi tiết hồ sơ lọc bằng `bo_da_kiem_tra`; lúc lưu
chỉ giữ khoá của điểm lệch còn tồn tại. Ghi nhật ký CONFLICT_CHECKED.

## PP-OCRv5 — đã thử rồi GỠ (15/10/2026)

Docs yêu cầu thử PP-OCRv5 (PaddleOCR 3.6, lang="vi" -> latin_PP-OCRv5_mobile_rec) cạnh Tesseract, đo xong thì yêu cầu GỠ
hẳn (service ppocr, nút so OCR, ppocr_v5.py). Số đo để khỏi thử lại: Phiếu TT .docx 12 trang (chữ gốc làm đáp án) ->
giống 83,7%, giữ 1028/1941 ký tự có dấu, 113 giây CPU — model latin THIẾU chữ dấu chồng (ộ ủ ệ ị ố ữ...): "Huyn",
"L TH HNH". Cùng lỗi mất dấu như lần thử PaddleOCR đời cũ (docstring ocr.py). Không dùng cho tiếng Việt.

## DeepSeek: max_tokens gồm cả phần "nghĩ"

Model `DEEPSEEK_MODEL` (deepseek-v4-flash) NGHĨ trước khi trả lời và phần nghĩ ăn vào `max_tokens`. Đặt thấp là
nội dung trả về RỖNG với finish_reason="length" (ten_tieng_anh: 40 token -> rỗng; tách file 32 trang: 16.000 ->
lúc được lúc rỗng). Mọi lệnh gọi DeepSeek mới phải để trần cao và kiểm tra nội dung rỗng.

## Phần cuối "Giấy tờ khác" — 5 ô trống (14/10/2026)

Cả 4 bản giấy kết thúc bằng "GIẤY TỜ KHÁC" 5 dòng trống (LOW độc thân 33-37, LOW kết hôn 37-41, HIGH độc thân
31-35, HIGH kết hôn đủ 3 con 73-77). `seed._giay_to_khac`: "Giấy tờ khác 1..5 (nếu có)", TUỲ CHỌN (không đổi %),
section "Giấy tờ khác", order 900+ -> luôn đứng cuối, số mục cũ không đổi và số 5 ô tự khớp bản giấy (đã kiểm
cả 4 bộ). Tên ô không chứa loại giấy nên file "<số ô>. <Họ tên> - <tên giấy bất kỳ>" vào thẳng ô theo số.

ĐỔI TÊN Ô THEO HỒ SƠ (14/10/2026): nút "✏️ Sửa tên" cạnh ô trong checklist trang hồ sơ thô ->
`PATCH /cases/{id}/other-doc-names {itemId, name}` (chỉ ô "giay-to-khac-*" cùng skillLevel, tối đa 120 ký tự,
trống = về tên mặc định). Lưu `Case.otherDocNames` (JSON), KHÔNG sửa ChecklistItem (dùng chung mọi hồ sơ) —
`ten_giay_to_khac.ap_vao_case_detail` thay tên vào DTO trả ra (checklist + mục khớp của file); hồ sơ hoàn thành
cũng dùng tên này. Xếp file theo tên file vẫn dùng tên gốc. Lịch sử OTHER_DOC_RENAME.

## Trang "CP đang xử lý" (`/admin/cpprocessing`, 12/10/2026)

Tab riêng ở sidebar admin (`components/AdminCpProcessing.tsx`). Liệt kê hồ sơ trạng thái SUBMITTED
("CP đang xử lý"), không tính hồ sơ đã xoá; nộp lâu nhất lên đầu. Cột: STT | Ngày tiếp nhận (createdAt) |
Tên KH | Ngày nộp | Ngày lăn tay | KQ.
- **Ngày nộp** = `Case.submittedDate` (DATE), admin tự chọn — `PATCH /admin/cases/{id}/submitted-date`.
- **Ngày lăn tay** = CHUNG cột `biometricsDate` với bảng tổng quan. Hai API ngày dùng chung
  `admin._dat_ngay` (lịch sử SUBMIT_DATE_SET / BIOMETRICS_SET).
- **KQ** (hỏi xác nhận) gọi đúng API sẵn có: Đậu -> PATCH trạng thái APPROVED, Rớt -> REJECTED. KHÔNG còn
  "Nộp lại" ở đây (15/10/2026) — chỉ sau khi Rớt, chọn ở trang chi tiết hồ sơ (cùng Thanh lý). Có KQ
  là hồ sơ rời khỏi danh sách — trang chỉ là danh sách việc đang chờ, không phải lịch sử.
- **Số cạnh tab** ở sidebar = `GET /admin/sidebar-counts` (1 câu COUNT, KHÔNG dùng /admin/stats vì
  nặng). Sidebar đếm lúc mở trang + khi có `baoSidebarDemLai()` (adminUi.tsx) — gọi hàm này sau MỌI
  thao tác đổi trạng thái ở trang admin, không thì số đứng yên tới lần mở trang sau.

## Admin đổi trạng thái hồ sơ — CHỈ ở trang chi tiết (14/10/2026)

Bảng tổng quan admin chỉ HIỆN NHÃN trạng thái (admin yêu cầu: tránh lỡ tay đổi nhầm trên bảng dài). Ô đổi
trạng thái + "Nộp lại lần N" = `components/AdminStatusSelect.tsx`, đặt ở trang chi tiết hồ sơ admin
(`/admin/cases/[id]`, nút "Xem"), đổi xong `router.refresh()` + `baoSidebarDemLai()`. Trang "CP đang xử lý" vẫn
chọn KQ Đậu / Rớt / Nộp lại như cũ.

## Cột "Ngày lăn tay" ở bảng hồ sơ trang tổng quan admin (12/10/2026)

Thay cột "Cần review". Ô chọn ngày (input type=date) — đổi là lưu ngay, xoá trắng = bỏ ngày:
`PATCH /admin/cases/{id}/biometrics-date` {biometricsDate: "YYYY-MM-DD" | null} (cần mật khẩu admin).
Lưu `Case.biometricsDate` (DATE), có trong mọi DTO hồ sơ qua `case_status_fields`. Lịch sử: BIOMETRICS_SET.

## Đếm "Hồ sơ dịch thuật: N trang" (12/10/2026)

Trang hồ sơ, cạnh "File đã upload · X trang": tổng trang của file thuộc mục CẦN dịch. Cờ
`ChecklistItem.needsTranslation` do `seed.KHONG_CAN_DICH` đặt mỗi lần seed chạy (sửa danh sách đó,
không sửa DB) — lấy từ ô TÔ VÀNG trong `4th/CHECKLIST - * Edit lần 2.docx`: hộ chiếu, căn cước (mọi
người), ảnh thẻ, khám sức khoẻ, chứng chỉ / xác nhận học tiếng Anh, CV, sổ tiết kiệm + xác nhận số
dư. File chưa khớp mục nào vẫn tính (chưa biết loại = coi như phải dịch). Từng file thuộc mục không
dịch có nhãn "Không cần dịch" (DocumentList). Seed in CANH BAO nếu KHONG_CAN_DICH có id sai.

Nút tải riêng 2 nhóm (13/10/2026): "⬇ Tải hồ sơ dịch thuật thô (N trang)" / "⬇ Tải hồ sơ tiếng Anh (N trang)" =
`GET /cases/{id}/download-all?loai=dich|tieng-anh` — backend lọc theo CÙNG quy tắc trên, hai gói
cộng lại đúng bằng toàn bộ file; không kèm bản phân tích AI; ghi Theo dõi Docs ZIP_DOWNLOAD.

## Công tắc "Đã sẵn sàng nộp" (12/10/2026)

ẨN SAU 1 NGÀY (14/10/2026, Docs yêu cầu): danh sách hồ sơ thô (CaseList) ẩn hồ sơ đã bật công tắc quá 24 giờ (tính
sau hydrate, mốc giờ lấy 1 lần lúc mở trang). GÕ TÌM tên vẫn ra; dòng "Hiển thị N/M" ghi số đã ẩn + nút "Hiện lại".
Chỉ là ẩn trên giao diện — trang admin, thống kê, chuông không đổi.

Trên THẺ hồ sơ ở danh sách Docs (cạnh nút "Hoàn tất"): `POST/DELETE /cases/{id}/ready-to-submit`,
lưu `Case.readyToSubmitAt` + `readyToSubmitBy`. CHỈ bật/tắt BẰNG TAY — bấm Hoàn tất KHÔNG tự bật,
seed KHÔNG tự bật cho hồ sơ đã hoàn tất, tắt được cả khi đang Hoàn tất (Docs yêu cầu). KHÔNG còn là
điều kiện bấm Hoàn tất (13/10/2026, Docs yêu cầu): nút "Hoàn tất" LUÔN bấm được ở mọi mức %, bấm là
hồ sơ lên 100% (force_complete) -> tự sang "Hoàn thành"; hộp xác nhận nói rõ "đang N% — sẽ tính là
100%" khi chưa đủ. KHÔNG phải trạng thái admin
READY_TO_SUBMIT ("Sẵn sàng nộp") — không đổi applicationStatus. "Nộp lại lần N" xoá dấu. Thẻ admin
"Đã sẵn sàng nộp" KHÔNG đếm công tắc này nữa (13/10/2026) — đếm trạng thái READY_TO_SUBMIT. Lịch sử: READY_ON / READY_OFF.

## Trạng thái hồ sơ và quy tắc chuyển

8 trạng thái, chia hai phần — "Hoàn thành" là điểm bàn giao (`STAFF_STATUSES` / `ADMIN_STATUSES`,
khai ở cả `backend/case_status.py` lẫn `lib/application-status.ts`):

| Phần | Mã | Tên hiển thị |
|---|---|---|
| Nhân viên (trang checklist) | `PENDING` | Chờ tiếp nhận |
| | `COLLECTING_DOCUMENTS` | Đang thu thập giấy tờ |
| | ~~`REVIEWING_DOCUMENTS`~~ | ĐÃ GỘP vào "Đang thu thập giấy tờ" 13/10/2026 (LEGACY_STATUS_MAP, seed tự chuyển) |
| | `COMPLETED` | Hoàn thành (tự chuyển khi đủ 100%) |
| Admin (trang quản trị) | `READY_TO_SUBMIT` | Sẵn sàng nộp |
| | `SUBMITTED` | CP đang xử lý (CP = Chính phủ; trước tên "Đã nộp", rồi "Đang xử lý" — đổi 12/10/2026; đã nộp, chờ kết quả; gửi email ngay) |
| | `APPROVED` | Được chấp thuận |
| | `REJECTED` | Không thành công |
| | `LIQUIDATED` | Thanh lý hồ sơ — CHỈ vào từ "Không thành công"; đã thanh lý chỉ trả về được "Không thành công". Có thẻ riêng "Hồ sơ thanh lý" ở tổng quan (thay chỗ thẻ "Giấy tờ đã hết hạn"); thẻ "Rớt" không đếm trùng |

Giữ MÃ cũ dù đổi tên (mã nằm trong DB, nhật ký email). Mã đã bỏ (`UNDER_REVIEW`,
`ADDITIONAL_DOCUMENTS_REQUIRED`, `AWAITING_DECISION`) được `seed.migrate_legacy_statuses` chuyển
sang `SUBMITTED` mỗi lần deploy — bắt buộc, vì `schemas.ApplicationStatus` không còn nhận chúng.

**Chặn ở BACKEND** (`case_status.ly_do_khong_chuyen_duoc`, gọi trong `PATCH /cases/{id}`), trả
400 kèm lý do tiếng Việt. Bản song sinh `statusChangeBlockedReason` ở `lib/application-status.ts`
chỉ để làm mờ lựa chọn trên các ô chọn trạng thái — sửa quy tắc thì sửa CẢ HAI.

- **Hoàn thành** chỉ khi đủ **100%** giấy tờ bắt buộc.
- **Nhân viên** chỉ đổi trong phần của mình và chỉ khi hồ sơ CÒN ở đó; hồ sơ đã sang phần admin
  thì ô trạng thái bị khoá.
- **Admin**: cửa vào duy nhất là Hoàn thành → **Sẵn sàng nộp** (không nhảy thẳng "CP đang xử lý").
- **Sẵn sàng nộp → CHỈ "CP đang xử lý"** (15/10/2026, Docs yêu cầu): không trả về Hoàn thành, không nhảy thẳng tới
  kết quả, không "Nộp lại" — chặn ở `ly_do_khong_chuyen_duoc` (backend, 400) + `statusChangeBlockedReason` /
  `statusOptionsFor` (các lựa chọn khác hiện mờ, không chọn được). Lý do: mất mốc SUBMITTED dùng ghi ngày nộp
  + gửi email. LƯU Ý lịch sử: quy tắc này nằm trong mã nguồn từ 17:40 14/10 nhưng chưa build — phải build + deploy
  thì mới có hiệu lực (đã deploy 15/10).
- **Luồng kết quả** (15/10/2026, Docs yêu cầu): **CP đang xử lý → Đậu hoặc Rớt** (không lùi, không Thanh lý / Nộp lại
  thẳng); **Rớt → Thanh lý hoặc Nộp lại** (`RESUBMIT_FROM_STATUSES = ("REJECTED",)` — trước là SUBMITTED + REJECTED);
  Thanh lý → Rớt vẫn được (gỡ thao tác). Chặn ở backend + bản sao giao diện; ô chọn HIỆN ĐỦ mọi trạng thái, bước không hợp lệ bị bôi mờ kèm lý do (Docs yêu cầu 15/10 — không ẩn). Thử
  13/13 trên hồ sơ tạm (SUBMITTED đặt bằng SQL để không gửi email).
  Admin được **trả về "Hoàn thành"** hồ sơ đã ở phần admin — lối thoát khi nhận nhầm, không có thì
  hồ sơ kẹt vì không bên nào đổi được. Admin không tự đánh dấu Hoàn thành cho hồ sơ còn ở phần NV.
- Nhận diện admin: `admin_auth.is_admin` — header `X-Admin-Password` đúng thì là admin, thiếu/SAI
  thì coi như nhân viên (không báo lỗi). `PATCH /cases/{id}` dùng chung cho cả hai trang.
- Mỗi ô chọn chỉ hiện trạng thái của bên mình (`statusOptionsFor`) + trạng thái hiện tại.
- Tiến độ tính SAU khi áp mọi trường của request (đổi hôn nhân là đổi checklist).
- **Giữ nguyên trạng thái luôn hợp lệ** — sửa tên, ghi chú không bao giờ bị chặn.
- Kiểm thử qua API: tránh đặt `SUBMITTED` (gửi email thật) — đặt bằng SQL.

### "Nộp lại lần N" (`POST /cases/{id}/resubmit`, cần admin)

Không phải trạng thái mà là THAO TÁC — trong ô chọn của admin là option giả `__NOP_LAI__`. Chỉ từ
"CP đang xử lý" / "Không thành công" (`RESUBMIT_FROM_STATUSES`), và **chỉ một lần**:
`MAX_SUBMISSION_ROUND = 2` (backend + `lib/application-status.ts`) — không có lần nộp thứ 3,
hồ sơ đã ở lần 2 thì ô chọn không còn lựa chọn này và API trả 400. Làm:
- **XOÁ VĨNH VIỄN** mọi file (DB + MinIO `<case_id>/`, kể cả ảnh trang) → 0%;
- `Case.submissionRound += 1` → nhãn "🔁 Nộp lại lần N" (`components/ResubmitBadge.tsx`) cạnh tên
  khách ở danh sách NV, trang hồ sơ, bảng admin, trang thống kê, chi tiết admin;
- trạng thái về "Chờ tiếp nhận"; huỷ Hoàn tất + hẹn tự xoá; xoá số dư tiết kiệm (cả số nhập tay)
  và bản phân tích AI (đều dựa trên file vừa xoá).
- DB commit TRƯỚC, xoá MinIO SAU (lỗi MinIO chỉ để lại file mồ côi, không làm hồ sơ trỏ file mất).

### Tự chuyển "Hoàn thành" theo tiến độ (`case_auto_status.py`)

- HOÀN TOÀN theo % (13/10/2026): **≤ 20%** (`NGUONG_CHO_TIEP_NHAN`) → Chờ tiếp nhận; **> 20%, < 100%** →
  Đang thu thập giấy tờ; **100%** → Hoàn thành. Đi cả hai chiều (tụt % thì lùi theo). Hồ sơ ở phần
  admin (Sẵn sàng nộp trở đi) KHÔNG bị đụng.
- Chọn tay trái quy tắc bị chặn ở `ly_do_khong_chuyen_duoc` (+ bản sao giao diện, cùng mốc 20% ở
  lib/application-status.ts) — không thì lượt quét mỗi giờ lại đổi về.
- `dong_bo_hoan_thanh(db, case)` gọi sau commit ở mọi endpoint đổi tiến độ: upload, xoá 1 file /
  xoá tất cả, gán tay, phân tích lại (cả nhánh lỗi), sửa hồ sơ, Hoàn tất / bỏ Hoàn tất, khôi phục.
  Thêm endpoint mới làm đổi tiến độ thì gọi nó.
- `PATCH /cases/{id}` mà nhân viên TỰ chọn trạng thái thì tôn trọng, không đồng bộ đè lên.
- Lưới an toàn: `case_cleanup.dong_bo_trang_thai` quét mỗi giờ (bỏ qua hồ sơ có file đang xử lý).

### Thẻ thống kê (`lib/adminCaseFilters.ts`)

"Hồ sơ đã nộp" = CP đang xử lý + Được chấp thuận + Không thành công; "Hồ sơ CP đang xử lý" = trạng thái
"CP đang xử lý" (thẻ và ô chọn trùng tên phải đếm cùng một thứ); "Hồ sơ hoàn thành" = trạng thái
"Hoàn thành", "Đã sẵn sàng nộp" = trạng thái "Sẵn sàng nộp" — ĐÚNG trạng thái, bấm thẻ chỉ ra hồ sơ ở trạng
thái đó (admin yêu cầu 13/10/2026; 12/10 từng đếm "mọi hồ sơ 100%" và "công tắc Đã sẵn sàng nộp").

## Trang thống kê hồ sơ của admin (`/admin/thong-ke`)

Biểu đồ số hồ sơ tạo mới theo 12 tháng + bảng chi tiết (STT, ngày tạo, khách, người nhận hồ sơ,
nguồn, NV quản lý, sale, trạng thái, % hoàn thành). Bấm bất kỳ thẻ nào ở trang tổng quan admin là
mở trang này với đúng bộ lọc của thẻ; bộ lọc nằm trên thanh địa chỉ (`?nam=&thang=&loc=`).

- **Tiêu chí của thẻ và của bộ lọc khai MỘT chỗ: `lib/adminCaseFilters.ts`.** Thẻ tổng quan đếm
  bằng chính các hàm đó — tự viết lại ở nơi khác là có ngày bấm thẻ "Đã nộp: 5" mở ra bảng 6 dòng.
- **"Nguồn" = cột `partner` có sẵn** (Đối tác / nguồn). Ba cột người phụ trách
  (`receiverName`, `managerName`, `saleName`) là ô chữ tự do có gợi ý (`/cases/receivers|managers|
  sales`), không có bảng nhân viên — gõ lệch một chữ là thành hai người khác nhau khi đếm.
- **Tháng tính theo giờ Việt Nam** (`parseUtcDate`) — backend lưu UTC, tính thẳng theo UTC là hồ
  sơ tạo 0h–7h sáng mùng 1 bị đếm sang tháng trước.
- Biểu đồ vẽ bằng HTML thuần, KHÔNG thêm thư viện: `npm install` trên Windows từng làm hỏng
  build Docker của frontend (xem mục package-lock ở trên).

## Nhiều backend sau load balancer

Dev cục bộ chạy **3 replica** (`backend`, `backend2`, `backend3`) sau service `lb` (Caddy,
`Caddyfile.local`); production chạy **2** (`backend`, `backend2`) sau Caddy chính (`Caddyfile`).
Nhân bản được vì backend KHÔNG giữ trạng thái trong bộ nhớ — mọi thứ lâu dài ở MySQL/MinIO,
không có phiên đăng nhập hay hàng đợi trong RAM.

Những chỗ phải nhớ khi đụng vào:

- **Chỉ `lb` mở cổng 8001 ra máy thật.** Cùng một cổng thì chỉ một container giữ được; để
  `ports` lại ở backend là hai cái kia chết lúc khởi động.
- **`seed` là service RIÊNG, chạy đúng một lần.** Ba replica cùng chạy seed sẽ đua nhau
  upsert/xoá trên cùng bảng. Cả ba đều `depends_on: seed: service_completed_successfully`.
- **Thêm/bớt replica là sửa 3 chỗ cùng lúc**: service trong compose, danh sách
  `reverse_proxy` trong Caddyfile tương ứng, và `BACKEND_REPLICAS`.
- **Load balancer dùng Caddy chứ không phải nginx** vì request upload chạy 30–150 giây và
  file tới 20MB: nginx mặc định cắt ở `proxy_read_timeout` 60s và `client_max_body_size` 1MB,
  quên chỉnh là upload hỏng kiểu khó đoán. Caddy không đặt trần cho hai thứ đó.
- **`GET /health` trả thêm `instance`** = tên container phục vụ request. Có nhiều replica thì
  đó là cách nhanh nhất để biết request rơi vào cái nào mà đọc đúng log.

## Tên miền candoc.info — HTTPS trong mạng văn phòng

Máy dev (`192.168.1.200`) là hệ thống CHÍNH của văn phòng từ 25/09/2026, phục vụ qua
**https://candoc.info** với chứng chỉ Let's Encrypt THẬT (tự gia hạn). Giao diện gọi API ở
**https://candoc.info/api** (Caddy bỏ tiền tố `/api` rồi chuyển cho 3 backend).

- **Chỉ chạy TRONG mạng văn phòng.** DNS của candoc.info nằm ở Cloudflare (nameserver
  `lou`/`ruth.ns.cloudflare.com`, mua ở Nhân Hòa), các bản ghi A trỏ vào `192.168.1.200` và để
  **DNS only (đám mây xám)** — Cloudflare KHÔNG đứng giữa, traffic đi thẳng trong LAN.
- **Chứng chỉ xin bằng DNS-01** qua API Cloudflare (`CLOUDFLARE_API_TOKEN` trong `.env.local`,
  quyền Zone.DNS:Edit + Zone.Zone:Read chỉ cho zone candoc.info). HTTP-01 thông thường KHÔNG
  dùng được vì Let's Encrypt không với tới máy sau NAT. Cần module `caddy-dns/cloudflare` →
  service `lb` build từ `caddy/Dockerfile`, không dùng image `caddy:2-alpine` trơn được.
- **KHÔNG dùng Cloudflare Tunnel / đám mây cam:** Cloudflare cắt mọi request qua proxy ở 100
  giây (lỗi 524), mà upload chạy 30–150 giây vì OCR nằm trong request.
- **Volume `caddy_data` là BẮT BUỘC.** Mất nó thì mỗi lần dựng lại `lb`, Caddy xin chứng chỉ
  mới — Let's Encrypt chỉ cho 5 chứng chỉ trùng tên/tuần, vượt là khoá tên miền cả tuần.
- **`resolvers 1.1.1.1 8.8.8.8` trong khối `tls`.** Đã gặp thật: router nhà mạng nhớ nameserver
  CŨ (zonedns.vn) rất lâu sau khi chuyển, Caddy hỏi qua DNS của Docker → hỏi nhầm chỗ → hết giờ
  chờ → không xin được chứng chỉ.
- **API ở `/api` chung tên miền, KHÔNG ở `api.candoc.info`** (khối đó vẫn giữ, vô hại). Tên
  miền con MỚI phải chờ router từng máy hết nhớ nameserver cũ mới phân giải được — lúc chuyển,
  router còn nhớ zonedns.vn nơi không có bản ghi `api`, dùng nó là cả văn phòng mất API. Chung
  tên miền còn là cùng nguồn gốc, không vướng CORS.
- **Token Cloudflare sai/thiếu là `lb` KHÔNG khởi động được** (module Cloudflare kiểm tra token
  ngay lúc nạp cấu hình) → mất luôn cổng 8001, cả app ngừng. Đổi token thì `caddy validate`
  với token thật trước khi restart.
- **Đường cũ vẫn mở:** `http://192.168.1.200` (IP trần, không HTTPS) và
  `http://192.168.1.200:3000`, `:8001`. `http://candoc.info` tự chuyển sang `https://`.
- **ĐƯỜNG DỰ PHÒNG khi tên miền hỏng: `http://192.168.1.250`** (cổng 80, không HTTPS) — chạy ĐẦY ĐỦ
  từ 12/10/2026: giao diện gọi API bằng đường dẫn tương đối `/api` (NEXT_PUBLIC_API_URL) và khối
  `:80` của Caddyfile.local cũng chuyển `/api` tới backend. Cổng `:3000` (Next.js trực tiếp) KHÔNG
  có `/api` — chỉ xem được trang, bấm nút là hỏng; đừng hướng dẫn ai dùng `:3000`.
- **Sự cố 10/10/2026 — tên miền bị nhà đăng ký Nhân Hòa khoá (verification hold):** nameserver bị
  đổi sang `ns1/ns2.verification-hold.suspended-domain.com` vì chưa xác minh email chủ thể trong 15
  ngày sau khi đăng ký (24/09). DNS trả `127.0.0.1` / SERVFAIL nên cả văn phòng mất app, chỉ máy chủ
  vẫn vào được. Kiểm tra nhanh: `nslookup -type=NS candoc.info a0.info.afilias-nst.info` hoặc RDAP.
  Sửa: xác minh với Nhân Hòa + nhờ trả nameserver về `lou.ns.cloudflare.com`, `ruth.ns.cloudflare.com`.
- **IIS phải giữ Disabled** — Windows cài sẵn IIS giữ cổng 80, bật lại là `lb` chết, mất cả API.
- **Đổi IP máy dev** phải sửa bản ghi A trên Cloudflare. Nên đặt IP cố định bằng DHCP
  reservation trên router.

## Vận hành

**Khởi động lại backend mà không làm hỏng file đang upload (14/10/2026).** Upload đọc chữ + xếp mục
chạy NGAY TRONG request — giết backend giữa chừng là file kẹt "Xử lý bị gián đoạn". Đã xảy ra 13/10 vì
lệnh kiểm tra trước deploy dò nhầm trạng thái `PENDING`/`PROCESSING` (không tồn tại — luôn ra 0). Đúng là
`Document.status IN ('OCR_RUNNING','CLASSIFYING')` (`case_cleanup.TRANG_THAI_DANG_XU_LY`). Backend có
`stop_grace_period: 5m` (uvicorn chờ request đang chạy xong rồi mới thoát); khởi động lại TỪNG backend
một (`docker compose up -d --no-deps backend`, chờ healthy, rồi backend2, backend3) để luôn còn bản phục vụ.
File vẫn bị gián đoạn thì `don_tai_lieu_ket` chuyển LỖI nhưng VẪN xếp mục theo tên file
(`completeness.xep_lai_theo_ten_file`); seed mỗi lần chạy cũng xếp lại file "chưa khớp" theo tên file với
checklist hiện tại (vd file "0. …" nộp trước khi có mục số 0).

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

## Theo dõi Docs — lịch sử thao tác (`backend/activity.py`, tab `/admin/theo-doi`)

- **Nhận diện:** trang Docs chưa có đăng nhập. Nhân viên tự chọn tên ở hộp "Bạn là ai?"
  (`components/StaffIdentity.tsx`, chân sidebar có nút "Đổi người"); tên nằm trong cookie
  `docs_staff` (encodeURIComponent). Cookie tự đi kèm MỌI request cùng tên miền (fetch, upload,
  link tải file/ZIP). KHÔNG phải xác thực — chọn tên người khác vẫn được.
- **Middleware** `main.nhan_dien_nguoi_thao_tac` đọc tên / IP / trình duyệt / có phải admin một lần
  mỗi request, cất vào contextvar. Endpoint chỉ gọi `activity.ghi("MÃ", case=..., detail=...)`
  SAU khi commit. `ghi` dùng phiên DB riêng và không bao giờ ném lỗi.
- **Thêm thao tác mới:** khai mã + nhãn ở `activity.ACTION_LABELS` (giao diện đọc bảng này qua
  API) rồi gọi `activity.ghi` trong endpoint. Tính `detail` cẩn thận — nó chạy NGOÀI try của
  `ghi`, lỗi ở đó là lỗi 500 sau khi thao tác đã lưu.
- "Mở hồ sơ" / "Mở file" gộp 30 / 10 phút cho cùng người; admin xem hoặc không rõ tên thì không ghi.
- Trang server-render mở hồ sơ (`app/cases/[id]`, `.../summary`) chuyển tiếp cookie / IP / UA qua
  `lib/serverApi.staffForwardHeaders`. Trang admin KHÔNG chuyển tiếp (admin xem ≠ Docs làm).
- **IP:** Docker Desktop trên Windows NAT mọi máy thành 172.18.0.1 → IP dải Docker được bỏ trống.
  Trên máy chủ Linux, IP thật tự hiện.
- Tự xoá sau `ACTIVITY_LOG_RETENTION_DAYS` (45) ngày — `case_cleanup.don_nhat_ky`.

## Chuông thông báo (`components/ChuongThongBao.tsx`, `GET /admin/notifications` + `GET /notifications`)

Hồ sơ đã nhập "Đơn vị xác nhận kinh nghiệm" (`Case.experienceUnits`, ngày do máy chủ tự ghi lúc
Tạo/Lưu) mà ngày SỚM nhất + `EXPERIENCE_UNIT_REMINDER_DAYS` (7) ≤ hôm nay (giờ VN) và vẫn còn ở
phần nhân viên (Chờ tiếp nhận / Đang thu thập / Đang kiểm tra = chưa làm xong để gửi nguồn).
Không có "đã đọc": hồ sơ tới "Hoàn thành" là tự biến khỏi chuông. Chuông nằm ở thanh tiêu đề của
cả 4 trang admin, tự làm mới 5 phút/lần.

Loại thứ hai (`kind: "CHUA_CAP_NHAT"`): 7 ngày không có file mới (lần upload gần nhất, chưa có
file thì từ ngày tạo) mà còn thiếu giấy tờ bắt buộc — CÙNG quy tắc với khung nhắc vàng trong
`CaseDetail.tsx` (`NGAY_IM_LANG_CANH_BAO`); sửa thì sửa cả hai. Banner đỏ trong trang hồ sơ chỉ
lấy loại `DON_VI_KN`.
Quy tắc ở MỘT hàm: `thong_bao.ngay_chua_cap_nhat` — dùng cho chuông, cho `CaseListItemDTO.idleDays`
(thẻ "7 ngày chưa cập nhật hồ sơ" ở tổng quan admin + bộ lọc `chuaCapNhat` trang thống kê) và thẻ
vàng ở danh sách Docs. **Chuông ADMIN bỏ loại này** (đã có thẻ riêng); chuông Docs vẫn hiện.

Quy tắc nằm MỘT chỗ: `backend/thong_bao.py` (`ho_so_qua_han`). Trang Docs dùng cùng danh sách
qua `GET /notifications` (router riêng — đặt dưới /cases thì bị `GET /cases/{case_id}` nuốt mất):
chuông ở sidebar Docs (`<ChuongThongBao vaiTro="docs" />`) + banner đỏ trong trang hồ sơ quá hạn
(CaseDetail hỏi đúng danh sách này, không tự tính lại quy tắc 7 ngày).

## Thư viện mẫu: hợp đồng lao động (`/mau-hop-dong`), thư xác nhận kinh nghiệm (`/mau-xac-nhan-kinh-nghiem`), phiếu lương (`/mau-phieu-luong`), CV (`/mau-cv`, kind CV, Word/PDF — 14/10/2026)

Ba thư viện, MỘT bộ code: cùng bảng `ContractTemplate`, cùng API `routers/contract_templates.py`,
cùng component `ContractTemplates` / `ContractTemplateDetail` — phân biệt bằng cột `kind`
(`HDLD` | `XNKN` | `PL`, mẫu cũ DEFAULT 'HDLD'). Mỗi loại nhận đuôi file riêng (`LOAI_MAU[...]["duoi"]`):
HĐLĐ / thư XNKN nhận Word + PDF, phiếu lương CHỈ nhận Excel (.xls/.xlsx) — ảnh xem trước dựng bằng
LibreOffice Calc (+ phông Carlito thay Calibri), cài ở layer riêng trong backend/Dockerfile. API danh sách / thêm / nhập zip / tải zip nhận `kind`
(mặc định HDLD); API theo id không cần. Chữ hiển thị mỗi loại ở `lib/loaiMau.ts`. Lịch sử Theo dõi
Docs dùng chung mã TEMPLATE_*, chi tiết mở đầu bằng `[HĐLĐ]` / `[Thư XNKN]` / `[Phiếu lương]`.
Phần dưới viết cho mẫu hợp đồng nhưng áp dụng y hệt cho hai loại kia.

Bảng `ContractTemplate` (create_all tự tạo) + file trên MinIO `contract-templates/<uuid>.<đuôi>` —
KHÔNG nằm trong thư mục hồ sơ nào nên xoá hồ sơ không xoá theo mẫu. Chỉ nhận .doc/.docx/.pdf ≤ 20MB.
Tên công ty gợi ý từ `GET /cases/experience-units` (đơn vị XNKN đã nhập ở hồ sơ) để sau này nối
mẫu với hồ sơ theo tên. Thêm/xoá ghi vào Theo dõi Docs (TEMPLATE_UPLOAD / TEMPLATE_DELETE).
Giao diện kiểu thư viện mẫu CV: lưới thẻ có ảnh trang đầu, lọc theo công ty; `/mau-hop-dong/[id]`
xem từng trang + tải Word / PDF / in. Ảnh xem trước: `backend/contract_preview.py` — Word -> PDF bằng
LibreOffice không giao diện (cài trong backend/Dockerfile, kèm fonts-liberation thay Times New Roman),
mỗi lần chuyển một hồ sơ LibreOffice riêng (nhiều replica chạy cùng lúc); PDF + `page-N.png` ở
`contract-templates/<id>/`. Lỗi tạo ảnh không chặn việc tải mẫu (`pageCount` NULL, có nút tạo lại).
Mỗi mẫu thuộc DUY NHẤT một công ty (`companyName`); `PATCH /contract-templates/{id}` chọn/đổi công ty =
chuyển hẳn (không có kiểu một mẫu dùng chung nhiều công ty). Ghi lịch sử TEMPLATE_ASSIGN.
Bẫy đã gặp: dòng chấm dùng `PositionalTab` (w:ptab) thì LibreOffice/Google Docs bỏ trống — dùng tab
thường + điểm dừng tab có dấu chấm dẫn.
KHÔNG làm: sinh hợp đồng / thư XNKN / phiếu lương điền sẵn thông tin khách, hoặc nhiều mẫu cố ý khác nhau theo công
ty (giấy tờ nộp IRCC phải do chính công ty lập và ký — xem trao đổi 01/10/2026). Thư viện chỉ LƯU mẫu
nhân viên tải lên.
