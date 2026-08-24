import os
import re
import uuid

import boto3

_s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["MINIO_ENDPOINT"],
    aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
    aws_secret_access_key=os.environ["MINIO_SECRET_KEY"],
    region_name="us-east-1",  # MinIO không dùng region thật, chỉ cần giá trị hợp lệ cho SDK
)

BUCKET = os.environ["MINIO_BUCKET"]


def _sanitize_filename(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]", "_", name)


def upload_document(case_id: str, original_filename: str, content: bytes, mime_type: str) -> str:
    key = f"{case_id}/{uuid.uuid4()}-{_sanitize_filename(original_filename)}"
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
