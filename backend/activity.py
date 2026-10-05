"""Lịch sử thao tác — admin xem ở tab "Theo dõi Docs" (/admin/theo-doi).

NHẬN DIỆN NGƯỜI THAO TÁC: trang Docs chưa có đăng nhập. Nhân viên tự chọn tên khi mở trang
(components/StaffIdentity.tsx), tên nằm trong cookie `docs_staff`. Trình duyệt tự gửi cookie
kèm MỌI request cùng tên miền — fetch, upload, cả link tải file/ZIP — nên không phải sửa từng
nút bấm. Đây KHÔNG phải xác thực: ai cũng chọn được tên người khác. Đủ để theo dõi công việc
hằng ngày, không đủ làm bằng chứng.

CÁCH GHI: middleware (main.py) nhận diện người gọi MỘT lần cho mỗi request rồi cất vào
contextvar; endpoint chỉ gọi ghi(...) SAU KHI thao tác đã commit. Starlette chép contextvar sang
threadpool nên endpoint `def` thường vẫn đọc được. Ghi hỏng thì chỉ log lỗi — nhật ký hỏng
không bao giờ được làm hỏng thao tác chính của nhân viên.
"""
from __future__ import annotations

import contextvars
import ipaddress
import logging
import os
import secrets
import unicodedata
import urllib.parse
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import SessionLocal
from models import ActivityLog, now_utc

logger = logging.getLogger(__name__)

COOKIE_NAME = "docs_staff"
MAX_NAME_LEN = 60
# Xoá nhật ký cũ hơn bấy nhiêu ngày (case_cleanup.py) — bảng chỉ tăng, không ai đọc lại quá xa.
RETENTION_DAYS = int(os.getenv("ACTIVITY_LOG_RETENTION_DAYS", "45"))

# Mã thao tác -> nhãn tiếng Việt. Giao diện lấy bảng này từ API, không tự khai lại.
ACTION_LABELS = {
    "CASE_CREATE": "Tạo hồ sơ",
    "CASE_VIEW": "Mở hồ sơ",
    "CASE_EDIT": "Sửa thông tin hồ sơ",
    "STATUS_CHANGE": "Đổi trạng thái",
    "TAGS_EDIT": "Đổi nhãn",
    "CASE_DELETE": "Xoá hồ sơ",
    "CASE_RESTORE": "Khôi phục hồ sơ",
    "CASE_PURGE": "Xoá vĩnh viễn hồ sơ",
    "CASE_COMPLETE": "Bấm Hoàn tất",
    "CASE_UNCOMPLETE": "Bỏ Hoàn tất",
    "CASE_RESUBMIT": "Nộp lại",
    "DOC_UPLOAD": "Upload file",
    "DOC_OPEN": "Mở file",
    "DOC_DELETE": "Xoá file",
    "DOC_DELETE_ALL": "Xoá tất cả file",
    "DOC_ASSIGN": "Gán file vào mục",
    "DOC_RECLASSIFY": "Phân tích lại file",
    "DOC_EDIT_TEXT": "Sửa chữ đọc được",
    "DOC_EDIT_EXPIRY": "Sửa ngày hết hạn",
    "ZIP_DOWNLOAD": "Tải ZIP",
    "AI_ANALYZE": "Chạy phân tích AI",
    "SAVINGS_DETECT": "Đọc số dư tiết kiệm",
    "SAVINGS_EDIT": "Sửa số dư tiết kiệm",
    "TRANSLATION_CHECK": "Kiểm tra bản dịch",
    # Dùng chung cho mẫu hợp đồng lao động và mẫu thư xác nhận kinh nghiệm — chi tiết mở đầu bằng
    # [HĐLĐ] / [Thư XNKN] (routers/contract_templates.py) cho biết loại nào.
    "TEMPLATE_UPLOAD": "Thêm mẫu giấy tờ",
    "TEMPLATE_DELETE": "Xoá mẫu giấy tờ",
    "TEMPLATE_ASSIGN": "Đổi công ty của mẫu",
    "TEMPLATE_DOWNLOAD": "Tải mẫu (ZIP)",
}

# Thao tác CHỈ XEM được gộp: cùng người xem lại cùng thứ trong khoảng này thì không ghi thêm dòng.
# Trang hồ sơ tự tải lại sau mỗi thao tác — không gộp thì một lần làm việc sinh cả chục dòng
# "Mở hồ sơ" che mất các thao tác thật.
_GOP_PHUT = {"CASE_VIEW": 30, "DOC_OPEN": 10}


@dataclass(frozen=True)
class NguoiThaoTac:
    name: Optional[str]
    ip: Optional[str]
    device: Optional[str]
    admin: bool


_hien_tai: contextvars.ContextVar[Optional[NguoiThaoTac]] = contextvars.ContextVar(
    "nguoi_thao_tac", default=None
)


def chuan_hoa_ten(raw: Optional[str]) -> Optional[str]:
    """Tên từ cookie (đã encodeURIComponent phía trình duyệt) -> tên sạch, hoặc None."""
    if not raw:
        return None
    try:
        ten = urllib.parse.unquote(raw)
    except Exception:  # noqa: BLE001
        return None
    ten = " ".join(unicodedata.normalize("NFC", ten).split())[:MAX_NAME_LEN]
    return ten or None


def mo_ta_thiet_bi(ua: Optional[str]) -> Optional[str]:
    """User-Agent -> "Chrome · Windows" — đủ để phân biệt máy, không cần chuỗi UA dài ngoằng."""
    if not ua:
        return None
    if "Edg/" in ua:
        trinh_duyet = "Edge"
    elif "Chrome/" in ua and "Chromium" not in ua:
        trinh_duyet = "Chrome"
    elif "Firefox/" in ua:
        trinh_duyet = "Firefox"
    elif "Safari/" in ua:
        trinh_duyet = "Safari"
    else:
        trinh_duyet = None
    if "iPhone" in ua or "iPad" in ua:
        he = "iOS"
    elif "Android" in ua:
        he = "Android"
    elif "Windows" in ua:
        he = "Windows"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        he = "macOS"
    elif "Linux" in ua:
        he = "Linux"
    else:
        he = None
    phan = [p for p in (trinh_duyet, he) if p]
    return " · ".join(phan) if phan else ua[:60]


def _ip_noi_bo_docker(ip: Optional[str]) -> bool:
    try:
        return ip is not None and ipaddress.ip_address(ip) in ipaddress.ip_network("172.16.0.0/12")
    except ValueError:
        return False


def nhan_dien(headers, cookies, client_host: Optional[str]) -> NguoiThaoTac:
    # Caddy ghi IP thật của trình duyệt vào X-Forwarded-For.
    ip = (headers.get("x-forwarded-for") or "").split(",")[0].strip() or client_host
    # Trang server-render (lib/serverApi.ts) gọi API từ TRONG container frontend: IP nhìn thấy
    # là IP Docker, IP thật nằm ở header nó chuyển tiếp. Chỉ tin header này khi request đúng là
    # đi ra từ mạng Docker — từ ngoài gửi lên thì bỏ qua.
    if _ip_noi_bo_docker(ip) and headers.get("x-docs-client-ip"):
        ip = headers.get("x-docs-client-ip").split(",")[0].strip()
    # Docker Desktop trên Windows NAT mọi kết nối vào cổng 80/443 thành IP cổng Docker
    # (172.18.0.1) — đo thật 29/09: mọi máy đều ra đúng một IP đó. Ghi con số ấy chỉ gây hiểu lầm
    # "cả văn phòng dùng chung một máy", nên bỏ trống; cột "Máy" vẫn còn trình duyệt · hệ điều hành.
    # Trên máy chủ Linux, Docker giữ nguyên IP nguồn nên IP thật sẽ tự hiện.
    if _ip_noi_bo_docker(ip):
        ip = None
    expected = os.environ.get("ADMIN_PASSWORD", "")
    mk = headers.get("x-admin-password")
    return NguoiThaoTac(
        name=chuan_hoa_ten(cookies.get(COOKIE_NAME)),
        ip=ip[:64] if ip else None,
        device=mo_ta_thiet_bi(headers.get("x-docs-user-agent") or headers.get("user-agent")),
        admin=bool(mk and expected and secrets.compare_digest(mk, expected)),
    )


def dat(nguoi: NguoiThaoTac):
    return _hien_tai.set(nguoi)


def bo(token) -> None:
    _hien_tai.reset(token)


def nguoi_hien_tai() -> Optional[NguoiThaoTac]:
    return _hien_tai.get()


def ghi(
    action: str,
    *,
    case=None,
    case_id: Optional[str] = None,
    client_name: Optional[str] = None,
    document=None,
    detail: Optional[str] = None,
) -> None:
    """Ghi một dòng lịch sử. Gọi SAU khi thao tác chính đã commit; không bao giờ ném lỗi.

    Dùng phiên DB RIÊNG chứ không dùng phiên của endpoint: commit ở phiên chung sẽ làm hết hạn
    mọi object endpoint đang cầm (phải đọc lại từ DB), và ghi hỏng thì rollback lây sang phiên
    đang làm việc thật.
    """
    nguoi = _hien_tai.get()
    if nguoi is None:  # gọi ngoài request (tiến trình nền) — không có ai để ghi
        return
    gop = _GOP_PHUT.get(action)
    # Chỉ-xem: bỏ qua khi không biết ai xem, hoặc admin xem (tab này theo dõi DOCS).
    if gop is not None and (not nguoi.name or nguoi.admin):
        return
    db = None
    try:
        # Đọc thuộc tính TRƯỚC khi mở phiên mới — object thuộc phiên của endpoint.
        document_id = getattr(document, "id", None)
        if case is not None:
            case_id = case_id or case.id
            client_name = client_name or case.clientName
        if document is not None:
            case_id = case_id or document.caseId
        db = SessionLocal()
        if gop is not None:
            dieu_kien = [
                ActivityLog.actorName == nguoi.name,
                ActivityLog.action == action,
                ActivityLog.createdAt >= now_utc() - timedelta(minutes=gop),
                (ActivityLog.documentId == document_id) if document_id else (ActivityLog.caseId == case_id),
            ]
            if db.scalars(select(ActivityLog.id).where(*dieu_kien).limit(1)).first() is not None:
                return
        db.add(ActivityLog(
            actorName=nguoi.name,
            actorRole="admin" if nguoi.admin else "staff",
            ip=nguoi.ip,
            device=nguoi.device,
            action=action,
            caseId=case_id,
            caseClientName=client_name[:191] if client_name else None,
            documentId=document_id,
            detail=detail,
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("Không ghi được lịch sử thao tác %s", action)
    finally:
        if db is not None:
            db.close()


def ten_muc(db: Session, item_id: Optional[str]) -> Optional[str]:
    """Tên mục checklist để ghi vào chi tiết (vd "Hộ chiếu") — dùng phiên của endpoint, chỉ đọc."""
    if not item_id:
        return None
    try:
        from models import ChecklistItem

        item = db.get(ChecklistItem, item_id)
        return item.nameVi if item else item_id
    except Exception:  # noqa: BLE001
        return item_id


def nhan_trang_thai(value: Optional[str]) -> str:
    from case_status import CASE_STATUS_DEFINITIONS

    return next((d["label"] for d in CASE_STATUS_DEFINITIONS if d["value"] == value), value or "?")


# Tên hiển thị các trường trong "Sửa thông tin hồ sơ".
TEN_TRUONG = {
    "clientName": "tên khách",
    "maritalStatus": "hôn nhân",
    "numberOfChildren": "số con",
    "skillLevel": "tay nghề",
    "partner": "nguồn/đối tác",
    "receiverName": "người nhận hồ sơ",
    "managerName": "NV quản lý",
    "saleName": "sale",
    "occupation": "nghề nghiệp",
    "experienceMonths": "kinh nghiệm",
    "experienceUnits": "đơn vị xác nhận kinh nghiệm",
    "notes": "ghi chú",
}
