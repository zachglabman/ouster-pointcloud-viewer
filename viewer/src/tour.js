// Guided tour: flies the camera through a dataset's `tour` stops (datasets.json), with a caption at each.
//   "tour": [{ "name": "...", "caption": "...", "position": [x,y,z], "target": [x,y,z], "hold": 6 }, ...]
// Motion: each leg eases in/out (smootherstep) on both camera position and look-at target, with a lift
// on long legs so the camera arcs over the scene instead of cutting through it. At each stop the camera
// drifts in a slow orbit while the caption is up. Any pointer/wheel/key input on the scene ends the tour
// and leaves the visitor where the camera is (the orbit pivot is the current stop's target).

const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function createTour({ viewer, el, root, onEvent = () => {}, onEnd = () => {} }) {
  let stops = null, i = 0, phase = 'idle', t = 0, legDur = 0, from = null, paused = false, dsId = null;
  let drift = 0;

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
    i = k; from = cur(); t = 0; drift = 0;
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
    phase = 'idle'; stops = null;
    render(); onEnd();
  }

  function next() { if (!stops) return; if (i + 1 < stops.length) legTo(i + 1); else finish(); }
  function prev() { if (stops && i > 0) legTo(i - 1); }
  function finish() {
    onEvent('tour_complete', { stops: stops.length });
    phase = 'idle'; stops = null; render(); onEnd();
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
      if (t >= 1) { phase = 'hold'; t = 0; onEvent('tour_stop_reached', { at: i + 1, name: s.name }); render(); }
    } else if (phase === 'hold') {
      t += dt;
      // Slow drift around the target: ~10 degrees over the hold, eased at the start.
      const hold = s.hold ?? 6;
      const a = (s.drift ?? 0.03) * Math.min(1, t / 1.5) * dt;
      drift += a;
      const v = view(), p = s.target;
      const dx = v.position.x - p[0], dy = v.position.y - p[1];
      v.position.x = p[0] + dx * Math.cos(a) - dy * Math.sin(a);
      v.position.y = p[1] + dx * Math.sin(a) + dy * Math.cos(a);
      v.lookAt(...p);
      if (t >= hold) next();
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
