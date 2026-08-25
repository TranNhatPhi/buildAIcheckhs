# Dùng node:25-alpine để khớp đúng version Node đang chạy dev cục bộ — Next.js 16 còn rất
# mới (xem AGENTS.md: "This is NOT the Next.js you know"), tránh rủi ro lệch version Node
# gây lỗi build khó lường không có trong lúc dev.

FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Dùng "npm install" thay vì "npm ci" — đã xác nhận bằng thực nghiệm là package-lock.json
# hiện tại lệch với dependency cây thực tế trên nền tảng build (thiếu entry
# @emnapi/runtime, @emnapi/core), khiến "npm ci" (yêu cầu khớp tuyệt đối) báo lỗi EUSAGE.
# "npm install" tự cập nhật lock file khi cần, không bị chặn bởi lệch nhỏ này.
RUN npm install

FROM node:25-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_API_URL được bake thẳng vào JS bundle lúc build (biến NEXT_PUBLIC_ chạy được
# ở browser) — phải truyền đúng URL backend PRODUCTION tại bước build, không phải lúc chạy
# container. Xem hướng dẫn deploy: docker build --build-arg NEXT_PUBLIC_API_URL=...
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:25-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
