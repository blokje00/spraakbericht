# PROGRAMMAPLAN — Sunshower Spraakbericht (audio-input van monteurs)

> **Definitieve versie** — herschreven op 2026-08-24 na de eerste bouw- en deploy-ronde.
> Dit document is het **enige** naslagwerk. De volgende keer moet de app hiermee in
> één keer perfect gebouwd én gedeployed worden. Elke fout uit ronde 1 staat erin als
> les, zodat hij niet herhaald wordt.

---

## 0. TL;DR (de 10 dingen die ronde 1 fout gingen)

1. **De app hoort in een EIGEN git-repo, NIET in de vault-repo en NIET in de diagnose-repo.**
2. **De vault-map (`~/vault`) is één grote git-repo** (`blokje00/vault.git`). Een app-map
   binnen `~/vault/` is dus géén zelfstandige repo — hij hoort bij de vault. De app moet
   in `~/dev/spraakbericht/` staan (buiten de vault).
3. **De diagnose-repo (`sunshower-diagnose-pwa-v3`) is live en waardevol. Nooit daarin
   bouwen — altijd een eigen repo.** Ronde 1 wijzigde router.js + voegde een handler toe,
   wat risico liep op overschrijven. Teruggedraaid.
4. **`vercel env pull` maskeert secrets met `"[SENSITIVE]"`** — je kunt een env-waarde dus
   NIET zo van het ene naar het andere project kopiëren. De placeholder breekt de app
   (`Invalid URL: "[SENSITIVE]"`).
5. **Vercel maakt van ELK bestand in `api/` automatisch een serverless function.** Een
   handler op `api/spraakbericht.js` wordt een losse route die de rewrite omzeilt. → De
   handler moet een **underscore-prefix** hebben (`api/_spraakbericht.js`), dan is alleen
   `api/router.js` de function.
6. **Vercel Hobby staat maxDuration 300s toe (Fluid Compute), niet 10s/60s.** Whisper past
   dus wél qua tijd, maar de 250MB-functielimiet is krap. Besloten: transcriptie blijft
   **lokaal op de Mac**, niet op Vercel.
7. **`tailscale serve` en `tailscale funnel` overschrijven elkaars paden** en kunnen de
   bestaande webui/fundament-routes breken. Niet meer gebruiken voor de 5G-oplossing; de
   frontend+API gaan op Vercel, de transcriptie op de Mac.
8. **De mock-backend (`tools/mock-server.js`) crasht met ENOENT als `uitzendingen/` wordt
   verwijderd terwijl hij draait** → `verzekerMap()` bij elke schrijf nodig. En `_`-bestanden
   (zoals `_leaderboard.json`) niet meetellen als submissie.
9. **`blobToBase64()` retourneert een Promise.** `audioBase64 = blobToBase64(blob)` zonder
   `await` zet een Promise-object in de payload → `JSON.stringify` maakt `{}` → de server
   geeft HTTP 400. **Altijd `await`**, en de functie moet `async` zijn.
10. **Publiek endpoint = throttling + sanitize + validId** (zoals `feedback.js`). Private
    routes (GET-lijst, transcript-schrijven) vereisen `Authorization: Bearer <ADMIN_TOKEN>`.

---

## 1. Doel

Monteurs kunnen vanuit de veld een **spraakmemo** insturen (of tekst typen) die:
- op een **publieke, 5G-bereikbare URL** terechtkomt (Vercel),
- de **originele audio altijd bewaart** (harde eis van Patrick),
- **lokaal op Patricks Mac** getranscribeerd wordt (whisper/faster-whisper, snel en gratis),
- het transcript + audio zichtbaar maakt voor de review,
- een **leaderboard** toont (meeste inzendingen per monteur, met een prijs).

**Niet in scope:** de diagnose-flow, review-uitwerking tot kaarten, publiceren, training.
Dat blijft in de bestaande diagnose-app. Deze app is puur de **ingang** (spraak → opslag →
transcript).

---

## 2. Architectuur (definitief)

```
┌──────────────────────┐   POST audio (5G)   ┌──────────────────────────┐
│  Monteur PWA (iPhone)│ ──────────────────► │  Vercel: spraakbericht    │
│  - spraakbericht.    │                     │  - / (frontend, statisch) │
│    vercel.app        │                     │  - /api/router.js (lambda)│
│  - + knop, MediaRec. │                     │  - Redis (audio base64 +  │
│  - leaderboard       │                     │    metadata + counts)     │
└──────────────────────┘                     └───────────┬──────────────┘
                                                        │ poll (GET nieuw)
                                        ┌───────────────▼──────────────┐
                                        │  Patricks Mac (consumer)      │
                                        │  - poll /api/spraakbericht    │
                                        │  - download audio (base64)    │
                                        │  - ffmpeg webm→wav            │
                                        │  - whisper_stt.py (lokaal)    │
                                        │  - POST transcript terug      │
                                        └──────────────────────────────┘
```

**Kernbeslissingen:**
- Frontend + API op Vercel (publiek, monteurs op 5G).
- Transcriptie LOKAAL op de Mac (whisper), nooit serverless.
- Audio als **base64 in Redis** (zelfde patroon als de diagnose-app; ~2MB audio is binnen de
  KV-grens). Geen aparte blob-store nodig.
- Eén Redis-instantie (zelfde REDIS_URL als diagnose-app), multi-tenant via `boekKey`.

---

## 3. Structuur van de repo (`~/dev/spraakbericht/`)

```
~/dev/spraakbericht/
├── index.html          ← PWA: + knop, opname, bevestig, verzonden, account, leaderboard
├── style.css           ← Sunshower huisstijl (tokens + lucide icon styling)
├── app.js              ← MediaRecorder + upload (async!) + leaderboard-fetch
├── config.js           ← ALLEEN hier de koppelingsvariabelen
├── manifest.json       ← PWA-installatie (iPhone homescreen)
├── sw.js               ← offline shell
├── icon.svg            ← app-icoon (Ember +, huisstijl)
├── review.html         ← toont binnenkomende memo's + audio + transcript (voor Patrick)
├── package.json        ← scripts: test / dev / mock / consumer
├── vercel.json         ← outputDirectory ".", rewrite /api/(.*)→/api/router
├── api/
│   ├── router.js       ← enige serverless function (dispatched naar _spraakbericht)
│   ├── _spraakbericht.js ← ALLE logica (underscore = geen eigen route!)
│   ├── _redis.js       ← REDIS_URL laag + boekKey
│   └── _sanitize.js    ← sanitizeTekst + validId
├── tools/
│   ├── dev-server.js   ← statische server (lokaal testen)
│   ├── mock-server.js  ← lokale test-backend (met transcriptie) — NIET voor productie
│   └── mac-consumer.js ← pollt Vercel, transcribeert lokaal, schrijft terug
├── tests/              ← consistentie + koppeling + transcriptie
└── .gitignore          ← node_modules/, uitzendingen/, .DS_Store
```

---

## 4. API-contract (de handler `api/_spraakbericht.js`)

| Route | Methode | Auth | Doel |
|-------|---------|------|------|
| `/api/spraakbericht` | POST | anoniem (throttle) | monteur stuurt memo `{monteur, audio(base64), audioType, tekst}` |
| `/api/spraakbericht` | GET | Bearer ADMIN_TOKEN | lijst memo's (voor Mac-consumer + review) |
| `/api/spraakbericht?status=nieuw` | GET | Bearer | alleen onverwerkte memo's |
| `/api/spraakbericht/:id` | GET | Bearer | één memo incl. audio (voor consumer) |
| `/api/spraakbericht/:id/transcript` | POST | Bearer | Mac schrijft `{transcript, status}` terug |
| `/api/spraakbericht/leaderboard` | GET | publiek | telling per monteur (gesorteerd) |

**Memon-record (Redis `spraakbericht:<id>`):**
```json
{ "id", "monteur", "tekst", "audioType", "audio" (base64), "ts", "status": "nieuw|verwerkt", "transcript": null }
```
- `spraakbericht:index` = SET van id's
- `spraakbericht:counts` = HASH monteur→aantal (leaderboard)

**Beveiliging:**
- POST anoniem: IP-throttle (30/min), `validId`, `sanitizeTekst`, audio ≥ 50 chars en ≤ 8MB base64.
- Private routes: `safeEqual(token, ADMIN_TOKEN)` via Bearer-header.
- `GEEN_BEVEILIGING=1` schakelt auth uit (alleen voor lokale test).

---

## 5. Bouwvolgorde (in één keer goed)

### Fase A — Basis frontend (PWA)
1. `config.js` met ALLE koppelingsvariabelen: `API_BASE`, `API_ROUTE` (`/api/spraakbericht`),
   `LEADERBOARD_ROUTE` (`/api/spraakbericht/leaderboard`), `BOEK_SLUG`, `AUTH_TOKEN`,
   `MONTEUR_NAAM`, `APP_V`, `AUDIO_MIME`, `MAX_SECONDS`.
2. `index.html` + `style.css` + `app.js` + `manifest.json` + `sw.js` + `icon.svg`.
3. **UI-elementen die app.js gebruikt MOETEN in index.html staan** (test checkt dit).
4. **Lucide icons** via CDN (`https://unpkg.com/lucide@latest`), `lucide.createIcons()` in app.js.
5. **Huisstijl:** zwart `#000000` stuurt, Ember `#d9491f` enige accent (opname), Sage `#758a85`
   bevestiging, canvas `#f4f4f2`, radius 6px, font CircularXXWeb (Book/Bold).
6. Tekst: "Patrick zal je bericht zo snel mogelijk toevoegen!" (idle-sub).

### Fase B — Audio-logica (app.js) — DEEL met de meeste fouten
1. `startOpname()`: `getUserMedia({audio:true})` → `MediaRecorder` (Opus webm als ondersteund).
2. `stopOpname()`: stop + `Blob`.
3. `blobToBase64(blob)`: **retourneert een Promise** via FileReader.
4. `verstuur()`: **MOET `async function` zijn** en `audioBase64 = await blobToBase64(blob)`.
   ZONDER await → Promise-object in payload → HTTP 400. **Dit was fout #9.**
5. Payload: `{boek, monteur, audio, audioType, tekst, ts}`. Headers: `Content-Type`, evt. Bearer.
6. Foutafhandeling: bij file-read fout de busy-state resetten (knop herstellen).

### Fase C — API (Vercel) — DEEL met de deploy-fouten
1. `api/_redis.js`: `REDIS_URL`, `configured()`, `cmd()`, `boekKey()`.
2. `api/_sanitize.js`: `sanitizeTekst`, `validId`.
3. `api/_spraakbericht.js`: alle routes (zie §4). **Underscore-prefix verplicht** (fout #5).
4. `api/router.js`: dispatch naar `_spraakbericht` (enige lambda).
5. `vercel.json`: `outputDirectory "."`, rewrite `/api/(.*)→/api/router?route=$1`,
   `functions: {"api/router.js": {"maxDuration": 60}}`.
6. `package.json`: dependency `redis`.

### Fase D — Mac-consumer (lokale transcriptie)
1. `tools/mac-consumer.js`: pollt `GET /api/spraakbericht?status=nieuw` met Bearer,
   downloadt `GET /:id` (audio base64 → webm), ffmpeg → wav, `whisper_stt.py` → transcript,
   `POST /:id/transcript` terug. `--watch` = elke 30s pollen.
2. `whisper_stt.py`: faster-whisper **base**, `language=None` (auto NL/EN/DE), `vad_filter`.
   **NOOIT `language="nl"` forceren.**

### Fase E — Tests
1. `tests/consistentie.test.js`: element-IDs, config-contract, `await blobToBase64`, geen
   hardcoded URL, manifest/sw geldig, huisstijl-tokens.
2. `tests/koppeling.test.js`: config parset, app.js koppelt via config, POST naar mock.
3. `tests/transcriptie.test.js`: echte WAV→webm→upload→transcript (via `say`+ffmpeg).
   **Slaat over** als `say`/`ffmpeg`/python/whisper_stt.py ontbreken.

---

## 6. Deploy naar Vercel (in één keer goed)

### Stap 0 — Vóór het deployen
- Repo staat in `~/dev/spraakbericht/` (buiten vault).
- Repo is gepusht naar `https://github.com/blokje00/spraakbericht` (PRIVATE).
- Vercel CLI ingelogd als `blokje00`.

### Stap 1 — Project aanmaken (éénmalig)
```bash
cd ~/dev/spraakbericht
vercel link --yes --project spraakbericht
```
> De GitHub-koppeling kan falen bij een private repo (Vercel heeft dan geen toegang).
> Maak de repo public óf deploy zonder Git-integratie via `vercel --prod` (CLI-upload).

### Stap 2 — Environment variabelen (KRITIEK — fout #4)
> ⚠️ **`vercel env pull` maskeert secrets met `"[SENSITIVE]"`.** Je kunt een waarde dus
> NIET van het ene project naar het andere kopiëren via pull. De placeholder breekt de
> app (`Invalid URL`).
- De **echte** REDIS_URL staat in `~/vault/projects/sunshower-diagnose-pwa-v3/.env.local`.
- Zet env handmatig op het spraakbericht-project:
  ```bash
  # uit .env.local van de diagnose-app de echte waarde halen
  echo "$REDIS_URL" | vercel env add REDIS_URL production --project spraakbericht
  echo "$ADMIN_TOKEN" | vercel env add ADMIN_TOKEN production --project spraakbericht
  # (eventueel ook voor preview)
  ```
- **Verifieer** dat de waarde niet `[SENSITIVE]` is vóór deploy (anders `Invalid URL`).

### Stap 3 — Deploy
```bash
cd ~/dev/spraakbericht
vercel --prod --yes
```
- Deploy **vanuit de repo-root** (`~/dev/spraakbericht`), NIET vanuit `app/`.
- Verwachte URL: `https://spraakbericht.vercel.app`.

### Stap 4 — Verifiëren (na deploy)
```bash
URL=https://spraakbericht.vercel.app
curl -s $URL/                                    # frontend → 200
curl -s $URL/api/spraakbericht/leaderboard       # publiek → 200 {"leaderboard":[...]}
curl -s -o /dev/null -w "%{http_code}" $URL/api/spraakbericht  # zonder token → 401
curl -s -X POST $URL/api/spraakbericht -H "Content-Type: application/json" \
     -d '{"monteur":"test","audio":"AAAA...","audioType":"audio/webm","tekst":"","ts":1}'
# met echte audio → 200 {ok,id}
```

### Veelgemaakte deploy-fouten (checklist)
- [ ] Handler heet `_spraakbericht.js` (underscore), anders wordt hij een losse route.
- [ ] REDIS_URL is de echte waarde, niet `[SENSITIVE]`.
- [ ] Deploy vanuit repo-root, niet `app/`.
- [ ] `vercel.json` heeft `outputDirectory: "."`.
- [ ] Frontend-config `API_BASE` → `https://spraakbericht.vercel.app`.

---

## 7. Leaderboard (inzendingen per monteur + prijs)

- Per POST: `HINCRBY spraakbericht:counts <monteur> 1`.
- `GET /api/spraakbericht/leaderboard`: HGETALL → sorteer desc → `{leaderboard:[{monteur,aantal}]}`.
- Frontend: `🏆`-knop (lucide `trophy`) → `laadLeaderboard()` → fetch → render rijen.
  - Winnaar (top) = Sage-kleur, eigen rij = Ember-outline.
  - `HGETALL` kan array of object teruggeven — **beide afhandelen** (fout in ronde 1: aanname array).
- Tekst: "Meeste inzendingen deze periode. De winnaar wint een prijs."

---

## 8. Review (voor Patrick)

- `review.html`: toont memo's uit `GET /api/spraakbericht` (met Bearer), per memo:
  monteur, datum, `<audio controls>` (origineel!), transcript, eventuele tekst.
- **De originele audio is altijd de bron van waarheid.** Transcript is een hulpmiddel.

---

## 9. Les: de mock is NIET voor productie

`tools/mock-server.js` is alleen voor lokale ontwikkeling (geen echte Vercel/Redis).
- Schrijft naar `uitzendingen/` (JSON + .webm + .transcript.txt).
- Heeft `verzekerMap()` nodig (fout #8: ENOENT als map weg is tijdens draaien).
- Filtert `_`-bestanden (`_leaderboard.json`) uit de submissie-lijst.
- Productie gebruikt `api/_spraakbericht.js` + Redis, NIET de mock.

---

## 10. Foutregister (wat er misging in ronde 1 — niet herhalen)

| # | Fout | Symptoom | Fix |
|---|------|----------|-----|
| 1 | App in vault-map gebouwd | geen eigen repo | verplaats naar `~/dev/spraakbericht/` |
| 2 | Wijzigingen in diagnose-repo | risico overschrijven live app | eigen repo; diagnose-repo terugdraaien |
| 3 | Deploy vanuit verkeerde root | 443MB upload / root-fout | deploy vanuit repo-root |
| 4 | Env gekopieerd via `pull` | REDIS_URL=`[SENSITIVE]`, Invalid URL | echte waarde uit `.env.local` |
| 5 | Handler als losse function | rewrite omzeild, HTML i.p.v. JSON | underscore-prefix `_spraakbericht.js` |
| 6 | Tailscale serve/funnel gemengd | webui/fundament-routes gebroken | niet gebruiken; Vercel voor 5G |
| 7 | Aanname HGETALL = array | leaderboard 500 | array én object afhandelen |
| 8 | Mock crasht bij ontbrekende map | ENOENT | `verzekerMap()` |
| 9 | `blobToBase64` zonder await | Promise→{} → HTTP 400 | `async` + `await` |
| 10 | Emoji i.p.v. icons | niet huisstijl | lucide CDN + `createIcons()` |

---

## 11. Nog openstaand (na dit plan)

- [ ] REDIS_URL echt doorzetten naar spraakbericht-project (fout #4 fixen — huidige status).
- [ ] Frontend-config `API_BASE` → `spraakbericht.vercel.app` (al gedaan in repo).
- [ ] Volledige end-to-end test: monteur POST → consumer transcribeert → review toont audio+transcript.
- [ ] GitHub-koppeling Vercel (optioneel; CLI-upload werkt ook).
