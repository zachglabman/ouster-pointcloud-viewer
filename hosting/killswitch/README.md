# Egress kill switch

Stops all viewer traffic when egress passes a hard ceiling, instead of only emailing.

```
Cloud Monitoring alert "Point cloud viewer: egress HARD CEILING 20 TB/day (kill switch)"
  (LB response bytes OR bucket sent bytes, 24 h sum > 20 TB)
    ├─▶ email channel (owner)
    └─▶ Pub/Sub channel ─▶ topic pcv-egress-killswitch ─▶ Cloud Function pcv-killswitch (us-west1, gen2)
          1. attaches edge security policy pcv-killswitch (default rule: deny 403) to backend bucket pcv-backend
          2. removes allUsers from gs://ouster-pointcloud-viewer (closes the direct storage.googleapis.com path)
```

The 500 GB/day email-only alert is unchanged and still fires first.

The function acts only on messages whose `incident.state` is `open`; closed incidents are logged and ignored.
Metrics lag a few minutes, so it caps the damage rather than stopping it instantly.

## Identity and permissions
Runs as `pcv-killswitch@ouster-growth-dashboard.iam.gserviceaccount.com`, which holds only:
- `projects/ouster-growth-dashboard/roles/pcvKillswitchCompute` (project): `compute.backendBuckets.get`,
  `compute.backendBuckets.setSecurityPolicy`, `compute.securityPolicies.use`, `compute.globalOperations.get`
- `projects/ouster-growth-dashboard/roles/pcvKillswitchBucket` (on the bucket only): `storage.buckets.get`,
  `storage.buckets.getIamPolicy`, `storage.buckets.setIamPolicy`
- `roles/serviceusage.serviceUsageConsumer` (project; Eventarc trigger validation requires it)
- `roles/run.invoker` on the function's Cloud Run service (for the Eventarc trigger)

Built by `pcv-killswitch-build@ouster-growth-dashboard.iam.gserviceaccount.com`, which holds only
`roles/cloudbuild.builds.builder`. The project's default Cloud Build account has no permissions, so the
deploy must pass `--build-service-account`.

The Monitoring notification service agent
(`service-874867146464@gcp-sa-monitoring-notification.iam.gserviceaccount.com`) has `roles/pubsub.publisher`
on the topic only.

## Recovery (manual, after finding the cause)
```sh
P=ouster-growth-dashboard
gcloud compute backend-buckets update pcv-backend --edge-security-policy="" --project=$P
# Only while the site is still served from storage.googleapis.com (before the bucket goes private):
gcloud storage buckets add-iam-policy-binding gs://ouster-pointcloud-viewer \
  --member=allUsers --role=roles/storage.legacyObjectReader
```
If the alert is still open it will not fire again; close the incident in Cloud Monitoring once things are fixed.

## Logs
`gcloud functions logs read pcv-killswitch --gen2 --region=us-west1 --project=ouster-growth-dashboard`
Every action prints a `killswitch:` line.

## Redeploy
```sh
gcloud functions deploy pcv-killswitch --gen2 --project=ouster-growth-dashboard --region=us-west1 \
  --runtime=python312 --source=. --entry-point=trip --trigger-topic=pcv-egress-killswitch \
  --service-account=pcv-killswitch@ouster-growth-dashboard.iam.gserviceaccount.com \
  --trigger-service-account=pcv-killswitch@ouster-growth-dashboard.iam.gserviceaccount.com \
  --build-service-account=projects/ouster-growth-dashboard/serviceAccounts/pcv-killswitch-build@ouster-growth-dashboard.iam.gserviceaccount.com \
  --no-allow-unauthenticated --ingress-settings=internal-only --memory=256Mi --max-instances=1 --timeout=300 \
  --set-env-vars=PROJECT=ouster-growth-dashboard,BACKEND=pcv-backend,POLICY=pcv-killswitch,BUCKET=ouster-pointcloud-viewer
```
