# PLAN — Aparte monteursapp voor audio-input
> Locatie: `/Users/pjpjvanzandvoort/vault/projects/Sunshower audio input/`
> Datum: 2026-08-24 · Status: **v1 — bouwen**

## 1. Waarom dit los staat

De bestaande Sunshower-diagnose-app (PWA, Vercel) is gericht op de *monteur die een
diagnose doorloopt*. Daar een volledige audio-capture-flow inbouwen vertraagt die app
en mengt twee doelen. Daarom bouwen we een **apart, dunne monteursapp** die maar één
ding doet: audio (en optioneel een korte tekst/foto) opnemen en versturen naar de
bestaande Sunshower-backend. De **koppeling** is bewust als eenvoudige, configureerbare
variabelen opgezet zodat de app later zonder codewijziging aan de bestaande app hangt.

## 1b. Huisstijl (Sunshower — verplicht)

De app volgt de officiële Sunshower-huisstijl (bron:
`~/vault/sunshower-faulttree/huisstijl/Sunshower-huisstijl.md` en
`~/vault/projects/sunshower-diagnose-pwa-v3/HUISSTIJL.md`). Kern:

| Token | Waarde | Gebruik |
|-------|--------|---------|
| Ink / Charcoal | `#000000` / `#2c2c2c` | Primaire tekst, "zwart stuurt" |
| Ember | `#d9491f` | **Enige** accentkleur — de + knop / opname |
| Canvas | `#f4f4f2` | Zachte achtergrond |
| Surface | `#ffffff` | Kaartvlakken |
| Hairline | `#e0e0e0` | Scheidingslijnen |
| Stone | `#878787` | Meta-tekst, secundair |
| Sage | `#758a85` | Bevestiging / "klaar" (rust, geen foutgroen) |
| Fill-tertiary | `#eaeae8` | Invoervelden / secondaire vlakken |

Regels:
- **Één accent per view:** zwart stuurt, Ember alléén voor de opname-actie
  (escalatie/actie). Geen tweede accentkleur.
- **Font:** CircularXXWeb (Book voor tekst, Bold voor koppen/actie). Fallback
  naar systeemfont.
- Radius `6px` op kaarten (merkradius), hairline-randen `1px`.
- Tekst **links** uitgelijnd, editorial.
- Sage (`#758a85`) = "hier ben je klaar" (bevestiging), géén generiek groen.

## 2. Doel (scope v1)

1. Monteur opent de PWA op zijn iPhone (homescreen), tikt een **+ knop**.
2. Spreekt in wat hij tegenkomt (symptomen, wat hij al deed, wat nog fout gaat).
3. Optioneel: typt een korte aanvulling en/of maakt een foto.
4. Druk op versturen → audio + metadata gaan naar de **bestaande Sunshower-backend**.
5. De monteur ziet een bevestiging en de status van zijn inzending.

Wat deze app **niet** doet (bewust, later in de bestaande app):
- De review-queue, het uitwerken tot kaarten, AI-drafting, publiceren, training.
  Dat blijft in de bestaande app. Deze app is alleen de **ingang**.

## 3. Architectuur

```
┌─────────────────────────┐     HTTPS/JSON + audio      ┌────────────────────────────┐
│  Monteursapp (PWA)      │  ─────────────────────────► │  Bestaande Sunshower-app    │
│  - statisch, geen build │                             │  - Vercel /api/*            │
│  - + knop, MediaRecorder│                             │  - ontvangt submissie       │
│  - config.js (koppeling)│                             │  - review-queue             │
└─────────────────────────┘                             └────────────────────────────┘
```

De monteursapp is **statisch** (HTML/JS/CSS + service worker). Geen eigen backend,
geen eigen database, geen eigen hosting-kosten. Alles wat hij nodig heeft om te koppelen
zit in één bestand: `config.js`.

## 4. Koppelingsvariabelen (het contract met de bestaande app)

Deze variabelen zijn wat de bestaande Sunshower-backend nodig heeft om de inzending te
kunnen ontvangen en routeren. Ze staan op één plek in `config.js`:

| Variabele | Voorbeeld | Waarvoor |
|-----------|-----------|----------|
| `API_BASE` | `https://sunshower-diagnose.vercel.app` | Basis-URL van de bestaande app |
| `API_ROUTE` | `/api/monteuridee` | Endpoint dat de inzending ontvangt |
| `BOEK_SLUG` | `sunshower` | Welk boek/klant (multi-tenant `boekKey`) |
| `AUTH_TOKEN` | `<ADMIN_TOKEN>` | Bearer-token; de bestaande app gebruikt `Authorization: Bearer <token>` |
| `MONTEUR_NAAM` | `Jan de Vries` | Wie stuurt (attributie) |
| `APP_V` | `1` | Cache-busting / versie |

> **Koppelingscontract — wat de bestaande app moet kunnen** (wordt later daar gebouwd):
> `POST {API_BASE}{API_ROUTE}` met `Authorization: Bearer <AUTH_TOKEN>`, JSON-body:
> ```json
> {
>   "boek": "<BOEK_SLUG>",
>   "monteur": "<MONTEUR_NAAM>",
>   "audio": "<base64 of upload-URL>",
>   "tekst": "optionele aanvulling",
>   "foto": "optioneel base64",
>   "ts": 1234567890
> }
> ```
> De bestaande app slaat dit op als `monteuridee:<id>` (draft → review-queue) en bewaart
> de originele audio. Zie `KOPPELING.md` voor het volledige contract.

## 5. Gedetailleerd actieplan (bouwvolgorde)

| # | Stap | Bestand | Klaar als |
|---|------|---------|-----------|
| 1 | Map + structuur | `tools/`, `tests/` | map bestaat |
| 2 | Plan + contract | `PLAN.md`, `KOPPELING.md` | geschreven |
| 3 | Koppelingsconfig | `config.js` | variabelen staan op één plek |
| 4 | PWA-scherm | `index.html`, `style.css`, `manifest.json`, `sw.js` | laadt, installable, offline-shell |
| 5 | Audio-logica + upload | `app.js` | MediaRecorder + POST naar config |
| 6 | Mock-backend | `tools/mock-server.js` | ontvangt + toont submissie (test zonder echte backend) |
| 7 | Dev-server | `tools/dev-server.js` | app lokaal draaien |
| 8 | Test | `tests/` | config + audio-upload getest |
| 9 | Documentatie | `README.md` | hoe te draaien, koppelen, deployen |

## 6. Acceptatiecriteria

- [ ] `+` knop start audio-opname (iPhone + desktop, `MediaRecorder`).
- [ ] Opname is te stoppen, te beluisteren, opnieuw te doen.
- [ ] Versturen POST't naar `config.js` (API_BASE + API_ROUTE) met de juiste headers.
- [ ] Originele audio wordt meegezonden (jouw harde eis: bij review de audio beluisteren).
- [ ] Statusmelding aan de monteur (verstuurd / fout).
- [ ] Koppelingsvariabelen staan allemaal in `config.js` (geen hardcoded URLs in app.js).
- [ ] Werkt als PWA op iPhone homescreen (manifest + sw).

## 7. Openstaande keuzes (nog niet blokkerend voor v1)

- **Audio transport**: base64 in JSON (simplistisch, werkt, groter) vs. `multipart/form-data`
  (netter voor bestanden) vs. aparte upload-stap naar blob-store. v1 kiest base64 voor
  eenvoud en één-request; veranderen is een config + kleine client-wijziging.
- **Transcriptie**: deze app stuurt alleen de **originele audio**. Transcriptie (Whisper)
  en AI-uitwerking gebeuren aan de **backend-kant** (bestaande app, `_taaldienst.js`), niet
  hier. Dat houdt deze app dun en de audio-verwerking op één plek.
- **Monteur-identiteit**: v1 = handmatig ingevulde naam (opgeslagen in localStorage).
  Later koppelbaar aan de Microsoft-OAuth van de bestaande app.
