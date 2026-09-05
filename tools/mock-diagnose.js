#!/usr/bin/env node
/* tools/mock-diagnose.js — nabootsing van de diagnose-app voor lokale tests.
   Biedt precies wat de spraakbericht-app aanroept (KOPPELING.md):
     GET  /api/boeken            → {ok, boeken:[{id,naam}]}
     POST /api/import            → {ok, treeId}  (Bearer DIAGNOSE_ADMIN_TOKEN)
     GET  /api/imports           → alles wat ontvangen is (voor de tests)
   Weigert boek 'sunshower' met 400, net als de echte app hoort te doen.
   Start: PORT=52351 DIAGNOSE_ADMIN_TOKEN=diag node tools/mock-diagnose.js */
const http = require("http");
const PORT = Number(process.env.PORT || 52351);
const TOKEN = process.env.DIAGNOSE_ADMIN_TOKEN || "diag";
const FAAL_BOEK = process.env.FAAL_BOEK || "kapot"; // import naar dit boek geeft 500 (test doorsturen-mislukt)
const imports = [];

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url.startsWith("/api/boeken")) return json(200, { ok: true, boeken: [{ id: "wachtkamer", naam: "Wachtkamer" }, { id: "sunshower", naam: "Sunshower" }, { id: "testboek", naam: "Testboek" }] });
  if (req.method === "GET" && req.url.startsWith("/api/imports")) return json(200, { ok: true, imports });
  if (req.method === "POST" && req.url.startsWith("/api/import")) {
    if ((req.headers.authorization || "") !== "Bearer " + TOKEN) return json(401, { error: "unauthorized" });
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      let body; try { body = JSON.parse(data); } catch (e) { return json(400, { error: "geen json" }); }
      if (body.boek === "sunshower") return json(400, { error: "sunshower is beschermd" });
      if (body.boek === FAAL_BOEK) return json(500, { error: "gesimuleerde storing" });
      const treeId = "txt_spraakbericht_" + Date.now() + "_" + imports.length;
      imports.push(Object.assign({ treeId, ontvangenOp: new Date().toISOString() }, body));
      console.log("[mock-diagnose] import", treeId, body.boek, body.lang, JSON.stringify(body.naam));
      json(200, { ok: true, treeId });
    });
    return;
  }
  json(404, { error: "niet gevonden" });
}).listen(PORT, () => console.log("[mock-diagnose] op http://localhost:" + PORT));
