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

  /* Maak een leesbare naam uit monteur + eerste symptoom (uit de AI-structuur).
     Zonder structuur: monteur + eerste 40 tekens van het transcript. */
  function leesbareNaam(rec) {
    let kern = "";
    if (rec && rec.structuur) {
      const m = String(rec.structuur).match(/^Symptoom:\s*(.+)$/m);
      if (m && m[1]) kern = m[1].trim();
    }
    if (!kern && rec && rec.transcript) kern = String(rec.transcript).slice(0, 40);
    const monteur = sanitizeNaam(rec && rec.monteur ? rec.monteur : "onbekend") || "onbekend";
    return monteur + " — " + (sanitizeNaam(kern) || "zonder symptoom");
  }

  /* Geldig doel-boek voor de diagnose-app. 'sunshower' is ALTIJD geblokkeerd. */
  function geldigDoelBoek(v) {
    if (typeof v !== "string") return false;
    const b = v.trim();
    if (!b || b.length > 60 || !/^[a-zA-Z0-9_-]+$/.test(b)) return false;
    return b !== "sunshower";
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
    if (!transcript) return res.status(400).json({ error: "transcript is leeg — vul het aan vóór goedkeuren" });
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ error: "memo niet gevonden" });
    const rec = JSON.parse(gevonden.raw);
    rec.transcript = transcript;
    if (structuur) rec.structuur = structuur;
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
    let diagnoseResult = null;
    if (DIAGNOSE_ADMIN_TOKEN) {
      try {
        /* Gebruik de AI-gestructureerde vorm (Model→Symptoom→Analyse→Fix→Controle)
           als die er is, anders de rauwe tekst. De structuur als .dot-tekst
           laten parsen door tekstNaarKaarten → vertakte faulttree.
           2026-08-25: naam = leesbaar (monteur — symptoom) i.p.v. spraakbericht-<id>. */
        const inhoud = rec.structuur || transcript;
        const diagnoseBody = JSON.stringify({
          soort: "tekst",
          inhoud: inhoud,
          naam: leesbareNaam(rec),
          boek: doelBoek,
          lang: "nl"
        });
        const dr = await fetch(DIAGNOSE_API_BASE + "/api/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + DIAGNOSE_ADMIN_TOKEN
          },
          body: diagnoseBody
        });
        const dtxt = await dr.text();
        diagnoseResult = { status: dr.status, body: dtxt.slice(0, 500) };
        rec.diagnoseStatus = dr.status;
        if (dr.ok) {
          try { rec.diagnoseTreeId = JSON.parse(dtxt).treeId || null; } catch (e) {}
        }
      } catch (e) {
        diagnoseResult = { status: 0, body: "fout: " + (e && e.message) };
        rec.diagnoseStatus = "fout";
      }
    } else {
      rec.diagnoseStatus = "niet-geconfigureerd"; // DIAGNOSE_ADMIN_TOKEN ontbreekt
    }

    await cmd(["SET", boekKey(boek, P + id), JSON.stringify(rec)]);
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
    const status = String(body.status || "verwerkt");
    const gevonden = await haalMemo(boek, id);
    if (!gevonden) return res.status(404).json({ error: "memo niet gevonden" });
    const rec = JSON.parse(gevonden.raw);
    rec.transcript = transcript; rec.status = status; rec.verwerktOp = new Date().toISOString();
    if (structuur) rec.structuur = structuur;
    await cmd(["SET", boekKey(boek, P + id), JSON.stringify(rec)]);
    return res.status(200).json({ ok: true, id });
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

  /* GET /api/spraakbericht (admin/Mac, lijst) */
  if (req.method === "GET") {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const alleenNieuw = String(req.query.status || "") === "nieuw";
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
      items.push({ id: rec.id, monteur: rec.monteur, tekst: rec.tekst, audioType: rec.audioType, ts: rec.ts, status: rec.status, transcript: rec.transcript, heeftAudio: !!rec.audio, structuur: rec.structuur || null, diagnoseStatus: rec.diagnoseStatus || null, diagnoseTreeId: rec.diagnoseTreeId || null });
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return res.status(200).json({ spraakberichten: items });
  }

  return res.status(405).json({ error: "method" });
};
