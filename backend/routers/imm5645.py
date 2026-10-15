"""API tab "Điền form IMM5645e" (/dien-form-imm5645) — logic ở imm5645.py.

    GET  /imm5645/{case_id}            dữ liệu đã lưu (null nếu chưa đọc) + giấy tờ sẽ dùng
    POST /imm5645/{case_id}/extract    AI đọc giấy tờ -> dữ liệu form (LƯU luôn vào Case.imm5645Data)
    PUT  /imm5645/{case_id}            lưu dữ liệu nhân viên đã sửa
    GET  /imm5645/{case_id}/pdf        PDF IMM 5645E đã điền theo dữ liệu đã lưu
"""
from __future__ import annotations

import json
import logging
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from sqlalchemy.orm import Session

import activity
import imm5645
import llm
from db import get_db
from models import Case, now_utc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/imm5645", tags=["imm5645"])


def _ho_so(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    return case


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
    pdf = imm5645.dien_pdf(imm5645.chuan_hoa(du_lieu))
    activity.ghi("IMM5645_PDF", case=case)
    ten = f"IMM5645E - {imm5645.bo_dau(case.clientName)}.pdf"
    ascii_ten = "".join(c if 32 <= ord(c) < 127 and c not in '"?' + chr(92) else "_" for c in ten)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"inline; filename=\"{ascii_ten}\"; filename*=UTF-8''{quote(ten, safe='')}"})
