# Hosting (Step 5)

1. `BUCKET=<bucket> sh upload.sh` — sets CORS (cors.json) and uploads out/*.copc.laz.
2. CloudFront distribution, origin = the bucket (Origin Access Control, bucket stays private).
   Behavior for `pointclouds/*`:
   - Allowed methods: GET, HEAD, OPTIONS
   - Cache policy: Managed-CachingOptimized
   - Origin request policy: Managed-CORS-S3Origin (forwards Origin so S3 returns CORS headers)
   - Response headers policy: none needed if S3 CORS is set (or Managed-CORS-With-Preflight)
   CloudFront serves Range requests from the cache natively. Objects up to 50 GB are cacheable.
3. `sh check_range.sh https://<dist>.cloudfront.net/pointclouds/ggp.copc.laz https://<viewer-origin>`
   Expect `HTTP/2 206`, `content-range: bytes 0-999/<size>`, and `access-control-allow-origin`.
4. Put the CloudFront URL into viewer/public/datasets.json (`url` for ggp).
