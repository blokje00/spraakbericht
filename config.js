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

  /* Standaard monteur-naam; overschrijfbaar in de app (localStorage). */
  MONTEUR_NAAM: "",

  /* App-versie — cache-busting / service worker. */
  APP_V: 1,

  /* ---- Audio-instellingen ---- */
  /* MIME-type voor MediaRecorder; bij ondersteuning Opus. */
  AUDIO_MIME: "audio/webm;codecs=opus",
  /* Maximale opnameduur in seconden (bewuste grens voor uploadgrootte). */
  MAX_SECONDS: 120
};
