/* ============================================================
   config.js — instellingen van de monteursapp (2026-09-05)
   ------------------------------------------------------------
   Eén plek voor alles wat per omgeving verschilt. De app is statisch;
   lokaal testen: zet API_BASE op "" (zelfde host als tools/local-api.js)
   of op "http://localhost:52350".
   ============================================================ */
window.SS_MONTEUR_CONFIG = {
  /* Basis-URL van de API. Leeg = dezelfde host als de pagina (werkt op
     Vercel én met tools/local-api.js). */
  API_BASE: "",

  /* Web Push: publieke VAPID-key waarmee de browser pushManager mag
     subscriben. De PRIVATE key + SUBJECT staan als env-var op Vercel
     (VAPID_PRIVATE_KEY, VAPID_SUBJECT). Gegenereerd: npx web-push generate-vapid-keys. */
  VAPID_PUBLIC_KEY: "BLxj1uPtMgFUWUKhr416yNThEYkd5PoPLNOzXXk1sceuyRy0AiiJu68EWsxd75CuMGFMoWIlzY_BLHIijCDWszs",

  /* Standaardtaal van de schermen zolang er niemand is ingelogd (nl | de). */
  STANDAARD_TAAL: "nl",

  /* App-versie — cache-busting / service worker. */
  APP_V: 3,

  /* ---- Audio-instellingen ---- */
  /* MIME-type voor MediaRecorder; bij ondersteuning Opus. */
  AUDIO_MIME: "audio/webm;codecs=opus",
  /* Maximale opnameduur in seconden (bewuste grens voor uploadgrootte). */
  MAX_SECONDS: 120
};
