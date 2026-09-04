import os
import re
import uuid

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


def get_document_bytes(key: str) -> bytes:
    res = _s3.get_object(Bucket=BUCKET, Key=key)
    return res["Body"].read()


def delete_document(key: str) -> None:
    _s3.delete_object(Bucket=BUCKET, Key=key)
