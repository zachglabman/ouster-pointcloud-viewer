// Optional analytics, configured in datasets.json "analytics":
//   { "gtm": "GTM-XXXXXXX" }  Google Tag Manager container: events are pushed to dataLayer as
//                              { event: name, dataset, ... } -> GTM "Custom Event" triggers fire GA4 tags.
//   { "ga4": "G-XXXXXXXXXX" }  direct GA4 (gtag.js). With both set, the container loads and events go to GA4 directly.
// Events (all carry `dataset`): dataset_view, cta_click, share, measure, screenshot,
// nav_mode, xray, ortho, clean, advanced_open, viewpoint.
// ?debug-analytics=1 logs events to the console (works with or without an ID).

let send = null;
const debug = new URLSearchParams(location.search).has('debug-analytics');

function load(src) {
  const s = document.createElement('script');
  s.async = true; s.src = src;
  document.head.append(s);
}

export function initAnalytics(cfg) {
  window.dataLayer = window.dataLayer || [];
  const gtm = cfg?.gtm, ga4 = cfg?.ga4;
  if (gtm && /^GTM-[A-Z0-9]+$/.test(gtm)) {
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    load(`https://www.googletagmanager.com/gtm.js?id=${gtm}`);
    send = (name, params) => window.dataLayer.push({ event: name, ...params });
  }
  // Direct GA4 wins for events when set: works without any tags configured in the container.
  // (Don't also add a GA4 tag with the same ID inside GTM, or page views count twice.)
  if (ga4 && /^G-[A-Z0-9]+$/.test(ga4)) {
    const gtag = function () { window.dataLayer.push(arguments); };
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', ga4);
    load(`https://www.googletagmanager.com/gtag/js?id=${ga4}`);
    send = (name, params) => gtag('event', name, params);
  }
}

export function track(name, params = {}) {
  if (debug) console.debug('[analytics]', name, params);
  if (send) send(name, params);
}
