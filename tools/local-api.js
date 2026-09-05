#!/usr/bin/env node
/* tools/local-api.js — de hele app LOKAAL: statische bestanden + de API
   (zelfde code als op Vercel, via een kleine nabootsing van req.query en
   res.status().json()). Bedoeld voor ontwikkelen en de testsuite.

   Start:  REDIS_URL=redis://127.0.0.1:6379/15 ADMIN_TOKEN=test node tools/local-api.js
   Poort:  PORT (default 52350). Leest ook .env.local (zonder te overschrijven). */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

(function laadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 52350);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

/* Vercel-achtige res.status().json() */
function verrijk(req, res, url) {
  req.query = {};
  for (const [k, v] of url.searchParams) req.query[k] = v;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    verrijk(req, res, url);
    req.query.route = url.pathname.slice(5);
    try { await require(path.join(ROOT, "api", "router.js"))(req, res); }
    catch (e) { console.error("[local-api]", e); if (!res.headersSent) res.status(500).json({ error: "interne fout: " + e.message }); }
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("verboden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("niet gevonden: " + rel); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("[local-api] app + API op http://localhost:" + PORT + "  (REDIS_URL=" + (process.env.REDIS_URL || "ONTBREEKT") + ")");
});
