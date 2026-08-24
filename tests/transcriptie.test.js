/* ============================================================
   tests/transcriptie.test.js — end-to-end transcriptie-test.
   Maakt een korte WAV met spraak (via `say` + ffmpeg), upload
   als webm naar de lokale mock, bevestigt:
     - HTTP 200
     - audio.opgeslagen (.webm)
     - transcript opgeslagen (.transcript.txt + in JSON)
   Start eerst:  PORT=52346 node tools/mock-server.js
   Run:          npm run test:transcriptie  (of: MOCK_PORT=52346 node ...)
   ============================================================ */
const assert = require("assert");
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = process.env.MOCK_PORT || "52346";
const WAV = "/tmp/ss-verify.wav";
const WEBM = "/tmp/ss-verify.webm";
const OUTDIR = path.join(__dirname, "..", "uitzendingen");
const PYTHON = process.env.STT_PYTHON || "/Users/pjpjvanzandvoort/.hermes/hermes-agent/venv/bin/python3.11";
const STT = process.env.STT_SCRIPT || "/Users/pjpjvanzandvoort/dev/dictation-app/whisper_stt.py";

function skipIfMissing() {
  try { execFileSync("which", ["say"]); } catch { return "say niet beschikbaar"; }
  try { execFileSync("which", ["ffmpeg"]); } catch { return "ffmpeg niet beschikbaar"; }
  if (!fs.existsSync(PYTHON)) return "Python-venv niet gevonden: " + PYTHON;
  if (!fs.existsSync(STT)) return "whisper_stt.py niet gevonden: " + STT;
  return null;
}

const skip = skipIfMissing();
if (skip) { console.log("○ Overgeslagen:", skip); process.exit(0); }

// 1. korte WAV met Nederlandse spraak (Xander-tekst)
execFileSync("say", ["-v", "Xander", "Ik sta bij een klant waar het unit niet start. Ik heb de stroom al aan en uitgezet.", "-o", WAV.replace(/\.wav$/, ".aiff")]);
execFileSync("ffmpeg", ["-y", "-i", WAV.replace(/\.wav$/, ".aiff"), "-ar", "16000", "-ac", "1", WAV]);
assert.ok(fs.existsSync(WAV), "WAV kon niet worden gemaakt");
console.log("✓ Test-WAV gemaakt:", fs.statSync(WAV).size, "bytes");

// 2. → webm (zoals de PWA opstuurt)
execFileSync("ffmpeg", ["-y", "-i", WAV, "-c:a", "libopus", WEBM]);
assert.ok(fs.existsSync(WEBM), "WebM kon niet worden gemaakt");
console.log("✓ WebM gecodeerd:", fs.statSync(WEBM).size, "bytes");

// 3. upload
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

(async () => {
  const audio = fs.readFileSync(WEBM).toString("base64");
  const r = await postJson(`http://localhost:${PORT}/api/monteuridee`, {
    boek: "sunshower", monteur: "Transcriptie Test", audio, audioType: "audio/webm;codecs=opus", tekst: "", ts: Date.now()
  });
  assert.strictEqual(r.status, 200, "mock moet 200 geven, kreeg " + r.status + " " + r.body);
  const parsed = JSON.parse(r.body);
  assert.ok(parsed.ok && parsed.id, "response mist ok/id");
  console.log("✓ Submissie ontvangen, id =", parsed.id);

  // 4. audio + transcript bestaan
  const webmFile = path.join(OUTDIR, parsed.id + ".webm");
  const jsonFile = path.join(OUTDIR, parsed.id + ".json");
  const txtFile = path.join(OUTDIR, parsed.id + ".transcript.txt");

  // de mock transcript het async; even wachten
  let tries = 0;
  while (tries < 20 && !fs.existsSync(txtFile)) { await new Promise((r) => setTimeout(r, 500)); tries++; }

  assert.ok(fs.existsSync(webmFile), "originele audio niet opgeslagen");
  console.log("✓ Originele audio bewaard:", fs.statSync(webmFile).size, "bytes");

  assert.ok(fs.existsSync(jsonFile), "JSON-record niet opgeslagen");
  const rec = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  assert.ok(rec.transcript && rec.transcript.length > 5, "record mist transcript");

  assert.ok(fs.existsSync(txtFile), "transcript.txt niet opgeslagen");
  const txt = fs.readFileSync(txtFile, "utf8");
  assert.ok(txt.length > 5, "transcript.txt is leeg");
  console.log("✓ Transcript opgeslagen:", JSON.stringify(rec.transcript));

  // sanity: transcript moet het Nederlandse woord "klant" of "unit" bevatten
  assert.ok(/klant|unit|start/.test(rec.transcript), "transcript klopt niet: " + rec.transcript);
  console.log("✓ Transcript bevat verwachte woorden (klant/unit/start)");

  console.log("\nTranscriptie-test GESLAAGD — end-to-end werkend.");
})().catch((e) => { console.error("✗ TEST MISLUKT:", e.message); process.exit(1); });
