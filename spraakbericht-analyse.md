# spraakbericht-analyse — doorstuur naar de diagnose-app

> Analyse van het spraakbericht → wachtkamer → diagnose-app stuk, opgesteld
> 2026-08-25 (Patrick: "spraakbericht-teksten komen altijd binnen op het
> standaard boek wachtkamer, maar dat loopt nog niet simpel — vooral omgezette
> berichten bekijken geeft problemen en de logica is nog niet goed").

## 1. De flow zoals die nu werkt (bewezen)

```
Monteur (iPhone, spraakbericht-PWA)
  → POST spraakbericht.vercel.app/api/spraakbericht  (audio base64, anoniem)
  → eigen Redis van de spraakbericht-app:  boekKey("sunshower", "spraakbericht:<id>")
  → Mac-consumer (launchd) pollt → whisper transcribeert → taalmodel structureert
       (Model → Symptoom → Analyse → Fix → Controle)
  → Patrick keurt goed in review.html
  → POST /api/import op de diagnose-app:  soort:"tekst", boek:"wachtkamer",
       inhoud: structuur-of-transcript, naam:"spraakbericht-<id>"
  → diagnose-app verwerkTekstImport:
       · tekstNaarKaarten → 5 info-kaarten (één per regel, geen vertakking)
       · archiveer → 2 bronnen: origineel + .dot
       · draft: txt_spraakbericht_memo_<timestamp>
  → Patrick bekijkt: nieuw-boek?boek=wachtkamer → bronnen-tabel → "Openen"
       → 401 "unauthorized — login required"   ← DE BUG
```

## 2. Visuele flow (zoals een user die ervaart)

- **Monteur** spreekt in → bevestiging "verzonden".
- **Patrick (review.html, spraakbericht-app):** ziet memo's met transcript + AI-structuur,
  bewerkt, klikt "Goedkeuren & doorsturen".
- **Patrick (diagnose-app):** Treestudio → boekenkast → "wachtkamer (concept)".
  Of `nieuw-boek?boek=wachtkamer` → sectie 2 Inhoud → bronnen-tabel. Ziet daar
  rijen met onleesbare namen (`spraakbericht-memo_1787631577239_sbyvl.d` /
  `...v2`), type "Bron", status "Opgeslagen". Klikt "Openen" →
  nieuw tabblad met **401 "unauthorized — login required"**.
- Treestudio `?boek=wachtkamer`: "Nakijken 0 / Publiceren 0" — niets te bewerken.

## 3. Problemen (geprioriteerd)

- **P1 — "Openen" geeft 401 (hoofdklacht).** `ui.js:344` → `window.open(item.downloadUrl)`
  met `downloadUrl = /api/bronnen?id=...` ZONDER `&public=1`. `window.open` kan geen
  Authorization-header meesturen; `bronnen.js:102` eist `admin` voor GET-zonder-public → 401.
  De kaft doet het wél goed (regel 107 voegt `&public=1` toe), foutboom/document niet.
- **P2 — oude bronnen type:"undefined".** De fix (type:"foutboom" in `archiveer`) geldt
  alleen voor nieuwe imports; bestaande bronnen blijven undefined → 403 "niet openbaar".
- **P3 — 1 spraakbericht = 3 dingen.** draft-faulttree + 2 bronnen (origineel + .dot),
  technische namen, document-versiesysteem (v2/vervangen) kleeft eraan.
- **P4 — alles hardcoded naar wachtkamer, geen routing.** DOELBOEK default "wachtkamer";
  geen per-melding boek-keuze. wachtkamer is een "concept"-boek (niet actief).
- **P5 — naam-collision "sunshower".** `_spraakbericht.js:79` gebruikt
  `req.query.boek || "sunshower"` als eigen Redis-naamruimte (apart Redis, zelfde naam).
- **P6 — documentatie achter.** `KOPPELING.md` beschrijft `/api/monteuridee`; realiteit is
  `/api/import`.
- **P7 — overlapReport berekend maar nooit gebruikt** (`import.js:297-306`).
- **P8 — meerdere symptomen niet expliciet gesplitst.**

## 4. Verbeterplan (uitvoervolgorde)

1. **"Openen" repareren** (P1+P2): open-actie type-bewust; foutboom/dot/handboek →
   Treestudio op de boom; document/kaft → `&public=1`. Backfill type:undefined → foutboom.
2. **Herkenbaar** (P3): leesbare naam (monteur + eerste symptoom) i.p.v. spraakbericht-memo_<ts>.
3. **Routing** (P4+P5): boek-keuze per melding in review; hernoem eigen boek-naamruimte.
4. **Overlap + meerdere symptomen** (P7+P8): overlapReport tonen in review; split-logica.
5. **Documentatie** (P6): KOPPELING.md vervangen door het werkelijke contract.

Beslissing Patrick (2026-08-25): "Openen" opent de boom in **Treestudio** (bewerken);
hele plan 1 t/m 5; werk uitbesteed aan subagents (deepseek-v4-flash-0731).

## 5. Betrokken bestanden

**Diagnose-app** (`~/vault/projects/sunshower-diagnose-pwa-v3/`):
- `app/nieuw-boek/ui.js` — `inzActie` (regel 286-346), `downloadUrl` (108), `kaftUrl` (107)
- `app/bronnen-tabel.js` — acties per type (`actiesVoor` 112-125), `herleidDetailRow` (251)
- `app/handlers/import.js` — `verwerkTekstImport` (248), `archiveer` (340)
- `app/handlers/bronnen.js` — public=1 leesvariant (100-208)

**Spraakbericht-app** (`~/dev/spraakbericht/`):
- `api/_spraakbericht.js` — approve (85-147), eigen boek-naamruimte (79)
- `review.html` — goedkeur + doorstuur
- `tools/mac-consumer.js`, `tools/structuur-faulttree.js`

## 6. Harde grens

**Boek `sunshower` is 100% onaantastbaar.** Spraakbericht-teksten mogen nooit in
`sunshower` landen. Alle wijzigingen beperken zich tot het `wachtkamer`-boek / de
spraakbericht-koppeling.
