#!/usr/bin/env node
/* ============================================================
   tools/split-symptomen.js — Deel 2 (stap 4b) van het routing-plan.
   ------------------------------------------------------------
   2026-08-25: een monteur noemt vaak MEERDERE symptomen in één memo
   ("dit fout én dat fout én nog een symptoom"). Deze tool splitst één
   transcript op in losse issues, elk met eigen Model/Symptoom/Analyse/
   Fix/Controle, zodat elk issue apart kan worden goedgekeurd en apart
   naar de diagnose-app kan worden doorgestuurd.

   Hij doet twee dingen in één run:
     1. Roept structuur-faulttree.js aan voor de SAMENGEVOEGDE structuur
        (rec.structuur — backward-compat: review.html toont die als er
        geen issues zijn).
     2. Vraagt het taalmodel om de tekst op te splitsen in losse issues
        en levert per issue Model/Symptoom/Analyse/Fix/Controle op als
        JSON-array (rec.issues).

   Gebruik:
     node tools/split-symptomen.js "<transcript>" ["<boek-context>"]

   Output (stdout): één JSON-object
     {
       "structuur": "Model: ...\nSymptoom: ...",   // samengevoegd (of null)
       "issues": [ { model, symptoom, analyse, fix, controle }, ... ]
     }

   Taalmodel: Nous (inference-api.nousresearch.com) via NOUS_API_KEY,
   zelfde aanpak als structuur-faulttree.js (max_tokens, korte prompt).
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
  console.error("gebruik: split-symptomen.js \"<transcript>\" [\"<boek-context>\"]");
  process.exit(2);
}
if (!KEY || KEY === "[SENSITIVE]") {
  console.error("geen NOUS_API_KEY — stel hem in (of .env.local)");
  process.exit(2);
}

/* ── Roep structuur-faulttree.js aan voor de samengevoegde structuur.
   Niet-blokkerend: bij falen blijft structuur null (approve kan dan alsnog
   met de rauwe tekst of de losse issues doorsturen). ── */
function samengevoegdeStructuur() {
  const script = path.join(__dirname, "structuur-faulttree.js");
  if (!fs.existsSync(script)) return null;
  try {
    const args = [script, transcript];
    if (boekContext) args.push(boekContext);
    const out = execFileSync(process.execPath, args, { encoding: "utf8", timeout: 90000 });
    const s = String(out || "").trim();
    return s && !s.startsWith("[lege response") ? s : null;
  } catch (e) {
    return null; // structuur is optioneel, geen harde eis
  }
}

/* ── Prompt voor de splitsing. Kort + een extra tokenbudget (issues zijn
   meerdere structuren in één JSON-array): deepseek-v4-flash-0731 is een
   reasoning-model en verzuimt content bij lange prompts (PLAN §4). ── */
function bouwSplitPrompt(tekst, context) {
  let kort = "";
  if (context) { kort = "Context: " + String(context).slice(0, 300) + ". "; }
  return kort
    + "Deze monteur-melding kan MEERDERE losse symptomen bevatten. Splits hem op in losse issues. Geef uitsluitend een JSON-array terug, elk element met de velden model, symptoom, analyse, fix, controle (max 1 regel per veld, slecht Nederlands). Eén symptoom = array met 1 element. Melding: " + tekst;
}

/* Haal een geldige JSON-array uit de model-response, ook als het model er
   tekst of een code-fence omheen zet. Fallback: één issue met de hele melding. */
function parseIssues(raw) {
  if (!raw) return [];
  const t = String(raw).trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  let arr = null;
  if (start !== -1 && end > start) {
    try { arr = JSON.parse(t.slice(start, end + 1)); } catch (e) { arr = null; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((it) => {
    const o = (it && typeof it === "object") ? it : {};
    return {
      model: String(o.model || "").trim(),
      symptoom: String(o.symptoom || "").trim(),
      analyse: String(o.analyse || "").trim(),
      fix: String(o.fix || "").trim(),
      controle: String(o.controle || "").trim()
    };
  }).filter((it) => it.symptoom || it.model); // lege elementen eruit
}

async function main() {
  const structuur = samengevoegdeStructuur();
  let issues = [];
  try {
    const res = await fetch(NOUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: bouwSplitPrompt(transcript, boekContext) }],
        max_tokens: 1600,
        temperature: 0.3
      })
    });
    if (!res.ok) throw new Error("taalmodel-fout HTTP " + res.status);
    const data = await res.json();
    const choice = (data.choices && data.choices[0]) || {};
    const raw = (choice.message && (choice.message.content || choice.message.reasoning_content)) || "";
    issues = parseIssues(raw);
  } catch (e) {
    console.error("splitsen mislukt:", e && e.message);
  }
  // Geen bruikbaar issue? Val terug op één issue met de samengevoegde structuur
  // of de rauwe tekst, zodat approve nooit leeg doorstuurt.
  if (!issues.length) {
    if (structuur) {
      const m = {};
      for (const line of structuur.split(/\r?\n/)) {
        const mm = line.match(/^(Model|Symptoom|Analyse|Fix|Controle):\s*(.+)$/i);
        if (mm) m[mm[1].toLowerCase()] = mm[2].trim();
      }
      if (m.symptoom || m.model) issues.push(m);
    }
    if (!issues.length) issues.push({ model: "", symptoom: transcript.slice(0, 300), analyse: "", fix: "", controle: "" });
  }
  console.log(JSON.stringify({ structuur: structuur || null, issues }));
  process.exit(0);
}

main().catch((e) => { console.error("fout:", e.message); process.exit(1); });
