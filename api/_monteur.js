/* api/_monteur.js — wie is de monteur (2026-09-05, fase 4).
   ------------------------------------------------------------
   De supervisor maakt monteurs aan (naam + taal) in review.html. De monteur
   kiest in de app zijn naam uit de lijst en kiest de eerste keer een
   pincode van vier cijfers: dat is "activeren". Daarna logt hij in met naam
   + pincode; de app bewaart een token. De server leidt de monteur af uit het
   token, nooit uit wat de app in de body meestuurt. De supervisor kan naam
   en taal wijzigen en de pincode resetten (monteur kiest dan opnieuw).

   Sleutels (prefix b:inbox:):
     monteur:<id>          {id, naam, taal, codeHash, aangemaaktOp}
     monteurs              SET van id's
     monteurnaam:<naam>    id (lowercase naam → id, voor login)
     monteurtoken:<token>  id
   ------------------------------------------------------------ */
const crypto = require("crypto");
const { cmd, boekKey } = require("./_redis");
const schema = require("../schema");

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
  return m ? { id: m.id, naam: m.naam, taal: m.taal, geactiveerd: !!m.codeHash, aangemaaktOp: m.aangemaaktOp } : null;
}

/* Publieke lijst voor het inlogscherm: alleen naam, taal en of de naam al in
   gebruik is. Geen id's of toestellen. */
async function lijst() {
  const ids = (await cmd(["SMEMBERS", k("monteurs")])) || [];
  const uit = [];
  for (const id of ids) { const m = await laad(id); if (m) uit.push({ naam: m.naam, taal: m.taal, geactiveerd: !!m.codeHash }); }
  uit.sort((a, b) => a.naam.localeCompare(b.naam));
  return uit;
}

async function alle() {
  const ids = (await cmd(["SMEMBERS", k("monteurs")])) || [];
  const uit = [];
  for (const id of ids) {
    const m = await laad(id);
    if (!m) continue;
    const p = publiek(m);
    p.pushToestellen = Number(await cmd(["SCARD", k("push:" + id)])) || 0; // aangemelde toestellen voor meldingen
    uit.push(p);
  }
  uit.sort((a, b) => a.naam.localeCompare(b.naam));
  return uit;
}

/* Maak of werk een monteur bij (admin). Zonder id: nieuw (of bijwerken op
   naam). Met id: naam/taal wijzigen. code leeg = ongewijzigd; reset = pincode
   weg, monteur kiest opnieuw bij de volgende login (tokens vervallen). */
async function bewaar({ naam, code, taal, id, reset }) {
  naam = String(naam || "").trim().slice(0, 80);
  if (!naam) throw new Error("naam ontbreekt");
  id = id || slug(naam);
  if (!id) throw new Error("naam levert geen geldig id op");
  const bestaand = await laad(id);
  taal = schema.isTaal(taal) ? taal : (bestaand ? bestaand.taal : "nl");
  const anderMetNaam = await idVanNaam(naam);
  if (anderMetNaam && anderMetNaam !== id) throw new Error("die naam is al in gebruik door een andere monteur");
  const m = bestaand || { id, aangemaaktOp: new Date().toISOString() };
  if (bestaand && bestaand.naam !== naam) await cmd(["DEL", k("monteurnaam:" + bestaand.naam.toLowerCase())]);
  m.naam = naam; m.taal = taal;
  if (code) m.codeHash = hashCode(code);
  if (reset) { delete m.codeHash; await vergeetTokens(id); }
  await cmd(["SET", k("monteur:" + id), JSON.stringify(m)]);
  await cmd(["SADD", k("monteurs"), id]);
  await cmd(["SET", k("monteurnaam:" + naam.toLowerCase()), id]);
  return publiek(m);
}

async function idVanNaam(naam) {
  return cmd(["GET", k("monteurnaam:" + String(naam || "").trim().toLowerCase())]);
}

/* Alle tokens van een monteur ongeldig maken (bij reset van de pincode). */
async function vergeetTokens(id) {
  const tokens = (await cmd(["SMEMBERS", k("monteurtokens:" + id)])) || [];
  for (const t of tokens) await cmd(["DEL", k("monteurtoken:" + t)]);
  await cmd(["DEL", k("monteurtokens:" + id)]);
}

async function maakToken(m) {
  const token = crypto.randomBytes(24).toString("base64url");
  await cmd(["SET", k("monteurtoken:" + token), m.id]);
  await cmd(["SADD", k("monteurtokens:" + m.id), token]);
  return { token, monteur: publiek(m) };
}

/* Pincode: precies vier cijfers. */
function geldigePincode(code) { return /^\d{4}$/.test(String(code || "")); }

/* Activeren: een door de supervisor aangemaakte naam de eerste keer een
   pincode geven. Alleen als de naam nog geen pincode heeft. Geeft een token. */
async function activeer({ naam, code }) {
  const m = await laad(await idVanNaam(naam));
  if (!m) throw new Error("onbekende naam — vraag de supervisor je aan te maken");
  if (m.codeHash) throw new Error("deze naam is al geactiveerd — log in met je pincode");
  if (!geldigePincode(code)) throw new Error("pincode moet uit vier cijfers bestaan");
  m.codeHash = hashCode(code);
  await cmd(["SET", k("monteur:" + m.id), JSON.stringify(m)]);
  return maakToken(m);
}

/* Login: naam + code → token. Geeft null bij een verkeerde combinatie. */
async function login(naam, code) {
  const m = await laad(await idVanNaam(naam));
  if (!m || !code || m.codeHash !== hashCode(code)) return null;
  return maakToken(m);
}

/* Monteur uit het Bearer-token van een request, of null. */
async function vanRequest(req) {
  const h = (req.headers && req.headers.authorization) || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || token.length > 200) return null;
  const id = await cmd(["GET", k("monteurtoken:" + token)]);
  return publiek(await laad(id));
}

module.exports = { laad, alle, lijst, bewaar, activeer, login, vanRequest, publiek, slug, geldigePincode };
