#!/bin/sh
# Copy the built Potree 1.8.2 bundle + only the libs the viewer uses into public/potree.
# Sidebar/GUI-only libs (jquery-ui, spectrum, jstree, d3, i18next, openlayers, plasio, three.js examples)
# are left out: the viewer never calls Potree's loadGUI().
#   jquery     Potree core uses $ internally
#   other      BinaryHeap (LOD queue)
#   tween      camera animations (setView with duration)
#   proj4      referenced at load time by potree.js (top-level proj4.defs)
#   copc       COPC reader + laz-perf.wasm
set -e
cd "$(dirname "$0")/.."
P=vendor/potree-1.8.2
rm -rf public/potree && mkdir -p public/potree/libs public/potree/build/potree
for f in potree.js potree.css LICENSE resources workers; do cp -R $P/build/potree/$f public/potree/build/potree/; done
for l in jquery other tween proj4 copc; do cp -R $P/libs/$l public/potree/libs/; done
echo "synced potree into public/potree ($(du -sh public/potree | cut -f1))"
