"""Clean any colorized point cloud for the web viewer. Every point is KEPT; bad points are CLASSIFIED,
and the viewer hides them (Clean button + Advanced sliders), so cleaning is reversible and tunable.

  Classification 7      floating noise   statistical outlier (mean dist to 12 NN > mean + 3 sd; same test as
                                         PDAL filters.outlier, run multi-threaded with scipy: 11x faster,
                                         identical labels) + filters.elm (10 m, 1)
  Classification 65..71 color speckle    speckle.py: brighter + differently colored than its ~1.5 m
                                         neighborhood (edge points pick up the color of what lies behind:
                                         sky/roof/road pixels). Band b = scores 32b..32b+31; the viewer's
                                         default strength (65%) hides bands 3..7 (score >= 96).
                                         --capture walk compares each point with the best-matching nearby
                                         surface patch instead of the neighborhood mean, so narrow bright
                                         ground (sand paths, curbs) next to dense plants isn't flagged;
                                         sky-colored points still use the mean. drone (default) = mean.

Input: anything PDAL reads (.las/.laz/.copc.laz/.ply), e.g. an Ouster Studio SLAM PLY. PLY float colors
0..1 and 8-bit colors are rescaled to LAS 16-bit. A reflectivity-like field (reflectivity / intensity /
signal) becomes LAS Intensity. Maps without color skip the speckle step (it is a color defect) and are
shown by reflectivity. Small inputs (< --whole points) are cleaned in one pass; larger ones are read
from COPC in --tile m tiles with a --buffer m overlap (neighborhoods stay complete at tile edges; each
point is written by exactly one tile; the summed count is checked against the source).
Non-COPC large inputs are converted to COPC with untwine first.

Output: <out>.copc.laz (LAS 1.4 PDRF 7, 0.01 m) + <out>.dataset.json (a datasets.json entry to paste).

  python clean_cloud.py IN OUT_BASENAME [--id ID] [--tile 100] [--buffer 3] [--workers 2] [--whole 40e6] [--capture drone|walk]
  e.g. python clean_cloud.py ~/Desktop/site.ply out/site --id site

Also writes <out>.qa.json + <out>.qa.png: before / flagged / after renders of sample tiles and the
class shares; status "hold" if anything is out of the normal range (hosting/gcs-setup.sh publish
refuses a held file unless FORCE=1). Look at the PNG before publishing a new kind of capture.

Resumable: rerun the same command; finished tiles are skipped. Cost per dense 33 M-point 100 m tile:
read 10 s, ELM 12 s, outlier 16 s (multi-threaded), speckle 6 s. The outlier step uses all cores,
so use --workers 2 (default) on a 10-core Mac. Needs scipy in the env.
"""
import argparse, glob, json, os, shutil, subprocess, sys, time, traceback
from multiprocessing import Pool
import numpy as np, pdal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from speckle import speckle_score

BIN = os.path.dirname(sys.executable)          # conda env bin: pdal, untwine (call directly; `conda run` breaks dyld)
NOISE = [{'type': 'filters.elm', 'cell': 10.0, 'threshold': 1.0}]      # the outlier test runs in numpy/scipy below

def outlier_mask(xyz, k=12, mult=3.0, chunk=2_000_000):
    """PDAL filters.outlier 'statistical' (mean_k=k, multiplier=mult), multi-threaded: mean distance to the
    k nearest neighbors (self excluded) > mean + mult*sd over the set. Matches PDAL's labels exactly on GGP."""
    from scipy.spatial import cKDTree
    c = xyz - xyz.mean(0)
    tree = cKDTree(c, leafsize=32, balanced_tree=False, compact_nodes=False)
    md = np.empty(len(c))
    for i in range(0, len(c), chunk):                      # chunked: k x n distance arrays get big
        d, _ = tree.query(c[i:i + chunk], k=k + 1, workers=-1)
        md[i:i + chunk] = d[:, 1:].mean(1)
    return md > md.mean() + mult * md.std()

def log(path, msg):
    line = time.strftime('%H:%M:%S ') + msg
    print(line, flush=True)
    with open(path, 'a') as f: f.write(line + '\n')

# Reflectivity-like dims as other tools name them (Ouster SDK / Studio PLY exports, CloudCompare, ...).
# The viewer reads LAS Intensity, so the first one present becomes Intensity (uint16).
INTENSITY_ALIASES = ('reflectivity', 'Reflectivity', 'REFLECTIVITY', 'intensity', 'scalar_intensity',
                     'scalar_Intensity', 'signal', 'Signal', 'SIGNAL', 'scalar_reflectivity')

def normalize_dims(a):
    """Map a reflectivity-like dimension to Intensity when the input has none (returns a new array)."""
    names = a.dtype.names
    if 'Intensity' in names and a['Intensity'].max() > 0: return a
    src = next((n for n in INTENSITY_ALIASES if n in names), None)
    if src is None: return a
    v = a[src].astype(np.float64)
    if v.max() <= 1.0: v = v * 255.0                      # 0..1 floats -> 0..255 like Ouster reflectivity
    keep = [n for n in names if n not in ('Intensity', src)]
    out = np.empty(len(a), dtype=[(n, a.dtype[n]) for n in keep] + [('Intensity', np.uint16)])
    for n in keep: out[n] = a[n]
    out['Intensity'] = np.clip(np.round(v), 0, 65535)
    return out

def has_rgb(a):
    return 'Red' in a.dtype.names and max(float(a['Red'].max()), float(a['Green'].max()), float(a['Blue'].max())) > 0

def color_scale(a):
    """Multiplier that maps the stored colors to LAS 16-bit."""
    if not has_rgb(a): return None
    mx = max(float(a['Red'].max()), float(a['Green'].max()), float(a['Blue'].max()))
    if mx <= 1.0: return 65535.0     # PLY floats 0..1
    if mx <= 255: return 257.0       # 8-bit
    return 1.0

def classify(a, scale, walk=False):
    """Run speckle scoring on non-noise points and write classes 65..71 in place. Returns the array."""
    cls = a['Classification'].astype(np.uint8).copy()
    cls[(cls >= 65) & (cls <= 71)] = 0       # re-cleaning an already-cleaned file: rescore speckle from scratch
    if len(a) > 13:
        cls[outlier_mask(np.stack([a['X'], a['Y'], a['Z']], 1))] = 7
    ok = cls != 7
    if has_rgb(a) and ok.any():          # speckle is a color defect: reflectivity-only maps skip it
        xyz = np.stack([a['X'][ok], a['Y'][ok], a['Z'][ok]], 1)
        rgb = np.stack([a['Red'][ok], a['Green'][ok], a['Blue'][ok]], 1).astype(np.float64) * (scale / 65535.0)
        q = np.zeros(len(a), np.uint8)
        q[ok], _ = speckle_score(xyz, np.clip(rgb, 0, 1), patch=walk)
        band = q // 32
        sp = ok & (band >= 1)
        cls[sp] = 64 + band[sp]
    a['Classification'] = cls
    return a

def to_las16(a, scale):
    if scale and scale != 1.0:
        out = np.empty(len(a), dtype=[(n, (np.uint16 if n in ('Red', 'Green', 'Blue') else a.dtype[n])) for n in a.dtype.names])
        for n in a.dtype.names:
            out[n] = np.clip(np.round(a[n] * scale), 0, 65535) if n in ('Red', 'Green', 'Blue') else a[n]
        return out
    return a

def write(a, path, copc=False):
    # Fixed 0.01 m grid at offset 0: a 0.01 m source stays bit-exact (offset 'auto' re-snaps coordinates by
    # up to 5 mm). Int32 at 0.01 m spans +-21,000 km, so UTM-size coordinates still fit.
    opts = dict(minor_version=4, dataformat_id=7, scale_x=0.01, scale_y=0.01, scale_z=0.01,
                offset_x=0, offset_y=0, offset_z=0)
    w = (pdal.Writer.copc(filename=path, scale_x=0.01, scale_y=0.01, scale_z=0.01, offset_x=0, offset_y=0, offset_z=0)
         if copc else pdal.Writer.las(filename=path, compression=True, **opts))
    w.pipeline(a).execute()

# ---------- review report ----------
HOLD = {'noise': 0.02, 'speckle': 0.08, 'window_flagged': 0.25}   # shares above these hold publishing

def render_panels(a, size=(560, 360), win=40.0):
    """Oblique view of one window: original | flagged (red) | cleaned. Returns an HxWx3 uint8 array."""
    xyz = np.stack([a['X'], a['Y'], a['Z']], 1).astype(np.float64)
    c = xyz - np.median(xyz, 0)
    az, el = np.radians(35), np.radians(35)
    x1 = c[:, 0] * np.cos(az) - c[:, 1] * np.sin(az); y1 = c[:, 0] * np.sin(az) + c[:, 1] * np.cos(az)
    u = x1; v = c[:, 2] * np.cos(el) + y1 * np.sin(el); depth = y1 * np.cos(el) - c[:, 2] * np.sin(el)
    W, H = size; res = win / W
    m = (np.abs(u) < W * res / 2) & (np.abs(v) < H * res / 2)
    if has_rgb(a):
        rgb = np.stack([a['Red'], a['Green'], a['Blue']], 1) / 65535.0
    else:                                   # reflectivity-only map: grayscale, stretched to the 99th percentile
        g = a['Intensity'].astype(np.float64) if 'Intensity' in a.dtype.names else np.full(len(a), 128.0)
        g = np.clip(g / max(np.percentile(g, 99), 1), 0, 1) ** 0.5; rgb = np.stack([g, g, g], 1)
    cls = a['Classification']; bad = (cls == 7) | (cls >= 67)
    out = []
    for mode in ('orig', 'flag', 'clean'):
        keep = m & (~bad if mode == 'clean' else True)
        idx = np.flatnonzero(keep); idx = idx[np.argsort(-depth[idx])]          # far first
        i = ((u[idx] + W * res / 2) / res).astype(int); j = (H - 1 - ((v[idx] + H * res / 2) / res)).astype(int)
        col = np.clip(rgb[idx], 0, 1) ** 0.8
        if mode == 'flag': col[bad[idx]] = [1, 0.1, 0.1]
        im = np.zeros((H, W, 3))
        for di in (0, 1):
            for dj in (0, 1):
                im[np.clip(j + dj, 0, H - 1), np.clip(i + di, 0, W - 1)] = col
        im[:, -2:] = 0.25                                                     # panel divider
        out.append((im * 255).astype(np.uint8))
    return np.concatenate(out, 1)

def qa_report(copc, base, n, noise, speck, logf):
    """Sample 3 windows (densest, typical, most-flagged) from the output and render before/flagged/after."""
    p = pdal.Pipeline(json.dumps([{'type': 'readers.copc', 'filename': copc, 'resolution': 2.0}])); p.execute()
    a = p.arrays[0]
    if not has_rgb(a) and ('Intensity' not in a.dtype.names or a['Intensity'].max() == 0):
        status, reasons = 'hold', ['no RGB and no reflectivity: nothing to color the points by']
        json.dump({'status': status, 'reasons': reasons}, open(base + '.qa.json', 'w'), indent=2); return status
    C = 40.0
    gx = np.floor(a['X'] / C).astype(np.int64); gy = np.floor(a['Y'] / C).astype(np.int64)
    gx0, gy0 = gx.min(), gy.min(); K = int(gy.max() - gy0) + 1
    key = (gx - gx0) * K + (gy - gy0)                       # non-negative cell index
    uk, inv = np.unique(key, return_inverse=True)
    cnt = np.bincount(inv); bad = np.bincount(inv, ((a['Classification'] == 7) | (a['Classification'] >= 67)).astype(float)) / cnt
    # Sample only the populated scene: the densest cells that together hold 80% of the points
    # (sparse outskirts and stray clusters would otherwise win "most flagged" with a handful of points).
    order = np.argsort(-cnt); keep = order[: max(1, int(np.searchsorted(np.cumsum(cnt[order]) / cnt.sum(), 0.8)) + 1)]
    picks = {'densest': int(keep[0]), 'typical': int(keep[len(keep) // 2]),
             'most flagged': int(keep[np.argmax(bad[keep])])}
    rows, wins, reasons = [], [], []
    for name, k in picks.items():
        kx, ky = divmod(int(uk[k]), K)
        x0, y0 = (kx + gx0) * C, (ky + gy0) * C
        q = pdal.Pipeline(json.dumps([{'type': 'readers.copc', 'filename': copc, 'bounds': f'([{x0},{x0 + C}],[{y0},{y0 + C}])'}])); q.execute()
        w = q.arrays[0]; c = w['Classification']
        share = float(np.mean((c == 7) | (c >= 67))) if len(w) else 0.0
        wins.append({'window': name, 'x0': x0, 'y0': y0, 'points': int(len(w)), 'flagged': round(share, 4)})
        if share > HOLD['window_flagged']: reasons.append(f'{name} window ({x0:.0f},{y0:.0f}) has {share:.0%} flagged')
        if len(w): rows.append(render_panels(w))
    if noise > HOLD['noise']: reasons.append(f'noise {noise:.2%} > {HOLD["noise"]:.0%}')
    if speck > HOLD['speckle']: reasons.append(f'speckle hidden by default {speck:.2%} > {HOLD["speckle"]:.0%}')
    status = 'hold' if reasons else 'ok'
    if rows:
        img = np.concatenate(rows, 0)
        ppm = base + '.qa.ppm'
        open(ppm, 'wb').write(b'P6 %d %d 255\n' % (img.shape[1], img.shape[0]) + img.tobytes())
        subprocess.run(['sips', '-s', 'format', 'png', ppm, '--out', base + '.qa.png'], capture_output=True); os.remove(ppm)
    json.dump({'status': status, 'reasons': reasons, 'points': n, 'noise': round(noise, 5), 'speckle_hidden': round(speck, 5),
               'thresholds': HOLD, 'windows': wins, 'png': os.path.basename(base + '.qa.png'),
               'panels': 'rows = windows (densest, typical, most flagged); columns = original | flagged (red) | cleaned'},
              open(base + '.qa.json', 'w'), indent=2)
    log(logf, f'review: {status.upper()}' + (': ' + '; '.join(reasons) if reasons else '') + f'  -> {base}.qa.png')
    return status

# ---------- tiled path ----------
G = {}
def tile_job(args):
    (i, j), x0, y0 = args
    src, tdir, T, B, logf = G['src'], G['tdir'], G['tile'], G['buf'], G['log']
    out = os.path.join(tdir, f'{i:03d}_{j:03d}.laz'); done = out + '.n'
    if os.path.exists(done): return int(open(done).read())
    t = time.time()
    try:
        p = pdal.Pipeline(json.dumps([{'type': 'readers.copc', 'filename': src,
                                       'bounds': f'([{x0 - B},{x0 + T + B}],[{y0 - B},{y0 + T + B}])'}] + NOISE))
        if p.execute() == 0:
            open(done, 'w').write('0'); return 0
        a = normalize_dims(p.arrays[0])
        a = classify(a, G['scale'], G['walk'])          # one scale for all tiles: a dark tile could look 8-bit
        a = a[(a['X'] >= x0) & (a['X'] < x0 + T) & (a['Y'] >= y0) & (a['Y'] < y0 + T)]
        if len(a):
            a = to_las16(a, G['scale'])
            write(a, out + '.tmp.laz'); os.replace(out + '.tmp.laz', out)
        c = a['Classification']
        log(logf, f'tile {i:03d}_{j:03d}: {len(a):>11,} pts  noise {np.mean(c == 7):.4f}  speckle>=96 {np.mean(c >= 67):.4f}  {time.time() - t:6.1f}s')
        open(done, 'w').write(str(len(a)))
        return len(a)
    except Exception:
        log(logf, f'tile {i:03d}_{j:03d}: FAILED\n' + traceback.format_exc()); raise

def init(g): G.update(g)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src'); ap.add_argument('out', help='output basename, e.g. out/site')
    ap.add_argument('--id'); ap.add_argument('--tile', type=float, default=100); ap.add_argument('--buffer', type=float, default=3)
    ap.add_argument('--workers', type=int, default=2); ap.add_argument('--whole', type=float, default=40e6)
    ap.add_argument('--capture', choices=('drone', 'walk'), default='drone', help='walk: own-surface speckle reference (ground-level captures)')
    ap.add_argument('--data-url', default=os.environ.get('DATA_BASE_URL', ''),
                    help='base URL the COPC will be served from, for the dataset.json "url" (env DATA_BASE_URL); '
                         'default: the dev server path /data/<file>')
    a = ap.parse_args()
    out_copc = a.out + '.copc.laz'; logf = a.out + '.clean.log'
    os.makedirs(os.path.dirname(os.path.abspath(out_copc)), exist_ok=True)
    src = os.path.abspath(os.path.expanduser(a.src))

    info = json.loads(subprocess.check_output([os.path.join(BIN, 'pdal'), 'info', '--summary', src]))['summary']
    n_src = int(info['num_points']); bb = info['bounds']
    log(logf, f'source {src}: {n_src:,} points, bounds x {bb["minx"]:.1f}..{bb["maxx"]:.1f} y {bb["miny"]:.1f}..{bb["maxy"]:.1f}')

    if n_src <= a.whole:
        p = pdal.Pipeline(json.dumps([{'type': 'readers.' + ('ply' if src.lower().endswith('.ply') else 'copc' if src.endswith('.copc.laz') else 'las'), 'filename': src}] + NOISE))
        p.execute(); arr = normalize_dims(p.arrays[0])
        scale = color_scale(arr) or 1.0
        log(logf, f'whole-file pass, color scale x{scale:g}')
        arr = to_las16(classify(arr, scale, a.capture == 'walk'), scale)
        write(arr, out_copc, copc=True)
        n_out = len(arr)
    else:
        if not src.endswith('.copc.laz'):
            conv = a.out + '.src.copc.laz'
            if not os.path.exists(conv):
                log(logf, 'converting to COPC with untwine (needed for tiled reads)')
                indir = a.out + '.src_in'; os.makedirs(indir, exist_ok=True)
                link = os.path.join(indir, os.path.basename(src))
                if not os.path.exists(link): os.symlink(src, link)    # untwine scans dirs; a lone symlink avoids .DS_Store
                subprocess.check_call([os.path.join(BIN, 'untwine'), '-i', indir, '-o', conv, '--temp_dir', a.out + '.tmp'])
                shutil.rmtree(a.out + '.tmp', ignore_errors=True)
            src = conv
        tdir = a.out + '.tiles'; os.makedirs(tdir, exist_ok=True)
        T = a.tile
        x0 = np.floor(bb['minx'] / T) * T; y0 = np.floor(bb['miny'] / T) * T
        nx = int((bb['maxx'] - x0) // T) + 1; ny = int((bb['maxy'] - y0) // T) + 1   # half-open cores cover max
        jobs = [((i, j), x0 + i * T, y0 + j * T) for i in range(nx) for j in range(ny)]
        # probe colors once for the scale (tiles may be dark/empty)
        probe = pdal.Pipeline(json.dumps([{'type': 'readers.copc', 'filename': src, 'resolution': 50}])); probe.execute()
        scale = color_scale(probe.arrays[0]) or 1.0
        log(logf, f'{len(jobs)} tiles of {T:g} m (+{a.buffer:g} m buffer), {a.workers} workers, color scale x{scale:g}')
        g = dict(src=src, tdir=tdir, tile=T, buf=a.buffer, log=logf, scale=scale, walk=a.capture == 'walk')
        with Pool(a.workers, initializer=init, initargs=(g,), maxtasksperchild=1) as pool:
            n_out = sum(pool.map(tile_job, jobs, chunksize=1))
        if n_out != n_src:
            log(logf, f'COUNT MISMATCH: tiles {n_out:,} vs source {n_src:,} -- not merging'); sys.exit(2)
        log(logf, 'merging tiles with untwine')
        tin = a.out + '.tiles_in'; shutil.rmtree(tin, ignore_errors=True); os.makedirs(tin)
        for f in glob.glob(os.path.join(tdir, '*.laz')): os.symlink(os.path.abspath(f), os.path.join(tin, os.path.basename(f)))  # relative targets would dangle
        subprocess.check_call([os.path.join(BIN, 'untwine'), '-i', tin, '-o', out_copc, '--temp_dir', a.out + '.tmp'])
        shutil.rmtree(a.out + '.tmp', ignore_errors=True)    # untwine leaves its scratch files (126 GB for Golden Gate Park)

    # verify + summarize
    s = json.loads(subprocess.check_output([os.path.join(BIN, 'pdal'), 'info', '--summary', out_copc]))['summary']
    n_copc = int(s['num_points'])
    if n_copc != n_src:
        log(logf, f'COUNT MISMATCH: output {n_copc:,} vs source {n_src:,}'); sys.exit(2)
    st = json.loads(subprocess.check_output([os.path.join(BIN, 'pdal'), 'info', '--stats', '--dimensions', 'Classification,Z,Intensity',
                                             '--filters.stats.count=Classification', out_copc]))['stats']['statistic']
    byname = {d['name']: d for d in st}
    counts = {int(float(c.split('/')[0])): int(c.split('/')[1]) for c in byname['Classification'].get('counts', [])}
    noise = counts.get(7, 0) / n_copc; speck = sum(v for k, v in counts.items() if k >= 67) / n_copc
    has_int = byname['Intensity']['maximum'] > 0
    probe = pdal.Pipeline(json.dumps([{'type': 'readers.copc', 'filename': out_copc, 'resolution': 20}])); probe.execute()
    rgb = has_rgb(probe.arrays[0])
    b = s['bounds']; ext = (b['maxx'] - b['minx'], b['maxy'] - b['miny'])
    log(logf, f'OK {out_copc}: {n_copc:,} pts (matches source), noise {noise:.2%}, speckle hidden by default {speck:.2%}')
    qa_report(out_copc, a.out, n_copc, noise, speck, logf)

    did = a.id or os.path.basename(a.out)
    pts = f'{n_copc / 1e9:.2f} B points' if n_copc >= 1e9 else f'{n_copc / 1e6:.2f} M points'
    cx, cy = (b['minx'] + b['maxx']) / 2, (b['miny'] + b['maxy']) / 2
    r = max(ext) * 0.6
    entry = {
        'id': did, 'name': did, 'title': did,
        'url': (a.data_url.rstrip('/') + '/' if a.data_url else 'data/') + os.path.basename(out_copc),
        'thumbnail': f'thumbs/{did}.jpg',
        'description': 'Point cloud of <place>, captured <by drone | on a walk> with an Ouster <sensor>. ...',
        'facts': ['Ouster <sensor>', '<Drone | Walking> capture', pts, f'~{ext[0]:.0f} × {ext[1]:.0f} m',
                  ('Reflectivity + RGB' if has_int else 'Full RGB') if rgb else 'Reflectivity'],
        'camera': {'position': [round(cx + r * 0.5), round(cy - r * 0.8), round(r * 0.5)], 'target': [round(cx), round(cy), 0]},
        'autoOrbit': True, 'viewpoints': [],
        'noiseClassified': True, 'clean': {'zBand': None},
        **({'speckle': {'default': 65}} if rgb else {}),
        'colorMode': 'rgb' if rgb else 'reflectivity',
        'colorModes': {**({'rgb': {'label': 'RGB', 'attribute': 'rgba'}} if rgb else {}),
                       **({'reflectivity': {'label': 'Reflectivity', 'attribute': 'intensity', 'range': [0, 40]}} if has_int else {})},
        'pointBudget': 8000000, 'maxFlySpeed': int(min(150, max(30, max(ext) / 8))),
    }
    json.dump(entry, open(a.out + '.dataset.json', 'w'), indent=2, ensure_ascii=False)
    log(logf, f'wrote {a.out}.dataset.json -- fill in the <...> copy, set camera/viewpoints in the viewer (P copies one)')

if __name__ == '__main__':
    main()
