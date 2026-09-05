/* ============================================================
   config.js — KOPPELING aan de bestaande Sunshower-app
   ------------------------------------------------------------
   ALLE variabelen die de bestaande Sunshower-backend nodig heeft
   staan hier op één plek. Verander niets in app.js om te koppelen
   aan een andere backend — verander dit bestand.

   De app is statisch. Dit bestand is het enige "contract" tussen
   deze monteursapp en de bestaande diagnose-app.
   ============================================================ */
window.SS_MONTEUR_CONFIG = {
  /* ---- Koppeling aan de bestaande Sunshower-app ---- */

  /* Basis-URL van deze app (Vercel). Frontend + API staan op spraakbericht.vercel.app. */
  API_BASE: "https://spraakbericht.vercel.app",

  /* Endpoint dat de inzending ontvangt. */
  API_ROUTE: "/api/spraakbericht",

  /* Endpoint dat het leaderboard (inzendingen per monteur) ophaalt. */
  LEADERBOARD_ROUTE: "/api/spraakbericht/leaderboard",

  /* Welk boek/klant (multi-tenant). Bestaande app gebruikt
     boekKey(boek, key) -> "b:<slug>:"-prefix. */
  BOEK_SLUG: "sunshower",

  /* Bearer-token. De bestaande app authenticeert met
     "Authorization: Bearer <token>" (ADMIN_TOKEN / sessie-token). */
  AUTH_TOKEN: "",

  /* Web Push (2026-09-01): publieke VAPID-key waarmee de browser pushManager
     mag subscriben. De bijbehorende PRIVATE key + SUBJECT leven als env-var
     op Vercel (VAPID_PRIVATE_KEY, VAPID_SUBJECT) — alleen de publieke key mag
     in deze client-bundle staan. Gegenereerd: npx web-push generate-vapid-keys. */
  VAPID_PUBLIC_KEY: "BLxj1uPtMgFUWUKhr416yNThEYkd5PoPLNOzXXk1sceuyRy0AiiJu68EWsxd75CuMGFMoWIlzY_BLHIijCDWszs",

  /* Standaard monteur-naam; overschrijfbaar in de app (localStorage). */
  MONTEUR_NAAM: "",

  /* App-versie — cache-busting / service worker. */
  APP_V: 2,

  /* ---- Audio-instellingen ---- */
  /* MIME-type voor MediaRecorder; bij ondersteuning Opus. */
  AUDIO_MIME: "audio/webm;codecs=opus",
  /* Maximale opnameduur in seconden (bewuste grens voor uploadgrootte). */
  MAX_SECONDS: 120
};
