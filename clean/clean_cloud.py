"""Clean any colorized point cloud for the web viewer. Every point is KEPT; bad points are CLASSIFIED,
and the viewer hides them (Clean button + Advanced sliders), so cleaning is reversible and tunable.

  Classification 7      floating noise   filters.outlier (statistical, mean_k 12, x3) + filters.elm (10 m, 1)
  Classification 65..71 color speckle    speckle.py: brighter + differently colored than its ~1.5 m
                                         neighborhood (lidar/camera misregistration paints edges with
                                         sky/roof/road pixels). Band b = scores 32b..32b+31; the viewer's
                                         default strength (65%) hides bands 3..7 (score >= 96).

Input: anything PDAL reads (.las/.laz/.copc.laz/.ply). PLY float colors 0..1 and 8-bit colors are
rescaled to LAS 16-bit. Small inputs (< --whole points) are cleaned in one pass; larger ones are read
from COPC in --tile m tiles with a --buffer m overlap (neighborhoods stay complete at tile edges; each
point is written by exactly one tile; the summed count is checked against the source).
Non-COPC large inputs are converted to COPC with untwine first.

Output: <out>.copc.laz (LAS 1.4 PDRF 7, 0.01 m) + <out>.dataset.json (a datasets.json entry to paste).

  python clean_cloud.py IN OUT_BASENAME [--id ID] [--tile 100] [--buffer 3] [--workers 3] [--whole 40e6]
  e.g. python clean_cloud.py ~/Desktop/site.ply out/site --id site

Resumable: rerun the same command; finished tiles are skipped. Cost: the outlier filter dominates,
~10 min per 33 M-point tile per worker on an M-series Mac (GGP: 1.41 B pts, 3 workers, ~3 h).
Budget ~7 GB RAM per worker on dense 100 m tiles; 3 workers fit in 24 GB.
"""
import argparse, glob, json, os, shutil, subprocess, sys, time, traceback
from multiprocessing import Pool
import numpy as np, pdal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from speckle import speckle_score

BIN = os.path.dirname(sys.executable)          # conda env bin: pdal, untwine (call directly; `conda run` breaks dyld)
NOISE = [{'type': 'filters.outlier', 'method': 'statistical', 'mean_k': 12, 'multiplier': 3.0},
         {'type': 'filters.elm', 'cell': 10.0, 'threshold': 1.0}]

def log(path, msg):
    line = time.strftime('%H:%M:%S ') + msg
    print(line, flush=True)
    with open(path, 'a') as f: f.write(line + '\n')

def color_scale(a):
    """Multiplier that maps the stored colors to LAS 16-bit."""
    if 'Red' not in a.dtype.names: return None
    mx = max(float(a['Red'].max()), float(a['Green'].max()), float(a['Blue'].max()))
    if mx <= 1.0: return 65535.0     # PLY floats 0..1
    if mx <= 255: return 257.0       # 8-bit
    return 1.0

def classify(a, scale):
    """Run speckle scoring on non-noise points and write classes 65..71 in place. Returns the array."""
    cls = a['Classification'].astype(np.uint8).copy()
    cls[(cls >= 65) & (cls <= 71)] = 0       # re-cleaning an already-cleaned file: rescore speckle from scratch
    ok = cls != 7
    if 'Red' in a.dtype.names and ok.any():
        xyz = np.stack([a['X'][ok], a['Y'][ok], a['Z'][ok]], 1)
        rgb = np.stack([a['Red'][ok], a['Green'][ok], a['Blue'][ok]], 1).astype(np.float64) * (scale / 65535.0)
        q = np.zeros(len(a), np.uint8)
        q[ok], _ = speckle_score(xyz, np.clip(rgb, 0, 1))
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
    opts = dict(minor_version=4, dataformat_id=7, scale_x=0.01, scale_y=0.01, scale_z=0.01,
                offset_x='auto', offset_y='auto', offset_z='auto')
    w = (pdal.Writer.copc(filename=path, scale_x=0.01, scale_y=0.01, scale_z=0.01, offset_x='auto', offset_y='auto', offset_z='auto')
         if copc else pdal.Writer.las(filename=path, compression=True, **opts))
    w.pipeline(a).execute()

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
        a = p.arrays[0]
        a = classify(a, G['scale'])          # one scale for all tiles: a dark tile could look 8-bit
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
    ap.add_argument('--workers', type=int, default=3); ap.add_argument('--whole', type=float, default=40e6)
    a = ap.parse_args()
    out_copc = a.out + '.copc.laz'; logf = a.out + '.clean.log'
    os.makedirs(os.path.dirname(os.path.abspath(out_copc)), exist_ok=True)
    src = os.path.abspath(os.path.expanduser(a.src))

    info = json.loads(subprocess.check_output([os.path.join(BIN, 'pdal'), 'info', '--summary', src]))['summary']
    n_src = int(info['num_points']); bb = info['bounds']
    log(logf, f'source {src}: {n_src:,} points, bounds x {bb["minx"]:.1f}..{bb["maxx"]:.1f} y {bb["miny"]:.1f}..{bb["maxy"]:.1f}')

    if n_src <= a.whole:
        p = pdal.Pipeline(json.dumps([{'type': 'readers.' + ('ply' if src.lower().endswith('.ply') else 'copc' if src.endswith('.copc.laz') else 'las'), 'filename': src}] + NOISE))
        p.execute(); arr = p.arrays[0]
        scale = color_scale(arr) or 1.0
        log(logf, f'whole-file pass, color scale x{scale:g}')
        arr = to_las16(classify(arr, scale), scale)
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
        g = dict(src=src, tdir=tdir, tile=T, buf=a.buffer, log=logf, scale=scale)
        with Pool(a.workers, initializer=init, initargs=(g,), maxtasksperchild=1) as pool:
            n_out = sum(pool.map(tile_job, jobs, chunksize=1))
        if n_out != n_src:
            log(logf, f'COUNT MISMATCH: tiles {n_out:,} vs source {n_src:,} -- not merging'); sys.exit(2)
        log(logf, 'merging tiles with untwine')
        tin = a.out + '.tiles_in'; shutil.rmtree(tin, ignore_errors=True); os.makedirs(tin)
        for f in glob.glob(os.path.join(tdir, '*.laz')): os.symlink(os.path.abspath(f), os.path.join(tin, os.path.basename(f)))  # relative targets would dangle
        subprocess.check_call([os.path.join(BIN, 'untwine'), '-i', tin, '-o', out_copc, '--temp_dir', a.out + '.tmp'])

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
    b = s['bounds']; ext = (b['maxx'] - b['minx'], b['maxy'] - b['miny'])
    log(logf, f'OK {out_copc}: {n_copc:,} pts (matches source), noise {noise:.2%}, speckle hidden by default {speck:.2%}')

    did = a.id or os.path.basename(a.out)
    pts = f'{n_copc / 1e9:.2f} B points' if n_copc >= 1e9 else f'{n_copc / 1e6:.2f} M points'
    cx, cy = (b['minx'] + b['maxx']) / 2, (b['miny'] + b['maxy']) / 2
    r = max(ext) * 0.6
    entry = {
        'id': did, 'name': did, 'title': did,
        'url': f'https://storage.googleapis.com/ouster-pointcloud-viewer/pointclouds/{os.path.basename(out_copc)}',
        'thumbnail': f'thumbs/{did}.jpg',
        'description': 'Point cloud of <place>, captured <by drone | on a walk> with an Ouster OS1 Max. ...',
        'facts': ['Ouster OS1 Max', '<Drone | Walking> capture', pts, f'~{ext[0]:.0f} × {ext[1]:.0f} m', 'Reflectivity + RGB' if has_int else 'Full RGB'],
        'camera': {'position': [round(cx + r * 0.5), round(cy - r * 0.8), round(r * 0.5)], 'target': [round(cx), round(cy), 0]},
        'autoOrbit': True, 'viewpoints': [],
        'noiseClassified': True, 'speckle': {'default': 65}, 'clean': {'zBand': None},
        'colorMode': 'rgb',
        'colorModes': ({'rgb': {'label': 'RGB', 'attribute': 'rgba'}, 'reflectivity': {'label': 'Reflectivity', 'attribute': 'intensity', 'range': [0, 40]}}
                       if has_int else {'rgb': {'label': 'RGB', 'attribute': 'rgba'}}),
        'pointBudget': 8000000, 'maxFlySpeed': int(min(150, max(30, max(ext) / 8))),
    }
    json.dump(entry, open(a.out + '.dataset.json', 'w'), indent=2, ensure_ascii=False)
    log(logf, f'wrote {a.out}.dataset.json -- fill in the <...> copy, set camera/viewpoints in the viewer (P copies one)')

if __name__ == '__main__':
    main()
