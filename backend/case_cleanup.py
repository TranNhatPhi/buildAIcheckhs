"""Dọn định kỳ: XOÁ VĨNH VIỄN hồ sơ đã hoàn tất quá hạn, và bản dịch tạm quá 7 ngày.

Nhân viên bấm "Hoàn tất" -> Case.autoDeleteAt = hôm nay + CASE_AUTO_DELETE_DAYS (14 ngày). Tới
hạn, tiến trình này XOÁ HẲN hồ sơ: toàn bộ file trên MinIO (file gốc + ảnh từng trang), các dòng
Document, và chính hồ sơ khách hàng — qua case_delete.hard_delete_case, dùng chung với nút "Xoá
vĩnh viễn" của admin.

KHÔNG KHÔI PHỤC ĐƯỢC. Đã đổi hai lần theo yêu cầu nghiệp vụ (25/09/2026): trước là xoá MỀM cả
hồ sơ, rồi thành chỉ xoá file giữ khách, rồi thành xoá hẳn như bây giờ. Hộp xác nhận khi bấm
"Hoàn tất" và khung cảnh báo trên trang hồ sơ phải nói rõ điều này.

Một hồ sơ lỗi không chặn các hồ sơ khác; hồ sơ đó vẫn còn nguyên (MinIO xoá trước, DB sau — xem
case_delete.py) nên vòng quét sau thử lại được.

VÌ SAO LÀ TIẾN TRÌNH RIÊNG, không nhét vào backend: backend chạy NHIỀU REPLICA sau load
balancer (xem docker-compose.yml), nhét việc chạy theo lịch vào đó là mỗi replica chạy một lần —
cùng lý do status_reminder.py tách riêng.
"""
from __future__ import annotations

import argparse
import logging
import os
import time
from datetime import timedelta

from dotenv import load_dotenv
from sqlalchemy import delete, select

load_dotenv(".env.local")
load_dotenv("../.env.local")
load_dotenv("../.env")

import storage  # noqa: E402
from case_auto_status import dong_bo_hoan_thanh, trang_thai_theo_tien_do  # noqa: E402
from case_delete import hard_delete_case  # noqa: E402
from case_status import CASE_AUTO_DELETE_DAYS  # noqa: E402
from db import SessionLocal  # noqa: E402
from completeness import compute_checklist_summary  # noqa: E402
from models import ActivityLog, Case, ChecklistItem, Document, now_utc  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("case-cleanup")

# 1 tiếng, không phải 1 ngày: quét là một câu SELECT trên cột có sẵn nên rẻ, mà hạn xoá rơi
# đúng giờ nhân viên bấm 15 ngày trước chứ không lệch tới gần một ngày như quét theo ngày.
DEFAULT_POLL_SECONDS = 60 * 60

# File của trang "Kiểm tra dịch thuật" là bản tạm để soát — giữ 7 ngày rồi xoá hẳn khỏi MinIO.
# Khai bằng NGÀY chứ không phải giờ vì đây là con số nghiệp vụ người dùng đọc trên giao diện;
# quy đổi ra giờ ngay bên dưới để phép so tuổi file vẫn chính xác tới từng giờ.
TRANSLATION_CHECK_RETENTION_DAYS = int(os.getenv("TRANSLATION_CHECK_RETENTION_DAYS", "7"))
TRANSLATION_CHECK_RETENTION_HOURS = TRANSLATION_CHECK_RETENTION_DAYS * 24

# Quá bấy nhiêu phút mà tài liệu vẫn "đang đọc / đang phân loại" thì chắc chắn đã chết giữa
# chừng. Một file bình thường xong trong 20–150 giây (đo thật, xem AGENTS.md); PDF nhiều trang
# đọc kỹ cũng chỉ vài phút. 30 phút là dư sức, không có lượt nào đang chạy thật bị bắt nhầm.
STUCK_PROCESSING_MINUTES = int(os.getenv("STUCK_PROCESSING_MINUTES", "30"))
TRANG_THAI_DANG_XU_LY = ("PENDING", "OCR_RUNNING", "CLASSIFYING")


def run_once(*, dry_run: bool = False) -> int:
    db = SessionLocal()
    try:
        now = now_utc()
        den_han = db.scalars(
            select(Case).where(
                Case.deletedAt.is_(None),
                Case.autoDeleteAt.is_not(None),
                Case.autoDeleteAt <= now,
            )
        ).all()
        if not den_han:
            logger.info("Không có hồ sơ nào tới hạn xoá vĩnh viễn.")
            return 0

        for case in den_han:
            ten, ma, so_tai_lieu = case.clientName, case.id, len(case.documents)
            if dry_run:
                logger.info("DRY RUN — sẽ XOÁ VĨNH VIỄN hồ sơ '%s' (%s) cùng %s tài liệu.",
                            ten, ma, so_tai_lieu)
                continue
            try:
                so_file = hard_delete_case(db, case)
            except Exception:  # noqa: BLE001
                db.rollback()
                logger.exception("Không xoá được hồ sơ '%s' (%s); vòng sau thử lại.", ten, ma)
                continue
            logger.info("Đã XOÁ VĨNH VIỄN hồ sơ '%s' (%s): %s tài liệu, %s file trên MinIO.",
                        ten, ma, so_tai_lieu, so_file)
        return len(den_han)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def don_ban_dich(*, dry_run: bool = False) -> int:
    """Xoá HẲN các file của trang "Kiểm tra dịch thuật" quá TRANSLATION_CHECK_RETENTION_HOURS.

    Xoá CỨNG chứ không xoá mềm như hồ sơ — ngược hẳn với run_once() ở trên, và cố ý:
      - đây là file TẠM để soát một lượt rồi thôi, không phải hồ sơ khách cần giữ;
      - KHÔNG có bảng DB nào trỏ tới chúng, nên không có chỗ nào đánh dấu "đã xoá" cả, cũng
        không có giao diện nào khôi phục lại được;
      - giữ lại là giấy tờ tuỳ thân của khách (CCCD, khai sinh, hộ khẩu) nằm mãi trên MinIO
        mà không ai nhớ tới.

    Tuổi file lấy từ LastModified của MinIO chứ không phải từ tên thư mục: id lượt kiểm tra là
    uuid4 ngẫu nhiên, không mang thông tin thời gian.

    Vì sao tự đếm thay vì dùng lifecycle rule của MinIO: quy tắc lifecycle của S3 hết hạn vào
    lúc nửa đêm UTC nên trượt tới gần một ngày so với mốc thật. Vòng quét này chạy mỗi giờ nên
    bám sát đúng mốc 7 ngày kể từ lúc tải lên.
    """
    nguong = now_utc() - timedelta(hours=TRANSLATION_CHECK_RETENTION_HOURS)
    try:
        tat_ca = storage.list_objects_with_time(storage.TRANSLATION_CHECK_PREFIX + "/")
    except Exception:
        # MinIO chưa lên / mất mạng: bỏ qua vòng này, giờ sau quét lại. Không được để hỏng
        # luôn phần dọn hồ sơ ở trên vốn chỉ cần MySQL.
        logger.exception("Không liệt kê được bản dịch trên MinIO; sẽ thử lại vòng sau.")
        return 0

    # LastModified của boto3 có tzinfo=UTC, now_utc() lại là datetime "naive" (xem models.py)
    # -> so trực tiếp là TypeError. Bỏ tzinfo đi cho cùng hệ quy chiếu, cả hai đều là UTC.
    qua_han = [k for k, t in tat_ca if t.replace(tzinfo=None) < nguong]
    if not qua_han:
        logger.info("Không có bản dịch nào quá %s ngày.", TRANSLATION_CHECK_RETENTION_DAYS)
        return 0

    if dry_run:
        logger.info("DRY RUN — sẽ xoá %s file bản dịch quá hạn.", len(qua_han))
        return len(qua_han)

    da_xoa = 0
    for key in qua_han:
        try:
            storage.delete_document(key)
            da_xoa += 1
        except Exception:  # noqa: BLE001
            # Một file xoá hỏng không được chặn các file còn lại; vòng sau sẽ thử lại nó.
            logger.exception("Không xoá được %s", key)
    logger.info("Đã xoá %s/%s file bản dịch quá %s ngày.",
                da_xoa, len(qua_han), TRANSLATION_CHECK_RETENTION_DAYS)
    return da_xoa


def don_tai_lieu_ket(*, dry_run: bool = False) -> int:
    """Chuyển tài liệu kẹt ở "đang đọc / đang phân loại" sang LỖI để hiện nút "Thử lại".

    Vì sao kẹt: đọc chữ + phân loại chạy NGAY TRONG request upload chứ không phải việc nền.
    Backend khởi động lại giữa chừng (deploy, build lại image, tắt Docker) là request đó chết
    luôn, còn dòng trong DB mãi mãi đứng ở OCR_RUNNING/CLASSIFYING — không có gì gỡ ra. Đã
    xảy ra thật: 3 file kẹt 43 giờ, trang admin báo "đang phân loại" suốt mà không ai biết.

    Chuyển sang ERROR chứ KHÔNG tự đọc lại: file hỏng thật thì tự đọc lại sẽ lặp mỗi giờ mãi
    mãi. ERROR hiện nút "Thử lại" có sẵn trên giao diện, nhân viên bấm là chạy lại từ file gốc.

    Hồ sơ cũ chưa có processingStartedAt thì lấy uploadedAt thay — cột mới thêm sau.
    """
    db = SessionLocal()
    try:
        nguong = now_utc() - timedelta(minutes=STUCK_PROCESSING_MINUTES)
        dang_xu_ly = db.scalars(
            select(Document).where(Document.status.in_(TRANG_THAI_DANG_XU_LY))
        ).all()
        ket = [d for d in dang_xu_ly if (d.processingStartedAt or d.uploadedAt) < nguong]
        if not ket:
            logger.info("Không có tài liệu nào kẹt ở trạng thái đang xử lý.")
            return 0

        for d in ket:
            logger.warning(
                "%s tài liệu '%s' (%s) kẹt ở %s từ %s.",
                "DRY RUN — sẽ chuyển sang LỖI" if dry_run else "Chuyển sang LỖI",
                d.originalFilename, d.id, d.status, d.processingStartedAt or d.uploadedAt,
            )
            if not dry_run:
                d.status = "ERROR"
                d.classificationError = (
                    "Xử lý bị gián đoạn giữa chừng (máy chủ khởi động lại) — bấm \"Thử lại\" "
                    "để đọc lại từ file gốc."
                )
        if not dry_run:
            db.commit()
        return len(ket)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()



def dong_bo_trang_thai(*, dry_run: bool = False) -> int:
    """Lưới an toàn cho việc tự chuyển "Hoàn thành" theo tiến độ (xem case_auto_status).

    Endpoint nào làm đổi tiến độ đều đã tự đồng bộ ngay; lượt quét này bắt chỗ lọt (vd seed đổi
    checklist làm hồ sơ tụt dưới 100%) và chuyển các hồ sơ đã đủ 100% từ trước khi có tính năng.

    Bỏ qua hồ sơ đang có file đọc/phân loại dở: lúc đó file đang thay bản mới tạm thời không tính
    là đã nộp, tiến độ tụt giả — đồng bộ lúc đó là hồ sơ nhảy khỏi "Hoàn thành" rồi nhảy về.
    """
    db = SessionLocal()
    try:
        items = db.scalars(select(ChecklistItem)).all()
        cases = db.scalars(select(Case).where(Case.deletedAt.is_(None))).all()
        doi = 0
        for case in cases:
            if any(d.status in TRANG_THAI_DANG_XU_LY for d in case.documents):
                continue
            if dry_run:
                tien_do = compute_checklist_summary(
                    items, case.documents, case.maritalStatus, case.numberOfChildren,
                    case.skillLevel, force_complete=case.completedAt is not None,
                ).percent
                moi = trang_thai_theo_tien_do(case.applicationStatus, tien_do)
                if moi:
                    logger.info("DRY RUN — hồ sơ %s (%d%%): %s -> %s", case.id, tien_do, case.applicationStatus, moi)
                    doi += 1
            elif dong_bo_hoan_thanh(db, case, items):
                doi += 1
        if doi:
            logger.info("Tự đồng bộ trạng thái theo tiến độ: %d hồ sơ.", doi)
        return doi
    finally:
        db.close()



def don_nhat_ky(*, dry_run: bool = False) -> int:
    """Xoá lịch sử thao tác cũ hơn ACTIVITY_LOG_RETENTION_DAYS (mặc định 45 ngày) — bảng chỉ
    tăng, mỗi ngày vài trăm dòng, mà không ai tra lại xa tới vậy (xem activity.py)."""
    import activity

    nguong = now_utc() - timedelta(days=activity.RETENTION_DAYS)
    db = SessionLocal()
    try:
        if dry_run:
            n = len(db.scalars(select(ActivityLog.id).where(ActivityLog.createdAt < nguong)).all())
        else:
            n = db.execute(delete(ActivityLog).where(ActivityLog.createdAt < nguong)).rowcount or 0
            db.commit()
        if n:
            logger.info("%s %d dòng lịch sử thao tác cũ hơn %d ngày.",
                        "DRY RUN — sẽ xoá" if dry_run else "Đã xoá", n, activity.RETENTION_DAYS)
        return n
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Tự xoá hồ sơ đã hoàn tất quá hạn giữ")
    parser.add_argument("--once", action="store_true", help="Quét một lần rồi thoát")
    parser.add_argument("--dry-run", action="store_true", help="Chỉ in ra, không xoá")
    args = parser.parse_args()

    if args.once:
        run_once(dry_run=args.dry_run)
        don_ban_dich(dry_run=args.dry_run)
        don_tai_lieu_ket(dry_run=args.dry_run)
        dong_bo_trang_thai(dry_run=args.dry_run)
        don_nhat_ky(dry_run=args.dry_run)
        return

    poll_seconds = int(os.getenv("CASE_CLEANUP_POLL_SECONDS", str(DEFAULT_POLL_SECONDS)))
    logger.info(
        "Bắt đầu quét mỗi %s giây; hồ sơ đánh dấu hoàn tất bị XOÁ VĨNH VIỄN sau %s ngày, "
        "bản dịch tạm tự xoá sau %s ngày.",
        poll_seconds, CASE_AUTO_DELETE_DAYS, TRANSLATION_CHECK_RETENTION_DAYS,
    )
    while True:
        try:
            run_once(dry_run=args.dry_run)
            don_ban_dich(dry_run=args.dry_run)
            don_tai_lieu_ket(dry_run=args.dry_run)
            dong_bo_trang_thai(dry_run=args.dry_run)
            don_nhat_ky(dry_run=args.dry_run)
        except Exception:
            # Phải sống để quét lại vòng sau: một lần mất kết nối MySQL không đáng để dừng
            # hẳn việc dọn, mà chết đi thì không ai biết (cùng lý do với status_reminder.py).
            logger.exception("Quét dọn hồ sơ thất bại; sẽ thử lại ở vòng kế tiếp.")
        time.sleep(poll_seconds)


if __name__ == "__main__":
    main()
