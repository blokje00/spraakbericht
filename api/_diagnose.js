/* api/_diagnose.js — doorsturen naar de diagnose-app (2026-09-05).
   ------------------------------------------------------------
   Eén issue → één import in de diagnose-app (boek 'wachtkamer' of een
   ander gekozen boek, nooit 'sunshower'). De tekst volgt de rail die de
   diagnose-app al kent (Model → Symptoom → Analyse → Fix → Controle); de
   sleutelwoorden zijn het protocol en blijven Nederlands, de inhoud staat
   in de taal van de memo. Zie KOPPELING.md.
   ------------------------------------------------------------ */
const schema = require("../schema");

const DIAGNOSE_API_BASE = process.env.DIAGNOSE_API_BASE || "https://sunshower-diagnose.vercel.app";
const DIAGNOSE_ADMIN_TOKEN = process.env.DIAGNOSE_ADMIN_TOKEN || "";
const STANDAARD_DOELBOEK = process.env.DOELBOEK || "wachtkamer";
const BESCHERMD_BOEK = "sunshower"; // het echte handboek: nooit een bestemming

function geconfigureerd() { return !!DIAGNOSE_ADMIN_TOKEN; }

function geldigDoelBoek(v) {
  if (typeof v !== "string") return false;
  const b = v.trim();
  return !!b && b.length <= 60 && /^[a-zA-Z0-9_-]+$/.test(b) && b !== BESCHERMD_BOEK;
}

function kiesDoelBoek(gevraagd) {
  if (gevraagd !== undefined && gevraagd !== null && String(gevraagd).trim() !== "") {
    if (String(gevraagd).trim().toLowerCase() === BESCHERMD_BOEK) {
      throw new Error(BESCHERMD_BOEK + " mag nooit het doel-boek zijn — kies een apart boek");
    }
    if (geldigDoelBoek(gevraagd)) return gevraagd.trim();
  }
  if (!geldigDoelBoek(STANDAARD_DOELBOEK)) throw new Error("DOELBOEK is ongeldig of " + BESCHERMD_BOEK);
  return STANDAARD_DOELBOEK;
}

function sanitizeNaam(s) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/* Issue → faulttree-tekst, één regel per stap. Lege stappen blijven weg. */
function issueNaarTekst(it, taal) {
  const L = schema.ISSUE;
  const rc = L.rootcauseStatus.optieLabel[taal] || L.rootcauseStatus.optieLabel.nl;
  const op = L.opgelost.optieLabel[taal] || L.opgelost.optieLabel.nl;
  const symptoom = [
    it.symptoomKlant ? (taal === "de" ? "Kunde: " : "Klant: ") + it.symptoomKlant : "",
    it.symptoomMonteur ? (taal === "de" ? "Monteur: " : "Monteur: ") + it.symptoomMonteur : "",
  ].filter(Boolean).join(" / ");
  const ot = L.oorzaakType.optieLabel[taal] || L.oorzaakType.optieLabel.nl;
  const controle = [
    it.rootcause ? (taal === "de" ? "Ursache" : "Oorzaak") + " (" + rc[it.rootcauseStatus] + "): " + it.rootcause : "",
    it.oorzaakType && it.oorzaakType !== "onbekend" ? (taal === "de" ? "Art: " : "Soort: ") + ot[it.oorzaakType] : "",
    it.opgelost !== "onbekend" ? (taal === "de" ? "Behoben: " : "Opgelost: ") + op[it.opgelost] : "",
  ].filter(Boolean).join(" / ");
  const rijen = [["Model", it.apparaat], ["Symptoom", symptoom], ["Analyse", it.analyse], ["Fix", it.oplossing], ["Controle", controle]];
  return rijen.filter((r) => r[1]).map((r) => r[0] + ": " + r[1]).join("\n");
}

/* Stuur alle issues van een memo door. Geeft per issue {issue, status, treeId, naam, body}. */
async function stuurDoor(rec, doelBoek, audioUrl) {
  const issues = rec.issues.length ? rec.issues : [{ symptoomKlant: String(rec.transcript || "").slice(0, 300) }];
  const uit = [];
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    /* De getypte aanvulling van de monteur (serienummer, adres, …) gaat altijd
       letterlijk mee als toelichting, los van wat het taalmodel ervan maakte. */
    const toelichting = rec.tekst ? "\n" + (rec.taal === "de" ? "Toelichting: " : "Toelichting: ") + String(rec.tekst).replace(/\s+/g, " ").trim() : "";
    const inhoud = (issueNaarTekst(it, rec.taal) || String(rec.transcript || "")) + toelichting;
    const naam = sanitizeNaam(rec.monteur) + " — " + (sanitizeNaam(it.symptoomKlant || it.symptoomMonteur || it.apparaat) || "zonder symptoom");
    let status = 0, body = "", treeId = null;
    try {
      const r = await fetch(DIAGNOSE_API_BASE + "/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + DIAGNOSE_ADMIN_TOKEN },
        body: JSON.stringify({
          soort: "tekst", inhoud, naam, boek: doelBoek, lang: rec.taal,
          spraakbericht: { id: rec.id, issue: i, monteur: rec.monteur, monteurId: rec.monteurId, audioUrl, taal: rec.taal },
        }),
      });
      status = r.status;
      body = (await r.text()).slice(0, 500);
      try { treeId = JSON.parse(body).treeId || null; } catch (e) { /* geen JSON */ }
    } catch (e) {
      status = 0; body = "fout: " + (e && e.message);
    }
    uit.push({ issue: i, status, treeId, naam, body, op: new Date().toISOString() });
  }
  return uit;
}

module.exports = { geconfigureerd, kiesDoelBoek, geldigDoelBoek, issueNaarTekst, stuurDoor, DIAGNOSE_API_BASE, BESCHERMD_BOEK };
