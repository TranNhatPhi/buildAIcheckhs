import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# DATABASE_URL dạng Prisma: mysql://user:pass@host:port/db
# SQLAlchemy + PyMySQL cần scheme mysql+pymysql://
_raw_url = os.environ["DATABASE_URL"]
SQLALCHEMY_DATABASE_URL = _raw_url.replace("mysql://", "mysql+pymysql://", 1)

# pool_size/max_overflow mặc định của SQLAlchemy chỉ 5+10=15 connection — không đủ cho
# app này: mỗi request upload/reclassify giữ nguyên 1 connection suốt cả lúc chạy OCR +
# gọi DeepSeek (có thể 30-150s, xem classify.py), cộng thêm client vẫn poll GET mỗi 4s để
# lấy tiến trình song song — dễ làm cạn pool khi có vài file đang xử lý cùng lúc (batch
# upload MAX_CONCURRENT=2 ở UploadDropzone.tsx), khiến các request khác phải chờ hoặc lỗi
# timeout dù chỉ là query đọc đơn giản. Tăng lên để có đủ dư địa.
engine = create_engine(SQLALCHEMY_DATABASE_URL, pool_pre_ping=True, pool_size=15, max_overflow=15)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
