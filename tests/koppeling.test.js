/* ============================================================
   tests/koppeling.test.js — verifieert het koppelingscontract.
   Draait met node (geen DOM nodig voor de config-check) + een
   POST naar de mock-backend om de audio-upload te bewijzen.
   Run:  node tests/koppeling.test.js
   (vereist tools/mock-server.js op :52344)
   ============================================================ */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");

// 1. config.js is parseerbaar en bevat de koppelingsvariabelen
const configSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
const vm = require("vm");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(configSrc, sandbox);
const cfg = sandbox.window.SS_MONTEUR_CONFIG;

assert.ok(cfg, "config.js moet window.SS_MONTEUR_CONFIG definiëren");
assert.ok(cfg.API_BASE, "API_BASE ontbreekt");
assert.ok(cfg.API_ROUTE, "API_ROUTE ontbreekt");
assert.ok(cfg.LEADERBOARD_ROUTE, "LEADERBOARD_ROUTE ontbreekt");
assert.ok(cfg.BOEK_SLUG, "BOEK_SLUG ontbreekt");
assert.strictEqual(typeof cfg.AUTH_TOKEN, "string", "AUTH_TOKEN moet een string zijn");
console.log("✓ config.js parseert, alle koppelingsvariabelen aanwezig:", Object.keys(cfg).join(", "));

// 2. app.js hardcoded geen API-URL (gebruikt config)
const appSrc = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
assert.ok(!/https?:\/\/[^"']+/.test(appSrc.replace(/https?:\/\/localhost[^"']*/, "")),
  "app.js mag geen hardcoded API-URL bevatten — alles via config.js");
assert.ok(appSrc.includes("cfg.API_BASE"), "app.js moet config.js gebruiken voor API_BASE");
console.log("✓ app.js koppelt via config.js, geen hardcoded URL");

// 3. POST een fake submissie naar de mock-backend
const MOCK_PORT = process.env.MOCK_PORT || "52344";
function isMockReachable() {
  return new Promise((resolve) => {
    const req = http.request("http://localhost:" + MOCK_PORT + "/api/uitzendingen", { method: "GET", timeout: 1000 }, (res) => resolve(res.statusCode === 200));
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

isMockReachable().then((reachable) => {
  if (!reachable) {
    console.log("○ Overgeslagen: mock-backend niet bereikbaar op port " + MOCK_PORT +
      " (start: PORT=" + MOCK_PORT + " node tools/mock-server.js)\n");
    process.exit(0);
  }
  return post("http://localhost:" + MOCK_PORT + "/api/monteuridee", {
    boek: "sunshower",
    monteur: "Test Monteur",
    audio: Buffer.from("fake-webm-bytes").toString("base64"),
    audioType: "audio/webm;codecs=opus",
    tekst: "test",
    ts: Date.now()
  });
}).then((r) => {
  if (!r) return;
  assert.strictEqual(r.status, 200, "mock moet 200 teruggeven, kreeg " + r.status + " " + r.body);
  const parsed = JSON.parse(r.body);
  assert.ok(parsed.ok && parsed.id, "mock moet {ok, id} teruggeven");
  console.log("✓ mock-backend ontving submissie, id =", parsed.id);
  console.log("\nAlle tests geslaagd.");
}).catch((e) => { console.error("✗ TEST MISLUKT:", e.message); process.exit(1); });
