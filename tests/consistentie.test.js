/* ============================================================
   tests/consistentie.test.js — controleert dat de gebouwde
   bestanden onderling consistent zijn (zonder backend).
   Run:  node tests/consistentie.test.js  (of via npm test)
   ============================================================ */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// 1. Elk element-ID dat app.js gebruikt, bestaat in index.html
const app = read("app.js");
const html = read("index.html");
const ids = [...app.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]);
const missing = ids.filter((id) => !html.includes(`id="${id}"`));
assert.deepStrictEqual(missing, [], "app.js gebruikt IDs die ontbreken in index.html: " + missing);
console.log("✓ " + ids.length + " element-IDs in app.js bestaan allemaal in index.html");

// 2. config.js defineert het volledige koppelingscontract
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(read("config.js"), sandbox);
const cfg = sandbox.window.SS_MONTEUR_CONFIG;
["API_BASE", "API_ROUTE", "BOEK_SLUG", "AUTH_TOKEN", "MONTEUR_NAAM", "APP_V", "AUDIO_MIME", "MAX_SECONDS", "LEADERBOARD_ROUTE"].forEach((k) =>
  assert.ok(k in cfg, "config.js mist " + k));
console.log("✓ config.js heeft volledig koppelingscontract (" + Object.keys(cfg).join(", ") + ")");

// 3. app.js stuurt de originele audio ALTIJD mee (harde eis)
assert.ok(app.includes("audio: audioBase64"), "app.js stuurt audio niet mee");
assert.ok(app.includes("audioType: blob.type"), "app.js stuurt audioType niet mee");
assert.ok(app.includes("await blobToBase64(blob)"), "audio moet geawait worden (was Promise-object → {} in JSON)");
console.log("✓ app.js stuurt originele audio + type mee (en await de base64)");

// 4. app.js gebruikt config.js (geen hardcoded API-URL)
const urls = app.match(/https?:\/\/[^"'\s]+/g) || [];
assert.deepStrictEqual(urls, [], "app.js bevat hardcoded URL: " + urls);
console.log("✓ app.js bevat geen hardcoded URL, alles via config.js");

// 5. manifest + sw geldig
JSON.parse(read("manifest.json"));
console.log("✓ manifest.json is geldige JSON");
assert.ok(read("sw.js").includes("self.addEventListener"));
console.log("✓ sw.js is een geldige service worker");

// 6. package.json test-scripts verwijzen naar de test-bestanden
const pkg = JSON.parse(read("package.json"));
const testScript = pkg.scripts.test;
assert.ok(testScript.includes("consistentie.test.js"), "test-script moet consistentie.test.js runnen");
assert.ok(pkg.scripts["test:all"].includes("koppeling.test.js"), "test:all moet koppeling.test.js runnen");
assert.ok(pkg.scripts["test:all"].includes("transcriptie.test.js"), "test:all moet transcriptie.test.js runnen");
console.log("✓ package.json test-script bundelt alle tests");

console.log("\nAlle consistentie-checks geslaagd.");
