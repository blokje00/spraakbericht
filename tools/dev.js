#!/usr/bin/env node
/* tools/dev.js — de HELE lus lokaal met één commando (2026-09-05).
   Start:  - tools/mock-diagnose.js   (nagebootste diagnose-app, poort MOCK_PORT)
           - tools/local-api.js       (app + API, poort PORT)
           - tools/mac-consumer.js    (--watch, tegen de lokale API, elke 10 s)
   en controleert of de Whisper-server (launchd, poort 52370) bereikbaar is.
   Zo wordt een memo die je lokaal inspreekt binnen een halve minuut
   getranscribeerd en verschijnt hij in review.html onder "Te controleren".

   Env: PORT (default 52350), MOCK_PORT (52351), REDIS_URL, ADMIN_TOKEN (of .env.local),
        WHISPER_URL (http://127.0.0.1:52370). */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

(function laadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const PORT = process.env.PORT || "52350";
const MOCK_PORT = process.env.MOCK_PORT || "52351";
const WHISPER_URL = process.env.WHISPER_URL || "http://127.0.0.1:52370";
const basis = Object.assign({}, process.env, {
  REDIS_URL: process.env.REDIS_URL || "redis://127.0.0.1:6379/14",
  DIAGNOSE_API_BASE: process.env.DIAGNOSE_API_BASE || "http://localhost:" + MOCK_PORT,
  DIAGNOSE_ADMIN_TOKEN: process.env.DIAGNOSE_ADMIN_TOKEN || "diag",
  SPRAAKBERICHT_BASE: "http://localhost:" + PORT,
  BLOB_READ_WRITE_TOKEN: "",
});
if (!basis.ADMIN_TOKEN) { console.error("[dev] ADMIN_TOKEN ontbreekt (.env.local)"); process.exit(2); }

const kinderen = [];
function start(naam, script, env) {
  const p = spawn(process.execPath, [path.join(__dirname, script)].concat(naam === "consumer" ? ["--watch"] : []), { env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write(String(d).split("\n").filter(Boolean).map((l) => "[" + naam + "] " + l + "\n").join("")));
  p.stderr.on("data", (d) => process.stderr.write(String(d).split("\n").filter(Boolean).map((l) => "[" + naam + "] " + l + "\n").join("")));
  p.on("exit", (code) => { console.error("[dev] " + naam + " stopte (" + code + ")"); stopAlles(); process.exit(code || 1); });
  kinderen.push(p);
}
function stopAlles() { kinderen.forEach((p) => { try { p.kill(); } catch (e) { /* al weg */ } }); }
process.on("SIGINT", () => { stopAlles(); process.exit(0); });
process.on("SIGTERM", () => { stopAlles(); process.exit(0); });

(async () => {
  const gezond = await fetch(WHISPER_URL + "/health").then((r) => r.json()).catch(() => null);
  if (!gezond) console.error("[dev] LET OP: Whisper-server niet bereikbaar op " + WHISPER_URL + " — start hem: launchctl load ~/Library/LaunchAgents/nl.sunshower.whisper-server.plist");
  else console.log("[dev] Whisper-server ok (model " + gezond.model + (gezond.geladen ? ", geladen" : ", laadt nog") + ")");
  start("diagnose", "mock-diagnose.js", Object.assign({}, basis, { PORT: MOCK_PORT }));
  start("api", "local-api.js", Object.assign({}, basis, { PORT }));
  start("consumer", "mac-consumer.js", Object.assign({}, basis, { API_BASE: "http://localhost:" + PORT, WHISPER_URL, POLL_INTERVAL_MS: "10000" }));
  console.log("[dev] monteur: http://localhost:" + PORT + "   supervisor: http://localhost:" + PORT + "/review.html");
})();
