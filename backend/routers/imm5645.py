"""API tab "Điền form IMM5645e" (/dien-form-imm5645) — logic ở imm5645.py.

    GET  /imm5645/{case_id}            dữ liệu đã lưu (null nếu chưa đọc) + giấy tờ sẽ dùng
    POST /imm5645/{case_id}/extract    AI đọc giấy tờ -> dữ liệu form (LƯU luôn vào Case.imm5645Data)
    PUT  /imm5645/{case_id}            lưu dữ liệu nhân viên đã sửa
    GET  /imm5645/{case_id}/pdf        PDF IMM 5645E đã điền theo dữ liệu đã lưu (có chữ ký nếu đã đặt)
    POST /imm5645/{case_id}/signature        tải 1 hoặc NHIỀU ảnh chữ ký (xoá nền, cắt sát) vào thư viện của hồ sơ —
                                             chưa có chỗ ký nào thì tự đặt ảnh đầu ở các dòng ký
    GET  /imm5645/{case_id}/signature/{id}   ảnh chữ ký đã xử lý (PNG nền trong suốt)
    DELETE /imm5645/{case_id}/signature/{id} xoá 1 ảnh (và các chỗ đang dùng ảnh đó)
    GET  /imm5645/{case_id}/page/{n}   ảnh trang n (0/1) đã điền, KHÔNG chữ ký — giao diện kéo chữ ký lên trên
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy.orm import Session

import activity
import imm5645
import llm
import storage
from db import get_db
from models import Case, now_utc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/imm5645", tags=["imm5645"])


def _ho_so(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    return case


def _anh(case: Case, anh_id: str) -> bytes | None:
    try:
        return storage.get_document_bytes(imm5645.khoa_chu_ky(case.id, anh_id))
    except Exception:  # noqa: BLE001 — ảnh đã mất
        return None


def _doc_luu(case: Case):
    try:
        return json.loads(case.imm5645Data) if case.imm5645Data else None
    except ValueError:
        return None


@router.get("/{case_id}")
def xem(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    luu = _doc_luu(case)
    return {
        "caseId": case.id, "clientName": case.clientName,
        # Chuẩn hoá + kiểm tra lại theo quy tắc HIỆN TẠI (dữ liệu lưu từ bản cũ cũng được lọc).
        "data": imm5645.chuan_hoa(luu) if luu else None, "updatedAt": case.imm5645UpdatedAt,
        "giayTo": [f"{g['ten_muc']}: {g['file']}" for g in imm5645.giay_to_lien_quan(case)],
    }


@router.post("/{case_id}/extract")
def doc_bang_ai(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    try:
        du_lieu = imm5645.trich_thong_tin(case)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        logger.exception("IMM5645: AI hỏng")
        raise HTTPException(status_code=502, detail=f"AI không đọc được ({llm.describe_error(e)}) — thử lại.") from e
    # Đọc lại bằng AI KHÔNG làm mất vị trí chữ ký nhân viên đã kéo.
    cu = _doc_luu(case) or {}
    du_lieu["anhChuKy"] = cu.get("anhChuKy") or []
    du_lieu["chuKy"] = cu.get("chuKy") or []
    du_lieu = imm5645.chuan_hoa(du_lieu)
    case.imm5645Data = json.dumps(du_lieu, ensure_ascii=False)
    case.imm5645UpdatedAt = now_utc()
    db.commit()
    activity.ghi("IMM5645_EXTRACT", case=case, detail=f"AI đọc {len(du_lieu.get('nguonGiayTo') or [])} giấy tờ")
    return {"data": du_lieu, "updatedAt": case.imm5645UpdatedAt}


@router.put("/{case_id}")
def luu(case_id: str, data: dict = Body(...), db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    du_lieu = imm5645.chuan_hoa(data)
    case.imm5645Data = json.dumps(du_lieu, ensure_ascii=False)
    case.imm5645UpdatedAt = now_utc()
    db.commit()
    activity.ghi("IMM5645_SAVE", case=case)
    return {"data": du_lieu, "updatedAt": case.imm5645UpdatedAt}


@router.get("/{case_id}/pdf")
def tai_pdf(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    du_lieu = _doc_luu(case)
    if not du_lieu:
        raise HTTPException(status_code=400, detail="Chưa có dữ liệu — bấm \"Đọc thông tin từ hồ sơ\" trước.")
    d = imm5645.chuan_hoa(du_lieu)
    anh = {a["id"]: png for a in d["anhChuKy"] if (png := _anh(case, a["id"])) is not None}
    pdf = imm5645.dien_pdf(d, anh)
    activity.ghi("IMM5645_PDF", case=case)
    ten = f"IMM5645E - {imm5645.bo_dau(case.clientName)}.pdf"
    ascii_ten = "".join(c if 32 <= ord(c) < 127 and c not in '"?' + chr(92) else "_" for c in ten)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"inline; filename=\"{ascii_ten}\"; filename*=UTF-8''{quote(ten, safe='')}"})


@router.post("/{case_id}/signature")
async def tai_chu_ky(case_id: str, files: list[UploadFile] = File(...), db: Session = Depends(get_db)):
    """Thêm 1 hoặc nhiều ảnh chữ ký vào thư viện của hồ sơ. Ảnh hỏng báo riêng, ảnh khác vẫn nhận."""
    case = _ho_so(db, case_id)
    du_lieu = imm5645.chuan_hoa(_doc_luu(case) or {})
    moi, loi = [], []
    for f in files:
        if len(du_lieu["anhChuKy"]) + len(moi) >= imm5645.SO_ANH_TOI_DA:
            loi.append(f"{f.filename}: tối đa {imm5645.SO_ANH_TOI_DA} ảnh chữ ký mỗi hồ sơ.")
            break
        noi_dung = await f.read()
        if len(noi_dung) > 15 * 1024 * 1024:
            loi.append(f"{f.filename}: ảnh quá lớn (tối đa 15 MB).")
            continue
        try:
            png = imm5645.xu_ly_chu_ky(noi_dung)
        except ValueError as e:
            loi.append(f"{f.filename}: {e}")
            continue
        anh_id = uuid.uuid4().hex[:10]
        storage.upload_object(imm5645.khoa_chu_ky(case.id, anh_id), png, "image/png")
        moi.append({"id": anh_id, "ten": os.path.splitext(f.filename or "")[0][:40], "_tiLe": imm5645.ti_le_anh(png)})
    if not moi:
        raise HTTPException(status_code=400, detail=" ".join(loi) or "Không nhận được ảnh nào.")
    du_lieu["anhChuKy"] += [{"id": a["id"], "ten": a["ten"]} for a in moi]
    # Chưa có chỗ ký nào -> tự đặt ẢNH ĐẦU vừa tải ở các dòng ký; đã có thì giữ nguyên chỗ.
    if not du_lieu["chuKy"]:
        du_lieu["chuKy"] = imm5645.chu_ky_mac_dinh(du_lieu, moi[0]["_tiLe"], moi[0]["id"])
    du_lieu = imm5645.chuan_hoa(du_lieu)
    case.imm5645Data = json.dumps(du_lieu, ensure_ascii=False)
    case.imm5645UpdatedAt = now_utc()
    db.commit()
    activity.ghi("IMM5645_SIGNATURE", case=case, detail=", ".join(f"'{f.filename}'" for f in files))
    return {"anhChuKy": du_lieu["anhChuKy"], "chuKy": du_lieu["chuKy"], "loi": loi, "updatedAt": case.imm5645UpdatedAt}


@router.get("/{case_id}/signature/{anh_id}")
def xem_chu_ky(case_id: str, anh_id: str, db: Session = Depends(get_db)):
    png = _anh(_ho_so(db, case_id), anh_id) if imm5645._ID_ANH.match(anh_id) else None
    if png is None:
        raise HTTPException(status_code=404, detail="Không có ảnh chữ ký này")
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/{case_id}/signature/{anh_id}")
def xoa_chu_ky(case_id: str, anh_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    if not imm5645._ID_ANH.match(anh_id):
        raise HTTPException(status_code=400, detail="Mã ảnh không hợp lệ")
    try:
        storage.delete_document(imm5645.khoa_chu_ky(case.id, anh_id))
    except Exception:  # noqa: BLE001
        pass
    du_lieu = imm5645.chuan_hoa(_doc_luu(case) or {})
    du_lieu["anhChuKy"] = [a for a in du_lieu["anhChuKy"] if a["id"] != anh_id]
    du_lieu = imm5645.chuan_hoa(du_lieu)  # bỏ luôn các chỗ ký đang dùng ảnh này
    case.imm5645Data = json.dumps(du_lieu, ensure_ascii=False)
    case.imm5645UpdatedAt = now_utc()
    db.commit()
    activity.ghi("IMM5645_SIGNATURE_DELETE", case=case)
    return {"anhChuKy": du_lieu["anhChuKy"], "chuKy": du_lieu["chuKy"], "updatedAt": case.imm5645UpdatedAt}


@router.get("/{case_id}/page/{so_trang}")
def xem_trang(case_id: str, so_trang: int, dpi: int = 100, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    try:
        png = imm5645.anh_trang(imm5645.chuan_hoa(_doc_luu(case) or {}), so_trang, dpi)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})
