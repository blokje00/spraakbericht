/* api/_monteur.js — wie is de monteur (2026-09-05, fase 4).
   ------------------------------------------------------------
   Vaste lijst monteurs in Redis. Een monteur logt eenmalig in met naam +
   persoonlijke code; de app bewaart daarna een token. De server leidt de
   monteur af uit het token, nooit uit wat de app in de body meestuurt.

   Sleutels (prefix b:inbox:):
     monteur:<id>          {id, naam, taal, codeHash, aangemaaktOp}
     monteurs              SET van id's
     monteurnaam:<naam>    id (lowercase naam → id, voor login)
     monteurtoken:<token>  id
   ------------------------------------------------------------ */
const crypto = require("crypto");
const { cmd, boekKey } = require("./_redis");

const BOEK = "inbox";
const k = (s) => boekKey(BOEK, s);

function hashCode(code) {
  return crypto.createHash("sha256").update("spraakbericht:" + String(code)).digest("hex");
}
function slug(naam) {
  return String(naam || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

async function laad(id) {
  const raw = id ? await cmd(["GET", k("monteur:" + id)]) : null;
  return raw ? JSON.parse(raw) : null;
}

/* Publieke vorm (zonder codeHash). */
function publiek(m) {
  return m ? { id: m.id, naam: m.naam, taal: m.taal, aangemaaktOp: m.aangemaaktOp } : null;
}

async function alle() {
  const ids = (await cmd(["SMEMBERS", k("monteurs")])) || [];
  const uit = [];
  for (const id of ids) { const m = await laad(id); if (m) uit.push(publiek(m)); }
  uit.sort((a, b) => a.naam.localeCompare(b.naam));
  return uit;
}

/* Maak of werk een monteur bij (admin). code leeg = ongewijzigd laten. */
async function bewaar({ naam, code, taal, id }) {
  naam = String(naam || "").trim().slice(0, 80);
  if (!naam) throw new Error("naam ontbreekt");
  taal = taal === "de" ? "de" : "nl";
  id = id || slug(naam);
  if (!id) throw new Error("naam levert geen geldig id op");
  const bestaand = await laad(id);
  if (!bestaand && !code) throw new Error("code ontbreekt voor nieuwe monteur");
  const m = bestaand || { id, aangemaaktOp: new Date().toISOString() };
  if (bestaand && bestaand.naam !== naam) await cmd(["DEL", k("monteurnaam:" + bestaand.naam.toLowerCase())]);
  m.naam = naam; m.taal = taal;
  if (code) m.codeHash = hashCode(code);
  await cmd(["SET", k("monteur:" + id), JSON.stringify(m)]);
  await cmd(["SADD", k("monteurs"), id]);
  await cmd(["SET", k("monteurnaam:" + naam.toLowerCase()), id]);
  return publiek(m);
}

/* Login: naam + code → token. Geeft null bij een verkeerde combinatie. */
async function login(naam, code) {
  const id = await cmd(["GET", k("monteurnaam:" + String(naam || "").trim().toLowerCase())]);
  const m = await laad(id);
  if (!m || !code || m.codeHash !== hashCode(code)) return null;
  const token = crypto.randomBytes(24).toString("base64url");
  await cmd(["SET", k("monteurtoken:" + token), m.id]);
  await cmd(["SADD", k("monteurtokens:" + m.id), token]);
  return { token, monteur: publiek(m) };
}

/* Monteur uit het Bearer-token van een request, of null. */
async function vanRequest(req) {
  const h = (req.headers && req.headers.authorization) || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || token.length > 200) return null;
  const id = await cmd(["GET", k("monteurtoken:" + token)]);
  return publiek(await laad(id));
}

module.exports = { laad, alle, bewaar, login, vanRequest, publiek, slug };
