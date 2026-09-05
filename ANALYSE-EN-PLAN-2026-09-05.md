# Spraakbericht — analyse en plan (2026-09-05)

Doel van het systeem, in Patricks woorden: een eenvoudige feedbacklus. De monteur
spreekt in bij welk apparaat hij stond, wat de klant zei, wat hij zelf zag, wat de
analyse en oplossing was, of de echte oorzaak is vastgesteld en of het is opgelost.
De audio wordt getranscribeerd en in blokken gezet, de supervisor controleert en stuurt
retour naar de monteur, de monteur bevestigt, en dan komt het geheel in het werkboek
"wachtkamer" waar het aan een boek kan worden toegevoegd. Niets mag verloren gaan,
de bron (monteur) moet altijd zichtbaar zijn, en er loopt een spel met een prijs.

Onderzocht met graft (kaart van 15 bestanden, 60 symbolen), drie leesagenten
(API, frontend, tools/tests/docs), de testsuite en de consumer-logs.

---

## 1. Wat er al is, per stap van de lus

| Stap | Stand | Toelichting |
|---|---|---|
| Monteur spreekt in en verstuurt | ✅ werkt | PWA, max 120 s, naam uit localStorage, upload als base64 naar `POST /api/spraakbericht`. |
| Transcriptie | ✅ werkt, kwetsbaar | Mac-consumer pollt elke 30 s, Whisper (base-model) lokaal via ffmpeg. Draait alleen als de Mac aan staat. Log: 278× DNS-fout, één memo 595× opnieuw geprobeerd. |
| In blokken zetten | 🟡 half | Taalmodel (DeepSeek via Nous) splitst in issues met 5 velden: model, symptoom, analyse, fix, controle. Ontbreekt: symptoom klant vs. monteur apart, rootcause vastgesteld ja/nee, opgelost ja/nee, apparaat-identificatie (serienummer/locatie). |
| Supervisor controleert | 🟡 half | `review.html` kan transcript en issues bewerken en goedkeuren. Kan **niet** terugsturen naar de monteur met een opmerking. |
| Retour naar monteur, monteur bevestigt | 🟡 half, ongecommit | Verificatiescherm + web-push bestaan, maar zitten in 606 regels ongecommit werk. De volgorde is omgekeerd: nu verifieert de monteur vóór de supervisor. De push-link opent niet het juiste memo. Monteur kan alleen velden aanvullen, niet "dit klopt niet" zeggen. |
| Naar werkboek wachtkamer | ✅ werkt, met gaten | Per issue een import naar de diagnose-app, boek `wachtkamer`. Bij meerdere issues worden de tree-id's niet bewaard. Mislukt de import, dan staat de memo toch op "goedgekeurd" en is er geen herkansing. |
| Toevoegen aan een boek | ⬜ elders | Gebeurt in Treestudio van de diagnose-app. Deze app weet daarna niets meer van de memo. |
| Nooit weggooien | ❌ niet geregeld | Zie §2, dit is het grootste probleem. |
| Bron (monteur) zichtbaar | 🟡 half | Naam gaat mee en staat in de titel in de diagnose-app. Maar de naam is vrij invulbaar, standaard "onbekend", en niemand controleert of een monteur zijn eigen memo bewerkt. |
| Spel met prijs | 🟡 half | Leaderboard telt het aantal inzendingen op het moment van uploaden. Geen periode, geen prijs, geen punten voor afgeronde lussen. |
| Duits: interface én transcriptie | ❌ niets | Alles is Nederlands en hard in de code gezet. Zie §2, punt 20, en fase 2b. |

---

## 2. Problemen in de code

Gesorteerd op ernst. Regelnummers verwijzen naar `api/_spraakbericht.js` tenzij anders vermeld.

### Data gaat verloren (botst met "nooit weggooien")

1. **Harde verwijdering.** `DELETE /api/spraakbericht/:id` (r.482-497) wist memo, audio, index en verlaagt de teller. Er blijft niets over.
2. **Elke stap overschrijft het hele record.** Transcript-route (r.308), verificatie (r.345) en approve (r.287) doen een `SET` van het complete JSON-object. Het Whisper-transcript verdwijnt zodra Patrick het bewerkt. De AI-issues verdwijnen zodra de monteur ze aanvult. Er is geen versie of geschiedenis.
3. **Audio staat als base64 in Redis** (r.410-414), tot 8 MB per memo. Redis is werkgeheugen, geen archief. De lokale kopieën in `uitzendingen/` staan op één Mac en niet in git.
4. **Lege issues worden gewist** bij een nieuwe transcript-post (r.306, `delete rec.issues`).

### Herkomst en toegang

5. **Monteur-naam is zelfverklaard.** Body-veld, max 80 tekens, standaard "onbekend" (r.407). Iedereen kan onder elke naam insturen.
6. **Verificatie is publiek zonder eigenaarschap.** `PUT /:id/verificatie` (r.318-347) en `GET ?monteur=` (r.507) hebben geen token en controleren niet wie de memo bewerkt.
7. **Admin-token lekt naar de andere app.** De audio-URL die naar de diagnose-app gaat bevat `?token=<ADMIN_TOKEN>` (r.244-245). Die URL wordt daar opgeslagen bij de draft.
8. **Push-subscription per naam.** `push:<monteur>` (r.360) wordt overschreven bij herregistratie. Twee toestellen met dezelfde naam: één krijgt niets.

### Flow en status

9. **Statussen te mager.** `nieuw → wacht-monteur → verwerkt → goedgekeurd`. Geen "retour van supervisor", geen "afgekeurd", geen "in wachtkamer", geen "in boek".
10. **Consumer mag "goedgekeurd" zetten.** De transcript-route accepteert elke status uit `STATUS_WAITLIST` (r.300), ook goedgekeurd, waarmee de supervisorstap te omzeilen is.
11. **Doorsturen zonder herkansing.** Faalt de import naar de diagnose-app, dan is `diagnoseStatus: "fout"` het enige spoor (r.277). Status blijft goedgekeurd, de knop in review is dan uitgeschakeld.
12. **Push-link werkt niet.** `sw.js` opent `index.html?verificatie=<id>`, maar `app.js` leest die parameter niet.

### Robuustheid

13. **Race conditions.** Alle updates zijn lees-wijzig-schrijf zonder `WATCH`/`MULTI`. Consumer en monteur kunnen elkaars wijziging overschrijven.
14. **Lijst laadt alle audio.** `GET /api/spraakbericht` haalt tot 200 volledige records op, inclusief base64-audio (r.519-526), om alleen metadata terug te geven. Traag en duur.
15. **Rate limiter werkt niet op Vercel.** In-memory `Map` (r.69) is per serverless-instantie en verdwijnt bij elke koude start.
16. **Consumer controleert de terugschrijf niet goed.** `tools/mac-consumer.js` r.182-189: bij een 500 blijft de memo op "nieuw" en wordt eindeloos opnieuw getranscribeerd (zie 595 herhalingen in de log).
17. **Twee namespaces overal gemerged.** `inbox` + legacy `sunshower` (r.154-166) maakt elke route dubbel zo complex. De migratie is nooit afgemaakt.
18. **Test `transcriptie.test.js` faalt** met een lege foutmelding. `koppeling.test.js` slaat het echte deel over zonder mock-server. De API zelf heeft geen tests.
19. **606 regels ongecommit** sinds 26 augustus (push, verificatie, sw). Eén crash of `git checkout` en dat werk is weg.

### Taal

20. **Nederlands zit overal hard in de code.** Vijf plekken, elk apart:
    - Spraakherkenning: `whisper_stt.py` (in `dev/dictation-app`) gebruikt het `base`-model met automatische taaldetectie. Dat model is voor Duits merkbaar slechter dan voor Engels, en auto-detectie gokt bij korte of gemengde opnames verkeerd.
    - Prompts aan het taalmodel: `tools/split-symptomen.js` r.85 en `tools/structuur-faulttree.js` r.58 zijn Nederlandse instructies en vragen impliciet Nederlandse uitvoer.
    - Doorsturen: `api/_spraakbericht.js` r.259 stuurt vast `lang: "nl"` mee naar de diagnose-app.
    - Schermteksten: alle knoppen en meldingen staan letterlijk in `index.html`, `review.html`, `app.js` en de push-tekst in `api/_spraakbericht.js` r.393. Er is geen vertaaltabel.
    - Metadata: `<html lang="nl">` in beide pagina's en `"lang": "nl"` in `manifest.json`.

---

## 3. Plan

Volgorde is bewust: eerst veiligstellen, dan het datamodel, dan de flow. Fase 1 is
de fundering voor alles daarna, want zonder bewaarplicht heeft de rest geen zin.

### Fase 0 — Veiligstellen (uren)

- [ ] Commit het ongecommitte werk (push, verificatie, sw).
- [ ] Consumer: controleer de statuscode van de terugschrijf; na 3 mislukte pogingen memo op `fout-transcriptie` zetten in plaats van eindeloos herhalen.
- [ ] Haal `goedgekeurd` uit de statussen die de transcript-route accepteert.
- [ ] `DELETE` uitschakelen tot fase 1 klaar is (410 Gone teruggeven).

### Fase 1 — Nooit weggooien (dagen)

Principe: een memo is een **logboek**, geen formulier dat je overschrijft.

- [ ] **Gebeurtenissenlijst per memo.** Redis-list `memo:<id>:events` waar elke stap een regel aan toevoegt (`RPUSH`, nooit `SET`): `ingestuurd`, `getranscribeerd`, `gestructureerd`, `supervisor-bewerkt`, `retour-monteur`, `monteur-akkoord`, `doorgestuurd`, `ingetrokken`. Elke regel bevat wie, wanneer en de volledige inhoud op dat moment. Het huidige record wordt een afgeleide van de laatste regel.
- [ ] **Verwijderen wordt intrekken.** `DELETE` voegt een event `ingetrokken` toe met reden; niets wordt gewist; de memo verdwijnt uit de actieve lijst maar blijft in het archief.
- [ ] **Audio uit Redis.** Upload naar Vercel Blob (of Cloudflare R2) met alleen de URL in Redis. Blob-opslag is bedoeld om te bewaren, Redis niet. Lijst-route wordt dan vanzelf licht.
- [ ] **Teller niet meer verlagen.** Punten volgen uit de gebeurtenissenlijst (fase 5), niet uit een losse teller.
- [ ] Migratie: één script dat legacy `sunshower`-sleutels omzet naar `inbox` en de namespace-merge uit alle routes haalt.

### Fase 2 — De juiste blokken (dagen)

Nieuw issue-model, in deze volgorde:

| Veld | Betekenis |
|---|---|
| `apparaat` | Model + serienummer of locatie: "bij welk apparaat stond hij" |
| `symptoomKlant` | Wat de klant meldde |
| `symptoomMonteur` | Wat de monteur zelf waarnam |
| `analyse` | Wat hij onderzocht en concludeerde |
| `oplossing` | Wat hij gedaan heeft |
| `rootcause` | `vastgesteld` / `vermoed` / `onbekend` + tekst |
| `opgelost` | `ja` / `deels` / `nee` |

- [ ] Prompt in `tools/split-symptomen.js` en `tools/structuur-faulttree.js` aanpassen.
- [ ] `issueNaarTekst` (r.144) mapt naar de bestaande rail van de diagnose-app: Model←apparaat, Symptoom←klant+monteur, Analyse, Fix←oplossing, Test←rootcause+opgelost.
- [ ] `review.html` en het verificatiescherm in `app.js` tonen en bewerken de zeven velden.
- [ ] Sanitizer `sanitizeIssues` uitbreiden.

### Fase 2b — Duits, in de hele keten (dagen)

Principe: de taal is een **instelling per monteur**, niet een kopie van de app.
Eén codebasis, twee talen, en de taal reist met de memo mee van opname tot boek.

- [ ] **Taal per monteur.** Veld `taal` (`nl` of `de`) bij de monteur (fase 4) en in elk event. Zolang fase 4 er nog niet is: keuze op het naamscherm, bewaard in localStorage, meegestuurd bij upload.
- [ ] **Spraakherkenning in het Duits.** `whisper_stt.py` krijgt een `--language`-argument dat de consumer doorgeeft; geen auto-detectie meer. Model omhoog van `base` naar minimaal `small`, liever `medium`, want Duits vakjargon (Wärmepumpe, Verdichter, Thermostat) gaat met `base` mis. Meet dit op drie echte Duitse opnames vóór de keuze vastligt.
- [ ] **Prompts tweetalig.** Instructie aan het taalmodel in de taal van de memo, met de harde regel: uitvoer in dezelfde taal als de invoer. Veldnamen in de JSON blijven Engels/technisch (`apparaat`, `symptoomKlant`, …) zodat de code taalonafhankelijk blijft.
- [ ] **Doorsturen met de juiste taal.** `lang` in de import naar de diagnose-app uit de memo halen, niet vast `"nl"`.
- [ ] **Schermteksten uit een vertaaltabel.** Eén bestand `i18n.js` met `nl` en `de`; `index.html` en `app.js` halen elke tekst daaruit op basis van de monteur-taal. `<html lang>`, `manifest.json` (naam, beschrijving) en de push-tekst volgen dezelfde instelling.
- [ ] **Beoordeelscherm.** `review.html` toont per memo de taal en het transcript in die taal. Of het scherm zelf Duits wordt, hangt af van wie het bedient (open vraag 5).
- [ ] **Test.** Eén Duitse en één Nederlandse opname door de hele keten, met schermafdruk van transcript, blokken en het resultaat in de wachtkamer.

### Fase 3 — De lus zoals bedoeld (dagen)

Nieuwe statusketen:

```
nieuw → getranscribeerd → wacht-supervisor → wacht-monteur → monteur-akkoord → in-wachtkamer
                                    ↑                 |
                                    └── monteur: "klopt niet" + opmerking
```

- [ ] Consumer zet `wacht-supervisor` (niet meer `wacht-monteur`).
- [ ] Supervisor krijgt in review een knop **Retour naar monteur** met opmerkingveld; dat triggert de push.
- [ ] Monteur krijgt twee knoppen: **Klopt** en **Klopt niet** met tekstveld. Beide worden events.
- [ ] Pas na `monteur-akkoord` is **Doorsturen naar wachtkamer** mogelijk. Mislukt de import, dan status `doorsturen-mislukt` met een knop **Opnieuw**.
- [ ] Bij meerdere issues alle tree-id's bewaren, niet alleen de eerste.
- [ ] `app.js` leest `?verificatie=<id>` en opent dat memo.
- [ ] Audio-link naar de diagnose-app zonder admin-token: aparte, per-memo leestoken of een ondertekende Blob-URL.

### Fase 4 — Wie is de monteur (dag)

- [ ] Vaste lijst monteurs in Redis (`monteurs`: id, naam, persoonlijke code).
- [ ] Monteur logt eenmalig in met naam + code; de app bewaart een per-monteur token.
- [ ] Server bepaalt `monteurId` uit het token, niet uit de body. Verificatie en `?monteur=` controleren eigenaarschap.
- [ ] Push-subscriptions per `monteurId` als set, zodat meerdere toestellen werken.
- [ ] `monteurId` + naam gaan mee in elk event en in de import naar de diagnose-app.

### Fase 5 — Het spel (dag)

- [ ] Punten uit de gebeurtenissenlijst, niet uit een teller. Voorstel: 1 punt bij `monteur-akkoord`, 2 extra als `rootcause = vastgesteld`, 1 extra als `opgelost = ja`. Inzenden alleen telt niet meer (geen spam-prikkel).
- [ ] Ronde met begin- en einddatum en prijsomschrijving in config; leaderboard toont de lopende ronde en het archief.
- [ ] Ingetrokken memo's tellen niet mee.

### Fase 6 — Robuustheid en bewijs (dagen)

- [ ] Updates via `WATCH`/`MULTI` of een Lua-script, of, eenvoudiger, alleen nog `RPUSH` op de eventlist (dan is er niets meer te overschrijven).
- [ ] Rate limiting via Redis (`INCR` + `EXPIRE` per IP).
- [ ] API-tests met een lokale Redis: elke route, elke statusovergang, elk event.
- [ ] `transcriptie.test.js` repareren of duidelijk laten overslaan met reden.
- [ ] Consumer als launchd-service documenteren en healthcheck loggen.

---

## 4. Open vragen voor Patrick

1. **Audio-opslag:** Vercel Blob (zelfde leverancier, eenvoudig) of Cloudflare R2 (goedkoper bij veel data)? Beide zijn duurzaam.
2. **Volgorde supervisor/monteur:** het plan zet de supervisor vóór de monteur, zoals je beschreef. De huidige code doet het andersom. Klopt de nieuwe volgorde?
3. **Puntentelling:** is het voorstel in fase 5 wat je bedoelt, of tellen andere dingen mee?
4. **Monteur-identiteit:** volstaat naam + persoonlijke code, of moet dit aan een bestaand login van de diagnose-app hangen?
5. **Duits:** wordt de app alleen Duits, of Nederlands én Duits met keuze per monteur? Het plan gaat uit van beide. En wie bedient het beoordeelscherm: alleen jij (dan blijft dat Nederlands) of ook een Duitse supervisor?
6. **Duitse woordenlijst:** heb je Duitse handboeken of onderdelenlijsten van Sunshower? Die kunnen als woordenlijst mee naar Whisper en het taalmodel, wat de herkenning van vakjargon flink verbetert.
