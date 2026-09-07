"""Chuyển dataclass nội bộ (completeness.py) sang Pydantic DTO (schemas.py) — tên field
đổi từ snake_case (Python) sang camelCase (khớp JSON mà frontend Next.js đang dùng)."""
from __future__ import annotations

from datetime import datetime

from completeness import (
    ChecklistItemStatus,
    ChecklistSummary,
    FinancialThreshold,
    SavingsAssessment,
)
from doc_checks import NGAY_CANH_BAO_HAN, DiemBatNhat, HanGiayTo
from schemas import (
    ChecklistItemStatusDTO,
    ChecklistSummaryDTO,
    ConflictValueDTO,
    DataConflictDTO,
    DocChecksDTO,
    DocExpiryDTO,
    FinancialThresholdDTO,
    SavingsAssessmentDTO,
)


def financial_threshold_to_dto(t: FinancialThreshold) -> FinancialThresholdDTO:
    return FinancialThresholdDTO(minVND=t.min_vnd, maxVND=t.max_vnd, isEstimated=t.is_estimated)


def savings_to_dto(a: SavingsAssessment, updated_at: datetime | None) -> SavingsAssessmentDTO:
    return SavingsAssessmentDTO(
        aiVnd=a.ai_vnd,
        aiNote=a.ai_note,
        manualVnd=a.manual_vnd,
        effectiveVnd=a.effective_vnd,
        source=a.source,
        verdict=a.verdict,
        shortOfMinVnd=a.short_of_min_vnd,
        shortOfMaxVnd=a.short_of_max_vnd,
        updatedAt=updated_at,
    )


def checklist_item_status_to_dto(s: ChecklistItemStatus) -> ChecklistItemStatusDTO:
    return ChecklistItemStatusDTO(
        item=s.item,
        requiredCount=s.required_count,
        fulfilledCount=s.fulfilled_count,
        complete=s.complete,
        matchedDocuments=s.matched_documents,
    )


def checklist_summary_to_dto(s: ChecklistSummary) -> ChecklistSummaryDTO:
    return ChecklistSummaryDTO(
        items=[checklist_item_status_to_dto(i) for i in s.items],
        percent=s.percent,
        totalRequiredItems=s.total_required_items,
        completedRequiredItems=s.completed_required_items,
        needsReviewCount=s.needs_review_count,
    )


def doc_checks_to_dto(
    han: list[HanGiayTo], bat_nhat: list[DiemBatNhat]
) -> DocChecksDTO:
    return DocChecksDTO(
        expiries=[
            DocExpiryDTO(
                documentId=h.document_id,
                filename=h.filename,
                itemName=h.item_name,
                expiresAt=h.expires_at,
                source=h.source,
                daysLeft=h.days_left,
                state=h.state,
            )
            for h in han
        ],
        conflicts=[
            DataConflictDTO(
                owner=d.owner,
                ownerLabel=d.owner_label,
                fieldLabel=d.field_label,
                values=[ConflictValueDTO(value=v.value, filename=v.filename) for v in d.values],
            )
            for d in bat_nhat
        ],
        expiredCount=sum(1 for h in han if h.state == "EXPIRED"),
        expiringSoonCount=sum(1 for h in han if h.state == "EXPIRING_SOON"),
        warnDays=NGAY_CANH_BAO_HAN,
    )
