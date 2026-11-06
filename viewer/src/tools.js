// Measurements (Potree MeasuringTool + our readout, undo/redo, share-link codec),
// the XYZ axis gizmo, and screenshots.

const KINDS = {
  distance: { label: 'Distance', icon: '↔', min: 2, args: { showDistances: true, maxMarkers: 2 } },
  path: { label: 'Path', icon: '〰', min: 2, args: { showDistances: true, maxMarkers: Infinity } },
  height: { label: 'Height', icon: '↕', min: 2, args: { showDistances: false, showHeight: true, maxMarkers: 2 } },
  area: { label: 'Area', icon: '▱', min: 3, args: { showDistances: true, showArea: true, closed: true, maxMarkers: Infinity } },
  point: { label: 'Point', icon: '⌖', min: 1, args: { showDistances: false, showCoordinates: true, maxMarkers: 1 } },
};
const CODE = { distance: 'd', path: 'p', height: 'h', area: 'a', point: 'x' };
const KIND_OF = Object.fromEntries(Object.entries(CODE).map(([k, c]) => [c, k]));

export { KINDS };

export function createTools({ viewer, el, toast, activeId, onChange, onMeasure }) {
  const scene = () => viewer.scene;
  const list = []; // { id, ds, kind, m }
  let seq = 0;
  let ins = null; // measurement being inserted
  const undoStack = [], redoStack = [];

  // ---------- create / remove ----------
  function build(kind, ds, pts) {
    const k = KINDS[kind];
    const m = new Potree.Measure();
    const a = { showDistances: true, showArea: false, showHeight: false, showCoordinates: false, closed: false, ...k.args };
    m.showDistances = a.showDistances; m.showArea = a.showArea; m.showHeight = a.showHeight;
    m.showCoordinates = a.showCoordinates; m.closed = a.closed; m.maxMarkers = a.maxMarkers;
    for (const p of pts) m.addMarker([...p]);
    return m;
  }

  function attach(item) {
    scene().addMeasurement(item.m);
    item.m.visible = item.ds === activeId();
    list.push(item);
  }
  function detach(item) {
    scene().removeMeasurement(item.m);
    const i = list.indexOf(item); if (i >= 0) list.splice(i, 1);
  }
  const ptsOf = (m) => m.points.map((p) => p.position.toArray());
  const snapshot = (item) => ({ id: item.id, ds: item.ds, kind: item.kind, pts: ptsOf(item.m) });
  const restore = (s) => { const item = { id: s.id, ds: s.ds, kind: s.kind, m: build(s.kind, s.ds, s.pts) }; attach(item); return item; };

  function record(op) { undoStack.push(op); redoStack.length = 0; changed(); }
  function changed() { renderCard(); onChange?.(); }

  // ---------- insertion ----------
  function start(kind) {
    cancel();
    const k = KINDS[kind];
    const m = viewer.measuringTool.startInsertion({ ...k.args, name: k.label });
    ins = { kind, m, ds: activeId() };
    changed();
  }
  // Polled each frame: Potree ends insertion by dropping the last dragged marker.
  function tick() {
    if (ins && !viewer.inputHandler.drag) finish();
    if (list.length) refreshValues();
  }
  function finish() {
    const { kind, m, ds } = ins; ins = null;
    if (m.points.length < KINDS[kind].min) { scene().removeMeasurement(m); changed(); return; }
    const item = { id: ++seq, ds, kind, m };
    list.push(item); item.m.visible = true;
    record({ type: 'add', items: [snapshot(item)] });
    onMeasure?.(kind);
  }
  function cancel() {
    if (!ins) return;
    const { kind, m } = ins;
    viewer.dispatchEvent({ type: 'cancel_insertions' });
    viewer.inputHandler.drag = null;
    // Escape mid-polygon keeps what was placed (minus the floating marker) if it's still valid.
    if (KINDS[kind].args.maxMarkers === Infinity && m.points.length - 1 >= KINDS[kind].min) {
      m.removeMarker(m.points.length - 1);
      finish();
    } else {
      scene().removeMeasurement(m); ins = null; changed();
    }
  }

  function remove(item) { const s = snapshot(item); detach(item); record({ type: 'remove', items: [s] }); }
  function clear() {
    cancel();
    const mine = list.filter((i) => i.ds === activeId());
    if (!mine.length) return;
    const snaps = mine.map(snapshot); mine.forEach(detach);
    record({ type: 'remove', items: snaps });
  }
  function apply(op, dir) {
    const adding = (op.type === 'add') === (dir === 'redo');
    if (adding) op.items.forEach(restore);
    else for (const s of op.items) { const it = list.find((i) => i.id === s.id); if (it) detach(it); }
  }
  function undo() { cancel(); const op = undoStack.pop(); if (!op) return; apply(op, 'undo'); redoStack.push(op); changed(); }
  function redo() { const op = redoStack.pop(); if (!op) return; apply(op, 'redo'); undoStack.push(op); changed(); }

  function showDataset(id) {
    cancel();
    for (const i of list) i.m.visible = i.ds === id;
    changed();
  }

  // ---------- values ----------
  const f2 = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  function values(item) {
    const p = ptsOf(item.m);
    if (item.kind === 'point') return [['X', f2(p[0][0])], ['Y', f2(p[0][1])], ['Z', f2(p[0][2])]];
    if (item.kind === 'distance' || item.kind === 'height') {
      const d = sub(p[1], p[0]), ground = Math.hypot(d[0], d[1]);
      const slope = (Math.atan2(Math.abs(d[2]), ground) * 180) / Math.PI;
      const rows = item.kind === 'height'
        ? [['Height', f2(Math.abs(d[2])) + ' m', true], ['3D', f2(len(d)) + ' m'], ['Ground', f2(ground) + ' m']]
        : [['3D', f2(len(d)) + ' m', true], ['Ground', f2(ground) + ' m'], ['Slope', slope.toFixed(1) + '°']];
      return [...rows, ['ΔX', f2(d[0])], ['ΔY', f2(d[1])], ['ΔZ', f2(d[2])]];
    }
    let total = 0, ground = 0;
    const n = p.length, closed = item.kind === 'area';
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const d = sub(p[(i + 1) % n], p[i]); total += len(d); ground += Math.hypot(d[0], d[1]);
    }
    if (item.kind === 'path') {
      const d = sub(p[n - 1], p[0]);
      return [['3D length', f2(total) + ' m', true], ['Ground', f2(ground) + ' m'], ['ΔX', f2(d[0])], ['ΔY', f2(d[1])], ['ΔZ', f2(d[2])]];
    }
    // Area: plan (footprint) from Potree; 3D = vector area of the polygon (Newell), i.e. its true tilted area.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const zs = p.map((q) => q[2]);
    return [['Plan area', f2(item.m.getArea()) + ' m²', true], ['3D area', f2(Math.hypot(nx, ny, nz) / 2) + ' m²'],
      ['Perimeter', f2(total) + ' m'], ['Z range', f2(Math.max(...zs) - Math.min(...zs)) + ' m']];
  }
  const textOf = (item, n) => `${KINDS[item.kind].label} ${n}: ` + values(item).map(([k, v]) => `${k} ${v}`).join(', ');

  // ---------- readout card ----------
  const card = document.querySelector('#measures');
  let sig = '';
  function refreshValues() {
    const s = list.filter((i) => i.ds === activeId()).map((i) => JSON.stringify(ptsOf(i.m))).join('|');
    if (s !== sig) renderCard();
  }
  function renderCard() {
    const mine = list.filter((i) => i.ds === activeId());
    sig = mine.map((i) => JSON.stringify(ptsOf(i.m))).join('|');
    if (!mine.length && !ins) return card.replaceChildren();
    const counters = {};
    const rows = mine.map((item) => {
      const n = (counters[item.kind] = (counters[item.kind] || 0) + 1);
      return el('div', { className: 'm-item' },
        el('div', { className: 'm-head' },
          el('span', { className: 'm-name', textContent: `${KINDS[item.kind].icon} ${KINDS[item.kind].label} ${n}` }),
          el('button', { className: 'icon', title: 'Copy values', textContent: '⧉', onclick: () => {
            navigator.clipboard?.writeText(textOf(item, n)).then(() => toast('Copied')).catch(() => {});
          } }),
          el('button', { className: 'icon', title: 'Delete', textContent: '✕', onclick: () => remove(item) })),
        el('dl', {}, ...values(item).flatMap(([k, v, main]) => [el('dt', { textContent: k }), el('dd', { textContent: v, className: main ? 'main' : '' })])));
    });
    card.replaceChildren(
      el('div', { className: 'm-top' },
        el('strong', { textContent: 'Measurements' }),
        el('span', { className: 'm-actions' },
          el('button', { className: 'icon', title: 'Undo (⌘Z)', textContent: '↶', disabled: !undoStack.length, onclick: undo }),
          el('button', { className: 'icon', title: 'Redo (⇧⌘Z)', textContent: '↷', disabled: !redoStack.length, onclick: redo }),
          el('button', { className: 'icon', title: 'Clear all', textContent: 'Clear', disabled: !mine.length, onclick: clear }))),
      ...[ins ? el('div', { className: 'm-hint', textContent: hintFor(ins.kind) }) : null, ...rows].filter(Boolean));
  }
  function hintFor(kind) {
    const k = KINDS[kind];
    if (k.args.maxMarkers === 1) return 'Click a point · Esc to cancel';
    if (k.args.maxMarkers === 2) return 'Click two points · Esc to cancel';
    return 'Click to add points · right-click or Esc to finish';
  }

  // ---------- share-link codec: "d:x,y,z;x,y,z~a:..." ----------
  const r2 = (v) => Math.round(v * 100) / 100;
  function encode(ds) {
    return list.filter((i) => i.ds === ds)
      .map((i) => CODE[i.kind] + ':' + ptsOf(i.m).map((p) => p.map(r2).join(',')).join(';')).join('~');
  }
  function decode(ds, s) {
    if (!s) return;
    for (const it of list.filter((i) => i.ds === ds)) detach(it);
    for (const part of s.split('~')) {
      const [c, body] = part.split(':'); const kind = KIND_OF[c];
      if (!kind || !body) continue;
      const pts = body.split(';').map((t) => t.split(',').map(Number)).filter((p) => p.length === 3 && p.every(Number.isFinite));
      if (pts.length < KINDS[kind].min) continue;
      restore({ id: ++seq, ds, kind, pts });
    }
    for (const i of list) i.m.visible = i.ds === activeId();
    changed();
  }
  const count = (ds) => list.filter((i) => i.ds === ds).length;

  return {
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    start, cancel, undo, redo, clear, tick, showDataset, encode, decode, count, renderCard,
    get inserting() { return ins?.kind || null; },
  };
}

// ---------- axis gizmo (top-right): click an axis to look along it ----------
export function createGizmo(host, viewer, onSnap) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-50 -50 100 100');
  host.append(svg);
  const AX = [['X', [1, 0, 0], '#ff5a5a'], ['Y', [0, 1, 0], '#5ad46a'], ['Z', [0, 0, 1], '#5a9bff']];
  const nodes = [];
  for (const [name, v, col] of AX) {
    for (const neg of [false, true]) {
      const g = document.createElementNS(NS, 'g');
      g.style.cursor = 'pointer';
      const line = document.createElementNS(NS, 'line'); line.setAttribute('stroke', col); line.setAttribute('stroke-width', neg ? 1.5 : 3);
      const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', neg ? 5 : 9); c.setAttribute('fill', neg ? 'none' : col); c.setAttribute('stroke', col); c.setAttribute('stroke-width', 2);
      const t = document.createElementNS(NS, 'text'); t.textContent = neg ? '' : name; t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('font-size', 11); t.setAttribute('font-weight', 700); t.setAttribute('fill', '#0b0d10');
      g.append(line, c, t);
      const title = document.createElementNS(NS, 'title'); title.textContent = `View from ${neg ? '−' : '+'}${name}`; g.append(title);
      const dir = v.map((x) => (neg ? -x : x));
      g.addEventListener('click', () => onSnap(dir));
      svg.append(g);
      nodes.push({ g, line, c, t, dir });
    }
  }
  function update() {
    const cam = viewer.scene.getActiveCamera();
    const e = cam.matrixWorldInverse.elements; // column-major; rotation part
    for (const n of nodes) {
      const [x, y, z] = n.dir;
      const vx = e[0] * x + e[4] * y + e[8] * z, vy = e[1] * x + e[5] * y + e[9] * z, vz = e[2] * x + e[6] * y + e[10] * z;
      const px = vx * 34, py = -vy * 34;
      n.line.setAttribute('x1', 0); n.line.setAttribute('y1', 0); n.line.setAttribute('x2', px); n.line.setAttribute('y2', py);
      for (const k of [n.c, n.t]) { k.setAttribute(k === n.c ? 'cx' : 'x', px); k.setAttribute(k === n.c ? 'cy' : 'y', py); }
      n.depth = vz;
    }
    nodes.sort((a, b) => a.depth - b.depth).forEach((n) => svg.append(n.g)); // nearer drawn last
  }
  return { update };
}

// ---------- screenshot: grab the canvas right after a frame renders ----------
export function screenshot(viewer, name) {
  return new Promise((resolve) => {
    const grab = () => {
      viewer.removeEventListener('render.pass.end', grab);
      const a = document.createElement('a');
      a.href = viewer.renderer.domElement.toDataURL('image/png');
      a.download = `${name}.png`;
      a.click();
      resolve();
    };
    viewer.addEventListener('render.pass.end', grab);
  });
}
