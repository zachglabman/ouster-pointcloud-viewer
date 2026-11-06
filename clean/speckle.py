"""Color-speckle score for colorized point clouds.

A speckle is a point that is brighter than, and differently colored from, every patch of surface around it:
lidar/camera misregistration paints edge points with sky/roof/road pixels. Real small bright objects
(lights, signs, paint) are bright *with* their neighbors, so their contrast is low.

Reference color: each of the 27 voxels (VOX m) around the point is one surface patch, summarized by its
mean color (own voxel excludes the point). The reference is the patch whose color is closest to the
point's, among patches with >= MIN_PTS points. Comparing to the closest patch, not the neighborhood mean,
keeps narrow bright surfaces next to dense dark ones (sand paths beside plants, curbs, white posts):
their own patch matches. A speckle has no matching patch.
score 0..255 = clip(color distance to reference / 0.5) * clip(brightness excess over reference / 0.25),
boosted for isolated points (< 6 neighbors in ~1.5 m).
Sky-colored points (pale blue / overcast white) are also scored against the neighborhood *mean*, because
sky fringe clusters along whole canopy edges and would otherwise match its own fringe patch, unless a
nearby patch matches the point's color closely (a solid white/blue surface: wall, post, tarp).
"""
import numpy as np

_LUM = np.array([0.299, 0.587, 0.114])
_OFFS = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)]


def speckle_score(xyz, rgb01, vox=0.5, min_pts=4, patch=False):
    lum = rgb01 @ _LUM
    ijk = np.floor((xyz - xyz.min(0)) / vox).astype(np.int64) + 1
    M = ijk.max(0) + 2
    key = (ijk[:, 0] * M[1] + ijk[:, 1]) * M[2] + ijk[:, 2]
    uk, inv = np.unique(key, return_inverse=True)
    n_v = np.bincount(inv).astype(np.float64)
    s_v = np.stack([np.bincount(inv, rgb01[:, c]) for c in range(3)], 1)
    Nv = np.zeros_like(n_v); Sv = np.zeros_like(s_v)
    ref = np.zeros_like(rgb01); best = np.full(len(xyz), np.inf)
    for dx, dy, dz in _OFFS:
        k = uk + (dx * M[1] + dy) * M[2] + dz
        j = np.minimum(np.searchsorted(uk, k), len(uk) - 1); hit = uk[j] == k
        Nv[hit] += n_v[j[hit]]; Sv[hit] += s_v[j[hit]]
        if not patch: continue
        # This neighbor patch's mean color, per point (voxel-level lookup, broadcast through inv).
        jv = np.where(hit, j, -1)[inv]; ok = jv >= 0
        n = np.where(ok, n_v[jv], 0.0); s = np.where(ok[:, None], s_v[jv], 0.0)
        if (dx, dy, dz) == (0, 0, 0): n = n - 1; s = s - rgb01          # own patch without the point
        ok &= n >= min_pts
        mc = s / np.maximum(n, 1)[:, None]
        d = np.linalg.norm(rgb01 - mc, axis=1); d[~ok] = np.inf
        b = d < best; best[b] = d[b]; ref[b] = mc[b]
    S = Sv[inv]; N = Nv[inv]
    clip = lambda x: np.clip(x, 0, 1)
    mean = (S - rgb01) / np.maximum(N - 1, 1)[:, None]        # neighborhood mean color (excl. self)

    def contrast(nb):
        dist = np.linalg.norm(rgb01 - nb, axis=1)
        return clip(dist / 0.5) * clip((lum - nb @ _LUM) / 0.25), dist

    score, dist = contrast(mean)
    iso = clip((6 - (N - 1)) / 6)                               # <6 neighbors in ~1.5 m: stray
    score = np.maximum(score, iso * clip(dist / 0.3))
    if patch:
        has = np.isfinite(best); nb = mean.copy(); nb[has] = ref[has]
        own, _ = contrast(nb)
        r, g, b = rgb01.T; mx = rgb01.max(1); mn = rgb01.min(1); sat = (mx - mn) / np.maximum(mx, 1e-6)
        sky = np.maximum(clip((b - np.maximum(r, g * 0.95)) / 0.06) * clip((mx - 0.15) / 0.25),
                         clip((mn - 0.50) / 0.30) * clip((0.25 - sat) / 0.15))
        solid = clip((0.15 - best) / 0.10)                     # a nearby patch matches closely: solid surface
        score = np.maximum(np.maximum(own, iso * clip(dist / 0.3)), score * sky * (1 - solid))
    return np.round(score * 255).astype(np.uint8), N - 1
