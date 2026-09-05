/* ============================================================
   app.js — Monteursapp audio-input
   - + knop start opname (MediaRecorder)
   - stop → bevestigen, beluisteren, aanvullen
   - versturen → POST naar config.js (API_BASE + API_ROUTE)
   - originele audio wordt ALTIJD meegestuurd (base64)
   ------------------------------------------------------------
   Koppelt via config.js (window.SS_MONTEUR_CONFIG). Geen
   hardcoded URLs hier.
   ============================================================ */
(function () {
  "use strict";

  var cfg = window.SS_MONTEUR_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  var LS_NAME = "ss_monteur_naam";
  var recorder = null;
  var chunks = [];
  var blob = null;
  var startTs = 0;
  var timerInt = null;
  var busy = false;

  /* ---- View-wisselaar ---- */
  function show(viewId) {
    ["idle", "record", "confirm", "sent", "error", "account", "leaderboard"].forEach(function (v) {
      $("view-" + v).classList.toggle("hidden", v !== viewId);
    });
  }

  /* ---- Naam (localStorage) ---- */
  function laadNaam() {
    var n = localStorage.getItem(LS_NAME) || cfg.MONTEUR_NAAM || "";
    if (n) $("inp-naam").value = n;
    return n;
  }
  function opslaanNaam() {
    var n = $("inp-naam").value.trim();
    if (n) localStorage.setItem(LS_NAME, n);
    show("idle");
    // 2026-08-26: zodra de naam (opnieuw) bekend is, verificatie laden en push
    // registreren — de sectie verschijnt dan vanzelf als er wachtende memo's zijn.
    laadVerificatie();
    registreerPush();
  }

  /* ---- Timer ---- */
  function startTimer() {
    startTs = Date.now();
    timerInt = setInterval(function () {
      var s = Math.floor((Date.now() - startTs) / 1000);
      var m = Math.floor(s / 60);
      var sec = s % 60;
      $("timer").textContent =
        String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
      /* harde bovengrens om uploadgrootte te begrenzen */
      if (cfg.MAX_SECONDS && s >= cfg.MAX_SECONDS) stopOpname();
    }, 1000);
  }
  function stopTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } }

  /* ---- Opname ---- */
  function startOpname() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return fout("Deze browser ondersteunt geen audio-opname.");
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var opts = {};
      if (cfg.AUDIO_MIME && MediaRecorder.isTypeSupported(cfg.AUDIO_MIME)) {
        opts.mimeType = cfg.AUDIO_MIME;
      }
      recorder = new MediaRecorder(stream, opts);
      chunks = [];
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        $("player").src = URL.createObjectURL(blob);
        show("confirm");
      };
      recorder.start();
      show("record");
      startTimer();
    }).catch(function (err) {
      fout("Microfoon niet beschikbaar: " + (err && err.message ? err.message : "toestemming geweigerd"));
    });
  }

  function stopOpname() {
    stopTimer();
    if (recorder && recorder.state === "recording") recorder.stop();
  }

  /* ---- Upload ---- */
  async function verstuur() {
    if (busy || !blob) return;
    busy = true;
    $("btn-send").disabled = true;
    $("btn-send").textContent = "Versturen…";

    var audioBase64;
    try {
      audioBase64 = await blobToBase64(blob);
    } catch (e) {
      busy = false;
      $("btn-send").disabled = false;
      $("btn-send").textContent = "Verstuur";
      return fout("Audio kon niet worden gelezen: " + e.message);
    }

    var payload = {
      boek: cfg.BOEK_SLUG,
      monteur: laadNaam() || "onbekend",
      audio: audioBase64,
      audioType: blob.type,
      tekst: $("inp-tekst").value.trim(),
      ts: Date.now()
    };

    var url = (cfg.API_BASE || "") + (cfg.API_ROUTE || "/api/monteuridee");
    var headers = { "Content-Type": "application/json" };
    if (cfg.AUTH_TOKEN) headers["Authorization"] = "Bearer " + cfg.AUTH_TOKEN;

    fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("HTTP " + res.status + (t ? " — " + t : ""));
        });
      }
      show("sent");
    }).catch(function (err) {
      fout(err && err.message ? err.message : "Netwerkfout bij versturen");
    }).finally(function () {
      busy = false;
      $("btn-send").disabled = false;
      $("btn-send").textContent = "Verstuur";
    });
  }

  /* blob → base64 (Promise) */
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var dataUrl = fr.result;
        var idx = dataUrl.indexOf(",");
        resolve(dataUrl.slice(idx + 1));
      };
      fr.onerror = function () { reject(new Error("FileReader mislukt")); };
      fr.readAsDataURL(blob);
    });
  }

  function fout(msg) {
    $("err-text").textContent = msg;
    show("error");
  }

  /* ---- Leaderboard ---- */
  function laadLeaderboard() {
    var url = (cfg.API_BASE || "") + (cfg.LEADERBOARD_ROUTE || "/api/leaderboard");
    var headers = {};
    if (cfg.AUTH_TOKEN) headers["Authorization"] = "Bearer " + cfg.AUTH_TOKEN;
    $("leaderboard-list").textContent = "Laden…";
    show("leaderboard");
    fetch(url, { headers: headers }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      var rij = data.leaderboard || [];
      var list = $("leaderboard-list");
      if (!rij.length) {
        list.textContent = "Nog geen inzendingen.";
        return;
      }
      var eigen = laadNaam();
      list.textContent = "";
      rij.forEach(function (entry, i) {
        var row = document.createElement("div");
        row.className = "lb-row" + (i === 0 ? " top" : "") + (entry.monteur === eigen ? " me" : "");
        var rank = document.createElement("span");
        rank.className = "lb-rank";
        rank.textContent = i + 1;
        var name = document.createElement("span");
        name.className = "lb-name";
        name.textContent = entry.monteur;
        var count = document.createElement("span");
        count.className = "lb-count";
        count.textContent = entry.aantal + (entry.aantal === 1 ? " inzending" : " inzendingen");
        row.appendChild(rank);
        row.appendChild(name);
        row.appendChild(count);
        list.appendChild(row);
      });
    }).catch(function (err) {
      $("leaderboard-list").textContent = "Klassement niet beschikbaar: " + (err.message || "fout");
    });
  }

  /* ---- Verificatie (2026-08-26) ----
     Toont de door Sunshower omgezette/opgeknipte memo's die wachten op
     aanlevering van de monteur (status 'wacht-monteur'). Lege velden
     (analyse/fix e.d.) vult de monteur zelf aan en stuurt hij opnieuw in. */
  var VERIF_FIELDS = [
    { key: "model", label: "Model" },
    { key: "symptoom", label: "Symptoom" },
    { key: "analyse", label: "Analyse" },
    { key: "fix", label: "Fix" },
    { key: "controle", label: "Controle" }
  ];

  function laadVerificatie() {
    // 2026-08-26: alleen de eigen wachtende memo's ophalen (op monteur filteren).
    var naam = laadNaam();
    if (!naam) return;
    var url = (cfg.API_BASE || "") + (cfg.API_ROUTE || "/api/spraakbericht") +
      "?monteur=" + encodeURIComponent(naam);
    var headers = {};
    if (cfg.AUTH_TOKEN) headers["Authorization"] = "Bearer " + cfg.AUTH_TOKEN;
    fetch(url, { headers: headers }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      var lijst = data.spraakberichten || data || [];
      if (!Array.isArray(lijst)) lijst = [];
      // 2026-08-26: alleen items die op de monteur wachten tonen.
      var wachtend = lijst.filter(function (it) {
        return it.status === "wacht-monteur";
      });
      toonVerificatie(wachtend);
    }).catch(function () {
      // 2026-08-26: verificatie mag nooit de hele app breken; stil leeg tonen.
      toonVerificatie([]);
    });
  }

  function toonVerificatie(items) {
    var sectie = $("verificatie-sectie");
    var leeg = $("verificatie-leeg");
    var lijst = $("verificatie-lijst");
    if (!sectie || !leeg || !lijst) return;
    lijst.textContent = "";
    if (!items.length) {
      // 2026-08-26: niets wachtend → 'Geen memo's te verifiëren' tonen.
      sectie.classList.remove("hidden");
      leeg.classList.remove("hidden");
      lijst.classList.add("hidden");
      return;
    }
    leeg.classList.add("hidden");
    lijst.classList.remove("hidden");
    sectie.classList.remove("hidden");
    items.forEach(function (item) {
      lijst.appendChild(bouwVerificatieKaart(item));
    });
  }

  function bouwVerificatieKaart(item) {
    // 2026-08-26: per issue bewerkbare velden; lege velden krijgen een
    // placeholder zodat de monteur ze kan invullen (waarde via .value,
    // placeholder via .placeholder → geen HTML-escape nodig).
    var kaart = document.createElement("div");
    kaart.className = "verificatie-kaart";
    var issues = Array.isArray(item.issues) ? item.issues : [];

    issues.forEach(function (issue, i) {
      var blok = document.createElement("div");
      blok.className = "verificatie-issue";
      VERIF_FIELDS.forEach(function (f) {
        var label = document.createElement("label");
        label.className = "field-label";
        label.textContent = f.label;
        var ta = document.createElement("textarea");
        ta.rows = 2;
        ta.dataset.issue = i;
        ta.dataset.veld = f.key;
        var val = issue[f.key] || "";
        if (val) {
          ta.value = val;
        } else {
          // 2026-08-26: leeg veld → placeholder, monteur vult aan.
          ta.placeholder = "Typ hier de " + f.label.toLowerCase() + ".";
        }
        blok.appendChild(label);
        blok.appendChild(ta);
      });
      kaart.appendChild(blok);
    });

    var btn = document.createElement("button");
    btn.className = "btn primary";
    btn.textContent = "Opnieuw indienen";
    btn.addEventListener("click", function () {
      indienenVerificatie(item, kaart, btn);
    });
    kaart.appendChild(btn);
    return kaart;
  }

  function indienenVerificatie(item, kaart, btn) {
    // 2026-08-26: aangevulde issues terugsturen ter controle (PUT).
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Verzenden…";
    var issues = Array.isArray(item.issues) ? item.issues : [];
    kaart.querySelectorAll("textarea").forEach(function (ta) {
      var idx = Number(ta.dataset.issue);
      if (issues[idx]) issues[idx][ta.dataset.veld] = ta.value.trim();
    });
    var id = item.id || item._id;
    if (!id) {
      btn.disabled = false;
      btn.textContent = "Opnieuw indienen";
      return fout("Kan deze memo niet indienen: id ontbreekt.");
    }
    var url = (cfg.API_BASE || "") + (cfg.API_ROUTE || "/api/spraakbericht") +
      "/" + encodeURIComponent(id) + "/verificatie";
    var headers = { "Content-Type": "application/json" };
    if (cfg.AUTH_TOKEN) headers["Authorization"] = "Bearer " + cfg.AUTH_TOKEN;
    fetch(url, {
      method: "PUT",
      headers: headers,
      body: JSON.stringify({ issues: issues })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("HTTP " + res.status + (t ? " — " + t : ""));
        });
      }
      // 2026-08-26: bevestiging tonen, daarna sectie herladen zodat het
      // verzonden item uit de wacht-lijst verdwijnt.
      var ok = document.createElement("p");
      ok.className = "sent-text";
      ok.textContent = "Verzonden ter controle";
      kaart.textContent = "";
      kaart.appendChild(ok);
      setTimeout(laadVerificatie, 1200);
    }).catch(function (err) {
      // 2026-08-26: bij fout blijft de knop actief om opnieuw te proberen.
      btn.disabled = false;
      btn.textContent = "Opnieuw indienen";
      fout(err && err.message ? err.message : "Indienen mislukt");
    });
  }

  /* ---- Push (2026-08-26) ----
     Registreert de service worker + push-subscription zodra de monteur-naam
     bekend is, zodat de backend notificaties kan sturen bij nieuwe/gewijzigde
     memo's. VAPID public key komt uit config.js; ontbreekt die, dan is push
     uit en crasht de app niet. */
  var pushBesloten = false; // 2026-08-26: in één sessie niet opnieuw om toestemming vragen.

  function urlBase64ToUint8Array(b64) {
    var pad = "=".repeat((4 - (b64.length % 4)) % 4);
    var raw = window.atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function registreerPush() {
    // 2026-08-26: geen VAPID-key → push overslaan zonder te crashen.
    if (!cfg.VAPID_PUBLIC_KEY) return;
    if (!laadNaam()) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (!("Notification" in window)) return;
    // 2026-08-26: idempotent — in één sessie nooit opnieuw om toestemming
    // vragen (ook niet na een afwijzing).
    if (pushBesloten) return;
    if (Notification.permission === "denied") return; // definitief geweigerd
    pushBesloten = true;
    navigator.serviceWorker.register("./sw.js").then(function () {
      // 2026-08-26: alleen vragen als de gebruiker nog niet besloten heeft;
      // al 'granted' → direct door naar subscribe zonder opnieuw te vragen.
      return Notification.permission === "default"
        ? Notification.requestPermission()
        : Promise.resolve(Notification.permission);
    }).then(function (perm) {
      if (perm !== "granted") return;
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY)
        });
      }).then(function (subscription) {
        var url = (cfg.API_BASE || "") + "/api/push/subscribe";
        var headers = { "Content-Type": "application/json" };
        if (cfg.AUTH_TOKEN) headers["Authorization"] = "Bearer " + cfg.AUTH_TOKEN;
        return fetch(url, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({ monteur: laadNaam(), subscription: subscription })
        });
      });
    }).catch(function () {
      // 2026-08-26: push is optioneel; een fout mag de app niet breken.
    });
  }

  /* ---- Events ---- */
  $("btn-plus").addEventListener("click", startOpname);
  $("btn-stop").addEventListener("click", stopOpname);
  $("btn-redo").addEventListener("click", function () { blob = null; show("idle"); });
  $("btn-send").addEventListener("click", verstuur);
  $("btn-new").addEventListener("click", function () { blob = null; show("idle"); });
  $("btn-err-back").addEventListener("click", function () { show("confirm"); });
  $("btn-err-retry").addEventListener("click", verstuur);
  $("btn-account").addEventListener("click", function () { show("account"); });
  $("btn-naam-save").addEventListener("click", opslaanNaam);
  $("btn-leaderboard").addEventListener("click", laadLeaderboard);
  $("btn-lb-back").addEventListener("click", function () { show("idle"); });

  /* init */
  laadNaam();
  if (window.lucide && lucide.createIcons) lucide.createIcons();
  show("idle");
  // 2026-08-26: bij app-start direct wachtende memo's tonen en push registreren
  // (na de naam is ingesteld via localStorage/config).
  laadVerificatie();
  registreerPush();
})();
