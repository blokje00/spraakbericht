/* schema.js — één bron voor de vorm van een memo-issue, de statussen en de
   talen. Gedeeld door de API (node), de monteursapp, review.html, de prompts
   en de tekst naar de diagnose-app (2026-09-05). Werkt in de browser
   (window.SS_SCHEMA) én in node (module.exports).

   Een issue = één probleem dat de monteur tegenkwam. De velden volgen de
   vragen die Patrick stelde: bij welk apparaat stond je, wat zei de klant,
   wat zag je zelf, wat was je analyse en oplossing, is de echte oorzaak
   vastgesteld en van welke soort, en is het opgelost.

   Talen: nl (Nederlands), de (Duits), fr (Belgisch Frans), id (Indonesisch).
   Een nieuwe taal toevoegen = hier een kolom, in i18n.js een blok, in
   tools/structureer.js een prompt en in tools/woordenlijst.json een regel;
   tests/consistentie.test.js controleert dat alles compleet is. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SS_SCHEMA = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* code → naam op het scherm; whisper = taalcode voor de spraakherkenning */
  var TALEN = {
    nl: { naam: "Nederlands", whisper: "nl" },
    de: { naam: "Deutsch", whisper: "de" },
    fr: { naam: "Français (Belgique)", whisper: "fr" },
    id: { naam: "Bahasa Indonesia", whisper: "id" }
  };

  /* Velden van een issue, in de volgorde waarin ze op het scherm staan.
     type "tekst" = vrije tekst; type "keuze" = één van `opties`. */
  var ISSUE = {
    apparaat: { type: "tekst", groot: false, label: {
      nl: "Apparaat (model, serienummer of plek)", de: "Gerät (Modell, Seriennummer oder Ort)",
      fr: "Appareil (modèle, numéro de série ou emplacement)", id: "Perangkat (model, nomor seri, atau lokasi)" } },
    symptoomKlant: { type: "tekst", groot: true, label: {
      nl: "Symptoom volgens de klant", de: "Symptom laut Kunde", fr: "Symptôme selon le client", id: "Gejala menurut pelanggan" } },
    symptoomMonteur: { type: "tekst", groot: true, label: {
      nl: "Symptoom volgens jou", de: "Symptom laut Monteur", fr: "Symptôme selon vous", id: "Gejala menurut Anda" } },
    analyse: { type: "tekst", groot: true, label: { nl: "Analyse", de: "Analyse", fr: "Analyse", id: "Analisis" } },
    oplossing: { type: "tekst", groot: true, label: { nl: "Oplossing", de: "Lösung", fr: "Solution", id: "Solusi" } },
    rootcauseStatus: { type: "keuze", opties: ["vastgesteld", "vermoed", "onbekend"],
      label: { nl: "Echte oorzaak", de: "Eigentliche Ursache", fr: "Cause réelle", id: "Penyebab sebenarnya" },
      optieLabel: {
        nl: { vastgesteld: "vastgesteld", vermoed: "vermoed", onbekend: "onbekend" },
        de: { vastgesteld: "festgestellt", vermoed: "vermutet", onbekend: "unbekannt" },
        fr: { vastgesteld: "établie", vermoed: "présumée", onbekend: "inconnue" },
        id: { vastgesteld: "dipastikan", vermoed: "diduga", onbekend: "tidak diketahui" } } },
    rootcause: { type: "tekst", groot: true, label: {
      nl: "Wat was de echte oorzaak?", de: "Was war die eigentliche Ursache?", fr: "Quelle était la cause réelle ?", id: "Apa penyebab sebenarnya?" } },
    oorzaakType: { type: "keuze", opties: ["productiefout", "installatiefout", "gebruikersfout", "onbekend"],
      label: { nl: "Soort oorzaak", de: "Art der Ursache", fr: "Type de cause", id: "Jenis penyebab" },
      optieLabel: {
        nl: { productiefout: "productiefout", installatiefout: "installatiefout", gebruikersfout: "gebruikersfout", onbekend: "onbekend" },
        de: { productiefout: "Produktionsfehler", installatiefout: "Installationsfehler", gebruikersfout: "Bedienungsfehler", onbekend: "unbekannt" },
        fr: { productiefout: "défaut de fabrication", installatiefout: "erreur d'installation", gebruikersfout: "erreur d'utilisation", onbekend: "inconnu" },
        id: { productiefout: "cacat produksi", installatiefout: "kesalahan pemasangan", gebruikersfout: "kesalahan pengguna", onbekend: "tidak diketahui" } } },
    opgelost: { type: "keuze", opties: ["ja", "deels", "nee", "onbekend"],
      label: { nl: "Opgelost", de: "Behoben", fr: "Résolu", id: "Teratasi" },
      optieLabel: {
        nl: { ja: "ja", deels: "deels", nee: "nee", onbekend: "onbekend" },
        de: { ja: "ja", deels: "teilweise", nee: "nein", onbekend: "unbekannt" },
        fr: { ja: "oui", deels: "en partie", nee: "non", onbekend: "inconnu" },
        id: { ja: "ya", deels: "sebagian", nee: "tidak", onbekend: "tidak diketahui" } } }
  };

  /* Statussen in de volgorde van de lus. `wie` = wie er aan zet is. */
  var STATUS = {
    "nieuw": { wie: "systeem", label: { nl: "nieuw", de: "neu", fr: "nouveau", id: "baru" } },
    "fout-transcriptie": { wie: "supervisor", label: { nl: "transcriptie mislukt", de: "Transkription fehlgeschlagen", fr: "transcription échouée", id: "transkripsi gagal" } },
    "wacht-supervisor": { wie: "supervisor", label: { nl: "wacht op supervisor", de: "wartet auf Supervisor", fr: "en attente du superviseur", id: "menunggu supervisor" } },
    "wacht-monteur": { wie: "monteur", label: { nl: "wacht op monteur", de: "wartet auf Monteur", fr: "en attente du technicien", id: "menunggu teknisi" } },
    "monteur-akkoord": { wie: "supervisor", label: { nl: "monteur akkoord", de: "Monteur einverstanden", fr: "technicien d'accord", id: "teknisi setuju" } },
    "in-wachtkamer": { wie: "klaar", label: { nl: "in wachtkamer", de: "im Wartezimmer", fr: "en salle d'attente", id: "di ruang tunggu" } },
    "doorsturen-mislukt": { wie: "supervisor", label: { nl: "doorsturen mislukt", de: "Weiterleitung fehlgeschlagen", fr: "transfert échoué", id: "penerusan gagal" } },
    "ingetrokken": { wie: "klaar", label: { nl: "verwijderd", de: "gelöscht", fr: "supprimé", id: "dihapus" } }
  };

  /* Korte woorden die de API in de taal van de memo gebruikt: in de tekst
     naar de diagnose-app en in de push-melding. */
  var TEKST = {
    nl: { klant: "Klant", monteur: "Monteur", oorzaak: "Oorzaak", soort: "Soort", opgelost: "Opgelost", toelichting: "Toelichting",
          pushTitel: "Memo ter controle", pushTekst: "De supervisor heeft je memo teruggestuurd. Kijk je even?" },
    de: { klant: "Kunde", monteur: "Monteur", oorzaak: "Ursache", soort: "Art", opgelost: "Behoben", toelichting: "Anmerkung",
          pushTitel: "Memo zum Prüfen", pushTekst: "Der Supervisor hat dein Memo zurückgeschickt. Bitte prüfen." },
    fr: { klant: "Client", monteur: "Technicien", oorzaak: "Cause", soort: "Type", opgelost: "Résolu", toelichting: "Remarque",
          pushTitel: "Mémo à vérifier", pushTekst: "Le superviseur vous a renvoyé votre mémo. Pouvez-vous le vérifier ?" },
    id: { klant: "Pelanggan", monteur: "Teknisi", oorzaak: "Penyebab", soort: "Jenis", opgelost: "Teratasi", toelichting: "Catatan",
          pushTitel: "Memo untuk diperiksa", pushTekst: "Supervisor mengembalikan memo Anda. Mohon diperiksa." }
  };

  function issueVelden() { return Object.keys(ISSUE); }
  function statussen() { return Object.keys(STATUS); }
  function talen() { return Object.keys(TALEN); }
  function isTaal(t) { return Object.prototype.hasOwnProperty.call(TALEN, t); }
  function taalNaam(t) { return TALEN[t] ? TALEN[t].naam : t; }
  function leegIssue() {
    var o = {};
    issueVelden().forEach(function (k) {
      o[k] = ISSUE[k].type === "keuze" ? ISSUE[k].opties[ISSUE[k].opties.length - 1] : "";
    });
    return o;
  }
  function label(veld, taal) { return ISSUE[veld].label[taal] || ISSUE[veld].label.nl; }
  function optieLabel(veld, optie, taal) { var m = ISSUE[veld].optieLabel; return (m[taal] || m.nl)[optie] || optie; }
  function statusLabel(status, taal) {
    var s = STATUS[status];
    return s ? (s.label[taal] || s.label.nl) : status;
  }
  function tekst(sleutel, taal) { return (TEKST[taal] || TEKST.nl)[sleutel] || TEKST.nl[sleutel] || sleutel; }

  return { ISSUE: ISSUE, STATUS: STATUS, TALEN: TALEN, TEKST: TEKST, issueVelden: issueVelden, statussen: statussen, talen: talen, isTaal: isTaal, taalNaam: taalNaam, leegIssue: leegIssue, label: label, optieLabel: optieLabel, statusLabel: statusLabel, tekst: tekst };
});
