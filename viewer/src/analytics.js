// Analytics. The Google tag (GA4 G-Y572VZ4TRZ) and Tag Manager container (GTM-KBDS6372) are in
// index.html <head>, so Google's tag checker sees them and page views count before the app loads.
// This module only sends viewer events through that tag. Events (all carry `dataset`): dataset_view,
// cta_click, share, measure, screenshot, nav_mode, xray, ortho, clean, advanced_open, viewpoint.
// ?debug-analytics=1 logs events to the console.

const debug = new URLSearchParams(location.search).has('debug-analytics');

export function initAnalytics() {}

export function track(name, params = {}) {
  if (debug) console.debug('[analytics]', name, params);
  if (typeof window.gtag === 'function') window.gtag('event', name, params);
}
