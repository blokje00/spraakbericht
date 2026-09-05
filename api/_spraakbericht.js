/* api/_spraakbericht.js — de API van de spraakbericht-app (herbouwd 2026-09-05).
   ------------------------------------------------------------
   De lus:  monteur spreekt in → Mac transcribeert + structureert →
            supervisor controleert → retour naar monteur → monteur akkoord
            → supervisor stuurt door naar de wachtkamer (diagnose-app).

   Statussen (schema.js):
     nieuw → wacht-supervisor → wacht-monteur → monteur-akkoord → in-wachtkamer
                  ↑ (monteur: klopt niet)  ┘        doorsturen-mislukt ↔
     fout-transcriptie (consumer gaf op), ingetrokken (supervisor, met reden)

   Alles is een logboek (api/_memo.js): niets wordt gewist of overschreven.

   Rollen en tokens:
     monteur     Bearer <monteurtoken>  (via POST /api/monteur/login)
     supervisor  Bearer <ADMIN_TOKEN>   (review.html, Mac-consumer)

   Routes:
     GET    /api/monteur/lijst            publiek: namen + taal + geactiveerd (inlogscherm)
     POST   /api/monteur/activeer         {naam, code(4 cijfers)} → {token, monteur} (eerste keer)
     POST   /api/monteur/login            {naam, code} → {token, monteur}
     GET    /api/monteur/mij              monteur: eigen profiel
     GET    /api/monteurs                 admin: lijst
     POST   /api/monteurs                 admin: {id?, naam, taal, code?, reset?} aanmaken/bijwerken
     POST   /api/spraakbericht            monteur: memo insturen
     GET    /api/spraakbericht/mijn       monteur: eigen memo's
     GET    /api/spraakbericht            admin: alle memo's (?status=)
     GET    /api/spraakbericht/:id        admin of eigenaar: memo + gebeurtenissen
     GET    /api/spraakbericht/:id/audio  admin, eigenaar of ?t=<audioToken>
     POST   /api/spraakbericht/:id/transcript   consumer: transcript + issues
     POST   /api/spraakbericht/:id/bewerk       admin: opslaan zonder statuswissel
     POST   /api/spraakbericht/:id/retour       admin: naar de monteur (+push)
     PUT    /api/spraakbericht/:id/verificatie  monteur: akkoord of klopt-niet
     POST   /api/spraakbericht/:id/doorsturen   admin: naar de wachtkamer
     DELETE /api/spraakbericht/:id              admin: intrekken (met reden)
     GET    /api/spraakbericht/leaderboard      publiek: het spel
     GET    /api/game  PUT /api/game            ronde (admin voor PUT)
     GET/PUT /api/instellingen                  admin: {taalmodel} voor het structureren
     GET    /api/taalmodellen                   admin: modellen bij Nous (?ververs=1)
     POST   /api/push/subscribe                 monteur
     POST   /api/push/notify                    admin
   ------------------------------------------------------------ */
const { configured, cmd, boekKey } = require("./_redis");
const { sanitizeTekst, validId } = require("./_sanitize");
const schema = require("../schema");
const memo = require("./_memo");
const opslag = require("./_opslag");
const monteurs = require("./_monteur");
const diagnose = require("./_diagnose");
const push = require("./_push");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GEEN_BEVEILIGING = process.env.GEEN_BEVEILIGING === "1";
const SPRAAKBERICHT_BASE = process.env.SPRAAKBERICHT_BASE || "https://spraakbericht.vercel.app";
const MAX_AUDIO_BASE64 = 8 * 1024 * 1024;
const MAX_TRANSCRIPT = 8000;

/* ── hulpjes ── */
function cors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  }
  return false;
}
function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
function isAdmin(req) {
  if (GEEN_BEVEILIGING) return true;
  const t = bearer(req);
  return !!t && !!ADMIN_TOKEN && safeEqual(t, ADMIN_TOKEN);
}
function getBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 12 * 1024 * 1024) { req.destroy(); reject(new Error("te groot")); } });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); } });
    req.on("error", reject);
  });
}
function ip(req) {
  return String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) || "?";
}
/* Rate limit in Redis (werkt ook over meerdere serverless-instanties). */
async function magDoorgaan(soort, sleutel, maxPerMinuut) {
  const k = boekKey("inbox", "limiet:" + soort + ":" + sleutel + ":" + Math.floor(Date.now() / 60000));
  const n = Number(await cmd(["INCR", k]));
  if (n === 1) await cmd(["EXPIRE", k, "120"]);
  return n <= maxPerMinuut;
}
function sanitizeIssues(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).map((it) => {
    if (!it || typeof it !== "object") return null;
    const o = {};
    for (const veld of schema.issueVelden()) o[veld] = sanitizeTekst(it[veld], 1500);
    /* oude veldnamen mogen mee: normaliseerIssue zet ze over */
    for (const oud of ["model", "symptoom", "fix", "controle"]) if (it[oud]) o[oud] = sanitizeTekst(it[oud], 1500);
    const n = memo.normaliseerIssue(o);
    return memo.issueIsLeeg(n) ? null : n;
  }).filter(Boolean);
}
function taalUit(v, fallback) { return schema.TALEN[v] ? v : (fallback || "nl"); }
function lichteVorm(rec) {
  const k = Object.assign({}, rec);
  delete k.audio; delete k.audioToken;
  return k;
}
function audioUrlVoor(rec) {
  return SPRAAKBERICHT_BASE + "/api/spraakbericht/" + encodeURIComponent(rec.id) + "/audio?t=" + encodeURIComponent(rec.audioToken || "");
}
function randomToken() { return require("crypto").randomBytes(18).toString("base64url"); }
function pushTekst(taal, id, badge) {
  return { title: schema.tekst("pushTitel", taal), body: schema.tekst("pushTekst", taal), id, badge: badge || 0 };
}
/* Hoeveel memo's wachten er op deze monteur? (voor het bolletje op het icoon) */
async function wachtendVoor(monteurId) {
  return (await memo.alle()).filter((r) => r.monteurId === monteurId && r.status === "wacht-monteur").length;
}

/* ── instellingen + modellenlijst ── */
const INSTELLINGEN_KEY = boekKey("inbox", "instellingen");
const MODELLEN_CACHE_KEY = boekKey("inbox", "taalmodellen-cache");
const TAALDIENST_URL = (process.env.TAALDIENST_URL || "https://inference-api.nousresearch.com/v1/chat/completions").replace(/\/chat\/completions$/, "");
const STANDAARD_TAALMODEL = process.env.TAALDIENST_MODEL || "deepseek/deepseek-v4-flash-0731";
async function leesInstellingen() {
  const raw = await cmd(["GET", INSTELLINGEN_KEY]);
  const i = raw ? JSON.parse(raw) : {};
  return { taalmodel: i.taalmodel || null, standaardTaalmodel: STANDAARD_TAALMODEL };
}
/* Lijst van tekstmodellen bij Nous Research (id, naam, prijs per miljoen
   tokens, redeneert ja/nee). Eén uur gecachet in Redis. Zonder NOUS_API_KEY
   op de server komt er een lege lijst met de reden; review.html toont dan
   een vrij invoerveld. */
async function taalmodellen(ververs) {
  if (!ververs) {
    const raw = await cmd(["GET", MODELLEN_CACHE_KEY]);
    if (raw) return JSON.parse(raw);
  }
  const key = (process.env.NOUS_API_KEY || "").trim();
  if (!key) return { ok: false, modellen: [], reden: "NOUS_API_KEY ontbreekt op de server" };
  try {
    const r = await fetch(TAALDIENST_URL + "/models", { headers: { Authorization: "Bearer " + key } });
    if (!r.ok) return { ok: false, modellen: [], reden: "Nous HTTP " + r.status };
    const data = await r.json();
    const modellen = (data.data || []).filter((m) => {
      const a = m.architecture || {};
      const inp = a.input_modalities || [], out = a.output_modalities || [];
      return (!inp.length || inp.includes("text")) && (!out.length || out.includes("text")) && !/embed|voyage|tts|whisper/i.test(m.id);
    }).map((m) => ({
      id: m.id, naam: m.name || m.id,
      prijsIn: m.pricing && m.pricing.prompt != null ? Math.round(Number(m.pricing.prompt) * 1e6 * 100) / 100 : null,
      prijsUit: m.pricing && m.pricing.completion != null ? Math.round(Number(m.pricing.completion) * 1e6 * 100) / 100 : null,
      redeneert: !!(m.reasoning || (m.supported_parameters || []).includes("reasoning")),
      context: m.context_length || null,
    })).sort((a, b) => a.naam.localeCompare(b.naam));
    const uit = { ok: true, modellen, opgehaaldOp: new Date().toISOString() };
    await cmd(["SET", MODELLEN_CACHE_KEY, JSON.stringify(uit), "EX", "3600"]);
    return uit;
  } catch (e) {
    return { ok: false, modellen: [], reden: "ophalen mislukt: " + e.message };
  }
}

/* ── het spel ── */
const GAME_KEY = boekKey("inbox", "game");
async function leesGame() {
  const raw = await cmd(["GET", GAME_KEY]);
  const g = raw ? JSON.parse(raw) : {};
  return {
    start: g.start || null, einde: g.einde || null, prijs: g.prijs || "",
    punten: Object.assign({ akkoord: 1, rootcause: 2, opgelost: 1 }, g.punten || {}),
  };
}
/* Punten per memo: alleen memo's waar de monteur akkoord op gaf (of verder). */
function puntenVoor(rec, game) {
  const telt = schema.STATUS[rec.status] && ["monteur-akkoord", "in-wachtkamer", "doorsturen-mislukt"].includes(rec.status);
  if (!telt) return 0;
  let p = game.punten.akkoord;
  for (const it of rec.issues) {
    if (it.rootcauseStatus === "vastgesteld") p += game.punten.rootcause;
    if (it.opgelost === "ja") p += game.punten.opgelost;
  }
  return p;
}
function inRonde(rec, game) {
  const t = rec.ts || 0;
  if (game.start && t < Date.parse(game.start)) return false;
  if (game.einde && t > Date.parse(game.einde)) return false;
  return true;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (!configured()) return res.status(503).json({ error: "database niet geconfigureerd" });
  const rawRoute = req.query.route;
  const route = Array.isArray(rawRoute) ? rawRoute : String(rawRoute || "").split("/").filter(Boolean);
  const r0 = route[0] || "", r1 = route[1] || "", r2 = route[2] || "";
  const M = req.method;

  /* ════ monteurs ════ */
  if (M === "POST" && r0 === "monteur" && r1 === "login") {
    if (!(await magDoorgaan("login", ip(req), 10))) return res.status(429).json({ error: "te veel pogingen" });
    const body = await getBody(req);
    const uit = await monteurs.login(sanitizeTekst(body.naam, 80), sanitizeTekst(body.code, 80));
    if (!uit) return res.status(401).json({ error: "naam of code klopt niet" });
    return res.status(200).json(Object.assign({ ok: true }, uit));
  }
  if (M === "GET" && r0 === "monteur" && r1 === "lijst") {
    return res.status(200).json({ ok: true, monteurs: await monteurs.lijst() });
  }
  /* Eerste keer: naam (door de supervisor aangemaakt) + zelfgekozen pincode. */
  if (M === "POST" && r0 === "monteur" && r1 === "activeer") {
    if (!(await magDoorgaan("activeer", ip(req), 10))) return res.status(429).json({ error: "te veel pogingen" });
    const body = await getBody(req);
    try {
      const uit = await monteurs.activeer({ naam: sanitizeTekst(body.naam, 80), code: sanitizeTekst(body.code, 10) });
      return res.status(200).json(Object.assign({ ok: true }, uit));
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  if (M === "GET" && r0 === "monteur" && r1 === "mij") {
    const m = await monteurs.vanRequest(req);
    if (!m) return res.status(401).json({ error: "niet ingelogd" });
    return res.status(200).json({ ok: true, monteur: m });
  }
  if (r0 === "monteurs") {
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (M === "GET") return res.status(200).json({ ok: true, monteurs: await monteurs.alle() });
    if (M === "POST") {
      const body = await getBody(req);
      try {
        const code = sanitizeTekst(body.code, 10);
        if (code && !monteurs.geldigePincode(code)) return res.status(400).json({ error: "pincode moet uit vier cijfers bestaan" });
        const m = await monteurs.bewaar({ naam: sanitizeTekst(body.naam, 80), code, taal: body.taal, id: body.id ? monteurs.slug(body.id) : undefined, reset: body.reset === true });
        return res.status(200).json({ ok: true, monteur: m });
      } catch (e) { return res.status(400).json({ error: e.message }); }
    }
  }

  /* ════ instellingen (taalmodel voor het structureren) ════
     De supervisor kiest in review.html → Beheer welk model bij Nous Research
     de blokken maakt; de Mac-consumer haalt dit elke ronde op. */
  if (r0 === "instellingen") {
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (M === "GET") return res.status(200).json(Object.assign({ ok: true }, await leesInstellingen()));
    if (M === "PUT") {
      const body = await getBody(req);
      const i = await leesInstellingen();
      if (body.taalmodel !== undefined) {
        const m = sanitizeTekst(body.taalmodel, 120);
        if (m && !/^[\w~.:\/-]+$/.test(m)) return res.status(400).json({ error: "ongeldige modelnaam" });
        i.taalmodel = m || null;
      }
      await cmd(["SET", INSTELLINGEN_KEY, JSON.stringify(i)]);
      return res.status(200).json(Object.assign({ ok: true }, i));
    }
  }
  /* eenmalige migratie van oude memo's (admin); ?doe=1 voert uit, anders alleen tonen */
  if (M === "POST" && r0 === "migreer") {
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const uit = await require("./_migratie").migreer({ doe: String(req.query.doe || "") === "1" });
    return res.status(200).json(Object.assign({ ok: true }, uit));
  }
  if (M === "GET" && r0 === "taalmodellen") {
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    return res.status(200).json(await taalmodellen(String(req.query.ververs || "") === "1"));
  }

  /* ════ het spel ════ */
  if (M === "GET" && r0 === "game") return res.status(200).json(Object.assign({ ok: true }, await leesGame()));
  if (M === "PUT" && r0 === "game") {
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const body = await getBody(req);
    const g = await leesGame();
    for (const veld of ["start", "einde"]) if (body[veld] !== undefined) g[veld] = body[veld] && !isNaN(Date.parse(body[veld])) ? new Date(body[veld]).toISOString() : null;
    if (body.prijs !== undefined) g.prijs = sanitizeTekst(body.prijs, 200);
    if (body.punten && typeof body.punten === "object") for (const k of Object.keys(g.punten)) if (Number.isFinite(Number(body.punten[k]))) g.punten[k] = Number(body.punten[k]);
    await cmd(["SET", GAME_KEY, JSON.stringify(g)]);
    return res.status(200).json(Object.assign({ ok: true }, g));
  }
  if (M === "GET" && r0 === "spraakbericht" && r1 === "leaderboard") {
    const game = await leesGame();
    const per = {};
    for (const rec of await memo.alle()) {
      if (!inRonde(rec, game)) continue;
      const sleutel = rec.monteurId || rec.monteur || "onbekend";
      const p = per[sleutel] || (per[sleutel] = { monteurId: rec.monteurId, monteur: rec.monteur, punten: 0, ingestuurd: 0, afgerond: 0 });
      p.ingestuurd++;
      const pt = puntenVoor(rec, game);
      if (pt) { p.afgerond++; p.punten += pt; }
    }
    const rij = Object.values(per).sort((a, b) => b.punten - a.punten || b.afgerond - a.afgerond || b.ingestuurd - a.ingestuurd);
    return res.status(200).json({ ok: true, leaderboard: rij, ronde: game });
  }

  /* ════ push ════ */
  if (M === "POST" && r0 === "push" && r1 === "subscribe") {
    const m = await monteurs.vanRequest(req);
    if (!m) return res.status(401).json({ error: "niet ingelogd" });
    const body = await getBody(req);
    if (!body.subscription || typeof body.subscription !== "object" || !body.subscription.endpoint) return res.status(400).json({ error: "subscription ontbreekt" });
    await push.bewaarSubscription(m.id, body.subscription);
    return res.status(200).json({ ok: true });
  }
  if (M === "POST" && r0 === "push" && r1 === "notify") {
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const body = await getBody(req);
    if (!body.monteurId) return res.status(400).json({ error: "monteurId ontbreekt" });
    const mid = monteurs.slug(body.monteurId);
    const m = await monteurs.laad(mid);
    const uit = await push.stuur(mid, pushTekst(m ? m.taal : "nl", body.id, await wachtendVoor(mid)));
    return res.status(200).json(Object.assign({ ok: true }, uit));
  }

  /* ════ memo's ════ */
  if (r0 !== "spraakbericht") return res.status(404).json({ error: "onbekende route" });

  /* insturen (monteur) */
  if (M === "POST" && !r1) {
    const m = await monteurs.vanRequest(req);
    if (!m) return res.status(401).json({ error: "niet ingelogd" });
    if (!(await magDoorgaan("memo", m.id, 30))) return res.status(429).json({ error: "te veel verzoeken" });
    const body = await getBody(req);
    const audio = String(body.audio || "");
    if (!audio || audio.length < 50) return res.status(400).json({ error: "geen audio ontvangen" });
    if (audio.length > MAX_AUDIO_BASE64) return res.status(413).json({ error: "audio te groot" });
    const id = "memo_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const audioType = sanitizeTekst(body.audioType, 60) || "audio/webm";
    const { audioRef, audioBytes } = await opslag.bewaarAudio(id, audio, audioType);
    const rec = {
      id, monteurId: m.id, monteur: m.naam, taal: taalUit(body.taal, m.taal),
      tekst: sanitizeTekst(body.tekst, 500), audioType, audioRef, audioBytes, audioToken: randomToken(),
      ts: Date.now(), status: "nieuw", transcript: null, transcriptOrigineel: null, issues: [], issuesOrigineel: [], diagnose: [],
    };
    await memo.maak(rec, { rol: "monteur", id: m.id, naam: m.naam });
    return res.status(200).json({ ok: true, id, status: rec.status });
  }

  /* eigen memo's (monteur) */
  if (M === "GET" && r1 === "mijn") {
    const m = await monteurs.vanRequest(req);
    if (!m) return res.status(401).json({ error: "niet ingelogd" });
    const lijst = (await memo.alle()).filter((r) => r.monteurId === m.id).map(lichteVorm);
    return res.status(200).json({ ok: true, spraakberichten: lijst });
  }

  /* lijst (admin) */
  if (M === "GET" && !r1) {
    if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const status = String(req.query.status || "");
    let lijst = await memo.alle();
    if (status) lijst = lijst.filter((r) => r.status === status);
    return res.status(200).json({ ok: true, spraakberichten: lijst.map(lichteVorm) });
  }

  /* vanaf hier: /spraakbericht/:id[/actie] */
  const id = r1;
  if (!validId(id)) return res.status(400).json({ error: "ongeldig memo-id" });
  const rec = await memo.laad(id);
  if (!rec) return res.status(404).json({ error: "memo niet gevonden" });
  const admin = isAdmin(req);
  const mon = admin ? null : await monteurs.vanRequest(req);
  const eigenaar = !!(mon && rec.monteurId && mon.id === rec.monteurId);
  const wie = admin ? { rol: "supervisor" } : mon ? { rol: "monteur", id: mon.id, naam: mon.naam } : null;

  /* audio */
  if (M === "GET" && r2 === "audio") {
    const t = String(req.query.t || req.query.token || "");
    const ok = admin || eigenaar || (t && ADMIN_TOKEN && safeEqual(t, ADMIN_TOKEN)) || (t && rec.audioToken && safeEqual(t, rec.audioToken));
    if (!ok) return res.status(401).json({ error: "unauthorized" });
    const buf = await opslag.leesAudio(rec);
    if (!buf) return res.status(404).json({ error: "geen audio" });
    res.writeHead(200, { "Content-Type": rec.audioType || "audio/webm", "Content-Length": buf.length, "Cache-Control": "no-store" });
    return res.end(buf);
  }

  /* detail + logboek */
  if (M === "GET" && !r2) {
    if (!admin && !eigenaar) return res.status(401).json({ error: "unauthorized" });
    const uit = lichteVorm(rec);
    uit.events = (await memo.events(id)).map((e) => ({ type: e.type, door: e.door, ts: e.ts, versie: e.versie, data: e.data }));
    if (admin) uit.audioUrl = audioUrlVoor(rec);
    return res.status(200).json(Object.assign({ ok: true }, uit));
  }
  if (M === "GET" && r2 === "events") {
    if (!admin && !eigenaar) return res.status(401).json({ error: "unauthorized" });
    return res.status(200).json({ ok: true, events: await memo.events(id) });
  }

  /* transcript (consumer) */
  if (M === "POST" && r2 === "transcript") {
    if (!admin) return res.status(401).json({ error: "unauthorized" });
    const body = await getBody(req);
    const mislukt = String(body.status || "") === "fout-transcriptie";
    const transcript = sanitizeTekst(body.transcript, MAX_TRANSCRIPT);
    if (!mislukt && !transcript) return res.status(400).json({ error: "transcript is leeg" });
    const issues = sanitizeIssues(body.issues);
    const reden = sanitizeTekst(body.reden, 500);
    const taalmodel = sanitizeTekst(body.taalmodel, 120) || null;
    const uit = await memo.werkBij(id, { type: mislukt ? "transcriptie-mislukt" : "getranscribeerd", door: { rol: "consumer" }, data: { reden: reden || null, taalGedetecteerd: body.taalGedetecteerd || null, taalmodel } }, (r) => {
      if (mislukt) { r.status = "fout-transcriptie"; r.transcriptieFout = reden || "onbekend"; return; }
      r.transcript = transcript;
      r.taalmodel = taalmodel;
      if (!r.transcriptOrigineel) r.transcriptOrigineel = transcript;
      r.issues = issues;
      if (!r.issuesOrigineel || !r.issuesOrigineel.length) r.issuesOrigineel = issues;
      if (body.taalGedetecteerd && schema.TALEN[body.taalGedetecteerd]) r.taalGedetecteerd = body.taalGedetecteerd;
      r.status = "wacht-supervisor";
      r.getranscribeerdOp = new Date().toISOString();
      delete r.transcriptieFout;
    });
    return res.status(200).json({ ok: true, id, status: uit.status });
  }

  /* bewerken zonder statuswissel (supervisor) */
  if (M === "POST" && r2 === "bewerk") {
    if (!admin) return res.status(401).json({ error: "unauthorized" });
    const body = await getBody(req);
    const uit = await memo.werkBij(id, { type: "supervisor-bewerkt", door: wie }, (r) => {
      if (body.transcript !== undefined) r.transcript = sanitizeTekst(body.transcript, MAX_TRANSCRIPT);
      if (body.issues !== undefined) r.issues = sanitizeIssues(body.issues);
      if (body.taal !== undefined) r.taal = taalUit(body.taal, r.taal);
    });
    return res.status(200).json({ ok: true, id, status: uit.status });
  }

  /* retour naar de monteur (supervisor) */
  if (M === "POST" && r2 === "retour") {
    if (!admin) return res.status(401).json({ error: "unauthorized" });
    if (!rec.monteurId) return res.status(400).json({ error: "memo heeft geen ingelogde monteur; retour is niet mogelijk" });
    if (["ingetrokken", "in-wachtkamer"].includes(rec.status)) return res.status(409).json({ error: "memo is " + rec.status });
    const body = await getBody(req);
    const opmerking = sanitizeTekst(body.opmerking, 1000);
    const uit = await memo.werkBij(id, { type: "retour-monteur", door: wie, data: { opmerking } }, (r) => {
      if (body.transcript !== undefined) r.transcript = sanitizeTekst(body.transcript, MAX_TRANSCRIPT);
      if (body.issues !== undefined) r.issues = sanitizeIssues(body.issues);
      if (!r.issues.length) r.issues = [schema.leegIssue()];
      r.opmerkingSupervisor = opmerking;
      r.status = "wacht-monteur";
      r.retourOp = new Date().toISOString();
    });
    const pushUit = await push.stuur(rec.monteurId, pushTekst(rec.taal, id, await wachtendVoor(rec.monteurId)));
    return res.status(200).json({ ok: true, id, status: uit.status, push: pushUit });
  }

  /* verificatie (monteur) */
  if (M === "PUT" && r2 === "verificatie") {
    if (!eigenaar) return res.status(401).json({ error: "alleen de monteur van deze memo" });
    if (rec.status !== "wacht-monteur") return res.status(409).json({ error: "memo wacht niet op de monteur (status " + rec.status + ")" });
    const body = await getBody(req);
    const akkoord = body.akkoord === true || body.akkoord === "ja";
    const opmerking = sanitizeTekst(body.opmerking, 1000);
    if (!akkoord && !opmerking) return res.status(400).json({ error: "geef aan wat er niet klopt" });
    const issues = body.issues !== undefined ? sanitizeIssues(body.issues) : null;
    const uit = await memo.werkBij(id, { type: akkoord ? "monteur-akkoord" : "monteur-klopt-niet", door: wie, data: { opmerking } }, (r) => {
      if (issues) r.issues = issues;
      r.opmerkingMonteur = opmerking;
      r.status = akkoord ? "monteur-akkoord" : "wacht-supervisor";
      r.akkoordOp = akkoord ? new Date().toISOString() : null;
    });
    return res.status(200).json({ ok: true, id, status: uit.status });
  }

  /* doorsturen naar de wachtkamer (supervisor) */
  if (M === "POST" && r2 === "doorsturen") {
    if (!admin) return res.status(401).json({ error: "unauthorized" });
    if (!["monteur-akkoord", "doorsturen-mislukt"].includes(rec.status)) {
      return res.status(409).json({ error: "pas doorsturen als de monteur akkoord is (status " + rec.status + ")" });
    }
    if (!diagnose.geconfigureerd()) return res.status(503).json({ error: "DIAGNOSE_ADMIN_TOKEN ontbreekt" });
    const body = await getBody(req);
    let doelBoek;
    try { doelBoek = diagnose.kiesDoelBoek(body.doelBoek); } catch (e) { return res.status(400).json({ error: e.message }); }
    let bron = rec;
    if (!rec.audioToken) bron = await memo.werkBij(id, { type: "audiotoken-aangemaakt", door: wie }, (r) => { r.audioToken = randomToken(); });
    const resultaat = await diagnose.stuurDoor(bron, doelBoek, audioUrlVoor(bron));
    const allesOk = resultaat.every((x) => x.status >= 200 && x.status < 300);
    const uit = await memo.werkBij(id, { type: allesOk ? "doorgestuurd" : "doorsturen-mislukt", door: wie, data: { doelBoek, resultaat } }, (r) => {
      r.doelBoek = doelBoek;
      r.diagnose = resultaat;
      r.status = allesOk ? "in-wachtkamer" : "doorsturen-mislukt";
      r.doorgestuurdOp = allesOk ? new Date().toISOString() : null;
    });
    return res.status(200).json({ ok: allesOk, id, status: uit.status, resultaat });
  }

  /* intrekken (supervisor) — niets wordt gewist */
  if (M === "DELETE" && !r2) {
    if (!admin) return res.status(401).json({ error: "unauthorized" });
    const body = await getBody(req);
    const reden = sanitizeTekst(body.reden || req.query.reden, 500);
    if (!reden) return res.status(400).json({ error: "reden ontbreekt" });
    const uit = await memo.werkBij(id, { type: "ingetrokken", door: wie, data: { reden } }, (r) => {
      r.statusVoorIntrekken = r.status;
      r.status = "ingetrokken";
      r.ingetrokkenReden = reden;
      r.ingetrokkenOp = new Date().toISOString();
    });
    return res.status(200).json({ ok: true, id, status: uit.status });
  }

  return res.status(405).json({ error: "onbekende actie" });
};
