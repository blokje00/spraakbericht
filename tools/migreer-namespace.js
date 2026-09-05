#!/usr/bin/env node
/* tools/migreer-namespace.js — zet memo's uit de oude Redis-naamruimte
   'sunshower' (vóór 2026-08-25) over naar 'inbox', en geeft elke memo
   zonder logboek een eerste gebeurtenis 'gemigreerd' met de huidige stand.
   Verwijdert NIETS: de oude sleutels blijven staan (met een kopie), zodat
   de fallback in api/_memo.js daarna weg kan.

   Draaien:  REDIS_URL=… node tools/migreer-namespace.js [--doe]
   Zonder --doe alleen tonen wat er zou gebeuren. */
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
const DOE = process.argv.includes("--doe");
const { cmd, boekKey } = require("../api/_redis");
const memo = require("../api/_memo");

(async () => {
  if (!process.env.REDIS_URL) { console.error("REDIS_URL ontbreekt"); process.exit(2); }
  const P = "spraakbericht:";
  const oudeIds = (await cmd(["SMEMBERS", boekKey("sunshower", P + "index")])) || [];
  const nieuweIds = new Set((await cmd(["SMEMBERS", memo.INDEX_KEY])) || []);
  console.log(`oude namespace: ${oudeIds.length} id's; inbox: ${nieuweIds.size} id's; modus: ${DOE ? "UITVOEREN" : "alleen tonen"}`);
  let verplaatst = 0, logboeken = 0;
  for (const id of oudeIds) {
    const oud = await cmd(["GET", boekKey("sunshower", P + id)]);
    if (!oud) continue;
    const bestaatAl = await cmd(["GET", memo.key(id)]);
    if (!bestaatAl) {
      console.log(`  verplaats ${id}`);
      if (DOE) { await cmd(["SET", memo.key(id), oud]); await cmd(["SADD", memo.INDEX_KEY, id]); }
      verplaatst++;
    }
  }
  for (const id of new Set([...oudeIds, ...nieuweIds])) {
    const n = Number(await cmd(["LLEN", memo.key(id, "events")]));
    if (n > 0) continue;
    const raw = await cmd(["GET", memo.key(id)]);
    if (!raw) continue;
    const rec = memo.normaliseer(JSON.parse(raw));
    if (!rec.versie) rec.versie = 1;
    const event = { type: "gemigreerd", door: { rol: "systeem" }, ts: new Date().toISOString(), versie: rec.versie, data: { van: "record zonder logboek" }, stand: Object.assign({}, rec, { audio: undefined }) };
    console.log(`  logboek voor ${id} (status ${rec.status})`);
    if (DOE) { await cmd(["SET", memo.key(id), JSON.stringify(rec)]); await cmd(["RPUSH", memo.key(id, "events"), JSON.stringify(event)]); }
    logboeken++;
  }
  console.log(`klaar: ${verplaatst} verplaatst, ${logboeken} logboeken aangemaakt${DOE ? "" : " (niets uitgevoerd; voeg --doe toe)"}`);
  process.exit(0);
})().catch((e) => { console.error("fout:", e.message); process.exit(1); });
