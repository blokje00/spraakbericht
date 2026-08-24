/* ============================================================
   tools/dev-server.js — statische server voor de monteursapp.
   Serveert de app op :52343 (zonder build).
   Start:  node tools/dev-server.js
   Open:   http://localhost:52343
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 52343;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webm": "video/webm"
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("verboden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("niet gevonden: " + rel); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("Monteursapp draait op http://localhost:" + PORT);
});
