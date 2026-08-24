"""Chuyển dataclass nội bộ (completeness.py) sang Pydantic DTO (schemas.py) — tên field
đổi từ snake_case (Python) sang camelCase (khớp JSON mà frontend Next.js đang dùng)."""
from completeness import ChecklistItemStatus, ChecklistSummary, FinancialThreshold
from schemas import (
    ChecklistItemStatusDTO,
    ChecklistSummaryDTO,
    FinancialThresholdDTO,
)


def financial_threshold_to_dto(t: FinancialThreshold) -> FinancialThresholdDTO:
    return FinancialThresholdDTO(minVND=t.min_vnd, maxVND=t.max_vnd, isEstimated=t.is_estimated)


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
