#!/bin/bash
# Chuyển dữ liệu ĐANG CHẠY từ Docker Compose sang k3s. Chạy MỘT LẦN, trên VM, sau khi đã
# `kubectl apply` xong mysql/minio nhưng TRƯỚC khi cho người dùng vào bản k8s.
#
# Đây là bước nguy hiểm nhất của cả cuộc chuyển đổi — nó đụng vào dữ liệu thật của khách.
# Script cố ý KHÔNG xoá gì ở phía Compose: volume cũ giữ nguyên, muốn quay lại chỉ cần
# `docker compose up -d` như cũ.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=checklist
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
ROOT_PW=$(grep -E '^MYSQL_ROOT_PASSWORD=' .env.prod | cut -d= -f2- | sed -E "s/^[\"'](.*)[\"']$/\1/")
DUMP=/tmp/checklist-migrate-$(date +%Y%m%d-%H%M%S).sql

echo "=================================================================="
echo " Chuyển dữ liệu Compose -> k3s. Dừng dịch vụ vài phút."
echo " Bản dump SQL sẽ nằm ở: $DUMP (GIỮ LẠI, đây là bản lùi của bạn)"
echo "=================================================================="
read -rp "Gõ 'dong y' để tiếp tục: " ok
[[ "$ok" == "dong y" ]] || { echo "Đã huỷ."; exit 1; }

# ---- 1. MySQL: dump từ Compose, nạp vào pod k8s ------------------------------------
# Dùng mysqldump thay vì chép thẳng thư mục dữ liệu: chép file chỉ an toàn khi hai bên
# CHÍNH XÁC cùng phiên bản MySQL, còn dump/restore thì không phụ thuộc điều đó.
echo "==> Dump database từ Compose..."
$COMPOSE exec -T mysql mysqldump -u root -p"$ROOT_PW" \
  --single-transaction --routines --triggers canada_checklist > "$DUMP"
echo "    $(wc -l < "$DUMP") dòng, $(du -h "$DUMP" | cut -f1)"
[[ -s "$DUMP" ]] || { echo "!! Dump rỗng — DỪNG."; exit 1; }

echo "==> Nạp vào MySQL trên k3s..."
kubectl -n "$NS" exec -i mysql-0 -- mysql -u root -p"$ROOT_PW" canada_checklist < "$DUMP"

echo "==> Đối chiếu số dòng 2 bên:"
for t in "Case" Document ChecklistItem; do
  a=$($COMPOSE exec -T mysql mysql -N -u root -p"$ROOT_PW" -e "SELECT COUNT(*) FROM canada_checklist.\`$t\`" 2>/dev/null | tr -d '\r')
  b=$(kubectl -n "$NS" exec -i mysql-0 -- mysql -N -u root -p"$ROOT_PW" -e "SELECT COUNT(*) FROM canada_checklist.\`$t\`" 2>/dev/null | tr -d '\r')
  if [[ "$a" == "$b" ]]; then echo "    OK  $t: $a"; else echo "    !! LỆCH $t: compose=$a k8s=$b"; exit 1; fi
done

# ---- 2. MinIO: chép thẳng thư mục dữ liệu ------------------------------------------
# Ở đây chép file LÀ đúng: MinIO lưu mỗi object thành file trên đĩa, không có định dạng
# nhị phân phụ thuộc phiên bản như database. Bắt buộc DỪNG cả hai bên trước khi chép —
# chép lúc đang ghi sẽ ra object hỏng.
echo "==> Dừng MinIO hai bên để chép an toàn..."
$COMPOSE stop minio
kubectl -n "$NS" scale statefulset/minio --replicas=0
kubectl -n "$NS" wait --for=delete pod/minio-0 --timeout=120s || true

SRC=$(docker volume inspect "$($COMPOSE config --volumes | grep -x minio_data | head -1 >/dev/null && basename "$PWD")_minio_data" \
        --format '{{.Mountpoint}}' 2>/dev/null || true)
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  SRC=$(docker volume ls -q | grep -i 'minio_data' | head -1 | xargs -r docker volume inspect --format '{{.Mountpoint}}')
fi
DST=$(kubectl -n "$NS" get pv -o jsonpath='{range .items[*]}{.spec.claimRef.name}{" "}{.spec.hostPath.path}{"\n"}{end}' \
      | awk '$1=="data-minio-0"{print $2}')
echo "    nguồn : $SRC"
echo "    đích  : $DST"
[[ -d "$SRC" && -n "$DST" ]] || { echo "!! Không xác định được đường dẫn — DỪNG, làm tay."; exit 1; }

sudo cp -a "$SRC/." "$DST/"
echo "    đã chép $(sudo du -sh "$DST" | cut -f1)"

kubectl -n "$NS" scale statefulset/minio --replicas=1
kubectl -n "$NS" rollout status statefulset/minio --timeout=300s

# ---- 3. Chứng chỉ HTTPS ------------------------------------------------------------
# Chép để Caddy mới KHỎI phải xin lại chứng chỉ. Xin lại vài lần liên tiếp là chạm hạn mức
# Let's Encrypt và site nằm không có HTTPS hàng giờ.
echo "==> Chép chứng chỉ HTTPS của Caddy..."
CSRC=$(docker volume ls -q | grep -i 'caddy_data' | head -1 | xargs -r docker volume inspect --format '{{.Mountpoint}}')
CDST=$(kubectl -n "$NS" get pv -o jsonpath='{range .items[*]}{.spec.claimRef.name}{" "}{.spec.hostPath.path}{"\n"}{end}' \
      | awk '$1=="caddy-data"{print $2}')
if [[ -d "$CSRC" && -n "$CDST" ]]; then
  kubectl -n "$NS" scale deployment/caddy --replicas=0 2>/dev/null || true
  sudo cp -a "$CSRC/." "$CDST/"
  echo "    xong"
else
  echo "    (bỏ qua — Caddy mới sẽ tự xin chứng chỉ)"
fi

echo
echo "=== XONG. Dữ liệu đã sang k3s. ==="
echo "Compose vẫn còn nguyên volume — muốn quay lại: $COMPOSE up -d"
echo "Giữ file dump: $DUMP"
