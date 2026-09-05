# Sunshower — Spraakbericht

Feedbacklus van monteur naar werkboek. De monteur spreekt in bij welk apparaat hij
stond, wat de klant zei, wat hij zelf zag, wat de analyse en oplossing was, of de
echte oorzaak is vastgesteld en of het is opgelost. Het systeem transcribeert, zet
het in blokken, laat de supervisor controleren, stuurt het retour naar de monteur
ter bevestiging, en zet het daarna in de wachtkamer van de diagnose-app.

Vier talen (Nederlands, Duits, Belgisch Frans, Indonesisch) voor de monteur; alles wat bij de
supervisor en in de wachtkamer komt is altijd Nederlands. Een logboek waarin niets ooit wordt weggegooid,
elke memo herleidbaar tot de monteur, en een spel met punten voor afgeronde memo's.

## De lus

```
monteur spreekt in ──► API (Vercel, Redis) ──► Mac-consumer: Whisper + taalmodel
                                                          │
       monteur: klopt / klopt niet  ◄── retour ◄── supervisor (review.html)
                │ akkoord                                 │
                └──────────────────────────────► doorsturen ──► diagnose-app, boek "wachtkamer"
```

Taal: de monteur spreekt in en controleert in zijn eigen taal (`transcript`, `issuesVertaald`,
`opmerkingSupervisorVertaald`); de supervisor werkt in het Nederlands (`transcriptNl`, `issues`,
`opmerkingMonteurNl`). Wat de monteur in zijn taal wijzigt wordt door de API terugvertaald.

Statussen: `nieuw → wacht-supervisor → wacht-monteur → monteur-akkoord → in-wachtkamer`,
plus `fout-transcriptie`, `doorsturen-mislukt` en `ingetrokken` (met reden, blijft bewaard).

## Bestanden

```
schema.js         ← één bron: de issue-velden, statussen, talen en labels (nl/de/fr/id)
i18n.js           ← alle schermteksten per taal
index.html, app.js, style.css, sw.js, manifest.json   ← monteursapp (PWA)
review.html       ← supervisor: controleren, retour, doorsturen, intrekken, beheer
config.js         ← instellingen van de app (API_BASE leeg = zelfde host)
api/
  router.js       ← enige Vercel-functie; stuurt door naar _spraakbericht.js
  _spraakbericht.js ← alle routes (zie kop van het bestand)
  _memo.js        ← opslag als logboek (events + compare-and-set)
  _opslag.js      ← audio: Vercel Blob of aparte Redis-sleutel
  _monteur.js     ← monteurs: aangemaakt door de supervisor, activeren met pincode (4 cijfers), tokens
  _taaldienst.js  ← één deur naar het taalmodel (Nous): chat + vertalen, gedeeld met de Mac
  _diagnose.js    ← doorsturen naar de diagnose-app (KOPPELING.md), altijd Nederlands
  _push.js        ← web-push per monteur (meerdere toestellen)
tools/
  whisper-server.py   ← lokale spraakherkenning, model blijft geladen (poort 52370)
  woordenlijst.json   ← vaktermen als hint voor Whisper, per taal
  structureer.js      ← transcript → Nederlandse blokken + vertaling in de taal van de monteur
  mac-consumer.js     ← haalt nieuwe memo's op, transcribeert, structureert, schrijft terug
  dev.js              ← npm run dev: mock-diagnose + local-api + consumer, alles lokaal
  local-api.js        ← de app lokaal (statisch + API), ook gebruikt door de tests
  mock-diagnose.js    ← nabootsing van de diagnose-app voor tests
  migreer-namespace.js← eenmalig: oude memo's naar 'inbox' + logboek
  nl.sunshower.whisper-server.plist ← launchd-definitie van de Whisper-server
tests/
  consistentie.test.js ← schermen, teksten, schema en config kloppen onderling
  api.test.js          ← de hele lus door de API (lokale Redis db 15 + mock-diagnose)
  loop.test.js         ← de hele lus met échte spraak nl + de (Whisper + taalmodel; Redis db 13)
```

## Lokaal draaien

Vereist: Redis lokaal (`brew install redis`), ffmpeg, de Python-venv met faster-whisper
(pad in `tools/nl.sunshower.whisper-server.plist`), en `.env.local` met `ADMIN_TOKEN`
en `NOUS_API_KEY`.

```bash
npm test                                   # consistentie + API-lus (start zelf servers)
npm run test:loop                          # échte spraak, beide talen (roept het taalmodel aan)
TAALDIENST_MOCK=1 npm run test:loop        # zelfde, zonder taalmodel

# handmatig klikken — alles in één keer (mock-diagnose + app/API + consumer tegen de lokale API):
npm run dev
# → http://localhost:52350 (monteur) en http://localhost:52350/review.html (supervisor)
# Een memo die je hier inspreekt is binnen een halve minuut getranscribeerd (Whisper via launchd).
```

Het taalmodel dat de blokken maakt kies je in review.html → Beheer (lijst met prijzen van
Nous Research; de consumer haalt de keuze elke ronde op). Voor die lijst moet `NOUS_API_KEY`
ook op de server staan; zonder sleutel kun je de modelnaam handmatig invullen.

Monteurs maak je aan in review.html → Beheer (naam + taal). In de app kiest de monteur zijn
naam uit de lijst en kiest de eerste keer een pincode van vier cijfers (activeren); daarna
naam + pincode. Namen die al in gebruik zijn staan grijs in de lijst. In Beheer zie je wie
geactiveerd is en wijzig je naam, taal of reset je de pincode.

Een taal toevoegen: kolom in `schema.js`, blok in `i18n.js`, prompt in `tools/structureer.js`,
regel in `tools/woordenlijst.json`; `npm test` controleert dat alles compleet is.

## Op de Mac (productie)

- `nl.sunshower.whisper-server` (launchd): Whisper-server op 127.0.0.1:52370, model `small`.
- `nl.sunshower.spraakbericht-consumer` (launchd): pollt de Vercel-API elke 30 s.
- Logs: `whisper.log`, `consumer.log` en de `.error.log`-varianten in deze map.

## Omgevingsvariabelen (Vercel)

`REDIS_URL`, `ADMIN_TOKEN`, `DIAGNOSE_API_BASE`, `DIAGNOSE_ADMIN_TOKEN`, `DOELBOEK`
(default `wachtkamer`, nooit `sunshower`), `SPRAAKBERICHT_BASE`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, optioneel `BLOB_READ_WRITE_TOKEN` (audio naar
Vercel Blob in plaats van Redis) en `NOUS_API_KEY` (alleen voor de modellenlijst in Beheer).

## Huisstijl

Volgt de officiële Sunshower-huisstijl (`~/vault/sunshower-faulttree/huisstijl/`):
zwart stuurt, Ember `#d9491f` als enige accent (opname), canvas `#f4f4f2`, radius 6px,
font CircularXXWeb.

Plan en analyse: `ANALYSE-EN-PLAN-2026-09-05.md`. Contract met de diagnose-app: `KOPPELING.md`.
