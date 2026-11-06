// Optional analytics. Off unless datasets.json has  "analytics": { "ga4": "G-XXXXXXXXXX" }.
// Events (all carry `dataset`): dataset_view, cta_click, share, measure, screenshot,
// nav_mode, xray, ortho, clean, advanced_open, viewpoint. GA4 adds page views + engagement time itself.
// ?debug-analytics=1 logs events to the console (works with or without an ID).

let gtag = null;
const debug = new URLSearchParams(location.search).has('debug-analytics');

export function initAnalytics(cfg) {
  const id = cfg?.ga4;
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  gtag = function () { window.dataLayer.push(arguments); };
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', id);
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.append(s);
}

export function track(name, params = {}) {
  if (debug) console.debug('[analytics]', name, params);
  if (gtag) gtag('event', name, params);
}
