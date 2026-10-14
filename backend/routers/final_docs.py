"""Tab "Danh sách hồ sơ hoàn thành" (/ho-so-hoan-thanh, 13/10/2026) — KHO RIÊNG các file đã duyệt
ở trang "Tách hồ sơ dịch thuật" (bản dịch + công chứng + bản gốc, tên "... - translated.pdf").

Vì sao KHÔNG đưa vào Document (giấy tờ của hồ sơ thô): bản dịch khớp cùng mục checklist với bản gốc,
sẽ bị cộng vào tiến độ %, "Hồ sơ dịch thuật: N trang", tải ZIP... — sai hết. Bảng FinalDocument tách
hẳn; file nằm trên MinIO ở "<caseId>/hoan-thanh/<id>.pdf" — CÙNG thư mục hồ sơ, nên xoá vĩnh viễn hồ
sơ và tự xoá file 14 ngày sau "Hoàn tất" (case_delete) cũng dọn luôn file ở đây.

Nguồn thứ hai (13/10/2026): nút "Chép hồ sơ tiếng Anh sang hồ sơ hoàn thành" ở trang hồ sơ thô — CHÉP
(không chuyển) các file KHÔNG cần dịch (hộ chiếu, căn cước, ảnh thẻ, CV...), giữ nguyên định dạng gốc
(ảnh vẫn là ảnh -> cột mimeType). Hồ sơ thô không đổi gì.

    GET    /final/cases                 hồ sơ có ít nhất 1 file hoàn thành
    GET    /final/cases/{id}            thông tin hồ sơ + file (xếp theo số mục checklist)
    GET    /final/cases/{id}/zip        tải tất cả (ZIP)
    GET    /final/files/{id}            mở / tải 1 file (?download=1)
    DELETE /final/files/{id}            xoá 1 file
    POST   /final/cases/{id}/copy-english   chép các file không cần dịch của hồ sơ thô sang đây
(Thêm file: POST /split-tool/{job}/to-final — routers/split_tool.py.)
"""
from __future__ import annotations

import io
import os
import zipfile
from types import SimpleNamespace
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import activity
import storage
import tach_file
from completeness import compute_checklist_summary
from db import get_db
from models import Case, ChecklistItem, FinalDocument, new_id, now_utc

router = APIRouter(prefix="/final", tags=["final"])


def key_file(case_id: str, file_id: str, duoi: str = ".pdf") -> str:
    return f"{case_id}/hoan-thanh/{file_id}{duoi}"


def luu_file(
    db: Session, case: Case, ten: str, noi_dung: bytes, item_id: str | None, so_trang: int | None,
    mime: str = "application/pdf",
) -> tuple[FinalDocument, bool]:
    """Thêm file vào hồ sơ hoàn thành. TRÙNG TÊN với file đã có của hồ sơ -> THAY bản cũ (cùng quy tắc
    upload giấy tờ thường). Trả (file, đã_thay)."""
    cu = db.scalars(
        select(FinalDocument).where(FinalDocument.caseId == case.id, FinalDocument.fileName == ten)
    ).first()
    nguoi = activity.nguoi_hien_tai()
    if cu is not None:
        storage.upload_object(cu.storedPath, noi_dung, mime)
        cu.checklistItemId, cu.fileSizeBytes, cu.pageCount, cu.mimeType = item_id, len(noi_dung), so_trang, mime
        cu.uploadedAt, cu.uploadedBy = now_utc(), nguoi.name if nguoi else None
        db.commit()
        return cu, True
    ma = new_id()
    duoi = os.path.splitext(ten)[1].lower()[:10] or ".pdf"
    # MinIO trước, DB sau: lỗi giữa chừng chỉ để lại object mồ côi trong thư mục hồ sơ (bị dọn cùng
    # hồ sơ), không bao giờ có dòng DB trỏ tới file không tồn tại.
    duong_dan = storage.upload_object(key_file(case.id, ma, duoi), noi_dung, mime)
    f = FinalDocument(id=ma, caseId=case.id, fileName=ten, storedPath=duong_dan, checklistItemId=item_id,
                      fileSizeBytes=len(noi_dung), pageCount=so_trang, mimeType=mime,
                      uploadedBy=nguoi.name if nguoi else None)
    db.add(f)
    db.commit()
    return f, False


def _so_muc(db: Session, case: Case) -> dict[str, str]:
    muc = tach_file.muc_cua_ho_so(
        list(db.scalars(select(ChecklistItem)).all()), case.maritalStatus, case.numberOfChildren, case.skillLevel
    )
    return {m.item.id: m.so for m in muc}


def _checklist(items: list, case: Case):
    """Checklist của hồ sơ hoàn thành: ĐÚNG hàm tính của hồ sơ thô (cùng mục, cùng thứ tự, cùng luật
    "1 trong 2"), chỉ thay giấy tờ bằng file hoàn thành. Tiến độ CHỈ tính mục bắt buộc CẦN DỊCH — hộ
    chiếu, căn cước... không bao giờ có bản dịch. Trả (tóm tắt, số mục xong, tổng số mục cần)."""
    gia = [SimpleNamespace(matchedChecklistItemId=f.checklistItemId, status="CLASSIFIED") for f in case.finalDocuments]
    tt = compute_checklist_summary(items, gia, case.maritalStatus, case.numberOfChildren, case.skillLevel)
    can = [s for s in tt.items if s.item.needsTranslation is not False and not s.item.isOptional]
    return tt, sum(1 for s in can if s.complete), len(can)


def _item_dto(i: ChecklistItem) -> dict:
    return {k: getattr(i, k) for k in ("id", "order", "section", "group", "nameVi", "note", "verificationNote",
                                       "isOptional", "appliesTo", "quantityRule", "skillLevel", "numberGroup",
                                       "needsTranslation")}


def _khoa_so(so: str | None):
    if not so:
        return (1, [])
    return (0, [int(x) for x in so.split(".")])


def _ho_so(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    return case


@router.get("/cases")
def danh_sach(db: Session = Depends(get_db)):
    rows = db.execute(
        select(
            FinalDocument.caseId,
            func.count(FinalDocument.id),
            func.coalesce(func.sum(FinalDocument.pageCount), 0),
            func.max(FinalDocument.uploadedAt),
        ).group_by(FinalDocument.caseId)
    ).all()
    theo_ho_so = {r[0]: r for r in rows}
    if not theo_ho_so:
        return []
    items = list(db.scalars(select(ChecklistItem)).all())
    ra = []
    for c in db.scalars(select(Case).where(Case.id.in_(list(theo_ho_so)), Case.deletedAt.is_(None))):
        _, so_file, so_trang, moi_nhat = theo_ho_so[c.id]
        _, xong, tong = _checklist(items, c)
        ra.append({
            "doneItems": xong, "totalItems": tong,
            "caseId": c.id, "clientName": c.clientName, "partner": c.partner,
            "maritalStatus": c.maritalStatus, "skillLevel": c.skillLevel,
            "applicationStatus": c.applicationStatus, "createdAt": c.createdAt,
            "fileCount": so_file, "pageCount": int(so_trang), "lastUploadAt": moi_nhat,
        })
    ra.sort(key=lambda x: x["lastUploadAt"] or now_utc(), reverse=True)
    return ra


@router.get("/cases/{case_id}")
def chi_tiet(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    so = _so_muc(db, case)
    items = list(db.scalars(select(ChecklistItem)).all())
    ten_muc = {i.id: i.nameVi for i in items}
    files = [{
        "id": f.id, "fileName": f.fileName, "itemId": f.checklistItemId,
        "number": so.get(f.checklistItemId or ""), "itemName": ten_muc.get(f.checklistItemId or ""),
        "pageCount": f.pageCount, "fileSizeBytes": f.fileSizeBytes,
        "uploadedAt": f.uploadedAt, "uploadedBy": f.uploadedBy,
    } for f in case.finalDocuments]
    files.sort(key=lambda x: (_khoa_so(x["number"]), x["fileName"].casefold()))
    tt, xong, tong = _checklist(items, case)
    ten_file = {f.id: f.fileName for f in case.finalDocuments}
    theo_muc: dict[str, list] = {}
    for f in case.finalDocuments:
        theo_muc.setdefault(f.checklistItemId or "", []).append({"id": f.id, "fileName": ten_file[f.id]})
    return {
        "checklist": [{
            "item": _item_dto(s.item), "requiredCount": s.required_count, "fulfilledCount": s.fulfilled_count,
            "complete": s.complete, "matchedDocuments": [], "files": theo_muc.get(s.item.id, []),
        } for s in tt.items],
        "progress": {"done": xong, "total": tong, "percent": round(100 * xong / tong) if tong else 100},
        "case": {"id": case.id, "clientName": case.clientName, "partner": case.partner,
                 "maritalStatus": case.maritalStatus, "skillLevel": case.skillLevel,
                 "applicationStatus": case.applicationStatus, "autoDeleteAt": case.autoDeleteAt},
        "files": files,
    }


def _file(db: Session, file_id: str) -> FinalDocument:
    f = db.get(FinalDocument, file_id)
    if not f:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")
    return f


def _tai_ve(ten: str, inline: bool) -> str:
    ascii_ten = "".join(c if 32 <= ord(c) < 127 and c not in '"?' + chr(92) else "_" for c in ten)
    return f"{'inline' if inline else 'attachment'}; filename=\"{ascii_ten}\"; filename*=UTF-8''{quote(ten, safe='')}"


@router.get("/files/{file_id}")
def mo_file(file_id: str, download: bool = False, db: Session = Depends(get_db)):
    f = _file(db, file_id)
    return Response(content=storage.get_document_bytes(f.storedPath), media_type=f.mimeType or "application/pdf",
                    headers={"Content-Disposition": _tai_ve(f.fileName, not download)})


@router.delete("/files/{file_id}", status_code=204)
def xoa_file(file_id: str, db: Session = Depends(get_db)):
    f = _file(db, file_id)
    case, ten = f.case, f.fileName
    storage.delete_document(f.storedPath)  # MinIO trước, DB sau (như case_delete)
    db.delete(f)
    db.commit()
    activity.ghi("FINAL_DELETE", case=case, detail=ten)
    return Response(status_code=204)


@router.get("/cases/{case_id}/zip")
def tai_zip(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    if not case.finalDocuments:
        raise HTTPException(status_code=404, detail="Hồ sơ chưa có file hoàn thành nào")
    so = _so_muc(db, case)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # Cùng thứ tự với trang chi tiết: theo số mục checklist.
        for f in sorted(case.finalDocuments, key=lambda f: (_khoa_so(so.get(f.checklistItemId or "")), f.fileName.casefold())):
            z.writestr(f.fileName, storage.get_document_bytes(f.storedPath))
    activity.ghi("FINAL_ZIP", case=case, detail=f"{len(case.finalDocuments)} file")
    return Response(content=buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": _tai_ve(f"{case.clientName} - Ho so hoan thanh.zip", False)})


@router.post("/cases/{case_id}/copy-english")
def chep_tieng_anh(case_id: str, db: Session = Depends(get_db)):
    """CHÉP các file KHÔNG cần dịch của hồ sơ thô (cùng nhóm với nút "Tải hồ sơ tiếng Anh" —
    ChecklistItem.needsTranslation = False) sang hồ sơ hoàn thành. Hồ sơ thô KHÔNG đổi gì. Trùng tên
    file đã có trong hồ sơ hoàn thành -> thay bản cũ, nên bấm lại bao nhiêu lần cũng không nhân đôi."""
    case = _ho_so(db, case_id)
    tai_lieu = [
        d for d in case.documents
        if d.matchedChecklistItem is not None and d.matchedChecklistItem.needsTranslation is False
    ]
    if not tai_lieu:
        raise HTTPException(status_code=404, detail="Hồ sơ không có file tiếng Anh (không cần dịch) nào để chép.")
    them = thay = 0
    for d in sorted(tai_lieu, key=lambda d: d.uploadedAt or now_utc()):
        noi_dung = storage.get_document_bytes(d.storedPath)
        so_trang = d.pageCount or (1 if (d.mimeType or "").startswith("image/") else None)
        _, da_thay = luu_file(db, case, d.originalFilename, noi_dung, d.matchedChecklistItemId, so_trang,
                              d.mimeType or "application/octet-stream")
        thay += da_thay
        them += not da_thay
    activity.ghi("FINAL_COPY", case=case, detail=f"{them} file mới" + (f", thay {thay} file" if thay else ""))
    return {"added": them, "replaced": thay, "total": len(tai_lieu)}
