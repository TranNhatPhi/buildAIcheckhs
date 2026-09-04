#!/bin/bash
# Script redeploy cho VM production — chạy từ thư mục gốc repo trên VM (~/buildAIcheckhs).
# Đây là CÁCH DUY NHẤT để deploy: webhook GitHub (push → tự deploy) đã bị gỡ vì nó phải tự
# dừng chính mình giữa lúc deploy, làm cả cụm container kẹt ở trạng thái "Created" và website
# chết hẳn (xem ghi chú chỗ service deploy-webhook cũ trong docker-compose.prod.yml).
#
# Dùng: ./deploy.sh          (kiểm tra an toàn trước khi restart)
#       ./deploy.sh --force  (bỏ qua kiểm tra, restart bất chấp — chỉ dùng khi chắc chắn)
set -euo pipefail
cd "$(dirname "$0")"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

if [[ ! -f .env.prod ]]; then
  echo "!! Không tìm thấy .env.prod ở $(pwd) — chạy script này từ thư mục gốc repo trên VM."
  exit 1
fi

# Production đã chuyển sang k3s (04/09/2026). Chạy nhầm script này khi k3s đang phục vụ sẽ
# dựng lại cụm Compose song song: container Caddy tranh cổng 80/443 với Caddy của k3s, còn
# mysql/minio thì gắn lại volume Compose CŨ — hai bản dữ liệu cùng chạy, rất khó nhận ra.
#
# Kiểm theo SỐ POD ĐANG PHỤC VỤ, không phải theo "deployment có tồn tại hay không".
#
# Khác biệt này quan trọng: tài khoản trên VM hiện KHÔNG có quyền sudo, nên đường lùi
# "sudo systemctl stop k3s" không dùng được. Đường lùi duy nhất còn lại là hạ replica về 0
# bằng kubectl (không cần sudo) — mà lúc đó deployment caddy VẪN TỒN TẠI. Guard bản cũ chỉ
# hỏi "có tồn tại không" nên sẽ chặn luôn cả lần quay lui hợp lệ, tức tự khoá mất lối thoát.
if command -v kubectl >/dev/null 2>&1; then
  K8S_CADDY_UP=$(kubectl -n checklist get deployment caddy \
    -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)
  if [[ "${K8S_CADDY_UP:-0}" -gt 0 ]]; then
    echo "!! ============================ DỪNG ============================"
    echo "!! Hệ thống đang chạy trên k3s, KHÔNG phải Docker Compose."
    echo "!! Deploy bằng:  ./k8s/deploy-k8s.sh"
    echo "!!"
    echo "!! Muốn CỐ Ý quay lui về Compose thì hạ k8s xuống trước (không cần sudo):"
    echo "!!   kubectl -n checklist scale deployment caddy backend frontend --replicas=0"
    echo "!!   kubectl -n checklist delete svc caddy      # trả lại cổng 80/443"
    echo "!!   kubectl -n checklist scale statefulset mysql minio --replicas=0"
    echo "!! =============================================================="
    exit 1
  fi
fi

# .env.prod có APP_DOMAIN/API_DOMAIN — dùng để gọi qua HTTPS công khai (backend không mở
# port ra host trong docker-compose.prod.yml, chỉ Caddy mới thấy được backend nội bộ).
export API_DOMAIN
API_DOMAIN=$(grep -E '^API_DOMAIN=' .env.prod | cut -d= -f2)

echo "==> Kiểm tra không có hồ sơ/tài liệu nào đang xử lý dở trước khi restart..."
BUSY=$(python3 <<'PYEOF'
import json
import os
import sys
import urllib.request

base = "https://" + os.environ["API_DOMAIN"]

try:
    with urllib.request.urlopen(base + "/cases", timeout=15) as r:
        cases = json.load(r)
except Exception:
    print("!!ERROR!! Không gọi được backend — kiểm tra backend còn sống không.")
    sys.exit(0)

busy = []
for c in cases:
    case_id = c["id"]
    try:
        with urllib.request.urlopen(base + "/cases/" + case_id, timeout=15) as r:
            detail = json.load(r)
    except Exception:
        continue
    case = detail["case"]
    client_name = case.get("clientName", case_id)
    if case.get("aiAnalysisStatus") == "RUNNING":
        busy.append(client_name + ": đang phân tích AI chuyên sâu")
    for doc in case.get("documents", []):
        status = doc.get("status")
        if status in ("PENDING", "OCR_RUNNING", "CLASSIFYING"):
            filename = doc.get("originalFilename", "?")
            busy.append(client_name + " - " + filename + ": đang xử lý (" + status + ")")

print("\n".join(busy))
PYEOF
)

if [[ "$BUSY" == "!!ERROR!!"* ]]; then
  echo "$BUSY"
elif [[ -n "$BUSY" ]] && [[ "$FORCE" -eq 0 ]]; then
  echo "!! Đang có việc xử lý dở, KHÔNG an toàn để restart ngay bây giờ:"
  echo "$BUSY"
  echo ""
  echo "Đợi xử lý xong rồi chạy lại, hoặc chạy './deploy.sh --force' nếu chắc chắn muốn bỏ qua."
  exit 1
elif [[ -n "$BUSY" ]]; then
  echo "!! Có việc đang xử lý dở nhưng chạy với --force nên vẫn tiếp tục:"
  echo "$BUSY"
else
  echo "OK — không có gì đang xử lý dở."
fi

echo "==> git pull..."
git pull

echo "==> Build & restart container..."
# Lấy danh sách service ĐỘNG từ chính file compose (không hard-code) để service mới thêm sau này
# tự động được deploy, không phải nhớ sửa thêm chỗ này.
DEPLOY_SERVICES=$(docker compose -f docker-compose.prod.yml --env-file .env.prod config --services \
  | tr '\n' ' ')
if [[ -z "${DEPLOY_SERVICES// /}" ]]; then
  echo "!! Không đọc được danh sách service từ docker-compose.prod.yml — dừng để tránh deploy nhầm."
  exit 1
fi
echo "    service sẽ deploy: $DEPLOY_SERVICES"
# --remove-orphans: dọn container của service ĐÃ BỊ XOÁ khỏi file compose (vd deploy-webhook
# vừa gỡ) — không có cờ này thì chúng cứ nằm lại chạy mãi bằng image cũ. An toàn vì
# $DEPLOY_SERVICES ở trên đã là TOÀN BỘ service trong file, không sót cái nào để bị dọn nhầm.
# shellcheck disable=SC2086  # cố ý tách từ: đây là danh sách nhiều service, không phải 1 chuỗi
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build --remove-orphans $DEPLOY_SERVICES

# Caddyfile gắn vào container qua bind-mount (không nằm trong image build) — nếu chỉ
# Caddyfile đổi mà docker-compose.prod.yml không đổi, lệnh "up -d" ở trên KHÔNG tự restart
# caddy (Compose không thấy service definition thay đổi). Restart hẳn container (không dùng
# "caddy reload" — đã xác nhận qua thực tế reload có thể báo thành công nhưng vẫn không áp
# dụng đúng config mới) để chắc chắn Caddy đọc lại Caddyfile từ đầu.
echo "==> Restart Caddy để áp dụng Caddyfile mới nhất..."
docker compose -f docker-compose.prod.yml --env-file .env.prod restart caddy

echo "==> Trạng thái container:"
docker compose -f docker-compose.prod.yml ps

# Xác nhận TỪNG service thật sự đang chạy — "docker compose up" có thể kết thúc mà vẫn để lại
# container ở trạng thái "Created"/"Exited" (đã gặp thật trên production: toàn bộ container
# "Created", caddy "Exited", website chết hẳn ERR_CONNECTION_REFUSED), và khi đó các bước sau
# vẫn chạy tiếp như không có gì, khiến sự cố chỉ lộ ra khi người dùng phát hiện web chết.
# Kiểm tra ở đây để hỏng là biết NGAY, kèm mã thoát khác 0 thay vì báo thành công nhầm.
# Service CHẠY MỘT LẦN RỒI THOÁT (không phải service thường trực). Với chúng, "running" là
# SAI kỳ vọng — phải là đã thoát với mã 0. Không tách riêng thì deploy.sh báo DEPLOY FAILED
# mỗi lần deploy dù mọi thứ đều đúng.
ONESHOT_SERVICES="seed"

is_oneshot() {
  local svc="$1" one
  for one in $ONESHOT_SERVICES; do [[ "$svc" == "$one" ]] && return 0; done
  return 1
}

echo "==> Xác nhận container đã chạy..."
NOT_RUNNING=""
for svc in $DEPLOY_SERVICES; do
  read -r state code < <(
    docker compose -f docker-compose.prod.yml --env-file .env.prod \
      ps -a --format '{{.State}} {{.ExitCode}}' "$svc" 2>/dev/null | head -1
  )
  if is_oneshot "$svc"; then
    # Chờ xong rồi mới đọc trạng thái: "up -d" trả về ngay khi container đã KHỞI ĐỘNG, còn
    # seed thì lúc đó vẫn đang chạy. Backend đã depends_on service_completed_successfully nên
    # thực tế nó đã xong trước khi tới đây, nhưng vẫn chờ tường minh cho chắc.
    docker compose -f docker-compose.prod.yml --env-file .env.prod wait "$svc" >/dev/null 2>&1 || true
    read -r state code < <(
      docker compose -f docker-compose.prod.yml --env-file .env.prod \
        ps -a --format '{{.State}} {{.ExitCode}}' "$svc" 2>/dev/null | head -1
    )
    if [[ "$state" != "exited" || "$code" != "0" ]]; then
      NOT_RUNNING="$NOT_RUNNING $svc(chạy-một-lần: ${state:-không thấy}, mã ${code:-?})"
    fi
  elif [[ "$state" != "running" ]]; then
    NOT_RUNNING="$NOT_RUNNING $svc(${state:-không thấy})"
  fi
done
if [[ -n "$NOT_RUNNING" ]]; then
  echo "!! CÁC SERVICE SAU KHÔNG ĐÚNG TRẠNG THÁI:$NOT_RUNNING"
  echo "!! Xem log để biết lý do: docker compose -f docker-compose.prod.yml logs <service> --tail 50"
  exit 1
fi
echo "    OK — service thường trực đang chạy, service chạy-một-lần đã xong."

echo "==> Kiểm tra health..."
sleep 3
curl -s "https://${API_DOMAIN}/health" && echo "" || echo "!! Backend chưa phản hồi, kiểm tra log: docker compose -f docker-compose.prod.yml logs backend --tail 50"

echo "==> Xong."
