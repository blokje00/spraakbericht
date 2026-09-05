#!/usr/bin/env node
/* tools/structureer.js — transcript → blokken (issues) in het NEDERLANDS,
   plus een vertaling voor de monteur in zijn eigen taal (2026-09-05).

   Afspraak (Patrick): de monteur spreekt in zijn eigen taal in en ziet zijn
   eigen taal terug; alles wat naar de supervisor en de wachtkamer gaat is
   Nederlands. Eén aanroep van het taalmodel levert daarom:
     transcriptNl   Nederlandse vertaling van het transcript (nl: gelijk)
     aanvullingNl   Nederlandse vertaling van de getypte aanvulling
     issues         de blokken in het Nederlands (schema.js), één per probleem
     issuesVertaald dezelfde blokken in de taal van de monteur (null bij nl)

   Gebruik als module:   const { structureer } = require("./structureer");
                         const uit = await structureer(transcript, "fr", { model, aanvulling });
   Gebruik als script:   node tools/structureer.js "<transcript>" [taal] [model]

   Env: NOUS_API_KEY (of .env.local), TAALDIENST_MODEL, TAALDIENST_URL,
        TAALDIENST_MOCK=1 → geen aanroep naar buiten (tests). */
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
const taaldienst = require("../api/_taaldienst");
const MODEL = taaldienst.STANDAARD_MODEL;

/* Uitleg per veld, voor het model (Nederlands; de uitvoer is Nederlands). */
const VELD_UITLEG = {
  apparaat: "bij welk apparaat de monteur stond: model/type, en serienummer, klantnaam of adres LETTERLIJK overnemen als die genoemd worden",
  symptoomKlant: "wat de klant meldde",
  symptoomMonteur: "wat de monteur zelf waarnam",
  analyse: "wat de monteur onderzocht en concludeerde",
  oplossing: "wat de monteur gedaan heeft om het op te lossen",
  rootcauseStatus: "vastgesteld | vermoed | onbekend — is de echte oorzaak met zekerheid gevonden?",
  rootcause: "de echte oorzaak, als die genoemd wordt",
  oorzaakType: "productiefout | installatiefout | gebruikersfout | onbekend — lag de oorzaak bij de fabriek (defect onderdeel), bij de installatie (verkeerd aangesloten/gemonteerd) of bij de gebruiker (verkeerd gebruik)? Alleen kiezen als het duidelijk uit de melding volgt",
  opgelost: "ja | deels | nee | onbekend — is het probleem opgelost?",
};

function bouwPrompt(transcript, taal, aanvulling) {
  const velden = schema.issueVelden().map((v) => `    "${v}": ${VELD_UITLEG[v]}`).join("\n");
  const anders = taal !== "nl";
  const taalNaam = schema.taalNaam(taal);
  return "Je krijgt de spraakmemo van een servicemonteur (Sunshower, zonnedouches/infrarood)"
    + (anders ? ", ingesproken in het " + taalNaam + "." : ".")
    + " De memo kan MEERDERE losse problemen bevatten: elk probleem wordt een eigen element in \"issues\". "
    + "Antwoord UITSLUITEND met één JSON-object, zonder uitleg, zonder code-fence, met precies deze vorm:\n{\n"
    + "  \"transcriptNl\": " + (anders ? "nauwkeurige Nederlandse vertaling van het transcript (niets weglaten)" : "het transcript ongewijzigd") + ",\n"
    + "  \"aanvullingNl\": " + (anders ? "Nederlandse vertaling van de getypte aanvulling, of \"\"" : "de getypte aanvulling ongewijzigd, of \"\"") + ",\n"
    + "  \"issues\": [ { ...één element per probleem, in het NEDERLANDS, met deze velden:\n" + velden + "\n  } ]"
    + (anders ? ",\n  \"issuesVertaald\": [ dezelfde elementen in dezelfde volgorde, tekstvelden vertaald naar het " + taalNaam + " ]" : "")
    + "\n}\n"
    + "Regels: tekstvelden kort (max. 1–2 zinnen), leeg laten (\"\") als het niet genoemd wordt; niets verzinnen. "
    + "Serienummers, klantnamen en adressen ALTIJD letterlijk in apparaat overnemen (ook uit de aanvulling). "
    + "De keuzevelden rootcauseStatus, oorzaakType en opgelost bevatten ALLEEN de opgegeven Nederlandse sleutelwoorden, in elke taal.\n\n"
    + (aanvulling ? "Getypte aanvulling van de monteur (telt even zwaar als de memo): " + aanvulling + "\n\n" : "")
    + "Transcript: " + transcript;
}

function normaliseerIssues(arr) {
  if (!Array.isArray(arr)) return [];
  const memo = require("../api/_memo");
  return arr.map((it) => memo.normaliseerIssue(it)).filter((it) => !memo.issueIsLeeg(it));
}

function terugval(transcript, taal, aanvulling) {
  const it = schema.leegIssue();
  it.symptoomKlant = String(transcript || "").slice(0, 300);
  if (aanvulling) it.apparaat = aanvulling;
  return { transcriptNl: transcript, aanvullingNl: aanvulling || "", issues: [it], issuesVertaald: taal === "nl" ? null : [Object.assign({}, it)], terugval: true };
}

async function structureer(transcript, taal, opties) {
  taal = schema.isTaal(taal) ? taal : "nl";
  const model = (opties && opties.model) || MODEL;
  const aanvulling = String((opties && opties.aanvulling) || "").trim().slice(0, 1000);
  if (!transcript || !String(transcript).trim()) return { transcriptNl: "", aanvullingNl: aanvulling, issues: [], issuesVertaald: null };
  if (taaldienst.MOCK) return terugval(transcript, taal, aanvulling);
  const raw = await taaldienst.chat(bouwPrompt(transcript, taal, aanvulling), { model, maxTokens: 4000 });
  const obj = taaldienst.parseJson(raw, "{", "}");
  const issues = obj ? normaliseerIssues(obj.issues) : [];
  if (!issues.length) {
    console.error("[structureer] terugval: één issue met het hele transcript");
    return terugval(transcript, taal, aanvulling);
  }
  let issuesVertaald = null;
  if (taal !== "nl") {
    issuesVertaald = normaliseerIssues(obj.issuesVertaald);
    if (issuesVertaald.length !== issues.length) {
      /* model gaf geen (complete) vertaling: apart vertalen */
      issuesVertaald = await taaldienst.vertaal(issues, "nl", taal, { model });
    }
  }
  return {
    transcriptNl: (taal === "nl" ? transcript : String(obj.transcriptNl || "").trim()) || transcript,
    aanvullingNl: (taal === "nl" ? aanvulling : String(obj.aanvullingNl || "").trim()) || aanvulling,
    issues, issuesVertaald,
  };
}

module.exports = { structureer, bouwPrompt, STANDAARD_MODEL: MODEL };

if (require.main === module) {
  const transcript = process.argv[2] || "";
  const taal = process.argv[3] || "nl";
  const model = process.argv[4] || undefined;
  if (!transcript) { console.error('gebruik: structureer.js "<transcript>" [taal] [model]'); process.exit(2); }
  structureer(transcript, taal, { model }).then((uit) => { console.log(JSON.stringify(uit, null, 2)); })
    .catch((e) => { console.error("fout:", e.message); process.exit(1); });
}
