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
