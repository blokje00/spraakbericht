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
})();
