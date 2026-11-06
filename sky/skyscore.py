"""Per-point 'sky bleed' score (0-255) for a colorized PLY, written as LAS Intensity.

Sky bleed = points on silhouettes (tree/roof edges, wires) that took sky-colored pixels.
score = color skyness  x  how much skier the point is than its 3x3x3 voxel neighborhood.
Real blue/white surfaces (cars, walls, painted lines) are skyish *together with* their
neighbors, so their contrast term is low and they keep a low score.
"""
import sys, numpy as np

src, out_npy = sys.argv[1], sys.argv[2]
VOX = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5

f = open(src, 'rb'); h = b''
while not h.endswith(b'end_header\n'): h += f.read(1)
a = np.fromfile(f, dtype='<f4').reshape(-1, 6)
r, g, b = a[:, 3], a[:, 4], a[:, 5]
mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
sat = (mx - mn) / np.maximum(mx, 1e-6)
clip = lambda x: np.clip(x, 0, 1)
blue = clip((b - np.maximum(r, g * 0.95)) / 0.06) * clip((mx - 0.15) / 0.25)   # pale/sky blue
white = clip((mn - 0.50) / 0.30) * clip((0.25 - sat) / 0.15)                     # overcast white
sc = np.maximum(blue, white).astype(np.float32)

# neighborhood mean skyness over 3x3x3 voxels
ijk = np.floor(a[:, :3] / VOX).astype(np.int64); ijk -= ijk.min(0)
M = ijk.max(0) + 3
key = ((ijk[:, 0] + 1) * M[1] + (ijk[:, 1] + 1)) * M[2] + (ijk[:, 2] + 1)
uk, inv = np.unique(key, return_inverse=True)
vs = np.bincount(inv, sc); vn = np.bincount(inv).astype(np.float64)
S = np.zeros(len(a)); N = np.zeros(len(a))
for dx in (-1, 0, 1):
    for dy in (-1, 0, 1):
        for dz in (-1, 0, 1):
            k = key + (dx * M[1] + dy) * M[2] + dz
            j = np.searchsorted(uk, k); j = np.minimum(j, len(uk) - 1); hit = uk[j] == k
            S[hit] += vs[j[hit]]; N[hit] += vn[j[hit]]
nb = (S - sc) / np.maximum(N - 1, 1)                     # neighbors' mean skyness (excl. self)
contrast = clip((sc - nb) / 0.5 + 0.2)                   # skier than surroundings -> ~1
iso = clip((8 - (N - 1)) / 8)                            # very few neighbors = stray -> boosts
score = clip(sc * np.maximum(contrast, iso))
q = np.round(score * 255).astype(np.uint16)
np.save(out_npy, q)
for t in (32, 64, 96, 128, 160, 192):
    print(f'score >= {t:3d}: {np.mean(q >= t)*100:5.2f}%')
