// Tiny static server for previewing Nook's pages: node preview/serve.mjs [port]
// Serves the project folder, and draws a letter icon for the extension's /_favicon/ URLs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 5178);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const hues = [210, 340, 35, 265, 170, 15, 290];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/nook/_favicon')) {
    let host = 'x';
    try { host = new URL(url.searchParams.get('pageUrl')).hostname.replace(/^www\./, ''); } catch {}
    const hue = hues[[...host].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length];
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="hsl(${hue} 55% 50%)"/><text x="16" y="22" font-family="Arial" font-weight="700" font-size="17" fill="#fff" text-anchor="middle">${host[0].toUpperCase()}</text></svg>`);
  }
  let path = decodeURIComponent(url.pathname);
  if (path === '/') { res.writeHead(302, { location: '/preview/nook.html' }); return res.end(); }
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, () => console.log(`Nook preview on http://localhost:${port}/preview/nook.html`));
