/* tests/loop.test.js — DE HELE LUS met echte spraak, in het Nederlands én Duits.
   Gebruikt: macOS `say` + ffmpeg (audio), de lokale Whisper-server
   (tools/whisper-server.py), het taalmodel via tools/structureer.js
   (echte aanroep; TAALDIENST_MOCK=1 voor offline), tools/local-api.js met
   Redis db 14 (wordt leeggemaakt) en tools/mock-diagnose.js.
   Run: node tests/loop.test.js */
const assert = require("assert");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379/14";
const API_PORT = 52362, DIAG_PORT = 52363, WHISPER_PORT = Number(process.env.WHISPER_PORT || 52370);
const API = "http://localhost:" + API_PORT, DIAG = "http://localhost:" + DIAG_PORT, WHISPER = "http://127.0.0.1:" + WHISPER_PORT;
const ADMIN = "loop-admin";
const PYTHON = process.env.STT_PYTHON || "/Users/pjpjvanzandvoort/.hermes/hermes-agent/venv/bin/python3.11";
const TMP = fs.mkdtempSync("/tmp/ss-loop-");

const env = Object.assign({}, process.env, {
  REDIS_URL, ADMIN_TOKEN: ADMIN, DIAGNOSE_API_BASE: DIAG, DIAGNOSE_ADMIN_TOKEN: "diag", SPRAAKBERICHT_BASE: API,
  BLOB_READ_WRITE_TOKEN: "", GEEN_BEVEILIGING: "0", API_BASE: API, WHISPER_URL: WHISPER, UITZENDINGEN: TMP,
});
const kinderen = [];
function start(cmd, args, extraEnv) {
  const p = spawn(cmd, args, { env: Object.assign({}, env, extraEnv || {}), stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write("  │ " + d));
  p.stderr.on("data", (d) => process.stdout.write("  │ " + d));
  kinderen.push(p);
  return p;
}
async function wachtOp(url, ms, test) {
  const tot = Date.now() + ms;
  while (Date.now() < tot) {
    try { const r = await fetch(url); if (!test || test(await r.json())) return; } catch (e) { /* nog niet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("niet bereikbaar: " + url);
}
async function call(method, pad, body, token) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(API + pad, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let json; try { json = JSON.parse(txt); } catch (e) { json = { raw: txt }; }
  return { status: r.status, json };
}
function spraak(voice, tekst, naam) {
  const aiff = path.join(TMP, naam + ".aiff"), webm = path.join(TMP, naam + ".webm");
  execFileSync("say", ["-v", voice, tekst, "-o", aiff]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-c:a", "libopus", "-b:a", "48k", webm]);
  return fs.readFileSync(webm).toString("base64");
}
let n = 0;
function ok(c, msg) { assert.ok(c, msg); n++; console.log("✓ " + msg); }

(async () => {
  const { createClient } = require("redis");
  const rc = createClient({ url: REDIS_URL }); await rc.connect(); await rc.flushDb(); await rc.quit();

  /* Whisper-server: hergebruik als hij draait, anders zelf starten. */
  let whisperGezond = await fetch(WHISPER + "/health").then((r) => r.json()).catch(() => null);
  if (!whisperGezond) {
    console.log("• whisper-server starten (" + PYTHON + ")…");
    start(PYTHON, [path.join(ROOT, "tools", "whisper-server.py")], { WHISPER_PORT: String(WHISPER_PORT) });
    await wachtOp(WHISPER + "/health", 180000, (j) => j.geladen);
    whisperGezond = await fetch(WHISPER + "/health").then((r) => r.json());
  }
  ok(whisperGezond.geladen, "Whisper-server actief (model " + whisperGezond.model + ")");
  start(process.execPath, [path.join(ROOT, "tools", "mock-diagnose.js")], { PORT: String(DIAG_PORT) });
  start(process.execPath, [path.join(ROOT, "tools", "local-api.js")], { PORT: String(API_PORT) });
  await wachtOp(DIAG + "/api/boeken", 8000); await wachtOp(API + "/api/game", 8000);

  /* monteurs + login */
  await call("POST", "/api/monteurs", { naam: "Jan de Vries", code: "1234", taal: "nl" }, ADMIN);
  await call("POST", "/api/monteurs", { naam: "Jörg Müller", code: "5678", taal: "de" }, ADMIN);
  const JAN = (await call("POST", "/api/monteur/login", { naam: "Jan de Vries", code: "1234" })).json.token;
  const JORG = (await call("POST", "/api/monteur/login", { naam: "Jörg Müller", code: "5678" })).json.token;
  ok(JAN && JORG, "Jan (nl) en Jörg (de) ingelogd");

  /* echte spraak insturen */
  const nlTekst = "Ik sta bij een klant met een Sunshower Pure. De klant zegt dat er geen warm water komt. Ik heb het verwarmingselement gemeten, dat was doorgebrand. Element vervangen, probleem opgelost.";
  const deTekst = "Ich stehe bei einem Kunden mit einer Sunshower Infrarotdusche. Der Kunde sagt, die Lampe flackert. Ich habe den Anschluss geprüft, eine Klemme war locker. Klemme festgezogen, Problem behoben. Außerdem tropft der Duschkopf, das habe ich noch nicht angeschaut.";
  let r = await call("POST", "/api/spraakbericht", { audio: spraak("Xander", nlTekst, "nl"), audioType: "audio/webm;codecs=opus", taal: "nl" }, JAN);
  const ID_NL = r.json.id;
  r = await call("POST", "/api/spraakbericht", { audio: spraak("Anna", deTekst, "de"), audioType: "audio/webm;codecs=opus", taal: "de" }, JORG);
  const ID_DE = r.json.id;
  ok(ID_NL && ID_DE, "twee gesproken memo's ingestuurd (Xander nl, Anna de)");

  /* consumer: één ronde */
  console.log("• consumer draait (whisper + taalmodel" + (process.env.TAALDIENST_MOCK === "1" ? ", MOCK" : "") + ")…");
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "tools", "mac-consumer.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => process.stdout.write("  │ " + d)); p.stderr.on("data", (d) => process.stdout.write("  │ " + d));
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error("consumer exit " + code)));
  });
  const nl = (await call("GET", "/api/spraakbericht/" + ID_NL, null, ADMIN)).json;
  const de = (await call("GET", "/api/spraakbericht/" + ID_DE, null, ADMIN)).json;
  ok(nl.status === "wacht-supervisor" && de.status === "wacht-supervisor", "beide memo's → wacht-supervisor");
  console.log("  nl transcript: " + nl.transcript);
  console.log("  de transcript: " + de.transcript);
  ok(/warm water/i.test(nl.transcript) && /verwarmingselement/i.test(nl.transcript), "Nederlands transcript bevat 'warm water' en 'verwarmingselement'");
  ok(/Lampe/i.test(de.transcript) && /Klemme/i.test(de.transcript), "Duits transcript bevat 'Lampe' en 'Klemme'");
  ok(nl.taalGedetecteerd === "nl" && de.taalGedetecteerd === "de", "Whisper herkende nl én de");
  console.log("  nl issues: " + JSON.stringify(nl.issues));
  console.log("  de issues: " + JSON.stringify(de.issues));
  ok(nl.issues.length >= 1 && nl.issues[0].symptoomKlant, "nl: minstens 1 issue met symptoom klant");
  ok(de.issues.length >= 1 && de.issues[0].symptoomKlant, "de: minstens 1 issue met symptoom klant");
  if (process.env.TAALDIENST_MOCK !== "1") {
    ok(de.issues.length === 2, "de: twee problemen → twee issues");
    ok(/[a-zäöü]/i.test(de.issues[0].oplossing) && /Klemme/i.test(JSON.stringify(de.issues[0])), "de: issue-inhoud is Duits (Klemme)");
    ok(nl.issues[0].rootcauseStatus === "vastgesteld" && nl.issues[0].opgelost === "ja", "nl: oorzaak vastgesteld + opgelost=ja herkend");
  }
  ok(fs.existsSync(path.join(TMP, ID_NL + ".webm")) && fs.existsSync(path.join(TMP, ID_NL + ".transcript.txt")), "lokale kopie van audio + transcript bewaard");

  /* supervisor → monteur → supervisor → wachtkamer, voor beide */
  for (const [id, tok, taal] of [[ID_NL, JAN, "nl"], [ID_DE, JORG, "de"]]) {
    r = await call("POST", "/api/spraakbericht/" + id + "/retour", { opmerking: taal === "de" ? "Bitte prüfen." : "Klopt dit?" }, ADMIN);
    ok(r.json.status === "wacht-monteur", taal + ": retour → wacht-monteur");
    const mijn = (await call("GET", "/api/spraakbericht/mijn", null, tok)).json.spraakberichten;
    ok(mijn.length === 1 && mijn[0].status === "wacht-monteur" && mijn[0].opmerkingSupervisor, taal + ": monteur ziet zijn memo met opmerking");
    r = await call("PUT", "/api/spraakbericht/" + id + "/verificatie", { akkoord: true }, tok);
    ok(r.json.status === "monteur-akkoord", taal + ": monteur akkoord");
    r = await call("POST", "/api/spraakbericht/" + id + "/doorsturen", { doelBoek: "wachtkamer" }, ADMIN);
    ok(r.json.status === "in-wachtkamer", taal + ": in wachtkamer (" + r.json.resultaat.length + " import(s))");
  }
  const imports = (await (await fetch(DIAG + "/api/imports")).json()).imports;
  const deImports = imports.filter((i) => i.lang === "de");
  ok(imports.some((i) => i.lang === "nl" && /Model: .*Sunshower/i.test(i.inhoud)), "wachtkamer: Nederlandse faulttree met apparaat");
  ok(deImports.length >= 1 && /Symptoom: Kunde:/.test(deImports[0].inhoud), "wachtkamer: Duitse faulttree met 'Kunde:'");
  console.log("  voorbeeld import (de):\n    " + deImports[0].inhoud.split("\n").join("\n    "));
  const lb = (await call("GET", "/api/spraakbericht/leaderboard")).json.leaderboard;
  ok(lb.length === 2 && lb.every((x) => x.punten >= 1), "klassement: beide monteurs hebben punten (" + lb.map((x) => x.monteur + " " + x.punten).join(", ") + ")");

  console.log("\nLUS-TEST GESLAAGD: " + n + " controles. Bestanden: " + TMP);
  kinderen.forEach((p) => p.kill()); process.exit(0);
})().catch((e) => { console.error("✗ LUS-TEST MISLUKT na " + n + " controles: " + e.message); kinderen.forEach((p) => p.kill()); process.exit(1); });
