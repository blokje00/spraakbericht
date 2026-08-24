# SPRAakbericht — Totale Routing

> Vastgelegd op 2026-08-24 na overleg over waar de gesproken monteur-tekst
> als faulttree terechtkomt en bewerkt wordt. Dit document legt het herziene
> plan vast met de inzichten van Patrick.

---

## 1. Het kerninzicht

Elke tekst van een Sunshower-monteur heeft als context **het hele bestaande
boek** (incl. het originele handboek.pdf). Wat de monteur ook zegt, er kan
bijna altijd iets van gemaakt worden dat past in:

```
Model → Symptoom → Analyse → Fix → Test
```

Die structuur **bestaat al** in de diagnose-app: de rail
`model → symptoom → analyse → oplossing → controle` zit in `kaart-rol.js`,
en het handboek-importpad zet `kclass` (`symptoom`/`test`/`oorzaak`/`fix`/
`toelichting`) — exact deze rollen.

**De tools (Treestudio: bekijken, bewerken, goedkeuren, publiceren) zijn al
ingebouwd.** Het probleem was nooit de tool; het was:
1. de tekst kwam binnen als **1 platte kaart** (geen vertakte faulttree);
2. hij landde in **boek `sunshower`** (dat 100% beschermd moet blijven).

---

## 2. Doel

De gesproken monteur-tekst moet:
- als een **echte vertakte faulttree** verschijnen (Model→Symptoom→Analyse→Fix→Test),
- **bewerkbaar** zijn in de bestaande Treestudio,
- **nooit** standaard in boek `sunshower` landen,
- het bestaande boek als **context** gebruiken voor de structurering.

---

## 3. Architectuur (herzien)

```
Monteur spreekt in (iPhone, 5G)
  → spraakbericht.vercel.app (PWA, audio opgeslagen)
  → Mac-consumer (launchd) transcribeert lokaal (whisper)
  → REVIEW (Patrick): edit transcript, keurt goed
  → [NIEUW] transcript → gestructureerde faulttree met BOEK-CONTEXT
        (Model → Symptoom → Analyse → Fix → Test)
  → import naar een APART boek (monteur-input), nooit sunshower
  → Treestudio ?boek=monteur-input: bekijken + bewerken + goedkeuren + publiceren
  → (later, na expliciet akkoord) koppelen aan het echte boek
```

---

## 4. De 3 delen

### Deel 1 — Transcript → gestructureerde faulttree (met boek-context)
**Nieuw.** Vóór de import wordt het transcript omgezet naar regels die de
bestaande `tekstNaarKaarten` / `_handboek.js`-heuristiek kan verwerken.

Cruciaal: de omzetting gebruikt het **bestaande boek als context** — het
taalmodel of de heuristiek matcht de monteur-tekst tegen bestaande
modellen/families/symptomen en structureert hem als
`Model → Symptoom → Analyse → Fix → Test`.

Hergebruikt: `kaart-rol.js` (fasen), `tekstNaarKaarten` (regels → kaarten),
`_handboek.js` (`kclass`).

**Waar:** op de Mac (in de consumer/review-flow). De Mac heeft het boek, de
handboek.pdf en whisper al lokaal — daar kan de contextrijke omzetting het
beste en goedkoopst. Geen Vercel-functie-limiet.

### Deel 2 — Bestemmingsboek (geen nieuwe routing-laag)
**Bestaand.** Monteur-bomen landen in een **apart boek** (bijv. `monteur-input`),
te openen via `treestudio?boek=monteur-input`.

- `sunshower` blijft beschermd: harde grens, nooit default doel.
- Het boek is een container, geen routing-systeem. Drafts zijn al de werkruimte.

### Deel 3 — Bewerken + later koppelen aan het echte boek
Bewerken is **bestaand** (Treestudio). Het koppelen aan het echte boek is
**nieuw** en gebeurt pas **na expliciet akkoord** van Patrick — nooit
automatisch.

---

## 5. Nieuw vs. bestaand

| Deel | Nieuw? | Hergebruikt |
|------|--------|-------------|
| Deel 1: transcript → faulttree met boek-context | **Nieuw** (AI/heuristiek matcht tegen boek) | `kaart-rol.js`, `tekstNaarKaarten`, `_handboek.js` |
| Deel 2: apart boek | Bestaand (boek aanmaken) | Treestudio `?boek=`, drafts |
| Deel 3: bewerken + later koppelen | Bewerken bestaand; koppelen nieuw | Treestudio |

---

## 6. Openstaande keuzes (blokkerend)

1. **Waar gebeurt Deel 1?**
   - A. Op de Mac (consumer/review) — aanbevolen, heeft boek + pdf + whisper lokaal.
   - B. Op Vercel (approve-flow) — server-side, langzamer, functie-aanroep.
   - → Aanbeveling: **A**.
2. **Boek-naam** voor de container: `monteur-input` of anders?
3. **Automatisch of handmatig structureren?**
   - Automatisch: AI matcht tegen boek, Patrick corrigeert in review.
   - Handmatig: Patrick ziet ruwe tekst + AI-voorstel, bevestigt structuur zelf.
   - → Aanbeveling: automatisch met correctie in review.

---

## 7. Verwijzingen

- Repo: `~/dev/spraakbericht` → GitHub `blokje00/spraakbericht`
- Diagnose-app: `~/vault/projects/sunshower-diagnose-pwa-v3`
- Bestaande modules: `app/kaart-rol.js`, `app/handlers/import.js` (`tekstNaarKaarten`),
  `app/api/_handboek.js`, `app/treestudio/`
- Live: spraakbericht.vercel.app (monteurs-app) · sunshower-diagnose.vercel.app (diagnose)
