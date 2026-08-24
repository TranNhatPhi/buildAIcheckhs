#!/bin/bash
# Chạy song song backend (FastAPI) + frontend (Next.js). Ctrl+C để dừng cả 2.
# MySQL/MinIO chạy riêng qua Docker — xem README, chạy `docker compose up -d` nếu chưa bật.

set -e
cd "$(dirname "$0")"

trap 'echo ""; echo "Đang dừng..."; kill 0' EXIT

echo "Khởi động backend (FastAPI, port 8001)..."
(cd backend && ./.venv/bin/python -m uvicorn main:app --port 8001) &

echo "Khởi động frontend (Next.js, port 3000)..."
npm run dev &

wait
