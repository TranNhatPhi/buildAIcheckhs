from __future__ import annotations

from datetime import date, datetime
from typing import Literal

import json

from pydantic import BaseModel, Field, field_validator


# Danh sách tag hợp lệ + màu hiển thị — single source of truth cho cả backend validate lẫn
# frontend render (trả về qua GET /cases/tags). Nhân viên chỉ được chọn từ danh sách này,
# KHÔNG tự gõ tên mới → đảm bảo nhất quán, không bị trùng kiểu "gấp"/"Gấp"/"GẤP".
ALLOWED_TAGS: dict[str, str] = {
    "GẤP": "red",
    "ĐANG CHỜ KHÁCH": "yellow",
    "ĐÃ NỘP IRCC": "green",
    "CẦN BỔ SUNG": "orange",
    "ĐÃ HOÀN THÀNH": "blue",
    "TẠM HOÃN": "gray",
    "VIP": "purple",
}

ApplicationStatus = Literal[
    "PENDING",
    "COLLECTING_DOCUMENTS",
    "REVIEWING_DOCUMENTS",
    "READY_TO_SUBMIT",
    "SUBMITTED",
    "UNDER_REVIEW",
    "ADDITIONAL_DOCUMENTS_REQUIRED",
    "AWAITING_DECISION",
    "APPROVED",
    "REJECTED",
]


def parse_tags(raw: str | None) -> list[str]:
    """Đọc cột tags (JSON text) thành list Python. NULL / rỗng / JSON hỏng → []."""
    if not raw:
        return []
    try:
        result = json.loads(raw)
        return result if isinstance(result, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


class CreateCaseRequest(BaseModel):
    clientName: str = Field(min_length=1, max_length=191)
    maritalStatus: Literal["SINGLE", "MARRIED"]
    numberOfChildren: int = Field(ge=0, le=20)
    skillLevel: Literal["LOW_SKILL", "HIGH_SKILL"] = "LOW_SKILL"
    notes: str | None = None


class UpdateCaseRequest(BaseModel):
    # Tất cả field optional — PATCH chỉ cập nhật field nào thực sự được gửi lên (dùng
    # exclude_unset khi áp dụng), không bắt buộc gửi đủ như lúc tạo mới.
    clientName: str | None = Field(default=None, min_length=1, max_length=191)
    maritalStatus: Literal["SINGLE", "MARRIED"] | None = None
    numberOfChildren: int | None = Field(default=None, ge=0, le=20)
    skillLevel: Literal["LOW_SKILL", "HIGH_SKILL"] | None = None
    notes: str | None = None
    applicationStatus: ApplicationStatus | None = None

    @field_validator(
        "clientName",
        "maritalStatus",
        "numberOfChildren",
        "skillLevel",
        "applicationStatus",
        mode="before",
    )
    @classmethod
    def reject_null_for_required_columns(cls, value):
        # Các field được phép BỎ QUA trong PATCH nhưng không được gửi null, vì những cột này
        # đều NOT NULL trong MySQL; chặn ở validation để trả 422 thay vì IntegrityError 500.
        if value is None:
            raise ValueError("Trường này không được để null")
        return value


class PatchDocumentRequest(BaseModel):
    matchedChecklistItemId: str | None


class UpdateManualCorrectedTextRequest(BaseModel):
    # Rỗng/toàn khoảng trắng nghĩa là nhân viên muốn XOÁ bản chỉnh tay, quay lại dùng
    # correctedText do AI sinh ra — xem router documents.py.
    manualCorrectedText: str


class ChecklistItemDTO(BaseModel):
    id: str
    order: int
    section: str
    group: str
    nameVi: str
    note: str | None
    verificationNote: str | None
    isOptional: bool
    appliesTo: str
    quantityRule: str
    skillLevel: str

    class Config:
        from_attributes = True


class DocumentDTO(BaseModel):
    id: str
    caseId: str
    originalFilename: str
    storedPath: str
    mimeType: str
    fileSizeBytes: int
    uploadedAt: datetime
    pageCount: int | None
    matchedChecklistItemId: str | None
    matchedChecklistItem: ChecklistItemDTO | None = None
    ocrText: str | None
    correctedText: str | None
    manualCorrectedText: str | None
    aiRawLabel: str | None
    aiConfidence: float | None
    aiReasoning: str | None
    status: str
    classificationError: str | None
    isManualOverride: bool

    # Thông tin AI bóc ra từ chính giấy tờ (xem models.Document).
    aiDocOwner: str | None = None
    aiHolderName: str | None = None
    aiHolderDob: date | None = None
    aiIdNumber: str | None = None
    aiIdType: str | None = None
    aiIssuedAt: date | None = None
    aiExpiresAt: date | None = None
    manualExpiresAt: date | None = None
    aiFieldsNote: str | None = None

    class Config:
        from_attributes = True


class FinancialThresholdDTO(BaseModel):
    minVND: int
    maxVND: int
    isEstimated: bool


class SavingsAssessmentDTO(BaseModel):
    """Số dư tiết kiệm THẬT của khách, đối chiếu với mức yêu cầu ở financialThreshold."""

    aiVnd: int | None
    aiNote: str | None
    manualVnd: int | None
    # Số được dùng để kết luận: manualVnd nếu nhân viên đã nhập, không thì aiVnd.
    effectiveVnd: int | None
    source: str  # "MANUAL" | "AI" | "NONE"
    verdict: str  # "ENOUGH" | "BORDERLINE" | "SHORT" | "UNKNOWN"
    shortOfMinVnd: int
    shortOfMaxVnd: int
    updatedAt: datetime | None


class DocExpiryDTO(BaseModel):
    """Một giấy tờ đã hết hạn hoặc sắp hết hạn."""

    documentId: str
    filename: str
    itemName: str | None
    expiresAt: date
    source: str  # "MANUAL" | "AI"
    daysLeft: int  # âm nghĩa là đã quá hạn
    state: str  # "EXPIRED" | "EXPIRING_SOON"


class ConflictValueDTO(BaseModel):
    value: str
    filename: str


class DataConflictDTO(BaseModel):
    owner: str
    ownerLabel: str
    fieldLabel: str
    values: list[ConflictValueDTO]


class DocChecksDTO(BaseModel):
    """Kết quả hai phép kiểm tra chạy bằng CODE trên thông tin AI đã bóc ra — luôn có sẵn,
    không cần bấm "Phân tích AI chuyên sâu" và không đổi kết quả giữa các lần chạy."""

    expiries: list[DocExpiryDTO]
    conflicts: list[DataConflictDTO]
    expiredCount: int
    expiringSoonCount: int
    warnDays: int


class ChecklistItemStatusDTO(BaseModel):
    item: ChecklistItemDTO
    requiredCount: int
    fulfilledCount: int
    complete: bool
    matchedDocuments: list[DocumentDTO]


class ChecklistSummaryDTO(BaseModel):
    items: list[ChecklistItemStatusDTO]
    percent: int
    totalRequiredItems: int
    completedRequiredItems: int
    needsReviewCount: int


class CaseDTO(BaseModel):
    id: str
    clientName: str
    maritalStatus: str
    numberOfChildren: int
    skillLevel: str = "LOW_SKILL"
    notes: str | None
    tags: list[str] = []
    createdAt: datetime
    applicationStatus: ApplicationStatus
    applicationStatusUpdatedAt: datetime | None
    # Lịch nhắc định kỳ: service status-reminder dựa vào hai field này để biết hồ sơ nào
    # tới hạn và lần nhắc gần nhất là khi nào (xem backend/status_reminder.py).
    lastStatusReminderAt: datetime | None
    nextStatusReminderAt: datetime | None
    statusReminderDue: bool
    statusReminderIntervalDays: int = 14
    # None ở các endpoint bình thường (hồ sơ đang hoạt động) — chỉ có giá trị khi trả về từ
    # endpoint danh sách hồ sơ đã xoá mềm (GET /cases/deleted), phục vụ giao diện admin sau.
    deletedAt: datetime | None = None

    class Config:
        from_attributes = True


class CaseListItemDTO(CaseDTO):
    percent: int
    needsReviewCount: int
    financialThreshold: FinancialThresholdDTO
    # CHỈ có ý nghĩa ở response của PATCH /cases/{id}: lần đổi trạng thái vừa rồi có kích
    # hoạt email báo tức thì hay không, để UI báo lại cho nhân viên. Đặt ở backend thay vì
    # để frontend tự đoán theo danh sách trạng thái — nếu không, INSTANT_EMAIL_STATUSES đổi
    # mà quên sửa frontend thì UI sẽ báo sai. Mọi endpoint khác luôn là False.
    statusEmailQueued: bool = False
    # Có mặc định để các endpoint phụ (khôi phục hồ sơ đã xoá...) không phải tính lại; endpoint
    # danh sách chính thì luôn điền số thật.
    expiredDocCount: int = 0
    expiringSoonDocCount: int = 0


class CaseWithDocumentsDTO(CaseDTO):
    documents: list[DocumentDTO]
    aiAnalysisStatus: str
    aiAnalysisSummary: str | None
    aiAnalysisError: str | None
    aiAnalysisUpdatedAt: datetime | None


class CaseDetailDTO(BaseModel):
    case: CaseWithDocumentsDTO
    checklist: ChecklistSummaryDTO
    financialThreshold: FinancialThresholdDTO
    savings: SavingsAssessmentDTO
    docChecks: DocChecksDTO


class UpdateTagsRequest(BaseModel):
    """Danh sách tag MỚI — thay toàn bộ, không phải thêm/xoá từng cái. Gửi mảng rỗng để xoá
    hết tag. Backend validate từng tag có trong ALLOWED_TAGS."""

    tags: list[str] = []


class UpdateSavingsRequest(BaseModel):
    """None nghĩa là XOÁ số nhập tay, quay về dùng số AI đọc — không phải "không đổi"."""

    manualVnd: int | None = None


class UpdateExpiresAtRequest(BaseModel):
    """None nghĩa là XOÁ ngày nhập tay, quay về dùng ngày AI đọc — không phải "không đổi".
    Cùng quy ước với UpdateSavingsRequest."""

    manualExpiresAt: date | None = None


class CaseAnalysisResponse(BaseModel):
    summary: str


class AdminStatsDTO(BaseModel):
    totalCases: int
    activeCases: int
    deletedCases: int
    needsReviewDocuments: int
    errorDocuments: int
    # Hồ sơ chưa có quyết định cuối và số hồ sơ đã chạm mốc nhắc 14 ngày.
    pendingDecisionCases: int
    statusRemindersDue: int


class AdminDocumentDTO(DocumentDTO):
    # Ghép thêm thông tin case vào để tab "Tài liệu" trong /admin không cần gọi thêm request
    # riêng để tra người nộp là ai — mỗi dòng tài liệu tự đủ thông tin hiển thị.
    caseClientName: str
    caseDeletedAt: datetime | None
