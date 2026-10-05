"""Trang "Kiểm tra hồ sơ dịch thuật": nhận họ tên + cả bộ bản dịch, trả về báo cáo quy tắc.

Bản dịch được LƯU LÊN MINIO để bấm vào tên file là mở lại được (kể cả sau khi tải lại trang
hay từ máy khác) — trước đó file chỉ nằm trong bộ nhớ trình duyệt nên F5 là mất.

KHÔNG có bảng DB nào cho phần này: mỗi lượt kiểm tra là một thư mục trên MinIO,
"translation-checks/<id>/<số thứ tự>.<đuôi file>" (vd "translation-checks/ab12.../00.docx") —
cần mở file nào thì hỏi thẳng MinIO theo tiền tố đó. Đặt tên theo SỐ THỨ TỰ chứ không theo tên
file gốc: tên thật có dấu tiếng Việt và dấu ngoặc, đưa vào key rồi ghép lại lúc đọc là chỗ rất
dễ sai; tên hiển thị đã nằm sẵn ở kết quả trả về cho frontend.

Đổi lại: không tra cứu lại được lịch sử kiểm tra (không có danh sách các lượt đã chạy) và file
KHÔNG tự xoá — dọn thì xoá tiền tố "translation-checks/" trên MinIO Console.
"""
from __future__ import annotations

import logging
import os
import re
import unicodedata
import uuid
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel

import activity
import storage
import translation_check as tc

logger = logging.getLogger("translation_check")

router = APIRouter(prefix="/translation-check", tags=["translation-check"])

MAX_FILES = 60
MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024  # cùng giới hạn với upload hồ sơ (case_documents.py)

# Lấy từ storage.py để case_cleanup.py dọn đúng chỗ — xem ghi chú ở đó.
STORAGE_PREFIX = storage.TRANSLATION_CHECK_PREFIX

# Bản JSON của kết quả, nằm cùng thư mục với file gốc nên cũng tự hết hạn theo cùng một lượt
# dọn. Đặt tên KHÁC hẳn dạng "<số thứ tự>.<đuôi>" để không lẫn với file bản dịch lúc liệt kê.
RESULT_KEY = "result.json"

# Kiểu file cho trình duyệt biết đường mở. Word thì trình duyệt tải về rồi mở bằng Word, PDF và
# ảnh xem thẳng trên tab mới.
_MEDIA_TYPES = {
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def _content_disposition(filename: str) -> str:
    """Giống hệt lý do ở routers/documents.py: tên file có dấu tiếng Việt mà nhét thẳng vào
    header sẽ làm Starlette crash (header bắt buộc ASCII) — dùng RFC 5987."""
    ascii_fallback = re.sub(r'[\x00-\x1f\x7f"\\?]', "_", filename.encode("ascii", "replace").decode("ascii"))
    return f"inline; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


# Cắt bớt văn bản trả về: học bạ 3 năm trong bộ mẫu đã 36k ký tự, gửi 60 file như vậy là vài MB
# cho một lần kiểm tra. 120k ký tự phủ trọn mọi giấy tờ trong bộ mẫu, phần cắt chỉ xảy ra với
# tài liệu bất thường và có ghi rõ ở cuối.
MAX_TEXT_CHARS = 120_000


class TranslationFileDTO(BaseModel):
    filename: str
    ownerName: str | None
    ownerForm: str | None
    chars: int
    error: str | None
    names: list[str]
    idNumbers: list[str]
    # Chữ app đọc được từ bản dịch — để nhân viên bấm vào file là xem được ngay app đã đọc ra
    # gì, thay vì phải mở file rồi tự dò.
    text: str
    # Đường dẫn mở lại chính file đã lưu trên MinIO; None nếu lưu hỏng (việc kiểm tra vẫn chạy).
    url: str | None


class TranslationFindingDTO(BaseModel):
    severity: str
    rule: str
    title: str
    message: str
    files: list[str]


class TranslationSummaryDTO(BaseModel):
    files: int
    readable: int
    errors: int
    warnings: int


class TranslationCheckResponse(BaseModel):
    applicantName: str
    expectedName: str
    # Mã lượt kiểm tra = tên thư mục trên MinIO đang giữ bộ bản dịch này.
    checkId: str
    files: list[TranslationFileDTO]
    findings: list[TranslationFindingDTO]
    summary: TranslationSummaryDTO


def _display_names(report: tc.FileReport) -> list[str]:
    """Tên kèm vai trò đọc được ("HO XUAN TINH (chủ hộ)").

    Trong một bộ bản dịch có nhiều người (đương đơn, bố, mẹ, vợ/chồng, con), bảng kết quả chỉ
    liệt kê tên trơn thì nhân viên không biết tên nào là của ai để đối chiếu — vai trò lấy từ
    chữ đứng ngay trước tên trong chính bản dịch (xem _role_from_context ở translation_check.py).
    """
    return [
        f"{n} ({', '.join(sorted(report.roles[n]))})" if report.roles.get(n) else n
        for n in sorted(set(report.names))
    ]


@router.post("", response_model=TranslationCheckResponse)
def check_translations(
    # Mặc định "" chứ không bắt buộc ở tầng FastAPI: thiếu trường thì FastAPI tự trả 422 kèm
    # câu tiếng Anh ("Field required"). Để trống rồi tự kiểm tra bên dưới -> luôn ra cùng một
    # câu tiếng Việt, dù người gọi quên gửi trường hay gửi chuỗi rỗng.
    response: Response,
    applicantName: str = Form(""),
    files: list[UploadFile] = File(...),
):
    # `def` thường, không `async`: đọc .doc/.pdf chạy tiến trình con / OCR (block) — xem giải
    # thích ở upload_document trong case_documents.py.
    name = " ".join(unicodedata.normalize("NFC", applicantName).split())
    expected = tc.to_translation_form(name)
    # Bắt buộc có họ tên: mọi quy tắc tên đều so với tên này — thiếu nó thì không biết tên
    # "đúng" là gì để bắt bản dịch ghi lệch.
    if len(expected.split()) < 2:
        raise HTTPException(status_code=400, detail="Nhập đầy đủ họ và tên của hồ sơ (ít nhất họ và tên).")
    if not files:
        raise HTTPException(status_code=400, detail="Chưa chọn file bản dịch nào.")
    if len(files) > MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Tối đa {MAX_FILES} file mỗi lần kiểm tra.")

    check_id = uuid.uuid4().hex
    # Gửi kèm mã lượt kiểm tra ở HEADER, ngoài phần thân JSON: đã gặp thật (28/09, 34 file) máy chủ
    # trả 200 + lưu kết quả xong nhưng trình duyệt không đọc được phần thân. Có mã ở header thì
    # giao diện tự đọc lại kết quả đã lưu (GET /translation-check/{id}) thay vì báo lỗi khó hiểu.
    response.headers["X-Check-Id"] = check_id
    urls: list[str | None] = []
    reports: list[tc.FileReport] = []
    for index, upload in enumerate(files):
        filename = tc.fix_mojibake(unicodedata.normalize("NFC", upload.filename or "file"))
        report = tc.FileReport(filename=filename)
        report.owner_name = tc.owner_from_filename(filename)
        report.owner_form = tc.to_translation_form(report.owner_name) if report.owner_name else None
        content = upload.file.read()
        url: str | None = None
        if len(content) > MAX_FILE_SIZE_BYTES:
            report.error = "File quá lớn (tối đa 20MB)."
        else:
            # Lưu trước khi đọc chữ: file KHÔNG đọc được chữ cũng phải mở lại được, vì đó chính
            # là lúc nhân viên cần mở ra xem tận mắt. Lưu hỏng thì vẫn kiểm tra tiếp, chỉ mất nút
            # "Mở file gốc" — không đáng để làm hỏng cả lượt kiểm tra.
            ext = os.path.splitext(filename.lower())[1]
            key = f"{STORAGE_PREFIX}/{check_id}/{index:02d}{ext}"
            try:
                storage.upload_object(key, content, _MEDIA_TYPES.get(ext, "application/octet-stream"))
                url = f"/translation-check/{check_id}/files/{index}"
            except Exception:  # noqa: BLE001
                logger.exception("Không lưu được bản dịch %s lên MinIO", filename)
            try:
                report.text = tc.extract_text(content, filename)
                report.chars = len(report.text.strip())
                if not report.chars:
                    report.error = "File không có chữ nào đọc được."
            except ValueError as e:
                report.error = str(e)
            except Exception:  # noqa: BLE001
                # 1 file hỏng không được làm hỏng cả bộ — các file khác vẫn phải được kiểm tra.
                logger.exception("Không đọc được bản dịch %s", filename)
                report.error = "Không đọc được file (file hỏng hoặc sai định dạng)."
        reports.append(report)
        urls.append(url)

    findings = tc.check_translation_set(name, reports)
    ket_qua = TranslationCheckResponse(
        applicantName=name,
        expectedName=expected,
        checkId=check_id,
        files=[
            TranslationFileDTO(
                filename=r.filename, ownerName=r.owner_name, ownerForm=r.owner_form, chars=r.chars,
                error=r.error, names=_display_names(r), idNumbers=r.id_numbers,
                text=(r.text[:MAX_TEXT_CHARS] + "\n\n[... đã cắt bớt, xem file gốc ...]"
                      if len(r.text) > MAX_TEXT_CHARS else r.text),
                url=url,
            )
            for r, url in zip(reports, urls)
        ],
        findings=[
            TranslationFindingDTO(severity=f.severity, rule=f.rule, title=f.title, message=f.message, files=f.files)
            for f in findings
        ],
        summary=TranslationSummaryDTO(
            files=len(reports),
            readable=sum(1 for r in reports if not r.error),
            errors=sum(1 for f in findings if f.severity == "ERROR"),
            warnings=sum(1 for f in findings if f.severity == "WARNING"),
        ),
    )

    # Lưu nguyên kết quả lên MinIO để F5 (hoặc mở lại link) không mất báo cáo. Không có bảng
    # DB nào cho phần này, mà chạy lại từ đầu thì tốn vài phút OCR và có thể ra khác — nên cất
    # thẳng bản JSON đã trả về, đọc lại là ra đúng y hệt.
    #
    # Lưu HỎNG thì bỏ qua: mất khả năng F5 còn hơn làm hỏng cả lượt kiểm tra vừa chạy xong.
    try:
        storage.upload_object(
            f"{STORAGE_PREFIX}/{check_id}/{RESULT_KEY}",
            ket_qua.model_dump_json().encode("utf-8"),
            "application/json",
        )
    except Exception:  # noqa: BLE001
        logger.exception("Không lưu được kết quả kiểm tra %s", check_id)
    activity.ghi(
        "TRANSLATION_CHECK",
        detail=f"Bộ hồ sơ {name}: {len(reports)} file — {ket_qua.summary.errors} lỗi, "
        f"{ket_qua.summary.warnings} cảnh báo (mã {check_id})",
    )
    return ket_qua


@router.get("/{check_id}", response_model=TranslationCheckResponse)
def get_translation_check(check_id: str):
    """Đọc lại kết quả một lượt kiểm tra đã chạy — dùng khi nhân viên F5 hoặc mở lại link.

    Kiểm tra dạng check_id TRƯỚC KHI ghép vào key, cùng lý do với endpoint mở file bên dưới.
    """
    if not re.fullmatch(r"[0-9a-f]{32}", check_id):
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt kiểm tra")
    try:
        raw = storage.get_document_bytes(f"{STORAGE_PREFIX}/{check_id}/{RESULT_KEY}")
    except Exception as e:  # noqa: BLE001
        # Hết hạn giữ (xem case_cleanup.py) hoặc id sai — cùng một câu trả lời cho người dùng.
        raise HTTPException(
            status_code=404,
            detail="Lượt kiểm tra này không còn (bản dịch chỉ được giữ 7 ngày). Gửi lại file để kiểm tra mới.",
        ) from e
    return TranslationCheckResponse.model_validate_json(raw)


@router.get("/{check_id}/files/{index}")
def get_translation_file(check_id: str, index: int, filename: str | None = None):
    """Mở lại một bản dịch đã lưu ở lượt kiểm tra trước.

    Kiểm tra dạng check_id/index TRƯỚC KHI ghép vào key: thiếu bước này thì chuỗi kiểu
    "../../" trong URL sẽ trỏ ra ngoài thư mục của lượt kiểm tra và đọc được file của hồ sơ
    khách khác trong cùng bucket.

    Không có bảng DB nào lưu key nên hỏi thẳng MinIO theo tiền tố — chỉ có đúng 1 object bắt
    đầu bằng "<số thứ tự>." trong thư mục của lượt đó (xem cách đặt key ở trên).
    """
    if not re.fullmatch(r"[0-9a-f]{32}", check_id) or not 0 <= index < MAX_FILES:
        raise HTTPException(status_code=404, detail="Không tìm thấy file")

    prefix = f"{STORAGE_PREFIX}/{check_id}/{index:02d}"
    keys = [k for k in storage.list_objects(prefix) if os.path.basename(k).startswith(f"{index:02d}.")]
    if not keys:
        raise HTTPException(status_code=404, detail="File không còn trên hệ thống lưu trữ")
    try:
        content = storage.get_document_bytes(keys[0])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="File không còn trên hệ thống lưu trữ") from e

    ext = os.path.splitext(keys[0])[1].lower()
    # Tên hiện lúc tải về do frontend gửi kèm (key trên MinIO chỉ có số thứ tự) — thiếu thì
    # dùng tạm tên theo số thứ tự, vẫn mở được.
    display = unicodedata.normalize("NFC", filename) if filename else f"ban-dich-{index:02d}{ext}"
    return Response(
        content=content,
        media_type=_MEDIA_TYPES.get(ext, "application/octet-stream"),
        headers={"Content-Disposition": _content_disposition(display)},
    )
