#!/bin/sh
# Cloud CDN in front of the bucket, on a custom domain (HTTPS load balancer + backend bucket).
# Why: every point cloud chunk is an HTTP range request; straight from the us-west1 bucket each one
# waits ~0.25-0.5 s before data flows. Through the CDN, chunks other visitors already loaded (the
# overview, every tour stop) come from a nearby edge in ~20-50 ms.
#
#   DOMAIN=pointclouds.ouster.com sh cdn-setup.sh create   # ~2 min; prints the IP for the DNS record
#   (add DNS:  <DOMAIN>  A  <IP>   -- whoever runs ouster.com DNS)
#   DOMAIN=pointclouds.ouster.com sh cdn-setup.sh status   # wait for the certificate: ACTIVE (15-60 min after DNS)
#   DOMAIN=pointclouds.ouster.com sh cdn-setup.sh check    # cache HIT/MISS + range + timing through the CDN
#   sh cdn-setup.sh teardown                               # remove everything this script made (bucket untouched)
#
# Cost: ~$18/month for the forwarding rule, plus CDN egress (cheaper per GB than serving from the bucket).
# Caching follows the objects' own Cache-Control (USE_ORIGIN_HEADERS): data is immutable (1 year),
# index.html + datasets.json are no-cache (copy edits stay instant), so no invalidations are needed.
# Range requests on the 13.8 GB file are cached in chunks (GCS supports byte ranges).
set -eu
PROJECT="${PROJECT:-ouster-growth-dashboard}"
BUCKET="${BUCKET:-ouster-pointcloud-viewer}"
N="${NAME:-pointcloud-viewer}"
G="--project=$PROJECT"

case "${1:-}" in
  create)
    DOMAIN="${DOMAIN:?set DOMAIN, e.g. DOMAIN=pointclouds.ouster.com}"
    gcloud services enable compute.googleapis.com $G
    gcloud compute backend-buckets create "$N-backend" $G --gcs-bucket-name="$BUCKET" \
      --enable-cdn --cache-mode=USE_ORIGIN_HEADERS
    gcloud compute url-maps create "$N-map" $G --default-backend-bucket="$N-backend"
    gcloud compute addresses create "$N-ip" $G --global --ip-version=IPV4
    gcloud compute ssl-certificates create "$N-cert" $G --global --domains="$DOMAIN"
    gcloud compute target-https-proxies create "$N-https" $G --url-map="$N-map" --ssl-certificates="$N-cert"
    gcloud compute forwarding-rules create "$N-443" $G --global --target-https-proxy="$N-https" \
      --address="$N-ip" --ports=443
    # http:// -> https://
    printf 'name: %s-redirect\ndefaultUrlRedirect:\n  httpsRedirect: true\n  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT\n' "$N" > "/tmp/$N-redirect.yaml"
    gcloud compute url-maps import "$N-redirect" $G --global --source="/tmp/$N-redirect.yaml" --quiet
    gcloud compute target-http-proxies create "$N-http" $G --url-map="$N-redirect"
    gcloud compute forwarding-rules create "$N-80" $G --global --target-http-proxy="$N-http" \
      --address="$N-ip" --ports=80
    IP="$(gcloud compute addresses describe "$N-ip" $G --global --format='value(address)')"
    echo
    echo "Add this DNS record, then run: DOMAIN=$DOMAIN sh $0 status"
    echo "  $DOMAIN.  A  $IP"
    ;;
  status)
    gcloud compute ssl-certificates describe "$N-cert" $G --global \
      --format="table(managed.status, managed.domainStatus)"
    echo "Viewer (once ACTIVE): https://${DOMAIN:-<DOMAIN>}/viewer/index.html"
    ;;
  check)
    DOMAIN="${DOMAIN:?set DOMAIN}"
    U="https://$DOMAIN/pointclouds/ggp-v2.copc.laz"
    for i in 1 2 3; do   # same range 3x: the 2nd/3rd should be cache hits and much faster
      curl -s -o /dev/null -D - -r 1000000-1400000 -w "ttfb %{time_starttransfer}s\n" "$U" \
        | grep -iE "^HTTP|^age:|^cache-status|^via|^ttfb" | tr '\n' ' '; echo
    done
    curl -s -o /dev/null -w "viewer %{http_code}\n" "https://$DOMAIN/viewer/index.html"
    ;;
  teardown)
    for c in "forwarding-rules delete $N-443 --global" "forwarding-rules delete $N-80 --global" \
             "target-https-proxies delete $N-https" "target-http-proxies delete $N-http" \
             "url-maps delete $N-map" "url-maps delete $N-redirect" \
             "ssl-certificates delete $N-cert --global" "addresses delete $N-ip --global" \
             "backend-buckets delete $N-backend"; do
      gcloud compute $c $G --quiet || true
    done
    ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
