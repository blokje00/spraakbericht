/* api/spraakbericht.js — de API voor de spraakbericht-app (zelfstandig).
   ------------------------------------------------------------
   POST /api/spraakbericht            → monteur stuurt memo (audio base64 + tekst), anoniem
   GET  /api/spraakbericht            → admin/Mac: lijst memo's
   GET  /api/spraakbericht?status=nieuw → alleen onverwerkte (voor de Mac-consumer)
   GET  /api/spraakbericht/:id        → admin/Mac: één memo incl. audio
   POST /api/spraakbericht/:id/transcript → Mac schrijft transcript + status terug
   GET  /api/spraakbericht/leaderboard → per-monteur telling (publiek)

   Beveiliging: POST (monteur) anoniem → throttle + validId + sanitize.
   De overige routes vereisen Authorization: Bearer <ADMIN_TOKEN> (de Mac-consumer).
   ------------------------------------------------------------ */
const { configured, cmd, boekKey } = require("./_redis");
const { sanitizeTekst, validId } = require("./_sanitize");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GEEN_BEVEILIGING = process.env.GEEN_BEVEILIGING === "1";

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

  const boek = req.query.boek || "sunshower";
  const P = "spraakbericht:";
  const rawRoute = req.query.route;
  const route = Array.isArray(rawRoute) ? rawRoute : String(rawRoute || "").split("/").filter(Boolean);

  /* POST /api/spraakbericht/:id/transcript (Mac-consumer, token) */
  if (req.method === "POST" && route[0] === "spraakbericht" && route[2] === "transcript") {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const id = String(route[1] || "");
    if (!validId(id)) return res.status(400).json({ error: "ongeldig memo-id" });
    const body = await getBody(req);
    const transcript = sanitizeTekst(body.transcript, 5000);
    const status = String(body.status || "verwerkt");
    const bestaand = await cmd(["GET", boekKey(boek, P + id)]);
    if (!bestaand) return res.status(404).json({ error: "memo niet gevonden" });
    const rec = JSON.parse(bestaand);
    rec.transcript = transcript; rec.status = status; rec.verwerktOp = new Date().toISOString();
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
      const counts = (await cmd(["HGETALL", boekKey(boek, P + "counts")])) || [];
      const rij = [];
      /* HGETALL geeft een platte array [k1,v1,k2,v2,...] (of object bij sommige clients) */
      if (Array.isArray(counts)) {
        for (let i = 0; i + 1 < counts.length; i += 2) {
          if (counts[i] == null || counts[i + 1] == null) continue;
          rij.push({ monteur: String(counts[i]), aantal: parseInt(counts[i + 1], 10) || 0 });
        }
      } else {
        for (const k of Object.keys(counts)) rij.push({ monteur: k, aantal: parseInt(counts[k], 10) || 0 });
      }
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
    const raw = await cmd(["GET", boekKey(boek, P + id)]);
    if (!raw) return res.status(404).json({ error: "memo niet gevonden" });
    const rec = JSON.parse(raw);
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
    const raw = await cmd(["GET", boekKey(boek, P + id)]);
    if (!raw) return res.status(404).json({ error: "memo niet gevonden" });
    return res.status(200).json(JSON.parse(raw));
  }

  /* GET /api/spraakbericht (admin/Mac, lijst) */
  if (req.method === "GET") {
    if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
    const alleenNieuw = String(req.query.status || "") === "nieuw";
    const ids = (await cmd(["SMEMBERS", boekKey(boek, P + "index")])) || [];
    const items = [];
    for (const id of ids.slice(0, 200)) {
      const raw = await cmd(["GET", boekKey(boek, P + id)]);
      if (!raw) continue;
      let rec = {}; try { rec = JSON.parse(raw); } catch (e) { continue; }
      if (alleenNieuw && rec.status !== "nieuw") continue;
      items.push({ id: rec.id, monteur: rec.monteur, tekst: rec.tekst, audioType: rec.audioType, ts: rec.ts, status: rec.status, transcript: rec.transcript, heeftAudio: !!rec.audio });
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return res.status(200).json({ spraakberichten: items });
  }

  return res.status(405).json({ error: "method" });
};
