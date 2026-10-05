from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Literal

import json
import unicodedata

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
    "COMPLETED",
    "READY_TO_SUBMIT",
    "SUBMITTED",
    "APPROVED",
    "REJECTED",
    "LIQUIDATED",
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


class ExperienceUnit(BaseModel):
    """Một đơn vị (công ty) xác nhận kinh nghiệm của khách + ngày nhập.

    Ngày KHÔNG do người dùng nhập: máy chủ tự ghi ngày (giờ Việt Nam) lúc bấm "Tạo hồ sơ" / "Lưu"
    — xem dump_experience_units. confirmedDate gửi lên từ trình duyệt bị bỏ qua.

    Tên field là confirmedDate chứ không phải "date": field trùng tên kiểu `date` làm Pydantic
    đọc chú thích "date | None" thành chính field đó.
    """

    name: str = Field(default="", max_length=191)
    confirmedDate: date | None = None


def parse_experience_units(raw: str | None) -> list[dict]:
    """Cột experienceUnits (JSON text) -> list cho DTO. NULL / rỗng / JSON hỏng -> []."""
    if not raw:
        return []
    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(result, list):
        return []
    return [
        {"name": str(u.get("name") or ""), "confirmedDate": u.get("confirmedDate") or None}
        for u in result
        if isinstance(u, dict) and u.get("name")
    ]


def dump_experience_units(units: list[ExperienceUnit] | None, cu_raw: str | None = None) -> str | None:
    """List từ request -> JSON để lưu. Bỏ dòng không có tên công ty; không còn dòng nào -> NULL.

    Ngày = hôm nay (giờ VN) cho đơn vị MỚI hoặc vừa đổi tên; đơn vị đã có (cùng tên, không phân
    biệt hoa/thường) GIỮ ngày cũ. Không giữ thì bấm "Lưu" chỉ để sửa ghi chú cũng làm đổi ngày của
    mọi đơn vị, ngày mất hết ý nghĩa.
    """
    hom_nay = datetime.now(timezone(timedelta(hours=7))).date().isoformat()
    # NFC: máy Mac hay gửi chữ có dấu dạng tách (ô = o + dấu mũ) — so thẳng là "Công ty" cũ và mới
    # lệch nhau dù nhìn giống hệt, đơn vị cũ bị coi là mới và mất ngày.
    ngay_cu = {
        unicodedata.normalize("NFC", u["name"]).casefold(): u["confirmedDate"]
        for u in parse_experience_units(cu_raw)
    }
    sach = []
    for u in units or []:
        ten = " ".join(unicodedata.normalize("NFC", u.name or "").split())
        if ten:
            sach.append({"name": ten, "confirmedDate": ngay_cu.get(ten.casefold()) or hom_nay})
    return json.dumps(sach, ensure_ascii=False) if sach else None


class CreateCaseRequest(BaseModel):
    clientName: str = Field(min_length=1, max_length=191)
    maritalStatus: Literal["SINGLE", "MARRIED"]
    numberOfChildren: int = Field(ge=0, le=20)
    skillLevel: Literal["LOW_SKILL", "HIGH_SKILL"] = "LOW_SKILL"
    partner: str | None = Field(default=None, max_length=191)
    receiverName: str | None = Field(default=None, max_length=191)
    managerName: str | None = Field(default=None, max_length=191)
    saleName: str | None = Field(default=None, max_length=191)
    occupation: str | None = Field(default=None, max_length=191)
    # Trần 100 năm: chặn lỗi gõ nhầm (vd nhập 2024 vì tưởng là năm) chứ không phải giới
    # hạn nghiệp vụ thật.
    experienceMonths: int | None = Field(default=None, ge=0, le=1200)
    experienceUnits: list[ExperienceUnit] | None = Field(default=None, max_length=10)
    notes: str | None = None


class UpdateCaseRequest(BaseModel):
    # Tất cả field optional — PATCH chỉ cập nhật field nào thực sự được gửi lên (dùng
    # exclude_unset khi áp dụng), không bắt buộc gửi đủ như lúc tạo mới.
    clientName: str | None = Field(default=None, min_length=1, max_length=191)
    maritalStatus: Literal["SINGLE", "MARRIED"] | None = None
    numberOfChildren: int | None = Field(default=None, ge=0, le=20)
    skillLevel: Literal["LOW_SKILL", "HIGH_SKILL"] | None = None
    partner: str | None = Field(default=None, max_length=191)
    receiverName: str | None = Field(default=None, max_length=191)
    managerName: str | None = Field(default=None, max_length=191)
    saleName: str | None = Field(default=None, max_length=191)
    occupation: str | None = Field(default=None, max_length=191)
    experienceMonths: int | None = Field(default=None, ge=0, le=1200)
    experienceUnits: list[ExperienceUnit] | None = Field(default=None, max_length=10)
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
    numberGroup: str | None = None

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
    # Đối tác / nguồn giới thiệu. None = hồ sơ khách tự tìm đến, hoặc hồ sơ tạo trước khi
    # có trường này.
    partner: str | None = None
    receiverName: str | None = None
    managerName: str | None = None
    saleName: str | None = None
    occupation: str | None = None
    # Luôn là SỐ THÁNG; giao diện tự đổi sang "x năm y tháng" khi hiển thị.
    experienceMonths: int | None = None
    experienceUnits: list[ExperienceUnit] = []
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
    submissionRound: int = 1
    lastDocumentAt: datetime | None = None
    # Số ngày chưa cập nhật nếu thuộc diện nhắc "7 ngày chưa cập nhật" (thong_bao.ngay_chua_cap_nhat),
    # None nếu không. Chỉ có ở 2 endpoint danh sách (GET /cases, GET /admin/cases).
    idleDays: int | None = None
    # None ở các endpoint bình thường (hồ sơ đang hoạt động) — chỉ có giá trị khi trả về từ
    # endpoint danh sách hồ sơ đã xoá mềm (GET /cases/deleted), phục vụ giao diện admin sau.
    deletedAt: datetime | None = None
    # Mốc nhân viên bấm "Đánh dấu hoàn tất" ở trang admin, và mốc hồ sơ sẽ tự xoá mềm.
    # None = chưa đánh dấu. Chỉ endpoint admin điền; các endpoint khác để mặc định.
    completedAt: datetime | None = None
    autoDeleteAt: datetime | None = None
    # Lúc file giấy tờ bị xoá sạch sau khi hoàn tất; None = file vẫn còn.
    filesPurgedAt: datetime | None = None

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
    # Theo dõi hạn giấy tờ (backend/doc_checks.py). Chỉ đếm trên hồ sơ CHƯA xoá mềm — giấy
    # tờ của hồ sơ đã xoá thì hết hạn cũng không ai cần làm gì.
    expiredDocuments: int = 0
    expiringSoonDocuments: int = 0
    # Phân bố hồ sơ theo trạng thái nghiệp vụ và theo nhãn, để dashboard vẽ biểu đồ mà không
    # phải tự gom lại từ danh sách hồ sơ (danh sách sẽ phân trang khi dữ liệu lớn dần).
    # Chỉ chứa khoá thực sự có hồ sơ; trạng thái/nhãn nào chưa dùng thì không xuất hiện.
    casesByStatus: dict[str, int] = {}
    casesByTag: dict[str, int] = {}


class EmailLogCaseRowDTO(BaseModel):
    """Một dòng hồ sơ bên trong email đã gửi."""

    client_name: str = ""
    status_label: str = ""
    status_color: str = "#909399"
    updated_at: str = ""
    case_url: str = "#"


class EmailLogDTO(BaseModel):
    id: str
    createdAt: datetime
    trigger: str
    caseId: str | None
    caseClientName: str | None
    applicationStatus: str | None
    title: str
    intro: str | None
    footer: str | None
    # Đã tách sẵn từ casesJson để giao diện không phải tự parse chuỗi JSON.
    cases: list[EmailLogCaseRowDTO] = []
    recipient: str | None
    status: str
    errorMessage: str | None


class AdminDocumentDTO(DocumentDTO):
    # Ghép thêm thông tin case vào để tab "Tài liệu" trong /admin không cần gọi thêm request
    # riêng để tra người nộp là ai — mỗi dòng tài liệu tự đủ thông tin hiển thị.
    caseClientName: str
    caseDeletedAt: datetime | None
