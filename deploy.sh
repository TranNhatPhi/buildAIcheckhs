#!/bin/bash
# Script redeploy cho VM production — chạy từ thư mục gốc repo trên VM (~/buildAIcheckhs).
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
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# Caddyfile gắn vào container qua bind-mount (không nằm trong image build) — nếu chỉ
# Caddyfile đổi mà docker-compose.prod.yml không đổi, lệnh "up -d" ở trên KHÔNG tự restart
# caddy (Compose không thấy service definition thay đổi). Reload tường minh để chắc chắn
# Caddy luôn đọc lại Caddyfile mới nhất trên đĩa, không phụ thuộc việc container có bị
# recreate hay không.
echo "==> Reload Caddy config..."
docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 || echo "!! Reload Caddy thất bại — kiểm tra: docker compose -f docker-compose.prod.yml logs caddy --tail 30"

echo "==> Trạng thái container:"
docker compose -f docker-compose.prod.yml ps

echo "==> Kiểm tra health..."
sleep 3
curl -s "https://${API_DOMAIN}/health" && echo "" || echo "!! Backend chưa phản hồi, kiểm tra log: docker compose -f docker-compose.prod.yml logs backend --tail 50"

echo "==> Xong."
