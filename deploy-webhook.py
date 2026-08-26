#!/usr/bin/env python3
"""
Webhook nghe sự kiện "push" từ GitHub, tự động `git pull && ./deploy.sh` — chạy như 1
container Docker (dịch vụ "deploy-webhook" trong docker-compose.prod.yml), KHÔNG phải
systemd trên host (tài khoản VM không có quyền sudo để cài systemd service). Container này
điều khiển Docker CỦA HOST qua socket mount ("Docker-outside-of-Docker") — không tự chạy
Docker riêng bên trong.

Bảo mật: xác thực chữ ký HMAC-SHA256 (X-Hub-Signature-256) bằng WEBHOOK_SECRET dùng chung với
GitHub — chỉ GitHub (biết secret) mới kích hoạt được deploy thật, không phải bất kỳ ai gọi
được URL này. Chỉ deploy khi push vào nhánh "main", bỏ qua các nhánh/sự kiện khác.
"""
import hashlib
import hmac
import json
import os
import subprocess
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Đường dẫn TUYỆT ĐỐI khớp đúng với đường dẫn thật trên HOST (không phải trong container) —
# bắt buộc cho Docker-outside-of-Docker: lệnh "docker compose" gọi qua socket mount thực thi
# bởi Docker daemon THẬT của host, daemon đó hiểu mọi bind-mount tương đối (vd "./Caddyfile")
# theo hệ thống file CỦA HOST — nếu container này mount repo vào chỗ khác host (vd /repo),
# đường dẫn sẽ lệch và daemon tìm không thấy file. Set qua biến môi trường REPO_DIR trong
# docker-compose.prod.yml, không suy ra từ vị trí file này (khác thư mục sau khi build image).
REPO_DIR = os.environ["REPO_DIR"]
SECRET = os.environ["WEBHOOK_SECRET"].encode()
LOG_FILE = os.path.join(REPO_DIR, "deploy-webhook.log")
PORT = 9090


def verify_signature(body: bytes, signature_header: str) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(SECRET, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature_header)


def run_deploy():
    # LƯU Ý: trước đây 2 lệnh dưới chạy vô điều kiện, không kiểm tra mã thoát — nếu "git pull"
    # lỗi (vd đúng sự cố thật đã gặp: object git trong .git/objects bị tạo bởi user khác,
    # không ghi đè được), code CŨ vẫn chạy tiếp "deploy.sh" với repo CHƯA được cập nhật, khiến
    # code MỚI coi như "đã deploy" trong khi thực ra server vẫn chạy bản CŨ — chỉ phát hiện
    # được nếu tự soi kỹ từng dòng log. Giờ dừng ngay và ghi rõ FAILED nếu git pull lỗi, không
    # âm thầm deploy nhầm bản cũ nữa.
    with open(LOG_FILE, "a") as f:
        f.write(f"\n=== Deploy triggered {datetime.now(timezone.utc).isoformat()} ===\n")
        f.flush()

        pull = subprocess.run(["git", "pull"], cwd=REPO_DIR, stdout=f, stderr=subprocess.STDOUT)
        if pull.returncode != 0:
            f.write(f"\n!!! DEPLOY FAILED — git pull lỗi (exit {pull.returncode}), KHÔNG chạy "
                    f"deploy.sh để tránh âm thầm giữ nguyên bản cũ mà tưởng đã deploy xong.\n")
            return

        deploy = subprocess.run(["bash", "./deploy.sh"], cwd=REPO_DIR, stdout=f, stderr=subprocess.STDOUT)
        if deploy.returncode != 0:
            f.write(f"\n!!! DEPLOY FAILED — deploy.sh lỗi (exit {deploy.returncode}), xem log phía "
                    f"trên để biết bước nào thất bại.\n")
        else:
            f.write(f"\n=== Deploy thành công {datetime.now(timezone.utc).isoformat()} ===\n")


class Handler(BaseHTTPRequestHandler):
    # Timeout đọc socket — nếu 1 kết nối gửi header xong nhưng "treo" không gửi nốt body (hết
    # hạn, lỗi mạng giữa chừng, hay bất kỳ client bất thường nào), tự đóng thay vì giữ mãi.
    timeout = 15

    def _respond(self, code: int, message: bytes):
        self.send_response(code)
        self.end_headers()
        self.wfile.write(message)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if not verify_signature(body, self.headers.get("X-Hub-Signature-256", "")):
            self._respond(401, b"Invalid signature")
            return

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._respond(400, b"Invalid JSON")
            return

        if payload.get("ref") != "refs/heads/main":
            self._respond(200, b"Ignored (not push to main)")
            return

        threading.Thread(target=run_deploy, daemon=True).start()
        self._respond(200, b"Deploy triggered")

    def log_message(self, format, *args):
        pass  # tắt access log mặc định in ra stdout — docker logs sẽ đủ ồn nếu bật lại


if __name__ == "__main__":
    # Container chạy git bằng UID khác chủ sở hữu thư mục trên host (bind-mount) — git 2.35.2+
    # mặc định chặn thao tác trên repo "lạ chủ" (an toàn chống CVE-2022-24765), báo "dubious
    # ownership" thay vì pull. Khai rõ REPO_DIR là an toàn, 1 lần lúc container khởi động.
    subprocess.run(["git", "config", "--global", "--add", "safe.directory", REPO_DIR])

    # ThreadingHTTPServer (không phải HTTPServer thường) — HTTPServer xử lý TỪNG kết nối
    # TUẦN TỰ trên 1 luồng duy nhất, nên 1 request treo (kết nối bất thường không gửi hết
    # body, hoặc container đang mid-restart lúc code webhook tự đổi) làm MỌI request sau đó
    # phải xếp hàng chờ — chính là nguyên nhân nghi vấn cho lỗi timeout GitHub gặp phải lúc
    # test thật đầu tiên (xem "Recent Deliveries" trên GitHub). Threading + timeout ở trên
    # đảm bảo 1 kết nối có vấn đề không chặn các request khác.
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Deploy webhook listening on :{PORT}, REPO_DIR={REPO_DIR}", flush=True)
    server.serve_forever()
