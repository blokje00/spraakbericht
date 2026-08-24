/* ============================================================
   tools/mock-server.js — TEST-backend voor de monteursapp.
   Draait het contract dat de BESTAANDE Sunshower-app straks moet
   bieden: POST /api/monteuridee ontvangen en opslaan als
   monteuridee:<id>. Zo kun je de app ontwikkelen/testen zonder
   de echte Vercel-backend (die heeft het endpoint nog niet).

   Start:  node tools/mock-server.js   (poort 52344)
   Zet daarna in config.js: API_BASE = "http://localhost:52344"
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 52344;
const OUTDIR = path.join(__dirname, "..", "uitzendingen");
const LEADERBOARD_FILE = path.join(__dirname, "..", "uitzendingen", "_leaderboard.json");
const PYTHON = process.env.STT_PYTHON || "/Users/pjpjvanzandvoort/.hermes/hermes-agent/venv/bin/python3.11";
const STT_SCRIPT = process.env.STT_SCRIPT || "/Users/pjpjvanzandvoort/dev/dictation-app/whisper_stt.py";
const FFMPEG = process.env.FFMPEG || "ffmpeg";

if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

/* Zorg dat de uitvoermap altijd bestaat — de map kan onderweg verwijderd
   zijn (opruiming) terwijl de server nog draait; zonder dit faalt een
   schrijfactie met ENOENT. */
function verzekerMap() {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
}

/* ── Leaderboard: tel submissies per monteur (duurzaam in een JSON-bestand). ── */
function leesLeaderboard() {
  try { return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8")); }
  catch (e) { return {}; }
}
function schrijfLeaderboard(tellers) {
  verzekerMap();
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(tellers, null, 2));
}
function telOp(monteur) {
  if (!monteur) return;
  const t = leesLeaderboard();
  t[monteur] = (t[monteur] || 0) + 1;
  schrijfLeaderboard(t);
}

/* Transcribeer een audio-bestand lokaal met whisper_stt.py.
   Return: transcript-string of null (geen spraak / mislukt / te kort). */
function transcribe(wavPath) {
  return new Promise((resolve) => {
    const r = require("child_process").spawnSync(PYTHON, [STT_SCRIPT, wavPath], {
      encoding: "utf8", timeout: 60000
    });
    if (r.status !== 0) {
      console.error("[stt] whisper_stt.py exit", r.status, String(r.stderr).trim());
      return resolve(null);
    }
    const t = String(r.stdout || "").trim();
    resolve(t || null);
  });
}

/* .webm → 16kHz mono .wav via ffmpeg (sneller dan in JS). */
function webmNaarWav(webmPath, wavPath) {
  return new Promise((resolve) => {
    const r = require("child_process").spawnSync(FFMPEG, [
      "-y", "-i", webmPath, "-ar", "16000", "-ac", "1", wavPath
    ], { encoding: "utf8", timeout: 60000 });
    resolve(r.status === 0);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 20 * 1024 * 1024) { req.destroy(); reject(new Error("te groot")); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "POST" && req.url.startsWith("/api/monteuridee")) {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const id = "monteuridee_" + Date.now();
      verzekerMap();
      const record = {
        id,
        ontvangen: new Date().toISOString(),
        boek: body.boek,
        monteur: body.monteur,
        audioType: body.audioType,
        audioBytes: body.audio ? Math.round(body.audio.length * 0.75) : 0, // base64 → bytes schatting
        tekst: body.tekst,
        heeftAudio: !!(body.audio && body.audio.length > 100)
      };
      fs.writeFileSync(path.join(OUTDIR, id + ".json"), JSON.stringify(record, null, 2));
      // sla de audio los op als webm zodat je hem kunt beluisteren
      if (body.audio) {
        fs.writeFileSync(path.join(OUTDIR, id + ".webm"), Buffer.from(body.audio, "base64"));
        // transcriptie (best-effort, lokaal): webm → wav → whisper_stt.py → transcript.txt
        try {
          const webmPath = path.join(OUTDIR, id + ".webm");
          const wavPath = path.join(OUTDIR, id + ".wav");
          if (await webmNaarWav(webmPath, wavPath)) {
            const t = await transcribe(wavPath);
            if (t) {
              record.transcript = t;
              fs.writeFileSync(path.join(OUTDIR, id + ".transcript.txt"), t);
              fs.writeFileSync(path.join(OUTDIR, id + ".json"), JSON.stringify(record, null, 2));
            }
            fs.unlinkSync(wavPath); // opruimen
          }
        } catch (e) {
          console.error("[stt] transcriptie mislukt:", e.message);
        }
      }
      console.log("[ontvangen]", id, "monteur=", body.monteur, "audio=", record.heeftAudio, "transcript=", record.transcript ? "ja" : "nee", "tekst=", (body.tekst || "").slice(0, 40));
      telOp(body.monteur); // leaderboard-teller
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, id }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "ongeldige submissie: " + e.message }));
    }
  }

  if (req.method === "GET" && req.url.startsWith("/api/uitzendingen")) {
    const files = fs.readdirSync(OUTDIR).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort().reverse();
    const detail = files.map((f) => {
      const id = f.replace(/\.json$/, "");
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(path.join(OUTDIR, f), "utf8")); } catch (e) {}
      const webm = path.join(OUTDIR, id + ".webm");
      const txt = path.join(OUTDIR, id + ".transcript.txt");
      return {
        id,
        monteur: rec.monteur || "onbekend",
        ontvangen: rec.ontvangen || null,
        audioType: rec.audioType || null,
        heeftAudio: fs.existsSync(webm),
        audioUrl: "/uitzendingen/" + id + ".webm",
        transcript: rec.transcript || null,
        tekst: rec.tekst || "",
        heeftTranscript: fs.existsSync(txt)
      };
    });
    return res.end(JSON.stringify({ uitzendingen: detail }));
  }

  if (req.method === "GET" && req.url.startsWith("/uitzendingen/")) {
    const file = path.basename(req.url.split("?")[0]);
    const full = path.join(OUTDIR, file);
    if (fs.existsSync(full) && (file.endsWith(".webm") || file.endsWith(".wav") || file.endsWith(".transcript.txt"))) {
      res.writeHead(200, {
        "Content-Type": file.endsWith(".webm") ? "audio/webm" : file.endsWith(".wav") ? "audio/wav" : "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "niet gevonden" }));
  }

  if (req.method === "GET" && req.url.startsWith("/api/leaderboard")) {
    const tellers = leesLeaderboard();
    const gesorteerd = Object.entries(tellers)
      .map(([monteur, aantal]) => ({ monteur, aantal }))
      .sort((a, b) => b.aantal - a.aantal);
    return res.end(JSON.stringify({ leaderboard: gesorteerd }));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "niet gevonden" }));
});

server.listen(PORT, () => {
  console.log("Mock-backend draait op http://localhost:" + PORT);
  console.log("Zet in config.js: API_BASE = 'http://localhost:" + PORT + "'");
});
