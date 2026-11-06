// Analytics events. The Google tag / Tag Manager snippets are injected into index.html at build time from
// VITE_GA4_ID / VITE_GTM_ID in viewer/.env (see vite.config.js); without them this sends nothing.
// Events (all carry `dataset`): dataset_view, cta_click, share, measure, screenshot, nav_mode, xray, ortho,
// clean, advanced_open, viewpoint, tour_start, tour_stop_reached, tour_stop_loaded, tour_stop, tour_complete.
// ?debug-analytics=1 logs events to the console.

const debug = new URLSearchParams(location.search).has('debug-analytics');

export function track(name, params = {}) {
  if (debug) console.debug('[analytics]', name, params);
  if (typeof window.gtag === 'function') window.gtag('event', name, params);
}
