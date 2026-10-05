"""Mẫu giấy tờ theo công ty — thư viện mẫu có ảnh xem trước từng trang, bấm vào xem chi tiết (xem
contract_preview.py). Mỗi loại (cột `kind`) một trang riêng ở Docs nhưng dùng chung API này:
    HDLD — "Mẫu hợp đồng lao động"          (/mau-hop-dong)              Word / PDF
    XNKN — "Mẫu thư xác nhận kinh nghiệm"   (/mau-xac-nhan-kinh-nghiem)  Word / PDF
    PL   — "Mẫu phiếu lương"                (/mau-phieu-luong)           Excel
API danh sách / thêm / nhập zip / tải zip nhận `kind` (mặc định HDLD — giữ nguyên hành vi cũ); API
theo id thì không cần vì id đã xác định mẫu.

Công khai như mọi API trang Docs (chưa có đăng nhập). Mọi thao tác thêm/xoá đều ghi vào lịch sử
"Theo dõi Docs" để admin biết ai đã đổi bộ mẫu dùng chung.
"""
from __future__ import annotations

import io
import logging
import os
import unicodedata
import uuid
import zipfile
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

import activity
import contract_preview
import storage
from db import get_db
from models import ContractTemplate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/contract-templates", tags=["contract-templates"])

PREFIX = contract_preview.PREFIX
MAX_BYTES = 20 * 1024 * 1024
# Đuôi file -> MIME. Mỗi loại mẫu chỉ nhận một phần trong số này (LOAI_MAU[...]["duoi"]) — chặn
# loại khác cho khỏi lẫn file rác.
DUOI_CHO_PHEP = {
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
# Ký tự làm hỏng cú pháp header Content-Disposition: nháy kép, gạch chéo ngược, dấu hỏi.
KY_TU_HONG_HEADER = {'"', "?", chr(92)}

# Loại mẫu -> nhãn ngắn ghi vào lịch sử Theo dõi Docs, tên file zip khi tải nhiều mẫu, đuôi file
# nhận và cách gọi các đuôi đó trong thông báo lỗi.
_WORD_PDF = {"duoi": {".doc", ".docx", ".pdf"}, "ten_duoi": "Word (.doc, .docx) hoặc PDF"}
LOAI_MAU = {
    "HDLD": {"nhan": "HĐLĐ", "zip": "Mau-hop-dong-lao-dong", **_WORD_PDF},
    "XNKN": {"nhan": "Thư XNKN", "zip": "Mau-thu-xac-nhan-kinh-nghiem", **_WORD_PDF},
    "PL": {"nhan": "Phiếu lương", "zip": "Mau-phieu-luong", "duoi": {".xls", ".xlsx"}, "ten_duoi": "Excel (.xls, .xlsx)"},
}


def _loai(kind: Optional[str]) -> str:
    k = (kind or "HDLD").strip().upper()
    if k not in LOAI_MAU:
        raise HTTPException(status_code=400, detail="Loại mẫu không hợp lệ.")
    return k


def _nhan(kind: str) -> str:
    """Tiền tố chi tiết lịch sử — cùng mã thao tác TEMPLATE_* cho mọi loại mẫu."""
    return f"[{LOAI_MAU.get(kind, LOAI_MAU['HDLD'])['nhan']}]"


def _sach(s: Optional[str]) -> str:
    return " ".join(unicodedata.normalize("NFC", s or "").split())


def _duoi(t: ContractTemplate) -> str:
    return os.path.splitext(t.originalFilename.lower())[1]


def _dto(t: ContractTemplate) -> dict:
    return {
        "id": t.id,
        "kind": t.kind,
        "companyName": t.companyName,
        "title": t.title,
        "originalFilename": t.originalFilename,
        "mimeType": t.mimeType,
        "fileSizeBytes": t.fileSizeBytes,
        "notes": t.notes,
        "uploadedBy": t.uploadedBy,
        "createdAt": t.createdAt,
        # Số trang bản xem trước; null = chưa có ảnh xem trước (giao diện hiện biểu tượng thay ảnh).
        "pageCount": t.pageCount,
    }


def _content_disposition(filename: str, tai_ve: bool) -> str:
    """Tên file tiếng Việt: header HTTP chỉ nhận ASCII -> filename= ASCII dự phòng + filename*=UTF-8
    (RFC 5987), cùng cách với routers/documents.py."""
    ascii_fallback = "".join(
        ch if 32 <= ord(ch) < 127 and ch not in KY_TU_HONG_HEADER else "_" for ch in filename
    )
    kieu = "attachment" if tai_ve else "inline"
    return f"{kieu}; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def _lay(db: Session, template_id: str) -> ContractTemplate:
    t = db.get(ContractTemplate, template_id)
    if not t:
        raise HTTPException(status_code=404, detail="Không tìm thấy mẫu")
    return t


def _tao_xem_truoc(db: Session, t: ContractTemplate, content: bytes) -> None:
    """Tạo ảnh xem trước; hỏng thì chỉ ghi log — mẫu vẫn tải về dùng được, chỉ thiếu ảnh."""
    try:
        t.pageCount = contract_preview.tao_ban_xem_truoc(t.id, content, _duoi(t))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Không tạo được bản xem trước cho mẫu %s", t.id)


@router.get("")
def list_templates(kind: str = "HDLD", db: Session = Depends(get_db)):
    rows = list(db.scalars(select(ContractTemplate).where(ContractTemplate.kind == _loai(kind))).all())
    rows.sort(key=lambda t: (t.companyName.casefold(), t.title.casefold()))
    return [_dto(t) for t in rows]


@router.post("", status_code=201)
def upload_template(
    companyName: str = Form(...),
    title: str = Form(""),
    notes: str = Form(""),
    kind: str = Form("HDLD"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    loai = _loai(kind)
    cong_ty = _sach(companyName)[:191]
    if not cong_ty:
        raise HTTPException(status_code=400, detail="Chọn hoặc nhập tên công ty cho mẫu.")
    ten_file = _sach(file.filename or "mau")
    duoi = os.path.splitext(ten_file.lower())[1]
    if duoi not in LOAI_MAU[loai]["duoi"]:
        raise HTTPException(status_code=400, detail=f"Chỉ nhận file {LOAI_MAU[loai]['ten_duoi']}.")
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="File rỗng.")
    if len(content) > MAX_BYTES:
        raise HTTPException(status_code=400, detail="File quá lớn (tối đa 20MB).")
    t = _tao_mau(db, loai, cong_ty, title, notes, ten_file, content)
    activity.ghi("TEMPLATE_UPLOAD", detail=f"{_nhan(loai)} {t.companyName}: '{t.title}' ({t.originalFilename})")
    return _dto(t)


def _tao_mau(
    db: Session, loai: str, cong_ty: str, title: str, notes: str, ten_file: str, content: bytes
) -> ContractTemplate:
    """Lưu file lên MinIO + tạo bản ghi + ảnh xem trước. Dùng chung cho tải từng file và nhập zip.
    Nơi gọi đã kiểm tra đuôi file, dung lượng và tên công ty."""
    duoi = os.path.splitext(ten_file.lower())[1]
    key = f"{PREFIX}/{uuid.uuid4().hex}{duoi}"
    storage.upload_object(key, content, DUOI_CHO_PHEP[duoi])
    nguoi = activity.nguoi_hien_tai()
    t = ContractTemplate(
        kind=loai,
        companyName=cong_ty,
        title=_sach(title)[:191] or os.path.splitext(ten_file)[0][:191] or "Mẫu",
        originalFilename=ten_file[:191],
        storedPath=key,
        mimeType=DUOI_CHO_PHEP[duoi],
        fileSizeBytes=len(content),
        notes=(notes or "").strip() or None,
        uploadedBy=nguoi.name if nguoi else None,
    )
    db.add(t)
    try:
        db.commit()
    except Exception:
        db.rollback()
        storage.delete_document(key)  # không để lại file mồ côi khi DB lỗi
        raise
    db.refresh(t)
    # Đồng bộ trong request: Word -> PDF mất vài giây, nhân viên vừa tải lên là thấy ngay ảnh.
    _tao_xem_truoc(db, t, content)
    db.refresh(t)
    return t


# Nhóm cho mẫu nhập từ zip mà chưa chọn công ty (cột companyName không được để trống).
CHUA_GAN = "Chưa gán công ty"

# Giới hạn khi nhập zip — chặn "zip bom" (file nén nhỏ, bung ra khổng lồ) và một lượt kéo quá lâu
# (mỗi file Word mất ~2 giây để dựng ảnh xem trước).
ZIP_MAX_BYTES = 100 * 1024 * 1024
ZIP_MAX_FILE = 60
ZIP_MAX_TONG_GIAI_NEN = 300 * 1024 * 1024


def _ten_trong_zip(info: zipfile.ZipInfo) -> str:
    """Tên file trong zip. Zip tạo trên Windows/Mac đời cũ không bật cờ UTF-8 nên Python đọc tên theo
    bảng mã cp437 -> tên tiếng Việt thành ký tự lạ; thử đọc lại bằng UTF-8."""
    ten = info.filename
    if not info.flag_bits & 0x800:
        try:
            ten = ten.encode("cp437").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return _sach(os.path.basename(ten.replace(chr(92), "/")))


@router.post("/import-zip", status_code=201)
def import_zip(
    companyName: str = Form(""),
    notes: str = Form(""),
    kind: str = Form("HDLD"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Thêm nhiều mẫu một lần từ file zip: mỗi file đúng loại của `kind` (Word/PDF, hoặc Excel cho phiếu lương) thành một mẫu (tên mẫu = tên
    file), tất cả cùng một công ty/nhóm và cùng loại `kind`. File loại khác bị bỏ qua và báo lại.

    Công ty để trống -> xếp vào nhóm CHUA_GAN; chọn công ty cho từng mẫu sau ở trang xem mẫu."""
    loai = _loai(kind)
    cong_ty = _sach(companyName)[:191] or CHUA_GAN
    data = file.file.read()
    if len(data) > ZIP_MAX_BYTES:
        raise HTTPException(status_code=400, detail="File zip quá lớn (tối đa 100MB).")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail="File không phải zip hợp lệ.") from e

    cac_file = [i for i in z.infolist() if not i.is_dir() and not i.filename.startswith("__MACOSX/")]
    if len(cac_file) > ZIP_MAX_FILE:
        raise HTTPException(status_code=400, detail=f"Zip có {len(cac_file)} file — tối đa {ZIP_MAX_FILE} file mỗi lần.")
    if sum(i.file_size for i in cac_file) > ZIP_MAX_TONG_GIAI_NEN:
        raise HTTPException(status_code=400, detail="Tổng dung lượng giải nén quá lớn.")

    da_them, bo_qua = [], []
    for info in sorted(cac_file, key=lambda i: i.filename):
        ten = _ten_trong_zip(info)
        duoi = os.path.splitext(ten.lower())[1]
        if ten.startswith(".") or duoi not in LOAI_MAU[loai]["duoi"]:
            bo_qua.append({"file": ten, "lyDo": f"không phải {LOAI_MAU[loai]['ten_duoi']}"})
            continue
        if info.file_size > MAX_BYTES:
            bo_qua.append({"file": ten, "lyDo": "quá 20MB"})
            continue
        content = z.read(info)
        if not content:
            bo_qua.append({"file": ten, "lyDo": "file rỗng"})
            continue
        tieu_de = os.path.splitext(ten)[0].replace("_", " ")
        t = _tao_mau(db, loai, cong_ty, tieu_de, notes, ten, content)
        da_them.append(_dto(t))
    if da_them:
        activity.ghi(
            "TEMPLATE_UPLOAD",
            detail=f"{_nhan(loai)} {cong_ty}: nhập {len(da_them)} mẫu từ zip ({_sach(file.filename)})",
        )
    return {"added": da_them, "skipped": bo_qua}


@router.get("/{template_id}")
def get_template(template_id: str, db: Session = Depends(get_db)):
    return _dto(_lay(db, template_id))


def _ten_an_toan(s: str) -> str:
    """Tên thư mục/file trong zip: bỏ ký tự cấm của Windows/macOS, giữ tiếng Việt có dấu."""
    cam = set('<>:"/|?*') | {chr(92)}
    return "".join("_" if ch in cam or ord(ch) < 32 else ch for ch in s).strip(" .") or "khong-ten"


# Đường dẫn 2 đoạn ("/export/zip") — không bao giờ trùng GET "/{template_id}" (1 đoạn) dù khai ở đâu.
@router.get("/export/zip")
def export_zip(ids: Optional[str] = None, kind: str = "HDLD", db: Session = Depends(get_db)):
    """Tải nhiều mẫu (file gốc) gói thành một zip, mỗi công ty/nhóm một thư mục.
    `ids` = danh sách id cách nhau dấu phẩy; bỏ trống = TẤT CẢ mẫu của loại `kind`."""
    loai = _loai(kind)
    rows = list(db.scalars(select(ContractTemplate).where(ContractTemplate.kind == loai)).all())
    if ids:
        chon = {x for x in ids.split(",") if x}
        rows = [t for t in rows if t.id in chon]
    if not rows:
        raise HTTPException(status_code=404, detail="Không có mẫu nào để tải.")
    rows.sort(key=lambda t: (t.companyName.casefold(), t.title.casefold()))

    buf = io.BytesIO()
    da_dung: set[str] = set()
    so_file = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for t in rows:
            try:
                content = storage.get_document_bytes(t.storedPath)
            except Exception:  # noqa: BLE001
                continue  # file mất trên MinIO — bỏ qua, không làm hỏng cả gói
            goc, duoi = os.path.splitext(_ten_an_toan(t.originalFilename))
            duong = f"{_ten_an_toan(t.companyName)}/{goc}{duoi}"
            n = 2
            while duong.casefold() in da_dung:
                duong = f"{_ten_an_toan(t.companyName)}/{goc} ({n}){duoi}"
                n += 1
            da_dung.add(duong.casefold())
            z.writestr(duong, content)
            so_file += 1
    activity.ghi("TEMPLATE_DOWNLOAD", detail=f"{_nhan(loai)} Tải {so_file} mẫu (ZIP)" + ("" if ids else " — tất cả"))
    goc_ten = LOAI_MAU[loai]["zip"]
    ten = f"{goc_ten}.zip" if not ids else f"{goc_ten} ({so_file} mau).zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(ten, True)},
    )


class XoaNhieuRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)


@router.post("/delete-many")
def delete_many(body: XoaNhieuRequest, db: Session = Depends(get_db)):
    """Xoá nhiều mẫu một lần (chế độ "Chọn để xoá" ở thư viện). Xoá cả file gốc, PDF và ảnh xem
    trước; id không còn tồn tại thì bỏ qua. Ghi MỘT dòng lịch sử cho cả lượt."""
    da_xoa = []
    loai = None
    for tid in dict.fromkeys(body.ids):  # bỏ id trùng, giữ thứ tự
        t = db.get(ContractTemplate, tid)
        if not t:
            continue
        key = t.storedPath
        loai = loai or t.kind
        da_xoa.append(t.title)
        db.delete(t)
        db.commit()
        try:
            storage.delete_document(key)
            storage.delete_prefix(f"{PREFIX}/{tid}/")
        except Exception:  # noqa: BLE001
            pass  # DB đã xoá — file mồ côi chỉ tốn chỗ
    if da_xoa:
        mau = ", ".join(f"'{x}'" for x in da_xoa[:5]) + (f" và {len(da_xoa) - 5} mẫu khác" if len(da_xoa) > 5 else "")
        activity.ghi("TEMPLATE_DELETE", detail=f"{_nhan(loai)} Xoá {len(da_xoa)} mẫu: {mau}")
    return {"deleted": len(da_xoa)}


class DoiCongTyRequest(BaseModel):
    companyName: str = Field(min_length=1, max_length=191)


@router.patch("/{template_id}")
def assign_template(template_id: str, body: DoiCongTyRequest, db: Session = Depends(get_db)):
    """Chọn / đổi công ty sở hữu mẫu. Mỗi mẫu thuộc DUY NHẤT một công ty — đổi là CHUYỂN hẳn sang
    công ty mới (không còn ở công ty cũ), không phải dùng chung."""
    t = _lay(db, template_id)
    cong_ty = _sach(body.companyName)[:191]
    if not cong_ty:
        raise HTTPException(status_code=400, detail="Chọn hoặc nhập tên công ty.")
    cu = t.companyName
    if cong_ty == cu:
        return _dto(t)
    t.companyName = cong_ty
    db.commit()
    db.refresh(t)
    activity.ghi("TEMPLATE_ASSIGN", detail=f"{_nhan(t.kind)} '{t.title}': {cu} → {cong_ty}")
    return _dto(t)


@router.post("/{template_id}/preview")
def rebuild_preview(template_id: str, db: Session = Depends(get_db)):
    """Tạo lại ảnh xem trước (mẫu tải lên trước khi có tính năng này, hoặc lần tạo trước bị lỗi)."""
    t = _lay(db, template_id)
    try:
        content = storage.get_document_bytes(t.storedPath)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="File mẫu không còn trên hệ thống lưu trữ") from e
    try:
        t.pageCount = contract_preview.tao_ban_xem_truoc(t.id, content, _duoi(t))
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.exception("Không tạo được bản xem trước cho mẫu %s", t.id)
        raise HTTPException(status_code=500, detail="Không tạo được bản xem trước cho mẫu này.") from e
    return _dto(t)


@router.get("/{template_id}/file")
def get_template_file(template_id: str, download: bool = False, db: Session = Depends(get_db)):
    t = _lay(db, template_id)
    try:
        content = storage.get_document_bytes(t.storedPath)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="File mẫu không còn trên hệ thống lưu trữ") from e
    return Response(
        content=content,
        media_type=t.mimeType,
        headers={"Content-Disposition": _content_disposition(t.originalFilename, download)},
    )


@router.get("/{template_id}/preview.pdf")
def get_template_pdf(template_id: str, download: bool = False, db: Session = Depends(get_db)):
    """Bản PDF của mẫu (Word đã chuyển sang PDF) — để in hoặc gửi cho công ty xem trước."""
    t = _lay(db, template_id)
    try:
        content = storage.get_document_bytes(contract_preview.key_pdf(t.id))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Mẫu này chưa có bản PDF xem trước.") from e
    ten_pdf = os.path.splitext(t.originalFilename)[0] + ".pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(ten_pdf, download)},
    )


@router.get("/{template_id}/pages/{page_num}")
def get_template_page(template_id: str, page_num: int, db: Session = Depends(get_db)):
    t = _lay(db, template_id)
    if not t.pageCount or page_num < 1 or page_num > min(t.pageCount, contract_preview.TOI_DA_TRANG):
        raise HTTPException(status_code=404, detail="Không có trang này")
    try:
        png = storage.get_document_bytes(contract_preview.key_trang(t.id, page_num))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="Không có ảnh trang này") from e
    # Ảnh cố định theo id mẫu (mẫu mới = id mới) nên cho trình duyệt giữ lâu — lướt thư viện không
    # phải tải lại hàng chục ảnh mỗi lần.
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/{template_id}")
def delete_template(template_id: str, db: Session = Depends(get_db)):
    t = _lay(db, template_id)
    mo_ta = f"{_nhan(t.kind)} {t.companyName}: '{t.title}' ({t.originalFilename})"
    key, tid = t.storedPath, t.id
    db.delete(t)
    db.commit()
    try:
        storage.delete_document(key)
        storage.delete_prefix(f"{PREFIX}/{tid}/")  # PDF + ảnh xem trước
    except Exception:  # noqa: BLE001
        pass  # DB đã xoá — file mồ côi chỉ tốn chỗ, không làm hỏng gì
    activity.ghi("TEMPLATE_DELETE", detail=mo_ta)
    return {"ok": True}
