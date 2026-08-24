#!/usr/bin/env node
/* ============================================================
   tools/structuur-faulttree.js — Deel 1 van het routing-plan.
   Zet een monteur-transcript om naar een gestructureerde
   faulttree-input: Model → Symptoom → Analyse → Fix → Controle,
   met het bestaande boek als context.

   Gebruik:
     node tools/structuur-faulttree.js "<transcript>" ["<boek-context>"]

   Output: genummerde regels op stdout, zo opgemaakt dat de
   bestaande tekstNaarKaarten-heuristiek van de diagnose-app er
   een vertakte faulttree van maakt:
       - elke regel = één gedachte
       - regels met een vraagteken = beslissing (q-kaart)

   Taalmodel: Nous (inference-api.nousresearch.com) via NOUS_API_KEY
   (uit .env.local of env). Zelfde aanpak als app/api/_taaldienst.js.
   ============================================================ */
const fs = require("fs");
const path = require("path");

/* ── .env.local laden (geen dotenv) ── */
(function laadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const NOUS_URL = "https://inference-api.nousresearch.com/v1/chat/completions";
const KEY = (process.env.NOUS_API_KEY || "").trim();
const MODEL = process.env.TAALDIENST_MODEL || "deepseek/deepseek-v4-flash-0731";

const transcript = process.argv[2] || "";
const boekContext = process.argv[3] || "";

if (!transcript) {
  console.error("gebruik: structuur-faulttree.js \"<transcript>\" [\"<boek-context>\"]");
  process.exit(2);
}
if (!KEY || KEY === "[SENSITIVE]") {
  console.error("geen NOUS_API_KEY — stel hem in (of .env.local)");
  process.exit(2);
}

/* ── Prompt: zet het transcript om naar een gestructureerde
   faulttree-invoer (Model → Symptoom → Analyse → Fix → Controle),
   met het bestaande boek als context.
   Prompt kort gehouden + max_tokens 1024: deepseek-v4-flash-0731 is een
   reasoning-model en verzuimt content bij lange prompts en weinig budget (PLAN §4). ── */
function bouwPrompt(tekst, context) {
  let kort = "";
  if (context) { kort = "Context: " + String(context).slice(0, 300) + ". "; }
  return kort
    + "Zet de monteur-melding om naar Model, Symptoom, Analyse, Fix, Controle. Max 1 regel per stap, slecht Nederlands, geen inleiding. Melding: " + tekst;
}

async function main() {
  const res = await fetch(NOUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: bouwPrompt(transcript, boekContext) }],
      max_tokens: 1024,
      temperature: 0.3
    })
  });
  if (!res.ok) {
    console.error("taalmodel-fout HTTP " + res.status + ": " + (await res.text()).slice(0, 500));
    process.exit(1);
  }
  const data = await res.json();
  const choice = (data.choices && data.choices[0]) || {};
  const raw = (choice.message && (choice.message.content || choice.message.reasoning_content)) || "";
  console.log(raw.trim() || "[lege response van model — nog niet verwerkt]");
  process.exit(raw.trim() ? 0 : 3);
}

main().catch((e) => { console.error("fout:", e.message); process.exit(1); });
