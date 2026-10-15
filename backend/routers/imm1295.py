"""API tab "Điền form IMM1295e" (/dien-form-imm1295) — logic ở imm1295.py.

    GET  /imm1295/{case_id}            dữ liệu đã lưu (null nếu chưa đọc) + giấy tờ sẽ dùng
    POST /imm1295/{case_id}/extract    AI đọc giấy tờ -> dữ liệu form (LƯU luôn vào Case.imm1295Data)
    PUT  /imm1295/{case_id}            lưu dữ liệu nhân viên đã sửa
    GET  /imm1295/{case_id}/pdf        PDF IMM 1295E đã điền theo dữ liệu đã lưu — TẢI VỀ (form XFA thuần: trình
                                       duyệt chỉ hiện "Please wait...", phải mở bằng Adobe Reader)
"""
from __future__ import annotations

import json
import logging
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from sqlalchemy.orm import Session

import activity
import imm1295
import llm
from db import get_db
from models import Case, now_utc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/imm1295", tags=["imm1295"])


def _ho_so(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    return case


def _doc_luu(case: Case):
    try:
        return json.loads(case.imm1295Data) if case.imm1295Data else None
    except ValueError:
        return None


@router.get("/{case_id}")
def xem(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    luu = _doc_luu(case)
    return {
        "caseId": case.id, "clientName": case.clientName,
        # Chuẩn hoá + kiểm tra lại theo quy tắc HIỆN TẠI (dữ liệu lưu từ bản cũ cũng được lọc).
        "data": imm1295.chuan_hoa(luu) if luu else None, "updatedAt": case.imm1295UpdatedAt,
        "giayTo": [f"{g['ten_muc']}: {g['file']}" for g in imm1295.giay_to_lien_quan(case)],
        "quocGia": sorted(imm1295.quoc_gia()),  # gợi ý ô quốc gia (đúng tên trong danh sách của form)
    }


@router.post("/{case_id}/extract")
def doc_bang_ai(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    try:
        du_lieu = imm1295.trich_thong_tin(case)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        logger.exception("IMM1295: AI hỏng")
        raise HTTPException(status_code=502, detail=f"AI không đọc được ({llm.describe_error(e)}) — thử lại.") from e
    case.imm1295Data = json.dumps(du_lieu, ensure_ascii=False)
    case.imm1295UpdatedAt = now_utc()
    db.commit()
    activity.ghi("IMM1295_EXTRACT", case=case, detail=f"AI đọc {len(du_lieu.get('nguonGiayTo') or [])} giấy tờ")
    return {"data": du_lieu, "updatedAt": case.imm1295UpdatedAt}


@router.put("/{case_id}")
def luu(case_id: str, data: dict = Body(...), db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    du_lieu = imm1295.chuan_hoa(data)
    case.imm1295Data = json.dumps(du_lieu, ensure_ascii=False)
    case.imm1295UpdatedAt = now_utc()
    db.commit()
    activity.ghi("IMM1295_SAVE", case=case)
    return {"data": du_lieu, "updatedAt": case.imm1295UpdatedAt}


@router.get("/{case_id}/pdf")
def tai_pdf(case_id: str, db: Session = Depends(get_db)):
    case = _ho_so(db, case_id)
    du_lieu = _doc_luu(case)
    if not du_lieu:
        raise HTTPException(status_code=400, detail="Chưa có dữ liệu — bấm \"Đọc thông tin từ hồ sơ\" trước.")
    pdf = imm1295.dien_pdf(imm1295.chuan_hoa(du_lieu))
    activity.ghi("IMM1295_PDF", case=case)
    ten = f"IMM1295E - {imm1295.bo_dau(case.clientName)}.pdf"
    ascii_ten = "".join(c if 32 <= ord(c) < 127 and c not in '"?' + chr(92) else "_" for c in ten)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=\"{ascii_ten}\"; filename*=UTF-8''{quote(ten, safe='')}"})
