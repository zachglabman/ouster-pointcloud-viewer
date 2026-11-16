"""Egress kill switch for the point cloud viewer.

Triggered by Pub/Sub messages from the Cloud Monitoring alert
"Point cloud viewer: egress HARD CEILING". On an *open* incident it:
  1. attaches the deny-all edge security policy (POLICY) to the CDN backend bucket (BACKEND), and
  2. removes allUsers from the bucket IAM policy, closing the direct storage.googleapis.com path.
Closed incidents and anything else are logged and ignored. Recovery is manual (see README.md).
"""
import base64
import json
import os

import functions_framework
from google.cloud import compute_v1, storage

PROJECT = os.environ["PROJECT"]
BACKEND = os.environ["BACKEND"]
POLICY = os.environ["POLICY"]
BUCKET = os.environ["BUCKET"]


@functions_framework.cloud_event
def trip(event):
    raw = base64.b64decode(event.data["message"]["data"])
    msg = json.loads(raw)
    incident = msg.get("incident", {})
    state = incident.get("state")
    if state != "open":
        print(f"killswitch: ignored message (incident state={state!r})")
        return

    print(f"killswitch: TRIPPED by incident {incident.get('incident_id')} ({incident.get('policy_name')})")

    bb = compute_v1.BackendBucketsClient()
    current = bb.get(project=PROJECT, backend_bucket=BACKEND).edge_security_policy or ""
    if current.endswith(f"/securityPolicies/{POLICY}"):
        print(f"killswitch: {BACKEND} already has {POLICY}")
    else:
        ref = compute_v1.SecurityPolicyReference(
            security_policy=f"projects/{PROJECT}/global/securityPolicies/{POLICY}")
        op = bb.set_edge_security_policy(project=PROJECT, backend_bucket=BACKEND,
                                         security_policy_reference_resource=ref)
        op.result(timeout=180)
        print(f"killswitch: attached {POLICY} to {BACKEND}")

    bucket = storage.Client(project=PROJECT).bucket(BUCKET)
    pol = bucket.get_iam_policy(requested_policy_version=3)
    removed = [b["role"] for b in pol.bindings if "allUsers" in b["members"]]
    if removed:
        for b in pol.bindings:
            b["members"].discard("allUsers")
        pol.bindings = [b for b in pol.bindings if b["members"]]
        bucket.set_iam_policy(pol)
        print(f"killswitch: removed allUsers from gs://{BUCKET} ({', '.join(removed)})")
    else:
        print(f"killswitch: gs://{BUCKET} has no allUsers binding")
