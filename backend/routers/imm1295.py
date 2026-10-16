"""API tab "Điền form IMM1295e" (/dien-form-imm1295) — logic ở imm1295.py.

    GET  /imm1295/{case_id}            dữ liệu đã lưu (null nếu chưa đọc) + giấy tờ sẽ dùng
    POST /imm1295/{case_id}/extract    AI đọc giấy tờ -> dữ liệu form (LƯU luôn vào Case.imm1295Data)
    PUT  /imm1295/{case_id}            lưu dữ liệu nhân viên đã sửa
    GET  /imm1295/{case_id}/pdf        PDF IMM 1295E đã điền theo dữ liệu đã lưu — TẢI VỀ (form XFA thuần: trình
                                       duyệt chỉ hiện "Please wait...", phải mở bằng Adobe Reader)
    POST /imm1295/{case_id}/signature            tải 1 / nhiều ảnh chữ ký vào thư viện (chưa đặt thì tự đặt ảnh đầu)
    POST /imm1295/{case_id}/signature/from-5645  chép thư viện chữ ký bên IMM5645e của cùng hồ sơ sang
    GET  /imm1295/{case_id}/signature/{id}       ảnh chữ ký (PNG nền trong suốt)
    DELETE /imm1295/{case_id}/signature/{id}     xoá 1 ảnh (bỏ luôn chỗ ký đang dùng nó)
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
import imm1295
import imm5645
import llm
import storage
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


def _anh(case: Case, anh_id: str) -> bytes | None:
    try:
        return storage.get_document_bytes(imm1295.khoa_chu_ky(case.id, anh_id))
    except Exception:  # noqa: BLE001 — ảnh đã mất
        return None


def _so_chu_ky_5645(case: Case) -> list[dict]:
    try:
        return imm5645.chuan_hoa_anh_chu_ky(json.loads(case.imm5645Data or "{}").get("anhChuKy"))
    except ValueError:
        return []


def _luu_ky(db: Session, case: Case, du_lieu: dict) -> dict:
    du_lieu = imm1295.chuan_hoa(du_lieu)
    case.imm1295Data = json.dumps(du_lieu, ensure_ascii=False)
    case.imm1295UpdatedAt = now_utc()
    db.commit()
    return {"anhChuKy": du_lieu["anhChuKy"], "chuKy": du_lieu["chuKy"], "signDate": du_lieu["signDate"],
            "updatedAt": case.imm1295UpdatedAt}


def _them_anh(du_lieu: dict, moi: list[dict]) -> None:
    """Thêm ảnh mới vào thư viện; chưa có chỗ ký -> đặt ảnh đầu vào ô ký, chưa có ngày ký -> hôm nay."""
    du_lieu["anhChuKy"] = (du_lieu.get("anhChuKy") or []) + [{"id": a["id"], "ten": a["ten"]} for a in moi]
    if moi and not du_lieu.get("chuKy"):
        du_lieu["chuKy"] = imm1295.vi_tri_mac_dinh(moi[0]["_tiLe"], moi[0]["id"])
        du_lieu["signDate"] = du_lieu.get("signDate") or imm5645.hom_nay_vn()


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
        "soChuKy5645": len(_so_chu_ky_5645(case)),  # nút "Lấy chữ ký từ IMM5645e"
        "vungKy": {"vung": imm1295.VUNG_KY, "oKy": imm1295.O_KY, "oNgay": imm1295.O_NGAY_KY},  # khung mô phỏng (mm)
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
    # Đọc lại bằng AI KHÔNG làm mất thư viện chữ ký / chỗ ký / ngày ký đã đặt.
    cu = _doc_luu(case) or {}
    for k in ("anhChuKy", "chuKy", "signDate"):
        du_lieu[k] = cu.get(k) or du_lieu.get(k)
    du_lieu = imm1295.chuan_hoa(du_lieu)
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
    d = imm1295.chuan_hoa(du_lieu)
    anh = {d["chuKy"]["anh"]: png} if d["chuKy"] and (png := _anh(case, d["chuKy"]["anh"])) else None
    pdf = imm1295.dien_pdf(d, anh)
    activity.ghi("IMM1295_PDF", case=case)
    ten = f"IMM1295E - {imm1295.bo_dau(case.clientName)}.pdf"
    ascii_ten = "".join(c if 32 <= ord(c) < 127 and c not in '"?' + chr(92) else "_" for c in ten)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=\"{ascii_ten}\"; filename*=UTF-8''{quote(ten, safe='')}"})


@router.post("/{case_id}/signature")
async def tai_chu_ky(case_id: str, files: list[UploadFile] = File(...), db: Session = Depends(get_db)):
    """Thêm 1 hoặc nhiều ảnh chữ ký (xử lý như IMM5645: xoá nền, cắt sát). Ảnh hỏng báo riêng, ảnh khác vẫn nhận."""
    case = _ho_so(db, case_id)
    du_lieu = imm1295.chuan_hoa(_doc_luu(case) or {})
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
        storage.upload_object(imm1295.khoa_chu_ky(case.id, anh_id), png, "image/png")
        moi.append({"id": anh_id, "ten": os.path.splitext(f.filename or "")[0][:40], "_tiLe": imm5645.ti_le_anh(png)})
    if not moi:
        raise HTTPException(status_code=400, detail=" ".join(loi) or "Không nhận được ảnh nào.")
    _them_anh(du_lieu, moi)
    kq = _luu_ky(db, case, du_lieu)
    activity.ghi("IMM1295_SIGNATURE", case=case, detail=", ".join(f"'{f.filename}'" for f in files))
    return {**kq, "loi": loi}


@router.post("/{case_id}/signature/from-5645")
def lay_chu_ky_5645(case_id: str, db: Session = Depends(get_db)):
    """Chép các ảnh trong thư viện chữ ký IMM5645e của hồ sơ sang IMM1295e (bỏ qua ảnh trùng tên đã có)."""
    case = _ho_so(db, case_id)
    du_lieu = imm1295.chuan_hoa(_doc_luu(case) or {})
    da_co = {a["ten"] for a in du_lieu["anhChuKy"]}
    moi = []
    for a in _so_chu_ky_5645(case):
        if a["ten"] in da_co or len(du_lieu["anhChuKy"]) + len(moi) >= imm5645.SO_ANH_TOI_DA:
            continue
        try:
            png = storage.get_document_bytes(imm5645.khoa_chu_ky(case.id, a["id"]))
        except Exception:  # noqa: BLE001 — ảnh bên 5645 đã mất
            continue
        anh_id = uuid.uuid4().hex[:10]
        storage.upload_object(imm1295.khoa_chu_ky(case.id, anh_id), png, "image/png")
        moi.append({"id": anh_id, "ten": a["ten"], "_tiLe": imm5645.ti_le_anh(png)})
    if not moi:
        raise HTTPException(status_code=400, detail="Không có chữ ký mới nào bên IMM5645e để lấy.")
    _them_anh(du_lieu, moi)
    kq = _luu_ky(db, case, du_lieu)
    activity.ghi("IMM1295_SIGNATURE", case=case, detail=f"lấy {len(moi)} chữ ký từ IMM5645e")
    return {**kq, "loi": []}


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
        storage.delete_document(imm1295.khoa_chu_ky(case.id, anh_id))
    except Exception:  # noqa: BLE001
        pass
    du_lieu = imm1295.chuan_hoa(_doc_luu(case) or {})
    du_lieu["anhChuKy"] = [a for a in du_lieu["anhChuKy"] if a["id"] != anh_id]
    kq = _luu_ky(db, case, du_lieu)  # chuan_hoa bỏ luôn chỗ ký đang dùng ảnh này
    activity.ghi("IMM1295_SIGNATURE_DELETE", case=case)
    return kq
