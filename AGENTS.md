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
rút ra từ bộ bản dịch thật trong `hosodichthuat/`: họ tên viết HOA bỏ dấu, cùng một người phải
cùng một tên ở mọi bản (bộ mẫu có tên bố ghi 3 kiểu), không còn chữ tiếng Việt có dấu, số giấy
tờ không lệch 1-2 chữ số, ngày tháng có thật.

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

## Đánh dấu hồ sơ hoàn tất & xoá vĩnh viễn

Trang **Danh sách hồ sơ** có nút **"Hoàn tất"** trên từng thẻ: `Case.completedAt = now`,
`Case.autoDeleteAt = now + CASE_AUTO_DELETE_DAYS` (**14 ngày**, `backend/case_status.py`). Tới
hạn, `case-cleanup` **XOÁ VĨNH VIỄN cả hồ sơ** — thông tin khách hàng, các dòng Document và toàn bộ
file trên MinIO. **Không khôi phục được.** Hộp xác nhận khi bấm và khung đỏ trên trang hồ sơ đều
phải nói rõ điều này.

- **Đã đổi hai lần trong một ngày (25/09/2026) theo yêu cầu nghiệp vụ:** xoá mềm cả hồ sơ → chỉ
  xoá file giữ khách → xoá hẳn như bây giờ. Cột `Case.filesPurgedAt` là di tích của bước giữa,
  hiện không được ghi nữa — để lại cho khỏi phải di chuyển schema.
- **Một hàm xoá cứng duy nhất: `case_delete.hard_delete_case`**, dùng chung cho tiến trình này
  VÀ nút "Xoá vĩnh viễn" trong trang admin. Hai nơi tự viết riêng là có ngày xoá khác nhau.
- **Xoá theo cả thư mục `<case_id>/` trên MinIO** (`storage.delete_prefix`). Nút admin bản cũ đi
  theo `storedPath` nên chỉ xoá file gốc, để sót toàn bộ ảnh từng trang (`<doc_id>-pages/...`) —
  chính là ảnh chụp CCCD/khai sinh, nặng gấp hàng chục lần file gốc (trang 17 MB, gốc 399 KB).
- **MinIO trước, DB sau.** Ngược lại mà MinIO hỏng thì hồ sơ đã mất khỏi DB, không còn gì để biết
  thư mục nào cần dọn. Theo thứ tự này, lỗi thì hồ sơ còn nguyên, vòng sau xoá lại được.
- **Nhật ký email không bị xoá theo** (chỉ lưu caseId dạng chữ, không khoá ràng buộc) — vẫn tra
  lại được đã gửi gì cho hồ sơ đã xoá.
- **Thùng rác (nút "Xoá" của nhân viên) vẫn là xoá mềm, giữ mãi** tới khi admin bấm tay "Xoá
  vĩnh viễn" — chưa có tự động dọn thùng rác.
- **`completedAt` chỉ đổi con số phần trăm**, không đổi sự thật từng mục (`force_complete`).
- Hồ sơ đã hẹn TRƯỚC khi đổi 15→14 ngày giữ nguyên hạn cũ (hạn lưu cứng trong `autoDeleteAt`).

## Trạng thái hồ sơ và quy tắc chuyển

8 trạng thái, chia hai phần — "Hoàn thành" là điểm bàn giao (`STAFF_STATUSES` / `ADMIN_STATUSES`,
khai ở cả `backend/case_status.py` lẫn `lib/application-status.ts`):

| Phần | Mã | Tên hiển thị |
|---|---|---|
| Nhân viên (trang checklist) | `PENDING` | Chờ tiếp nhận |
| | `COLLECTING_DOCUMENTS` | Đang thu thập giấy tờ |
| | `REVIEWING_DOCUMENTS` | Đang kiểm tra hồ sơ |
| | `COMPLETED` | Hoàn thành (tự chuyển khi đủ 100%) |
| Admin (trang quản trị) | `READY_TO_SUBMIT` | Sẵn sàng nộp |
| | `SUBMITTED` | Đang xử lý (trước tên "Đã nộp" — đã nộp, chờ kết quả; gửi email ngay) |
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
- **Admin**: cửa vào duy nhất là Hoàn thành → **Sẵn sàng nộp** (không nhảy thẳng "Đang xử lý").
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
"Đang xử lý" / "Không thành công" (`RESUBMIT_FROM_STATUSES`), và **chỉ một lần**:
`MAX_SUBMISSION_ROUND = 2` (backend + `lib/application-status.ts`) — không có lần nộp thứ 3,
hồ sơ đã ở lần 2 thì ô chọn không còn lựa chọn này và API trả 400. Làm:
- **XOÁ VĨNH VIỄN** mọi file (DB + MinIO `<case_id>/`, kể cả ảnh trang) → 0%;
- `Case.submissionRound += 1` → nhãn "🔁 Nộp lại lần N" (`components/ResubmitBadge.tsx`) cạnh tên
  khách ở danh sách NV, trang hồ sơ, bảng admin, trang thống kê, chi tiết admin;
- trạng thái về "Chờ tiếp nhận"; huỷ Hoàn tất + hẹn tự xoá; xoá số dư tiết kiệm (cả số nhập tay)
  và bản phân tích AI (đều dựa trên file vừa xoá).
- DB commit TRƯỚC, xoá MinIO SAU (lỗi MinIO chỉ để lại file mồ côi, không làm hồ sơ trỏ file mất).

### Tự chuyển "Hoàn thành" theo tiến độ (`case_auto_status.py`)

- **0%** → Chờ tiếp nhận; **trên 0%** mà đang Chờ tiếp nhận (hoặc tụt từ Hoàn thành) → **Đang thu
  thập giấy tờ**; "Đang thu thập" / "Đang kiểm tra" giữ nguyên; **100%** → **Hoàn thành**. Hồ sơ ở
  phần admin (Sẵn sàng nộp trở đi) KHÔNG bị đụng.
- Chọn tay trái quy tắc bị chặn ở `ly_do_khong_chuyen_duoc` (+ bản sao giao diện): "Chờ tiếp nhận"
  khi > 0%, "Đang thu thập" / "Đang kiểm tra" khi 0% — không thì lượt quét mỗi giờ lại đổi về.
- `dong_bo_hoan_thanh(db, case)` gọi sau commit ở mọi endpoint đổi tiến độ: upload, xoá 1 file /
  xoá tất cả, gán tay, phân tích lại (cả nhánh lỗi), sửa hồ sơ, Hoàn tất / bỏ Hoàn tất, khôi phục.
  Thêm endpoint mới làm đổi tiến độ thì gọi nó.
- `PATCH /cases/{id}` mà nhân viên TỰ chọn trạng thái thì tôn trọng, không đồng bộ đè lên.
- Lưới an toàn: `case_cleanup.dong_bo_trang_thai` quét mỗi giờ (bỏ qua hồ sơ có file đang xử lý).

### Thẻ thống kê (`lib/adminCaseFilters.ts`)

"Hồ sơ đã nộp" = Đang xử lý + Được chấp thuận + Không thành công; "Hồ sơ đang xử lý" = trạng thái
"Đang xử lý" (thẻ và ô chọn trùng tên phải đếm cùng một thứ); "Hồ sơ hoàn thành" = trạng thái
"Hoàn thành", không theo % giấy tờ.

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
- **IIS phải giữ Disabled** — Windows cài sẵn IIS giữ cổng 80, bật lại là `lb` chết, mất cả API.
- **Đổi IP máy dev** phải sửa bản ghi A trên Cloudflare. Nên đặt IP cố định bằng DHCP
  reservation trên router.

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

## Thư viện mẫu: hợp đồng lao động (`/mau-hop-dong`), thư xác nhận kinh nghiệm (`/mau-xac-nhan-kinh-nghiem`), phiếu lương (`/mau-phieu-luong`)

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
