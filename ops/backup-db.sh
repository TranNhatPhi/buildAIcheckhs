#!/bin/sh
# Sao lưu CSDL canada_checklist mỗi ngày — dịch vụ "db-backup" trong docker-compose.yml.
#
# VÌ SAO: 13/10/2026 tiến trình tự xoá xoá HẲN 2 hồ sơ khách mà không có bản sao lưu nào -> mất luôn.
#
# Cách chạy: mỗi giờ kiểm tra HÔM NAY (giờ VN) đã có bản sao lưu chưa, chưa có thì làm ngay. KHÔNG hẹn
# một giờ cố định ban đêm vì máy chủ bị tắt mỗi tối (~17h40 -> 8h45 sáng) — hẹn 2h sáng là không bao
# giờ chạy. Bản sao lưu nằm ở thư mục ./backups trên ổ máy chủ (ngoài Docker): Docker hỏng vẫn còn.
#
# Khôi phục (xem AGENTS.md "Sao lưu CSDL"):
#   gzip -cd backups/canada_checklist-<ngày>.sql.gz | docker compose exec -T mysql \
#       mysql -uroot -p<MYSQL_ROOT_PASSWORD> canada_checklist
set -u

DIR=/backups
GIU_NGAY="${BACKUP_RETENTION_DAYS:-30}"
mkdir -p "$DIR"

while true; do
  # Image mysql không có dữ liệu múi giờ -> tự cộng 7 tiếng để ra NGÀY theo giờ Việt Nam.
  NGAY=$(date -u -d '+7 hours' +%Y-%m-%d)
  if ! ls "$DIR"/canada_checklist-"$NGAY"_*.sql.gz >/dev/null 2>&1; then
    TEN="$DIR/canada_checklist-$(date -u -d '+7 hours' +%Y-%m-%d_%H%M).sql.gz"
    # MYSQL_PWD lấy từ biến môi trường (không lộ mật khẩu trên dòng lệnh / ps).
    mysqldump -h mysql -u root --single-transaction --routines --triggers --events \
      --default-character-set=utf8mb4 --set-gtid-purged=OFF canada_checklist | gzip > "$TEN.tmp"
    # sh không có pipefail: mysqldump hỏng giữa chừng gzip vẫn ra file -> kiểm tra dòng cuối của
    # bản dump ("-- Dump completed") mới coi là xong.
    if gzip -cd "$TEN.tmp" 2>/dev/null | tail -n 1 | grep -q "Dump completed"; then
      mv "$TEN.tmp" "$TEN"
      echo "$(date -u -d '+7 hours' '+%F %T') Đã sao lưu: $TEN ($(du -h "$TEN" | cut -f1))"
    else
      rm -f "$TEN.tmp"
      echo "$(date -u -d '+7 hours' '+%F %T') LỖI sao lưu — giờ sau thử lại"
    fi
    find "$DIR" -name 'canada_checklist-*.sql.gz' -mtime +"$GIU_NGAY" -print -delete
  fi
  sleep 3600
done
