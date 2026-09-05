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
  TAALDIENST_MOCK: "1", // vertalen in de API: geen aanroep naar buiten, tekst blijft gelijk
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
  ok(r.status === 200 && r.json.monteur.geactiveerd === false, "nieuwe monteur zonder pincode: aangemaakt, nog niet geactiveerd");
  r = await call("POST", "/api/monteur/login", { naam: "jan de vries", code: "0000" });
  ok(r.status === 401, "login met verkeerde code faalt");
  r = await call("POST", "/api/monteur/login", { naam: "Jan de Vries", code: "1234" });
  ok(r.status === 200 && r.json.token, "Jan logt in en krijgt een token");
  const JAN = r.json.token;
  r = await call("POST", "/api/monteur/login", { naam: "Jörg Müller", code: "5678" });
  const JORG = r.json.token;
  ok(!!JORG, "Jörg logt in");

  /* ── monteurs: supervisor maakt aan, monteur activeert, supervisor beheert ── */
  r = await call("POST", "/api/monteurs", { naam: "Piet Nieuw", taal: "fr" }, ADMIN);
  ok(r.status === 200 && r.json.monteur.geactiveerd === false && r.json.monteur.taal === "fr", "admin maakt Piet aan zonder pincode (Frans), nog niet geactiveerd");
  r = await call("GET", "/api/monteur/lijst");
  const piet = r.json.monteurs.find((m) => m.naam === "Piet Nieuw"), janL = r.json.monteurs.find((m) => m.naam === "Jan de Vries");
  ok(r.status === 200 && piet && piet.geactiveerd === false && janL.geactiveerd === true && !piet.id, "publieke lijst: namen + geactiveerd, zonder id's");
  r = await call("POST", "/api/monteur/activeer", { naam: "Piet Nieuw", code: "12" });
  ok(r.status === 400, "activeren met pincode van 2 cijfers wordt geweigerd");
  r = await call("POST", "/api/monteur/activeer", { naam: "Onbekende Naam", code: "1234" });
  ok(r.status === 400, "activeren van een naam die de supervisor niet aanmaakte wordt geweigerd");
  r = await call("POST", "/api/monteur/activeer", { naam: "piet nieuw", code: "4321" });
  ok(r.status === 200 && r.json.token && r.json.monteur.geactiveerd === true, "Piet activeert zijn naam met een pincode en krijgt een token");
  const PIET = r.json.token;
  r = await call("POST", "/api/monteur/activeer", { naam: "Piet Nieuw", code: "9999" });
  ok(r.status === 400, "nog eens activeren (door een ander) wordt geweigerd");
  r = await call("POST", "/api/monteur/login", { naam: "Piet Nieuw", code: "4321" });
  ok(r.status === 200, "Piet kan daarna inloggen met zijn pincode");
  r = await call("POST", "/api/monteurs", { id: "piet-nieuw", naam: "Piet de Nieuwe", taal: "id" }, ADMIN);
  ok(r.status === 200 && r.json.monteur.naam === "Piet de Nieuwe" && r.json.monteur.taal === "id", "admin wijzigt naam en taal (Indonesisch)");
  r = await call("POST", "/api/monteur/login", { naam: "Piet de Nieuwe", code: "4321" });
  ok(r.status === 200, "inloggen met de nieuwe naam werkt");
  r = await call("POST", "/api/monteurs", { id: "jan-de-vries", naam: "Piet de Nieuwe" }, ADMIN);
  ok(r.status === 400, "naam die al van een ander is wordt geweigerd");
  r = await call("POST", "/api/monteurs", { id: "piet-nieuw", naam: "Piet de Nieuwe", reset: true }, ADMIN);
  ok(r.status === 200 && r.json.monteur.geactiveerd === false, "admin reset de pincode → niet meer geactiveerd");
  r = await call("GET", "/api/monteur/mij", null, PIET);
  ok(r.status === 401, "oude token van Piet is na de reset ongeldig");
  r = await call("POST", "/api/monteur/activeer", { naam: "Piet de Nieuwe", code: "1111" });
  ok(r.status === 200, "Piet activeert opnieuw met een nieuwe pincode");
  r = await call("GET", "/api/monteurs", null, ADMIN);
  ok(r.json.monteurs.some((m) => m.id === "piet-nieuw" && m.geactiveerd === true), "admin ziet Piet als geactiveerd");
  r = await call("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "x", auth: "y" } } }, JAN);
  ok(r.status === 200, "Jan meldt een toestel aan voor meldingen");
  r = await call("GET", "/api/monteurs", null, ADMIN);
  ok(r.json.monteurs.find((m) => m.id === "jan-de-vries").pushToestellen === 1, "beheer ziet 1 toestel voor Jan");

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
  r = await call("POST", "/api/spraakbericht/" + ID + "/bewerk", { transcriptNl: "Ik sta bij klant X, geen warm water." }, ADMIN);
  ok(r.status === 200 && r.json.status === "wacht-supervisor", "supervisor bewerkt transcript zonder statuswissel");
  const bewerkt = issues.map((i) => Object.assign({}, i, { analyse: "element gemeten: 0 ohm" }));
  r = await call("POST", "/api/spraakbericht/" + ID + "/retour", { issues: bewerkt, opmerking: "Klopt de analyse? En wat was de oorzaak?" }, ADMIN);
  ok(r.status === 200 && r.json.status === "wacht-monteur", "retour → wacht-monteur");
  ok(r.json.push && (r.json.push.geenVapid === true || r.json.push.mislukt === 1), "push: poging naar het testtoestel faalt netjes (geen VAPID-sleutels lokaal), geen crash");
  r = await call("GET", "/api/spraakbericht/" + ID, null, ADMIN);
  ok(r.json.transcriptNlOrigineel === "ik sta bij klant x, geen warm water" && r.json.transcriptOrigineel === "ik sta bij klant x, geen warm water" && r.json.transcriptNl === "Ik sta bij klant X, geen warm water.", "origineel transcript (Whisper én taalmodel) bewaard naast de bewerkte Nederlandse versie");

  /* ── monteur: klopt niet → terug naar supervisor ── */
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: false }, JAN);
  ok(r.status === 400, "'klopt niet' zonder opmerking wordt geweigerd");
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: false, opmerking: "Het was 2 ohm, niet 0." }, JAN);
  ok(r.json.status === "wacht-supervisor", "'klopt niet' → wacht-supervisor");
  r = await call("POST", "/api/spraakbericht/" + ID + "/retour", { opmerking: "Aangepast, akkoord?" }, ADMIN);
  ok(r.json.status === "wacht-monteur", "tweede retour → wacht-monteur");
  r = await call("PUT", "/api/spraakbericht/" + ID + "/verificatie", { akkoord: true }, JORG);
  ok(r.status === 401, "Jörg kan Jans memo niet verifiëren");
  const akkoordIssues = bewerkt.map((i) => Object.assign({}, i, { rootcauseStatus: "vastgesteld", rootcause: "element doorgebrand", oorzaakType: "productiefout", oplossing: "element vervangen", opgelost: "ja" }));
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
  ok(laatste.boek === "wachtkamer" && laatste.lang === "nl" && /Model: SunShower 2000/.test(laatste.inhoud) && /Oorzaak \(vastgesteld\)/.test(laatste.inhoud) && /Soort: productiefout/.test(laatste.inhoud) && /Toelichting: bij klant X/.test(laatste.inhoud), "diagnose-app kreeg faulttree-tekst met apparaat, oorzaak, soort oorzaak en de getypte aanvulling");
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
  r = await call("GET", "/api/spraakbericht/mijn", null, JAN);
  ok(!r.json.spraakberichten.some((x) => x.id === ID), "verwijderde memo staat niet meer bij de monteur");

  /* ── Duitse monteur ── */
  r = await call("POST", "/api/spraakbericht", { audio, audioType: "audio/webm" }, JORG);
  ok(r.json.status === "nieuw", "Jörg stuurt een memo in");
  r = await call("GET", "/api/spraakbericht/" + r.json.id, null, ADMIN);
  ok(r.json.taal === "de", "taal van de memo volgt de monteur (de)");

  /* ── anderstalige monteur: Nederlands voor de supervisor, eigen taal voor de monteur ── */
  const ID_DE = (await call("POST", "/api/spraakbericht", { audio, audioType: "audio/webm", tekst: "Seriennummer 99" }, JORG)).json.id;
  const nlIssues = [{ apparaat: "Sunshower Pure 99", symptoomKlant: "lamp flikkert", oplossing: "klem vastgezet", rootcauseStatus: "vastgesteld", rootcause: "losse klem", oorzaakType: "installatiefout", opgelost: "ja" }];
  const deIssues = [{ apparaat: "Sunshower Pure 99", symptoomKlant: "Lampe flackert", oplossing: "Klemme festgezogen", rootcauseStatus: "vastgesteld", rootcause: "lockere Klemme", oorzaakType: "installatiefout", opgelost: "ja" }];
  r = await call("POST", "/api/spraakbericht/" + ID_DE + "/transcript", { transcript: "Die Lampe flackert.", transcriptNl: "De lamp flikkert.", aanvullingNl: "Serienummer 99", issues: nlIssues, issuesVertaald: deIssues, taalGedetecteerd: "de" }, ADMIN);
  r = await call("GET", "/api/spraakbericht/" + ID_DE, null, ADMIN);
  ok(r.json.transcriptNl === "De lamp flikkert." && r.json.transcript === "Die Lampe flackert." && r.json.issues[0].symptoomKlant === "lamp flikkert" && r.json.issuesVertaald[0].symptoomKlant === "Lampe flackert", "Duitse memo: Nederlandse blokken + Duitse vertaling bewaard, transcript in beide talen");
  r = await call("POST", "/api/spraakbericht/" + ID_DE + "/retour", { opmerking: "Klopt dit?" }, ADMIN);
  r = await call("GET", "/api/spraakbericht/" + ID_DE, null, JORG);
  ok(r.json.status === "wacht-monteur" && r.json.opmerkingSupervisorVertaald !== undefined && r.json.issuesVertaald.length === 1, "retour: monteur krijgt vertaalde opmerking en blokken (mock: ongewijzigd)");
  r = await call("PUT", "/api/spraakbericht/" + ID_DE + "/verificatie", { akkoord: true, issues: [Object.assign({}, deIssues[0], { symptoomMonteur: "Klemme sichtbar locker" })], opmerking: "" }, JORG);
  r = await call("GET", "/api/spraakbericht/" + ID_DE, null, ADMIN);
  ok(r.json.status === "monteur-akkoord" && r.json.issuesVertaald[0].symptoomMonteur === "Klemme sichtbar locker" && r.json.issues[0].symptoomMonteur === "Klemme sichtbar locker", "monteur bewerkt in het Duits: eigen versie bewaard, Nederlandse versie via vertaling (mock: gelijk)");
  r = await call("POST", "/api/spraakbericht/" + ID_DE + "/doorsturen", { doelBoek: "wachtkamer" }, ADMIN);
  const impDe = (await (await fetch(DIAG + "/api/imports")).json()).imports.pop();
  ok(impDe.lang === "nl" && /Klant: /.test(impDe.inhoud) && /Toelichting: Serienummer 99/.test(impDe.inhoud) && impDe.spraakbericht.taal === "de", "wachtkamer krijgt altijd Nederlands (lang nl, 'Klant:'), brontaal blijft vermeld");

  /* ── legacy record blijft leesbaar ── */
  const rc2 = createClient({ url: REDIS_URL }); await rc2.connect();
  await rc2.set("b:inbox:spraakbericht:memo_oud", JSON.stringify({ id: "memo_oud", monteur: "Oude Naam", audio, audioType: "audio/webm", ts: 1, status: "verwerkt", transcript: "oud", issues: [{ model: "M1", symptoom: "S1", fix: "F1" }] }));
  await rc2.sAdd("b:inbox:spraakbericht:index", "memo_oud"); await rc2.quit();
  r = await call("GET", "/api/spraakbericht/memo_oud", null, ADMIN);
  ok(r.json.status === "wacht-supervisor" && r.json.issues[0].apparaat === "M1" && r.json.issues[0].oplossing === "F1" && r.json.heeftAudio, "oud record: status en velden vertaald, audio leesbaar");
  r = await call("POST", "/api/spraakbericht/memo_oud/retour", { opmerking: "x" }, ADMIN);
  ok(r.status === 400, "oud record zonder monteur-login kan niet retour");
  r = await call("POST", "/api/migreer", null, ADMIN);
  ok(r.json.doe === false && r.json.logboeken === 1, "migratie (droog): 1 memo zonder logboek gevonden");
  r = await call("POST", "/api/migreer?doe=1", null, ADMIN);
  ok(r.json.doe === true && r.json.logboeken === 1, "migratie uitgevoerd");
  r = await call("GET", "/api/spraakbericht/memo_oud", null, ADMIN);
  ok(r.json.events.length === 1 && r.json.events[0].type === "gemigreerd" && r.json.versie === 1, "oud record heeft nu een logboek");
  r = await call("POST", "/api/migreer?doe=1", null, ADMIN);
  ok(r.json.logboeken === 0, "migratie nog eens: niets meer te doen");

  console.log("\nAPI-test GESLAAGD: " + geslaagd + " controles.");
  kinderen.forEach((p) => p.kill());
  process.exit(0);
})().catch((e) => {
  console.error("✗ API-TEST MISLUKT na " + geslaagd + " controles: " + e.message);
  kinderen.forEach((p) => p.kill());
  process.exit(1);
});
