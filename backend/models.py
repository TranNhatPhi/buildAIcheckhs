import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
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
    skillLevel = Column(String(191), nullable=False, default="LOW_SKILL")  # "LOW_SKILL" | "HIGH_SKILL"
    notes = Column(Text, nullable=True)
    createdAt = Column(DateTime, default=now_utc)
    updatedAt = Column(DateTime, default=now_utc, onupdate=now_utc)
    # Xoá mềm — nút "Xoá" ở danh sách hồ sơ chỉ đánh dấu deletedAt (ẩn khỏi danh sách),
    # KHÔNG xoá thật document/file trên MinIO — chừa chỗ cho giao diện admin sau này khôi
    # phục lại được. NULL nghĩa là hồ sơ đang hoạt động bình thường.
    deletedAt = Column(DateTime, nullable=True)

    # Trạng thái NGHIỆP VỤ của cả hồ sơ, tách biệt với Document.status (OCR/phân loại) và
    # aiAnalysisStatus. Hai mốc thời gian bên dưới chừa sẵn nền cho email nhắc admin: trạng
    # thái chưa phải APPROVED/REJECTED sẽ đến hạn nhắc sau mỗi 14 ngày (xem case_status.py).
    applicationStatus = Column(String(191), nullable=False, default="PENDING")
    applicationStatusUpdatedAt = Column(DateTime, nullable=True, default=now_utc)
    lastStatusReminderAt = Column(DateTime, nullable=True)

    # Lưu lại kết quả "Phân tích AI chuyên sâu" vào DB (thay vì chỉ giữ trong state React)
    # — bước phân tích có thể chạy 2-4+ phút với hồ sơ nhiều file, nếu nhân viên bấm F5
    # giữa chừng thì trước đây mất trắng kết quả dù backend vẫn chạy xong bình thường.
    # status: "IDLE" | "RUNNING" | "DONE" | "ERROR" — trang tổng hợp dựa vào đây để tự
    # polling lại đúng tiến trình sau khi tải lại trang, giống cách DocumentList đã làm
    # với status của từng Document.
    aiAnalysisStatus = Column(String(191), nullable=False, default="IDLE")
    aiAnalysisSummary = Column(Text, nullable=True)
    aiAnalysisError = Column(Text, nullable=True)
    aiAnalysisUpdatedAt = Column(DateTime, nullable=True)

    # Số dư tiết kiệm chứng minh tài chính. Tách LÀM 2 CỘT theo đúng khuôn đã dùng cho văn
    # bản OCR (correctedText / manualCorrectedText): AI đọc ra một con số, nhân viên được đè
    # lên mà KHÔNG mất bản AI — vẫn còn để đối chiếu khi nghi AI đọc nhầm. Số hiệu lực =
    # savingsManualVnd nếu có, không thì savingsAiVnd (xem completeness.assess_savings).
    #
    # BigInteger chứ không Integer: INT của MySQL tối đa ~2,1 tỷ, mà số dư 3-5 tỷ VNĐ là
    # chuyện bình thường với hồ sơ diện tay nghề cao — tràn số sẽ làm hỏng đúng những hồ sơ
    # dư tiền nhất.
    savingsAiVnd = Column(BigInteger, nullable=True)
    # AI đọc được những khoản nào, từ file nào — hiện nguyên văn cho nhân viên soát lại,
    # vì con số một mình không đủ để tin khi nó quyết định "đủ tiền đi hay không".
    savingsAiNote = Column(Text, nullable=True)
    savingsManualVnd = Column(BigInteger, nullable=True)
    savingsUpdatedAt = Column(DateTime, nullable=True)

    # Nhãn (tag) do nhân viên tự gắn cho hồ sơ, vd ["GẤP","VIP"]. Lưu JSON array dạng text
    # thay vì kiểu JSON của MySQL vì: (1) MySQL JSON không cho DEFAULT ở mọi phiên bản, (2)
    # pattern Text + parse JSON phía app đã dùng xuyên suốt codebase (aiFieldsNote, savings...),
    # (3) không cần query JSON phức tạp — chỉ đọc/ghi nguyên mảng, lọc tag làm phía app.
    tags = Column(Text, nullable=True)

    documents = relationship("Document", back_populates="case", cascade="all, delete-orphan")


class ChecklistItem(Base):
    __tablename__ = "ChecklistItem"

    id = Column(String(191), primary_key=True)  # slug ổn định, vd "passport"
    order = Column("order", Integer, nullable=False)
    # Tên đầy đủ để hiển thị trực tiếp lên UI (vd "Hồ sơ đương đơn", "Hồ sơ người phụ thuộc
    # (Con 1)") — KHÔNG còn là mã "A"/"B" đơn lẻ như trước (frontend từng tự suy ra nhãn từ
    # mã này, giờ hiển thị thẳng section để phân biệt được vợ/chồng vs từng con).
    section = Column(String(191), nullable=False)
    group = Column("group", String(191), nullable=False)
    nameVi = Column(String(191), nullable=False)
    note = Column(Text, nullable=True)
    # Ghi chú riêng cho nhân viên: cách kiểm tra tính hợp lệ nội dung giấy tờ (khác với
    # `note` vốn hướng dẫn thu thập giấy tờ gì) — tổng hợp từ kinh nghiệm thực tế xử lý hồ sơ.
    verificationNote = Column(Text, nullable=True)
    isOptional = Column(Boolean, nullable=False, default=False)
    # "ALWAYS" | "SPOUSE" | "SINGLE" | "CHILD_1/2/3" | "SPOUSE_CHILD_1/2/3" — xem
    # is_item_applicable (completeness.py) để biết ý nghĩa từng giá trị.
    appliesTo = Column(String(191), nullable=False)
    quantityRule = Column(String(191), nullable=False, default="FIXED_1")
    # "LOW_SKILL" | "HIGH_SKILL" — checklist hoàn toàn khác nhau theo skill level (xem
    # backend/seed.py), lọc theo Case.skillLevel giống cách appliesTo lọc theo marital/con.
    skillLevel = Column(String(191), nullable=False, default="LOW_SKILL")
    # Cặp "chỉ cần 1 trong 2" (vd CCCD vợ / CCCD chồng — 1 hồ sơ chỉ có 1 người, không bao
    # giờ cần cả 2) — trỏ sang id của mục kia trong cặp. Xem compute_checklist_summary.
    eitherWithId = Column(String(191), nullable=True)

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
    # Nhân viên tự sửa tay phần văn bản đã qua DeepSeek (mục 2 ở khung "Xem chi tiết OCR &
    # AI") khi phát hiện sai sót AI không tự sửa được — giữ RIÊNG với correctedText (không
    # ghi đè) để vẫn còn bản gốc AI sinh ra làm audit trail. NULL nghĩa là chưa từng chỉnh
    # tay; khi có giá trị, đây là bản "cuối cùng" được ưu tiên dùng ở mọi nơi hiển thị/phân
    # tích (xem CaseSummary.tsx và analyze_case) thay vì correctedText.
    manualCorrectedText = Column(Text, nullable=True)
    aiRawLabel = Column(String(191), nullable=True)
    aiConfidence = Column(Float, nullable=True)
    aiReasoning = Column(Text, nullable=True)

    # --- Thông tin AI bóc ra từ chính giấy tờ, lấy KÈM trong lệnh phân loại ---
    #
    # Vì sao gộp chung lệnh phân loại chứ không gọi riêng: mỗi file đang mất 30-150 giây
    # ĐỒNG BỘ trong request upload (xem AGENTS.md). Thêm một lượt gọi LLM nữa là đẩy thẳng
    # vào lỗi "Failed to fetch" đã biết. Lệnh phân loại dù sao cũng đã phải đọc hết nội dung
    # và đã bật reasoning để phán đoán "giấy tờ này của ai trong nhà" — bắt nó ghi luôn phán
    # đoán đó ra thay vì vứt đi gần như không tốn thêm gì.
    #
    # Giấy tờ này của AI: "APPLICANT" | "SPOUSE" | "CHILD_1..3" | "FATHER" | "MOTHER" |
    # "OTHER". NULL = không xác định được. Dùng để GOM NHÓM khi đối chiếu chéo: checklist
    # KHÔNG cho biết chủ giấy tờ (mục "Căn cước công dân mẹ" vẫn là appliesTo="ALWAYS"),
    # nên thiếu trường này thì mọi phép so tên/ngày sinh giữa các file sẽ báo lệch oan giữa
    # giấy tờ của mẹ và của đương đơn.
    aiDocOwner = Column(String(191), nullable=True)
    aiHolderName = Column(String(191), nullable=True)
    aiHolderDob = Column(Date, nullable=True)
    aiIdNumber = Column(String(191), nullable=True)
    # Loại của số trên: "CCCD" | "PASSPORT" | "OTHER". Có nó mới đối chiếu chéo được, vì số
    # CCCD và số hộ chiếu của CÙNG MỘT NGƯỜI vốn dĩ khác nhau — so hai số khác loại với nhau
    # là báo lệch oan ở mọi hồ sơ, đúng kiểu cảnh báo sai hàng loạt khiến nhân viên học cách
    # bỏ qua rồi bỏ sót luôn cái lệch thật.
    aiIdType = Column(String(191), nullable=True)
    aiIssuedAt = Column(Date, nullable=True)
    aiExpiresAt = Column(Date, nullable=True)
    # Nhân viên đè lên ngày hết hạn khi AI đọc sai — giữ RIÊNG với aiExpiresAt theo đúng
    # khuôn đã dùng cho correctedText/manualCorrectedText và savingsAiVnd/savingsManualVnd:
    # con số này quyết định hồ sơ còn hiệu lực hay không, phải sửa được mà vẫn còn bản AI
    # để đối chiếu khi nghi ngờ.
    manualExpiresAt = Column(Date, nullable=True)
    # AI ghi rõ đọc được gì từ đâu, chỗ nào không chắc — con số/ngày tháng một mình không đủ
    # để tin khi nó quyết định "giấy tờ này còn dùng được hay không".
    aiFieldsNote = Column(Text, nullable=True)
    status = Column(String(191), nullable=False)
    classificationError = Column(Text, nullable=True)
    isManualOverride = Column(Boolean, nullable=False, default=False)

    case = relationship("Case", back_populates="documents")
    matchedChecklistItem = relationship("ChecklistItem", back_populates="documents")


# Không tạo/sửa bảng ở đây — schema đã được Prisma migrate + seed từ trước, giữ
# nguyên để không phải chạy lại migration/seed 29 mục checklist. Models ở trên
# chỉ map vào bảng đã có sẵn.
Base.metadata.bind = engine
