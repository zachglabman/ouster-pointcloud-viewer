"""Color-speckle score for colorized point clouds.

A speckle is a point whose color is far from its neighborhood's (3x3x3 voxels of VOX m), and brighter:
lidar/camera misregistration paints edge points with sky/roof/road pixels. Real small bright objects
(lights, signs, paint) are bright *with* their neighbors, so their contrast is low.
score 0..255 = clip(color distance to neighbor mean / 0.5) * clip(brightness excess / 0.25), boosted for isolated points.
"""
import numpy as np

def speckle_score(xyz, rgb01, vox=0.5):
    lum = rgb01 @ np.array([0.299, 0.587, 0.114])
    ijk = np.floor((xyz - xyz.min(0)) / vox).astype(np.int64) + 1
    M = ijk.max(0) + 2
    key = (ijk[:, 0] * M[1] + ijk[:, 1]) * M[2] + ijk[:, 2]
    uk, inv = np.unique(key, return_inverse=True)
    n_v = np.bincount(inv).astype(np.float64)
    s_v = np.stack([np.bincount(inv, rgb01[:, c]) for c in range(3)], 1)
    # 27-neighborhood sums per occupied voxel (far fewer voxels than points), then broadcast to points.
    Sv = np.zeros_like(s_v); Nv = np.zeros_like(n_v)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                k = uk + (dx * M[1] + dy) * M[2] + dz
                j = np.minimum(np.searchsorted(uk, k), len(uk) - 1); hit = uk[j] == k
                Sv[hit] += s_v[j[hit]]; Nv[hit] += n_v[j[hit]]
    S = Sv[inv]; N = Nv[inv]
    nb = (S - rgb01) / np.maximum(N - 1, 1)[:, None]          # neighbors' mean color (excl. self)
    dist = np.linalg.norm(rgb01 - nb, axis=1)
    excess = lum - nb @ np.array([0.299, 0.587, 0.114])
    clip = lambda x: np.clip(x, 0, 1)
    score = clip(dist / 0.5) * clip(excess / 0.25)
    iso = clip((6 - (N - 1)) / 6)                               # <6 neighbors in ~1.5 m: stray
    score = np.maximum(score, iso * clip(dist / 0.3))
    return np.round(score * 255).astype(np.uint8), N - 1
