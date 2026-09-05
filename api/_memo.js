/* api/_memo.js — opslag van memo's als LOGBOEK (2026-09-05, fase 1).
   ------------------------------------------------------------
   Principe: een memo wordt nooit overschreven of gewist. Elke wijziging
   voegt een gebeurtenis toe aan een lijst (RPUSH) mét een momentopname
   van de velden op dat moment. Het "record" is de huidige stand, afgeleid
   van de laatste gebeurtenis, en wordt alleen via compare-and-set
   bijgewerkt (veld `versie`), zodat twee schrijvers (consumer én monteur)
   elkaar niet kunnen overschrijven.

   Sleutels (prefix b:inbox:spraakbericht:):
     <id>            huidige stand (JSON)
     <id>:events     gebeurtenissenlijst (RPUSH, nooit verwijderd)
     <id>:audio      audio als base64 (alleen als er geen blob-opslag is)
     index           SET van alle id's (ook ingetrokken)
   Velden en statussen komen uit schema.js (één bron, ook voor de schermen).
   ------------------------------------------------------------ */
const { cmd, boekKey } = require("./_redis");
const schema = require("../schema");

const BOEK = "inbox";
const P = "spraakbericht:";

/* Oude statussen (vóór 2026-09-05) → nieuwe. 'verwerkt' betekende:
   getranscribeerd en (soms) door de monteur bekeken, nog niet goedgekeurd. */
function normaliseerStatus(s) {
  s = String(s || "");
  if (s === "verwerkt") return "wacht-supervisor";
  if (s === "goedgekeurd") return "in-wachtkamer";
  return schema.STATUS[s] ? s : "nieuw";
}

function key(id, suffix) {
  return boekKey(BOEK, P + id + (suffix ? ":" + suffix : ""));
}
const INDEX_KEY = boekKey(BOEK, P + "index");

/* ── Compare-and-set via Lua ──
   KEYS[1] = record, KEYS[2] = events
   ARGV[1] = verwachte versie (0 = nieuw record), ARGV[2] = nieuwe JSON,
   ARGV[3] = event-JSON. Geeft 1 bij succes, 0 als de versie niet klopt. */
const CAS_LUA = `
local raw = redis.call('GET', KEYS[1])
local huidige = 0
if raw then
  local rec = cjson.decode(raw)
  huidige = tonumber(rec.versie) or 0
end
if tostring(huidige) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[3])
return 1
`;

/* Momentopname die in elke gebeurtenis meegaat: alles behalve de audio. */
function momentopname(rec) {
  const kopie = Object.assign({}, rec);
  delete kopie.audio;
  return kopie;
}

/* Voeg een gebeurtenis toe en werk de stand bij.
   type: naam van de gebeurtenis, door: {rol, id, naam}, mutator(rec) past
   het record aan (in place). Bij een versieconflict wordt opnieuw geladen en
   de mutator opnieuw toegepast (max 5 pogingen). */
async function werkBij(id, { type, door, data }, mutator) {
  for (let poging = 0; poging < 5; poging++) {
    const raw = await cmd(["GET", key(id)]);
    if (!raw) return null;
    const rec = normaliseer(JSON.parse(raw));
    const verwacht = Number(rec.versie) || 0;
    mutator(rec);
    rec.versie = verwacht + 1;
    rec.bijgewerktOp = new Date().toISOString();
    const event = {
      type, door: door || { rol: "systeem" }, ts: rec.bijgewerktOp,
      versie: rec.versie, data: data || null, stand: momentopname(rec),
    };
    const ok = await cmd(["EVAL", CAS_LUA, "2", key(id), key(id, "events"),
      String(verwacht), JSON.stringify(rec), JSON.stringify(event)]);
    if (Number(ok) === 1) return rec;
  }
  throw new Error("memo " + id + " kon niet worden bijgewerkt (versieconflict)");
}

/* Nieuwe memo aanmaken: record + eerste gebeurtenis + index. */
async function maak(rec, door) {
  rec.versie = 1;
  rec.aangemaaktOp = rec.aangemaaktOp || new Date().toISOString();
  rec.bijgewerktOp = rec.aangemaaktOp;
  const event = {
    type: "ingestuurd", door: door || { rol: "monteur" }, ts: rec.aangemaaktOp,
    versie: 1, data: null, stand: momentopname(rec),
  };
  const ok = await cmd(["EVAL", CAS_LUA, "2", key(rec.id), key(rec.id, "events"),
    "0", JSON.stringify(rec), JSON.stringify(event)]);
  if (Number(ok) !== 1) throw new Error("memo-id bestaat al: " + rec.id);
  await cmd(["SADD", INDEX_KEY, rec.id]);
  return rec;
}

/* Lees de huidige stand. Valt terug op de legacy-namespace 'sunshower'
   (memo's van vóór 2026-08-25) zolang tools/migreer-namespace.js nog niet
   gedraaid heeft; dit is de enige plek waar die fallback nog bestaat. */
async function laad(id) {
  let raw = await cmd(["GET", key(id)]);
  if (!raw) raw = await cmd(["GET", boekKey("sunshower", P + id)]);
  if (!raw) return null;
  return normaliseer(JSON.parse(raw));
}

async function events(id) {
  const lijst = (await cmd(["LRANGE", key(id, "events"), "0", "-1"])) || [];
  return lijst.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

async function alleIds() {
  const ids = new Set((await cmd(["SMEMBERS", INDEX_KEY])) || []);
  for (const i of (await cmd(["SMEMBERS", boekKey("sunshower", P + "index")])) || []) ids.add(i);
  return Array.from(ids);
}

/* Alle memo's (huidige stand, zonder audio), jongste eerst. */
async function alle() {
  const uit = [];
  for (const id of await alleIds()) {
    const rec = await laad(id);
    if (rec) uit.push(rec);
  }
  uit.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return uit;
}

/* Breng een (mogelijk oud) record naar de huidige vorm. Verandert niets in
   Redis; alleen de gelezen kopie. */
function normaliseer(rec) {
  rec.status = normaliseerStatus(rec.status);
  rec.versie = Number(rec.versie) || 0;
  rec.taal = schema.TALEN[rec.taal] ? rec.taal : "nl";
  if (!rec.monteurId) rec.monteurId = null; // memo van vóór de monteur-login
  rec.issues = Array.isArray(rec.issues) ? rec.issues.map(normaliseerIssue) : [];
  rec.diagnose = Array.isArray(rec.diagnose) ? rec.diagnose : [];
  if (rec.diagnoseTreeId && !rec.diagnose.length) {
    rec.diagnose = [{ issue: 0, status: 200, treeId: rec.diagnoseTreeId }];
  }
  if (rec.audio && !rec.audioRef) rec.audioRef = "inline"; // audio nog in het record
  rec.heeftAudio = !!rec.audioRef;
  return rec;
}

/* Issue naar de vorm uit schema.js; oude veldnamen (model/symptoom/fix/
   controle van vóór 2026-09-05) worden overgezet. */
function normaliseerIssue(it) {
  it = it && typeof it === "object" ? it : {};
  const o = schema.leegIssue();
  for (const veld of schema.issueVelden()) {
    const def = schema.ISSUE[veld];
    const v = String(it[veld] == null ? "" : it[veld]).trim();
    if (def.type === "keuze") { if (def.opties.includes(v)) o[veld] = v; }
    else o[veld] = v;
  }
  if (!o.apparaat && it.model) o.apparaat = String(it.model).trim();
  if (!o.symptoomKlant && it.symptoom) o.symptoomKlant = String(it.symptoom).trim();
  if (!o.oplossing && it.fix) o.oplossing = String(it.fix).trim();
  if (!o.analyse && it.controle) o.analyse = String(it.controle).trim();
  if (o.rootcause && o.rootcauseStatus === "onbekend") o.rootcauseStatus = "vermoed";
  return o;
}

/* Is het issue leeg (niets ingevuld)? */
function issueIsLeeg(o) {
  return !schema.issueVelden().some((v) => schema.ISSUE[v].type === "tekst" && o[v]);
}

module.exports = {
  key, INDEX_KEY, maak, laad, werkBij, events, alle, alleIds,
  normaliseer, normaliseerIssue, normaliseerStatus, issueIsLeeg,
};
