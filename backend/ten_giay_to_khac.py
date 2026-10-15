"""Tên riêng cho 5 ô "Giấy tờ khác 1..5 (nếu có)" ở cuối checklist (14/10/2026, Docs yêu cầu: được sửa
"Giấy tờ khác 1" thành tên giấy thật, vd "Giấy khai sinh con 3").

Mục checklist DÙNG CHUNG mọi hồ sơ nên KHÔNG sửa ChecklistItem.nameVi — tên lưu ở Case.otherDocNames
(JSON {"<id mục>": "<tên>"}) và chỉ được THAY VÀO DỮ LIỆU TRẢ RA (DTO): trang hồ sơ, ô "Khớp mục",
hồ sơ hoàn thành. Xếp file theo tên file (filename_rules) vẫn dùng tên gốc — ô không có loại giấy nên
số trong tên file luôn được tin.
"""
from __future__ import annotations

import json

TOI_DA = 120


def la_o_giay_to_khac(item_id: str | None) -> bool:
    return bool(item_id) and "giay-to-khac-" in item_id


def doc_ten(case) -> dict[str, str]:
    try:
        d = json.loads(case.otherDocNames or "{}")
    except (TypeError, ValueError):
        return {}
    return {k: v for k, v in d.items() if isinstance(k, str) and isinstance(v, str) and v.strip()} if isinstance(d, dict) else {}


def ghi_ten(case, item_id: str, ten: str) -> dict[str, str]:
    d = doc_ten(case)
    ten = " ".join((ten or "").split())[:TOI_DA]
    if ten:
        d[item_id] = ten
    else:
        d.pop(item_id, None)  # để trống = về tên mặc định
    case.otherDocNames = json.dumps(d, ensure_ascii=False) if d else None
    return d


def ap_vao_case_detail(dto, ten: dict[str, str]) -> None:
    """Thay tên trong CaseDetailDTO (pydantic, sửa tại chỗ): checklist + mục khớp của từng file."""
    if not ten:
        return
    for s in dto.checklist.items:
        if s.item.id in ten:
            s.item.nameVi = ten[s.item.id]
        for d in s.matchedDocuments:
            if d.matchedChecklistItem is not None and d.matchedChecklistItem.id in ten:
                d.matchedChecklistItem.nameVi = ten[d.matchedChecklistItem.id]
    for d in dto.case.documents:
        if d.matchedChecklistItem is not None and d.matchedChecklistItem.id in ten:
            d.matchedChecklistItem.nameVi = ten[d.matchedChecklistItem.id]
