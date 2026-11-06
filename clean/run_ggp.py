"""Tile-wise cleaning of the GGP COPC.

Per 100 m tile (+3 m buffer, so neighborhoods are complete at tile edges):
  1. filters.outlier (statistical, mean_k 12, x3) + filters.elm (10 m, 1)  -> Classification 7  (floating noise)
  2. color-speckle score (speckle.py) on non-noise points -> Classification 64 + score//32  (65..71 = 8 strength bands)
  3. keep only the tile's core points (half-open, so every point lands in exactly one tile) -> tiles/<i>_<j>.laz
Every point is kept; the viewer hides classes. Resumable: finished tiles are skipped.
Usage: python run_ggp.py [workers]      (then: untwine -i tiles -o out/ggp-v2.copc.laz)
"""
import json, os, sys, time, traceback
from multiprocessing import Pool
import numpy as np, pdal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from speckle import speckle_score

SRC = os.path.join(HERE, '..', 'out', 'ggp.copc.laz')
DST = os.path.join(HERE, 'tiles')
LOG = os.path.join(HERE, 'run_ggp.log')
X0, Y0, T, BUF = -600.0, -1200.0, 100.0, 3.0
NX = NY = 17          # covers x -600..1100, y -1200..500 (data: x -538..1054, y -1162..470)

def log(msg):
    with open(LOG, 'a') as f: f.write(time.strftime('%H:%M:%S ') + msg + '\n')

def tile(ij):
    i, j = ij
    out = os.path.join(DST, f'{i:02d}_{j:02d}.laz')
    done = out + '.n'
    if os.path.exists(done): return int(open(done).read())
    x0, y0 = X0 + i * T, Y0 + j * T
    t = time.time()
    try:
        bounds = f'([{x0 - BUF},{x0 + T + BUF}],[{y0 - BUF},{y0 + T + BUF}])'
        p = pdal.Pipeline(json.dumps([
            {'type': 'readers.copc', 'filename': SRC, 'bounds': bounds},
            {'type': 'filters.outlier', 'method': 'statistical', 'mean_k': 12, 'multiplier': 3.0},
            {'type': 'filters.elm', 'cell': 10.0, 'threshold': 1.0},
        ]))
        n = p.execute()
        if n == 0:
            open(done, 'w').write('0'); return 0
        a = p.arrays[0]
        cls = a['Classification'].copy()
        ok = cls != 7
        q = np.zeros(len(a), np.uint8)
        if ok.sum() > 0:
            xyz = np.stack([a['X'][ok], a['Y'][ok], a['Z'][ok]], 1)
            rgb = np.stack([a['Red'][ok], a['Green'][ok], a['Blue'][ok]], 1) / 65535.0
            q[ok], _ = speckle_score(xyz, rgb)
        band = q // 32                          # 0..7
        sp = ok & (band >= 1)
        cls[sp] = 64 + band[sp]
        a['Classification'] = cls
        core = (a['X'] >= x0) & (a['X'] < x0 + T) & (a['Y'] >= y0) & (a['Y'] < y0 + T)
        a = a[core]
        if len(a):
            w = pdal.Writer.las(filename=out + '.tmp.laz', minor_version=4, dataformat_id=7,
                                scale_x=0.01, scale_y=0.01, scale_z=0.01, offset_x=0, offset_y=0, offset_z=0,
                                compression=True).pipeline(a)
            w.execute()
            os.replace(out + '.tmp.laz', out)
        c = a['Classification']
        log(f'tile {i:02d}_{j:02d}: {len(a):>10,} pts  noise {np.mean(c == 7):.4f}  speckle>=96 {np.mean(c >= 67):.4f}  {time.time() - t:6.1f}s')
        open(done, 'w').write(str(len(a)))
        return len(a)
    except Exception:
        log(f'tile {i:02d}_{j:02d}: FAILED\n' + traceback.format_exc())
        raise

if __name__ == '__main__':
    os.makedirs(DST, exist_ok=True)
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    only = sys.argv[2] if len(sys.argv) > 2 else None    # e.g. "07_08" to test one tile
    tiles = [(i, j) for i in range(NX) for j in range(NY)]
    if only: tiles = [tuple(map(int, only.split('_')))]
    log(f'start: {len(tiles)} tiles, {workers} workers')
    t = time.time()
    with Pool(workers, maxtasksperchild=1) as pool:
        counts = pool.map(tile, tiles, chunksize=1)
    total = sum(counts)
    log(f'done: {total:,} points in {time.time() - t:.0f}s (expected 1,414,051,258)')
    print(total)
