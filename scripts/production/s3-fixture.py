"""Disposable Moto fixture; no host ports or real provider credentials.

The four bootstrap AWS calls are followed by mandatory negative authentication
checks. Moto is an S3 protocol/IAM simulation, not evidence of cloud IAM parity.
"""
import json
import logging
import os
import signal

os.environ["INITIAL_NO_AUTH_ACTION_COUNT"] = "4"
os.environ["S3_IGNORE_SUBDOMAIN_BUCKETNAME"] = "true"
import boto3
from botocore.exceptions import ClientError
from moto.server import ThreadedMotoServer

logging.getLogger("werkzeug").setLevel(logging.CRITICAL)
server = ThreadedMotoServer(ip_address="0.0.0.0", port=5000, verbose=False)
server.start()
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
