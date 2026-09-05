/* api/spraakbericht.js — de API voor de spraakbericht-app (zelfstandig).
   ------------------------------------------------------------
   POST /api/spraakbericht            → monteur stuurt memo (audio base64 + tekst), anoniem
   GET  /api/spraakbericht            → admin/Mac: lijst memo's
   GET  /api/spraakbericht?status=nieuw → alleen onverwerkte (voor de Mac-consumer)
   GET  /api/spraakbericht/:id        → admin/Mac: één memo incl. audio
   POST /api/spraakbericht/:id/transcript → Mac schrijft transcript + status terug
   POST /api/spraakbericht/:id/approve → admin: edit + stuur door naar diagnose-app (P3/P4)
   GET  /api/spraakbericht/leaderboard → per-monteur telling (publiek)

   Eigen Redis-naamruimte: 'inbox' (sinds 2026-08-25; was 'sunshower', gemigreerd).

   Beveiliging: POST (monteur) anoniem → throttle + validId + sanitize.
   De overige routes vereisen Authorization: Bearer <ADMIN_TOKEN> (de Mac-consumer).
   ------------------------------------------------------------ */
const { configured, cmd, boekKey } = require("./_redis");
const { sanitizeTekst, validId } = require("./_sanitize");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GEEN_BEVEILIGING = process.env.GEEN_BEVEILIGING === "1";
/* Diagnose-app koppeling: waar de goedgekeurde memo heen gestuurd wordt.
   DIAGNOSE_API_BASE = de live diagnose-app; DIAGNOSE_ADMIN_TOKEN = zijn admin-token. */
const DIAGNOSE_API_BASE = process.env.DIAGNOSE_API_BASE || "https://sunshower-diagnose.vercel.app";
const DIAGNOSE_ADMIN_TOKEN = process.env.DIAGNOSE_ADMIN_TOKEN || "";

/* Eigen publieke basis-URL (2026-08-26, Patrick: "ook de originele wav kunnen
   beluisteren bij het nalopen in Treestudio"). Bij goedkeuren bouwen we hier
   de audio-URL van deze memo uit — die verwijzing sturen we mee naar de
   diagnose-app, zodat Treestudio de memo kan afspelen. De ?token= is dezelfde
   ADMIN_TOKEN die review.html al gebruikt voor <audio src=…>. */
const SPRAAKBERICHT_BASE = process.env.SPRAAKBERICHT_BASE || "https://spraakbericht.vercel.app";

function cors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
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

/* autorisatie: geldig ADMIN_TOKEN (Bearer-header) of beveiliging uit. */
function authed(req) {
  if (GEEN_BEVEILIGING) return true;
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return !!token && !!ADMIN_TOKEN && safeEqual(token, ADMIN_TOKEN);
}

/* Toegestane status-waarden voor een memo.
   2026-08-26: 'wacht-monteur' is nieuw — de Mac-consumer zet een memo hierop
   ná transcriptie maar vóórdat de monteur de AI-issues geverifieerd/ingevuld
   heeft. Zo blijft de memo zichtbaar voor de monteur (push) maar wordt hij pas
   na verificatie (→ 'verwerkt') door Patrick goedgekeurd. */
const STATUS_WAITLIST = ["nieuw", "wacht-monteur", "verwerkt", "goedgekeurd"];

const SB_MAX_IP_PER_MIN = 30;
const sbHits = new Map();
function sbMagDoorgaan(ip) {
  const nu = Date.now();
  const arr = (sbHits.get(ip) || []).filter((t) => nu - t < 60000);
  if (arr.length >= SB_MAX_IP_PER_MIN) { sbHits.set(ip, arr); return false; }
  arr.push(nu); sbHits.set(ip, arr);
  return true;
}
function sbIp(req) {
  return String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) || "?";
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 12 * 1024 * 1024) { req.destroy(); reject(new Error("te groot")); } });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); } });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (!configured()) return res.status(503).json({ error: "database niet geconfigureerd" });

  /* 2026-08-25: eigen Redis-naamruimte hernoemd van 'sunshower' naar 'inbox'
     (de diagnose-app heeft óók een 'sunshower' boek → verwarrend). Bestaande
     memo's staan nog onder de oude sleutel; haalMemo + de GET-lijst mergen beide. */
  const boek = req.query.boek || "inbox";
  const P = "spraakbericht:";
  const rawRoute = req.query.route;

  /* ── Naamgeving + doel-boek (P3/P4) ─────────────────────────────
     2026-08-25: leesbare bestandsnaam i.p.v. spraakbericht-<id>, en
     per-melding doel-boek met harde blokkade op 'sunshower'. */

  /* Sanitiseer een naamstuk: behoud leesbare letters/cijfers/spaties,
     verwijder tekens die in bestandsnamen/URLs storen. */
  function sanitizeNaam(s) {
    return String(s == null ? "" : s)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  /* Geldig doel-boek voor de diagnose-app. 'sunshower' is ALTIJD geblokkeerd. */
  function geldigDoelBoek(v) {
    if (typeof v !== "string") return false;
    const b = v.trim();
    if (!b || b.length > 60 || !/^[a-zA-Z0-9_-]+$/.test(b)) return false;
    return b !== "sunshower";
  }

  /* Sanitiseer een los issue: per veld veilige tekst, ongewenste velden eruit.
     2026-08-25: issues komen uit de AI-split en uit Patricks review-bewerking. */
  function sanitizeIssue(it) {
    if (!it || typeof it !== "object") return null;
    const o = {};
    for (const k of ["model", "symptoom", "analyse", "fix", "controle"]) {
      o[k] = sanitizeTekst(it[k], 1000);
    }
    if (!o.symptoom && !o.model) return null; // leeg issue overslaan
    return o;
  }
  function sanitizeIssues(v) {
    if (!Array.isArray(v)) return [];
    return v.map(sanitizeIssue).filter(Boolean);
  }

  /* Zet één los issue om naar de faulttree-tekst die de diagnose-app
     (tekstNaarKaarten) tot een vertakte boom verwerkt: een regel per stap. */
  function issueNaarTekst(it) {
    const rijen = [];
    for (const k of ["model", "symptoom", "analyse", "fix", "controle"]) {
      const waarde = it && it[k] ? String(it[k]).trim() : "";
      if (waarde) rijen.push(k.charAt(0).toUpperCase() + k.slice(1) + ": " + waarde);
    }
    return rijen.length ? rijen.join("\n") : "";
  }

  /* Namespace-lijst: actieve boek + legacy 'sunshower' (migratie P5). */
  function namespaceLijst(b) {
    const l = [b];
    if (b !== "sunshower") l.push("sunshower");
    return l;
  }

  /* Haal een memo op uit de actieve of legacy 'sunshower'-namespace. */
  async function haalMemo(b, id) {
    for (const ns of namespaceLijst(b)) {
      const raw = await cmd(["GET", boekKey(ns, P + id)]);
      if (raw) return { ns, raw };
    }
    return null;
  }

  const route = Array.isArray(rawRoute) ? rawRoute : String(rawRoute || "").split("/").filter(Boolean);

  /* POST /api/spraakbericht/:id/approve (admin — edit transcript + stuur door naar diagnose-app) */
  if (req.method === "POST" && route[0] === "spraakbericht" && route[1] && route[2] === "approve") {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const id = String(route[1] || "");
    if (!validId(id)) return res.status(400).json({ error: "ongeldig memo-id" });
    const body = await getBody(req);
    const transcript = sanitizeTekst(body.transcript, 5000);
    const structuur = sanitizeTekst(body.structuur, 3000);
    const issuesBody = sanitizeIssues(body.issues);
    if (!transcript) return res.status(400).json({ error: "transcript is leeg — vul het aan vóór goedkeuren" });
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ error: "memo niet gevonden" });
    const rec = JSON.parse(gevonden.raw);
    rec.transcript = transcript;
    if (structuur) rec.structuur = structuur;
    if (issuesBody.length) rec.issues = issuesBody; // Patricks bewerkte issues winnen
    rec.status = "goedgekeurd";
    rec.goedgekeurdOp = new Date().toISOString();

    /* ── Doorsturen naar de diagnose-app (faulttree-draft) ──
       Harde grens (PLAN §2/§4): NOOIT naar boek 'sunshower'. De bestemming is
       'wachtkamer' (aparte container) of een expliciet gekozen doel-boek.
       Patrick kiest het doel-boek per melding in review.html. Als iemand toch
       'sunshower' als doel probeert door te geven, weigeren we. */
    const DOELBOEK = process.env.DOELBOEK || "wachtkamer";
    if (String(DOELBOEK) === "sunshower") {
      return res.status(400).json({ error: "DOELBOEK mag nooit sunshower zijn — kies een apart boek" });
    }
    let doelBoek = DOELBOEK;
    if (body.doelBoek !== undefined) {
      if (geldigDoelBoek(body.doelBoek)) {
        doelBoek = body.doelBoek;
      } else if (String(body.doelBoek).trim().toLowerCase() === "sunshower") {
        return res.status(400).json({ error: "sunshower mag nooit het doel-boek zijn — kies een apart boek" });
      }
      // andere ongeldige waarde → val terug op DOELBOEK
    }

    /* 2026-08-25 (stap 4b): welke issues sturen we door? Patricks bewerkte
       issues (body.issues) winnen, anders de AI-split uit rec.issues, anders
       één fallback-issue van de samengevoegde structuur of het transcript.
       Bij MEERDERE issues sturen we ELK issue als een aparte import naar de
       diagnose-app; bij één issue gedragen we ons zoals voorheen. */
    let sendIssues = issuesBody.length ? issuesBody : (Array.isArray(rec.issues) ? rec.issues : []);
    if (!sendIssues.length) {
      const fb = { model: "", symptoom: "", analyse: "", fix: "", controle: "" };
      const inhoud = rec.structuur || transcript;
      if (rec.structuur) {
        const m = {};
        for (const line of String(rec.structuur).split(/\r?\n/)) {
          const mm = line.match(/^(Model|Symptoom|Analyse|Fix|Controle):\s*(.+)$/i);
          if (mm) m[mm[1].toLowerCase()] = mm[2].trim();
        }
        fb.model = m.model || ""; fb.symptoom = m.symptoom || ""; fb.analyse = m.analyse || "";
        fb.fix = m.fix || ""; fb.controle = m.controle || "";
      }
      if (!fb.symptoom && !fb.model) fb.symptoom = String(inhoud).slice(0, 300);
      sendIssues = [fb];
    }
    const monteur = rec && rec.monteur ? rec.monteur : "onbekend";

    let diagnoseResult = null;
    if (DIAGNOSE_ADMIN_TOKEN) {
      try {
        const resultaten = [];
        for (const issue of sendIssues) {
          /* Per issue: faulttree-tekst (Model→…→Controle) als inhoud, en een
             leesbare naam '<monteur> — <symptoom>' zodat elk issue apart te
             herkennen is in de diagnose-app. */
          const inhoud = issueNaarTekst(issue) || (rec.structuur || transcript);
          const naam = sanitizeNaam(monteur) + " — " + (sanitizeNaam(issue && issue.symptoom) || "zonder symptoom");
          /* 2026-08-26 (audio-koppeling): de originele memo-audio hoort bij
             de doorgezonden tekst. De diagnose-app bewaart deze verwijzing
             bij de draft en toont een speler in Treestudio — zonder de
             verwijzing blijft de audio achter in deze app. */
          const audioUrl = SPRAAKBERICHT_BASE + "/api/spraakbericht/"
            + encodeURIComponent(id) + "/audio?token=" + encodeURIComponent(ADMIN_TOKEN);
          const dr = await fetch(DIAGNOSE_API_BASE + "/api/import", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + DIAGNOSE_ADMIN_TOKEN
            },
            body: JSON.stringify({
              soort: "tekst",
              inhoud: inhoud,
              naam: naam,
              boek: doelBoek,
              lang: "nl",
              spraakbericht: { id, audioUrl },
            })
          });
          const dtxt = await dr.text();
          resultaten.push({ status: dr.status, body: dtxt.slice(0, 500), naam, symptoom: (issue && issue.symptoom) || "" });
        }
        diagnoseResult = sendIssues.length > 1 ? resultaten : resultaten[0];
        const statuses = resultaten.map((r) => r.status);
        rec.diagnoseStatus = sendIssues.length > 1
          ? ("meervoudig " + statuses.join(","))
          : statuses[0];
        if (sendIssues.length === 1 && resultaten[0] && resultaten[0].status === 200) {
          try { rec.diagnoseTreeId = JSON.parse(resultaten[0].body).treeId || null; } catch (e) {}
        }
      } catch (e) {
        diagnoseResult = { status: 0, body: "fout: " + (e && e.message) };
        rec.diagnoseStatus = "fout";
      }
    } else {
      rec.diagnoseStatus = "niet-geconfigureerd"; // DIAGNOSE_ADMIN_TOKEN ontbreekt
    }

    /* 2026-08-25 (bugfix): schrijf terug naar de namespace waar de memo
       GEVONDEN is (gevonden.ns), niet naar de actieve 'boek'. Anders bleef
       een legacy 'sunshower'-memo op status 'nieuw' staan terwijl er een
       'inbox'-kopie met 'goedgekeurd' naast kwam → de consumer (pollt op
       status=nieuw) herverwerkte de memo eindeloos. */
    await cmd(["SET", boekKey(gevonden.ns, P + id), JSON.stringify(rec)]);
    return res.status(200).json({ ok: true, id, status: rec.status, diagnoseResult });
  }

  /* POST /api/spraakbericht/:id/transcript (Mac-consumer, token) */
  if (req.method === "POST" && route[0] === "spraakbericht" && route[2] === "transcript") {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const id = String(route[1] || "");
    if (!validId(id)) return res.status(400).json({ error: "ongeldig memo-id" });
    const body = await getBody(req);
    const transcript = sanitizeTekst(body.transcript, 5000);
    const structuur = sanitizeTekst(body.structuur, 3000);
    const issues = sanitizeIssues(body.issues);
    const status = STATUS_WAITLIST.includes(String(body.status || "")) ? String(body.status) : "verwerkt";
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ error: "memo niet gevonden" });
    const rec = JSON.parse(gevonden.raw);
    rec.transcript = transcript; rec.status = status; rec.verwerktOp = new Date().toISOString();
    if (structuur) rec.structuur = structuur;
    if (issues && issues.length) rec.issues = issues; else delete rec.issues;
    /* 2026-08-25 (bugfix): terugschrijven naar gevonden.ns (zie approve). */
    await cmd(["SET", boekKey(gevonden.ns, P + id), JSON.stringify(rec)]);
    return res.status(200).json({ ok: true, id });
  }

  /* PUT /api/spraakbericht/:id/verificatie (monteur, token)
     2026-08-26: de monteur heeft via push-notificatie gezien dat zijn memo
     klaar is om te verifiëren. Hij stuurt de AI-issues terug met aangevulde
     velden (fix/analyse). Per issue-index wint een niet-lege clientwaarde,
     lege waarden behouden de bestaande AI-split. Zodra geverifieerd → status
     'verwerkt', zodat Patrick kan goedkeuren. */
  if (req.method === "PUT" && route[0] === "spraakbericht" && route[1] && route[2] === "verificatie") {
    /* 2026-09-01 (fix): de monteur-PWA stuurt AUTH_TOKEN:"" (geen admin-token),
       dus deze PUT MOET publiek zijn — net als de GET ?monteur= (2026-08-26).
       Anders faalt 'Opnieuw indienen' met 401. Eigenaarschap wordt niet
       gecheckt (interne tool), consistent met GET ?monteur=. */
    const id = String(route[1] || "");
    if (!validId(id)) return res.status(400).json({ ok: false, error: "ongeldig memo-id" });
    const body = await getBody(req);
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ ok: false, error: "memo niet gevonden" });
    const rec = JSON.parse(gevonden.raw);
    if (!Array.isArray(rec.issues) || !rec.issues.length) {
      return res.status(400).json({ ok: false, error: "memo heeft geen issues om te verifiëren" });
    }
    const clientIssues = Array.isArray(body.issues) ? body.issues : [];
    rec.issues = rec.issues.map((bestaand, i) => {
      const client = clientIssues[i];
      if (!client || typeof client !== "object") return bestaand;
      const uit = {};
      for (const k of ["model", "symptoom", "analyse", "fix", "controle"]) {
        const v = String(client[k] == null ? "" : client[k]).trim();
        uit[k] = v ? v : (bestaand && bestaand[k]) || "";
      }
      return uit;
    });
    rec.status = "verwerkt";
    rec.verwerktOp = new Date().toISOString();
    await cmd(["SET", boekKey(gevonden.ns, P + id), JSON.stringify(rec)]);
    return res.status(200).json({ ok: true, id, status: rec.status });
  }

  /* POST /api/push/subscribe (monteur, anoniem)
     2026-08-26: de PWA slaat de web-push-subscription van de monteur op onder
     push:<monteur>, zodat de Mac-consumer hem later een 'memo klaar'-notificatie
     kan sturen. Idempotent — overschrijven ok (herregistratie na refresh/device). */
  if (req.method === "POST" && route[0] === "push" && route[1] === "subscribe") {
    const body = await getBody(req);
    const monteur = sanitizeTekst(body.monteur, 80);
    if (!monteur) return res.status(400).json({ ok: false, error: "monteur ontbreekt" });
    if (!body.subscription || typeof body.subscription !== "object") {
      return res.status(400).json({ ok: false, error: "subscription ontbreekt" });
    }
    await cmd(["SET", "push:" + monteur, JSON.stringify(body.subscription)]);
    return res.status(200).json({ ok: true });
  }

  /* POST /api/push/notify (Mac-consumer, token)
     2026-08-26: stuur de monteur een web-push dat zijn memo klaar is om te
     verifiëren. Zonder subscription → {ok:true, notified:false}. Zonder
     VAPID-keys slaan we over (log) i.p.v. te crashen — een push-fout mag de
     poll van de consumer nooit breken (niet-blokkerend). */
  if (req.method === "POST" && route[0] === "push" && route[1] === "notify") {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const body = await getBody(req);
    const monteur = String(body.monteur || "");
    const id = String(body.id || "");
    if (!monteur) return res.status(400).json({ ok: false, error: "monteur ontbreekt" });
    const raw = await cmd(["GET", "push:" + monteur]);
    if (!raw) return res.status(200).json({ ok: true, notified: false });
    let subscription;
    try { subscription = JSON.parse(raw); } catch (e) { subscription = null; }
    if (!subscription || !subscription.endpoint) {
      return res.status(200).json({ ok: true, notified: false });
    }
    const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY,
      subject = process.env.VAPID_SUBJECT;
    if (!pub || !priv || !subject) {
      console.error("[push] VAPID-keys ontbreken — notificatie overgeslagen voor " + monteur);
      return res.status(200).json({ ok: false, error: "no-vapid" });
    }
    try {
      const webpush = require("web-push");
      webpush.setVapidDetails(subject, pub, priv);
      await webpush.sendNotification(subscription, JSON.stringify({
        title: "Nieuwe memo klaar",
        body: "Er is een spraakmemo klaar om te verifiëren",
        id,
      }));
      return res.status(200).json({ ok: true, notified: true });
    } catch (e) {
      console.error("[push] verzenden mislukt voor " + monteur + ": " + (e && e.message));
      return res.status(200).json({ ok: false, error: "push-fout", notified: false });
    }
  }

  /* POST /api/spraakbericht (monteur, anoniem) */
  if (req.method === "POST") {
    if (!sbMagDoorgaan(sbIp(req))) return res.status(429).json({ error: "te veel verzoeken" });
    const body = await getBody(req);
    const monteur = sanitizeTekst(body.monteur, 80) || "onbekend";
    const tekst = sanitizeTekst(body.tekst, 500);
    const audioType = sanitizeTekst(body.audioType, 60);
    const audio = String(body.audio || "");
    if (!audio || audio.length < 50) return res.status(400).json({ error: "geen audio ontvangen" });
    if (audio.length > 8 * 1024 * 1024) return res.status(413).json({ error: "audio te groot" });
    const id = "memo_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const rec = { id, monteur, tekst, audioType, audio, ts: Date.now(), status: "nieuw", transcript: null };
    await cmd(["SET", boekKey(boek, P + id), JSON.stringify(rec)]);
    await cmd(["SADD", boekKey(boek, P + "index"), id]);
    await cmd(["HINCRBY", boekKey(boek, P + "counts"), monteur, "1"]);
    return res.status(200).json({ ok: true, id });
  }

  /* GET /api/spraakbericht/leaderboard (publiek) */
  if (req.method === "GET" && route[0] === "spraakbericht" && route[1] === "leaderboard") {
    try {
      /* 2026-08-25: merge tellingen uit actieve + legacy 'sunshower'-namespace. */
      const counts = {};
      for (const ns of namespaceLijst(boek)) {
        const raw = (await cmd(["HGETALL", boekKey(ns, P + "counts")])) || [];
        const teller = {};
        if (Array.isArray(raw)) {
          for (let i = 0; i + 1 < raw.length; i += 2) {
            if (raw[i] == null || raw[i + 1] == null) continue;
            teller[String(raw[i])] = parseInt(raw[i + 1], 10) || 0;
          }
        } else {
          for (const k of Object.keys(raw)) teller[k] = parseInt(raw[k], 10) || 0;
        }
        for (const k of Object.keys(teller)) counts[k] = (counts[k] || 0) + teller[k];
      }
      const rij = Object.keys(counts).map((k) => ({ monteur: k, aantal: counts[k] }));
      rij.sort((a, b) => b.aantal - a.aantal);
      return res.status(200).json({ leaderboard: rij });
    } catch (e) {
      return res.status(200).json({ leaderboard: [] }); // leeg leaderboard is geen fout
    }
  }

  /* GET /api/spraakbericht/:id/audio (admin — originele audio als stream voor <audio>) */
  if (req.method === "GET" && route[0] === "spraakbericht" && route[1] && route[2] === "audio") {
    const tokenHeader = req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : "";
    const tokenQ = String(req.query.token || "");
    const authOk = GEEN_BEVEILIGING || (tokenHeader && ADMIN_TOKEN && safeEqual(tokenHeader, ADMIN_TOKEN)) ||
      (tokenQ && ADMIN_TOKEN && safeEqual(tokenQ, ADMIN_TOKEN));
    if (!authOk) return res.status(401).json({ error: "unauthorized" });
    const id = String(route[1]);
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ error: "memo niet gevonden" });
    const rec = JSON.parse(gevonden.raw);
    if (!rec.audio) return res.status(404).json({ error: "geen audio" });
    res.writeHead(200, {
      "Content-Type": rec.audioType || "audio/webm",
      "Content-Length": Buffer.from(rec.audio, "base64").length,
      "Cache-Control": "no-store"
    });
    res.end(Buffer.from(rec.audio, "base64"));
    return;
  }

  /* GET /api/spraakbericht/:id (admin/Mac, incl. audio) */
  if (req.method === "GET" && route[0] === "spraakbericht" && route[1] && route.length === 2) {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const id = String(route[1]);
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ error: "memo niet gevonden" });
    return res.status(200).json(JSON.parse(gevonden.raw));
  }

  /* DELETE /api/spraakbericht/:id (admin — memo, index-entry en teller verwijderen)
     2026-08-26: Patrick wil een onterecht/fout geplaatste memo kunnen weggooien
     zonder restjes. Verwijder via de namespace waar de memo GEVONDEN is
     (gevonden.ns), net als approve/transcript — zo verdwijnt ook een legacy
     'sunshower'-memo correct i.p.v. een lege 'inbox'-copie achter te laten. */
  if (req.method === "DELETE" && route[0] === "spraakbericht" && route[1] && route.length === 2) {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const id = String(route[1]);
    if (!validId(id)) return res.status(400).json({ error: "ongeldig memo-id" });
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ error: "memo niet gevonden" });
    let rec = {}; try { rec = JSON.parse(gevonden.raw); } catch (e) {}
    await cmd(["DEL", boekKey(gevonden.ns, P + id)]);
    await cmd(["SREM", boekKey(gevonden.ns, P + "index"), id]);
    /* 2026-08-26: per-monteur-teller verlagen (telt de geleverde memo's);
       als het rec onvolledig is blijft de teller ongewijzigd. */
    if (rec && rec.monteur) {
      await cmd(["HINCRBY", boekKey(gevonden.ns, P + "counts"), rec.monteur, "-1"]);
    }
    return res.status(200).json({ ok: true, id });
  }

  /* GET /api/spraakbericht (admin/Mac, lijst) — of (monteur) met ?monteur=
     2026-08-26 (fix): de monteur-PWA haalt zijn eigen wachtende memo's op via
     ?monteur=<naam> maar heeft GEEN admin-token (config AUTH_TOKEN is leeg).
     Daarom: zónder ?monteur= blijft de GET admin-only (Mac-consumer/review),
     mét ?monteur= is hij publiek zodat de monteur zijn eigen items ziet. */
  if (req.method === "GET") {
    const alleenNieuw = String(req.query.status || "") === "nieuw";
    const monteurFilter = String(req.query.monteur || "");
    if (!monteurFilter && !authed(req)) return res.status(401).json({ error: "unauthorized" });
    /* 2026-08-26: optioneel filter ?monteur=<naam> — exacte match op rec.monteur.
       Gebruikt door de monteur-PWA om alleen eigen memo's te zien in de
       verificatieflow. Zonder deze param gedraagt de GET zich als voorheen. */
    /* 2026-08-25: merge actieve + legacy 'sunshower'-namespace zodat bestaande
       memo's niet verdwijnen na de hernoeming naar 'inbox'. */
    const ids = [];
    for (const ns of namespaceLijst(boek)) {
      const nsIds = (await cmd(["SMEMBERS", boekKey(ns, P + "index")])) || [];
      for (const i of nsIds) if (!ids.includes(i)) ids.push(i);
    }
    const items = [];
    for (const id of ids.slice(0, 200)) {
      const gevonden = await haalMemo(boek, id);
      if (!gevonden) continue;
      let rec = {}; try { rec = JSON.parse(gevonden.raw); } catch (e) { continue; }
      if (alleenNieuw && rec.status !== "nieuw") continue;
      if (monteurFilter && rec.monteur !== monteurFilter) continue;
      items.push({ id: rec.id, monteur: rec.monteur, tekst: rec.tekst, audioType: rec.audioType, ts: rec.ts, status: rec.status, transcript: rec.transcript, heeftAudio: !!rec.audio, structuur: rec.structuur || null, issues: Array.isArray(rec.issues) ? rec.issues : null, diagnoseStatus: rec.diagnoseStatus || null, diagnoseTreeId: rec.diagnoseTreeId || null, verwerktOp: rec.verwerktOp || null, goedgekeurdOp: rec.goedgekeurdOp || null });
    }
    /* 2026-08-26: aflopend sorteren — jongste memo bovenaan (Patrick: de
       laatst binnenkomende melding moet als eerste in beeld staan). */
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return res.status(200).json({ spraakberichten: items });
  }

  return res.status(405).json({ error: "method" });
};
