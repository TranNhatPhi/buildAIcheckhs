"""API trang "Tách file" (/tach-file) — logic ở tach_file.py.

    POST /split-tool                    caseId + file (+ loai=dich cho trang "Tách hồ sơ dịch thuật") ->
                                        đọc chữ, DeepSeek chia trang, trả bảng đề xuất
    GET  /split-tool/{job}/source.pdf   file gốc (đã thành PDF) để xem
    GET  /split-tool/{job}/pages/{n}    ảnh nhỏ trang n (xem nhanh trong bảng)
    POST /split-tool/{job}/zip          tách THEO BẢNG nhân viên gửi lên (đã sửa) -> ZIP

Công khai như mọi API trang Docs. Đồng bộ trong request (đọc chữ + DeepSeek có thể vài phút) — cùng
cách với upload hồ sơ; Caddy không cắt request dài.
"""
from __future__ import annotations

import io
import json
import logging
import re
import uuid
import zipfile
from typing import List
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

import activity
import llm
import storage
import tach_file
from db import get_db
from models import Case, ChecklistItem

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/split-tool", tags=["split-tool"])

_JOB_RE = re.compile(r"^[0-9a-f]{32}$")


def _key(job: str, ten: str) -> str:
    if not _JOB_RE.match(job or ""):
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt tách file")
    return f"{tach_file.PREFIX}/{job}/{ten}"


def _doc(job: str, ten: str) -> bytes:
    try:
        return storage.get_document_bytes(_key(job, ten))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=404, detail="Lượt tách file đã hết hạn (file tạm tự xoá sau 24 giờ) — tải file lên lại."
        ) from e


def _ho_so(db: Session, case_id: str) -> Case:
    case = db.get(Case, case_id)
    if not case or case.deletedAt is not None:
        raise HTTPException(status_code=404, detail="Không tìm thấy hồ sơ")
    return case


def _muc(db: Session, case: Case) -> list:
    return tach_file.muc_cua_ho_so(
        list(db.scalars(select(ChecklistItem)).all()),
        case.maritalStatus, case.numberOfChildren, case.skillLevel,
    )


def _muc_dto(muc) -> list[dict]:
    return [{"id": m.item.id, "number": m.so, "name": m.item.nameVi, "section": m.item.section, "label": m.nhan,
             "needsNotary": tach_file.can_cong_chung(m.item)}
            for m in muc]


@router.post("")
def phan_tich(
    caseId: str = Form(...), file: List[UploadFile] = File(...), loai: str = Form("goc"), db: Session = Depends(get_db)
):
    """`file` gửi 1 hoặc NHIỀU lần (kéo thả nhiều file một lúc). Nhiều file thì gói vào một ZIP trong bộ
    nhớ rồi đi đúng đường ZIP — cùng thứ tự theo tên, cùng chú thích "bắt đầu file gốc", cùng giới hạn."""
    if loai not in ("goc", "dich"):
        raise HTTPException(status_code=422, detail="loai chỉ nhận 'goc' hoặc 'dich'")
    ban_dich = loai == "dich"
    case = _ho_so(db, caseId)
    if len(file) == 1:
        ten_file = file[0].filename or ""
        content = file[0].file.read()
    else:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            for f in file:
                z.writestr(f.filename or "file", f.file.read())
        content = buf.getvalue()
        ten_file = f"{len(file)} file.zip"
    if not content:
        raise HTTPException(status_code=400, detail="File rỗng.")
    if len(content) > tach_file.MAX_BYTES:
        raise HTTPException(status_code=400, detail="File quá lớn (tối đa 80MB).")
    try:
        ghep = tach_file.chuan_bi_pdf(content, ten_file, ban_dich)
        pdf = ghep.pdf
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        logger.exception("Tách file: không chuẩn bị được file")
        raise HTTPException(status_code=400, detail="Không đọc / chuyển được file sang PDF.") from e

    import fitz  # PyMuPDF

    try:
        with fitz.open(stream=pdf, filetype="pdf") as d:
            so_trang = d.page_count
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Không mở được file PDF.") from e
    if so_trang == 0:
        raise HTTPException(status_code=400, detail="File không có trang nào.")
    if so_trang > tach_file.MAX_PAGES:
        raise HTTPException(status_code=400, detail=f"File {so_trang} trang — tối đa {tach_file.MAX_PAGES} trang mỗi lần.")

    muc = _muc(db, case)
    chu = tach_file.doc_chu_tung_trang(pdf)
    ghi_chu = None
    try:
        # Bản dịch: chỉ đưa AI các mục CẦN dịch (bớt nhầm sang hộ chiếu / CCCD...); ô chọn mục vẫn đủ.
        muc_ai = [m for m in muc if m.item.needsTranslation is not False] if ban_dich else muc
        doan = tach_file.chia_bang_deepseek(case.clientName, muc_ai, chu, ghep.dau_file, ban_dich)
    except Exception as e:  # noqa: BLE001
        logger.exception("Tách file: DeepSeek hỏng")
        ghi_chu = f"AI không chia được ({llm.describe_error(e)}) — mỗi trang để một dòng, hãy tự gộp và chọn mục."
        doan = tach_file.moi_trang_mot_doan(so_trang, "Chưa phân tích")
        loai_ai_hong = [tach_file.loai_trang(t) for t in chu] if ban_dich else []
        if ban_dich and tach_file.co_cau_truc(loai_ai_hong):
            # AI hỏng vẫn chia được theo cấu trúc bộ bản dịch (chỉ thiếu mục) — đưa vào MỘT đoạn để chỉ
            # còn các chỗ cắt theo cấu trúc, không giữ "mỗi trang một dòng".
            ghi_chu = f"AI không chia được ({llm.describe_error(e)}) — đã chia theo cấu trúc bộ bản dịch, hãy chọn mục."
            doan = tach_file.theo_cau_truc(
                [{"from": 1, "to": so_trang, "itemId": None, "reason": "Chia theo cấu trúc bộ bản dịch"}], loai_ai_hong
            )
    loai_trang = [tach_file.loai_trang(t) for t in chu] if ban_dich else None

    job = uuid.uuid4().hex
    storage.upload_object(_key(job, "source.pdf"), pdf, "application/pdf")
    meta = {"caseId": case.id, "originalName": ten_file, "pageCount": so_trang, "loai": loai}
    storage.upload_object(_key(job, "meta.json"), json.dumps(meta, ensure_ascii=False).encode(), "application/json")
    activity.ghi("SPLIT_FILE", case=case,
                 detail=("[Bản dịch] " if ban_dich else "") + f"{ten_file}: {so_trang} trang -> {len(doan)} file" + (" (AI lỗi)" if ghi_chu else ""))
    return {
        "jobId": job,
        "fileName": ten_file,
        "pageCount": so_trang,
        "caseId": case.id,
        "clientName": case.clientName,
        "loai": loai,
        "items": _muc_dto(muc),
        "segments": doan,
        "aiNote": ghi_chu,
        # Bản dịch: loại từng trang ("dich" | "cong_chung" | "goc" | null) + có áp cấu trúc bộ hay không —
        # giao diện ghi thành phần mỗi file và cảnh báo thiếu công chứng / bản gốc.
        "pageKinds": loai_trang,
        "structured": bool(loai_trang) and tach_file.co_cau_truc(loai_trang),
        # ZIP: file gốc nào bắt đầu ở trang nào (giao diện ghi trên từng dòng) + file bị bỏ qua.
        "sourceFiles": [{"page": p, "name": n} for p, n in sorted(ghep.dau_file.items())],
        "skipped": ghep.bo_qua,
    }


@router.get("/{job}/source.pdf")
def file_goc(job: str):
    return Response(content=_doc(job, "source.pdf"), media_type="application/pdf",
                    headers={"Content-Disposition": "inline; filename=\"source.pdf\""})


@router.get("/{job}/pages/{so}")
def anh_trang(job: str, so: int, dpi: int = 60):
    """Ảnh trang `so`. dpi=60 cho ảnh nhỏ trong bảng; khung "xem file" xin dpi cao hơn (tối đa 150)."""
    try:
        png = tach_file.anh_trang(_doc(job, "source.pdf"), so, max(40, min(dpi, 150)))
    except IndexError as e:
        raise HTTPException(status_code=404, detail="Không có trang này") from e
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


class ZipRequest(BaseModel):
    # [{"from": 1, "to": 2, "itemId": "passport" | null}] — dict thường vì "from" là từ khoá Python.
    segments: List[dict]


class MotFileRequest(BaseModel):
    segments: List[dict]
    index: int


@router.post("/{job}/file")
def mot_file(job: str, body: MotFileRequest, db: Session = Depends(get_db)):
    """MỘT file đã tách (file thứ `index` trong bảng) — nút "Đưa vào hồ sơ" lấy file này rồi upload
    qua ĐÚNG đường upload thường (POST /cases/{id}/documents): chống trùng, OCR, xếp mục theo tên
    file, ghi lịch sử y như nhân viên tự upload. Tên file ở header X-File-Name (đã mã hoá URL)."""
    meta = json.loads(_doc(job, "meta.json"))
    case = _ho_so(db, meta["caseId"])
    try:
        doan = [{"from": int(s["from"]), "to": int(s["to"]), "itemId": s.get("itemId")} for s in body.segments]
        noi_dung, ten = tach_file.mot_file(
            _doc(job, "source.pdf"), doan, body.index, _muc(db, case), case.clientName, meta.get("loai") == "dich"
        )
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e) or "Bảng tách file không hợp lệ.") from e
    return Response(content=noi_dung, media_type="application/pdf", headers={"X-File-Name": quote(ten, safe="")})


@router.post("/{job}/to-final")
def dua_vao_hoan_thanh(job: str, body: MotFileRequest, db: Session = Depends(get_db)):
    """Trang "Tách hồ sơ dịch thuật": tách file thứ `index` theo bảng và cất vào "hồ sơ hoàn thành"
    (routers/final_docs.py) — KHÔNG vào giấy tờ của hồ sơ thô. Trùng tên thì thay bản cũ."""
    from routers import final_docs

    meta = json.loads(_doc(job, "meta.json"))
    if meta.get("loai") != "dich":
        raise HTTPException(status_code=400, detail="Chỉ bản dịch mới đưa vào hồ sơ hoàn thành.")
    case = _ho_so(db, meta["caseId"])
    try:
        doan = [{"from": int(s["from"]), "to": int(s["to"]), "itemId": s.get("itemId")} for s in body.segments]
        noi_dung, ten = tach_file.mot_file(_doc(job, "source.pdf"), doan, body.index, _muc(db, case), case.clientName, True)
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e) or "Bảng tách file không hợp lệ.") from e
    d = doan[body.index]
    f, da_thay = final_docs.luu_file(db, case, ten, noi_dung, d["itemId"], d["to"] - d["from"] + 1)
    activity.ghi("FINAL_ADD", case=case, detail=ten + (" (thay bản cũ)" if da_thay else ""))
    return {"id": f.id, "fileName": ten, "replaced": da_thay}


@router.post("/{job}/zip")
def tai_zip(job: str, body: ZipRequest, db: Session = Depends(get_db)):
    meta = json.loads(_doc(job, "meta.json"))
    case = _ho_so(db, meta["caseId"])
    if not body.segments:
        raise HTTPException(status_code=400, detail="Không có file nào để tách.")
    try:
        doan = [{"from": int(s["from"]), "to": int(s["to"]), "itemId": s.get("itemId")} for s in body.segments]
        ban_dich = meta.get("loai") == "dich"
        noi_dung, ten = tach_file.tao_zip(_doc(job, "source.pdf"), doan, _muc(db, case), case.clientName, ban_dich)
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e) or "Bảng tách file không hợp lệ.") from e
    activity.ghi("SPLIT_ZIP", case=case,
                 detail=("[Bản dịch] " if ban_dich else "") + f"{meta.get('originalName')}: tải {len(ten)} file")
    ten_zip = f"{tach_file._sach_ten(case.clientName)} - " + ("tach ban dich.zip" if ban_dich else "tach file.zip")
    ascii_ten = "".join(c if 32 <= ord(c) < 127 and c not in '"?' + chr(92) else "_" for c in ten_zip)
    return Response(
        content=noi_dung,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=\"{ascii_ten}\"; filename*=UTF-8''{quote(ten_zip, safe='')}"},
    )
