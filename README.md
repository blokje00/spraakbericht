# Sunshower — Monteursapp (audio-input)

Aparte, dunne PWA voor monteurs: spreek in wat je tegenkomt, de originele audio gaat
naar de bestaande Sunshower-backend voor review.

## Draaien

```bash
# app (statisch)
node tools/dev-server.js        # http://localhost:52343

# test-backend (simuleert de bestaande Sunshower-app)
node tools/mock-server.js       # http://localhost:52344
```

Testen zonder echte backend: zet in `config.js` `API_BASE = "http://localhost:52344"`.
De mock slaat elke submissie op in `uitzendingen/` (incl. audio als `.webm`).

## Koppeling

Alles wat de bestaande Sunshower-app nodig heeft staat in **`config.js`**:
`API_BASE`, `API_ROUTE`, `BOEK_SLUG`, `AUTH_TOKEN`, `MONTEUR_NAAM`, `APP_V`.
Zie **`KOPPELING.md`** voor het volledige contract.

## Structuur

```
config.js        ← koppeling (het contract)
index.html       ← + knop, opnameflow
style.css        ← Sunshower huisstijl
app.js           ← MediaRecorder + upload
manifest.json    ← PWA-installatie (iPhone homescreen)
sw.js            ← offline shell
icon.svg         ← app-icoon
tools/
  dev-server.js  ← statische server
  mock-server.js ← test-backend
KOPPELING.md     ← contract met de bestaande app
PLAN.md          ← plan + actieplan
```

## Huisstijl

Volgt de officiële Sunshower-huisstijl (`~/vault/sunshower-faulttree/huisstijl/`):
zwart stuurt, Ember `#d9491f` als enige accent (opname), canvas `#f4f4f2`, radius 6px,
font CircularXXWeb.

## Volgende stap

De bestaande Sunshower-app moet het endpoint `POST /api/monteuridee` bouwen
(handler + router-regel) zodat echte submissies binnenkomen. Zie `KOPPELING.md` §3.
