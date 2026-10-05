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

# antiword: đọc chữ file Word đời cũ (.doc) cho trang kiểm tra hồ sơ dịch thuật — bộ bản dịch
# mẫu thật có 8/13 file là .doc, không phải .docx (xem backend/translation_check.py).
# CỐ Ý là lệnh RIÊNG đặt SAU pip install, không gộp vào lệnh apt-get phía trên: sửa lệnh đó là
# mọi layer sau nó mất cache, kéo theo tải lại toàn bộ gói Python (>100MB). Đã gặp thật — trên
# mạng Wi-Fi ~4 Mbps, lượt tải lại đó hỏng giữa chừng 2 lần liền (pip báo sai mã băm do file tải
# dở: opencv 61MB "xong" sau 2 giây).
RUN apt-get update && apt-get install -y --no-install-recommends antiword \
    && rm -rf /var/lib/apt/lists/*

# LibreOffice Writer (không giao diện): chuyển mẫu hợp đồng Word sang PDF để dựng ảnh xem trước
# từng trang ở trang "Mẫu hợp đồng lao động" (xem backend/contract_preview.py). fonts-liberation:
# Liberation Serif có cùng kích thước chữ với Times New Roman — mẫu HĐLĐ dùng TNR, thiếu phông này
# thì bản xem trước bị dàn trang lệch so với lúc mở bằng Word. Lệnh RIÊNG, đặt sau cùng, cùng lý do
# với antiword ở trên (không làm mất cache các layer pip phía trước).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# LibreOffice Calc: dựng ảnh xem trước cho mẫu phiếu lương (file Excel .xls/.xlsx) — cùng lệnh
# soffice --convert-to pdf ở contract_preview.py, LibreOffice tự chọn Calc theo đuôi file. Lệnh
# RIÊNG để không làm mất cache layer Writer ở trên. fonts-crosextra-carlito: Carlito cùng kích thước
# chữ với Calibri (phông mặc định của Excel) — thiếu thì chữ trong ảnh xem trước tràn ô / lệch cột.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-calc-nogui \
    fonts-crosextra-carlito \
    && rm -rf /var/lib/apt/lists/*

COPY . .

EXPOSE 8001

# --workers=2: nhân song song bằng CẢ 2 cách — nhiều REPLICA container (xem docker-compose.prod.yml
# backend + backend2, cân bằng tải qua Caddy) VÀ nhiều worker trong mỗi container — 2 replica x 2
# worker = 4 process tổng. Từng là --workers=1 (2 process) lúc VM chỉ có 2 vCPU (e2-medium); đã
# nâng VM lên e2-standard-8 (8 vCPU) nên tăng theo, còn dư CPU cho mysql/minio/caddy. Đừng tăng
# quá số process vượt hẳn số vCPU thật của VM — kiểm tra lại nếu resize VM lần nữa.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]
