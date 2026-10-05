"""Lịch sử thao tác: danh sách tên nhân viên (công khai, cho ô "Bạn là ai?") + tra cứu cho admin."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

import activity
from admin_auth import require_admin
from db import get_db
from models import ActivityLog, Case, now_utc

router = APIRouter(prefix="/activity", tags=["activity"])

# Múi giờ văn phòng: "hôm nay" phải tính theo giờ Việt Nam, không phải UTC — không thì từ 0h
# tới 7h sáng số liệu "hôm nay" vẫn là của hôm qua.
VN = timezone(timedelta(hours=7))


def _dau_ngay_vn_utc() -> datetime:
    bay_gio_vn = datetime.now(VN)
    dau_ngay = bay_gio_vn.replace(hour=0, minute=0, second=0, microsecond=0)
    return dau_ngay.astimezone(timezone.utc).replace(tzinfo=None)


@router.get("/staff-names")
def staff_names(db: Session = Depends(get_db)) -> list[str]:
    """Gợi ý cho ô "Bạn là ai?": tên đã từng dùng + tên NV quản lý / người nhận hồ sơ đã nhập.

    Công khai (không cần mật khẩu) vì trang Docs chưa có đăng nhập; chỉ lộ tên nhân viên.
    """
    ten: set[str] = set()
    ten.update(n for n in db.scalars(select(ActivityLog.actorName).distinct()) if n)
    ten.update(n for n in db.scalars(select(Case.managerName).distinct()) if n)
    ten.update(n for n in db.scalars(select(Case.receiverName).distinct()) if n)
    return sorted(ten, key=str.casefold)


@router.get("/log", dependencies=[Depends(require_admin)])
def activity_log(
    actor: Optional[str] = None,
    action: Optional[str] = None,
    days: int = 7,
    q: Optional[str] = None,
    before_id: Optional[int] = None,
    limit: int = 200,
    db: Session = Depends(get_db),
):
    """Nhật ký cho tab "Theo dõi Docs". `actor="__none__"` = các dòng không rõ tên.

    Trả kèm bảng tóm tắt theo người (hôm nay) và bảng nhãn thao tác — giao diện không tự khai
    lại nhãn, thêm thao tác mới ở activity.ACTION_LABELS là tab này hiện đúng luôn.
    """
    limit = max(1, min(limit, 500))
    dk = []
    if days > 0:
        dk.append(ActivityLog.createdAt >= now_utc() - timedelta(days=days))
    if actor == "__none__":
        dk.append(ActivityLog.actorName.is_(None))
    elif actor:
        dk.append(ActivityLog.actorName == actor)
    if action:
        dk.append(ActivityLog.action == action)
    if q:
        mau = f"%{q.strip()}%"
        dk.append(or_(ActivityLog.caseClientName.like(mau), ActivityLog.detail.like(mau)))
    if before_id:
        dk.append(ActivityLog.id < before_id)
    rows = db.scalars(
        select(ActivityLog).where(*dk).order_by(ActivityLog.id.desc()).limit(limit + 1)
    ).all()
    con_nua = len(rows) > limit
    rows = rows[:limit]

    # Tóm tắt theo người: hôm nay làm bao nhiêu thao tác, đụng bao nhiêu hồ sơ, lần cuối lúc nào.
    tu = _dau_ngay_vn_utc()
    tom_tat = []
    for ten, so, so_hs, cuoi in db.execute(
        select(
            ActivityLog.actorName,
            func.count(ActivityLog.id),
            func.count(func.distinct(ActivityLog.caseId)),
            func.max(ActivityLog.createdAt),
        )
        .where(ActivityLog.createdAt >= tu, ActivityLog.actorRole == "staff")
        .group_by(ActivityLog.actorName)
    ):
        tom_tat.append({"name": ten, "actionsToday": so, "casesToday": so_hs, "lastAt": cuoi})
    # Người đã từng làm mà hôm nay chưa làm gì cũng phải hiện (0 thao tác) — "hôm nay chưa
    # thấy ai đó đâu" cũng là thông tin admin cần.
    co_roi = {t["name"] for t in tom_tat}
    for ten, cuoi in db.execute(
        select(ActivityLog.actorName, func.max(ActivityLog.createdAt))
        .where(ActivityLog.actorRole == "staff", ActivityLog.createdAt >= now_utc() - timedelta(days=30))
        .group_by(ActivityLog.actorName)
    ):
        if ten not in co_roi:
            tom_tat.append({"name": ten, "actionsToday": 0, "casesToday": 0, "lastAt": cuoi})
    tom_tat.sort(key=lambda t: t["lastAt"] or datetime.min, reverse=True)

    return {
        "items": [
            {
                "id": r.id,
                "createdAt": r.createdAt,
                "actorName": r.actorName,
                "actorRole": r.actorRole,
                "ip": r.ip,
                "device": r.device,
                "action": r.action,
                "caseId": r.caseId,
                "caseClientName": r.caseClientName,
                "documentId": r.documentId,
                "detail": r.detail,
            }
            for r in rows
        ],
        "hasMore": con_nua,
        "people": tom_tat,
        "actions": activity.ACTION_LABELS,
        "retentionDays": activity.RETENTION_DAYS,
    }
