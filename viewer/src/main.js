// Dataset viewer on Potree 1.8.2 (patched: reflectivity + height-band shader filters).
// datasets.json drives datasets; the toolbar is the simple layer, the panel is "Advanced".
//
// Keys:  G  orbit <-> fly (god mode)      1 / 2 / 3  color modes
//        Fly: W A S D move, E / R up, Q / F down, drag to look,
//             scroll = speed, Shift = 4x boost, Ctrl = 1/4 creep
//        Orbit: drag rotate, right-drag pan, scroll zoom, double-click = zoom to point
//        N  cycle noise Show / Hide / Only     P  copy camera JSON (viewpoint authoring)
//        M  distance   Esc cancel   ⌘Z / ⇧⌘Z undo / redo   O orthographic   X x-ray   T top view
// URL:   #d=<id>&c=<color>&cam=px,py,pz,tx,ty,tz&m=<measurements> (share links; "#<id>" also works)
//        #d=<id>&tour  opens straight into the dataset's guided tour
// Tour:  ← / → previous / next stop, Space pause, any drag/scroll/other key hands control back
//        ?stats=1 HUD, ?dev=1 dev datasets, ?advanced=1 open panel

import { createTools, createGizmo, screenshot, KINDS } from './tools.js';
import { track } from './analytics.js';
import { createTour } from './tour.js';

const T0 = performance.now();
const params = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s);
const isTouch = matchMedia('(pointer: coarse)').matches;

// ?config=<file>.json picks another dataset list from the same site (e.g. datasets.sample.json). Relative
// paths only: a link must not be able to load someone else's datasets and links under this domain.
const cfgPath = params.get('config');
const cfgFile = cfgPath && /^(?!.*\.\.)[\w.-]+(\/[\w.-]+)*\.json$/.test(cfgPath) ? cfgPath : 'datasets.json';
const cfg = await (await fetch(cfgFile, { cache: 'no-cache' })).json();
const datasets = cfg.datasets.filter((d) => !d.dev || params.has('dev'));
// UI switches ("ui" in the config): turn off the parts an embed doesn't need.
const UI = { switcher: true, cta: true, tour: true, share: true, measure: true, image: true, advanced: true, ...cfg.ui };
const ev = (name, p = {}) => track(name, { dataset: state.activeId, ...p });

const DEFAULT_COLOR_MODES = {
  rgb: { label: 'RGB', attribute: 'rgba' },
  reflectivity: { label: 'Reflectivity', attribute: 'intensity', range: [0, 40] },
};
const HEIGHT_MODE = { label: 'Height', attribute: 'elevation', gradient: 'TURBO' };

const viewer = new Potree.Viewer($('#potree_render_area'));
window.viewer = viewer;
viewer.fpControls.keys.UP.push('E'.charCodeAt(0));
viewer.fpControls.keys.DOWN.push('Q'.charCodeAt(0));

// Measurements, axis gizmo (tools.js). onChange re-renders the toolbar so Measure shows as active.
const tools = createTools({ viewer, el: (...a) => el(...a), toast: (m) => toast(m), activeId: () => state.activeId, onChange: () => renderToolbar(), onMeasure: (kind) => ev('measure', { kind }) });
window.tools = tools; // console access, like window.viewer
const gizmo = createGizmo($('#gizmo'), viewer, (dir) => snapView(dir));
const tour = createTour({ viewer, el: (...a) => el(...a), root: $('#tour'), onEvent: (n, p) => ev(n, p), onEnd: () => renderInfo(), onPrefetch: (s) => prefetchView(s),
  viewFull: () => { const pc = viewer.scene.pointclouds.find((p) => p.visible); return !!pc && pc.numVisiblePoints >= 0.97 * viewer.getPointBudget(); } });

// ---------- prefetch: load another view's detail in the background ----------
// After each rendered frame, run Potree's visibility pass for a second camera at the target view: that
// queues its missing nodes for download. The next frame's update recomputes visibility for the real
// camera before drawing, so the screen is unaffected. It runs every frame (only while touring), after the
// frame, so it claims free download slots before the next frame's pass for the real camera does.
let pfCam = null, pfStop = null;
function prefetchView(stop) {
  pfStop = stop;
  if (!stop) return;
  const cam = viewer.scene.getActiveCamera();
  pfCam = pfCam || cam.clone();
  pfCam.copy(cam);
  pfCam.position.set(...stop.position);
  pfCam.lookAt(...stop.target);
  pfCam.updateMatrixWorld(true);
}
viewer.addEventListener('render.pass.end', () => {
  if (!pfStop) return;
  Potree.updatePointClouds(viewer.scene.pointclouds.filter((p) => p.visible), pfCam, viewer.renderer);
});
window.tour = tour;
function startTour(at = 0) {
  const ds = activeDs();
  if (!UI.tour || !ds?.tour?.length) return;
  stopAutoOrbit(); tools.cancel();
  if (S.nav !== 'orbit') setNav('orbit');
  if (S.ortho) setOrtho(false);
  state.pop = null;
  tour.start(ds, at);
  renderAll();
}

// ---------- fly speed cap ----------
const SPEED_MIN = 0.5, DEFAULT_MAX_SPEED = 150;
const maxSpeed = () => activeDs()?.maxFlySpeed ?? DEFAULT_MAX_SPEED;
const rawSetMoveSpeed = viewer.setMoveSpeed.bind(viewer);
viewer.setMoveSpeed = (v) => rawSetMoveSpeed(Math.min(maxSpeed(), Math.max(SPEED_MIN, v)));

// ---------- settings ----------
const DEFAULTS = {
  nav: 'orbit', fov: 60, background: 'black',
  colorKey: null,
  refl: { range: [0, 40], gamma: 1 },
  rgb: { gamma: 1, brightness: 0, contrast: 0 },
  pointSize: 0.5, sizeType: 'ADAPTIVE', shape: 'CIRCLE',
  budgetM: isTouch ? 2 : 8, voxelLevel: Infinity,
  lodPx: isTouch ? 10 : 6,       // refine a node once it covers this many CSS px (lower = sooner)
  res: 'auto',                   // render resolution: 'auto' (adaptive) | 1 | 1.5 | 2  (x CSS pixels)
  clean: true,                   // simple toggle: applies the dataset's clean preset
  noise: 'show',                 // show | hide | only   (Classification 7)
  zBand: null,                   // [zmin, zmax] world Z; null = full extent
  reflFilter: [0, 255],
  skyCut: 0,                     // 0-100 % sky-fringe removal (datasets with a skyFilter score in Intensity)
  speckle: 0,                    // 0-100 % color-speckle removal (datasets with speckle bands in classes 65-71)
  edl: true, edlStrength: 1, edlRadius: 1.4,
  ortho: false,
  xray: false, xrayOpacity: 0.04, // additive: dense areas saturate fast, keep it low
};
const S = structuredClone(DEFAULTS);
const state = { activeId: null, boost: 1, baseSpeed: null, autoOrbit: false, advanced: params.has('advanced'), pop: null };
const clouds = new Map();
// Potree's pick() gets the mouse in CSS px but reads its pick buffer at render size (scaleFactor x CSS).
// Scale the coordinates so clicks (measurements, double-click zoom) land under the cursor.
function patchPick(pc) {
  const proto = Object.getPrototypeOf(pc);
  if (proto.__scaledPick) return;
  const pick = proto.pick;
  proto.pick = function (viewer, camera, ray, params = {}) {
    const k = viewer.scaleFactor || 1;
    if (k !== 1 && params.x != null) params = { ...params, x: params.x * k, y: params.y * k };
    return pick.call(this, viewer, camera, ray, params);
  };
  proto.__scaledPick = true;
}
const SPECKLE_CLASSES = [65, 66, 67, 68, 69, 70, 71];
// Register them with a color: Potree's classification LUT crashes on entries without one.
for (const c of SPECKLE_CLASSES) viewer.classifications[c] ??= { visible: true, name: `speckle ${c - 64}`, color: [0.9, 0.3, 0.9, 1] };
const budgetFor = (ds) => Math.min((ds?.pointBudget || 8e6) / 1e6, isTouch ? 2 : 99);

// ---------- render resolution ----------
// Potree draws at CSS-pixel size by default (half resolution on Retina). viewer.scaleFactor sizes the
// drawing buffer and EDL targets; CSS (#potree_render_area canvas) pins the displayed size.
// 'auto' starts at the screen's real resolution (capped at 2x desktop, 1.5x phones) and steps down
// while frames are slow, back up once there is headroom.
const RES_MAX = Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 2);
const res = { frameMs: 16, lastChange: 0, ceiling: RES_MAX, ceilingUntil: 0 };
// Largest on-screen point, CSS px. Potree's default (50 device px) turns not-yet-refined areas into big
// blobs; capped, coarse areas read as sparse points and sharpen as detail streams in.
const MAX_POINT_PX = 4;
const capPointSize = () => forClouds((pc) => { pc.material.uniforms.maxSize.value = MAX_POINT_PX * viewer.scaleFactor; });
// Parallel node downloads (Potree default 4). Measured in Chrome against the bucket, 96 real chunks:
// 4 at once 6.2 s, 12 4.2 s, 24 3.2 s, 48 3.6 s. (Merging adjacent chunks into one range request was
// tried and dropped: views are bandwidth-bound, ~50 MB for a sharp 16 M-point view, so fewer requests
// saved little; a view's chunks merge 0-30% in typical views.)
Potree.maxNodesLoading = isTouch ? 8 : 24;
function setScale(v) {
  v = Math.max(1, Math.min(RES_MAX, Math.round(v * 4) / 4));
  if (v === viewer.scaleFactor) return;
  viewer.scaleFactor = v;
  viewer.setMinNodeSize(S.lodPx * v);
  capPointSize();
}
function resTick(dtMs, now) {
  if (document.hidden) return;
  res.frameMs += (dtMs - res.frameMs) * 0.1; // smoothed frame time
  if (S.res !== 'auto') return setScale(Number(S.res));
  if (now - res.lastChange < 1500) return;
  if (now > res.ceilingUntil) res.ceiling = RES_MAX;
  if (res.frameMs > 24 && viewer.scaleFactor > 1) {            // below ~42 fps: step down, and stay below
    res.ceiling = viewer.scaleFactor - 0.25; res.ceilingUntil = now + 20000;   // this scale for 20 s
    setScale(res.ceiling); res.lastChange = now;
  } else if (res.frameMs < 18 && viewer.scaleFactor < res.ceiling) {          // holding ~60 fps (vsync): step up
    setScale(viewer.scaleFactor + 0.25); res.lastChange = now;
  }
}
viewer.scaleFactor = RES_MAX;
const info = new Map();

const activeDs = () => datasets.find((d) => d.id === state.activeId);
const colorModesOf = (ds) => ({ ...(ds.colorModes || DEFAULT_COLOR_MODES), height: HEIGHT_MODE });

function load(ds) {
  if (!clouds.has(ds.id)) {
    clouds.set(ds.id, new Promise((resolve, reject) => {
      Potree.loadPointCloud(ds.url, ds.id, (e) => {
        const pc = e.pointcloud;
        if (!pc) return reject(new Error(`failed to load ${ds.url}`));
        pc.visible = false;
        const h = pc.pcoGeometry.copc?.header;
        info.set(ds.id, {
          zMin: h ? h.min[2] : pc.boundingBox.min.z,
          zMax: h ? h.max[2] : pc.boundingBox.max.z,
          rootSpacing: pc.pcoGeometry.spacing,
        });
        patchPick(pc);
        viewer.scene.addPointCloud(pc);
        resolve(pc);
      });
    }));
  }
  return clouds.get(ds.id);
}
const forClouds = (fn) => { for (const p of clouds.values()) p.then(fn); };

function zBand() {
  const i = info.get(state.activeId);
  return S.zBand || (i ? [i.zMin, i.zMax] : [-1e30, 1e30]);
}

// Intensity filter: reflectivity bounds, or (skyFilter datasets) a cut on the precomputed sky-bleed score.
// Score 0-255 is stored in Intensity; strength s% hides points with score >= 256 - 2.56*s.
function intensityFilter() {
  if (activeDs()?.skyFilter) return S.skyCut > 0 ? [-1e30, 255.5 - 2.56 * S.skyCut] : [-1e30, 1e30];
  return S.reflFilter[0] <= 0 && S.reflFilter[1] >= 255 ? [-1e30, 1e30] : S.reflFilter;
}

function applyColor(pc) {
  const ds = activeDs(); if (!ds) return;
  const mode = colorModesOf(ds)[S.colorKey];
  const m = pc.material;
  m.activeAttributeName = mode.attribute;
  if (mode.attribute === 'intensity') {
    m.intensityRange = S.refl.range; m.intensityGamma = S.refl.gamma;
    m.intensityBrightness = 0; m.intensityContrast = 0;
  } else if (mode.attribute === 'rgba') {
    m.rgbGamma = S.rgb.gamma; m.rgbBrightness = S.rgb.brightness; m.rgbContrast = S.rgb.contrast;
  } else if (mode.attribute === 'elevation') {
    m.gradient = Potree.Gradients[mode.gradient] || Potree.Gradients.TURBO;
    m.elevationRange = zBand();
  }
}

function applySettings() {
  viewer.setFOV(S.fov);
  viewer.setBackground(S.background);
  viewer.setEDLEnabled(S.edl && !S.xray); // EDL needs depth; x-ray draws without it
  viewer.setCameraMode(S.ortho ? Potree.CameraMode.ORTHOGRAPHIC : Potree.CameraMode.PERSPECTIVE);
  viewer.setEDLStrength(S.edlStrength);
  viewer.setEDLRadius(S.edlRadius);
  viewer.setPointBudget(S.budgetM * 1e6);
  viewer.setMinNodeSize(S.lodPx * viewer.scaleFactor); // Potree measures node size in render pixels
  // Classes: 7 = floating noise; 65..71 = color-speckle bands (band b holds scores 32b..32b+31, see clean/run_ggp.py).
  // Strength s% hides bands whose score >= 256 - 2.56 s (65% -> score >= 96).
  const cut = 256 - 2.56 * S.speckle;
  const keys = new Set([...Object.keys(viewer.classifications), ...SPECKLE_CLASSES.map(String)]);
  for (const key of keys) {
    const c = Number(key), isNoise = c === 7, band = c - 64;
    const isSpeckle = band >= 1 && band <= 7;
    const visible = S.noise === 'only' ? isNoise
      : isNoise ? S.noise === 'show'
      : isSpeckle ? 32 * band < cut
      : true;
    viewer.setClassificationVisibility(key, visible);
  }
  forClouds((pc) => {
    const m = pc.material;
    m.size = S.pointSize;
    m.uniforms.maxSize.value = MAX_POINT_PX * viewer.scaleFactor;
    m.pointSizeType = Potree.PointSizeType[S.sizeType];
    m.shape = Potree.PointShape[S.shape];
    m.opacity = S.xray ? S.xrayOpacity : 1; // <1 = additive blend, no depth test: see-through
    m.useOrthographicCamera = S.ortho;
    pc.maxLevel = S.voxelLevel;
    m.uniforms.uFilterIntensityRange.value = intensityFilter();
    m.uniforms.uFilterZRange.value = S.zBand || [-1e30, 1e30];
    if (pc.visible) applyColor(pc);
  });
  renderLegend();
}

// "Clean" = the dataset's preset height band + hide classified noise.
function setClean(on) {
  const ds = activeDs();
  S.clean = on;
  S.zBand = on && ds?.clean?.zBand ? [...ds.clean.zBand] : null;
  S.noise = on && ds?.noiseClassified ? 'hide' : 'show';
  S.skyCut = on && ds?.skyFilter ? ds.skyFilter.default : 0;
  S.speckle = on && ds?.speckle ? ds.speckle.default : 0;
  applySettings(); renderAll();
}

function setColor(key) { S.colorKey = key; applySettings(); renderAll(); }

function setNav(mode) {
  if (mode !== S.nav) ev('nav_mode', { mode });
  S.nav = mode;
  stopAutoOrbit();
  if (mode === 'fly') {
    if (S.ortho) { S.ortho = false; applySettings(); } // flying needs perspective
    viewer.setMoveSpeed(Math.max(2, viewer.scene.view.radius / 4));
    viewer.setControls(viewer.fpControls);
  } else if (mode === 'pan') {
    viewer.setControls(viewer.earthControls);
  } else {
    viewer.setControls(viewer.orbitControls);
  }
  renderAll();
}
function setOrtho(on) {
  if (on) ev('ortho');
  S.ortho = on;
  if (on && S.nav === 'fly') setNav('orbit');
  applySettings(); renderAll();
}
function setXray(on) { if (on) ev('xray'); S.xray = on; applySettings(); renderAll(); }

// Look at the current pivot from direction `dir` (unit vector from pivot to camera), same distance.
function snapView(dir) {
  stopAutoOrbit();
  if (S.nav === 'fly') setNav('orbit');
  const v = viewer.scene.view, p = v.getPivot(), r = v.radius;
  // Straight up/down: nudge along the current heading so the view keeps its rotation.
  let d = [...dir];
  if (Math.abs(d[2]) > 0.99) { const h = v.direction; const n = Math.hypot(h.x, h.y) || 1; d = [-h.x / n * 1e-3, -h.y / n * 1e-3, Math.sign(d[2])]; }
  viewer.scene.view.setView([p.x + d[0] * r, p.y + d[1] * r, p.z + d[2] * r], [p.x, p.y, p.z], 500);
}
const VIEWS = [['Top', [0, 0, 1]], ['Front', [0, -1, 0]], ['Back', [0, 1, 0]], ['Left', [-1, 0, 0]], ['Right', [1, 0, 0]]];

function flyTo(cam, duration = 1.2) {
  if (cam.name) ev('viewpoint', { name: cam.name });
  stopAutoOrbit();
  if (S.nav === 'fly') setNav('orbit');
  viewer.scene.view.setView(cam.position, cam.target, duration * 1000);
}

// ---------- auto-orbit intro ----------
let lastT = performance.now();
function stopAutoOrbit() { state.autoOrbit = false; }
for (const ev of ['pointerdown', 'wheel', 'touchstart']) $('#potree_render_area').addEventListener(ev, stopAutoOrbit, { passive: true });
addEventListener('keydown', stopAutoOrbit);

// ---------- dataset switching ----------
function setCamera(ds, pc, cam) {
  const c = cam || ds.camera;
  if (c && c.position && c.target) viewer.scene.view.setView(c.position, c.target, 0);
  else viewer.zoomTo(pc, 1.0, 0);
}

async function switchTo(id, { cam = null, color = null } = {}) {
  const ds = datasets.find((d) => d.id === id && d.url);
  if (!ds || id === state.activeId) return;
  if (tour.active) tour.stop('switch');
  state.activeId = id;
  history.replaceState(null, '', `${location.search}#d=${id}`); // replaceState fires no hashchange
  S.budgetM = budgetFor(ds);
  renderAll();

  const pc = await load(ds);
  if (state.activeId !== id) return;
  for (const [otherId, p] of clouds) p.then((o) => { o.visible = otherId === id; });
  tools.showDataset(id);
  const modes = colorModesOf(ds);
  S.colorKey = modes[color] ? color : modes[S.colorKey] ? S.colorKey : (ds.colorMode in modes ? ds.colorMode : Object.keys(modes)[0]);
  const refl = (ds.colorModes || DEFAULT_COLOR_MODES).reflectivity;
  if (refl?.range) S.refl.range = [...refl.range];
  if (!refl) S.reflFilter = [0, 255]; // no intensity in this dataset: a refl filter would hide everything
  setClean(S.clean);
  setCamera(ds, pc, cam);
  state.autoOrbit = !cam && !!ds.autoOrbit;
  renderAll();
  ev('dataset_view', { from_link: !!cam });
}

// ---------- share ----------
function shareUrl() {
  const v = viewer.scene.view, r = (a) => a.map((x) => Math.round(x * 100) / 100);
  const cam = [...r(v.position.toArray()), ...r(v.getPivot().toArray())].join(',');
  const u = new URL(location.href);
  for (const k of ['stats', 'dev', 'advanced']) u.searchParams.delete(k);
  const m = tools.encode(state.activeId);
  u.hash = `d=${state.activeId}&c=${S.colorKey}&cam=${cam}` + (m ? `&m=${m}` : '');
  return u.toString();
}
async function share() {
  const url = shareUrl();
  const ds = activeDs();
  if (isTouch && navigator.share) {
    try { await navigator.share({ title: ds?.title || 'Lidar dataset', url }); return; } catch { /* fall through to copy */ }
  }
  const n = tools.count(state.activeId);
  ev('share', { measurements: n });
  try { await navigator.clipboard.writeText(url); toast(n ? `Link copied with ${n} measurement${n > 1 ? 's' : ''}` : 'Link to this view copied'); }
  catch { toast(url); }
}
function parseHash() {
  const h = location.hash.slice(1);
  if (!h) return {};
  if (!h.includes('=')) return { id: h };
  const p = new URLSearchParams(h);
  const n = (p.get('cam') || '').split(',').map(Number);
  const cam = n.length === 6 && n.every(Number.isFinite) ? { position: n.slice(0, 3), target: n.slice(3) } : null;
  return { id: p.get('d'), color: p.get('c'), cam, m: p.get('m'), tour: p.has('tour') };
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// ---------- UI helpers ----------
function el(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null && k !== false)); return e; }
function seg(items, active, onPick, { disabled = false, className = 'seg' } = {}) {
  return el('div', { className, role: 'group' }, ...items.map(([key, label, hint]) => {
    const b = el('button', { textContent: label, title: hint || '', disabled });
    b.setAttribute('aria-pressed', String(key === active));
    b.onclick = () => onPick(key);
    return b;
  }));
}
function toggle(label, on, onClick, title = '') {
  const b = el('button', { className: 'tb', textContent: label, title, onclick: onClick });
  b.setAttribute('aria-pressed', String(on));
  return b;
}
function slider(label, { min, max, step, value, fmt = (v) => v, onInput, title = '' }) {
  const out = el('output', { textContent: fmt(value) });
  const inp = el('input', { type: 'range', min, max, step, value });
  inp.oninput = () => { const v = Number(inp.value); out.textContent = fmt(v); onInput(v); };
  return el('label', { title }, el('span', { textContent: label }), inp, out);
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function section(id, title, ...rows) {
  const d = el('details', { open: store.get(`sec:${id}`, id === 'color' || id === 'cleaning') }, el('summary', { textContent: title }), ...rows);
  d.ontoggle = () => store.set(`sec:${id}`, d.open);
  return d;
}
const fmtM = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' m';
function voxelOptions() {
  const i = info.get(state.activeId); if (!i) return [];
  const opts = [];
  for (let L = 4; L <= 12; L++) opts.push({ level: L + 1, size: i.rootSpacing / 2 ** L });
  return opts;
}
const fmtSize = (s) => (s >= 1 ? s.toFixed(2) + ' m' : s >= 0.01 ? (s * 100).toFixed(1) + ' cm' : (s * 1000).toFixed(1) + ' mm');

// ---------- info card (top-left) ----------
function renderInfo() {
  const ds = activeDs();
  const card = $('#info');
  if (!ds) return card.replaceChildren();
  const collapsed = store.get('infoCollapsed', isTouch);
  const ctaUrl = ds.cta?.url || ds.studioUrl;
  const cta = UI.cta && ctaUrl ? el('a', { className: 'cta', href: ctaUrl, target: '_blank', rel: 'noopener', textContent: (ds.cta?.label || 'See Full Dataset') + ' →',
    onclick: () => track('cta_click', { dataset: ds.id, url: ctaUrl }) }) : null;
  const tourBtn = UI.tour && ds.tour?.length ? el('button', { className: 'tour-btn', textContent: tour.active ? '■ End tour' : '▶ Take the tour',
    title: tour.active ? 'Stop the tour here' : `About ${Math.max(1, Math.round(ds.tour.reduce((t, x) => t + (x.hold ?? 6) + 5, 0) / 60))} min, ${ds.tour.length} stops. Drag any time to take over.`,
    onclick: () => (tour.active ? tour.stop('close') : startTour()) }) : null;
  const vps = ds.viewpoints?.length ? el('div', { className: 'vps' }, el('span', { textContent: 'Jump to' }),
    ...ds.viewpoints.map((vp) => el('button', { className: 'chip', textContent: vp.name, onclick: () => flyTo(vp) }))) : null;
  const head = el('div', { className: 'info-head' },
    el('h1', { textContent: ds.title || ds.name }),
    el('button', { className: 'icon', title: collapsed ? 'Show details' : 'Hide details', textContent: collapsed ? '▾' : '▴',
      onclick: () => { store.set('infoCollapsed', !collapsed); renderInfo(); } }));
  card.replaceChildren(...[head,
    !collapsed && ds.description ? el('p', { textContent: ds.description }) : null,
    !collapsed && ds.facts?.length ? el('div', { className: 'facts' }, ...ds.facts.map((f) => el('span', { textContent: f }))) : null,
    !collapsed ? vps : null,
    tourBtn ? el('div', { className: 'actions' }, tourBtn, cta) : cta].filter(Boolean)); // replaceChildren would stringify nulls
}

// ---------- reflectivity legend ----------
function renderLegend() {
  const lg = $('#legend');
  const mode = activeDs() && colorModesOf(activeDs())[S.colorKey];
  if (!mode || mode.attribute === 'rgba') return lg.replaceChildren();
  const [lo, hi] = mode.attribute === 'intensity' ? S.refl.range : zBand();
  const cls = mode.attribute === 'intensity' ? 'bar gray' : 'bar turbo';
  const lbl = mode.attribute === 'intensity' ? ['low reflectivity', 'high'] : [fmtM(lo), fmtM(hi)];
  lg.replaceChildren(el('div', { className: cls }), el('div', { className: 'ends' }, el('span', { textContent: lbl[0] }), el('span', { textContent: lbl[1] })));
}

// ---------- toolbar (bottom-center, the simple layer) ----------
function renderToolbar() {
  const ds = activeDs();
  const tb = $('#toolbar');
  if (!ds) return tb.replaceChildren();
  let modes = ds.colorModes || DEFAULT_COLOR_MODES;
  if (Object.keys(modes).length < 2) modes = colorModesOf(ds); // RGB-only data: offer Height as the second look
  tb.replaceChildren(...[ // filter: replaceChildren would print switched-off (null) items as "null"
    seg(Object.entries(modes).map(([k, m]) => [k, m.label]), S.colorKey, setColor, { className: 'seg tb-seg' }),
    popBtn('nav', NAV_LABEL[S.nav] + (S.ortho ? ' · Ortho' : ''), 'Navigation, projection and views'),
    popBtn('display', '◐ Display', 'X-ray, eye-dome lighting, point size'),
    isTouch || !UI.measure ? null : popBtn('measure', '⟷ Measure', 'Distance, height, area, point (M)', tools.inserting != null || tools.count(state.activeId) > 0),
    toggle('✦ Clean', S.clean, () => { ev('clean', { on: !S.clean }); setClean(!S.clean); }, ds.skyFilter ? 'Hide stray points and sky-colored fringe on edges' : ds.speckle ? 'Hide stray points and mis-colored speckle' : 'Hide stray points (noise below ground and in the air)'),
    !UI.image ? null : el('button', { className: 'tb', title: 'Save a screenshot (PNG)', ariaLabel: 'Save a screenshot', onclick: () => { ev('screenshot'); screenshot(viewer, `${ds.id}-view`).then(() => toast('Screenshot saved')); } }, ...tbLabel('⤓ Image')),
    !UI.share ? null : el('button', { className: 'tb', title: 'Copy a link to exactly this view (includes measurements)', ariaLabel: 'Share this view', onclick: share }, ...tbLabel('↗ Share')),
    !UI.advanced ? null : toggle('⚙', state.advanced, () => { state.advanced = !state.advanced; if (state.advanced) ev('advanced_open'); renderAll(); }, 'Advanced controls'),
  ].filter(Boolean));
  const hint = $('#hint');
  hint.textContent = tools.inserting ? ''
    : S.nav === 'fly' ? 'WASD move · E/Q up/down · drag to look · scroll = speed · Shift boost · G to exit'
    : S.nav === 'pan' ? 'Drag to pan · scroll zoom to cursor · right-drag rotate'
    : isTouch ? 'Drag to orbit · pinch to zoom · two-finger drag to pan'
      : 'Drag to orbit · right-drag pan · scroll zoom · double-click to dive in · G to fly';
  renderPop();
}

// ---------- toolbar pop-overs ----------
const NAV_LABEL = { orbit: '⟲ Orbit', fly: '✈ Fly', pan: '✋ Pan' };
// "⟲ Orbit" -> icon + label; phones show only the icon (style.css .lbl), so the toolbar fits on 1-2 rows.
const tbLabel = (label) => { const [icon, ...rest] = label.split(' '); return [el('span', { className: 'ic', textContent: icon }), el('span', { className: 'lbl', textContent: ' ' + rest.join(' ') })]; };
function popBtn(id, label, title, active = false) {
  const b = el('button', { className: 'tb pop-btn', title, ariaLabel: title, onclick: (e) => { e.stopPropagation(); state.pop = state.pop === id ? null : id; renderToolbar(); } },
    ...tbLabel(label), el('span', { className: 'caret', textContent: ' ⌃' }));
  b.setAttribute('aria-pressed', String(state.pop === id || active));
  b.dataset.pop = id;
  return b;
}
function renderPop() {
  const pop = $('#pop');
  const close = () => { state.pop = null; renderToolbar(); };
  if (!state.pop || !activeDs()) return pop.replaceChildren();
  const rows = [];
  if (state.pop === 'nav') {
    rows.push(el('div', { className: 'row-label', textContent: 'Navigation' }),
      seg([['orbit', '⟲ Orbit', 'Drag to rotate around a point'], ...(isTouch ? [] : [['fly', '✈ Fly', 'G — WASD + mouse look']]), ['pan', '✋ Pan', 'Drag the ground like a map']], S.nav, (k) => setNav(k)),
      el('div', { className: 'row-label', textContent: 'Projection' }),
      seg([[false, 'Perspective'], [true, 'Orthographic', 'O — no perspective: true-scale plans and elevations']], S.ortho, setOrtho),
      el('div', { className: 'row-label', textContent: 'Look from' }),
      el('div', { className: 'chips' }, ...VIEWS.map(([n, d]) => el('button', { className: 'chip', textContent: n, onclick: () => snapView(d) })),
        el('button', { className: 'chip', textContent: 'Reset', title: 'Back to the dataset’s opening view', onclick: () => { const ds = activeDs(); if (ds.camera) flyTo(ds.camera); } })));
  } else if (state.pop === 'display') {
    rows.push(
      el('div', { className: 'row-label', textContent: 'Render' }),
      seg([[false, 'Solid'], [true, 'X-ray', 'X — see through surfaces']], S.xray, setXray),
      S.xray ? slider('Opacity', { min: 0.01, max: 0.3, step: 0.005, value: S.xrayOpacity, fmt: (v) => (v * 100).toFixed(1) + '%', onInput: (v) => { S.xrayOpacity = v; applySettings(); } }) : null,
      seg([[true, 'EDL on', 'Eye-dome lighting: shades edges for depth'], [false, 'EDL off']], S.edl, (k) => { S.edl = k; applySettings(); renderAll(); }, { disabled: S.xray }),
      slider('Point size', { min: 0.2, max: 4, step: 0.1, value: S.pointSize, fmt: (v) => v.toFixed(1), onInput: (v) => { S.pointSize = v; applySettings(); } }),
      el('button', { className: 'link', textContent: 'More in Advanced ⚙', onclick: () => { state.advanced = true; close(); renderPanel(); } }));
  } else if (state.pop === 'measure') {
    rows.push(el('div', { className: 'tools' }, ...Object.entries(KINDS).map(([k, d]) => {
      const b = el('button', { className: 'tool', title: d.label, onclick: () => { tools.start(k); close(); } }, el('span', { textContent: d.icon }), d.label);
      b.setAttribute('aria-pressed', String(tools.inserting === k));
      return b;
    })),
    el('div', { className: 'm-row' },
      el('button', { className: 'chip', textContent: '↶ Undo', disabled: !tools.canUndo, onclick: () => tools.undo() }),
      el('button', { className: 'chip', textContent: '↷ Redo', disabled: !tools.canRedo, onclick: () => tools.redo() }),
      el('button', { className: 'chip danger', textContent: `Clear all${tools.count(state.activeId) ? ` (${tools.count(state.activeId)})` : ''}`, disabled: !tools.count(state.activeId), onclick: () => tools.clear() })),
    el('div', { className: 'help', textContent: 'Drag a placed marker to adjust it. Share links include your measurements.' }));
  }
  pop.replaceChildren(...rows.filter(Boolean));
  // Sit above the button that opened it.
  const btn = document.querySelector(`#toolbar [data-pop="${state.pop}"]`);
  if (btn) {
    const b = btn.getBoundingClientRect(), w = pop.offsetWidth;
    pop.style.left = Math.max(16, Math.min(innerWidth - w - 16, b.left + b.width / 2 - w / 2)) + 'px';
    pop.style.bottom = innerHeight - b.top + 10 + 'px';
  }
}
document.addEventListener('pointerdown', (e) => {
  if (state.pop && !e.target.closest('#pop, .pop-btn')) { state.pop = null; renderToolbar(); }
});

// ---------- advanced panel ----------
function renderPanel() {
  const ds = activeDs();
  const panel = $('#panel');
  if (!ds || !state.advanced) return panel.replaceChildren();
  const modes = colorModesOf(ds);
  const i = info.get(ds.id);
  const [zMin, zMax] = i ? [i.zMin, i.zMax] : [0, 1];
  const band = S.zBand || [zMin, zMax];
  const vox = voxelOptions();
  const voxIdx = vox.findIndex((o) => o.level === S.voxelLevel);
  const rerender = () => { applySettings(); renderAll(); };
  const hasRefl = !!(ds.colorModes || DEFAULT_COLOR_MODES).reflectivity;

  const colorRows = S.colorKey === 'reflectivity' ? [
    slider('Range max', { min: 5, max: 255, step: 1, value: S.refl.range[1], onInput: (v) => { S.refl.range = [S.refl.range[0], v]; applySettings(); } }),
    slider('Range min', { min: 0, max: 100, step: 1, value: S.refl.range[0], onInput: (v) => { S.refl.range = [v, S.refl.range[1]]; applySettings(); } }),
    slider('Gamma', { min: 0.3, max: 3, step: 0.05, value: S.refl.gamma, fmt: (v) => v.toFixed(2), onInput: (v) => { S.refl.gamma = v; applySettings(); } }),
  ] : S.colorKey === 'rgb' ? [
    slider('Gamma', { min: 0.3, max: 3, step: 0.05, value: S.rgb.gamma, fmt: (v) => v.toFixed(2), onInput: (v) => { S.rgb.gamma = v; applySettings(); } }),
    slider('Brightness', { min: -0.5, max: 0.5, step: 0.01, value: S.rgb.brightness, fmt: (v) => v.toFixed(2), onInput: (v) => { S.rgb.brightness = v; applySettings(); } }),
    slider('Contrast', { min: -0.5, max: 0.5, step: 0.01, value: S.rgb.contrast, fmt: (v) => v.toFixed(2), onInput: (v) => { S.rgb.contrast = v; applySettings(); } }),
  ] : [el('div', { className: 'help', textContent: 'Height colors follow the Cleaning height band.' })];

  panel.replaceChildren(
    el('div', { className: 'panel-head' }, el('strong', { textContent: 'Advanced' }),
      el('button', { className: 'icon', title: 'Close', textContent: '✕', onclick: () => { state.advanced = false; renderPanel(); renderToolbar(); } })),
    section('view', 'View',
      slider('FOV', { min: 30, max: 100, step: 1, value: S.fov, fmt: (v) => v + '°', onInput: (v) => { S.fov = v; applySettings(); } }),
      seg([['black', 'Black'], ['gradient', 'Gradient'], ['white', 'White']], S.background, (k) => { S.background = k; rerender(); }),
      el('div', { className: 'row-label', textContent: 'Resolution' }),
      seg([['auto', 'Auto', 'Sharpest the device keeps smooth'], ['1', 'Standard'], ...(RES_MAX >= 1.5 ? [['1.5', '1.5×']] : []), ...(RES_MAX >= 2 ? [['2', 'Retina 2×']] : [])],
        String(S.res), (k) => { S.res = k === 'auto' ? 'auto' : k; if (k !== 'auto') setScale(Number(k)); else res.lastChange = 0; rerender(); }),
      el('div', { className: 'speed', id: 'speed', hidden: S.nav !== 'fly' }),
    ),
    section('color', 'Color',
      seg(Object.entries(modes).map(([k, m], n) => [k, m.label, String(n + 1)]), S.colorKey, setColor),
      ...colorRows,
    ),
    section('points', 'Points',
      slider('Size', { min: 0.2, max: 4, step: 0.1, value: S.pointSize, fmt: (v) => v.toFixed(1), onInput: (v) => { S.pointSize = v; applySettings(); } }),
      seg([['ADAPTIVE', 'Adaptive'], ['FIXED', 'Fixed'], ['ATTENUATED', 'Attenuated']], S.sizeType, (k) => { S.sizeType = k; rerender(); }),
      seg([['SQUARE', 'Square'], ['CIRCLE', 'Circle'], ['PARABOLOID', 'Paraboloid']], S.shape, (k) => { S.shape = k; rerender(); }),
      slider('Voxel size', {
        min: 0, max: vox.length, step: 1, value: voxIdx === -1 ? vox.length : voxIdx,
        fmt: (n) => (n >= vox.length ? 'full' : fmtSize(vox[n].size)),
        onInput: (n) => { S.voxelLevel = n >= vox.length ? Infinity : vox[n].level; applySettings(); },
        title: 'Coarsest spacing drawn: caps the octree depth (a runtime voxel grid)',
      }),
      slider('Point budget', { min: 1, max: 30, step: 1, value: S.budgetM, fmt: (v) => v + 'M', onInput: (v) => { S.budgetM = v; applySettings(); } }),
      slider('LOD threshold', { min: 4, max: 80, step: 1, value: S.lodPx, fmt: (v) => v + ' px', onInput: (v) => { S.lodPx = v; applySettings(); }, title: 'Lower = refine sooner (more detail, more load)' }),
    ),
    section('cleaning', 'Cleaning',
      el('div', { className: 'row-label', textContent: 'Noise (classified)' }),
      seg([['show', 'Show'], ['hide', 'Hide'], ['only', 'Only noise']], S.noise, (k) => { S.noise = k; rerender(); }, { disabled: !ds.noiseClassified }),
      ds.noiseClassified ? null : el('div', { className: 'help', textContent: 'No noise classification in this dataset yet; Clean uses the height band.' }),
      slider('Height max', { min: zMin, max: zMax, step: 0.1, value: band[1], fmt: fmtM, onInput: (v) => { S.zBand = [Math.min(band[0], v), v]; band[1] = v; applySettings(); } }),
      slider('Height min', { min: zMin, max: zMax, step: 0.1, value: band[0], fmt: fmtM, onInput: (v) => { S.zBand = [v, Math.max(band[1], v)]; band[0] = v; applySettings(); } }),
      !hasRefl ? null : slider('Refl. min', { min: 0, max: 100, step: 1, value: S.reflFilter[0], onInput: (v) => { S.reflFilter = [v, S.reflFilter[1]]; applySettings(); }, title: 'Hide low-reflectivity points (dust, rain, edge speckle)' }),
      !hasRefl ? null : slider('Refl. max', { min: 1, max: 255, step: 1, value: S.reflFilter[1], onInput: (v) => { S.reflFilter = [S.reflFilter[0], v]; applySettings(); }, title: 'Hide high-reflectivity points (retroreflector blooming)' }),
      !ds.speckle ? null : slider('Speckle', { min: 0, max: 100, step: 1, value: S.speckle, fmt: (v) => (v ? v + '%' : 'off'), onInput: (v) => { S.speckle = v; applySettings(); }, title: 'Hide points whose color is much brighter than their surroundings (mis-colored edges, glints)' }),
      !ds.skyFilter ? null : slider('Sky fringe', { min: 0, max: 100, step: 1, value: S.skyCut, fmt: (v) => (v ? v + '%' : 'off'), onInput: (v) => { S.skyCut = v; applySettings(); }, title: 'Hide points on tree/roof edges that picked up sky color during colorization' }),
      el('button', { className: 'link', textContent: 'Reset cleaning', onclick: () => { S.reflFilter = [0, 255]; setClean(false); } }),
    ),
    section('lighting', 'Lighting',
      seg([[true, 'EDL on'], [false, 'EDL off']], S.edl, (k) => { S.edl = k; rerender(); }),
      slider('EDL strength', { min: 0, max: 5, step: 0.05, value: S.edlStrength, fmt: (v) => v.toFixed(2), onInput: (v) => { S.edlStrength = v; applySettings(); } }),
      slider('EDL radius', { min: 0.5, max: 4, step: 0.05, value: S.edlRadius, fmt: (v) => v.toFixed(2), onInput: (v) => { S.edlRadius = v; applySettings(); } }),
    ),
    el('div', { className: 'footer' },
      el('button', { className: 'link', textContent: 'Copy settings', title: 'JSON for a datasets.json preset', onclick: () => {
        const out = { ...S, voxelLevel: Number.isFinite(S.voxelLevel) ? S.voxelLevel : null };
        navigator.clipboard?.writeText(JSON.stringify(out)).then(() => toast('Settings copied')).catch(() => {});
      } }),
      el('button', { className: 'link', textContent: 'Reset all', onclick: () => {
        const keep = { nav: S.nav, colorKey: S.colorKey };
        Object.assign(S, structuredClone(DEFAULTS), keep);
        S.budgetM = budgetFor(activeDs());
        setClean(true);
      } }),
    ),
  );
}

function renderSwitcher() {
  const live = datasets.filter((d) => d.url);
  const sw = $('#switcher');
  // A lone dataset doesn't need a switcher; placeholders only show once there are 2+ real datasets.
  if (!UI.switcher || live.length < 2) return sw.replaceChildren();
  sw.replaceChildren(...live.map((ds) => { // url:null placeholders stay out of the UI
    const thumb = ds.thumbnail ? el('img', { src: ds.thumbnail, alt: '' }) : el('span', { className: 'ph' });
    thumb.onerror = () => thumb.replaceWith(el('span', { className: 'ph' }));
    const b = el('button', { disabled: !ds.url, onclick: () => switchTo(ds.id) }, thumb, ds.name);
    b.setAttribute('aria-pressed', String(ds.id === state.activeId));
    return b;
  }));
}

// ---------- phone layout ----------
// Phones: the dataset switcher joins the bottom column (above the toolbar) instead of floating over it,
// and --bottom-h tracks that column's height so the switcher (desktop), pop-ups and the loading pill sit
// just above it whatever its height (toolbar wrapping, hint, tour card).
const phoneMQ = matchMedia('(max-width: 640px)');
function placeSwitcher() {
  const sw = $('#switcher');
  if (phoneMQ.matches) $('#bottom').insertBefore(sw, $('#toolbar'));
  else if (sw.parentElement !== document.body) document.body.append(sw);
}
phoneMQ.addEventListener('change', placeSwitcher);
placeSwitcher();
const setBottomH = () => document.documentElement.style.setProperty('--bottom-h', $('#bottom').offsetHeight + 'px');
new ResizeObserver(setBottomH).observe($('#bottom'));

// ---------- two-finger touch: pinch to zoom AND drag to pan ----------
// Potree's orbit controls only zoom with two fingers (panning needs three). Add the standard 3D-viewer
// gesture: the midpoint of two fingers moves the view, using the same pan path as Potree's 3-finger pan.
{
  // Potree's pan (plus its glide after release) moves the scene ~2.3x the finger travel; PAN_K brings the
  // point under the fingers back to ~1:1 (measured with synthetic touches).
  const PAN_K = 0.45;
  let prevMid = null;
  const mid = (t) => [(t[0].pageX + t[1].pageX) / 2, (t[0].pageY + t[1].pageY) / 2];
  const oc = viewer.orbitControls;
  oc.addEventListener('touchstart', (e) => { prevMid = e.touches.length === 2 ? mid(e.touches) : null; });
  oc.addEventListener('touchend', (e) => { prevMid = e.touches.length === 2 ? mid(e.touches) : null; });
  oc.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2) { prevMid = null; return; }
    const m = mid(e.touches);
    if (prevMid) {
      const el = viewer.renderer.domElement;
      oc.panDelta.x += PAN_K * (m[0] - prevMid[0]) / el.clientWidth;
      oc.panDelta.y += PAN_K * (m[1] - prevMid[1]) / el.clientHeight;
    }
    prevMid = m;
  });
}

function renderAll() { renderInfo(); renderToolbar(); renderPanel(); renderSwitcher(); renderLegend(); document.body.classList.toggle('adv', state.advanced); setBottomH(); }

// ---------- keys ----------
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input,textarea,select')) return;
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { tools.cancel(); if (state.pop) { state.pop = null; renderToolbar(); } }
  else if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); e.shiftKey ? tools.redo() : tools.undo(); }
  else if (e.metaKey || e.ctrlKey || e.altKey) return;
  else if (k === 'g') setNav(S.nav === 'fly' ? 'orbit' : 'fly');
  else if (k === 'm' && !isTouch && UI.measure) tools.start('distance');
  else if (k === 'o') setOrtho(!S.ortho);
  else if (k === 'x') setXray(!S.xray);
  else if (k === 't') snapView([0, 0, 1]);
  else if (/^[1-9]$/.test(k)) { const keys = Object.keys(colorModesOf(activeDs() || {})); if (keys[k - 1]) setColor(keys[k - 1]); }
  else if (k === 'n' && activeDs()?.noiseClassified) { S.noise = { show: 'hide', hide: 'only', only: 'show' }[S.noise]; applySettings(); renderAll(); }
  else if (k === 'p') {
    const v = viewer.scene.view, r = (a) => a.map((x) => Math.round(x * 100) / 100);
    const vp = { name: 'New viewpoint', position: r(v.position.toArray()), target: r(v.getPivot().toArray()) };
    console.log(JSON.stringify(vp));
    navigator.clipboard?.writeText(JSON.stringify(vp)).then(() => toast('Viewpoint JSON copied')).catch(() => {});
  } else if (S.nav === 'fly' && (e.key === 'Shift' || e.key === 'Control') && state.boost === 1) {
    state.boost = e.key === 'Shift' ? 4 : 0.25;
    state.baseSpeed = viewer.getMoveSpeed();
    viewer.setMoveSpeed(state.baseSpeed * state.boost);
  }
});
function endBoost() {
  if (state.boost === 1) return;
  viewer.setMoveSpeed(state.baseSpeed);
  state.boost = 1; state.baseSpeed = null;
}
addEventListener('keyup', (e) => {
  if ((e.key === 'Shift' && state.boost === 4) || (e.key === 'Control' && state.boost === 0.25)) endBoost();
});
addEventListener('blur', endBoost);

// ---------- "Refining detail…" ----------
// Shown while detail for the current view streams in (after 300 ms of loading; hidden after 800 ms idle),
// so a coarse view reads as in progress. Background prefetch for the tour doesn't count.
const loadingEl = $('#loading');
let ldBusySince = null, ldIdleSince = null;
function loadingTick(now) {
  const busy = Potree.numNodesLoading > 0 && !pfStop;
  if (busy) { ldIdleSince = null; ldBusySince ??= now; } else { ldBusySince = null; ldIdleSince ??= now; }
  if (busy && now - ldBusySince > 300) loadingEl.hidden = false;
  else if (!busy && now - ldIdleSince > 800) loadingEl.hidden = true;
}

// ---------- per-frame ----------
const statsEl = $('#stats');
if (params.has('stats')) statsEl.hidden = false;
let frames = 0, last = performance.now(), fps = 0, firstPixels = null;
viewer.addEventListener('update', () => {
  const now = performance.now();
  resTick(now - lastT, now);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  tour.tick(dt);
  loadingTick(now);
  if (state.autoOrbit) { // circle the camera around its pivot, ~100 s per revolution
    const v = viewer.scene.view, p = v.getPivot(), a = dt * 0.06;
    const dx = v.position.x - p.x, dy = v.position.y - p.y;
    v.position.x = p.x + dx * Math.cos(a) - dy * Math.sin(a);
    v.position.y = p.y + dx * Math.sin(a) + dy * Math.cos(a);
    v.lookAt(p);
  }
  tools.tick();
  gizmo.update();
  if (S.nav === 'fly') { const s = $('#speed'); if (s) s.textContent = `fly speed ${viewer.getMoveSpeed().toFixed(1)} / ${maxSpeed()} m/s`; }
  if (statsEl.hidden) return;
  frames++;
  const pts = viewer.scene.pointclouds.filter((p) => p.visible).reduce((s, p) => s + (p.numVisiblePoints || 0), 0);
  if (firstPixels === null && pts > 0) firstPixels = now - T0;
  if (now - last >= 500) { fps = (frames * 1000) / (now - last); frames = 0; last = now; }
  statsEl.textContent = `fps ${fps.toFixed(0)}\npoints ${(pts / 1e6).toFixed(2)}M / ${(viewer.getPointBudget() / 1e6).toFixed(1)}M\nfirst pixels ${firstPixels ? (firstPixels / 1000).toFixed(2) + ' s' : '…'}\nresolution ${viewer.scaleFactor}x (${S.res})`;
});

// Share links pasted into an already-open viewer only change the hash (no reload): apply them.
addEventListener('hashchange', async () => {
  const h = parseHash();
  if (h.id && h.id !== state.activeId) { await switchTo(h.id, { cam: h.cam, color: h.color }); if (h.m) tools.decode(h.id, h.m); if (h.tour) startTour(); return; }
  if (h.tour) { startTour(); return; }
  if (h.color && colorModesOf(activeDs())[h.color]) setColor(h.color);
  if (h.cam) { stopAutoOrbit(); viewer.scene.view.setView(h.cam.position, h.cam.target, 0); }
  if (h.m) tools.decode(state.activeId, h.m);
});

const fromHash = parseHash();
const initial = datasets.find((d) => d.id === fromHash.id && d.url)?.id || cfg.default;
await switchTo(initial, { cam: fromHash.cam, color: fromHash.color });
if (fromHash.m && fromHash.id === initial) tools.decode(initial, fromHash.m);
if (fromHash.tour && fromHash.id === initial) startTour();

for (const ds of datasets) if (ds.url && ds.id !== initial) load(ds).then(applySettings).catch(console.warn);
