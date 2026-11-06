import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev only: serve ../out/*.copc.laz at /data/* with HTTP Range support, so the
// viewer streams the local COPC exactly as it will from S3/CloudFront.
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

export default defineConfig({
  base: './', // relative URLs so dist/ works from any path (e.g. a bucket prefix)
  plugins: [rangeData()],
  build: { target: 'es2022' }, // main.js uses top-level await
});
