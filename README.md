# Ouster point cloud viewer

Browser viewer for large Ouster OS1 Max point clouds, built on Potree 1.8.2 and streaming COPC files from Google Cloud Storage.

**Live:** https://storage.googleapis.com/ouster-pointcloud-viewer/viewer/index.html

| Dataset | Capture | Points | File |
|---|---|---|---|
| Golden Gate Park, San Francisco | Drone, OS1 Max | 1.41 B | `pointclouds/ggp.copc.laz` (13.6 GB) |
| Viansa Winery, Sonoma | Walking, OS1 Max | 7.59 M | `pointclouds/viansa.copc.laz` (83 MB) |

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
tool checks the point count matches the source exactly. Budget ~10 min per 33 M-point tile per worker
and ~7 GB RAM per worker (3 workers on a 24 GB Mac; Golden Gate Park took ~3 h).
`clean/run_ggp.py` is the original Golden Gate Park run (same algorithm, fixed grid).

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

Set `"analytics": { "ga4": "G-XXXXXXXXXX" }` in `datasets.json` and redeploy. Events: `dataset_view`, `cta_click`, `share`, `measure`, `screenshot`, `nav_mode`, `xray`, `ortho`, `clean`, `advanced_open`, `viewpoint` (each with `dataset`). Add `?debug-analytics=1` to log events in the console.
