# Ouster point cloud viewer

Browser viewer for large Ouster OS1 Max point clouds, built on Potree 1.8.2 and streaming COPC files from Google Cloud Storage.

**Live:** https://storage.googleapis.com/ouster-pointcloud-viewer/viewer/index.html

| Dataset | Capture | Points | File |
|---|---|---|---|
| Golden Gate Park, San Francisco | Drone, OS1 Max | 1.41 B | `pointclouds/ggp-v2.copc.laz` (13.8 GB) |
| Viansa Winery, Sonoma | Walking, OS1 Max | 7.59 M | `pointclouds/viansa-v2.copc.laz` (83 MB) |

## Layout

```
viewer/                 Vite app (the site)
  index.html            page shell, link-preview tags
  src/main.js           settings, toolbar, pop-overs, advanced panel, share links, keys
  src/tools.js          measurements (Potree MeasuringTool + readout/undo/share codec), axis gizmo, screenshot
  src/analytics.js      optional GA4 events
  src/style.css
  public/datasets.json  datasets, copy, cameras, viewpoints, clean presets, analytics ID
  public/potree/        built Potree bundle + the libs it needs (generated, committed)
  patches/              our changes to Potree 1.8.2 source (shader filters)
  scripts/sync-potree.sh
hosting/gcs-setup.sh    bucket, data upload, site deploy, range check
sky/                    sky-fringe scoring for colorized clouds (Viansa)
```

## Run locally

```sh
cd viewer
npm install
npm run dev          # http://localhost:5173 ; local files in ../out are served at /data/
```

## Deploy

```sh
gcloud auth login                       # if the token expired
sh hosting/gcs-setup.sh site            # build + upload viewer/dist to gs://ouster-pointcloud-viewer/viewer/
```

- `index.html` and `datasets.json` are `no-cache`: copy/viewpoint edits are live on the next page load.
- Hashed `assets/` are immutable; `potree/` is cached 1 day. Text files are stored gzip-encoded.
- Data files are cached for a year. **A changed data file needs a new filename** (e.g. `viansa-v2.copc.laz`).
- The "thumbs: no URLs matched" error is gone once `public/thumbs/` exists; harmless either way.

## Add a dataset

```sh
PY=/opt/homebrew/Caskroom/miniforge/base/envs/pc/bin/python
# 1. clean + convert: any LAS/LAZ/COPC/PLY -> out/<id>.copc.laz + out/<id>.dataset.json (every point kept)
nohup $PY -I clean/clean_cloud.py path/to/input out/<id> --id <id> > out/<id>.clean.out 2>&1 &
caffeinate -i -w $! &
# 2. upload (refuses to overwrite: data is cached for a year, so a new version needs a new name)
sh hosting/gcs-setup.sh publish out/<id>.copc.laz
# 3. paste out/<id>.dataset.json into viewer/public/datasets.json, fill in the copy, add thumbs/<id>.jpg (176x120)
# 4. fly to good spots in the dev viewer, press P to copy viewpoint JSON, then
sh hosting/gcs-setup.sh site
```

**Cleaning** classifies instead of deleting, and the viewer hides the classes (Clean button, Advanced → Cleaning):

| Class | Meaning | Detector |
|---|---|---|
| 7 | floating noise (air, below ground) | `filters.outlier` statistical (mean_k 12, ×3) + `filters.elm` (10 m, 1) |
| 65–71 | color speckle, 8 strength bands (score // 32) | `clean/speckle.py`: brighter and differently colored than the ~1.5 m neighborhood |

Inputs over 40 M points are processed in 100 m tiles with a 3 m overlap and merged with untwine; the
tool checks the point count matches the source exactly. The outlier test runs multi-threaded (scipy),
so a dense 33 M-point tile takes ~65 s (was ~10 min with PDAL's single-threaded filter; labels identical).
Viansa: 20 s. Golden Gate Park would now take roughly 15–25 min (the original run: 1 h 32 min).

Each run writes `out/<id>.qa.png` and `out/<id>.qa.json`: before / flagged (red) / cleaned renders of the
densest, a typical, and the most-flagged area, plus class shares. Status `hold` (noise > 2%, speckle > 8%,
or a sampled area > 25% flagged) makes `gcs-setup.sh publish` refuse until you've looked
(`FORCE=1` to publish anyway).

Use `--capture walk` for ground-level captures: each point is compared with the best-matching nearby
surface patch instead of the neighborhood average, so narrow bright ground next to dense plants (sand
paths, curbs, small white structures) isn't flagged; sky-colored points still get the average test, so
canopy sky fringe is still caught. Viansa: 6.2% → 2.1% hidden. Drone captures keep the default.

`clean/run_ggp.py` is the original Golden Gate Park run (same labels, PDAL outlier filter, fixed grid).

## CDN (optional, faster loading)

`hosting/cdn-setup.sh` puts Cloud CDN and a custom domain in front of the bucket (HTTPS load balancer +
backend bucket, caching by the objects' own Cache-Control). Straight from the bucket each chunk waits
~0.25-0.5 s; cached at an edge, ~20-50 ms. After it's live, point the dataset `url`s in datasets.json at
the new domain (same paths) and redeploy.

## Guided tour

`"tour"` in a dataset (datasets.json) lists stops `{ name, caption, position, target, hold }`. **▶ Take the
tour** in the info card flies between them (eased, arcing over long legs, slow drift while a caption shows).
← / → step, Space pauses, any drag/scroll/other key hands control back where the camera is.
`#d=<id>&tour` opens straight into it. Bandwidth goes where the camera is heading: during a flight the
destination's detail downloads first, and once a stop is sharp, the next stop's (a second-camera visibility
pass after each frame). A stop never moves on before it has loaded (full point budget, or loading quiet
for 1.5 s; 25 s cap), and holds still until then. A "Refining detail…" pill shows while the
current view is still loading. Author stops in the dev viewer with **P** (copies camera JSON).
Events: `tour_start`, `tour_stop_reached`, `tour_stop_loaded` (`seconds` waited), `tour_stop` (`at`, `reason`), `tour_complete`. Code: `src/tour.js`.

## Potree

The viewer uses Potree 1.8.2 with a small shader patch (reflectivity and world-Z discard filters, tagged `[ggp]`). To rebuild it:

```sh
cd viewer
git clone --branch 1.8.2 --depth 1 https://github.com/potree/potree.git vendor/potree-1.8.2
git -C vendor/potree-1.8.2 apply ../../patches/potree-1.8.2-ggp.patch
(cd vendor/potree-1.8.2 && npm install && npx gulp build)
npm run sync-potree     # copies only what the viewer loads into public/potree
```

## Analytics

GA4 property **G-Y572VZ4TRZ** (stream 16284157236) plus Tag Manager container **GTM-KBDS6372**, both in
`viewer/index.html` `<head>` (static, so Google's tag checker finds them). `src/analytics.js` sends viewer
events through that tag, so nothing has to be configured in GTM; the container loads for anything added
there later. Don't add a GA4 tag with the same ID inside GTM
(page views would count twice). Events, each with a `dataset` parameter: `dataset_view`, `cta_click`,
`share`, `measure`, `screenshot`, `nav_mode`, `xray`, `ortho`, `clean`, `advanced_open`, `viewpoint`.
In GA4: register `dataset` as an event-scoped custom dimension, and mark `cta_click` as a key event.
Add `?debug-analytics=1` to log events in the console.
