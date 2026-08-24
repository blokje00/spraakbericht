# KOPPELING — Contract tussen monteursapp en bestaande Sunshower-app

Dit document is het **contract**. De monteursapp stuurt een submissie; de bestaande
Sunshower-app moet die kunnen ontvangen. Alles staat op één plek in `config.js`.

## 1. Request

**Endpoint:** `POST {API_BASE}{API_ROUTE}`
(vb. `POST https://sunshower-diagnose.vercel.app/api/monteuridee`)

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <AUTH_TOKEN>
```

**Body (JSON):**
```json
{
  "boek": "sunshower",
  "monteur": "Jan de Vries",
  "audio": "<base64 van het .webm bestand>",
  "audioType": "audio/webm;codecs=opus",
  "tekst": "optionele tekst-aanvulling",
  "ts": 1724500000000
}
```

| Veld | Type | Verplicht | Omschrijving |
|------|------|-----------|--------------|
| `boek` | string | ja | Boek-slug (multi-tenant `boekKey`) |
| `monteur` | string | ja | Naam van de meldende monteur |
| `audio` | string (base64) | ja | **De originele audio** — altijd meesturen |
| `audioType` | string | ja | MIME-type van de opname (voor afspelen/transcriptie) |
| `tekst` | string | nee | Korte aanvulling van de monteur |
| `ts` | number | ja | Unix-timestamp van opname |

> **Harde eis:** de originele audio (`audio`) wordt altijd meegestuurd. De monteur
> die de review doet, moet de oorspronkelijke opname kunnen beluisteren — transcriptie
> is een hulpmiddel, nooit vervanging.

## 2. Response

**Succes (200):**
```json
{ "ok": true, "id": "monteuridee_1724500000000" }
```

**Fouten:**
| Status | Betekenis |
|--------|-----------|
| 400 | Ongeldige body / ontbrekend veld |
| 401 | Ontbrekend of fout token |
| 503 | Database niet geconfigureerd |

## 3. Wat de bestaande app moet doen (later te bouwen)

1. Handler `app/handlers/monteuridee.js` — `POST` validatie + opslaan.
2. Regel in de `HANDLERS`-tabel van `app/api/router.js` voor `/api/monteuridee`.
3. Opslaan als `monteuridee:<id>` (Redis) met status `nieuw`, herkomst "monteur",
   auteur (monteur), originele audio (blob-opslag), tekst, ts.
4. De originele audio in blob-opslag (Vercel Blob / S3), niet in Redis.
5. De submissie verschijnt in de admin review-queue als een `draft`.

## 4. Transcriptie (best-effort, lokaal en snel)

De app stuurt **alleen de originele audio**. Transcriptie gebeurt aan de **review-kant** —
niet in de monteursapp, niet in de cloud. We hergebruiken de bestaande, bewezen snelle
STT op Patricks Mac: `~/dev/dictation-app/whisper_stt.py` (faster-whisper base,
`language=None` → auto NL/EN/DE, `vad_filter` negeert stiltes). Hij is vandaag
geverifieerd werkend (faster-whisper 1.2.1).

**Aanroep:**
```bash
<hermes-venv>/bin/python3.11 ~/dev/dictation-app/whisper_stt.py <audio.wav>
# → print transcript naar stdout
```

**Flow bij review:**
1. Monteursapp stuurt `.webm` (originele audio) naar de mock/backend.
2. De backend converteert `.webm` → `16 kHz mono .wav` (ffmpeg is aanwezig op de Mac).
3. `whisper_stt.py` transcribeert lokaal → transcript.
4. Transcript komt naast de originele audio te staan in de submissie.

> **Harde eis blijft:** het transcript is een hulpmiddel. De originele audio blijft de
> bron van waarheid en wordt bij de review altijd bewaard + beluisterbaar.

**Waarom lokaal (niet cloud):** Patricks vaststelling — de lokale Parakeet/whisper
vertaalt extreem snel en kwalitatief goed. Geen cloudkosten, geen privacy-lek van
klantlocaties, geen Vercel-functie-limiet. En de transcriptie loopt óók lokaal op de
review-machine, niet op de serverless Vercel-backend.

**In de mock (bewezen werkend):** `tools/mock-server.js` roept `whisper_stt.py` aan op de
ontvangen `.webm` (via ffmpeg → 16 kHz mono WAV) en slaat `transcript.txt` +
`audio.webm` naast elkaar op in `uitzendingen/`. Bewezen werkend met een echte opname
(Nederlands, Xander): submissie → HTTP 200 → transcript opgeslagen → audio bewaard.
Zie `tests/transcriptie.test.js`.

**Gebruikt model:** faster-whisper `base`, `language=None` (auto-detect NL/EN/DE),
`vad_filter=True`. Zoals vastgesteld in AGENTS.md §5 en `whisper_stt.py`: nooit
`language="nl"` forceren (garbage op Engels), `base` snel genoeg voor batches.

## 5. Testen zonder echte backend

`node tools/mock-server.js` draait het contract lokaal op :52344. Zet in `config.js`:
`API_BASE = "http://localhost:52344"` en je kunt de volledige flow testen. De mock
slaat elke submissie op in `uitzendingen/` inclusief de audio als `.webm`.
