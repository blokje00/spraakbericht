#!/usr/bin/env node
/* tools/migreer-namespace.js — draai de migratie (api/_migratie.js) tegen de
   Redis in REDIS_URL. Zonder --doe alleen tonen. Voor productie: gebruik de
   beheerroute POST /api/migreer[?doe=1] met het admin-token, want Vercel
   geeft REDIS_URL niet terug aan de Mac. */
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
if (!process.env.REDIS_URL) { console.error("REDIS_URL ontbreekt"); process.exit(2); }
require("../api/_migratie").migreer({ doe: process.argv.includes("--doe") }).then((u) => {
  u.regels.forEach((r) => console.log("  " + r));
  console.log(`oud: ${u.oud}, inbox: ${u.inbox}; ${u.verplaatst} verplaatst, ${u.logboeken} logboeken${u.doe ? "" : " (niets uitgevoerd; voeg --doe toe)"}`);
  process.exit(0);
}).catch((e) => { console.error("fout:", e.message); process.exit(1); });
