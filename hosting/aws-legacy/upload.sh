#!/bin/sh
# Step 5: upload COPC + set CORS. Usage: BUCKET=my-bucket [PREFIX=pointclouds] [AWS_PROFILE=...] sh upload.sh
# Tighten AllowedOrigins in cors.json to the viewer's domain before going public.
set -eu
: "${BUCKET:?set BUCKET}"; PREFIX="${PREFIX:-pointclouds}"
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$HERE/../out"
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "file://$HERE/cors.json"
for f in "$OUT"/*.copc.laz; do
  aws s3 cp "$f" "s3://$BUCKET/$PREFIX/$(basename "$f")" \
    --content-type application/vnd.laszip+copc \
    --cache-control "public, max-age=31536000, immutable" \
    --expected-size "$(stat -f%z "$f")"
done
aws s3api get-bucket-cors --bucket "$BUCKET"
