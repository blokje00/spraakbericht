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

// 2. config.js definieert wat app.js nodig heeft
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(read("config.js"), sandbox);
const cfg = sandbox.window.SS_MONTEUR_CONFIG;
const gebruikt = [...new Set([...app.matchAll(/cfg\.([A-Z_]+)/g)].map((m) => m[1]))];
gebruikt.forEach((k) => assert.ok(k in cfg, "config.js mist " + k + " (gebruikt in app.js)"));
console.log("✓ config.js heeft alles wat app.js gebruikt (" + gebruikt.join(", ") + ")");

// 3. Elke tekst-sleutel die index.html/app.js gebruikt, bestaat in i18n.js voor nl én de
const i18nSandbox = { window: {} };
vm.createContext(i18nSandbox);
vm.runInContext(read("i18n.js"), i18nSandbox);
const I = i18nSandbox.window.SS_I18N;
const sleutels = new Set([...html.matchAll(/data-i18n(?:-ph)?="([a-z_]+)"/g)].map((m) => m[1]).concat([...app.matchAll(/\bt\("([a-z_]+)"\)/g)].map((m) => m[1])));
for (const taal of I.talen) {
  I.zetTaal(taal);
  const ontbreekt = [...sleutels].filter((k) => I.t(k) === k);
  assert.deepStrictEqual(ontbreekt, [], "i18n.js mist voor " + taal + ": " + ontbreekt);
}
console.log("✓ " + sleutels.size + " schermteksten bestaan in " + I.talen.join(" en "));

// 4. schema.js: elk issue-veld heeft een label in beide talen; keuzevelden hebben optielabels
const schema = require(path.join(ROOT, "schema.js"));
for (const veld of schema.issueVelden()) {
  const def = schema.ISSUE[veld];
  for (const taal of Object.keys(schema.TALEN)) {
    assert.ok(def.label[taal], "schema.js: " + veld + " mist label " + taal);
    if (def.type === "keuze") def.opties.forEach((o) => assert.ok(def.optieLabel[taal][o], "schema.js: " + veld + " mist optielabel " + taal + "/" + o));
  }
}
for (const st of schema.statussen()) for (const taal of Object.keys(schema.TALEN)) assert.ok(schema.STATUS[st].label[taal], "schema.js: status " + st + " mist label " + taal);
console.log("✓ schema.js: " + schema.issueVelden().length + " velden en " + schema.statussen().length + " statussen hebben labels in beide talen");

// 5. app.js stuurt de originele audio ALTIJD mee en gebruikt geen hardcoded URL
assert.ok(/audio: b64/.test(app) && /audioType: blob\.type/.test(app), "app.js stuurt audio + type niet mee");
const urls = app.match(/https?:\/\/[^"'\s]+/g) || [];
assert.deepStrictEqual(urls, [], "app.js bevat hardcoded URL: " + urls);
console.log("✓ app.js stuurt originele audio + type mee, geen hardcoded URL");

// 6. manifest + sw geldig; package.json bundelt de tests
JSON.parse(read("manifest.json"));
assert.ok(read("sw.js").includes("self.addEventListener"));
const pkg = JSON.parse(read("package.json"));
assert.ok(pkg.scripts.test.includes("consistentie.test.js") && pkg.scripts.test.includes("api.test.js"), "npm test moet consistentie + api draaien");
assert.ok(pkg.scripts["test:loop"].includes("loop.test.js"), "test:loop moet loop.test.js draaien");
console.log("✓ manifest.json, sw.js en package.json-scripts in orde");

console.log("\nAlle consistentie-checks geslaagd.");
