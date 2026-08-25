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

# --workers=1: cơ chế nhân song song là chạy nhiều REPLICA container (xem docker-compose.prod.yml
# backend + backend2, cân bằng tải qua Caddy) chứ không phải nhiều worker trong 1 container —
# 2 replica x 1 worker = 2 process tổng, khớp đúng 2 vCPU của e2-medium. Đừng tăng cả 2 chỗ
# cùng lúc (vd 2 replica x 2 worker = 4 process) trừ khi VM cũng có đủ vCPU tương ứng.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
