#!/bin/sh
# Step 5 on Google Cloud Storage.
#   sh gcs-setup.sh bucket    # create private bucket + CORS (safe, reversible)
#   sh gcs-setup.sh upload    # upload out/*.copc.laz
#   sh gcs-setup.sh site      # build the viewer and upload dist/ to gs://$BUCKET/viewer/
#   sh gcs-setup.sh public    # grant allUsers objectViewer (makes the data world-readable)
#   sh gcs-setup.sh check     # range-request test (expects 206 + CORS header)
#   sh gcs-setup.sh teardown  # delete objects and bucket
set -eu
PROJECT="${PROJECT:-ouster-growth-dashboard}"
BUCKET="${BUCKET:-ouster-pointcloud-viewer}"
REGION="${REGION:-us-west1}"
PREFIX="${PREFIX:-pointclouds}"
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$HERE/../out"
URL_BASE="https://storage.googleapis.com/$BUCKET/$PREFIX"

case "${1:-}" in
  bucket)
    gcloud storage buckets create "gs://$BUCKET" --project="$PROJECT" --location="$REGION" \
      --default-storage-class=STANDARD --uniform-bucket-level-access
    gcloud storage buckets update "gs://$BUCKET" --cors-file="$HERE/gcs-cors.json"
    gcloud storage buckets describe "gs://$BUCKET" --format="yaml(name,location,cors_config)"
    ;;
  upload)
    for f in "$OUT"/*.copc.laz; do
      gcloud storage cp "$f" "gs://$BUCKET/$PREFIX/$(basename "$f")" \
        --content-type=application/vnd.laszip+copc \
        --cache-control="public, max-age=31536000, immutable"
    done
    gcloud storage ls -l "gs://$BUCKET/$PREFIX/"
    ;;
  site)
    # Viewer: build, then upload dist/ to gs://$BUCKET/viewer/.
    # index.html + datasets.json: no-cache (edits go live immediately);
    # hashed assets/: immutable; potree/ vendor bundle: 1 day.
    SITE="${SITE_PREFIX:-viewer}"; DIST="$HERE/../viewer/dist"
    (cd "$HERE/../viewer" && npm run build)
    # Text files are stored gzip-encoded (browsers decompress transparently): potree.js 2.2 MB -> ~0.5 MB.
    GZ="--gzip-local=js,css,html,json,svg,wasm"
    gcloud storage cp -r "$DIST/potree" "gs://$BUCKET/$SITE/" $GZ --cache-control="public, max-age=86400"
    gcloud storage cp -r "$DIST/assets" "gs://$BUCKET/$SITE/" $GZ --cache-control="public, max-age=31536000, immutable"
    for f in index.html datasets.json; do
      gcloud storage cp "$DIST/$f" "gs://$BUCKET/$SITE/$f" $GZ --cache-control="no-cache"
    done
    [ -f "$DIST/og.jpg" ] && gcloud storage cp "$DIST/og.jpg" "gs://$BUCKET/$SITE/og.jpg" --cache-control="public, max-age=86400"
    [ -d "$DIST/thumbs" ] && gcloud storage cp -r "$DIST/thumbs" "gs://$BUCKET/$SITE/" --cache-control="public, max-age=3600"
    echo "Live: https://storage.googleapis.com/$BUCKET/$SITE/index.html"
    ;;
  public)
    gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
      --member=allUsers --role=roles/storage.objectViewer
    ;;
  check)
    U="$URL_BASE/${2:-ggp.copc.laz}"
    curl -s -o /dev/null -D - -r 0-999 -H "Origin: https://example.com" "$U" \
      | grep -iE "^HTTP|content-range|content-length|accept-ranges|access-control"
    ;;
  teardown)
    gcloud storage rm -r "gs://$BUCKET"
    ;;
  *) sed -n 2,9p "$0"; exit 1 ;;
esac
