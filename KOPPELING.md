# KOPPELING — Contract tussen spraakbericht-app en de diagnose-app

Dit document beschrijft het **werkelijke** contract tussen de spraakbericht-app
(`spraakbericht.vercel.app`) en de diagnose-app (`sunshower-diagnose.vercel.app`),
zoals het nu in de code zit (2026-08-25).

## 0. Flow in één zin

Monteur spreekt een memo in → `POST /api/spraakbericht` (spraakbericht-app) →
Mac-consumer transcribeert (whisper) + structureert (AI → Model/Symptoom/Analyse/
Fix/Controle) → Patrick keurt goed in `review.html` → de approve stuurt de tekst
naar de diagnose-app via `POST /api/import`.

## 1. Eigen opslag in de spraakbericht-app (niet onder dit contract)

De memo's staan in de eigen Redis-naamruimte van de spraakbericht-app. Sinds
**2026-08-25** heet die namespace **`inbox`** (was `sunshower` — verwarrend, want
de diagnose-app heeft óók een `sunshower`-boek). Bestaande memo's staan nog onder
de oude `sunshower`-sleutel; de GET-lijst en de memo-ophaalroutes **mergen** beide
namespaces zodat niets verdwijnt. De `boekKey`-prefix is `b:<boek>:`.

## 2. Doorsturen naar de diagnose-app (het daadwerkelijke contract)

Alleen de **goedgekeurde** memo wordt doorgestuurd. De approve-handler
(`POST /api/spraakbericht/:id/approve` in `api/_spraakbericht.js`) stuurt:

**Endpoint:** `POST {DIAGNOSE_API_BASE}/api/import`
(`DIAGNOSE_API_BASE` default `https://sunshower-diagnose.vercel.app`)

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <DIAGNOSE_ADMIN_TOKEN>
```

**Body (JSON):**
```json
{
  "soort": "tekst",
  "inhoud": "<AI-structuur, of het transcript als er geen structuur is>",
  "naam": "<monteur> — <eerste symptoom>",
  "boek": "<doel-boek>",
  "lang": "nl"
}
```

| Veld     | Type   | Verplicht | Omschrijving |
|----------|--------|-----------|--------------|
| `soort`  | string | ja        | Altijd `"tekst"` |
| `inhoud` | string | ja        | De AI-gestructureerde vorm (Model→Symptoom→Analyse→Fix→Controle, bewerkbaar) of de rauwe transcript-tekst |
| `naam`   | string | ja        | Leesbare bestandsnaam: `monteur — symptoom`. Valt zonder structuur terug op monteur + eerste 40 tekens van het transcript. Gesanitiseerd (geen rare tekens) |
| `boek`   | string | ja        | Doel-boek in de diagnose-app. Default `wachtkamer`; Patrick kiest het per melding in `review.html` |
| `lang`   | string | ja        | Altijd `"nl"` |

> **Harde grens:** `sunshower` mag **nooit** het doel-boek zijn. De approve
> weigert met een duidelijke melding als `doelBoek === "sunshower"` wordt
> aangeleverd, en `review.html` toont de optie uitgeschakeld ("geblokkeerd").
> Het `DOELBOEK`-env (default `wachtkamer`) mag evenmin `sunshower` zijn.

### Doel-boek-keuze (P4)

`review.html` toont naast de goedkeurknop een dropdown per melding (default
`wachtkamer`). De beschikbare boeken komen uit de publieke diagnose-endpoint
`GET {DIAGNOSE_API_BASE}/api/boeken`. `wachtkamer` en `sunshower` staan altijd in
de lijst; `sunshower` wordt alleen als geblokkeerd getoond. De gekozen waarde gaat
mee in het approve-verzoek als `doelBoek`; ongeldige/ontbrekende waarden vallen
terug op `DOELBOEK`.

### Respons van de diagnose-app

De approve slaat `diagnoseStatus` (HTTP-status, of `"fout"`/`"niet-geconfigureerd"`)
en bij succes `diagnoseTreeId` op de memo. De app schakelt het doorsturen pas in
als `DIAGNOSE_ADMIN_TOKEN` is gezet; zonder token krijgt de memo `diagnoseStatus:
"niet-geconfigureerd"` en wordt alleen lokaal opgeslagen.

## 3. Boeken ophalen (voor de dropdown)

**Endpoint:** `GET {DIAGNOSE_API_BASE}/api/boeken` (publiek, geen auth)
**Antwoord (vorm):** `{ "ok": true, "boeken": [ { "id": "…", "naam": "…" }, … ] }`
De app normaliseert naar `id`-strings en voegt altijd `wachtkamer` + `sunshower` toe.

## 4. Testen

```bash
npm test                 # consistentie-check (geen backend nodig)
npm run test:all         # + koppeling (mock) + transcriptie
node --check api/_spraakbericht.js
```

De mock-server (`tools/mock-server.js`) draait op :52344 voor de lokale
koppelings-test.
