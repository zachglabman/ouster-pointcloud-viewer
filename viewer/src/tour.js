// Guided tour: flies the camera through a dataset's `tour` stops (datasets.json), with a caption at each.
//   "tour": [{ "name": "...", "chip": "spec pill", "caption": "...", "position": [x,y,z], "target": [x,y,z], "hold": 6 }, ...]
// Motion: each leg eases in/out (smootherstep) on both camera position and look-at target, with a lift
// on long legs so the camera arcs over the scene instead of cutting through it. At each stop the camera
// drifts in a slow orbit while the caption is up. Any pointer/wheel/key input on the scene ends the tour
// and leaves the visitor where the camera is (the orbit pivot is the current stop's target).
// Bandwidth goes where the camera is heading: during a flight the destination's nodes are requested first
// (onPrefetch); once a stop has loaded, the next stop's. A stop never moves on before it has loaded (25 s cap).

const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function createTour({ viewer, el, root, onEvent = () => {}, onEnd = () => {}, onPrefetch = () => {}, viewFull = () => false }) {
  let stops = null, i = 0, phase = 'idle', t = 0, legDur = 0, from = null, paused = false, dsId = null;
  let wait = 0, quiet = 0, loaded = false, settleAt = 0;

  const view = () => viewer.scene.view;
  const cur = () => {
    const v = view();
    return { position: v.position.toArray(), target: v.getPivot().toArray() };
  };
  function place(pos, tgt) {
    const v = view();
    v.position.set(...pos);
    v.lookAt(...tgt);
  }

  function legTo(k) {
    i = k; from = cur(); t = 0; onPrefetch(null);
    const d = Math.max(dist(from.position, stops[k].position), dist(from.target, stops[k].target) * 0.7);
    legDur = Math.min(9, Math.max(3, 1.6 + d / 70));         // seconds: ~3 s nearby, up to 9 s across a site
    phase = 'fly';
    render();
  }

  function start(ds, at = 0) {
    if (!ds?.tour?.length) return;
    stops = ds.tour; dsId = ds.id; paused = false;
    onEvent('tour_start', { stops: stops.length });
    legTo(at);
  }

  function stop(reason = 'user') {
    if (phase === 'idle') return;
    if (reason !== 'done') onEvent('tour_stop', { at: i + 1, of: stops.length, reason });
    phase = 'idle'; stops = null; onPrefetch(null);
    render(); onEnd();
  }

  function next() { if (!stops) return; if (i + 1 < stops.length) legTo(i + 1); else finish(); }
  function prev() { if (stops && i > 0) legTo(i - 1); }
  function finish() {
    onEvent('tour_complete', { stops: stops.length });
    phase = 'idle'; stops = null; onPrefetch(null); render(); onEnd();
  }

  // Called every frame with dt in seconds.
  function tick(dt) {
    if (phase === 'idle' || paused) return;
    const s = stops[i];
    if (phase === 'fly') {
      t = Math.min(1, t + dt / legDur);
      const e = ease(t);
      const pos = lerp3(from.position, s.position, e);
      const d = dist(from.position, s.position);
      pos[2] += Math.sin(Math.PI * t) * Math.min(80, d * 0.12);  // arc up on long legs
      place(pos, lerp3(from.target, s.target, e));
      // Download the destination's detail during the flight, ahead of the views passed on the way.
      onPrefetch(s);
      if (t >= 1) { phase = 'hold'; t = 0; wait = 0; quiet = 0; loaded = false; onPrefetch(null); onEvent('tour_stop_reached', { at: i + 1, name: s.name }); render(); }
    } else if (phase === 'hold') {
      // A stop moves on only when its caption time has passed AND its detail has finished loading
      // ("loaded" = the view has its full point budget, or nothing loading for 1.5 s straight; loading
      // pauses briefly between batches, and Potree keeps a few downloads going once the budget is full), with a
      // 25 s safety cap. The camera holds still until loaded (no drift = no new detail to fetch), then
      // drifts slowly while the rest of the caption time runs and the next stop downloads.
      wait += dt; t += dt;
      quiet = Potree.numNodesLoading === 0 ? quiet + dt : 0;
      if (!loaded && (quiet > 1.5 || viewFull())) { loaded = true; settleAt = t; onEvent('tour_stop_loaded', { at: i + 1, seconds: Math.round(wait) }); }
      if (loaded && i + 1 < stops.length) onPrefetch(stops[i + 1]);
      const hold = s.hold ?? 6;
      if (loaded) {
        const a = (s.drift ?? 0.03) * Math.min(1, (t - settleAt) / 1.5) * dt;   // eased start
        const v = view(), p = s.target;
        const dx = v.position.x - p[0], dy = v.position.y - p[1];
        v.position.x = p[0] + dx * Math.cos(a) - dy * Math.sin(a);
        v.position.y = p[1] + dx * Math.sin(a) + dy * Math.cos(a);
        v.lookAt(...p);
      }
      if (t >= hold && (loaded ? t - settleAt >= 2.5 : wait > 25)) next();   // >= 2.5 s on the sharp view
    }
  }

  function render() {
    if (phase === 'idle' || !stops) { root.replaceChildren(); root.hidden = true; return; }
    const s = stops[i];
    root.hidden = false;
    const dots = el('div', { className: 'tour-dots' }, ...stops.map((_, k) => {
      const b = el('button', { className: 'tour-dot' + (k === i ? ' on' : k < i ? ' done' : ''), title: stops[k].name, onclick: () => legTo(k) });
      b.setAttribute('aria-label', `Stop ${k + 1}: ${stops[k].name}`);
      return b;
    }));
    const pause = el('button', { className: 'icon', textContent: paused ? '▶' : '❚❚', title: paused ? 'Resume' : 'Pause',
      onclick: () => { paused = !paused; render(); } });
    root.replaceChildren(...[
      el('div', { className: 'tour-head' },
        el('span', { className: 'tour-step', textContent: `${i + 1} / ${stops.length}` }),
        el('strong', { textContent: s.name }),
        el('span', { className: 'tour-ctl' },
          el('button', { className: 'icon', textContent: '‹', title: 'Previous stop', disabled: i === 0, onclick: prev }),
          pause,
          el('button', { className: 'icon', textContent: '›', title: 'Next stop', onclick: next }),
          el('button', { className: 'icon', textContent: '✕', title: 'End tour (or just drag the view)', onclick: () => stop('close') }))),
      s.chip ? el('span', { className: 'tour-chip', textContent: s.chip }) : null,
      s.caption ? el('p', { textContent: s.caption }) : null,
      dots,
    ].filter(Boolean));
  }

  // Taking the controls ends the tour: the visitor keeps the current view.
  const area = document.getElementById('potree_render_area');
  for (const type of ['pointerdown', 'wheel', 'touchstart']) area.addEventListener(type, () => stop('interact'), { passive: true });
  addEventListener('keydown', (e) => {
    if (phase === 'idle' || e.target.closest?.('input,textarea,select')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    else if (e.key === ' ') { e.preventDefault(); paused = !paused; render(); }
    else if (!['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) stop(e.key === 'Escape' ? 'close' : 'interact');
  }, true);

  return {
    start, stop, tick,
    get active() { return phase !== 'idle'; },
    get dataset() { return dsId; },
  };
}
