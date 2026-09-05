/* schema.js — één bron voor de vorm van een memo-issue en de statussen.
   Gedeeld door de API (node), de monteursapp, review.html en de prompts
   (2026-09-05, fase 2/2b). Werkt in de browser (window.SS_SCHEMA) én in
   node (module.exports).

   Een issue = één probleem dat de monteur tegenkwam. De velden volgen de
   vragen die Patrick stelde: bij welk apparaat stond je, wat zei de klant,
   wat zag je zelf, wat was je analyse en oplossing, is de echte oorzaak
   vastgesteld, en is het opgelost. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SS_SCHEMA = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* Velden van een issue, in de volgorde waarin ze op het scherm staan.
     type "tekst" = vrije tekst; type "keuze" = één van `opties`. */
  var ISSUE = {
    apparaat:        { type: "tekst", groot: false, label: { nl: "Apparaat (model, serienummer of plek)", de: "Gerät (Modell, Seriennummer oder Ort)" } },
    symptoomKlant:   { type: "tekst", groot: true,  label: { nl: "Symptoom volgens de klant",           de: "Symptom laut Kunde" } },
    symptoomMonteur: { type: "tekst", groot: true,  label: { nl: "Symptoom volgens jou",                de: "Symptom laut Monteur" } },
    analyse:         { type: "tekst", groot: true,  label: { nl: "Analyse",                             de: "Analyse" } },
    oplossing:       { type: "tekst", groot: true,  label: { nl: "Oplossing",                           de: "Lösung" } },
    rootcauseStatus: { type: "keuze", opties: ["vastgesteld", "vermoed", "onbekend"],
                       label: { nl: "Echte oorzaak", de: "Eigentliche Ursache" },
                       optieLabel: { nl: { vastgesteld: "vastgesteld", vermoed: "vermoed", onbekend: "onbekend" },
                                     de: { vastgesteld: "festgestellt", vermoed: "vermutet", onbekend: "unbekannt" } } },
    rootcause:       { type: "tekst", groot: true,  label: { nl: "Wat was de echte oorzaak?",          de: "Was war die eigentliche Ursache?" } },
    oorzaakType:     { type: "keuze", opties: ["productiefout", "installatiefout", "gebruikersfout", "onbekend"],
                       label: { nl: "Soort oorzaak", de: "Art der Ursache" },
                       optieLabel: { nl: { productiefout: "productiefout", installatiefout: "installatiefout", gebruikersfout: "gebruikersfout", onbekend: "onbekend" },
                                     de: { productiefout: "Produktionsfehler", installatiefout: "Installationsfehler", gebruikersfout: "Bedienungsfehler", onbekend: "unbekannt" } } },
    opgelost:        { type: "keuze", opties: ["ja", "deels", "nee", "onbekend"],
                       label: { nl: "Opgelost", de: "Behoben" },
                       optieLabel: { nl: { ja: "ja", deels: "deels", nee: "nee", onbekend: "onbekend" },
                                     de: { ja: "ja", deels: "teilweise", nee: "nein", onbekend: "unbekannt" } } }
  };

  /* Statussen in de volgorde van de lus. `wie` = wie er aan zet is. */
  var STATUS = {
    "nieuw":              { wie: "systeem",    label: { nl: "nieuw",                 de: "neu" } },
    "fout-transcriptie":  { wie: "supervisor", label: { nl: "transcriptie mislukt",  de: "Transkription fehlgeschlagen" } },
    "wacht-supervisor":   { wie: "supervisor", label: { nl: "wacht op supervisor",   de: "wartet auf Supervisor" } },
    "wacht-monteur":      { wie: "monteur",    label: { nl: "wacht op monteur",      de: "wartet auf Monteur" } },
    "monteur-akkoord":    { wie: "supervisor", label: { nl: "monteur akkoord",       de: "Monteur einverstanden" } },
    "in-wachtkamer":      { wie: "klaar",      label: { nl: "in wachtkamer",         de: "im Wartezimmer" } },
    "doorsturen-mislukt": { wie: "supervisor", label: { nl: "doorsturen mislukt",    de: "Weiterleitung fehlgeschlagen" } },
    "ingetrokken":        { wie: "klaar",      label: { nl: "ingetrokken",           de: "zurückgezogen" } }
  };

  var TALEN = { nl: "Nederlands", de: "Deutsch" };

  function issueVelden() { return Object.keys(ISSUE); }
  function statussen() { return Object.keys(STATUS); }
  function leegIssue() {
    var o = {};
    issueVelden().forEach(function (k) {
      o[k] = ISSUE[k].type === "keuze" ? ISSUE[k].opties[ISSUE[k].opties.length - 1] : "";
    });
    return o;
  }
  function label(veld, taal) { return (ISSUE[veld].label[taal] || ISSUE[veld].label.nl); }
  function statusLabel(status, taal) {
    var s = STATUS[status];
    return s ? (s.label[taal] || s.label.nl) : status;
  }

  return { ISSUE: ISSUE, STATUS: STATUS, TALEN: TALEN, issueVelden: issueVelden, statussen: statussen, leegIssue: leegIssue, label: label, statusLabel: statusLabel };
});
