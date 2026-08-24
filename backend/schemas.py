from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class CreateCaseRequest(BaseModel):
    clientName: str = Field(min_length=1)
    maritalStatus: Literal["SINGLE", "MARRIED"]
    numberOfChildren: int = Field(ge=0, le=20)
    notes: str | None = None


class UpdateCaseRequest(BaseModel):
    # Tất cả field optional — PATCH chỉ cập nhật field nào thực sự được gửi lên (dùng
    # exclude_unset khi áp dụng), không bắt buộc gửi đủ như lúc tạo mới.
    clientName: str | None = Field(default=None, min_length=1)
    maritalStatus: Literal["SINGLE", "MARRIED"] | None = None
    numberOfChildren: int | None = Field(default=None, ge=0, le=20)
    notes: str | None = None


class PatchDocumentRequest(BaseModel):
    matchedChecklistItemId: str | None


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
    aiRawLabel: str | None
    aiConfidence: float | None
    aiReasoning: str | None
    status: str
    classificationError: str | None
    isManualOverride: bool

    class Config:
        from_attributes = True


class FinancialThresholdDTO(BaseModel):
    minVND: int
    maxVND: int
    isEstimated: bool


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
    notes: str | None
    createdAt: datetime

    class Config:
        from_attributes = True


class CaseListItemDTO(CaseDTO):
    percent: int
    needsReviewCount: int
    financialThreshold: FinancialThresholdDTO


class CaseWithDocumentsDTO(CaseDTO):
    documents: list[DocumentDTO]


class CaseDetailDTO(BaseModel):
    case: CaseWithDocumentsDTO
    checklist: ChecklistSummaryDTO
    financialThreshold: FinancialThresholdDTO
