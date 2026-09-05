/* ============================================================
   app.js — Monteursapp (herbouwd 2026-09-05)
   - inloggen met naam + persoonlijke code (token in localStorage)
   - + knop start opname (MediaRecorder) → bevestigen → versturen
   - "Mijn memo's": status van elke memo; wacht een memo op jou, dan
     open je hem en zeg je "Klopt" of "Klopt niet" (+ wat er niet klopt)
   - klassement (punten voor afgeronde memo's)
   - push-notificatie als de supervisor een memo terugstuurt
   Teksten: i18n.js (nl/de). Velden: schema.js. Instellingen: config.js.
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.SS_MONTEUR_CONFIG || {};
  var I = window.SS_I18N, S = window.SS_SCHEMA;
  var $ = function (id) { return document.getElementById(id); };
  var t = I.t;

  var LS_TOKEN = "ss_monteur_token", LS_MONTEUR = "ss_monteur", LS_TAAL = "ss_taal";
  /* elke <section class="view" id="view-…"> in index.html is een scherm */
  var views = Array.prototype.map.call(document.querySelectorAll("section.view[id^='view-']"), function (el) { return el.id.slice(5); });
  var recorder = null, chunks = [], blob = null, startTs = 0, timerInt = null, busy = false;
  var monteur = null; // {id, naam, taal}
  var mijnMemos = [];

  /* ---- API ---- */
  function api(method, pad, body) {
    var headers = { "Content-Type": "application/json" };
    var token = localStorage.getItem(LS_TOKEN);
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetch((cfg.API_BASE || "") + pad, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.text().then(function (txt) {
          var json; try { json = JSON.parse(txt); } catch (e) { json = { error: txt }; }
          if (res.status === 401 && pad.indexOf("/login") === -1) { uitloggen(); throw new Error(t("sessie_verlopen")); }
          if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
          return json;
        });
      });
  }

  /* ---- Views + taal ---- */
  function show(viewId) {
    views.forEach(function (v) { $("view-" + v).classList.toggle("hidden", v !== viewId); });
    window.scrollTo(0, 0);
  }
  function zetTaal(taal) {
    I.zetTaal(taal);
    localStorage.setItem(LS_TAAL, I.taal());
    I.pasToe(document);
    $("inp-taal").value = I.taal();
  }
  function fout(msg) { $("err-text").textContent = msg; show("error"); }
  var LOCALES = { nl: "nl-NL", de: "de-DE", fr: "fr-BE", id: "id-ID" };
  function fmtDatum(ts) { return new Date(ts).toLocaleString(LOCALES[I.taal()] || "nl-NL", { dateStyle: "short", timeStyle: "short" }); }

  /* ---- Inloggen ---- */
  function ingelogd() { return !!(localStorage.getItem(LS_TOKEN) && monteur); }
  function laadMonteur() {
    try { monteur = JSON.parse(localStorage.getItem(LS_MONTEUR) || "null"); } catch (e) { monteur = null; }
    return monteur;
  }
  /* Inloggen in twee stappen: naam kiezen uit de lijst van de supervisor →
     (al geactiveerd) pincode | (eerste keer) pincode 2x = activeren. */
  var loginStap = "naam"; // naam | code | nieuw
  var monteurLijst = [];
  function vulTalen() {
    var sel = $("inp-taal"); sel.textContent = "";
    S.talen().forEach(function (code) { var o = document.createElement("option"); o.value = code; o.textContent = S.taalNaam(code); sel.appendChild(o); });
  }
  function laadMonteurLijst() {
    var sel = $("inp-naam"); sel.textContent = "";
    var leeg = document.createElement("option"); leeg.value = ""; leeg.textContent = t("login_kies"); sel.appendChild(leeg);
    return api("GET", "/api/monteur/lijst").then(function (d) {
      monteurLijst = d.monteurs || [];
      monteurLijst.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m.naam;
        o.textContent = m.naam + (m.geactiveerd ? " ✓ " + t("login_geactiveerd") : "");
        if (m.geactiveerd) o.className = "in-gebruik";
        sel.appendChild(o);
      });
      $("login-lijst-leeg").classList.toggle("hidden", monteurLijst.length > 0);
    }).catch(function () { $("login-lijst-leeg").classList.remove("hidden"); });
  }
  function gekozenMonteur() {
    var naam = $("inp-naam").value;
    return monteurLijst.filter(function (m) { return m.naam === naam; })[0] || null;
  }
  function loginFout(msg) { $("login-fout").textContent = msg; $("login-fout").classList.toggle("hidden", !msg); }
  function toonLoginStap(stap) {
    loginStap = stap;
    $("login-stap-code").classList.toggle("hidden", stap !== "code");
    $("login-stap-nieuw").classList.toggle("hidden", stap !== "nieuw");
    $("inp-naam").disabled = stap !== "naam";
    $("inp-taal").disabled = false;
    $("btn-login-terug").classList.toggle("hidden", stap === "naam");
    $("btn-login").textContent = stap === "naam" ? t("btn_verder") : stap === "code" ? t("btn_login") : t("btn_registreer");
    loginFout("");
    var focus = stap === "code" ? "inp-code" : stap === "nieuw" ? "inp-code-nieuw" : "inp-naam";
    setTimeout(function () { $(focus).focus(); }, 50);
  }
  function pinOk(v) { return /^\d{4}$/.test(v); }
  function loginKlaar(d) {
    localStorage.setItem(LS_TOKEN, d.token);
    localStorage.setItem(LS_MONTEUR, JSON.stringify(d.monteur));
    monteur = d.monteur;
    $("inp-code").value = ""; $("inp-code-nieuw").value = ""; $("inp-code-herhaal").value = "";
    zetTaal($("inp-taal").value || d.monteur.taal);
    toonLoginStap("naam");
    naStart();
  }
  function inloggen() {
    var naam = $("inp-naam").value.trim();
    if (!naam) return loginFout(t("login_naam_leeg"));
    $("btn-login").disabled = true;
    var p;
    if (loginStap === "naam") {
      var gekozen = gekozenMonteur();
      if (gekozen && gekozen.taal && !localStorage.getItem(LS_TAAL + "_handmatig")) zetTaal(gekozen.taal);
      toonLoginStap(gekozen && gekozen.geactiveerd ? "code" : "nieuw");
      p = Promise.resolve();
    } else if (loginStap === "code") {
      var code = $("inp-code").value.trim();
      if (!pinOk(code)) { $("btn-login").disabled = false; return loginFout(t("login_pin_vorm")); }
      p = api("POST", "/api/monteur/login", { naam: naam, code: code }).then(loginKlaar).catch(function () { loginFout(t("login_fout")); });
    } else {
      var c1 = $("inp-code-nieuw").value.trim(), c2 = $("inp-code-herhaal").value.trim();
      if (!pinOk(c1)) { $("btn-login").disabled = false; return loginFout(t("login_pin_vorm")); }
      if (c1 !== c2) { $("btn-login").disabled = false; return loginFout(t("login_pin_ongelijk")); }
      p = api("POST", "/api/monteur/activeer", { naam: naam, code: c1 }).then(loginKlaar)
        .catch(function (err) { loginFout(err.message || t("login_fout")); });
    }
    p.catch(function (err) { loginFout(err.message || t("netwerkfout")); }).finally(function () { $("btn-login").disabled = false; });
  }
  function naarLogin() {
    toonLoginStap("naam");
    show("login");
    laadMonteurLijst();
  }
  function uitloggen() {
    localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_MONTEUR);
    monteur = null; mijnMemos = [];
    $("mijn-badge").classList.add("hidden");
    naarLogin();
  }

  /* ---- Timer ---- */
  function startTimer() {
    startTs = Date.now();
    timerInt = setInterval(function () {
      var s = Math.floor((Date.now() - startTs) / 1000);
      $("timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      if (cfg.MAX_SECONDS && s >= cfg.MAX_SECONDS) stopOpname();
    }, 1000);
  }
  function stopTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } }

  /* ---- Opname ---- */
  function startOpname() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fout(t("geen_audio"));
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var opts = {};
      if (cfg.AUDIO_MIME && MediaRecorder.isTypeSupported(cfg.AUDIO_MIME)) opts.mimeType = cfg.AUDIO_MIME;
      recorder = new MediaRecorder(stream, opts);
      chunks = [];
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (tr) { tr.stop(); });
        blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        $("player").src = URL.createObjectURL(blob);
        show("confirm");
      };
      recorder.start();
      show("record");
      startTimer();
    }).catch(function (err) { fout(t("mic_fout") + (err && err.message ? err.message : "")); });
  }
  function stopOpname() { stopTimer(); if (recorder && recorder.state === "recording") recorder.stop(); }

  /* ---- Versturen ---- */
  function blobToBase64(b) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result.slice(fr.result.indexOf(",") + 1)); };
      fr.onerror = function () { reject(new Error("FileReader")); };
      fr.readAsDataURL(b);
    });
  }
  function verstuur() {
    if (busy || !blob) return;
    busy = true;
    $("btn-send").disabled = true; $("btn-send").textContent = t("btn_sending");
    blobToBase64(blob).then(function (b64) {
      return api("POST", "/api/spraakbericht", { audio: b64, audioType: blob.type, tekst: $("inp-tekst").value.trim(), taal: I.taal(), ts: Date.now() });
    }).then(function () {
      blob = null; $("inp-tekst").value = "";
      show("sent");
      laadMijn();
    }).catch(function (err) { fout(err && err.message ? err.message : t("netwerkfout")); })
      .finally(function () { busy = false; $("btn-send").disabled = false; $("btn-send").textContent = t("btn_send"); });
  }

  /* ---- Klassement ---- */
  function laadLeaderboard() {
    $("leaderboard-list").textContent = t("lb_laden");
    show("leaderboard");
    api("GET", "/api/spraakbericht/leaderboard").then(function (data) {
      var rij = data.leaderboard || [], list = $("leaderboard-list");
      var prijs = data.ronde && data.ronde.prijs;
      $("lb-prijs").textContent = prijs ? t("lb_prijs") + prijs : "";
      $("lb-prijs").classList.toggle("hidden", !prijs);
      list.textContent = "";
      if (!rij.length) { list.textContent = t("lb_leeg"); return; }
      rij.forEach(function (entry, i) {
        var row = document.createElement("div");
        row.className = "lb-row" + (i === 0 ? " top" : "") + (monteur && entry.monteurId === monteur.id ? " me" : "");
        var rank = document.createElement("span"); rank.className = "lb-rank"; rank.textContent = i + 1;
        var name = document.createElement("span"); name.className = "lb-name"; name.textContent = entry.monteur;
        var count = document.createElement("span"); count.className = "lb-count";
        count.textContent = entry.punten + " " + t("lb_punten") + " · " + entry.afgerond + " " + t("lb_afgerond");
        row.appendChild(rank); row.appendChild(name); row.appendChild(count);
        list.appendChild(row);
      });
    }).catch(function (err) { $("leaderboard-list").textContent = t("lb_fout") + (err.message || ""); });
  }

  /* ---- Mijn memo's ---- */
  function laadMijn() {
    if (!ingelogd()) return Promise.resolve([]);
    return api("GET", "/api/spraakbericht/mijn").then(function (d) {
      mijnMemos = d.spraakberichten || [];
      var wacht = mijnMemos.filter(function (m) { return m.status === "wacht-monteur"; }).length;
      $("mijn-badge").textContent = wacht;
      $("mijn-badge").classList.toggle("hidden", !wacht);
      /* bolletje op het app-icoon gelijk houden met wat er echt wacht */
      if ("setAppBadge" in navigator) (wacht ? navigator.setAppBadge(wacht) : navigator.clearAppBadge()).catch(function () {});
      return mijnMemos;
    }).catch(function () { return mijnMemos; });
  }
  function toonMijn() {
    show("mijn");
    var lijst = $("mijn-lijst");
    lijst.textContent = t("lb_laden");
    laadMijn().then(function (memos) {
      lijst.textContent = "";
      if (!memos.length) { lijst.textContent = t("mijn_leeg"); return; }
      memos.forEach(function (m) {
        var row = document.createElement("button");
        row.className = "memo-row" + (m.status === "wacht-monteur" ? " wacht" : "");
        var kop = document.createElement("div"); kop.className = "memo-kop";
        var datum = document.createElement("span"); datum.textContent = fmtDatum(m.ts);
        var st = document.createElement("span"); st.className = "memo-status status-" + m.status;
        st.textContent = m.status === "wacht-monteur" ? t("mijn_wacht") : S.statusLabel(m.status, I.taal());
        kop.appendChild(datum); kop.appendChild(st);
        var txt = document.createElement("div"); txt.className = "memo-tekst";
        var eerste = m.issues && m.issues[0];
        txt.textContent = (eerste && (eerste.symptoomKlant || eerste.symptoomMonteur || eerste.apparaat)) || m.transcript || m.tekst || "…";
        row.appendChild(kop); row.appendChild(txt);
        row.addEventListener("click", function () { openVerificatie(m.id); });
        lijst.appendChild(row);
      });
    });
  }

  /* ---- Controle van één memo ---- */
  function openVerificatie(id) {
    show("verificatie");
    var box = $("verif-inhoud");
    box.textContent = t("lb_laden");
    api("GET", "/api/spraakbericht/" + encodeURIComponent(id)).then(function (m) {
      box.textContent = "";
      var taal = I.taal();
      var kanBewerken = m.status === "wacht-monteur";
      if (m.opmerkingSupervisor) {
        var opm = document.createElement("div"); opm.className = "verif-opmerking";
        var l = document.createElement("div"); l.className = "field-label"; l.textContent = t("verif_opmerking");
        var p = document.createElement("div"); p.textContent = m.opmerkingSupervisor;
        opm.appendChild(l); opm.appendChild(p); box.appendChild(opm);
      }
      if (m.transcript) {
        var tl = document.createElement("div"); tl.className = "field-label"; tl.textContent = t("verif_transcript");
        var tp = document.createElement("div"); tp.className = "verif-transcript"; tp.textContent = m.transcript;
        box.appendChild(tl); box.appendChild(tp);
      }
      var issues = (m.issues && m.issues.length) ? m.issues : [S.leegIssue()];
      issues.forEach(function (issue, i) {
        var blok = document.createElement("div"); blok.className = "verificatie-issue";
        var kop = document.createElement("div"); kop.className = "verif-issue-kop"; kop.textContent = t("verif_issue") + " " + (i + 1);
        blok.appendChild(kop);
        S.issueVelden().forEach(function (veld) {
          var def = S.ISSUE[veld];
          var label = document.createElement("label"); label.className = "field-label"; label.textContent = S.label(veld, taal);
          blok.appendChild(label);
          var el;
          if (def.type === "keuze") {
            el = document.createElement("select");
            def.opties.forEach(function (o) {
              var op = document.createElement("option"); op.value = o; op.textContent = (def.optieLabel[taal] || def.optieLabel.nl)[o]; el.appendChild(op);
            });
            el.value = issue[veld] || def.opties[def.opties.length - 1];
          } else {
            el = document.createElement("textarea"); el.rows = def.groot ? 2 : 1;
            el.value = issue[veld] || ""; el.placeholder = t("veld_leeg");
          }
          el.dataset.issue = i; el.dataset.veld = veld; el.disabled = !kanBewerken;
          blok.appendChild(el);
        });
        box.appendChild(blok);
      });
      if (!kanBewerken) {
        var st = document.createElement("p"); st.className = "sent-text"; st.textContent = S.statusLabel(m.status, taal);
        box.appendChild(st);
        return;
      }
      var opmLabel = document.createElement("label"); opmLabel.className = "field-label"; opmLabel.textContent = t("verif_klopt_niet_label");
      var opmVeld = document.createElement("textarea"); opmVeld.rows = 2; opmVeld.id = "verif-opmerking";
      var rij = document.createElement("div"); rij.className = "row";
      var btnNiet = document.createElement("button"); btnNiet.className = "btn ghost"; btnNiet.textContent = t("btn_klopt_niet");
      var btnOk = document.createElement("button"); btnOk.className = "btn primary"; btnOk.textContent = t("btn_klopt");
      var melding = document.createElement("p"); melding.className = "fout hidden";
      rij.appendChild(btnNiet); rij.appendChild(btnOk);
      box.appendChild(opmLabel); box.appendChild(opmVeld); box.appendChild(rij); box.appendChild(melding);

      function verzamel() {
        var uit = issues.map(function (it) { return Object.assign({}, it); });
        box.querySelectorAll("[data-issue]").forEach(function (el) { uit[Number(el.dataset.issue)][el.dataset.veld] = el.value.trim(); });
        return uit;
      }
      function stuur(akkoord) {
        var opmerking = opmVeld.value.trim();
        melding.classList.add("hidden");
        if (!akkoord && !opmerking) { melding.textContent = t("verif_klopt_niet_leeg"); melding.classList.remove("hidden"); return; }
        btnOk.disabled = btnNiet.disabled = true;
        api("PUT", "/api/spraakbericht/" + encodeURIComponent(id) + "/verificatie", { akkoord: akkoord, issues: verzamel(), opmerking: opmerking })
          .then(function () {
            box.textContent = "";
            var ok = document.createElement("p"); ok.className = "sent-text"; ok.textContent = akkoord ? t("verif_ok") : t("verif_klopt_niet_ok");
            box.appendChild(ok);
            laadMijn();
          }).catch(function (err) {
            btnOk.disabled = btnNiet.disabled = false;
            melding.textContent = err.message; melding.classList.remove("hidden");
          });
      }
      btnOk.addEventListener("click", function () { stuur(true); });
      btnNiet.addEventListener("click", function () { stuur(false); });
    }).catch(function (err) { box.textContent = err.message; });
  }

  /* ---- Push ---- */
  var pushBesloten = false;
  function urlBase64ToUint8Array(b64) {
    var pad = "=".repeat((4 - (b64.length % 4)) % 4);
    var raw = window.atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  /* Meldingen (push). Browsers geven alleen toestemming na een tik van de
     gebruiker; automatisch vragen bij het opstarten wordt stil genegeerd
     (Safari, iPhone). Daarom een knop. Op een iPhone werkt push alleen als
     de app op het beginscherm staat. */
  function pushKan() {
    return !!cfg.VAPID_PUBLIC_KEY && ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
  }
  function isIphoneZonderBeginscherm() {
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return ios && !window.navigator.standalone;
  }
  function aanmeldenVoorPush() {
    return navigator.serviceWorker.register("./sw.js").then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
      return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY) });
    }).then(function (subscription) { return api("POST", "/api/push/subscribe", { subscription: subscription }); });
  }
  function toonPushKnop() {
    var blok = $("push-blok"), hint = $("push-hint");
    if (!blok) return;
    var toon = ingelogd() && pushKan() && Notification.permission !== "granted";
    blok.classList.toggle("hidden", !toon);
    if (!toon) return;
    hint.textContent = Notification.permission === "denied" ? t("push_geweigerd") : isIphoneZonderBeginscherm() ? t("push_iphone") : "";
    $("btn-push").classList.toggle("hidden", Notification.permission === "denied");
  }
  function registreerPush() {
    /* stil: alleen (opnieuw) aanmelden als de toestemming er al is */
    if (!ingelogd() || !pushKan()) return;
    if (Notification.permission === "granted") aanmeldenVoorPush().catch(function () { /* optioneel */ });
    toonPushKnop();
  }
  function pushAanzetten() {
    if (!pushKan()) return;
    $("btn-push").disabled = true;
    Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") return;
      return aanmeldenVoorPush().then(function () { $("push-hint").textContent = t("push_aan"); });
    }).catch(function (err) { $("push-hint").textContent = t("push_fout") + (err && err.message ? " (" + err.message + ")" : ""); })
      .finally(function () { $("btn-push").disabled = false; toonPushKnop(); });
  }

  /* ---- Events ---- */
  $("btn-login").addEventListener("click", inloggen);
  $("btn-login-terug").addEventListener("click", function () { toonLoginStap("naam"); });
  ["inp-naam", "inp-code", "inp-code-nieuw", "inp-code-herhaal"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) { if (e.key === "Enter") inloggen(); });
  });
  $("inp-taal").addEventListener("change", function () { localStorage.setItem(LS_TAAL + "_handmatig", "1"); zetTaal($("inp-taal").value); });
  $("inp-naam").addEventListener("change", function () { var g = gekozenMonteur(); if (g && !localStorage.getItem(LS_TAAL + "_handmatig")) zetTaal(g.taal); });
  $("btn-plus").addEventListener("click", startOpname);
  $("btn-push").addEventListener("click", pushAanzetten);
  $("btn-stop").addEventListener("click", stopOpname);
  $("btn-redo").addEventListener("click", function () { blob = null; show("idle"); });
  $("btn-send").addEventListener("click", verstuur);
  $("btn-new").addEventListener("click", function () { show("idle"); });
  $("btn-err-back").addEventListener("click", function () { show(blob ? "confirm" : "idle"); });
  $("btn-err-retry").addEventListener("click", function () { if (blob) verstuur(); else show("idle"); });
  $("btn-account").addEventListener("click", function () {
    if (!ingelogd()) return naarLogin();
    $("account-naam").textContent = monteur.naam + " · " + S.taalNaam(I.taal());
    show("account");
  });
  $("btn-acc-back").addEventListener("click", function () { show("idle"); });
  $("btn-logout").addEventListener("click", uitloggen);
  $("btn-leaderboard").addEventListener("click", laadLeaderboard);
  $("btn-lb-back").addEventListener("click", function () { show("idle"); });
  $("btn-mijn").addEventListener("click", function () { if (ingelogd()) toonMijn(); else naarLogin(); });
  $("btn-mijn-back").addEventListener("click", function () { show("idle"); });
  $("btn-verif-back").addEventListener("click", toonMijn);

  /* ---- Automatisch verversen van "Mijn memo's" (rode bolletje) ----
     1. bericht van de service worker zodra er een push binnenkomt;
     2. zodra de app weer in beeld komt (telefoon ontgrendeld, tab gewisseld);
     3. elke 45 s als de app in beeld staat. Geen handmatig verversen nodig. */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (e) { if (e.data && e.data.type === "memo-update") laadMijn(); });
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) laadMijn(); });
  window.addEventListener("focus", function () { laadMijn(); });
  setInterval(function () { if (!document.hidden) laadMijn(); }, 45000);

  /* ---- Start ---- */
  function naStart() {
    show("idle");
    laadMijn().then(function () {
      var gevraagd = new URLSearchParams(location.search).get("verificatie");
      if (gevraagd) { history.replaceState(null, "", location.pathname); openVerificatie(gevraagd); }
    });
    registreerPush();
  }
  vulTalen();
  zetTaal(localStorage.getItem(LS_TAAL) || cfg.STANDAARD_TAAL || "nl");
  if (window.lucide && lucide.createIcons) lucide.createIcons();
  if (laadMonteur() && localStorage.getItem(LS_TOKEN)) {
    if (!localStorage.getItem(LS_TAAL)) zetTaal(monteur.taal);
    naStart();
  } else {
    naarLogin();
  }
})();
