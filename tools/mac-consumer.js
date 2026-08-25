#!/usr/bin/env node
/* ============================================================
   tools/mac-consumer.js — LOKALE transcriptie-consumer op Patricks Mac.
   ------------------------------------------------------------
   Architectuur (2026-08-24): frontend + ontvangst op Vercel, transcriptie
   lokaal. Monteurs sturen een spraakmemo naar de publieke Vercel-API; dit
   script polt die API, haalt nieuwe memo's op, transcribeert ze LOKAAL met
   whisper_stt.py (faster-whisper base), en schrijft het transcript terug.

   De originele audio blijft altijd bewaard op Vercel (base64 in Redis) én
   wordt lokaal weggeschreven naar ./uitzendingen voor de review.

   Gebruik:
     node tools/mac-consumer.js            # één poll-ronde
     node tools/mac-consumer.js --watch    # blijf pollen elke 30s

   Env:
     API_BASE   (default: https://sunshower-diagnose.vercel.app)
     TOKEN      (ADMIN_TOKEN van Vercel — voor GET + transcript-POST)
     BOEK       (default: inbox — eigen namespace van de spraakbericht-app)
   ============================================================ */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");

/* ── .env.local automatisch laden (geen dotenv-dependency) ──
   Zo pakt launchd ook de ADMIN_TOKEN op zonder env te hoeven zetten. */
(function laadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const API_BASE = process.env.API_BASE || "https://spraakbericht.vercel.app";
const TOKEN = process.env.TOKEN || process.env.ADMIN_TOKEN || "";
const BOEK = process.env.BOEK || "inbox"; // 2026-08-25: namespace 'sunshower' → 'inbox'
const WATCH = process.argv.includes("--watch");
const INTERVAL = 30000;
const OUTDIR = path.join(__dirname, "..", "uitzendingen");
const PYTHON = process.env.STT_PYTHON || "/Users/pjpjvanzandvoort/.hermes/hermes-agent/venv/bin/python3.11";
const STT_SCRIPT = process.env.STT_SCRIPT || "/Users/pjpjvanzandvoort/dev/dictation-app/whisper_stt.py";
/* 2026-08-25 (bugfix): absoluut ffmpeg-pad i.p.v. kale "ffmpeg". De launchd-
   consumer heeft een minimale PATH (zonder /opt/homebrew/bin), waardoor
   spawnSync ffmpeg ENOENT gooide en elke memo eindeloos herverwerkt werd.
   Zelfde aanpak als STT_PYTHON/STT_SCRIPT (al absoluut). */
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

/* ── HTTP helper (https voor Vercel) ── */
function request(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const u = new URL(url);
    const opts = {
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({}, headers || {}),
    };
    if (body) opts.headers["Content-Length"] = Buffer.byteLength(body);
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/* base64 → bestand */
function base64NaarBestand(b64, outPath) {
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
}

/* .webm → 16kHz mono .wav → whisper_stt.py → transcript */
function transcribe(webmPath) {
  const wavPath = webmPath.replace(/\.webm$/, ".wav");
  execFileSync(FFMPEG, ["-y", "-i", webmPath, "-ar", "16000", "-ac", "1", wavPath]);
  const out = execFileSync(PYTHON, [STT_SCRIPT, wavPath], { encoding: "utf8" });
  fs.unlinkSync(wavPath); // opruimen
  return String(out || "").trim();
}

/* Deel 1 + 4b: transcript → samengevoegde structuur (structuur-faulttree.js)
   + losse issues (split-symptomen.js). Optioneel en niet-blokkerend: bij falen
   levert dit { structuur: null, issues: [] }, de approve kan dan alsnog met de
   rauwe tekst doorsturen. 2026-08-25: split bij meerdere symptomen in één memo. */
function structureer(transcript) {
  const script = path.join(__dirname, "split-symptomen.js");
  if (!fs.existsSync(script)) return { structuur: null, issues: [] };
  try {
    const out = execFileSync(process.execPath, [script, transcript], {
      encoding: "utf8", timeout: 120000,
    });
    const s = String(out || "").trim();
    if (!s) return { structuur: null, issues: [] };
    try {
      const parsed = JSON.parse(s);
      return {
        structuur: parsed && parsed.structuur ? parsed.structuur : null,
        issues: Array.isArray(parsed && parsed.issues) ? parsed.issues : []
      };
    } catch (e) {
      console.error("[structurering] split-output niet JSON:", e && e.message);
      return { structuur: null, issues: [] };
    }
  } catch (e) {
    console.error("[structurering] fout:", e && e.message);
    return { structuur: null, issues: [] };
  }
}

/* 2026-08-25 (bugfix): re-entrancy-guard. De verwerking (whisper + split met
   taalmodel) kan langer duren dan het 30s-poll-interval; zonder guard startte
   de volgende tick dezelfde nog-'nieuw'-memo opnieuw op (dubbele transcriptie,
   dubbele taalmodel-kosten). 'bezig' blokkeert een tweede poll zolang de
   vorige nog loopt — setInterval kan een tick gewoon overslaan. */
let bezig = false;

async function poll() {
  if (bezig) return;
  bezig = true;
  try {
    const url = `${API_BASE}/api/spraakbericht?boek=${BOEK}&status=nieuw`;
    const res = await request("GET", url, null, { Authorization: "Bearer " + TOKEN });
    if (res.status !== 200) {
      console.error(`[poll] GET gaf ${res.status}: ${res.body.slice(0, 200)}`);
      return;
    }
    const data = JSON.parse(res.body);
    const nieuw = data.spraakberichten || [];
    if (!nieuw.length) { console.log("[poll] geen nieuwe memo's"); return; }
    console.log(`[poll] ${nieuw.length} nieuwe memo's`);
    for (const memo of nieuw) {
      if (!memo.heeftAudio) { console.log(`[poll] ${memo.id}: geen audio, overslaan`); continue; }
      console.log(`[poll] verwerk ${memo.id} (${memo.monteur})`);
      /* haal de audio op: GET /api/spraakbericht/:id → { audio (base64) } */
      const one = await request("GET", `${API_BASE}/api/spraakbericht/${memo.id}?boek=${BOEK}`, null,
        { Authorization: "Bearer " + TOKEN });
      const oneData = JSON.parse(one.body);
      if (!oneData.audio) { console.log(`[poll] ${memo.id}: geen audio in detail`); continue; }
      const webmPath = path.join(OUTDIR, memo.id + ".webm");
      base64NaarBestand(oneData.audio, webmPath);
      let transcript = "";
      try {
        transcript = transcribe(webmPath);
      } catch (e) {
        console.error(`[poll] ${memo.id}: transcriptie mislukt: ${e.message}`);
        continue;
      }
      fs.writeFileSync(path.join(OUTDIR, memo.id + ".transcript.txt"), transcript);
      /* Deel 1 + 4b: structureer + splits op in losse issues
         (Model/Symptoom/Analyse/Fix/Controle per issue). */
      const st = structureer(transcript);
      const structuur = st.structuur;
      const issues = st.issues;
      if (structuur) fs.writeFileSync(path.join(OUTDIR, memo.id + ".structuur.txt"), structuur);
      if (issues.length) fs.writeFileSync(path.join(OUTDIR, memo.id + ".issues.json"), JSON.stringify(issues, null, 2));
      /* schrijf transcript + structuur + issues terug naar Vercel */
      const upd = await request("POST",
        `${API_BASE}/api/spraakbericht/${memo.id}/transcript?boek=${BOEK}`,
        JSON.stringify({ transcript, structuur: structuur || null, issues: issues.length ? issues : null, status: "verwerkt" }),
        { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN });
      console.log(`[poll] ${memo.id}: transcript teruggeschreven (${upd.status})` +
        (structuur ? " + structuur" : " (geen structuur)") +
        (issues.length ? ` + ${issues.length} issue(s)` : ""));
    }
  } catch (e) {
    console.error("[poll] fout:", e.message);
  } finally {
    bezig = false;
  }
}

if (WATCH) {
  console.log(`[consumer] watch-modus, poll elke ${INTERVAL / 1000}s naar ${API_BASE}`);
  poll();
  setInterval(poll, INTERVAL);
} else {
  poll();
}
