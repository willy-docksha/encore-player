// local dev server: static files plus the vercel functions in api/ (same routes as vercel.json)
// usage: node dev.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".onnx": "application/octet-stream", ".f16": "application/octet-stream", ".wasm": "application/wasm",
};
const FUNCTIONS = { "/drive": "api/drive.js", "/title": "api/title.js" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (FUNCTIONS[url.pathname]) {
      const { GET } = await import(path.join(ROOT, FUNCTIONS[url.pathname]));
      const out = await GET(new Request(url, { headers: req.headers }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      if (out.body) Readable.fromWeb(out.body).pipe(res); else res.end();
      return;
    }
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    // only the web app is served, never the tooling around it
    const rel = path.relative(ROOT, file);
    const allowed = /^(index\.html|sw\.js|manifest\.webmanifest|icon-\d+\.png|app\/.+|models\/.+)$/.test(rel);
    if (!allowed || !fs.existsSync(file)) { res.writeHead(404).end("not found"); return; }
    const { size } = fs.statSync(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "content-length": size, "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err));
  }
}).listen(PORT, () => console.log(`Encore di http://localhost:${PORT}`));
