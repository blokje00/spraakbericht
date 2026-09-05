/* tests/api.test.js — de hele lus door de API, tegen een lokale Redis
   (db 15, wordt leeggemaakt) en de nagebootste diagnose-app.
   Start de servers zelf; geen productie.  Run: node tests/api.test.js */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379/15";
const API_PORT = 52360, DIAG_PORT = 52361;
const API = "http://localhost:" + API_PORT, DIAG = "http://localhost:" + DIAG_PORT;
const ADMIN = "test-admin-token";

const env = Object.assign({}, process.env, {
  REDIS_URL, ADMIN_TOKEN: ADMIN, DIAGNOSE_API_BASE: DIAG, DIAGNOSE_ADMIN_TOKEN: "diag",
  SPRAAKBERICHT_BASE: API, BLOB_READ_WRITE_TOKEN: "", GEEN_BEVEILIGING: "0", PORT: String(API_PORT),
});
const kinderen = [];
function start(script, extraEnv) {
  const p = spawn(process.execPath, [path.join(ROOT, "tools", script)], { env: Object.assign({}, env, extraEnv || {}), stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write("  [" + script + "] " + d));
  p.stderr.on("data", (d) => process.stdout.write("  [" + script + " ERR] " + d));
  kinderen.push(p);
  return p;
}
async function wachtOp(url, ms) {
  const tot = Date.now() + (ms || 8000);
  while (Date.now() < tot) {
    try { await fetch(url); return; } catch (e) { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error("server niet bereikbaar: " + url);
}
async function call(method, pad, body, token) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(API + pad, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let json; try { json = JSON.parse(txt); } catch (e) { json = { raw: txt }; }
  return { status: r.status, json };
}
let geslaagd = 0;
function ok(cond, msg) { assert.ok(cond, msg); geslaagd++; console.log("✓ " + msg); }

(async () => {
  /* Redis db 15 leegmaken */
  const { createClient } = require("redis");
  const rc = createClient({ url: REDIS_URL }); await rc.connect(); await rc.flushDb(); await rc.quit();

  start("mock-diagnose.js", { PORT: String(DIAG_PORT) });
  start("local-api.js");
  await wachtOp(DIAG + "/api/boeken"); await wachtOp(API + "/api/game");

  /* ── monteurs ── */
  let r = await call("POST", "/api/monteurs", { naam: "Jan de Vries", code: "1234", taal: "nl" }, ADMIN);
  ok(r.status === 200 && r.json.monteur.id === "jan-de-vries", "admin maakt monteur Jan (nl) aan");
  r = await call("POST", "/api/monteurs", { naam: "Jörg Müller", code: "5678", taal: "de" }, ADMIN);
  ok(r.status === 200 && r.json.monteur.taal === "de", "admin maakt monteur Jörg (de) aan");
  r = await call("POST", "/api/monteurs", { naam: "Piet" }, ADMIN);
  ok(r.status === 400, "nieuwe monteur zonder code wordt geweigerd");
  r = await call("POST", "/api/monteur/login", { naam: "jan de vries", code: "0000" });
  ok(r.status === 401, "login met verkeerde code faalt");
  r = await call("POST", "/api/monteur/login", { naam: "Jan de Vries", code: "1234" });
  ok(r.status === 200 && r.json.token, "Jan logt in en krijgt een token");
  const JAN = r.json.token;
  r = await call("POST", "/api/monteur/login", { naam: "Jörg Müller", code: "5678" });
  const JORG = r.json.token;
  ok(!!JORG, "Jörg logt in");

  /* ── zelfregistratie ── */
  r = await call("POST", "/api/monteur/status", { naam: "jan de vries" });
  ok(r.json.bestaat === true, "status: bestaande naam (hoofdletters maken niet uit) → bestaat");
  r = await call("POST", "/api/monteur/status", { naam: "Piet Nieuw" });
  ok(r.json.bestaat === false, "status: onbekende naam → bestaat niet");
  r = await call("POST", "/api/monteur/registreer", { naam: "Piet Nieuw", code: "12", taal: "nl" });
  ok(r.status === 400, "registreren met pincode van 2 cijfers wordt geweigerd");
  r = await call("POST", "/api/monteur/registreer", { naam: "Jan de Vries", code: "9999", taal: "nl" });
  ok(r.status === 400, "registreren onder een bestaande naam wordt geweigerd");
  r = await call("POST", "/api/monteur/registreer", { naam: "Piet Nieuw", code: "4321", taal: "de" });
  ok(r.status === 200 && r.json.token && r.json.monteur.id === "piet-nieuw" && r.json.monteur.taal === "de", "Piet registreert zichzelf met pincode en taal, krijgt een token");
  r = await call("POST", "/api/monteur/login", { naam: "Piet Nieuw", code: "4321" });
  ok(r.status === 200, "Piet kan daarna inloggen met zijn pincode");
  r = await call("GET", "/api/monteurs", null, ADMIN);
  ok(r.json.monteurs.some((m) => m.id === "piet-nieuw"), "Piet staat in de monteurslijst van de admin");

  /* ── insturen ── */
  const audio = Buffer.from("x".repeat(400)).toString("base64");
  r = await call("POST", "/api/spraakbericht", { audio, audioType: "audio/webm", tekst: "test" });
  ok(r.status === 401, "insturen zonder login wordt geweigerd");
  r = await call("POST", "/api/spraakbericht", { audio, audioType: "audio/webm", tekst: "bij klant X", monteur: "Iemand Anders" }, JAN);
  ok(r.status === 200 && r.json.status === "nieuw", "Jan stuurt een memo in → status nieuw");
  const ID = r.json.id;
  r = await call("GET", "/api/spraakbericht/" + ID, null, ADMIN);
  ok(r.json.monteur === "Jan de Vries" && r.json.monteurId === "jan-de-vries", "monteur komt uit het token, niet uit de body");
  ok(r.json.audioRef && r.json.audioRef.startsWith("redis:") && !r.json.audio, "audio staat apart van het record");
  ok(r.json.events.length === 1 && r.json.events[0].type === "ingestuurd", "logboek heeft 1 gebeurtenis: ingestuurd");
  r = await call("GET", "/api/spraakbericht/" + ID, null, JORG);
  ok(r.status === 401, "Jörg mag Jans memo niet zien");
  r = await call("GET", "/api/spraakbericht/" + ID, null, JAN);
  ok(r.status === 200, "Jan mag zijn eigen memo zien");

  /* ── consumer: transcript ── */
  r = await call("GET", "/api/spraakbericht?status=nieuw", null, ADMIN);
  ok(r.json.spraakberichten.length === 1 && !r.json.spraakberichten[0].audio, "consumer ziet 1 nieuwe memo, lijst zonder audio");
  const issues = [{ apparaat: "SunShower 2000", symptoomKlant: "geen warm water", symptoomMonteur: "verwarmingselement koud", analyse: "", oplossing: "", rootcauseStatus: "onbekend", rootcause: "", opgelost: "onbekend" }];
  r = await call("POST", "/api/spraakbericht/" + ID + "/transcript", { transcript: "ik sta bij klant x, geen warm water", issues, taalGedetecteerd: "nl" }, ADMIN);
  ok(r.status === 200 && r.json.status === "wacht-supervisor", "transcript → wacht-supervisor");
  r = await call("POST", "/api/spraakbericht/" + ID + "/transcript", { transcript: "x", status: "goedgekeurd" }, ADMIN);
  ok(r.json.status === "wacht-supervisor", "consumer kan de status niet op goedgekeurd zetten");

  /* ── monteur mag nog niet ── */
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: true }, JAN);
  ok(r.status === 409, "monteur kan niet akkoord gaan vóór de supervisor");
  r = await call("POST", "/api/spraakbericht/" + ID + "/doorsturen", { doelBoek: "wachtkamer" }, ADMIN);
  ok(r.status === 409, "doorsturen kan niet vóór monteur-akkoord");

  /* ── supervisor bewerkt + retour ── */
  r = await call("POST", "/api/spraakbericht/" + ID + "/bewerk", { transcript: "Ik sta bij klant X, geen warm water." }, ADMIN);
  ok(r.status === 200 && r.json.status === "wacht-supervisor", "supervisor bewerkt transcript zonder statuswissel");
  const bewerkt = issues.map((i) => Object.assign({}, i, { analyse: "element gemeten: 0 ohm" }));
  r = await call("POST", "/api/spraakbericht/" + ID + "/retour", { issues: bewerkt, opmerking: "Klopt de analyse? En wat was de oorzaak?" }, ADMIN);
  ok(r.status === 200 && r.json.status === "wacht-monteur", "retour → wacht-monteur");
  ok(r.json.push && r.json.push.geenSubscription === true, "push: geen subscription, geen crash");
  r = await call("GET", "/api/spraakbericht/" + ID, null, ADMIN);
  ok(r.json.transcriptOrigineel === "ik sta bij klant x, geen warm water" && r.json.transcript === "Ik sta bij klant X, geen warm water.", "origineel transcript bewaard naast de bewerkte versie");

  /* ── monteur: klopt niet → terug naar supervisor ── */
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: false }, JAN);
  ok(r.status === 400, "'klopt niet' zonder opmerking wordt geweigerd");
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: false, opmerking: "Het was 2 ohm, niet 0." }, JAN);
  ok(r.json.status === "wacht-supervisor", "'klopt niet' → wacht-supervisor");
  r = await call("POST", "/api/spraakbericht/" + ID + "/retour", { opmerking: "Aangepast, akkoord?" }, ADMIN);
  ok(r.json.status === "wacht-monteur", "tweede retour → wacht-monteur");
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: true }, JORG);
  ok(r.status === 401, "Jörg kan Jans memo niet verifiëren");
  const akkoordIssues = bewerkt.map((i) => Object.assign({}, i, { rootcauseStatus: "vastgesteld", rootcause: "element doorgebrand", oplossing: "element vervangen", opgelost: "ja" }));
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: true, issues: akkoordIssues }, JAN);
  ok(r.json.status === "monteur-akkoord", "monteur akkoord → monteur-akkoord");

  /* ── taalmodel-instelling ── */
  r = await call("GET", "/api/instellingen", null, ADMIN);
  ok(r.status === 200 && r.json.taalmodel === null && r.json.standaardTaalmodel, "instellingen: geen keuze → standaardmodel");
  r = await call("PUT", "/api/instellingen", { taalmodel: "kapot model!" }, ADMIN);
  ok(r.status === 400, "ongeldige modelnaam wordt geweigerd");
  r = await call("PUT", "/api/instellingen", { taalmodel: "qwen/qwen3.8-flash" }, ADMIN);
  ok(r.json.taalmodel === "qwen/qwen3.8-flash", "supervisor kiest een model");
  r = await call("GET", "/api/instellingen", null, JAN);
  ok(r.status === 401, "monteur mag de instellingen niet lezen");
  const ID2 = (await call("POST", "/api/spraakbericht", { audio, audioType: "audio/webm" }, JAN)).json.id;
  await call("POST", "/api/spraakbericht/" + ID2 + "/transcript", { transcript: "x", issues, taalmodel: "qwen/qwen3.8-flash" }, ADMIN);
  r = await call("GET", "/api/spraakbericht/" + ID2, null, ADMIN);
  ok(r.json.taalmodel === "qwen/qwen3.8-flash", "memo onthoudt welk model de blokken maakte");
  await call("DELETE", "/api/spraakbericht/" + ID2, { reden: "testmemo" }, ADMIN);
  r = await call("GET", "/api/taalmodellen", null, ADMIN);
  ok(r.status === 200 && Array.isArray(r.json.modellen), "modellenlijst-route antwoordt (" + (r.json.ok ? r.json.modellen.length + " modellen" : "geen sleutel: " + r.json.reden) + ")");

  /* ── spel ── */
  r = await call("GET", "/api/spraakbericht/leaderboard");
  const jan = r.json.leaderboard.find((x) => x.monteurId === "jan-de-vries");
  ok(jan && jan.punten === 4 && jan.afgerond === 1, "leaderboard: 1 + 2 (rootcause) + 1 (opgelost) = 4 punten");

  /* ── doorsturen: mislukt en dan gelukt ── */
  r = await call("POST", "/api/spraakbericht/" + ID + "/doorsturen", { doelBoek: "sunshower" }, ADMIN);
  ok(r.status === 400, "doorsturen naar sunshower wordt geweigerd");
  r = await call("POST", "/api/spraakbericht/" + ID + "/doorsturen", { doelBoek: "kapot" }, ADMIN);
  ok(r.json.status === "doorsturen-mislukt", "storing bij diagnose-app → doorsturen-mislukt");
  r = await call("POST", "/api/spraakbericht/" + ID + "/doorsturen", { doelBoek: "wachtkamer" }, ADMIN);
  ok(r.json.status === "in-wachtkamer" && r.json.resultaat[0].treeId, "opnieuw → in-wachtkamer met treeId");
  const imp = await (await fetch(DIAG + "/api/imports")).json();
  const laatste = imp.imports[imp.imports.length - 1];
  ok(laatste.boek === "wachtkamer" && laatste.lang === "nl" && /Model: SunShower 2000/.test(laatste.inhoud) && /Oorzaak \(vastgesteld\)/.test(laatste.inhoud), "diagnose-app kreeg faulttree-tekst met apparaat en oorzaak");
  ok(laatste.spraakbericht.monteurId === "jan-de-vries" && /\/audio\?t=/.test(laatste.spraakbericht.audioUrl) && !laatste.spraakbericht.audioUrl.includes(ADMIN), "bron (monteur) gaat mee; audio-link zonder admin-token");
  const audioR = await fetch(laatste.spraakbericht.audioUrl);
  ok(audioR.status === 200 && (await audioR.arrayBuffer()).byteLength === 400, "audio-link uit de diagnose-app werkt");

  /* ── intrekken = niets weg ── */
  r = await call("DELETE", "/api/spraakbericht/" + ID, {}, ADMIN);
  ok(r.status === 400, "intrekken zonder reden wordt geweigerd");
  r = await call("DELETE", "/api/spraakbericht/" + ID, { reden: "testmemo" }, ADMIN);
  ok(r.json.status === "ingetrokken", "intrekken → ingetrokken");
  r = await call("GET", "/api/spraakbericht/" + ID, null, ADMIN);
  ok(r.status === 200 && r.json.transcript && r.json.issues.length === 1 && r.json.statusVoorIntrekken === "in-wachtkamer", "ingetrokken memo is nog compleet aanwezig");
  const types = r.json.events.map((e) => e.type);
  ok(types.join(",") === "ingestuurd,getranscribeerd,getranscribeerd,supervisor-bewerkt,retour-monteur,monteur-klopt-niet,retour-monteur,monteur-akkoord,doorsturen-mislukt,doorgestuurd,ingetrokken", "logboek bevat elke stap: " + types.length + " gebeurtenissen");
  r = await call("GET", "/api/spraakbericht/leaderboard");
  ok(!r.json.leaderboard.find((x) => x.monteurId === "jan-de-vries" && x.punten > 0), "ingetrokken memo telt niet meer mee");

  /* ── Duitse monteur ── */
  r = await call("POST", "/api/spraakbericht", { audio, audioType: "audio/webm" }, JORG);
  ok(r.json.status === "nieuw", "Jörg stuurt een memo in");
  r = await call("GET", "/api/spraakbericht/" + r.json.id, null, ADMIN);
  ok(r.json.taal === "de", "taal van de memo volgt de monteur (de)");

  /* ── legacy record blijft leesbaar ── */
  const rc2 = createClient({ url: REDIS_URL }); await rc2.connect();
  await rc2.set("b:inbox:spraakbericht:memo_oud", JSON.stringify({ id: "memo_oud", monteur: "Oude Naam", audio, audioType: "audio/webm", ts: 1, status: "verwerkt", transcript: "oud", issues: [{ model: "M1", symptoom: "S1", fix: "F1" }] }));
  await rc2.sAdd("b:inbox:spraakbericht:index", "memo_oud"); await rc2.quit();
  r = await call("GET", "/api/spraakbericht/memo_oud", null, ADMIN);
  ok(r.json.status === "wacht-supervisor" && r.json.issues[0].apparaat === "M1" && r.json.issues[0].oplossing === "F1" && r.json.heeftAudio, "oud record: status en velden vertaald, audio leesbaar");
  r = await call("POST", "/api/spraakbericht/memo_oud/retour", { opmerking: "x" }, ADMIN);
  ok(r.status === 400, "oud record zonder monteur-login kan niet retour");

  console.log("\nAPI-test GESLAAGD: " + geslaagd + " controles.");
  kinderen.forEach((p) => p.kill());
  process.exit(0);
})().catch((e) => {
  console.error("✗ API-TEST MISLUKT na " + geslaagd + " controles: " + e.message);
  kinderen.forEach((p) => p.kill());
  process.exit(1);
});
