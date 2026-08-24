import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from db import engine
from sqlalchemy.orm import DeclarativeBase


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# Dùng default=now_utc (Python-side, SQLAlchemy tự tính rồi gửi kèm INSERT) thay vì
# server_default=func.now() — bảng do Prisma tạo trước đó, cột `updatedAt` của Case
# không có DEFAULT ở tầng DB (Prisma tự quản lý @updatedAt phía app, không phải DB
# default), nên server_default không có tác dụng thật và INSERT sẽ lỗi thiếu giá trị.


class Base(DeclarativeBase):
    pass


def new_id() -> str:
    return uuid.uuid4().hex


class Case(Base):
    __tablename__ = "Case"

    id = Column(String(191), primary_key=True, default=new_id)
    clientName = Column(String(191), nullable=False)
    maritalStatus = Column(String(191), nullable=False)  # "SINGLE" | "MARRIED"
    numberOfChildren = Column(Integer, nullable=False, default=0)
    notes = Column(Text, nullable=True)
    createdAt = Column(DateTime, default=now_utc)
    updatedAt = Column(DateTime, default=now_utc, onupdate=now_utc)

    documents = relationship("Document", back_populates="case", cascade="all, delete-orphan")


class ChecklistItem(Base):
    __tablename__ = "ChecklistItem"

    id = Column(String(191), primary_key=True)  # slug ổn định, vd "passport"
    order = Column("order", Integer, nullable=False)
    section = Column(String(191), nullable=False)  # "A" | "B"
    group = Column("group", String(191), nullable=False)
    nameVi = Column(String(191), nullable=False)
    note = Column(Text, nullable=True)
    # Ghi chú riêng cho nhân viên: cách kiểm tra tính hợp lệ nội dung giấy tờ (khác với
    # `note` vốn hướng dẫn thu thập giấy tờ gì) — tổng hợp từ kinh nghiệm thực tế xử lý hồ sơ.
    verificationNote = Column(Text, nullable=True)
    isOptional = Column(Boolean, nullable=False, default=False)
    appliesTo = Column(String(191), nullable=False)  # "ALWAYS" | "SPOUSE" | "DEPENDENTS"
    quantityRule = Column(String(191), nullable=False, default="FIXED_1")

    documents = relationship("Document", back_populates="matchedChecklistItem")


class Document(Base):
    __tablename__ = "Document"

    id = Column(String(191), primary_key=True, default=new_id)
    caseId = Column(String(191), ForeignKey("Case.id", ondelete="CASCADE"), nullable=False)
    originalFilename = Column(String(191), nullable=False)
    storedPath = Column(String(191), nullable=False)
    mimeType = Column(String(191), nullable=False)
    fileSizeBytes = Column(Integer, nullable=False)
    uploadedAt = Column(DateTime, default=now_utc)
    # Số trang (chỉ có ý nghĩa với PDF) — dùng để biết có bao nhiêu ảnh từng trang đã lưu
    # trong MinIO ở prefix "{caseId}/{id}-pages/page-{n}.png" (xem storage.upload_object).
    pageCount = Column(Integer, nullable=True)

    matchedChecklistItemId = Column(
        String(191), ForeignKey("ChecklistItem.id", ondelete="SET NULL"), nullable=True
    )

    ocrText = Column(Text, nullable=True)
    # Text sau khi LLM sửa chính tả/sắp xếp lại câu cho mạch lạc (giữ nguyên ocrText thô
    # để đối chiếu) — dùng làm input cho bước phân loại DeepSeek vì cho tín hiệu tốt hơn.
    correctedText = Column(Text, nullable=True)
    aiRawLabel = Column(String(191), nullable=True)
    aiConfidence = Column(Float, nullable=True)
    aiReasoning = Column(Text, nullable=True)
    status = Column(String(191), nullable=False)
    classificationError = Column(Text, nullable=True)
    isManualOverride = Column(Boolean, nullable=False, default=False)

    case = relationship("Case", back_populates="documents")
    matchedChecklistItem = relationship("ChecklistItem", back_populates="documents")


# Không tạo/sửa bảng ở đây — schema đã được Prisma migrate + seed từ trước, giữ
# nguyên để không phải chạy lại migration/seed 29 mục checklist. Models ở trên
# chỉ map vào bảng đã có sẵn.
Base.metadata.bind = engine
