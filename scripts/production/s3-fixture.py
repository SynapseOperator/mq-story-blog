"""Disposable Moto fixture; no host ports or real provider credentials.

The four bootstrap AWS calls are followed by mandatory negative authentication
checks. Moto is an S3 protocol/IAM simulation, not evidence of cloud IAM parity.
"""
import json
import logging
import os
import re
import signal
from threading import Lock
from urllib.parse import parse_qs, unquote

os.environ["INITIAL_NO_AUTH_ACTION_COUNT"] = "4"
oss = os.environ.get("MQ_LAB_OSS") == "true"
os.environ["S3_IGNORE_SUBDOMAIN_BUCKETNAME"] = "false" if oss else "true"
import boto3
from botocore.exceptions import ClientError
from moto.server import ThreadedMotoServer

logging.getLogger("werkzeug").setLevel(logging.CRITICAL)
server = ThreadedMotoServer(ip_address="0.0.0.0", port=5000, verbose=False)
server.start()
if oss:
    # This is a pinned Moto test fixture, not an OSS service or RAM emulator.
    # Inspect only routing/signing properties; never persist Authorization.
    application = server._server.app
    prefix = os.environ["MQ_LAB_OSS_PREFIX"] + "/"
    evidence = {"requests": 0, "virtualHost": True, "regionScope": True, "methods": [],
                "headBucketDenied": 0, "unscopedListsDenied": 0, "nonLockDeletesDenied": 0}
    evidence_lock = Lock()

    def transport_check(environ, start_response):
        host = environ.get("HTTP_HOST", "")
        if host.endswith(".aliyuncs.com"):
            valid_host = host == "mq-lab.oss-cn-hongkong.aliyuncs.com"
            valid_scope = re.search(r"Credential=[^ /]+/[0-9]{8}/oss-cn-hongkong/s3/aws4_request(?:,| )",
                                    environ.get("HTTP_AUTHORIZATION", "")) is not None
            method = environ["REQUEST_METHOD"]
            key = unquote(environ["PATH_INFO"]).lstrip("/")
            query = parse_qs(environ.get("QUERY_STRING", ""))
            # Model the relevant least-privilege boundaries; this is not a
            # claim that Moto implements Alibaba RAM policies.
            head_bucket = method == "HEAD" and not key
            unscoped_list = method == "GET" and not key and not query.get("prefix", [""])[0].startswith(prefix)
            nonlock_delete = method == "DELETE" and not key.startswith(prefix + "locks/")
            with evidence_lock:
                evidence["requests"] += 1
                evidence["virtualHost"] = evidence["virtualHost"] and valid_host
                evidence["regionScope"] = evidence["regionScope"] and valid_scope
                evidence["methods"] = sorted(set(evidence["methods"] + [method]))
                evidence["headBucketDenied"] += int(head_bucket)
                evidence["unscopedListsDenied"] += int(unscoped_list)
                evidence["nonLockDeletesDenied"] += int(nonlock_delete)
                with open("/credentials/transport.json", "w", opener=lambda p, f: os.open(p, f, 0o600)) as record:
                    json.dump(evidence, record)
            if not valid_host or not valid_scope:
                start_response("400 Bad Request", [("Content-Type", "text/plain")])
                return [b"OSS_TRANSPORT_CONTRACT_REJECTED"]
            if head_bucket or unscoped_list or nonlock_delete:
                start_response("403 Forbidden", [("Content-Type", "application/xml")])
                return [b"<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"]
        return application(environ, start_response)

    server._server.app = transport_check
endpoint = "http://127.0.0.1:5000"
bootstrap = dict(endpoint_url=endpoint, region_name="us-east-1",
                 aws_access_key_id="synthetic-bootstrap", aws_secret_access_key="synthetic-bootstrap")
iam = boto3.client("iam", **bootstrap)
iam.create_user(UserName="mq-backup-lab")
key = iam.create_access_key(UserName="mq-backup-lab")["AccessKey"]
iam.put_user_policy(UserName="mq-backup-lab", PolicyName="scoped-backup", PolicyDocument=json.dumps({
    "Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:*",
    "Resource": ["arn:aws:s3:::mq-lab", "arn:aws:s3:::mq-lab/*"]}]}))
boto3.client("s3", **bootstrap).create_bucket(Bucket="mq-lab")
credentials = dict(bootstrap, aws_access_key_id=key["AccessKeyId"], aws_secret_access_key=key["SecretAccessKey"])
boto3.client("s3", **credentials).list_objects_v2(Bucket="mq-lab")
for invalid in [bootstrap, dict(credentials, aws_secret_access_key="wrong-synthetic-secret")]:
    try:
        boto3.client("s3", **invalid).list_objects_v2(Bucket="mq-lab")
        raise RuntimeError("S3_NEGATIVE_AUTHENTICATION_DID_NOT_FAIL")
    except ClientError as error:
        assert error.response["ResponseMetadata"]["HTTPStatusCode"] == 403
path = "/credentials/s3_credentials"
with open(path, "x", opener=lambda p, f: os.open(p, f, 0o400)) as output:
    json.dump({"accessKeyId": key["AccessKeyId"], "secretAccessKey": key["SecretAccessKey"]}, output)
print("S3_FIXTURE_READY authentication-negative-controls=2", flush=True)
signal.pause()
