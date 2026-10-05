import os
import re
import uuid
from datetime import datetime

import boto3
from botocore.exceptions import ClientError

_s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    region_name="us-east-1",  # MinIO không dùng region thật, chỉ cần giá trị hợp lệ cho SDK
)

BUCKET = os.environ["MINIO_BUCKET"]

# Thư mục giữ bản dịch của trang "Kiểm tra dịch thuật". Khai ở đây chứ không ở router vì
# case_cleanup.py cũng phải biết đúng tiền tố này để dọn — hai nơi tự khai là dọn nhầm chỗ
# hoặc dọn hụt mà không ai thấy (không có bảng DB nào đối chiếu được).
TRANSLATION_CHECK_PREFIX = "translation-checks"



def _ensure_bucket_exists() -> None:
    # Trên 1 MinIO instance hoàn toàn mới (vd VM production lần đầu deploy), bucket chưa tồn
    # tại — put_object sẽ lỗi NoSuchBucket. Local dev không gặp vì bucket đã tạo từ trước và
    # volume Docker giữ nguyên qua các lần restart. Tự tạo (idempotent, chỉ tạo nếu chưa có)
    # để không cần thêm bước thủ công nào khi deploy lần đầu.
    try:
        _s3.head_bucket(Bucket=BUCKET)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchBucket"):
            _s3.create_bucket(Bucket=BUCKET)
        else:
            raise


_ensure_bucket_exists()


def _sanitize_filename(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]", "_", name)


def upload_document(case_id: str, original_filename: str, content: bytes, mime_type: str) -> str:
    prefix = f"{case_id}/{uuid.uuid4()}-"
    safe_name = _sanitize_filename(original_filename) or "file"
    # Document.storedPath là VARCHAR(191). Tên file hệ điều hành thường cho phép dài hơn
    # phần còn lại sau case id + UUID; nếu không cắt trước, MinIO nhận file nhưng INSERT DB
    # lỗi "Data too long", để lại object mồ côi không còn bản ghi nào trỏ tới.
    key = f"{prefix}{safe_name[:max(1, 191 - len(prefix))]}"
    _s3.put_object(Bucket=BUCKET, Key=key, Body=content, ContentType=mime_type)
    return key


def upload_object(key: str, content: bytes, mime_type: str) -> str:
    """Như upload_document nhưng dùng đúng key được truyền vào (không random UUID) — cho
    các trường hợp cần key có thể suy ra lại được sau này (vd ảnh từng trang PDF, suy từ
    document_id + số trang) thay vì phải lưu riêng danh sách key vào DB."""
    _s3.put_object(Bucket=BUCKET, Key=key, Body=content, ContentType=mime_type)
    return key


def list_objects(prefix: str) -> list[str]:
    """Các key đang có dưới một tiền tố. Dùng cho bộ bản dịch (translation-checks/<id>/...) —
    chỗ đó KHÔNG có bảng DB nào lưu key, nên phải hỏi thẳng MinIO xem file nằm ở key nào."""
    res = _s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
    return sorted(item["Key"] for item in res.get("Contents", []))


def delete_prefix(prefix: str) -> int:
    """Xoá MỌI object dưới một tiền tố, trả về số object đã xoá.

    Dùng để xoá sạch file của một hồ sơ (tiền tố "<case_id>/"): gồm cả file gốc LẪN ảnh từng
    trang PDF ("<doc_id>-pages/page-N.png"). Xoá từng tài liệu qua delete_document chỉ xoá
    file gốc — ảnh trang (chính là ảnh chụp CCCD/khai sinh, và nặng gấp hàng chục lần file gốc)
    sẽ nằm lại vĩnh viễn.

    Tiền tố PHẢI kết thúc bằng "/": "abc" sẽ khớp cả thư mục "abcdef/" của hồ sơ khác.
    """
    if not prefix.endswith("/"):
        raise ValueError(f"Tiền tố phải kết thúc bằng '/': {prefix!r}")
    keys = [k for k, _ in list_objects_with_time(prefix)]
    # delete_objects nhận tối đa 1000 key mỗi lần.
    for i in range(0, len(keys), 1000):
        res = _s3.delete_objects(
            Bucket=BUCKET,
            Delete={"Objects": [{"Key": k} for k in keys[i:i + 1000]], "Quiet": True},
        )
        loi = res.get("Errors") or []
        if loi:
            raise RuntimeError(f"Không xoá được {len(loi)} file, vd {loi[0].get('Key')}: {loi[0].get('Message')}")
    return len(keys)


def list_objects_with_time(prefix: str) -> list[tuple[str, "datetime"]]:
    """(key, thời điểm ghi lên MinIO) của MỌI object dưới tiền tố, có phân trang.

    Khác list_objects ở hai chỗ, đều cần cho việc dọn theo tuổi file:
      - trả kèm LastModified để biết file bao nhiêu tuổi (không bảng DB nào lưu mốc này);
      - ĐI HẾT các trang: list_objects_v2 chỉ trả tối đa 1000 key mỗi lần, mà một lượt kiểm
        tra đã có thể 60 file — dọn hụt thì file cũ nằm lại vĩnh viễn và không ai biết.
    """
    ra: list[tuple[str, datetime]] = []
    token = None
    while True:
        kw = {"Bucket": BUCKET, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        res = _s3.list_objects_v2(**kw)
        ra.extend((item["Key"], item["LastModified"]) for item in res.get("Contents", []))
        if not res.get("IsTruncated"):
            return ra
        token = res.get("NextContinuationToken")


def get_document_bytes(key: str) -> bytes:
    res = _s3.get_object(Bucket=BUCKET, Key=key)
    return res["Body"].read()


def delete_document(key: str) -> None:
    _s3.delete_object(Bucket=BUCKET, Key=key)
