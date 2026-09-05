#!/usr/bin/env node
/* ============================================================
   tools/mac-consumer.js — LOKALE transcriptie-consumer op Patricks Mac
   (herbouwd 2026-09-05).
   ------------------------------------------------------------
   Haalt nieuwe memo's van de API, transcribeert ze via de lokale
   Whisper-server (tools/whisper-server.py, model blijft geladen) in de
   taal van de memo, laat het taalmodel er issues van maken
   (tools/structureer.js) en schrijft alles terug. De memo komt dan op
   'wacht-supervisor'. Mislukt een memo drie keer, dan krijgt hij
   'fout-transcriptie' met de reden, in plaats van eindeloos opnieuw.

   Gebruik:
     node tools/mac-consumer.js            # één ronde
     node tools/mac-consumer.js --watch    # elke 30 s

   Env (of .env.local):
     API_BASE      (default https://spraakbericht.vercel.app)
     ADMIN_TOKEN   (of TOKEN)
     WHISPER_URL   (default http://127.0.0.1:52370)
     FFMPEG        (default /opt/homebrew/bin/ffmpeg — launchd heeft een kale PATH)
     UITZENDINGEN  (map voor lokale kopieën; default ./uitzendingen)
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

(function laadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const API_BASE = (process.env.API_BASE || "https://spraakbericht.vercel.app").replace(/\/$/, "");
const TOKEN = process.env.TOKEN || process.env.ADMIN_TOKEN || "";
const WHISPER_URL = (process.env.WHISPER_URL || "http://127.0.0.1:52370").replace(/\/$/, "");
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const OUTDIR = process.env.UITZENDINGEN || path.join(__dirname, "..", "uitzendingen");
const WATCH = process.argv.includes("--watch");
const INTERVAL = Number(process.env.POLL_INTERVAL_MS || 30000);
const MAX_POGINGEN = 3;
const { structureer } = require("./structureer");

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
if (!TOKEN) { console.error("[consumer] ADMIN_TOKEN ontbreekt"); process.exit(2); }

/* fetch met timeout; Vercel/proxy sluit stille verbindingen, dus per
   verzoek een verse verbinding en bij een netwerkfout twee keer opnieuw. */
async function api(method, pad, body, poging) {
  poging = poging || 1;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(API_BASE + pad, {
      method, signal: ctrl.signal,
      headers: Object.assign({ Authorization: "Bearer " + TOKEN, Connection: "close" }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch (e) { json = { raw: txt }; }
    return { status: r.status, json };
  } catch (e) {
    if (poging < 3) { await new Promise((res) => setTimeout(res, 1000 * poging)); return api(method, pad, body, poging + 1); }
    throw e;
  } finally { clearTimeout(timer); }
}

async function haalAudio(id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(API_BASE + "/api/spraakbericht/" + encodeURIComponent(id) + "/audio", { headers: { Authorization: "Bearer " + TOKEN, Connection: "close" }, signal: ctrl.signal });
    if (!r.ok) throw new Error("audio HTTP " + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(timer); }
}

function naarWav(inPath, wavPath) {
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", inPath, "-ar", "16000", "-ac", "1", wavPath]);
}

async function whisper(wavPath, taal) {
  const r = await fetch(WHISPER_URL + "/transcribe", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: wavPath, language: taal }),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || "whisper HTTP " + r.status);
  return json; // {text, language, duration, seconden}
}

/* pogingen per memo-id binnen dit proces */
const pogingen = new Map();

async function verwerk(m) {
  const id = m.id, taal = m.taal || "nl";
  const n = (pogingen.get(id) || 0) + 1;
  pogingen.set(id, n);
  console.log(`[consumer] ${id} (${m.monteur}, ${taal}) poging ${n}`);
  try {
    const ext = /ogg/.test(m.audioType || "") ? "ogg" : /mp4|m4a|aac/.test(m.audioType || "") ? "m4a" : "webm";
    const bron = path.join(OUTDIR, id + "." + ext);
    const wav = path.join(OUTDIR, id + ".wav");
    fs.writeFileSync(bron, await haalAudio(id));
    naarWav(bron, wav);
    const w = await whisper(wav, taal);
    fs.unlinkSync(wav);
    const transcript = String(w.text || "").trim();
    if (!transcript) throw new Error("whisper gaf een leeg transcript (geen spraak?)");
    fs.writeFileSync(path.join(OUTDIR, id + ".transcript.txt"), transcript);
    let issues = [];
    try { issues = await structureer(transcript, taal); }
    catch (e) { console.error(`[consumer] ${id}: structureren mislukt (gaat door zonder issues): ${e.message}`); }
    if (issues.length) fs.writeFileSync(path.join(OUTDIR, id + ".issues.json"), JSON.stringify(issues, null, 2));
    const upd = await api("POST", "/api/spraakbericht/" + encodeURIComponent(id) + "/transcript", { transcript, issues, taalGedetecteerd: w.language });
    if (upd.status < 200 || upd.status >= 300) throw new Error("terugschrijven HTTP " + upd.status + " " + JSON.stringify(upd.json).slice(0, 200));
    console.log(`[consumer] ${id}: klaar → ${upd.json.status} (${w.duration}s audio, whisper ${w.seconden}s, ${issues.length} issue(s))`);
    pogingen.delete(id);
  } catch (e) {
    console.error(`[consumer] ${id}: mislukt: ${e.message}`);
    if (n >= MAX_POGINGEN) {
      const upd = await api("POST", "/api/spraakbericht/" + encodeURIComponent(id) + "/transcript", { status: "fout-transcriptie", reden: e.message.slice(0, 400) }).catch((e2) => ({ status: 0, json: { error: e2.message } }));
      console.error(`[consumer] ${id}: opgegeven na ${n} pogingen → fout-transcriptie (${upd.status})`);
      pogingen.delete(id);
    }
  }
}

let bezig = false;
async function ronde() {
  if (bezig) return;
  bezig = true;
  try {
    const gezond = await fetch(WHISPER_URL + "/health").then((r) => r.json()).catch(() => null);
    if (!gezond || !gezond.geladen) { console.error("[consumer] whisper-server niet bereikbaar of nog aan het laden op " + WHISPER_URL); return; }
    const lijst = await api("GET", "/api/spraakbericht?status=nieuw");
    if (lijst.status !== 200) { console.error(`[consumer] lijst HTTP ${lijst.status}: ${JSON.stringify(lijst.json).slice(0, 200)}`); return; }
    const nieuw = lijst.json.spraakberichten || [];
    if (!nieuw.length) { console.log("[consumer] geen nieuwe memo's"); return; }
    for (const m of nieuw) {
      if (!m.heeftAudio) { console.log(`[consumer] ${m.id}: geen audio, overslaan`); continue; }
      await verwerk(m);
    }
  } catch (e) {
    console.error("[consumer] fout:", e.message);
  } finally { bezig = false; }
}

ronde().then(() => {
  if (WATCH) { console.log(`[consumer] watch-modus, elke ${INTERVAL / 1000}s (${API_BASE})`); setInterval(ronde, INTERVAL); }
});
