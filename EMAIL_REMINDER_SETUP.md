# Thiết lập EmailJS nhắc trạng thái hồ sơ

Email nhận thông báo được cố định trong template EmailJS là
`documentlncglobal@gmail.com`. Hệ thống kiểm tra mỗi ngày nhưng mỗi hồ sơ chỉ được gửi lại
sau đúng 14 ngày.

## 1. Cấu hình EmailJS

Các giá trị đã tạo trên EmailJS:

```dotenv
EMAILJS_SERVICE_ID=service_jj7v0ik
EMAILJS_TEMPLATE_ID=template_2hsh71j
```

Template phải gửi tới `documentlncglobal@gmail.com` và dùng các biến:

- `{{case_count}}`: số hồ sơ đến hạn nhắc.
- `{{sent_at}}`: thời điểm gửi.
- `{{#cases}} ... {{/cases}}`: danh sách hồ sơ.
- Trong mỗi hồ sơ: `client_name`, `status_label`, `status_color`, `updated_at` và
  `case_url`.

Nên bật **Do not save private data** để EmailJS không lưu tên và trạng thái hồ sơ trong
lịch sử gửi.

## 2. Khai báo trên máy chủ production

Mở **Account → API Keys** trên EmailJS để sao chép Public Key và Private Key. Không gửi
Private Key qua tin nhắn, không đưa vào Git và không bấm **Refresh Keys** nếu chưa cần thu
hồi khóa cũ.

SSH vào VM rồi mở file cấu hình:

```bash
cd ~/buildAIcheckhs
nano .env.prod
```

Thêm bốn dòng sau và thay hai giá trị khóa bằng giá trị lấy trực tiếp từ EmailJS:

```dotenv
EMAILJS_SERVICE_ID=service_jj7v0ik
EMAILJS_TEMPLATE_ID=template_2hsh71j
EMAILJS_PUBLIC_KEY=PUBLIC_KEY_LAY_TU_EMAILJS
EMAILJS_PRIVATE_KEY=PRIVATE_KEY_LAY_TU_EMAILJS
```

Không bọc giá trị trong dấu nháy vì `.env.prod` còn được dùng để tạo Secret khi chuyển
sang k3s.

## 3. Deploy

```bash
cd ~/buildAIcheckhs
./deploy.sh
```

Deploy tạo đúng một service `status-reminder`; không đặt việc gửi trong hai replica backend
vì làm vậy có thể gửi trùng email.

## 4. Gửi email kiểm tra

Lệnh này gửi ngay một email kiểm tra qua EmailJS và không thay đổi lịch nhắc của hồ sơ:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec status-reminder python status_reminder.py --test-email
```

Sau đó kiểm tra hộp thư đến và Spam của `documentlncglobal@gmail.com`, đồng thời kiểm tra
**Email History** trên EmailJS.

## 5. Kiểm tra nhật ký

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  logs status-reminder --tail 100
```

## Lỗi đã gặp

**`RuntimeError: EmailJS trả lỗi HTTP 403: error code: 1010`**

Đây là lỗi của **Cloudflare** đứng trước `api.emailjs.com`, không phải của EmailJS: nó chặn
User-Agent mặc định `Python-urllib/3.9`. Đừng mất công kiểm tra lại key hay template. Đã đo:
cùng một payload, chỉ cần đặt User-Agent bất kỳ khác mặc định là request vào tới EmailJS và
nhận đúng lỗi nghiệp vụ của họ. `status_reminder.py` đã gửi sẵn header
`User-Agent: lnc-status-reminder/1.0` — nếu lỗi này quay lại thì kiểm tra xem header đó có
còn được gửi không.

**`RuntimeError: EmailJS trả lỗi HTTP 404: Account not found`**

Sai `EMAILJS_PUBLIC_KEY`. Đã khoanh vùng bằng cách đo, không phải đoán:

- Bỏ hẳn `accessToken` khỏi request → lỗi đổi thành `400 The parameters are invalid`, tức
  EmailJS còn chưa kiểm tới private key. **Không phải** private key sai.
- Public key thật + `service_id` **rác** → vẫn `Account not found`. Nếu public key hợp lệ thì
  EmailJS đã tìm ra tài khoản và phải báo lỗi về service. Nó trượt ngay ở bước tra `user_id`.
- Public key thật nhận đúng câu trả lời như một chuỗi rác → giá trị đó không khớp tài khoản nào.

Lần đã gặp (07/09/2026), key chỉ sai **đúng một ký tự**: đang dùng `a4rsQiK-a4DVglk7-` (chữ `l`
thường) trong khi key thật là `a4rsQiK-a4DVgJk7-` (chữ `J` hoa). EmailJS không hé lộ gì về
chuyện đó, chỉ nói cụt lủn "Account not found". Nên **copy-paste** key chứ đừng gõ tay lại, và
khi đối chiếu thì so từng ký tự.

Lấy key ở **Dashboard → Account → General → Public Key**. Thử ngay không cần build lại image —
`-e` chỉ ghi đè cho một lần chạy:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -e EMAILJS_PUBLIC_KEY='<key mới>' \
  status-reminder python status_reminder.py --test-email
```

Qua được bước tài khoản thì thông báo lỗi sẽ đổi (sang service hoặc template) — dấu hiệu đã đi
thêm một bước. Chạy được rồi mới ghi vào `.env.prod`.

**Sửa `.env.prod` xong thì BẮT BUỘC dựng lại container.** `docker-compose.prod.yml` truyền biến
qua `environment:` với `${EMAILJS_PUBLIC_KEY:-}`, nên giá trị bị đóng băng vào container lúc nó
được tạo. `docker compose exec` chạy tiến trình mới *bên trong container đang có sẵn* và thừa
hưởng đúng bộ biến đã đóng băng đó — sửa file bao nhiêu lần `exec` cũng không thấy. Đã mất một
vòng lặp vì chuyện này: file ghi `...gJk7-` mà log vẫn in `...glk7-`.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  up -d --force-recreate status-reminder

# Phải in ra a4rsQiK-a4DVgJk7- rồi mới test tiếp
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec status-reminder printenv EMAILJS_PUBLIC_KEY
```

`--force-recreate` an toàn với riêng `status-reminder` vì nó không gắn volume nào. **Đừng** dùng
với `mysql` hay `minio` — hai service đó có ổ đĩa riêng.

## Hai đường gửi email

Cả hai dùng CHUNG một template EmailJS (`EMAILJS_TEMPLATE_ID`) — template nhận `cases` là một
mảng, thông báo tức thì chỉ là mảng một phần tử. Cố ý vậy để khỏi bảo trì template thứ hai.

| | Nhắc định kỳ | Báo tức thì |
|---|---|---|
| Chạy ở | service `status-reminder` | service `backend` (BackgroundTask) |
| Kích hoạt bởi | đủ 14 ngày kể từ lần đổi trạng thái | vừa đổi sang **Đã nộp** hoặc **Cần bổ sung giấy tờ** |
| Code | `backend/status_reminder.py` | `update_case` trong `backend/routers/cases.py` |
| Trạng thái nào | mọi trạng thái chưa Đậu/Rớt | `INSTANT_EMAIL_STATUSES` trong `backend/case_status.py` |

Muốn thêm/bớt trạng thái báo tức thì thì sửa `INSTANT_EMAIL_STATUSES`, không phải sửa router.

Email tức thì gửi ở background nên **không** làm chậm thao tác đổi trạng thái, và **nuốt mọi
lỗi**: EmailJS chết thì trạng thái vẫn lưu bình thường, chỉ có một dòng ERROR trong log backend.
Đó là chủ ý — hồ sơ đằng nào cũng được nhắc lại theo chu kỳ 14 ngày. Xem log:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  logs backend backend2 | grep "đổi trạng thái"
```

Backend cần đủ 4 biến `EMAILJS_*` + `APP_BASE_URL` giống `status-reminder`
(`docker-compose.prod.yml`, khối `x-backend-common`). Thiếu thì đổi trạng thái vẫn chạy, chỉ là
không có email.

## Quy tắc gửi

Email chỉ liệt kê hồ sơ đang ở một trong các trạng thái:

1. Chờ tiếp nhận
2. Đang thu thập giấy tờ
3. Đang kiểm tra hồ sơ
4. Sẵn sàng nộp
5. Đã nộp
6. Đang xét duyệt
7. Cần bổ sung giấy tờ
8. Chờ kết quả

Nội dung mỗi dòng gồm tên hồ sơ, trạng thái có màu tương ứng, ngày cập nhật trạng thái và
liên kết mở hồ sơ. Sau khi EmailJS gửi thành công, mốc nhắc tiếp theo được đặt sau 14 ngày.
Đổi trạng thái sẽ bắt đầu lại chu kỳ 14 ngày. Hồ sơ **Đã đậu** hoặc **Đã rớt** sẽ không
được gửi nữa.
