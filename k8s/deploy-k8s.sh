#!/bin/bash
# Deploy lên k3s trên VM production. Thay cho ./deploy.sh (bản Docker Compose).
# Chạy từ thư mục gốc repo trên VM: ./k8s/deploy-k8s.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NS=checklist
# Gắn thẻ ảnh theo commit đang deploy, KHÔNG dùng "latest": Kubernetes so sánh tên ảnh để
# biết có gì đổi hay không — mọi lần đều tên "latest" thì `apply` thấy manifest y hệt và
# KHÔNG làm gì cả, code mới xây xong nằm im mà tưởng đã lên.
TAG=$(git rev-parse --short HEAD)

if [[ ! -f .env.prod ]]; then
  echo "!! Không thấy .env.prod ở $(pwd) — chạy script này từ thư mục gốc repo trên VM."
  exit 1
fi

API_DOMAIN=$(grep -E '^API_DOMAIN=' .env.prod | cut -d= -f2)

echo "==> git pull..."
git pull

echo "==> Build ảnh (tag $TAG)..."
docker build -t "checklist-backend:$TAG" ./backend
# NEXT_PUBLIC_API_URL nướng vào bundle lúc build, không phải lúc chạy — xem Dockerfile.
docker build -t "checklist-frontend:$TAG" \
  --build-arg "NEXT_PUBLIC_API_URL=https://${API_DOMAIN}" .

# k3s dùng containerd, KHÔNG dùng Docker — ảnh vừa build nằm trong Docker thì k3s không
# thấy. Phải nạp sang, nếu không pod sẽ chết với ErrImageNeverPull/ImagePullBackOff.
echo "==> Nạp ảnh vào containerd của k3s..."
docker save "checklist-backend:$TAG"  | sudo k3s ctr images import -
docker save "checklist-frontend:$TAG" | sudo k3s ctr images import -

echo "==> Namespace + secret..."
kubectl apply -f k8s/00-namespace.yaml
# Đọc thẳng .env.prod nên không phải chép tay từng biến. Dạng "dry-run | apply" để chạy
# lại được nhiều lần (create thuần sẽ báo AlreadyExists ở lần thứ hai).
#
# sed BỎ DẤU NHÁY BAO NGOÀI — BẮT BUỘC, không phải cho đẹp. Docker Compose tự bỏ nháy khi
# đọc env-file, `kubectl --from-env-file` thì KHÔNG: nó lấy nguyên cả dấu nháy vào giá trị.
# ĐÃ GẶP THẬT khi chạy thử: ADMIN_TOOLS_PASSWORD_HASH trong .env.prod ghi dạng
# '\$2a\$14\$...' nên Caddy nhận chuỗi có kèm nháy, không hiểu là bcrypt, và CHẾT hẳn
# (CrashLoopBackOff, "base64-decoding password: illegal base64 data at input byte 0") —
# tức mất cả 4 domain chứ không chỉ hỏng đăng nhập phpMyAdmin.
#
# /dev/stdin để bí mật không bao giờ rơi xuống file tạm trên đĩa.
sed -E "s/^([A-Za-z_][A-Za-z0-9_]*)=[\"'](.*)[\"']\$/\\1=\\2/" .env.prod \
  | kubectl -n "$NS" create secret generic app-secrets \
      --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -

echo "==> Hạ tầng (config, mysql, minio, phpmyadmin)..."
kubectl apply -f k8s/01-config.yaml -f k8s/02-mysql.yaml -f k8s/03-minio.yaml -f k8s/04-phpmyadmin.yaml
kubectl -n "$NS" rollout status statefulset/mysql --timeout=300s
kubectl -n "$NS" rollout status statefulset/minio --timeout=300s

# Job là BẤT BIẾN — apply đè lên Job cũ sẽ lỗi "field is immutable". Xoá rồi tạo lại.
echo "==> Nạp checklist (Job seed)..."
kubectl -n "$NS" delete job seed --ignore-not-found --wait=true
sed "s|IMAGE_TAG|$TAG|g" k8s/05-seed-job.yaml | kubectl apply -f -
# Thay cho `depends_on: service_completed_successfully` của compose — Kubernetes không có
# khái niệm đó, thứ tự do chính script này giữ.
if ! kubectl -n "$NS" wait --for=condition=complete job/seed --timeout=300s; then
  echo "!! Seed thất bại — DỪNG, không deploy backend với checklist sai."
  kubectl -n "$NS" logs job/seed --tail=50 || true
  exit 1
fi

echo "==> App (backend, frontend, caddy)..."
sed "s|IMAGE_TAG|$TAG|g" k8s/06-backend.yaml  | kubectl apply -f -
sed "s|IMAGE_TAG|$TAG|g" k8s/07-frontend.yaml | kubectl apply -f -
kubectl apply -f k8s/08-caddy.yaml
# Sửa Caddyfile trong ConfigMap không tự làm pod đọc lại — phải ép dựng lại.
kubectl -n "$NS" rollout restart deployment/caddy

# rollout status trả về khác 0 nếu quá hạn -> deploy hỏng là biết NGAY, không báo thành
# công nhầm (đúng tinh thần phần kiểm tra trạng thái ở ./deploy.sh bản compose).
echo "==> Chờ cập nhật xong (không gián đoạn dịch vụ)..."
kubectl -n "$NS" rollout status deployment/backend  --timeout=600s
kubectl -n "$NS" rollout status deployment/frontend --timeout=300s
kubectl -n "$NS" rollout status deployment/caddy    --timeout=300s

echo "==> Trạng thái:"
kubectl -n "$NS" get pods -o wide

echo "==> Kiểm tra health..."
curl -s "https://${API_DOMAIN}/health" && echo "" \
  || echo "!! Backend chưa trả lời — xem log: kubectl -n $NS logs deployment/backend --tail=50"

echo "==> Xong."
