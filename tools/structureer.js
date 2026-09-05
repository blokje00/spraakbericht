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

/* Prompt per taal. Eén sjabloon per taal (zinnen), plus per veld één uitleg.
   De keuzewoorden (vastgesteld, productiefout, ja, …) zijn technisch en blijven
   in elke taal gelijk; de uitleg zegt dat erbij. Nieuwe taal = hier een blok. */
const PROMPT = {
  nl: {
    intro: "Je krijgt de spraakmemo van een servicemonteur (Sunshower, zonnedouches/infrarood). De memo kan MEERDERE losse problemen bevatten: elk probleem wordt een eigen element. Antwoord UITSLUITEND met een JSON-array, zonder uitleg, zonder code-fence. Elk element heeft precies deze velden:",
    regels: "Regels: tekstvelden in het Nederlands, kort (max. 1–2 zinnen), leeg laten (\"\") als het niet genoemd wordt; niets verzinnen. Serienummers, klantnamen en adressen ALTIJD letterlijk in apparaat overnemen (ook uit de aanvulling). De keuzevelden rootcauseStatus, oorzaakType en opgelost bevatten ALLEEN de opgegeven sleutelwoorden.",
    aanvulling: "Getypte aanvulling van de monteur (telt even zwaar als de memo): ",
    memo: "Memo: ",
    velden: {
      apparaat: "bij welk apparaat de monteur stond: model/type, en serienummer, klantnaam of adres LETTERLIJK overnemen als die genoemd worden",
      symptoomKlant: "wat de klant meldde",
      symptoomMonteur: "wat de monteur zelf waarnam",
      analyse: "wat de monteur onderzocht en concludeerde",
      oplossing: "wat de monteur gedaan heeft om het op te lossen",
      rootcauseStatus: "vastgesteld | vermoed | onbekend — is de echte oorzaak met zekerheid gevonden?",
      rootcause: "de echte oorzaak, als die genoemd wordt",
      oorzaakType: "productiefout | installatiefout | gebruikersfout | onbekend — lag de oorzaak bij de fabriek (defect onderdeel), bij de installatie (verkeerd aangesloten/gemonteerd) of bij de gebruiker (verkeerd gebruik)? Alleen kiezen als het duidelijk uit de melding volgt",
      opgelost: "ja | deels | nee | onbekend — is het probleem opgelost?",
    },
  },
  de: {
    intro: "Du bekommst die Sprachnotiz eines Servicemonteurs (Sunshower, Solarduschen/Infrarot). Die Notiz kann MEHRERE getrennte Probleme enthalten: jedes Problem wird ein eigenes Element. Antworte AUSSCHLIESSLICH mit einem JSON-Array, ohne Erklärung, ohne Code-Zaun. Jedes Element hat genau diese Felder:",
    regels: "Regeln: Textfelder auf Deutsch, kurz (max. 1–2 Sätze), leer lassen (\"\") wenn nicht genannt; nichts erfinden. Seriennummern, Kundennamen und Adressen IMMER wörtlich in apparaat übernehmen (auch aus der Ergänzung). Die Auswahlfelder rootcauseStatus, oorzaakType und opgelost enthalten NUR die angegebenen Schlüsselwörter (nicht übersetzen).",
    aanvulling: "Getippte Ergänzung des Monteurs (gleichwertig zur Notiz): ",
    memo: "Notiz: ",
    velden: {
      apparaat: "an welchem Gerät der Monteur stand: Modell/Typ, und Seriennummer, Kundenname oder Adresse WÖRTLICH übernehmen, falls genannt",
      symptoomKlant: "was der Kunde gemeldet hat",
      symptoomMonteur: "was der Monteur selbst beobachtet hat",
      analyse: "was der Monteur untersucht und geschlossen hat",
      oplossing: "was der Monteur getan hat, um es zu beheben",
      rootcauseStatus: "vastgesteld | vermoed | onbekend — wurde die eigentliche Ursache sicher gefunden? (vastgesteld = festgestellt, vermoed = vermutet, onbekend = unbekannt)",
      rootcause: "die eigentliche Ursache, falls genannt",
      oorzaakType: "productiefout | installatiefout | gebruikersfout | onbekend — lag die Ursache beim Werk (defektes Teil, productiefout), bei der Installation (falsch angeschlossen/montiert, installatiefout) oder beim Benutzer (Fehlbedienung, gebruikersfout)? Nur wählen, wenn es klar aus der Notiz folgt; Schlüsselwörter nicht übersetzen",
      opgelost: "ja | deels | nee | onbekend — ist das Problem behoben? (deels = teilweise, nee = nein, onbekend = unbekannt)",
    },
  },
  fr: {
    intro: "Tu reçois le mémo vocal d'un technicien de service (Sunshower, douches solaires/infrarouge). Le mémo peut contenir PLUSIEURS problèmes distincts : chaque problème devient un élément séparé. Réponds UNIQUEMENT par un tableau JSON, sans explication, sans balise de code. Chaque élément a exactement ces champs :",
    regels: "Règles : champs texte en français, courts (1–2 phrases max.), vides (\"\") si non mentionnés ; ne rien inventer. Numéros de série, noms de clients et adresses TOUJOURS repris mot pour mot dans apparaat (aussi depuis le complément). Les champs à choix rootcauseStatus, oorzaakType et opgelost contiennent UNIQUEMENT les mots-clés indiqués (ne pas traduire).",
    aanvulling: "Complément tapé par le technicien (même poids que le mémo) : ",
    memo: "Mémo : ",
    velden: {
      apparaat: "devant quel appareil le technicien se trouvait : modèle/type, et numéro de série, nom du client ou adresse repris MOT POUR MOT s'ils sont mentionnés",
      symptoomKlant: "ce que le client a signalé",
      symptoomMonteur: "ce que le technicien a constaté lui-même",
      analyse: "ce que le technicien a examiné et conclu",
      oplossing: "ce que le technicien a fait pour résoudre le problème",
      rootcauseStatus: "vastgesteld | vermoed | onbekend — la cause réelle a-t-elle été trouvée avec certitude ? (vastgesteld = établie, vermoed = présumée, onbekend = inconnue)",
      rootcause: "la cause réelle, si elle est mentionnée",
      oorzaakType: "productiefout | installatiefout | gebruikersfout | onbekend — la cause vient-elle de l'usine (pièce défectueuse, productiefout), de l'installation (mal raccordé/monté, installatiefout) ou de l'utilisateur (mauvaise utilisation, gebruikersfout) ? Choisir seulement si cela ressort clairement du mémo ; ne pas traduire les mots-clés",
      opgelost: "ja | deels | nee | onbekend — le problème est-il résolu ? (ja = oui, deels = en partie, nee = non, onbekend = inconnu)",
    },
  },
  id: {
    intro: "Anda menerima memo suara dari seorang teknisi servis (Sunshower, shower surya/inframerah). Memo bisa berisi BEBERAPA masalah terpisah: setiap masalah menjadi elemen tersendiri. Jawab HANYA dengan array JSON, tanpa penjelasan, tanpa code fence. Setiap elemen memiliki tepat kolom-kolom berikut:",
    regels: "Aturan: kolom teks dalam bahasa Indonesia, singkat (maks. 1–2 kalimat), kosongkan (\"\") jika tidak disebutkan; jangan mengarang. Nomor seri, nama pelanggan, dan alamat SELALU disalin apa adanya ke apparaat (juga dari tambahan). Kolom pilihan rootcauseStatus, oorzaakType, dan opgelost HANYA berisi kata kunci yang diberikan (jangan diterjemahkan).",
    aanvulling: "Tambahan yang diketik teknisi (sama pentingnya dengan memo): ",
    memo: "Memo: ",
    velden: {
      apparaat: "di perangkat mana teknisi berada: model/tipe, dan nomor seri, nama pelanggan, atau alamat disalin APA ADANYA jika disebutkan",
      symptoomKlant: "apa yang dilaporkan pelanggan",
      symptoomMonteur: "apa yang diamati teknisi sendiri",
      analyse: "apa yang diperiksa dan disimpulkan teknisi",
      oplossing: "apa yang dilakukan teknisi untuk mengatasinya",
      rootcauseStatus: "vastgesteld | vermoed | onbekend — apakah penyebab sebenarnya sudah dipastikan? (vastgesteld = dipastikan, vermoed = diduga, onbekend = tidak diketahui)",
      rootcause: "penyebab sebenarnya, jika disebutkan",
      oorzaakType: "productiefout | installatiefout | gebruikersfout | onbekend — apakah penyebabnya dari pabrik (komponen cacat, productiefout), pemasangan (salah sambung/pasang, installatiefout), atau pengguna (salah pakai, gebruikersfout)? Pilih hanya jika jelas dari memo; jangan terjemahkan kata kunci",
      opgelost: "ja | deels | nee | onbekend — apakah masalah teratasi? (ja = ya, deels = sebagian, nee = tidak, onbekend = tidak diketahui)",
    },
  },
};

function bouwPrompt(transcript, taal, aanvulling) {
  const p = PROMPT[taal] || PROMPT.nl;
  const velden = schema.issueVelden().map((v) => `  "${v}": ${p.velden[v]}`).join("\n");
  const extra = aanvulling ? p.aanvulling + aanvulling + "\n\n" : "";
  return p.intro + "\n{\n" + velden + "\n}\n" + p.regels + "\n\n" + extra + p.memo + transcript;
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

/* Eén aanroep. `extra` = extra velden in het verzoek (max_tokens, reasoning).
   Geeft { issues, finish, tokens }. */
async function vraag(transcript, taal, extra, model) {
  const { aanvulling, ...params } = extra;
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify(Object.assign({ model: model || MODEL, messages: [{ role: "user", content: bouwPrompt(transcript, taal, aanvulling) }], temperature: 0.2 }, params)),
  });
  if (!res.ok) throw new Error("taalmodel HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const data = await res.json();
  const choice = (data.choices && data.choices[0]) || {};
  const raw = (choice.message && choice.message.content) || "";
  return { issues: parseIssues(raw), finish: choice.finish_reason || "?", tokens: data.usage && data.usage.completion_tokens };
}

/* Het model (DeepSeek, een "redenerend" model) denkt eerst onzichtbaar na en
   antwoordt dan. Dat nadenken kan het hele tokenbudget opeten, waarna het
   antwoord leeg is (finish_reason "length", zelfs bij 6000 tokens; gezien op
   2026-09-05). Daarom:
   1. zónder nadenken (~3 s, betrouwbaar; de supervisor en monteur vullen
      ontbrekende velden toch aan in de lus);
   2. lukt dat niet, dan mét nadenken en ruim budget (~30 s);
   3. lukt ook dat niet, één issue met het transcript — en dat wordt gelogd. */
async function structureer(transcript, taal, opties) {
  taal = schema.TALEN[taal] ? taal : "nl";
  const model = (opties && opties.model) || MODEL;
  const aanvulling = String((opties && opties.aanvulling) || "").trim().slice(0, 1000);
  if (!transcript || !String(transcript).trim()) return [];
  if (MOCK) { const t = terugval(transcript); if (aanvulling) t[0].apparaat = aanvulling; return t; }
  if (!KEY) throw new Error("geen NOUS_API_KEY (zet hem in .env.local)");
  const pogingen = [
    { naam: "zonder nadenken", extra: { max_tokens: 3000, reasoning: { enabled: false } } },
    { naam: "met nadenken", extra: { max_tokens: 6000 } },
  ];
  for (const p of pogingen) {
    let uit;
    try {
      uit = await vraag(transcript, taal, p.extra, model);
    } catch (e) {
      /* Niet elk model kent de parameter `reasoning` (Gemini geeft dan HTTP 400):
         dezelfde poging nog eens zonder die parameter. */
      if (p.extra.reasoning && /HTTP 400/.test(e.message)) {
        const zonder = Object.assign({ aanvulling }, p.extra); delete zonder.reasoning;
        uit = await vraag(transcript, taal, zonder, model);
      } else throw e;
    }
    if (uit.issues.length) return uit.issues;
    console.error(`[structureer] ${model} ${p.naam}: geen bruikbaar antwoord (finish=${uit.finish}, tokens=${uit.tokens})`);
  }
  console.error("[structureer] terugval: één issue met het hele transcript");
  return terugval(transcript);
}

module.exports = { structureer, bouwPrompt, parseIssues, STANDAARD_MODEL: MODEL, PROMPT };

if (require.main === module) {
  const transcript = process.argv[2] || "";
  const taal = process.argv[3] || "nl";
  const model = process.argv[4] || undefined;
  if (!transcript) { console.error('gebruik: structureer.js "<transcript>" [nl|de] [model]'); process.exit(2); }
  structureer(transcript, taal, { model }).then((issues) => { console.log(JSON.stringify(issues, null, 2)); })
    .catch((e) => { console.error("fout:", e.message); process.exit(1); });
}
