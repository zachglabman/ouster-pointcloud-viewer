#!/bin/sh
# Step 5 acceptance: range request must return 206 with CORS headers.
# Usage: sh check_range.sh https://dxxxx.cloudfront.net/pointclouds/ggp.copc.laz [https://viewer.origin]
URL="$1"; ORIGIN="${2:-https://example.com}"
echo "--- GET range 0-999"
curl -s -o /dev/null -D - -r 0-999 -H "Origin: $ORIGIN" "$URL" | grep -iE "^HTTP|content-range|content-length|accept-ranges|access-control|x-cache"
echo "--- CORS preflight"
curl -s -o /dev/null -D - -X OPTIONS -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" "$URL" | grep -iE "^HTTP|access-control"
