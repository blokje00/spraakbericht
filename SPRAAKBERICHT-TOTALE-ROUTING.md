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

---

## 8. Nieuwe ideeën (2026-08-24, Patrick)

Twee uitbreidingen op hetzelfde routing-concept.

### Idee A — Klant-app: eigen symptoom filmen → analyse

Een **afgeleide app** wordt aan klanten (eindgebruikers) uitgegeven waarmee ze hun
eigen symptoom **filmen** (video, niet alleen audio). Die video komt binnen en wordt
**daadwerkelijk geanalyseerd op wat er mis is** — de klant krijgt dus niet zomaar een
melding, maar een echte (voorlopige) diagnose-analyse.

**Implicaties:**
- Dit is een **ander publiek** dan de monteurs: klanten i.p.v. interne monteurs.
- Het is **video** (visueel symptoom) i.p.v. audio — vraagt beeldanalyse.
- De analyse "wat er mis is" vereist een **redeneermodel** over het product/domein.
- **Trainingsdata:** Patrick merkt terecht op dat we daar waarschijnlijk heel veel
  trainingsdata voor nodig hebben. De monteurs-app (spraakbericht) is zelf een
  **data-bron**: elke goedgekeurde monteur-memo (symptoom → diagnose → fix) is een
  gelabeld trainingsvoorbeeld. Dat is een mooie synergie: de monteurs-app voedt de
  dataset, de klant-app consumeert het.

**De klant-app → monteur-koppeling (URL voor in Synergie):**
De klant-app genereert per melding een **URL** die de monteur-tool (spraakbericht /
Synergie) binnenkomt. Met die URL kan de monteur de klant-melding **van tevoren** al:
- **zien** (de film/video van het symptoom),
- **beluisteren** (de gesproken toelichting van de klant),
- en **evt. analyseren** (de voorlopige diagnose + context).

Zo krijgt de monteur vóór vertrek naar de klant al beeld van wat er speelt, i.p.v. dat
hij ter plaatse voor verrassingen staat.

```
Klant filmt symptoom (klant-app)
  → video + toelichting binnen, analyse "wat is er mis"
  → klant-app genereert een URL voor deze melding
  → URL komt binnen in de monteur-tool (spraakbericht/Synergie)
  → monteur ziet/beluistert/analyseert de melding VOORAF
  → monteur gaat voorbereid naar de klant
```

**Synergie met monteurs-app:** dezelfde pipeline (audio/video → transcript → analyse →
Model/Symptoom/Analyse/Fix/Controle) dient zowel klant als monteur; de klant-app levert
de input, de monteur verifieert/repareert.

### Idee A2 — Bestaande databerg als trainingsdata (cruciaal asset)

Patrick heeft een **enorme berg bestaande data** die als trainingsdata kan dienen om
aan de hand van het klant-filmpje te voorspellen wat er fout is:

1. **Klant foutmeldingen** — hoe de klant het probleem omschrijft (tekst/audio).
2. **Wat de monteur heeft gezien** — de observatie van de monteur ter plaatse
   (waarschijnlijk ook de spraakbericht-meldingen).
3. **Afleverbonnen met de reparatie** — wat er daadwerkelijk is gedaan om het te
   verhelpen.
4. **Gebruikte onderdelen** — welke onderdelen zijn vervangen (gelabeld eindresultaat).

Dit is een **gelabelde dataset**: symptoom/observatie → reparatie → onderdelen. Dat is
precies de grondstof voor een model dat:
- van een klant-filmpje (symptoom) voorspelt **wat er fout is**,
- en mogelijk zelfs **welk onderdeel / welke fix** nodig is.

**Waarom dit sterk is:**
- Het is **bestaande, echte, gelabelde data** — geen synthetische data.
- De afleverbon + onderdelen = het **grond-ware eindlabel** ("dit was de reparatie").
- Combineerbaar met de geverifieerde monteur-meldingen uit de spraakbericht-flow
  (Idee B) voor een steeds beter datavliegwiel.

**Nog te onderzoeken (niet geblokkeerd):**
- Waar staat deze data nu (afleverbonnen-systeem, CRM, Excel, de diagnose-app)?
- Hoe is de structuur / zijn de velden (klantmelding, monteurverslag, reparatie,
  onderdelen)?
- Koppelbaarheid: zit er een gezamenlijke sleutel (klant/order/serienummer) tussen
  klantmelding, monteurverslag en afleverbon?
- Privacy: klantdata voor modeltraining — toestemming/anonymisering nodig.

Dit data-asset is de **belangrijkste input** voor Idee A (klant-video-voorspelling).

### Idee B — Monteur-check: begrepen we het goed?

De verwerking tot faulttree wordt **nog één keer teruggestuurd naar de monteur** om te
laten checken of we het goed begrepen hebben — **niet in faulttree-vorm**, maar in de
leesbare vorm:

```
Model, Symptoom, Analyse, Fix, Controle
```

De monteur (die bij de klant staat) krijgt dus een **platte, menselijke samenvatting**
van hoe zijn melding is geïnterpreteerd, en kan bevestigen of corrigeren vóórdat het
verder gaat naar de faulttree/het boek.

**Waarom dit sterk is:**
- Het **sluit de feedbacklus** met de monteur — hij ziet dat zijn melding iets oplevert
  (motiveert, vliegwiel).
- Het **voorkomt fouten** voordat ze de kennisbank in gaan: een verkeerd begrepen
  symptoom/fix wordt gecorrigeerd vóór publicatie.
- Het gebruikt exact de structuur **Model → Symptoom → Analyse → Fix → Controle**
  (dus ook de `kaart-rol.js`-fasen), maar dan als leesbare tekst i.p.v. boom.

**Waar in de flow:**
```
Monteur spreekt in
  → transcript (whisper, Mac)
  → AI verwerkt tot Model/Symptoom/Analyse/Fix/Controle (met boek-context)
  → [NIEUW] TERUGSTUREN naar monteur ter check (platte vorm)
        Monteur: "klopt dit?" ja/nee + correctie
  → pas daarna door naar faulttree-import in het aparte boek
  → Treestudio bewerken
```

**Vragen/overwegingen (niet geblokkeerd):**
- Hoe bereikt de check de monteur? (Via de spraakbericht-app zelf, of via WhatsApp — de
  bot-gedachte van eerder.)
- Is één check-ronde genoeg, of moet de monteur kunnen blijven corrigeren?
- Timing: de monteur staat bij de klant — hoe snel moet de check terugkomen om zinvol
  te zijn?

---

## 9. Synergie tussen beide ideeën

- **Idee B** (monteur-check) maakt de **kwaliteit** van elke melding hoger — de input
  voor de faulttree is geverifieerd.
- **Idee A** (klant-video-analyse) heeft **trainingsdata** nodig; die komt precies uit de
  geverifieerde monteur-meldingen (Idee B + goedkeuring). Samen vormen ze een
  **datavliegwiel**: monteurs leveren gelabelde voorbeelden, de klant-app leert eruit.
- Beide delen dezelfde kern: "gesproken/gefilmde tekst → gestructureerd als
  Model→Symptoom→Analyse→Fix→Controle → geverifieerd → naar de kennisbank".

