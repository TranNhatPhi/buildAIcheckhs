# Thiết lập Gmail nhắc trạng thái hồ sơ

Email nhận thông báo mặc định là `documentlncglobal@gmail.com` (không có dấu `\` trước
ký tự `@`). Hệ thống kiểm tra mỗi ngày nhưng mỗi hồ sơ chỉ được gửi lại sau đúng 14 ngày.

## 1. Bật xác minh 2 bước cho Gmail

1. Đăng nhập tài khoản `documentlncglobal@gmail.com`.
2. Mở [Bảo mật Tài khoản Google](https://myaccount.google.com/security).
3. Bật **Xác minh 2 bước** nếu tài khoản chưa bật.

## 2. Tạo mật khẩu ứng dụng

1. Mở [Mật khẩu ứng dụng](https://myaccount.google.com/apppasswords).
2. Nhập tên ứng dụng: `Checklist hồ sơ Canada`.
3. Bấm **Tạo** và sao chép mật khẩu 16 ký tự Google cung cấp.

Không dùng mật khẩu đăng nhập Gmail thông thường. Mật khẩu ứng dụng là bí mật và không được
gửi lên Git hoặc dán vào file nào ngoài `.env.prod` trên máy chủ.

## 3. Khai báo trên máy chủ production

SSH vào VM, mở file cấu hình:

```bash
cd ~/buildAIcheckhs
nano .env.prod
```

Thêm ba dòng sau, thay `16_KY_TU_GOOGLE_CAP` bằng mật khẩu ứng dụng vừa tạo:

```dotenv
GMAIL_SENDER_EMAIL=documentlncglobal@gmail.com
GMAIL_APP_PASSWORD=16_KY_TU_GOOGLE_CAP
STATUS_REMINDER_TO_EMAIL=documentlncglobal@gmail.com
```

Không bọc giá trị trong dấu nháy. Nếu Google hiển thị mật khẩu thành bốn nhóm có khoảng
trắng thì có thể dán nguyên; chương trình sẽ tự bỏ khoảng trắng trước khi đăng nhập SMTP.

## 4. Deploy

```bash
cd ~/buildAIcheckhs
./deploy.sh
```

Deploy sẽ tạo đúng một service `status-reminder`; không đặt việc gửi trong hai replica
backend vì làm vậy có thể gửi trùng email.

## 5. Gửi email kiểm tra

Lệnh này gửi ngay một email kiểm tra và không thay đổi lịch nhắc của bất kỳ hồ sơ nào:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec status-reminder python status_reminder.py --test-email
```

Sau đó kiểm tra hộp thư đến và mục Spam của `documentlncglobal@gmail.com`.

## 6. Kiểm tra nhật ký

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

Nội dung mỗi dòng gồm tên hồ sơ, trạng thái hiện tại, ngày cập nhật trạng thái và liên kết
mở hồ sơ. Sau khi gửi thành công, mốc nhắc tiếp theo được đặt sau 14 ngày. Đổi trạng thái
sẽ bắt đầu lại chu kỳ 14 ngày. Hồ sơ **Đã đậu** hoặc **Đã rớt** sẽ không được gửi nữa.
