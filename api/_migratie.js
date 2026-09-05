/* api/_migratie.js — eenmalige migratie (2026-09-05), gedeeld door
   tools/migreer-namespace.js (lokaal) en POST /api/migreer (op Vercel, waar
   de productiedatabase bekend is).
   1. memo's uit de oude naamruimte 'sunshower' (vóór 2026-08-25) → 'inbox';
   2. elke memo zonder logboek krijgt een eerste gebeurtenis 'gemigreerd'
      met de huidige stand.
   Verwijdert NIETS; idempotent (nog eens draaien doet niets meer). */
const { cmd, boekKey } = require("./_redis");
const memo = require("./_memo");

async function migreer({ doe }) {
  const P = "spraakbericht:";
  const regels = [];
  const oudeIds = (await cmd(["SMEMBERS", boekKey("sunshower", P + "index")])) || [];
  const nieuweIds = new Set((await cmd(["SMEMBERS", memo.INDEX_KEY])) || []);
  let verplaatst = 0, logboeken = 0;
  for (const id of oudeIds) {
    const oud = await cmd(["GET", boekKey("sunshower", P + id)]);
    if (!oud) continue;
    if (!(await cmd(["GET", memo.key(id)]))) {
      regels.push("verplaats " + id);
      if (doe) { await cmd(["SET", memo.key(id), oud]); await cmd(["SADD", memo.INDEX_KEY, id]); }
      verplaatst++;
    }
  }
  for (const id of new Set([...oudeIds, ...nieuweIds])) {
    if (Number(await cmd(["LLEN", memo.key(id, "events")])) > 0) continue;
    const raw = await cmd(["GET", memo.key(id)]) || await cmd(["GET", boekKey("sunshower", P + id)]);
    if (!raw) continue;
    const rec = memo.normaliseer(JSON.parse(raw));
    if (!rec.versie) rec.versie = 1;
    const event = { type: "gemigreerd", door: { rol: "systeem" }, ts: new Date().toISOString(), versie: rec.versie, data: { van: "record zonder logboek" }, stand: Object.assign({}, rec, { audio: undefined }) };
    regels.push("logboek voor " + id + " (status " + rec.status + ")");
    if (doe) { await cmd(["SET", memo.key(id), JSON.stringify(rec)]); await cmd(["RPUSH", memo.key(id, "events"), JSON.stringify(event)]); }
    logboeken++;
  }
  return { doe: !!doe, oud: oudeIds.length, inbox: nieuweIds.size, verplaatst, logboeken, regels };
}

module.exports = { migreer };
