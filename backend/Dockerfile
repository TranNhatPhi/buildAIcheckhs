FROM python:3.9-slim

# tesseract-ocr + gói ngôn ngữ tiếng Việt — bắt buộc phải cài qua apt, không tự tải lúc
# chạy (xem ocr.py load_models: chỉ kiểm tra đã cài chưa, fail sớm nếu thiếu). Các gói
# libgl1/libglib2.0-0/libsm6/libxext6/libxrender1 là dependency hệ thống quen thuộc của
# opencv-python-headless dù bản "headless" vẫn cần vài thư viện đồ hoạ nền để import được.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-vie \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8001

# --workers=2: nhân song song bằng CẢ 2 cách — nhiều REPLICA container (xem docker-compose.prod.yml
# backend + backend2, cân bằng tải qua Caddy) VÀ nhiều worker trong mỗi container — 2 replica x 2
# worker = 4 process tổng. Từng là --workers=1 (2 process) lúc VM chỉ có 2 vCPU (e2-medium); đã
# nâng VM lên e2-standard-8 (8 vCPU) nên tăng theo, còn dư CPU cho mysql/minio/caddy. Đừng tăng
# quá số process vượt hẳn số vCPU thật của VM — kiểm tra lại nếu resize VM lần nữa.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]
