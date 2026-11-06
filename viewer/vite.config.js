import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev only: serve ../out/*.copc.laz at /data/* with HTTP Range support, so the
// viewer streams the local COPC exactly as it will from the bucket.
// (Kept out of public/ so `vite build` never copies a 40+ GB file into dist.)
const DATA_DIR = path.resolve(__dirname, '../out');

function rangeData() {
  return {
    name: 'range-data',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const file = path.join(DATA_DIR, decodeURIComponent(req.url.split('?')[0]));
        if (!file.startsWith(DATA_DIR + path.sep) || !fs.existsSync(file)) return next();
        const size = fs.statSync(file).size;
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/octet-stream');
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        if (!m) {
          res.setHeader('Content-Length', size);
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(file).pipe(res);
        }
        let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
        let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
        end = Math.min(end, size - 1);
        if (start > end || start < 0) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end(); }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

// Deployment-specific values come from viewer/.env (copy .env.example; .env is not committed):
//   VITE_GA4_ID=G-XXXXXXXXXX   Google Analytics 4 (optional)
//   VITE_GTM_ID=GTM-XXXXXXX    Google Tag Manager container (optional)
//   VITE_SITE_URL=https://...  public URL of the deployed viewer folder, for link previews (optional)
// Analytics tags are only injected into production builds, so local development sends no events.
function siteConfig(env, command) {
  return {
    name: 'site-config',
    transformIndexHtml(html) {
      const ga = /^G-[A-Z0-9]+$/.test(env.VITE_GA4_ID || '') ? env.VITE_GA4_ID : null;
      const gtm = /^GTM-[A-Z0-9]+$/.test(env.VITE_GTM_ID || '') ? env.VITE_GTM_ID : null;
      let tags = '';
      if (command === 'build' && (ga || gtm)) {
        tags += ga ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga}"></script>\n` : '';
        tags += '<script>\n  window.dataLayer = window.dataLayer || [];\n';
        if (ga) tags += `  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n  gtag('config', '${ga}');\n`;
        if (gtm) tags += `  (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtm}');\n`;
        tags += '</script>';
      }
      html = html.replace(/<!-- analytics:[^>]*-->/, tags);
      const site = (env.VITE_SITE_URL || '').replace(/\/+$/, '');
      return site ? html.replaceAll('__SITE_URL__', site)
        : html.replace(/\s*<meta property="og:(url|image)" content="__SITE_URL__[^"]*">/g, '');
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  base: './', // relative URLs so dist/ works from any path (e.g. a bucket prefix)
  plugins: [rangeData(), siteConfig(loadEnv(mode, process.cwd(), 'VITE_'), command)],
  build: { target: 'es2022' }, // main.js uses top-level await
}));
