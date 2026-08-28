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

# deploy-webhook (docker-compose.prod.yml) chạy git pull TRỰC TIẾP lên thư mục repo bind-mount
# chung với host — ép nó chạy đúng UID:GID của tài khoản host đang gọi script này (thay vì mặc
# định root) để không tạo ra object git thuộc sở hữu root, khiến lần chạy tay tiếp theo (không
# có sudo) không xoá/ghi đè được. Tính tự động mỗi lần chạy — không hard-code — để đúng bất kể
# tài khoản/VM nào chạy script.
#
# CỐ Ý dùng `stat` (đọc chủ sở hữu file) thay vì `id -u`/`id -g` (đọc UID của TIẾN TRÌNH đang
# chạy) — script này có thể tự chạy TỪ BÊN TRONG chính container deploy-webhook (khi trigger
# qua GitHub webhook, xem run_deploy() trong deploy-webhook.py), lúc đó tiến trình vẫn là
# UID/GID CŨ của container (có thể vẫn là root nếu đây là lần đầu áp dụng fix này) — `id -u`
# lúc đó sẽ trả về UID SAI (của container, không phải của host). Chủ sở hữu file thư mục repo
# (bind-mount CHUNG với host) thì luôn phản ánh đúng UID/GID thật trên host dù đọc từ đâu.
export DEPLOY_UID DEPLOY_GID DOCKER_SOCK_GID
DEPLOY_UID=$(stat -c '%u' .)
DEPLOY_GID=$(stat -c '%g' .)
DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock)

echo "==> Build & restart container..."
# KHÔNG deploy service "deploy-webhook" ở đây — nó chính là container đang CHẠY script này khi
# deploy được kích hoạt qua GitHub webhook (xem run_deploy() trong deploy-webhook.py). Đưa nó
# vào danh sách "up" khiến Compose dừng chính container đang chạy script → tiến trình bị SIGKILL
# (exit 137) NGAY GIỮA CHỪNG, các service còn lại đã được "Created" nhưng CHƯA KỊP "Started".
#
# ĐÃ XẢY RA THẬT trên production: toàn bộ container nằm ở trạng thái "Created", caddy "Exited",
# website chết hẳn (ERR_CONNECTION_REFUSED) sau 1 lần push code bình thường. Đây KHÔNG phải lỗi
# ngẫu nhiên — "docker compose up" là điều phối phía CLIENT (build → stop cũ → create mới →
# start mới), nên client chết ở bước "stop cũ" thì 2 bước sau không bao giờ chạy.
#
# Lấy danh sách service ĐỘNG từ chính file compose (không hard-code) để service mới thêm sau này
# tự động được deploy, không phải nhớ sửa thêm chỗ này.
DEPLOY_SERVICES=$(docker compose -f docker-compose.prod.yml --env-file .env.prod config --services \
  | grep -v '^deploy-webhook$' | tr '\n' ' ')
if [[ -z "${DEPLOY_SERVICES// /}" ]]; then
  echo "!! Không đọc được danh sách service từ docker-compose.prod.yml — dừng để tránh deploy nhầm."
  exit 1
fi
echo "    service sẽ deploy: $DEPLOY_SERVICES"
# shellcheck disable=SC2086  # cố ý tách từ: đây là danh sách nhiều service, không phải 1 chuỗi
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build $DEPLOY_SERVICES

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
# container ở trạng thái "Created"/"Exited" (đã gặp thật, xem giải thích ở khối "up" phía trên),
# và khi đó các bước sau vẫn chạy tiếp như không có gì, khiến sự cố chỉ lộ ra khi người dùng
# phát hiện website chết. Kiểm tra ở đây để hỏng là biết NGAY, kèm mã thoát khác 0 để webhook
# ghi rõ DEPLOY FAILED thay vì báo thành công nhầm.
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

# Vì webhook KHÔNG tự deploy chính nó (lý do ở khối "up" phía trên), thay đổi với code webhook
# sẽ không có hiệu lực cho tới khi cập nhật tay. Báo thật rõ thay vì im lặng để bản mới nằm im
# trong repo mà tưởng đã chạy — đúng tinh thần cảnh báo git-pull-lỗi ở deploy-webhook.py.
# PREV_HEAD do deploy-webhook.py truyền vào (commit TRƯỚC khi pull); chạy tay thì không có biến
# này nên bỏ qua kiểm tra — chạy tay vốn đã deploy đủ mọi thứ rồi.
if [[ -n "${PREV_HEAD:-}" ]] && ! git diff --quiet "$PREV_HEAD" HEAD -- deploy-webhook.py Dockerfile.webhook 2>/dev/null; then
  echo ""
  echo "!! ================== CẦN LÀM TAY =================="
  echo "!! Code webhook (deploy-webhook.py / Dockerfile.webhook) vừa thay đổi, nhưng lần deploy"
  echo "!! này KHÔNG áp dụng được cho chính nó (nó đang chạy script này)."
  echo "!! SSH vào VM và chạy đúng 1 lệnh sau để cập nhật webhook:"
  echo "!!   cd ~/buildAIcheckhs && export DEPLOY_UID=\$(stat -c '%u' .) DEPLOY_GID=\$(stat -c '%g' .) DOCKER_SOCK_GID=\$(stat -c '%g' /var/run/docker.sock) && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build deploy-webhook"
  echo "!! ================================================="
  echo ""
fi

echo "==> Xong."
