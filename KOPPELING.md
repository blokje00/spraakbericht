# KOPPELING — Contract tussen spraakbericht-app en de diagnose-app

Dit document beschrijft het **werkelijke** contract tussen de spraakbericht-app
(`spraakbericht.vercel.app`) en de diagnose-app (`sunshower-diagnose.vercel.app`),
zoals het in de code zit sinds 2026-09-05.

## 0. Flow in één zin

Monteur spreekt in → Mac transcribeert (Whisper, in de taal van de monteur) en
structureert (taalmodel → issues) → supervisor controleert en stuurt retour →
monteur bevestigt → supervisor stuurt door: per issue één import in de diagnose-app.

## 1. Eigen opslag (niet onder dit contract)

Memo's staan in de eigen Redis-naamruimte `inbox` (`b:inbox:spraakbericht:<id>`),
elk met een logboek (`…:<id>:events`) dat nooit wordt ingekort. Zie `api/_memo.js`.

## 2. Doorsturen naar de diagnose-app

Alleen na `monteur-akkoord`. Handler: `POST /api/spraakbericht/:id/doorsturen`
(`api/_spraakbericht.js` → `api/_diagnose.js`). Per issue één verzoek:

**Endpoint:** `POST {DIAGNOSE_API_BASE}/api/import`

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <DIAGNOSE_ADMIN_TOKEN>
```

**Body:**
```json
{
  "soort": "tekst",
  "inhoud": "Model: …\nSymptoom: Klant: … / Monteur: …\nAnalyse: …\nFix: …\nControle: Oorzaak (vastgesteld): … / Opgelost: ja",
  "naam": "<monteur> — <symptoom klant>",
  "boek": "wachtkamer",
  "lang": "nl",
  "spraakbericht": {
    "id": "memo_…", "issue": 0,
    "monteur": "Jan de Vries", "monteurId": "jan-de-vries",
    "audioUrl": "https://spraakbericht.vercel.app/api/spraakbericht/memo_…/audio?t=<audioToken>",
    "taal": "nl"
  }
}
```

| Veld | Omschrijving |
|---|---|
| `inhoud` | Faulttree-tekst op de rail Model → Symptoom → Analyse → Fix → Controle. Sleutelwoorden én inhoud zijn Nederlands, ongeacht de taal van de monteur. Lege stappen worden weggelaten. |
| `naam` | `<monteur> — <symptoom>`; letters met accenten blijven staan. |
| `boek` | Doel-boek; standaard `DOELBOEK` (= `wachtkamer`). **`sunshower` wordt altijd geweigerd.** |
| `lang` | Altijd `nl`: inhoud, toelichting en naam zijn Nederlands, ook bij anderstalige monteurs. De brontaal staat in `spraakbericht.taal`. |
| `spraakbericht.audioUrl` | Afspeelbare link naar de originele opname. Het token in de link is **per memo** (geen admin-token) en geeft alleen die audio. |
| `spraakbericht.monteur*` | De bron van de melding, zodat de diagnose-app hem kan tonen. |

De diagnose-app antwoordt met `{ ok, treeId }`. Per issue wordt `status`, `treeId` en
de naam bewaard op de memo (`diagnose[]`). Als één van de imports faalt krijgt de memo
`doorsturen-mislukt` en kan de supervisor opnieuw doorsturen.

### Waar de velden vandaan komen

| Stap in de diagnose-app | Issue-veld (schema.js) |
|---|---|
| Model | `apparaat` |
| Symptoom | `symptoomKlant` + `symptoomMonteur` |
| Analyse | `analyse` |
| Fix | `oplossing` |
| Controle | `rootcause` (+ `rootcauseStatus`) en `opgelost` |

## 3. Boeken ophalen (voor de dropdown in review.html)

`GET {DIAGNOSE_API_BASE}/api/boeken` (publiek) → `{ ok, boeken: [{ id, naam }] }`.
`wachtkamer` staat altijd in de lijst; `sunshower` wordt nooit als keuze getoond.

## 4. Testen zonder de echte diagnose-app

`tools/mock-diagnose.js` biedt precies deze twee endpoints (+ `GET /api/imports` om te
zien wat er binnenkwam) en weigert `sunshower` met 400. `npm test` en
`npm run test:loop` gebruiken hem.
