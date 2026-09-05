/* api/_taaldienst.js — één deur naar het taalmodel (Nous Research), gedeeld
   door de Mac-consumer (tools/structureer.js) en de API op Vercel
   (vertalen van opmerkingen en door de monteur bewerkte blokken).

   chat(prompt, {model, maxTokens})  → tekst van het model ("" bij leeg)
   Het model (DeepSeek) is "redenerend": het denkt onzichtbaar na en kan
   daarmee het hele budget opeten (finish_reason "length", gezien 2026-09-05).
   Daarom eerst zónder nadenken (~3 s, betrouwbaar), dan mét nadenken en ruim
   budget. Modellen die de parameter `reasoning` niet kennen (Gemini → HTTP
   400) krijgen dezelfde poging zonder die parameter.

   vertaal(velden, van, naar, {model}) → zelfde vorm terug, teksten vertaald.
   Env: NOUS_API_KEY, TAALDIENST_URL, TAALDIENST_MODEL, TAALDIENST_MOCK=1
   (tests: geen aanroep naar buiten; vertalen geeft de tekst ongewijzigd). */
const schema = require("../schema");

const URL_ = process.env.TAALDIENST_URL || "https://inference-api.nousresearch.com/v1/chat/completions";
const STANDAARD_MODEL = process.env.TAALDIENST_MODEL || "deepseek/deepseek-v4-flash-0731";
const KEY = (process.env.NOUS_API_KEY || "").trim();
const MOCK = process.env.TAALDIENST_MOCK === "1";

function beschikbaar() { return MOCK || !!KEY; }

async function eenKeer(prompt, model, params) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify(Object.assign({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2 }, params)),
  });
  if (!res.ok) throw new Error("taalmodel HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const data = await res.json();
  const choice = (data.choices && data.choices[0]) || {};
  return { tekst: String((choice.message && choice.message.content) || "").trim(), finish: choice.finish_reason || "?", tokens: data.usage && data.usage.completion_tokens };
}

/* Geeft de tekst van het model, of "" als er na twee pogingen niets bruikbaars kwam. */
async function chat(prompt, opties) {
  if (MOCK) return "";
  if (!KEY) throw new Error("geen NOUS_API_KEY (zet hem in .env.local of op Vercel)");
  const model = (opties && opties.model) || STANDAARD_MODEL;
  const max = (opties && opties.maxTokens) || 3000;
  const pogingen = [
    { naam: "zonder nadenken", params: { max_tokens: max, reasoning: { enabled: false } } },
    { naam: "met nadenken", params: { max_tokens: max * 2 } },
  ];
  for (const p of pogingen) {
    let uit;
    try { uit = await eenKeer(prompt, model, p.params); }
    catch (e) {
      if (p.params.reasoning && /HTTP 400/.test(e.message)) { const zonder = Object.assign({}, p.params); delete zonder.reasoning; uit = await eenKeer(prompt, model, zonder); }
      else throw e;
    }
    if (uit.tekst) return uit.tekst;
    console.error(`[taaldienst] ${model} ${p.naam}: leeg antwoord (finish=${uit.finish}, tokens=${uit.tokens})`);
  }
  return "";
}

/* Haal het eerste JSON-object of -array uit modeltekst (ook met tekst/code-fence eromheen). */
function parseJson(raw, open, dicht) {
  const t = String(raw || "");
  const a = t.indexOf(open), b = t.lastIndexOf(dicht);
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

/* Vertaal een object/array van strings (geneste structuur blijft gelijk).
   Alleen tekstvelden worden vertaald; keuzewoorden (vastgesteld, ja, …) en
   lege strings blijven staan. Mislukt het, dan komt de invoer ongewijzigd terug. */
async function vertaal(velden, van, naar, opties) {
  if (van === naar || MOCK || !KEY) return velden;
  const uitzonderingen = new Set();
  for (const v of schema.issueVelden()) if (schema.ISSUE[v].type === "keuze") schema.ISSUE[v].opties.forEach((o) => uitzonderingen.add(o));
  const prompt = "Vertaal de tekstwaarden in deze JSON van het " + schema.taalNaam(van) + " naar het " + schema.taalNaam(naar)
    + ". Geef EXACT dezelfde JSON-structuur terug met dezelfde sleutels, alleen de tekstwaarden vertaald. Laat lege strings leeg. "
    + "Vertaal deze sleutelwoorden NIET: " + Array.from(uitzonderingen).join(", ") + ". Serienummers, namen en adressen letterlijk laten. "
    + "Antwoord UITSLUITEND met de JSON.\n\n" + JSON.stringify(velden);
  const raw = await chat(prompt, Object.assign({ maxTokens: 3000 }, opties || {}));
  const uit = Array.isArray(velden) ? parseJson(raw, "[", "]") : parseJson(raw, "{", "}");
  return uit || velden;
}

module.exports = { chat, vertaal, parseJson, beschikbaar, STANDAARD_MODEL, MOCK };
