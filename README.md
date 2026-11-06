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

1. Convert to COPC (keep all dimensions):
   - many LAS files: `untwine -i <dir-of-las> -o out/<id>.copc.laz --temp_dir tmp`
   - one PLY/LAS: a PDAL pipeline ending in `writers.copc` (see `sky/viansa.pipeline.json`; float 0–1 PLY colors must be scaled ×65535).
   - Optional noise classes: `filters.outlier` (statistical, mean_k 12, multiplier 3) + `filters.elm` (cell 10, threshold 1) mark Classification 7; set `"noiseClassified": true`.
2. Upload: `gcloud storage cp out/<id>.copc.laz gs://ouster-pointcloud-viewer/pointclouds/ --content-type=application/vnd.laszip+copc --cache-control="public, max-age=31536000, immutable"`
3. Add an entry to `viewer/public/datasets.json` (copy an existing one). Fly to good spots and press **P** to copy viewpoint JSON. Add a 176×120 `thumbs/<id>.jpg`.
4. `sh hosting/gcs-setup.sh site`.

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
