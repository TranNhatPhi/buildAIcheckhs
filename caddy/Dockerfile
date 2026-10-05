# Caddy kèm module DNS của Cloudflare — để xin chứng chỉ HTTPS cho candoc.info bằng DNS-01.
#
# VÌ SAO KHÔNG DÙNG caddy:2-alpine TRƠN như trước: máy này có IP nội bộ 192.168.1.200 sau NAT,
# Let's Encrypt KHÔNG với tới được để xác minh kiểu thông thường (HTTP-01). DNS-01 chỉ cần
# chứng minh sở hữu tên miền bằng một bản ghi TXT, Caddy tự tạo qua API Cloudflare — nên máy
# không cần lộ ra Internet mà vẫn có chứng chỉ thật. Image chuẩn không kèm module này.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
