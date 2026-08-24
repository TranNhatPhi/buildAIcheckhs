"""Tính đủ/thiếu checklist + ngưỡng tài chính. Port từ lib/completeness.ts (Next.js)."""
from dataclasses import dataclass, field

from models import ChecklistItem, Document

FULFILLED_STATUSES = {"CLASSIFIED", "MANUALLY_SET"}


def is_item_applicable(item: ChecklistItem, marital_status: str, number_of_children: int) -> bool:
    if item.appliesTo == "ALWAYS":
        return True
    if item.appliesTo == "SPOUSE":
        return marital_status == "MARRIED"
    if item.appliesTo == "CHILDREN":
        # Mục chỉ dành riêng cho con cái (vd giấy khai sinh con cái, tách riêng khỏi
        # vợ/chồng) — khác DEPENDENTS ở chỗ KHÔNG áp dụng chỉ vì đã kết hôn chưa có con.
        return number_of_children > 0
    # DEPENDENTS (mục 28 — hình thẻ trắng): áp dụng khi có vợ/chồng HOẶC có ít nhất 1 con
    return marital_status == "MARRIED" or number_of_children > 0


def required_count(item: ChecklistItem, marital_status: str, number_of_children: int) -> int:
    if item.quantityRule == "PER_CHILD":
        # Mục chỉ tính theo số con, không cộng thêm cho vợ/chồng (khác PER_DEPENDENT).
        return number_of_children
    if item.quantityRule != "PER_DEPENDENT":
        return 1
    # Mục 28 cần 1 document cho mỗi người: vợ/chồng (nếu có) + từng con. v1 không
    # track document nào ứng với người nào cụ thể — chỉ đếm tổng số document đã khớp
    # mục này so với tổng số người kỳ vọng.
    return (1 if marital_status == "MARRIED" else 0) + number_of_children


@dataclass
class ChecklistItemStatus:
    item: ChecklistItem
    required_count: int
    fulfilled_count: int
    complete: bool
    matched_documents: list[Document] = field(default_factory=list)


@dataclass
class ChecklistSummary:
    items: list[ChecklistItemStatus]
    percent: int
    total_required_items: int
    completed_required_items: int
    needs_review_count: int


def compute_checklist_summary(
    all_items: list[ChecklistItem],
    documents: list[Document],
    marital_status: str,
    number_of_children: int,
) -> ChecklistSummary:
    applicable_items = sorted(
        (i for i in all_items if is_item_applicable(i, marital_status, number_of_children)),
        key=lambda i: i.order,
    )

    statuses: list[ChecklistItemStatus] = []
    for item in applicable_items:
        matched = [
            d
            for d in documents
            if d.matchedChecklistItemId == item.id and d.status in FULFILLED_STATUSES
        ]
        required = required_count(item, marital_status, number_of_children)
        statuses.append(
            ChecklistItemStatus(
                item=item,
                required_count=required,
                fulfilled_count=len(matched),
                complete=len(matched) >= required,
                matched_documents=matched,
            )
        )

    # Cặp "chỉ cần 1 trong 2" (vd CCCD vợ / CCCD chồng) — hễ 1 bên đủ thì coi cả 2 đủ, vì
    # 1 hồ sơ chỉ có đúng 1 người (vợ hoặc chồng), không bao giờ cần cả 2 cùng lúc.
    by_id = {s.item.id: s for s in statuses}
    for status in statuses:
        partner = by_id.get(status.item.eitherWithId) if status.item.eitherWithId else None
        if partner and (status.complete or partner.complete):
            status.complete = True
            partner.complete = True

    required_statuses = [s for s in statuses if not s.item.isOptional]
    completed_required_items = sum(1 for s in required_statuses if s.complete)
    total_required_items = len(required_statuses)
    percent = (
        100
        if total_required_items == 0
        else round(100 * completed_required_items / total_required_items)
    )

    needs_review_count = sum(1 for d in documents if d.status in ("NEEDS_REVIEW", "ERROR"))

    return ChecklistSummary(
        items=statuses,
        percent=percent,
        total_required_items=total_required_items,
        completed_required_items=completed_required_items,
        needs_review_count=needs_review_count,
    )


@dataclass
class FinancialThreshold:
    min_vnd: int
    max_vnd: int
    is_estimated: bool


def compute_financial_threshold_vnd(marital_status: str, number_of_children: int) -> FinancialThreshold:
    """
    Bậc thang lấy đúng theo checklist gốc cho 0/1/2 con; từ con thứ 3 ngoại suy
    "+50 triệu/con" theo ghi chú "(Thêm 1 người thì tăng thêm 50 triệu)" trong docx gốc.
    """
    if number_of_children == 0:
        if marital_status == "SINGLE":
            return FinancialThreshold(100_000_000, 150_000_000, False)
        return FinancialThreshold(200_000_000, 300_000_000, False)

    if number_of_children == 1:
        base = 350_000_000
    elif number_of_children == 2:
        base = 400_000_000
    else:
        base = 400_000_000 + (number_of_children - 2) * 50_000_000

    # Checklist gốc không định nghĩa mức cho "độc thân + có con" hoặc từ con thứ 3
    # trở lên — hai trường hợp này được đánh dấu ước tính thay vì coi là chính thức.
    is_estimated = number_of_children > 2 or marital_status == "SINGLE"

    return FinancialThreshold(base, base, is_estimated)
