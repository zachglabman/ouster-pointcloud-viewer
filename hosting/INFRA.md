# Live infrastructure

How viewer.ouster.com is served. Everything is in the Google Cloud project `ouster-growth-dashboard`.
These resources were created by hand (names `pcv-*`), not by `cdn-setup.sh`, which uses different names
and is kept as a template.

```
browser ──DNS (Cloudflare, DNS only)──▶ 34.96.125.236  (pcv-ip, global static IP)
  :443  pcv-https (forwarding rule) ─▶ pcv-proxy (HTTPS proxy, cert pcv-cert) ─▶ pcv-urlmap ─▶ pcv-backend ─▶ gs://ouster-pointcloud-viewer
  :80   pcv-http  (forwarding rule) ─▶ pcv-http-proxy ─▶ pcv-http-redirect (301 to https://viewer.ouster.com)
```

Classic global external Application Load Balancer (`EXTERNAL` scheme), backend bucket with Cloud CDN.

## Bucket: `gs://ouster-pointcloud-viewer` (us-west1)

| Path | What | Cache-Control |
|---|---|---|
| `viewer/index.html`, `viewer/datasets*.json` | page and dataset list | `no-cache` (edits go live at once) |
| `viewer/assets/` | hashed app bundle | 1 year, immutable |
| `viewer/potree/` | Potree 1.8.2 bundle (open source) | 1 day |
| `pointclouds/ggp-v2.copc.laz` | the 13.8 GB point cloud, streamed with Range requests | 1 year, immutable |

- **Access:** uniform bucket-level access. `allUsers` has `roles/storage.legacyObjectReader`, which lets
  anyone read objects but not list, write or delete. Only project Owners can write.
- **CORS:** GET/HEAD from `https://viewer.ouster.com` only, Range allowed (`gcs-cors.json`).
- **Deploys:** `sh hosting/gcs-setup.sh site`, run by an Owner. Nothing in CI deploys; GitHub Actions
  only builds and lints.

## Load balancer and CDN

- **Host rule (`pcv-urlmap`):** only `viewer.ouster.com` is served. Any other Host header, including the
  raw IP, gets a 301 to `https://viewer.ouster.com`. `/` and `/viewer/` redirect to `/viewer/index.html`.
- **HTTPS only:** port 80 returns a 301 to `https://viewer.ouster.com`.
- **Certificate:** Google-managed `pcv-cert`. Issuance requires viewer.ouster.com to resolve directly to
  34.96.125.236, so the Cloudflare record must be DNS only (not proxied).
- **CDN (`pcv-backend`):** `CACHE_ALL_STATIC`, honoring each object's Cache-Control. The default backend
  bucket cache key ignores query strings Cloud Storage doesn't use, so `?anything=` can't bypass the cache.
  Share links keep their state in the `#hash`, which never reaches the server.
- **Response headers (`pcv-backend`):**
  - `Strict-Transport-Security: max-age=31536000`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Content-Security-Policy-Report-Only`: `'self'`, the hash of the one inline analytics script, Google
    Tag Manager / Analytics, `'wasm-unsafe-eval'` (LAZ decoding), `worker-src blob:` (Potree workers),
    `style-src 'unsafe-inline'` (jQuery), `frame-ancestors 'self' https://ouster.com https://*.ouster.com`.
    It's report-only until it has been tested through the CDN, then it will be enforced. If
    `viewer/index.html`'s inline script changes, update the hash.
- **Cloud Armor:** only the kill switch edge policy `pcv-killswitch` (default rule deny 403), which is
  normally **not attached**. Backend buckets only support edge policies (allow/deny on IP, region, path,
  headers), with no rate limiting or WAF.

## IAM

- **Project roles:** Owners only (two people), plus Google-managed service agents and the two kill switch
  service accounts below.
- **`pcv-killswitch`** (runs the kill switch function): custom role `pcvKillswitchCompute` on the project
  (get backend bucket, set its edge policy, use security policies, read operations),
  `serviceusage.serviceUsageConsumer`, custom role `pcvKillswitchBucket` on the viewer bucket only (get
  bucket, read/set its IAM policy), and `run.invoker` on the function's own Cloud Run service.
- **`pcv-killswitch-build`** (builds the function): `cloudbuild.builds.builder` only.
- **Monitoring notification agent:** `pubsub.publisher` on topic `pcv-egress-killswitch` only.
- **Logging:** load balancer request logs are always on for backend buckets.
- **Alert:** "Point cloud viewer: egress > 500 GB/day" (Cloud Monitoring) emails the owner when load
  balancer or bucket egress passes 500 GB in a day.
- **Kill switch:** "Point cloud viewer: egress HARD CEILING 20 TB/day (kill switch)" emails the owner and
  publishes to Pub/Sub `pcv-egress-killswitch`, which triggers Cloud Function `pcv-killswitch` (us-west1,
  gen2, internal ingress, no unauthenticated access). On an open incident it attaches `pcv-killswitch` to
  `pcv-backend` and removes `allUsers` from the bucket. Recovery is manual: `killswitch/README.md`.

## Known exposure

- **Direct bucket URLs:** `https://storage.googleapis.com/ouster-pointcloud-viewer/...` still works and
  skips the CDN, the response headers and the host rule. It stays public until the site has moved to
  viewer.ouster.com. After that, the plan is to make the bucket private and grant read to the load
  balancer's service agent (`service-<project number>@https-lb.iam.gserviceaccount.com`).
- **Egress cost:** anyone can download the 13.8 GB cloud repeatedly, and there's no rate limit. The
  500 GB/day alert only emails; the kill switch blocks all traffic at 20 TB/day. Metrics lag a few
  minutes, so it caps the damage rather than stopping it instantly.
- **Viewer still loads data from the bucket URL:** `viewer/public/datasets.json` points at
  storage.googleapis.com, so today's traffic skips the CDN. viewer.ouster.com has no DNS record yet
  (ISD-43918, in security review). Once it resolves, point the dataset URL at `/pointclouds/...`,
  deploy, then make the bucket private.
