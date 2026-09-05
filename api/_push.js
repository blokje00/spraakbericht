/* api/_push.js — web-push naar de monteur (2026-09-05).
   Subscriptions per monteur-id als SET (meerdere toestellen). Een
   subscription die de push-dienst als verlopen meldt (404/410) wordt uit
   de set gehaald; dat is geen inhoud, alleen een adres dat niet meer bestaat. */
const { cmd, boekKey } = require("./_redis");

const k = (id) => boekKey("inbox", "push:" + id);

async function bewaarSubscription(monteurId, subscription) {
  await cmd(["SADD", k(monteurId), JSON.stringify(subscription)]);
}

function vapid() {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT;
  return pub && priv && subject ? { pub, priv, subject } : null;
}

/* Stuur {title, body, id} naar alle toestellen van de monteur.
   Geeft {verzonden, mislukt, geenSubscription, geenVapid}. */
async function stuur(monteurId, payload) {
  const leden = (await cmd(["SMEMBERS", k(monteurId)])) || [];
  if (!leden.length) return { verzonden: 0, mislukt: 0, geenSubscription: true };
  const v = vapid();
  if (!v) { console.error("[push] VAPID-keys ontbreken — overgeslagen voor " + monteurId); return { verzonden: 0, mislukt: leden.length, geenVapid: true }; }
  const webpush = require("web-push");
  webpush.setVapidDetails(v.subject, v.pub, v.priv);
  let verzonden = 0, mislukt = 0;
  for (const raw of leden) {
    let sub; try { sub = JSON.parse(raw); } catch (e) { sub = null; }
    if (!sub || !sub.endpoint) { mislukt++; continue; }
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); verzonden++; }
    catch (e) {
      mislukt++;
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await cmd(["SREM", k(monteurId), raw]);
      else console.error("[push] mislukt voor " + monteurId + ": " + (e && e.message));
    }
  }
  return { verzonden, mislukt };
}

module.exports = { bewaarSubscription, stuur };
