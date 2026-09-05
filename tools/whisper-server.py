#!/usr/bin/env python3
"""tools/whisper-server.py — lokale spraakherkenning als server (2026-09-05).

Laadt het faster-whisper-model één keer en houdt het in het geheugen; elke
memo kost daarna alleen de herkenning zelf, niet steeds opnieuw ~1 minuut
laden. De taal komt per verzoek mee (nl of de): geen gokken meer.

    GET  /health                → {"ok": true, "model": "...", "geladen": true}
    POST /transcribe            JSON {"path": "/pad/naar/audio.wav", "language": "de"}
                                → {"text": "...", "language": "de", "duration": 12.3}

Env:  WHISPER_MODEL (default small), WHISPER_PORT (default 52370),
      WHISPER_DEVICE (cpu), WHISPER_COMPUTE (int8).
Start: <venv>/bin/python3 tools/whisper-server.py
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
PORT = int(os.environ.get("WHISPER_PORT", "52370"))
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
TALEN = {"nl", "de"}

model = None
model_lock = Lock()

# Woordenlijst per taal (tools/woordenlijst.json): vaktermen als hint voor het
# model, zodat merknamen en onderdelen goed herkend worden.
WOORDENLIJST_PAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "woordenlijst.json")


def laad_woordenlijst():
    try:
        with open(WOORDENLIJST_PAD, encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if k in TALEN and isinstance(v, str)}
    except Exception as e:  # noqa: BLE001
        print(f"[whisper] geen woordenlijst ({e})", flush=True)
        return {}


woordenlijst = laad_woordenlijst()


def laad_model():
    global model
    from faster_whisper import WhisperModel
    t = time.time()
    print(f"[whisper] laad model {MODEL_SIZE} ({DEVICE}/{COMPUTE}) …", flush=True)
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
    print(f"[whisper] model geladen in {time.time() - t:.1f}s", flush=True)


def transcribeer(path, language):
    if language not in TALEN:
        language = None  # laat whisper de taal bepalen (alleen als niets meegegeven is)
    hint = woordenlijst.get(language) if language else None
    with model_lock:
        segments, info = model.transcribe(path, language=language, beam_size=5, vad_filter=True,
                                          initial_prompt=hint)
        text = " ".join(seg.text.strip() for seg in segments)
    text = (text.replace(" ,", ",").replace(" .", ".").replace(" ?", "?")
                .replace(" !", "!").replace(" :", ":").strip())
    return {"text": text, "language": info.language, "duration": round(info.duration, 2)}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "model": MODEL_SIZE, "geladen": model is not None})
        self._json(404, {"error": "niet gevonden"})

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            return self._json(404, {"error": "niet gevonden"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "geen geldige JSON"})
        path = req.get("path") or ""
        if not path or not os.path.isfile(path):
            return self._json(400, {"error": f"bestand niet gevonden: {path}"})
        t = time.time()
        try:
            uit = transcribeer(path, req.get("language"))
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": f"transcriptie mislukt: {e}"})
        uit["seconden"] = round(time.time() - t, 2)
        print(f"[whisper] {os.path.basename(path)} taal={uit['language']} {uit['duration']}s audio in {uit['seconden']}s", flush=True)
        self._json(200, uit)

    def log_message(self, fmt, *args):  # stil, we loggen zelf
        pass


def main():
    laad_model()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[whisper] server op http://127.0.0.1:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
