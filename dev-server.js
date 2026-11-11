/* 本地开发服务
 * 1) 静态服务仓库文件（给 harness 页面与浏览器内动态 import 用）
 * 2) POST /api/dump  接收浏览器送回的 DOM 快照，落盘成夹具
 *
 * 用法：node dev-server.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // CORS：允许从 threads.com 页面里 import 本地源码
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // DOM 快照落盘
  if (req.method === 'POST' && url.pathname === '/api/dump') {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body);
      const name = String(json.name || 'snapshot').replace(/[^\w.-]/g, '_');
      const out = path.join(ROOT, 'tests', 'dumps', name.endsWith('.html') ? name : name + '.html');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, json.html, 'utf8');
      console.log(`[dump] ${out} (${json.html.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, out, bytes: json.html.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message) }));
    }
    return;
  }

  // PNG 落盘：body = { name, dataUrl }
  if (req.method === 'POST' && url.pathname === '/api/png') {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body);
      const name = String(json.name || 'card').replace(/[^\w.-]/g, '_');
      const b64 = String(json.dataUrl || '').split('base64,')[1] || '';
      if (!b64) throw new Error('no base64 payload');
      const out = path.join(ROOT, 'tests', 'renders', name.endsWith('.png') ? name : name + '.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      const kb = (fs.statSync(out).size / 1024).toFixed(1);
      console.log(`[png] ${out} (${kb} KB)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, out, kb }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message) }));
    }
    return;
  }

  // 静态文件
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/tests/harness.html';
  const file = path.join(ROOT, p.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + p);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${PORT}`);
  console.log(`harness:    http://127.0.0.1:${PORT}/tests/harness.html`);
});
