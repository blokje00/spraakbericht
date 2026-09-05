#!/usr/bin/env node
/* tools/structureer.js — transcript → losse issues in de vorm van schema.js
   (2026-09-05; vervangt split-symptomen.js + structuur-faulttree.js).

   Eén aanroep van het taalmodel. De instructie staat in de taal van de memo
   en eist uitvoer in diezelfde taal; de veldnamen in de JSON zijn technisch
   en taalonafhankelijk (schema.js). Meerdere problemen in één memo worden
   losse issues.

   Gebruik als module:   const { structureer } = require("./structureer");
                         const issues = await structureer(transcript, "de");
   Gebruik als script:   node tools/structureer.js "<transcript>" [nl|de]

   Env: NOUS_API_KEY (of .env.local), TAALDIENST_MODEL, TAALDIENST_URL,
        TAALDIENST_MOCK=1 → geen aanroep naar buiten (voor tests): één issue
        met het transcript als symptoomKlant. */
const fs = require("fs");
const path = require("path");
const schema = require("../schema");

(function laadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const URL_ = process.env.TAALDIENST_URL || "https://inference-api.nousresearch.com/v1/chat/completions";
const MODEL = process.env.TAALDIENST_MODEL || "deepseek/deepseek-v4-flash-0731";
const KEY = (process.env.NOUS_API_KEY || "").trim();
const MOCK = process.env.TAALDIENST_MOCK === "1";

/* Uitleg per veld voor het model, in de taal van de memo. */
const VELD_UITLEG = {
  nl: {
    apparaat: "bij welk apparaat de monteur stond (model, type, serienummer of plek)",
    symptoomKlant: "wat de klant meldde",
    symptoomMonteur: "wat de monteur zelf waarnam",
    analyse: "wat de monteur onderzocht en concludeerde",
    oplossing: "wat de monteur gedaan heeft om het op te lossen",
    rootcauseStatus: "vastgesteld | vermoed | onbekend — is de echte oorzaak met zekerheid gevonden?",
    rootcause: "de echte oorzaak, als die genoemd wordt",
    opgelost: "ja | deels | nee | onbekend — is het probleem opgelost?",
  },
  de: {
    apparaat: "an welchem Gerät der Monteur stand (Modell, Typ, Seriennummer oder Ort)",
    symptoomKlant: "was der Kunde gemeldet hat",
    symptoomMonteur: "was der Monteur selbst beobachtet hat",
    analyse: "was der Monteur untersucht und geschlossen hat",
    oplossing: "was der Monteur getan hat, um es zu beheben",
    rootcauseStatus: "vastgesteld | vermoed | onbekend — wurde die eigentliche Ursache sicher gefunden? (vastgesteld = festgestellt, vermoed = vermutet, onbekend = unbekannt)",
    rootcause: "die eigentliche Ursache, falls genannt",
    opgelost: "ja | deels | nee | onbekend — ist das Problem behoben? (deels = teilweise, nee = nein, onbekend = unbekannt)",
  },
};

function bouwPrompt(transcript, taal) {
  const u = VELD_UITLEG[taal] || VELD_UITLEG.nl;
  const velden = schema.issueVelden().map((v) => `  "${v}": ${u[v]}`).join("\n");
  if (taal === "de") {
    return "Du bekommst die Sprachnotiz eines Servicemonteurs (Sunshower, Solarduschen/Infrarot). "
      + "Die Notiz kann MEHRERE getrennte Probleme enthalten: jedes Problem wird ein eigenes Element. "
      + "Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Erklärung, ohne Code-Zaun. Jedes Element hat genau diese Felder:\n{\n" + velden + "\n}\n"
      + "Regeln: Textfelder auf Deutsch, kurz (max. 1–2 Sätze), leer lassen (\"\") wenn nicht genannt; nichts erfinden. "
      + "Die Auswahlfelder rootcauseStatus und opgelost enthalten NUR die angegebenen Schlüsselwörter (nicht übersetzen).\n\nNotiz: " + transcript;
  }
  return "Je krijgt de spraakmemo van een servicemonteur (Sunshower, zonnedouches/infrarood). "
    + "De memo kan MEERDERE losse problemen bevatten: elk probleem wordt een eigen element. "
    + "Antwoord UITSLUITEND met een JSON-array, zonder uitleg, zonder code-fence. Elk element heeft precies deze velden:\n{\n" + velden + "\n}\n"
    + "Regels: tekstvelden in het Nederlands, kort (max. 1–2 zinnen), leeg laten (\"\") als het niet genoemd wordt; niets verzinnen. "
    + "De keuzevelden rootcauseStatus en opgelost bevatten ALLEEN de opgegeven sleutelwoorden.\n\nMemo: " + transcript;
}

/* Haal een JSON-array uit de modeltekst, ook met tekst of code-fence eromheen. */
function parseIssues(raw) {
  const t = String(raw || "").trim();
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a === -1 || b <= a) return [];
  let arr; try { arr = JSON.parse(t.slice(a, b + 1)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const memo = require("../api/_memo");
  return arr.map((it) => memo.normaliseerIssue(it)).filter((it) => !memo.issueIsLeeg(it));
}

function terugval(transcript) {
  const it = schema.leegIssue();
  it.symptoomKlant = String(transcript || "").slice(0, 300);
  return [it];
}

async function structureer(transcript, taal) {
  taal = schema.TALEN[taal] ? taal : "nl";
  if (!transcript || !String(transcript).trim()) return [];
  if (MOCK) return terugval(transcript);
  if (!KEY) throw new Error("geen NOUS_API_KEY (zet hem in .env.local)");
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: bouwPrompt(transcript, taal) }], max_tokens: 2000, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error("taalmodel HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const data = await res.json();
  const choice = (data.choices && data.choices[0]) || {};
  const raw = (choice.message && (choice.message.content || choice.message.reasoning_content)) || "";
  const issues = parseIssues(raw);
  return issues.length ? issues : terugval(transcript);
}

module.exports = { structureer, bouwPrompt, parseIssues };

if (require.main === module) {
  const transcript = process.argv[2] || "";
  const taal = process.argv[3] || "nl";
  if (!transcript) { console.error('gebruik: structureer.js "<transcript>" [nl|de]'); process.exit(2); }
  structureer(transcript, taal).then((issues) => { console.log(JSON.stringify(issues, null, 2)); })
    .catch((e) => { console.error("fout:", e.message); process.exit(1); });
}
