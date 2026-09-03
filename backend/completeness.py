"""Tính đủ/thiếu checklist + ngưỡng tài chính. Port từ lib/completeness.ts (Next.js)."""
from __future__ import annotations

from dataclasses import dataclass, field

from models import ChecklistItem, Document

FULFILLED_STATUSES = {"CLASSIFIED", "MANUALLY_SET"}


# Số con tối thiểu cần để mục "CHILD_N" / "SPOUSE_CHILD_N" áp dụng — checklist nguồn (4 file
# .md của khách hàng) chỉ định nghĩa giấy tờ riêng cho tối đa 3 con (con 1/2/3), không có mục
# tổng quát "mọi con thứ N+" nữa như model cũ (PER_CHILD/PER_DEPENDENT).
_CHILD_MIN_COUNT = {"CHILD_1": 1, "CHILD_2": 2, "CHILD_3": 3,
                    "SPOUSE_CHILD_1": 1, "SPOUSE_CHILD_2": 2, "SPOUSE_CHILD_3": 3}


def is_item_applicable(
    item: ChecklistItem, marital_status: str, number_of_children: int, skill_level: str
) -> bool:
    # Mỗi skill level có bộ checklist HOÀN TOÀN riêng (xem seed.py) — lọc trước tiên, không
    # liên quan gì tới appliesTo bên dưới.
    if item.skillLevel != skill_level:
        return False

    applies_to = item.appliesTo
    if applies_to == "ALWAYS":
        return True
    if applies_to == "SPOUSE":
        return marital_status == "MARRIED"
    if applies_to == "SINGLE":
        return marital_status == "SINGLE"
    if applies_to in _CHILD_MIN_COUNT:
        # "SPOUSE_CHILD_N" (checklist HIGH_SKILL): mục riêng cho từng con nhưng CHỈ áp dụng
        # khi đã kết hôn — checklist gốc không có mục cho con khi đương đơn còn độc thân.
        # "CHILD_N" (checklist LOW_SKILL): áp dụng chỉ theo số con, không cần đã kết hôn.
        if applies_to.startswith("SPOUSE_") and marital_status != "MARRIED":
            return False
        return number_of_children >= _CHILD_MIN_COUNT[applies_to]
    return False


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
    skill_level: str,
) -> ChecklistSummary:
    applicable_items = sorted(
        (
            i
            for i in all_items
            if is_item_applicable(i, marital_status, number_of_children, skill_level)
        ),
        key=lambda i: i.order,
    )

    statuses: list[ChecklistItemStatus] = []
    for item in applicable_items:
        matched = [
            d
            for d in documents
            if d.matchedChecklistItemId == item.id and d.status in FULFILLED_STATUSES
        ]
        # Mỗi mục trong checklist mới (4 file .md khách hàng gửi) là 1 giấy tờ cụ thể, kể cả
        # với vợ/chồng/từng con (đã tách thành mục riêng theo tên, vd "hs-child1-passport")
        # — không còn mục nào cần NHIỀU document mới coi là đủ như model cũ (PER_DEPENDENT).
        required = 1
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


# Mục checklist chứa TIỀN MẶT chứng minh tài chính. Nhận diện theo mẩu chuỗi trong id thay vì
# liệt kê cứng 6 id: cùng một mục lặp lại ở cả 3 bộ với tiền tố khác nhau ("so-tiet-kiem",
# "hs-so-tiet-kiem", "hs-spouse-so-tiet-kiem" — xem seed.py), và bộ checklist còn được sửa/
# thêm theo yêu cầu khách hàng, nên danh sách cứng sẽ âm thầm bỏ sót mục mới.
#
# CỐ Ý KHÔNG tính "Quyền sử dụng đất" / "giay-to-nha-dat": đó là tài sản, không phải số dư
# tài khoản — cộng vào sẽ thổi phồng con số quyết định "đủ tiền hay không".
_SAVINGS_ID_MARKERS = ("tiet-kiem", "so-du")


def is_savings_item(item_id: str | None) -> bool:
    return bool(item_id) and any(m in item_id for m in _SAVINGS_ID_MARKERS)


@dataclass
class SavingsAssessment:
    """Đối chiếu số dư THẬT của khách với mức yêu cầu (compute_financial_threshold_vnd)."""

    threshold: FinancialThreshold
    ai_vnd: int | None
    ai_note: str | None
    manual_vnd: int | None
    effective_vnd: int | None
    # "MANUAL" (nhân viên tự nhập) | "AI" (AI đọc từ giấy tờ) | "NONE" (chưa có số nào)
    source: str
    # "ENOUGH" (đạt cả mức an toàn) | "BORDERLINE" (qua mức tối thiểu nhưng chưa tới mức an
    # toàn) | "SHORT" (chưa đủ mức tối thiểu) | "UNKNOWN" (chưa đọc được số dư nào)
    verdict: str
    # Còn thiếu bao nhiêu để chạm mức TỐI THIỂU, và bao nhiêu để chạm mức AN TOÀN. 0 nghĩa
    # là đã đạt mức đó rồi.
    short_of_min_vnd: int
    short_of_max_vnd: int


def assess_savings(
    marital_status: str,
    number_of_children: int,
    ai_vnd: int | None,
    ai_note: str | None,
    manual_vnd: int | None,
) -> SavingsAssessment:
    threshold = compute_financial_threshold_vnd(marital_status, number_of_children)

    # Nhân viên nhập tay thì LUÔN thắng số AI đọc — giống hệt cách manualCorrectedText đè
    # correctedText ở Document. Người đã tự mở giấy tờ ra xem thì đáng tin hơn máy đọc ảnh.
    if manual_vnd is not None:
        effective, source = manual_vnd, "MANUAL"
    elif ai_vnd is not None:
        effective, source = ai_vnd, "AI"
    else:
        effective, source = None, "NONE"

    if effective is None:
        verdict = "UNKNOWN"
        short_of_min = short_of_max = 0
    else:
        short_of_min = max(0, threshold.min_vnd - effective)
        short_of_max = max(0, threshold.max_vnd - effective)
        if short_of_min > 0:
            verdict = "SHORT"
        elif short_of_max > 0:
            # Chỉ xảy ra với hồ sơ không con, nơi checklist gốc cho một KHOẢNG (vd độc thân
            # 100-150 triệu) chứ không một con số. Nằm trong khoảng nghĩa là đã qua mức tối
            # thiểu nhưng chưa tới mức khách hàng vẫn khuyên nên có — nói rõ thay vì gộp
            # chung vào "đủ", vì gộp là giấu mất rủi ro trượt.
            verdict = "BORDERLINE"
        else:
            verdict = "ENOUGH"

    return SavingsAssessment(
        threshold=threshold,
        ai_vnd=ai_vnd,
        ai_note=ai_note,
        manual_vnd=manual_vnd,
        effective_vnd=effective,
        source=source,
        verdict=verdict,
        short_of_min_vnd=short_of_min,
        short_of_max_vnd=short_of_max,
    )
