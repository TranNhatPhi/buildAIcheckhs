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
from schemas import (
    ChecklistItemStatusDTO,
    ChecklistSummaryDTO,
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
