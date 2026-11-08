# Read-only boto3 client from the pinned Moto test image; no Moto server here.
# No automatic credential chain, cloud writes, object names or raw diagnostics.
import json, os, re, sys
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from botocore import UNSIGNED

try:
    identifier = os.environ["MQ_OSS_TEST_ID"]
    assert re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", identifier)
    action = sys.argv[1]
    assert action in ("empty", "measure")
    with open("/run/oss/s3_credentials", encoding="utf8") as file:
        credentials = json.load(file)
    client = boto3.client("s3", endpoint_url="https://oss-cn-hongkong.aliyuncs.com", region_name="oss-cn-hongkong",
        aws_access_key_id=credentials["accessKeyId"], aws_secret_access_key=credentials["secretAccessKey"],
        aws_session_token=credentials.get("sessionToken"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"},
                      connect_timeout=10, read_timeout=30, retries={"max_attempts": 1}))
    bucket, prefix = "mq-story-backups", "p502-synthetic/" + identifier + "/"
    count, byte_count, max_object_bytes = 0, 0, 0
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for row in page.get("Contents", []):
            assert row["Key"].startswith(prefix)
            count += 1
            byte_count += row["Size"]
            max_object_bytes = max(max_object_bytes, row["Size"])
            assert count <= 2000 and byte_count < 1024 ** 3
    if action == "empty":
        assert count == 0
        try:
            client.head_object(Bucket=bucket, Key=prefix + "config")
        except ClientError as error:
            assert error.response["ResponseMetadata"]["HTTPStatusCode"] == 404
        else:
            raise ValueError("existing repository")
    else:
        assert count > 0
        assert max_object_bytes < 200 * 1024 ** 2
        anonymous = boto3.client("s3", endpoint_url="https://oss-cn-hongkong.aliyuncs.com", region_name="oss-cn-hongkong",
            config=Config(signature_version=UNSIGNED, s3={"addressing_style": "virtual"},
                          connect_timeout=10, read_timeout=30, retries={"max_attempts": 0}))
        try:
            anonymous.head_object(Bucket=bucket, Key=prefix + "config")
        except ClientError as error:
            assert error.response["ResponseMetadata"]["HTTPStatusCode"] in (403, 404)
        else:
            raise ValueError("anonymous access")
    print(json.dumps({"empty": count == 0, "objects": count, "storedBytes": byte_count,
                      "maxObjectBytes": max_object_bytes, "anonymousConfigDenied": action == "measure", "readOnly": True}))
except ClientError as error:
    operation = error.operation_name if error.operation_name in ("ListObjectsV2", "HeadObject") else "Unknown"
    code = str(error.response.get("Error", {}).get("Code", "CloudRequestRejected"))
    if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", code):
        code = "CloudRequestRejected"
    request_id = str(error.response.get("ResponseMetadata", {}).get("RequestId", ""))
    suffix = ";requestId=" + request_id if re.fullmatch(r"[A-Za-z0-9-]{1,128}", request_id) else ""
    print("OSS_INSPECTION_FAILED operation=" + operation + ";code=" + code + suffix, file=sys.stderr)
    sys.exit(1)
except Exception:
    print("OSS_INSPECTION_FAILED code=TargetOrIntegrityRejected", file=sys.stderr)
    sys.exit(1)
