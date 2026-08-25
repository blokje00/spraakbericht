/* api/_redis.js — vereenvoudigde Redis-laag voor de spraakbericht-app.
   Gebruikt REDIS_URL (directe verbinding, zelfde als de diagnose-app).
   Geen endpoint (underscore-prefix). */
const REDIS_URL = process.env.REDIS_URL;

function configured() {
  return !!REDIS_URL;
}

let client = null;
async function getClient() {
  if (!client) {
    const { createClient } = require("redis");
    client = createClient({ url: REDIS_URL });
    client.on("error", () => {});
    await client.connect();
  }
  return client;
}

/* voert één Redis-commando uit, bv. cmd(["SET","k","v"]). */
async function cmd(args) {
  const c = await getClient();
  return c.sendCommand(args.map(String));
}

/* multi-tenant: boek-scoped sleutel. spraakbericht gebruikt één boek ("inbox").
   2026-08-25: hernoemd van "sunshower" → "inbox" (de diagnose-app heeft ook
   een "sunshower" boek → verwarrend). Oude sleutels blijven bestaan; de API
   leest + merged beide namespaces tijdens de migratie. */
function boekKey(boek, key) {
  return "b:" + (boek || "inbox") + ":" + key;
}

module.exports = { configured, cmd, boekKey };
