/* global CSInterface, DOMPurify, JSZip, docx, mammoth */
(function () {
  "use strict";

  var EXTENSION_ID = "com.wordviewer.panel";
  var PREF_KEY = EXTENSION_ID + ".preferences.v1";
  var RECENT_LIMIT = 10;

  var DEFAULT_PREFS = {
    preserveStyling: false,
    fontFamily: "Arial",
    fontSize: 16,
    lineHeight: 1.5,
    textColor: "#1c1c1c",
    backgroundColor: "#ffffff",
    zoom: 100,
    theme: "auto",
    recentFiles: [],
    savedTemplates: [],    // [{ path, name }] persisted custom .mogrt list
    activeTemplatePath: "", // "" = bundled ZH default
    lastFilePath: ""       // auto-reload last document on reopen
  };

  var state = {
    prefs: loadPreferences(),
    currentDocument: null,
    currentFileName: "",
    currentFilePath: "",
    searchHits: [],
    currentSearchIndex: -1,
    responsiveScale: 1,
    hostSkinIsDark: true,
    csInterface: null
  };

  var els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    installSanitizerPolicy();
    initCep();
    bindEvents();
    populateFontOptions(getFallbackFonts());
    loadSystemFonts();
    try { installBundledFonts(); } catch (e) { /* never block font UI */ }
    try { enforceLicense(); } catch (e) { /* fail open if gate errors */ }
    applyPreferencesToControls();
    applyVisualPreferences();
    try { stampVersion(); } catch (e) {}
    try { wireTemplateTab(); } catch (e) {}
    renderTitleTemplate();
    renderRecentFiles();
    updateSearchControls();
    observeDocumentResize();
    if (!loadQueuedLaunchDocument()) {
      // Auto-reload the last document so reopening the panel keeps your script.
      if (state.prefs.lastFilePath) {
        try { loadFromPath(state.prefs.lastFilePath); } catch (e) {}
      }
    }
    try { checkForUpdate(); } catch (e) { /* never block the panel */ }
    try { setTimeout(function () { try { maybeAskReview(); } catch (e) {} }, 6000); } catch (e) {}
    // Live quota refresh: when the admin raises a key's minutes, the badge should
    // update without reopening the panel. Re-fetch on focus / when it becomes visible.
    try {
      window.addEventListener("focus", function () { try { refreshQuota(); } catch (e) {} });
      document.addEventListener("visibilitychange", function () { if (!document.hidden) { try { refreshQuota(); } catch (e) {} } });
    } catch (e) {}
  }

  // This panel's version — keep in sync with CSXS/manifest.xml ExtensionBundleVersion.
  var EXT_VERSION = "3.2.10";

  // API base. Normally the site directly. If the host firewall (lsrecaptcha) challenges
  // this client's IP, we transparently switch to a Cloudflare Worker relay that forwards
  // from a clean IP — so a flagged client network never blocks activation / Auto Subtitle.
  var DIRECT_BASE = "https://zhmotions.com";
  var RELAY_BASE  = "https://api-relay-2.zhmotionspanel.workers.dev";
  function apiRoot() {
    try { return localStorage.getItem("zh_use_relay") === "1" ? RELAY_BASE : DIRECT_BASE; } catch (e) { return DIRECT_BASE; }
  }
  function switchToRelay() {
    try { localStorage.setItem("zh_use_relay", "1"); } catch (e) {}
    STT_API = RELAY_BASE + "/api.php";
    LICENSE_URL = RELAY_BASE + "/api/license/verify";
  }
  // True when a server response is a bot-challenge / firewall HTML page, not our JSON.
  function isChallengeHTML(txt) {
    var t = String(txt || "");
    return /^\s*</.test(t) || /captcha|just a moment|verify you are human|cloudflare|lsrecaptcha/i.test(t);
  }

  // a > b for dotted versions like "2.0.2" vs "2.1.0".
  function versionNewer(a, b) {
    var pa = String(a || "0").split("."), pb = String(b || "0").split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i] || "0", 10) || 0, nb = parseInt(pb[i] || "0", 10) || 0;
      if (na > nb) return true;
      if (na < nb) return false;
    }
    return false;
  }

  // On launch: ask the server for the latest version. If newer, show an update banner.
  function checkForUpdate() {
    var x = new XMLHttpRequest();
    x.open("GET", apiRoot() + "/api.php?action=ss_version&_=" + Date.now(), true);
    x.timeout = 8000;
    x.onload = function () {
      try {
        var j = JSON.parse(x.responseText);
        if (j && j.status === "success" && versionNewer(j.version, EXT_VERSION)) {
          showUpdateBanner(j.version, j.url || "https://zhmotions.com/scriptstudio");
        }
      } catch (e) {}
    };
    try { x.send(); } catch (e) {}
  }

  // Yellow bar at the top of the panel: "Update available → Download". One per session.
  function showUpdateBanner(version, url) {
    if (document.getElementById("ssUpdateBar")) return;
    var bar = document.createElement("div");
    bar.id = "ssUpdateBar";
    bar.style.cssText = "display:flex;align-items:center;gap:8px;justify-content:center;" +
      "background:#ffd34d;color:#1a1300;font-weight:700;font-size:12px;padding:7px 10px;" +
      "cursor:pointer;position:relative;z-index:9999;";
    bar.textContent = "🔔 Update available (v" + version + ") — click to download";
    bar.onclick = function () { openExternal(url); };
    var close = document.createElement("span");
    close.textContent = "✕";
    close.style.cssText = "position:absolute;right:10px;opacity:0.6;cursor:pointer;";
    close.onclick = function (e) { e.stopPropagation(); bar.remove(); };
    bar.appendChild(close);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // ── In-app review prompt (after a few days of use) ──
  var REVIEW_AFTER_DAYS = 3;
  function reviewState() {
    try { return JSON.parse(localStorage.getItem("zh_ss_review") || "{}"); } catch (e) { return {}; }
  }
  function reviewSave(s) { try { localStorage.setItem("zh_ss_review", JSON.stringify(s)); } catch (e) {} }
  function maybeAskReview() {
    var lic = getStoredLicense();
    if (!lic || !lic.key) return;                  // only prompt activated users
    var s = reviewState(), now = Date.now();
    if (!s.first_run) { s.first_run = now; reviewSave(s); return; }   // start the clock
    if (s.status === "done") return;
    if (now < (s.snooze_until || 0)) return;
    if (now - s.first_run < REVIEW_AFTER_DAYS * 86400000) return;
    showReviewPrompt();
  }
  function showReviewPrompt() {
    if (document.getElementById("ssReviewModal")) return;
    var rating = 0;
    var ov = document.createElement("div");
    ov.id = "ssReviewModal";
    ov.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(10,6,4,.62);padding:18px;box-sizing:border-box;";
    ov.innerHTML =
      '<div style="background:var(--panel-bg-alt,#1c1c1c);border:1px solid var(--panel-line,#444);border-radius:14px;max-width:360px;width:100%;padding:20px;color:var(--panel-text,#eee);box-shadow:0 20px 60px rgba(0,0,0,.5);">' +
      '<div style="font-size:16px;font-weight:800;margin-bottom:4px;">Enjoying ZH Script Studio?</div>' +
      '<div style="font-size:12px;opacity:.75;margin-bottom:12px;">Tap the stars and leave a quick review — it really helps.</div>' +
      '<div id="ssRevStars" style="font-size:30px;letter-spacing:4px;color:#d9d2c4;cursor:pointer;margin-bottom:10px;user-select:none;">' +
        '<span data-v="1">★</span><span data-v="2">★</span><span data-v="3">★</span><span data-v="4">★</span><span data-v="5">★</span></div>' +
      '<input id="ssRevName" type="text" maxlength="80" placeholder="Your name" style="width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid var(--panel-line,#555);background:var(--panel-bg,#111);color:inherit;font-size:13px;margin-bottom:8px;">' +
      '<textarea id="ssRevComment" maxlength="1000" placeholder="Share what you liked (optional)" style="width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid var(--panel-line,#555);background:var(--panel-bg,#111);color:inherit;font-size:13px;min-height:64px;resize:vertical;"></textarea>' +
      '<div id="ssRevMsg" style="font-size:11px;min-height:15px;margin:6px 0;font-weight:600;"></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
        '<span id="ssRevLater" style="font-size:12px;opacity:.7;cursor:pointer;">Maybe later</span>' +
        '<span id="ssRevNever" style="font-size:12px;opacity:.7;cursor:pointer;">No thanks</span>' +
        '<button id="ssRevSend" style="margin-left:auto;background:var(--zh-gold,#d4a017);color:#1a1206;font-weight:800;border:0;border-radius:999px;padding:9px 18px;font-size:12px;cursor:pointer;">Post review</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    var starsEl = document.getElementById("ssRevStars");
    function paint() {
      var sp = starsEl.children;
      for (var i = 0; i < sp.length; i++) sp[i].style.color = (i < rating) ? "#e0a800" : "#d9d2c4";
    }
    starsEl.addEventListener("click", function (e) {
      var t = e.target; if (t && t.getAttribute("data-v")) { rating = +t.getAttribute("data-v"); paint(); }
    });
    var msg = document.getElementById("ssRevMsg");
    function close() { ov.remove(); }
    document.getElementById("ssRevLater").onclick = function () { var s = reviewState(); s.snooze_until = Date.now() + 3 * 86400000; reviewSave(s); close(); };
    document.getElementById("ssRevNever").onclick = function () { var s = reviewState(); s.status = "done"; reviewSave(s); close(); };
    document.getElementById("ssRevSend").onclick = function () {
      var name = (document.getElementById("ssRevName").value || "").trim();
      var comment = (document.getElementById("ssRevComment").value || "").trim();
      if (rating < 1) { msg.style.color = "#e0a800"; msg.textContent = "Please tap the stars to rate."; return; }
      if (name.length < 2) { msg.style.color = "#e0a800"; msg.textContent = "Please enter your name."; return; }
      msg.style.color = "#9a9"; msg.textContent = "Sending…";
      var body = "app=scriptstudio&name=" + encodeURIComponent(name) + "&rating=" + rating + "&comment=" + encodeURIComponent(comment);
      var x = new XMLHttpRequest();
      x.open("POST", apiRoot() + "/api.php?action=review_submit", true);
      x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      x.onload = function () {
        var ok = false; try { ok = JSON.parse(x.responseText).status === "success"; } catch (e) {}
        if (ok) { var s = reviewState(); s.status = "done"; reviewSave(s); msg.style.color = "#7ed957"; msg.textContent = "Thank you! ★"; setTimeout(close, 900); }
        else { msg.style.color = "#ff6b6b"; msg.textContent = "Couldn't send — check internet and retry."; }
      };
      x.onerror = function () { msg.style.color = "#ff6b6b"; msg.textContent = "Network error. Try again."; };
      try { x.send(body); } catch (e) { msg.style.color = "#ff6b6b"; msg.textContent = "Network error."; }
    };
  }

  function cacheElements() {
    els.body = document.body;
    els.openButton = document.getElementById("openButton");
    els.toolsButton = document.getElementById("toolsButton");
    els.toolsMenu = document.getElementById("toolsMenu");
    els.themeToggleInput = document.getElementById("themeToggleInput");
    els.fileInput = document.getElementById("fileInput");
    els.preserveToggle = document.getElementById("preserveToggle");
    els.fontFamilyInput = document.getElementById("fontFamilyInput");
    els.fontSizeInput = document.getElementById("fontSizeInput");
    els.fontSizeDownButton = document.getElementById("fontSizeDownButton");
    els.fontSizeUpButton = document.getElementById("fontSizeUpButton");
    els.lineHeightInput = document.getElementById("lineHeightInput");
    els.textColorInput = document.getElementById("textColorInput");
    els.backgroundColorInput = document.getElementById("backgroundColorInput");
    els.zoomInput = document.getElementById("zoomInput");
    els.zoomOutput = document.getElementById("zoomOutput");
    els.themeSelect = document.getElementById("themeSelect");
    els.searchInput = document.getElementById("searchInput");
    els.captionButton = document.getElementById("captionButton");
    els.batchButton = document.getElementById("batchButton");
    els.markerButton = document.getElementById("markerButton");
    els.templateButton = document.getElementById("templateButton");
    els.templateInput = document.getElementById("templateInput");
    els.templateName = document.getElementById("templateName");
    els.durationInput = document.getElementById("durationInput");
    els.prevSearchButton = document.getElementById("prevSearchButton");
    els.nextSearchButton = document.getElementById("nextSearchButton");
    els.searchCount = document.getElementById("searchCount");
    els.statusMessage = document.getElementById("statusMessage");
    els.documentViewport = document.getElementById("documentViewport");
    els.documentSurface = document.getElementById("documentSurface");
    els.recentFiles = document.getElementById("recentFiles");
    els.hostBadge = document.getElementById("hostBadge");
  }

  function initCep() {
    // Brand badge stays "zhmotions.com" in all hosts (don't show PPRO/AEFT version).
    if (!isCepRuntime()) {
      return;
    }

    try {
      state.csInterface = new CSInterface();
      var env = state.csInterface.getHostEnvironment();
      if (env && env.appSkinInfo) {
        state.hostSkinIsDark = isDarkSkin(env.appSkinInfo);
      }
      // Reliable host detection via CEP app id (AEFT = After Effects, PPRO = Premiere).
      try {
        var appId = (env && env.appName) || (state.csInterface.getApplicationID && state.csInterface.getApplicationID()) || "";
        state.hostIsAE = /AEFT/i.test(String(appId));
        // v3: the animation Style/Effect chips only do anything in After Effects (text
        // animators). In Premiere the title/subtitle animation comes from the MOGRT
        // template, so hide the Effect chips there (use the Templates dock instead).
        try { document.body.classList.toggle("host-ae", !!state.hostIsAE); } catch (eHb) {}
      } catch (eId) {}

      state.csInterface.addEventListener(
        CSInterface.THEME_COLOR_CHANGED_EVENT,
        function () {
          try {
            var nextEnv = state.csInterface.getHostEnvironment();
            state.hostSkinIsDark = isDarkSkin(nextEnv.appSkinInfo);
            applyTheme();
          } catch (error) {
            console.warn("Unable to refresh Adobe theme", error);
          }
        }
      );

      state.csInterface.evalScript("$.zhScriptStudio.getHostInfo()", function (result) {
        try {
          var info = JSON.parse(result);
          if (info && info.name && /after\s*effects/i.test(info.name)) {
            state.hostIsAE = true;   // confirm only — never reset the reliable appId detection
          }
        } catch (error) {
          // Host info is cosmetic only.
        }
      });
    } catch (error) {
      els.hostBadge.textContent = "CEP runtime";
      console.warn("CEP initialization warning", error);
    }
  }

  function bindEvents() {
    els.openButton.addEventListener("click", openDocument);
    var closeDocBtn = document.getElementById("closeDocButton");
    if (closeDocBtn) closeDocBtn.addEventListener("click", closeDocument);
    els.themeToggleInput.addEventListener("change", function () {
      state.prefs.theme = els.themeToggleInput.checked ? "dark" : "light";
      applyTheme();
      savePreferences();
    });
    els.toolsButton.addEventListener("click", function (event) {
      event.stopPropagation();
      setToolsMenuOpen(els.toolsMenu.hidden);
    });
    els.toolsMenu.addEventListener("click", function (event) {
      event.stopPropagation();
    });
    document.addEventListener("click", function () {
      setToolsMenuOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        setToolsMenuOpen(false);
        els.toolsButton.focus();
      }
    });
    els.fileInput.addEventListener("change", handleFileInput);

    // Drag-and-drop a script onto the panel. Without these handlers CEF treats a
    // dropped file as a navigation and loads the panel to its file URL
    // (file:///.file/id=…) → "Page failed to load / ERR_FILE_NOT_FOUND", killing
    // the panel. preventDefault stops that; then we load the file ourselves.
    document.addEventListener("dragover", function (event) {
      event.preventDefault();
      if (event.dataTransfer) { event.dataTransfer.dropEffect = "copy"; }
    });
    document.addEventListener("drop", function (event) {
      event.preventDefault();
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) { return; }
      clearStatus();
      // CEP exposes the real OS path on the dropped File → use the path loader
      // (handles .docx/.txt/.srt + all validation). Fall back to the browser reader.
      var nativePath = normalizeLocalFilePath(file.path || "");
      if (nativePath) {
        loadFromPath(nativePath);
      } else {
        handleFileInput({ target: { files: [file] } });
      }
    });

    els.fontSizeDownButton.addEventListener("click", function () {
      resizeFont(-1);
    });
    els.fontSizeUpButton.addEventListener("click", function () {
      resizeFont(1);
    });

    var preferenceInputs = [
      els.preserveToggle,
      els.fontFamilyInput,
      els.fontSizeInput,
      els.lineHeightInput,
      els.textColorInput,
      els.backgroundColorInput,
      els.zoomInput,
      els.themeSelect
    ].filter(Boolean);

    preferenceInputs.forEach(function (input) {
      input.addEventListener("input", onPreferenceInput);
      input.addEventListener("change", onPreferenceInput);
    });

    els.searchInput.addEventListener("input", function () {
      runSearch(els.searchInput.value);
    });
    els.captionButton.addEventListener("click", function () { sendToTimeline("caption"); });
    els.batchButton.addEventListener("click", function () { sendToTimeline("batch"); });
    els.markerButton.addEventListener("click", function () { sendToTimeline("marker"); });
    // Color swatches (native color input does not open inside CEP).
    var swatchWraps = document.querySelectorAll(".swatches");
    Array.prototype.forEach.call(swatchWraps, function (wrap) {
      wrap.addEventListener("click", function (event) {
        var btn = event.target.closest ? event.target.closest(".swatch") : null;
        if (!btn) return;
        event.stopPropagation();
        var targetId = wrap.getAttribute("data-swatch-target");
        var color = btn.getAttribute("data-color");
        var input = document.getElementById(targetId);
        if (input) {
          input.value = color;
          onPreferenceInput({ currentTarget: input });
        }
        // highlight active swatch
        Array.prototype.forEach.call(wrap.querySelectorAll(".swatch"), function (s) {
          s.classList.toggle("active", s === btn);
        });
      });
    });
    // Mark/colour the SELECTED text in the script.
    var selSwatches = document.querySelector(".sel-swatches");
    if (selSwatches) {
      selSwatches.addEventListener("click", function (event) {
        var btn = event.target.closest ? event.target.closest(".swatch") : null;
        if (!btn) return;
        event.stopPropagation();
        colorSelection(btn.getAttribute("data-selcolor"));
      });
    }
    // Help / Terms / License modal
    var helpBtn = document.getElementById("helpButton");
    var helpOverlay = document.getElementById("helpOverlay");
    var helpClose = document.getElementById("helpClose");
    if (helpBtn && helpOverlay) {
      helpBtn.addEventListener("click", function () {
        helpOverlay.hidden = false;
        var lic = getStoredLicense(); var cur = document.getElementById("licCurrent");
        if (cur) cur.textContent = (lic && lic.key) ? lic.key : "Not activated";
      });
      var changeKeyBtn = document.getElementById("changeKeyBtn");
      if (changeKeyBtn) changeKeyBtn.addEventListener("click", function () {
        if (!confirm("Change license key? You'll need to enter a key to use the panel again.")) return;
        clearLicense();
        helpOverlay.hidden = true;
        var inp = document.getElementById("licenseKeyInput"); if (inp) inp.value = "";
        showLicenseGate("", false);
      });
      if (helpClose) helpClose.addEventListener("click", function () { helpOverlay.hidden = true; });
      helpOverlay.addEventListener("click", function (e) { if (e.target === helpOverlay) helpOverlay.hidden = true; });
      var tabs = helpOverlay.querySelectorAll(".mtab");
      Array.prototype.forEach.call(tabs, function (tab) {
        tab.addEventListener("click", function () {
          var name = tab.getAttribute("data-tab");
          Array.prototype.forEach.call(tabs, function (t) { t.classList.toggle("active", t === tab); });
          Array.prototype.forEach.call(helpOverlay.querySelectorAll("[data-pane]"), function (p) {
            p.hidden = p.getAttribute("data-pane") !== name;
          });
        });
      });
    }
    var licBtn = document.getElementById("licenseActivateBtn");
    var licInput = document.getElementById("licenseKeyInput");
    if (licBtn) licBtn.addEventListener("click", activateLicense);
    if (licInput) licInput.addEventListener("keydown", function (e) { if (e.key === "Enter") activateLicense(); });
    var subBtn = document.getElementById("subtitleButton");
    if (subBtn) subBtn.addEventListener("click", generateSubtitles);
    // Words-per-caption + language button groups (native <select> can stick inside CEP).
    bindBtnGroup(".wpc-btn", "wordsPerCue", "data-wpc");
    bindBtnGroup(".lang-btn", "subLang", "data-lang");
    bindBtnGroup(".tl-btn", "subTranslate", "data-tl");
    function bindBtnGroup(btnSel, hiddenId, attr) {
      var btns = document.querySelectorAll(btnSel);
      Array.prototype.forEach.call(btns, function (b) {
        b.addEventListener("click", function () {
          var hid = document.getElementById(hiddenId);
          if (hid) hid.value = b.getAttribute(attr);
          Array.prototype.forEach.call(btns, function (x) { x.classList.toggle("active", x === b); });
        });
      });
    }
    var autoSubBtn = document.getElementById("autoSubButton");
    if (autoSubBtn) autoSubBtn.addEventListener("click", function () { autoSubMain("subtitle"); });
    var transcribeBtn = document.getElementById("transcribeButton");
    if (transcribeBtn) transcribeBtn.addEventListener("click", function () { autoSubMain("transcribe"); });
    // Bounce script: apply a bounce to the SELECTED After Effects text layer(s) — reusable on any
    // text, independent of the Title/Batch insert flow.
    var bncMode = document.getElementById("bncMode"), bncManual = document.getElementById("bncManual");
    if (bncMode && bncManual) bncMode.addEventListener("change", function () { bncManual.hidden = bncMode.value !== "manual"; });
    function bounceOpts() {
      var props = [];
      if (document.getElementById("bncScale") && document.getElementById("bncScale").checked) props.push("scale");
      if (document.getElementById("bncPos") && document.getElementById("bncPos").checked) props.push("position");
      if (document.getElementById("bncRot") && document.getElementById("bncRot").checked) props.push("rotation");
      if (!props.length) props = ["scale"];
      var mode = (bncMode && bncMode.value) || "auto";
      var o = { props: props, mode: mode };
      if (mode === "manual") {
        o.e = parseFloat((document.getElementById("bncElastic") || {}).value) || 0.65;
        o.g = parseFloat((document.getElementById("bncGravity") || {}).value) || 4000;
      }
      return o;
    }
    var bounceBtn = document.getElementById("bounceScriptBtn");
    if (bounceBtn) bounceBtn.addEventListener("click", function () {
      if (!state.csInterface) { showStatus("Open After Effects and select text layer(s) first.", true); return; }
      if (!state.hostIsAE) { showStatus("Bounce script is After Effects only.", true); return; }
      showStatus("Applying bounce…", false, false);
      var enc = encodeURIComponent(JSON.stringify(bounceOpts()));
      state.csInterface.evalScript("$.zhScriptStudio.bounceSelectedLayers(" + JSON.stringify(enc) + ")", function (result) {
        var response = parseHostResponse(result);
        showStatus(response.message, !response.ok, false);
      });
    });

    var animBtn = document.getElementById("animatedToggle");
    if (animBtn) animBtn.addEventListener("click", function () {
      state.animatedSubs = !state.animatedSubs;
      animBtn.classList.toggle("active", state.animatedSubs);
      animBtn.setAttribute("aria-pressed", state.animatedSubs ? "true" : "false");
      animBtn.textContent = state.animatedSubs ? "✨ Animated: On" : "✨ Animated: Off";
    });
    var audioInput = document.getElementById("audioInput");
    if (audioInput) audioInput.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) uploadAudioForSubtitle(f, f.name);
    });
    var editBtn = document.getElementById("editButton");
    var saveBtn = document.getElementById("saveButton");
    if (editBtn) editBtn.addEventListener("click", toggleEditMode);
    if (saveBtn) saveBtn.addEventListener("click", saveEdits);
    els.templateButton.addEventListener("click", chooseTitleTemplate);
    var onlineTplBtn = document.getElementById("onlineTemplateButton");
    if (onlineTplBtn) onlineTplBtn.addEventListener("click", openOnlineTemplates);
    els.templateInput.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) setTitleTemplate(normalizeLocalFilePath(f.path || ""), f.name);
    });
    els.prevSearchButton.addEventListener("click", function () {
      moveSearch(-1);
    });
    els.nextSearchButton.addEventListener("click", function () {
      moveSearch(1);
    });
  }

  function setToolsMenuOpen(isOpen) {
    els.toolsMenu.hidden = !isOpen;
    els.toolsButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (!isOpen) return;
    // Anchor the menu as a viewport-fixed card just ABOVE the ⚙ button. Using fixed
    // positioning (not absolute) makes it immune to any ancestor `overflow:hidden`
    // or stacking context — the menu always shows, even in a short/narrow CEP panel.
    try {
      var r = els.toolsButton.getBoundingClientRect();
      var m = els.toolsMenu.style;
      m.position = "fixed";
      m.top = "auto";
      m.left = "auto";
      m.right = Math.max(8, Math.round(window.innerWidth - r.right)) + "px";
      m.bottom = Math.round(window.innerHeight - r.top + 8) + "px";
      m.maxHeight = Math.max(120, Math.round(r.top - 16)) + "px";
      m.zIndex = "1000";
    } catch (e) {}
  }

  function loadPreferences() {
    try {
      var raw = localStorage.getItem(PREF_KEY);
      if (!raw) {
        return clone(DEFAULT_PREFS);
      }

      var parsed = JSON.parse(raw);
      return Object.assign(clone(DEFAULT_PREFS), parsed, {
        recentFiles: normalizeRecentFiles(parsed.recentFiles)
      });
    } catch (error) {
      console.warn("Unable to load preferences", error);
      return clone(DEFAULT_PREFS);
    }
  }

  function savePreferences() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs));
    } catch (error) {
      showStatus("Preferences could not be saved locally: " + error.message, true);
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function applyPreferencesToControls() {
    ensureFontOption(state.prefs.fontFamily);
    els.preserveToggle.checked = Boolean(state.prefs.preserveStyling);
    els.fontFamilyInput.value = state.prefs.fontFamily;
    els.fontSizeInput.value = String(state.prefs.fontSize);
    els.lineHeightInput.value = String(state.prefs.lineHeight);
    els.textColorInput.value = state.prefs.textColor;
    els.backgroundColorInput.value = state.prefs.backgroundColor;
    els.zoomInput.value = String(state.prefs.zoom);
    els.zoomOutput.value = state.prefs.zoom + "%";
    if (els.themeSelect) {
      els.themeSelect.value = state.prefs.theme;
    }
    updateThemeToggle();
  }

  function resizeFont(direction) {
    var nextSize = clampNumber(Number(els.fontSizeInput.value) + direction, 8, 96, DEFAULT_PREFS.fontSize);
    els.fontSizeInput.value = String(nextSize);
    onPreferenceInput({ currentTarget: els.fontSizeInput });
  }

  function getFallbackFonts() {
    return [
      "Hind Siliguri",
      "Noto Sans Bengali",
      "Anek Bangla",
      "Inter",
      "Poppins",
      "Arial",
      "Aptos",
      "Calibri",
      "Georgia",
      "Helvetica Neue",
      "Noto Sans Bengali",
      "Noto Serif Bengali",
      "Times New Roman",
      "Vrinda"
    ];
  }

  function populateFontOptions(fonts) {
    var selected = state.prefs.fontFamily || els.fontFamilyInput.value || DEFAULT_PREFS.fontFamily;
    var uniqueFonts = {};
    var cleaned = fonts.map(sanitizeFontFamily).filter(Boolean).filter(function (font) {
      if (uniqueFonts[font]) {
        return false;
      }
      uniqueFonts[font] = true;
      return true;
    }).sort(function (a, b) {
      return a.localeCompare(b);
    });

    els.fontFamilyInput.innerHTML = "";
    cleaned.forEach(function (font) {
      var option = document.createElement("option");
      option.value = font;
      option.textContent = font;
      els.fontFamilyInput.appendChild(option);
    });
    ensureFontOption(selected);
    els.fontFamilyInput.value = selected;
  }

  function ensureFontOption(font) {
    var value = sanitizeFontFamily(font);
    if (!value) {
      return;
    }

    for (var index = 0; index < els.fontFamilyInput.options.length; index += 1) {
      if (els.fontFamilyInput.options[index].value === value) {
        return;
      }
    }

    var option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    els.fontFamilyInput.insertBefore(option, els.fontFamilyInput.firstChild);
  }

  function loadSystemFonts() {
    var nodeRequire = getNodeRequire();
    if (!nodeRequire) {
      return;
    }

    // 1) FAST: scan the macOS font folders right now (instant, reliable).
    try {
      var dirFonts = scanFontDirectories(nodeRequire);
      if (dirFonts.length) populateFontOptions(getFallbackFonts().concat(dirFonts));
    } catch (e) {}

    // 2) ACCURATE: system_profiler gives true family names — refine when ready.
    try {
      var childProcess = nodeRequire("child_process");
      childProcess.execFile("/usr/sbin/system_profiler", ["SPFontsDataType", "-json"], {
        maxBuffer: 1024 * 1024 * 128
      }, function (error, stdout) {
        if (error || !stdout) {
          console.warn("system_profiler fonts unavailable, using folder scan", error);
          return;
        }
        try {
          var fonts = extractFontFamiliesFromProfiler(JSON.parse(stdout));
          if (fonts.length) populateFontOptions(getFallbackFonts().concat(fonts));
        } catch (parseError) {
          console.warn("Unable to parse system fonts", parseError);
        }
      });
    } catch (error) {
      console.warn("Unable to load system fonts", error);
    }
  }

  // Auto-install the bundled free Google fonts (Bengali + English) so timeline text
  // renders everywhere — no manual font install. macOS: ~/Library/Fonts (no admin).
  function installBundledFonts() {
    var nr = getNodeRequire();
    if (!nr || !state.csInterface) return;
    try {
      var fs = nr("fs"), path = nr("path"), os = nr("os");
      var ext = state.csInterface.getSystemPath(SystemPath.EXTENSION);
      var srcDir = path.join(ext, "client", "assets", "fonts");
      if (!fs.existsSync(srcDir)) srcDir = path.join(ext, "assets", "fonts");
      if (!fs.existsSync(srcDir)) return;

      var destDir, isWin = false;
      try { isWin = (nr("os").platform() === "win32"); } catch (e) {}
      if (isWin) {
        var la = (typeof process !== "undefined" && process.env && process.env.LOCALAPPDATA) || path.join(os.homedir(), "AppData", "Local");
        destDir = path.join(la, "Microsoft", "Windows", "Fonts");
      } else {
        destDir = path.join(os.homedir(), "Library", "Fonts");
      }
      try { if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true }); } catch (e) {}

      var installed = 0;
      fs.readdirSync(srcDir).forEach(function (f) {
        if (/\.(ttf|otf)$/i.test(f)) {
          var dest = path.join(destDir, f);
          if (!fs.existsSync(dest)) {
            try { fs.copyFileSync(path.join(srcDir, f), dest); installed += 1; } catch (e) {}
          }
        }
      });
      if (installed) console.log("ZH Script Studio installed " + installed + " bundled fonts to " + destDir);
    } catch (e) {
      console.warn("Bundled font install skipped:", e);
    }
  }

  // ─────────────── LICENSE GATE ───────────────
  var LICENSE_URL = apiRoot() + "/api/license/verify";
  var LICENSE_APP = "scriptstudio";

  function getDeviceId() {
    try {
      var stored = localStorage.getItem("zh_device_id");
      if (stored) return stored;
      var id = "web-" + Math.random().toString(36).slice(2, 14);
      var nr = getNodeRequire();
      if (nr) {
        var os = nr("os"), crypto = nr("crypto");
        var info = "";
        try { info = (os.userInfo().username || ""); } catch (e) {}
        var seed = os.hostname() + "|" + os.platform() + "|" + os.arch() + "|" + info;
        id = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
      }
      localStorage.setItem("zh_device_id", id);
      return id;
    } catch (e) { return "device-unknown"; }
  }

  // Persistent license file — OUTSIDE the CEP cache, so a cache cleaner (which wipes
  // ~/Library/Caches where CEP's localStorage lives) can't erase the activation.
  function licenseFilePath() {
    try {
      var nr = getNodeRequire(); if (!nr) return "";
      var os = nr("os"), path = nr("path"), fs = nr("fs");
      var dir = path.join(os.homedir(), "Library", "Application Support", "ZH Script Studio");
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      return path.join(dir, "license.json");
    } catch (e) { return ""; }
  }
  function readLicenseFile() {
    try { var nr = getNodeRequire(); var p = licenseFilePath(); if (nr && p && nr("fs").existsSync(p)) return JSON.parse(nr("fs").readFileSync(p, "utf8")); } catch (e) {}
    return null;
  }
  function writeLicenseFile(obj) {
    try { var nr = getNodeRequire(); var p = licenseFilePath(); if (nr && p) nr("fs").writeFileSync(p, JSON.stringify(obj)); } catch (e) {}
  }

  function getStoredLicense() {
    // 1) localStorage (fast). 2) if wiped by a cache cleaner, restore from the persistent file.
    try {
      var ls = JSON.parse(localStorage.getItem("zh_license") || "null");
      if (ls && ls.key) return ls;
    } catch (e) {}
    var f = readLicenseFile();
    if (f && f.key) { try { localStorage.setItem("zh_license", JSON.stringify(f)); } catch (e) {} return f; }
    return null;
  }
  function storeLicense(key, plan) {
    var obj = { key: key, plan: plan || "pro", at: Date.now() };
    try { localStorage.setItem("zh_license", JSON.stringify(obj)); } catch (e) {}
    writeLicenseFile(obj);   // survives cache cleaning
  }
  function clearLicense() {
    try { localStorage.removeItem("zh_license"); } catch (e) {}
    try { var nr = getNodeRequire(); var p = licenseFilePath(); if (nr && p && nr("fs").existsSync(p)) nr("fs").unlinkSync(p); } catch (e) {}
  }

  function verifyLicense(key, cb, _tries) {
    _tries = _tries || 0;
    var body = "key=" + encodeURIComponent(key) + "&app=" + LICENSE_APP +
      "&device=" + encodeURIComponent(getDeviceId()) + "&v=2.0";
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", LICENSE_URL, true);
      xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      xhr.timeout = 15000;
      xhr.onload = function () {
        try { cb(JSON.parse(xhr.responseText)); }
        catch (e) {
          // Non-JSON = host firewall bot-challenge (HTML). Switch to the Worker relay
          // (clean IP) and retry, so a flagged client can still activate.
          if (isChallengeHTML(xhr.responseText) && _tries < 1) { switchToRelay(); }
          if (_tries < 3) { setTimeout(function () { verifyLicense(key, cb, _tries + 1); }, 1500); return; }
          cb({ valid: false, message: "Server is busy — please try Activate again in a moment." });
        }
      };
      xhr.onerror = function () { cb({ valid: false, message: "No internet connection — connect once to activate.", offline: true }); };
      xhr.ontimeout = function () { cb({ valid: false, message: "Server timed out. Please try again.", offline: true }); };
      xhr.send(body);
    } catch (e) { cb({ valid: false, message: "Activation failed: " + e.message }); }
  }

  function showLicenseGate(msg, isError) {
    var gate = document.getElementById("licenseGate");
    if (gate) gate.hidden = false;
    var m = document.getElementById("licenseMsg");
    if (m && typeof msg === "string") { m.textContent = msg; m.classList.toggle("error", !!isError); }
  }
  function hideLicenseGate() {
    var gate = document.getElementById("licenseGate");
    if (gate) gate.hidden = true;
  }

  // Called on startup: block the panel until a valid key is stored/verified.
  function enforceLicense() {
    var lic = getStoredLicense();
    if (lic && lic.key) {
      hideLicenseGate(); // already activated — allow use immediately
      try { refreshQuota(); } catch (e) {}
      // silent re-check; only revoke on a definitive negative (not offline)
      verifyLicense(lic.key, function (res) {
        if (res && res.valid === false && !res.offline) {
          clearLicense();
          showLicenseGate(res.message || "License is no longer valid.", true);
        }
      });
      return;
    }
    showLicenseGate("", false);
  }

  function activateLicense() {
    var input = document.getElementById("licenseKeyInput");
    var btn = document.getElementById("licenseActivateBtn");
    var key = (input && input.value || "").trim();
    if (!key) { showLicenseGate("Enter your license key.", true); return; }
    if (btn) { btn.disabled = true; btn.textContent = "Activating…"; }
    showLicenseGate("Checking your key…", false);
    verifyLicense(key, function (res) {
      if (btn) { btn.disabled = false; btn.textContent = "Activate"; }
      if (res && res.valid) {
        storeLicense(key, res.plan);
        try { refreshQuota(); } catch (e) {}
        hideLicenseGate();
      } else {
        showLicenseGate((res && res.message) || "Invalid license key.", true);
      }
    });
  }

  // Read installed font files and derive usable family names (fast path).
  function scanFontDirectories(nodeRequire) {
    var fs = nodeRequire("fs");
    var path = nodeRequire("path");
    var os = nodeRequire("os");
    var dirs = [
      "/System/Library/Fonts",
      "/System/Library/Fonts/Supplemental",
      "/Library/Fonts",
      path.join(os.homedir(), "Library", "Fonts")
    ];
    var names = {};
    dirs.forEach(function (dir) {
      try {
        fs.readdirSync(dir).forEach(function (file) {
          if (/\.(ttf|otf|ttc)$/i.test(file)) {
            var n = prettyFontName(file.replace(/\.(ttf|otf|ttc)$/i, ""));
            if (n && n.length > 1) names[n] = true;
          }
        });
      } catch (e) {}
    });
    return Object.keys(names);
  }

  function prettyFontName(base) {
    base = base.replace(/[-_]+/g, " ");
    base = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    base = base.replace(/\b(Regular|Bold|Italic|Light|Medium|Thin|Heavy|Black|Semibold|SemiBold|Demibold|Extrabold|ExtraBold|Oblique|Condensed|Narrow|MT|PS|PSMT|VF)\b/gi, "");
    base = base.replace(/\s{2,}/g, " ").trim();
    return base;
  }

  function extractFontFamiliesFromProfiler(profile) {
    var fonts = {};
    var items = profile && profile.SPFontsDataType ? profile.SPFontsDataType : [];
    items.forEach(function (item) {
      (item.typefaces || []).forEach(function (typeface) {
        if (typeface && typeface.family && typeface.enabled !== "no") {
          fonts[typeface.family] = true;
        }
      });
    });
    return Object.keys(fonts);
  }

  function observeDocumentResize() {
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(function () {
        updateResponsiveDocumentScale();
      });
      observer.observe(els.documentViewport);
      return;
    }

    window.addEventListener("resize", updateResponsiveDocumentScale);
  }

  function loadQueuedLaunchDocument() {
    var nodeRequire = getNodeRequire();
    if (!nodeRequire) {
      return false;
    }

    try {
      var fs = nodeRequire("fs");
      var queuePath = getLaunchQueuePath(nodeRequire);
      if (!queuePath || !fs.existsSync(queuePath)) {
        return false;
      }

      var filePath = normalizeLocalFilePath(fs.readFileSync(queuePath, "utf8").trim());
      fs.unlinkSync(queuePath);
      if (filePath) {
        window.setTimeout(function () {
          loadFromPath(filePath);
        }, 250);
        return true;
      }
    } catch (error) {
      console.warn("Unable to load queued launch document", error);
    }
    return false;
  }

  function getLaunchQueuePath(nodeRequire) {
    var os = nodeRequire("os");
    var pathModule = nodeRequire("path");
    var baseDir;

    if (os.platform && os.platform() === "win32") {
      baseDir = typeof process !== "undefined" && process.env && process.env.APPDATA ?
        process.env.APPDATA :
        pathModule.join(os.homedir(), "AppData", "Roaming");
    } else {
      baseDir = pathModule.join(os.homedir(), "Library", "Application Support");
    }

    return pathModule.join(baseDir, "Word Viewer Panel", "open-on-launch.txt");
  }

  function onPreferenceInput(event) {
    var target = event.currentTarget;
    if (target === els.preserveToggle) {
      state.prefs.preserveStyling = els.preserveToggle.checked;
      savePreferences();
      rerenderCurrentDocument();
      return;
    }

    state.prefs.fontFamily = sanitizeFontFamily(els.fontFamilyInput.value);
    state.prefs.fontSize = clampNumber(els.fontSizeInput.value, 8, 96, DEFAULT_PREFS.fontSize);
    state.prefs.lineHeight = clampNumber(els.lineHeightInput.value, 1, 3, DEFAULT_PREFS.lineHeight);
    state.prefs.textColor = normalizeColor(els.textColorInput.value, DEFAULT_PREFS.textColor);
    state.prefs.backgroundColor = normalizeColor(els.backgroundColorInput.value, DEFAULT_PREFS.backgroundColor);
    state.prefs.zoom = clampNumber(els.zoomInput.value, 50, 250, DEFAULT_PREFS.zoom);
    if (els.themeSelect) {
      state.prefs.theme = ["auto", "dark", "light"].indexOf(els.themeSelect.value) >= 0 ? els.themeSelect.value : state.prefs.theme;
    }

    els.zoomOutput.value = state.prefs.zoom + "%";
    applyVisualPreferences();
    updateResponsiveDocumentScale();
    savePreferences();

    if (els.themeSelect && target === els.themeSelect) {
      applyTheme();
    }
  }

  function applyVisualPreferences() {
    var root = document.documentElement;
    root.style.setProperty("--reader-font", quoteFontFamily(state.prefs.fontFamily));
    root.style.setProperty("--reader-size", state.prefs.fontSize + "px");
    root.style.setProperty("--reader-line", String(state.prefs.lineHeight));
    root.style.setProperty("--doc-bg", state.prefs.backgroundColor);
    root.style.setProperty("--doc-fg", state.prefs.textColor);
    setDocumentZoom();
    applyTheme();
  }

  function applyTheme() {
    var dark = getEffectiveDarkTheme();
    els.body.classList.toggle("theme-light", !dark);
    els.body.classList.toggle("theme-dark", dark);
    updateThemeToggle();
  }

  function getEffectiveDarkTheme() {
    var theme = state.prefs.theme;
    return theme === "dark" || (theme === "auto" && state.hostSkinIsDark);
  }

  function updateThemeToggle() {
    if (els.themeToggleInput) {
      els.themeToggleInput.checked = getEffectiveDarkTheme();
      els.themeToggleInput.setAttribute("aria-checked", getEffectiveDarkTheme() ? "true" : "false");
    }
  }

  function setDocumentZoom() {
    var zoom = (state.prefs.zoom / 100) * state.responsiveScale;
    document.documentElement.style.setProperty("--doc-zoom", String(zoom));
  }

  function updateResponsiveDocumentScale() {
    var nextScale = 1;

    if (
      state.currentDocument &&
      state.prefs.preserveStyling &&
      els.documentSurface.classList.contains("preserved-mode")
    ) {
      var page = els.documentSurface.querySelector("section.docx");
      var viewportWidth = els.documentViewport.clientWidth || 0;
      var currentZoom = (state.prefs.zoom / 100) * state.responsiveScale;

      if (page && viewportWidth && currentZoom > 0) {
        var renderedWidth = page.getBoundingClientRect().width;
        var naturalWidth = renderedWidth / currentZoom;
        var availableWidth = Math.max(220, viewportWidth - 24);
        var userZoom = state.prefs.zoom / 100;
        nextScale = Math.min(1, availableWidth / (naturalWidth * userZoom));
        nextScale = Math.max(0.4, nextScale);
      }
    }

    state.responsiveScale = Number.isFinite(nextScale) ? nextScale : 1;
    setDocumentZoom();
  }

  function isDarkSkin(skinInfo) {
    var color = skinInfo && skinInfo.panelBackgroundColor && skinInfo.panelBackgroundColor.color;
    if (!color) {
      return true;
    }

    var red = normalizeChannel(color.red);
    var green = normalizeChannel(color.green);
    var blue = normalizeChannel(color.blue);
    var luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return luminance < 145;
  }

  function normalizeChannel(channel) {
    var value = Number(channel);
    if (value <= 1) {
      return value * 255;
    }
    return value;
  }

  // Close the current script + stop it auto-opening in every project.
  function closeDocument() {
    state.currentFilePath = "";
    state.currentFileName = "";
    state.currentDocument = null;
    state.prefs.lastFilePath = "";
    savePreferences();
    state.editing = false;
    els.documentSurface.setAttribute("contenteditable", "false");
    els.documentSurface.className = "document-surface empty-state";
    els.documentSurface.innerHTML =
      '<p>Tap <strong>＋ New</strong> to open a <strong>.docx</strong>, <strong>.txt</strong> or <strong>.srt</strong> script. Select text, then send it to your timeline.</p>' +
      '<div id="recentFiles" class="recent-files"></div>';
    els.recentFiles = document.getElementById("recentFiles");
    state.searchHits = [];
    renderRecentFiles();
    updateSearchControls();
    showStatus("Script closed. It won't auto-open anymore.", false, true);
  }

  function openDocument() {
    clearStatus();

    var cepPath = chooseFileWithCep();
    if (cepPath) {
      loadFromPath(cepPath);
      return;
    }

    els.fileInput.value = "";
    els.fileInput.click();
  }

  function chooseFileWithCep() {
    if (!window.cep || !window.cep.fs || typeof window.cep.fs.showOpenDialog !== "function") {
      return "";
    }

    try {
      var result = window.cep.fs.showOpenDialog(false, false, "Open script (.docx, .txt, .srt)", "", ["docx", "txt", "srt"]);
      if (result && result.err === 0 && result.data && result.data.length) {
        return result.data[0];
      }
    } catch (error) {
      console.warn("CEP open dialog failed, using HTML file picker", error);
    }

    return "";
  }

  function handleFileInput(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    if (isWordLockFile(file.name)) {
      showWordLockFileError();
      return;
    }

    if (hasExtension(file.name, ".doc") && !hasExtension(file.name, ".docx")) {
      showUnsupportedDocError();
      return;
    }

    // Plain text + subtitles open directly.
    if (hasExtension(file.name, ".txt") || hasExtension(file.name, ".srt")) {
      readBrowserFileText(file)
        .then(function (text) {
          renderPlainText(text, file.name, normalizeLocalFilePath(file.path || ""), hasExtension(file.name, ".srt"));
        })
        .catch(function (error) { showStatus("Could not read this file: " + error.message, true); });
      return;
    }

    if (!hasExtension(file.name, ".docx")) {
      showStatus("Open a .docx, .txt, or .srt file.", true);
      return;
    }

    readBrowserFile(file)
      .then(function (arrayBuffer) {
        return renderDocument({
          arrayBuffer: arrayBuffer,
          name: file.name,
          path: normalizeLocalFilePath(file.path || ""),
          source: "file"
        });
      })
      .catch(function (error) {
        showStatus("Could not read this file: " + error.message, true);
      });
  }

  function loadFromPath(filePath) {
    filePath = normalizeLocalFilePath(filePath);

    if (isWordLockFile(filePath)) {
      showWordLockFileError();
      return;
    }

    if (hasExtension(filePath, ".doc") && !hasExtension(filePath, ".docx")) {
      showUnsupportedDocError();
      return;
    }

    if (hasExtension(filePath, ".txt") || hasExtension(filePath, ".srt")) {
      try {
        var txt = readLocalTextFile(filePath);
        renderPlainText(txt, basename(filePath), filePath, hasExtension(filePath, ".srt"));
      } catch (e) { showStatus("Could not read this file: " + e.message, true); }
      return;
    }

    if (!hasExtension(filePath, ".docx")) {
      showStatus("Open a .docx, .txt, or .srt file.", true);
      return;
    }

    try {
      var arrayBuffer = readLocalBinaryFile(filePath);
      renderDocument({
        arrayBuffer: arrayBuffer,
        name: basename(filePath),
        path: filePath,
        source: "path"
      });
    } catch (error) {
      showStatus("Could not read this file: " + error.message, true);
    }
  }

  function readBrowserFile(file) {
    if (file && typeof file.arrayBuffer === "function") {
      return file.arrayBuffer();
    }

    return new Promise(function (resolve, reject) {
      if (window.FileReader) {
        var reader = new FileReader();
        reader.onload = function () {
          resolve(reader.result);
        };
        reader.onerror = function () {
          reject(reader.error || new Error("Browser file reader failed."));
        };
        reader.readAsArrayBuffer(file);
        return;
      }

      var filePath = normalizeLocalFilePath(file && file.path);
      if (filePath) {
        try {
          resolve(readLocalBinaryFile(filePath));
        } catch (error) {
          reject(error);
        }
        return;
      }

      reject(new Error("This Adobe panel cannot access the selected file."));
    });
  }

  function readLocalBinaryFile(filePath) {
    filePath = normalizeLocalFilePath(filePath);

    var nodeRequire = getNodeRequire();
    if (nodeRequire) {
      var fs = nodeRequire("fs");
      var buffer = fs.readFileSync(filePath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }

    if (window.cep && window.cep.fs && typeof window.cep.fs.readFile === "function") {
      var encoding = window.cep.encoding && window.cep.encoding.Base64;
      var result = window.cep.fs.readFile(filePath, encoding);
      if (result.err !== 0) {
        throw new Error("CEP file API returned error " + result.err + ".");
      }
      return base64ToArrayBuffer(result.data);
    }

    throw new Error("Local file system access is unavailable in this runtime.");
  }

  function readBrowserFileText(file) {
    return new Promise(function (resolve, reject) {
      if (window.FileReader) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || "")); };
        reader.onerror = function () { reject(reader.error || new Error("File reader failed.")); };
        reader.readAsText(file, "UTF-8");
        return;
      }
      var p = normalizeLocalFilePath(file && file.path);
      if (p) { try { resolve(readLocalTextFile(p)); } catch (e) { reject(e); } return; }
      reject(new Error("Cannot read this file."));
    });
  }

  function readLocalTextFile(filePath) {
    filePath = normalizeLocalFilePath(filePath);
    var nodeRequire = getNodeRequire();
    if (nodeRequire) {
      return String(nodeRequire("fs").readFileSync(filePath, "utf8"));
    }
    if (window.cep && window.cep.fs && typeof window.cep.fs.readFile === "function") {
      var result = window.cep.fs.readFile(filePath, window.cep.encoding && window.cep.encoding.UTF8);
      if (result.err !== 0) throw new Error("CEP file API error " + result.err + ".");
      return String(result.data || "");
    }
    throw new Error("Local file access unavailable.");
  }

  // Render a .txt / .srt file as clean reading-mode text (SRT: drop indices + timecodes).
  function renderPlainText(text, name, filePath, isSrt) {
    var clean = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (window.zhBijoyOn && window.zhBijoyOn() && window.ZHBijoy) { clean = window.ZHBijoy.toUnicode(clean); }
    // Keep the RAW srt (timecodes intact) so "From script" places captions on the REAL voice timing
    // instead of a reading-speed estimate. Cleared for non-srt files.
    state.srtRaw = isSrt ? clean : "";
    if (isSrt) {
      clean = clean
        .replace(/^\s*\d+\s*$/gm, "")                                   // cue numbers
        .replace(/^\s*[\d:,]+\s*-->\s*[\d:,]+.*$/gm, "")                // timecodes
        .replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
    }
    var paras = clean.split(/\n{2,}/).map(function (p) {
      return "<p>" + escapeHtml(p).replace(/\n/g, "<br>") + "</p>";
    }).join("");
    els.documentSurface.className = "document-surface reading-mode";
    els.documentSurface.innerHTML = '<div class="reading-wrapper">' + (paras || "<p>(empty)</p>") + "</div>";
    state.currentFileName = name;
    state.currentFilePath = filePath || "";
    state.prefs.lastFilePath = filePath || "";
    if (filePath) addRecentFile(filePath, name);
    savePreferences();
    applyVisualPreferences();
    updateSearchControls();
    showStatus("Loaded " + name, false, true);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function getNodeRequire() {
    try {
      if (window.cep_node && typeof window.cep_node.require === "function") {
        return window.cep_node.require;
      }
      if (typeof window.require === "function") {
        return window.require;
      }
      if (typeof require === "function") {
        return require;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  async function renderDocument(docInfo) {
    clearStatus();
    clearSearch();
    setBusy(true);

    try {
      if (isWordLockFile(docInfo.name || docInfo.path)) {
        throw new Error("This is a temporary Word lock file. Select the real .docx file, not the ~$ file.");
      }
      validateDocxPackage(docInfo.arrayBuffer);
      state.currentDocument = docInfo.arrayBuffer.slice(0);
      state.currentFileName = docInfo.name;
      state.currentFilePath = docInfo.path || "";
      if (docInfo.path) { state.prefs.lastFilePath = docInfo.path; savePreferences(); }

      els.documentSurface.className = "document-surface";
      els.documentSurface.innerHTML = "";

      if (state.prefs.preserveStyling) {
        await renderPreservedDocx(state.currentDocument);
      } else {
        await renderReadingMode(state.currentDocument);
      }

      if (docInfo.path) {
        addRecentFile(docInfo.path, docInfo.name);
      }

      updateResponsiveDocumentScale();
      showStatus("Loaded " + docInfo.name, false, true);
      runSearch(els.searchInput.value);
    } catch (error) {
      state.currentDocument = null;
      state.currentFileName = "";
      state.currentFilePath = "";
      showStatus(formatRenderError(error), true);
      showEmptyState("This document could not be displayed.");
    } finally {
      setBusy(false);
    }
  }

  async function rerenderCurrentDocument() {
    if (!state.currentDocument) {
      return;
    }

    await renderDocument({
      arrayBuffer: state.currentDocument.slice(0),
      name: state.currentFileName,
      path: state.currentFilePath,
      source: "memory"
    });
  }

  async function renderPreservedDocx(arrayBuffer) {
    if (!window.JSZip) {
      throw new Error("The bundled JSZip dependency is missing.");
    }

    if (!window.docx || typeof docx.renderAsync !== "function") {
      throw new Error("The bundled docx-preview renderer is missing.");
    }

    els.documentSurface.classList.add("preserved-mode");

    await docx.renderAsync(arrayBuffer.slice(0), els.documentSurface, null, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      experimental: true,
      useBase64URL: true,
      renderChanges: false,
      renderHeaders: true,
      renderFooters: true
    });

    sanitizeNode(els.documentSurface);
    updateResponsiveDocumentScale();
  }

  async function renderReadingMode(arrayBuffer) {
    if (!window.mammoth || typeof mammoth.convertToHtml !== "function") {
      throw new Error("The bundled mammoth.js renderer is missing.");
    }

    els.documentSurface.classList.add("reading-mode");

    var result = await mammoth.convertToHtml(
      { arrayBuffer: arrayBuffer.slice(0) },
      {
        convertImage: mammoth.images.imgElement(function (image) {
          return image.read("base64").then(function (imageBuffer) {
            return {
              src: "data:" + image.contentType + ";base64," + imageBuffer
            };
          });
        })
      }
    );

    var wrapper = document.createElement("div");
    wrapper.className = "reading-wrapper";
    wrapper.innerHTML = sanitizeHtml(result.value || "");
    scrubCssUrls(wrapper);
    els.documentSurface.appendChild(wrapper);

    if (result.messages && result.messages.length) {
      console.info("mammoth.js messages", result.messages);
    }
    updateResponsiveDocumentScale();
  }

  function validateDocxPackage(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 8) {
      throw new Error("The file is empty or incomplete.");
    }

    var bytes = new Uint8Array(arrayBuffer, 0, 4);
    var isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (!isZip) {
      throw new Error("This file is not a valid .docx package.");
    }
  }

  function showUnsupportedDocError() {
    showStatus("Please convert this .doc file to .docx.", true);
  }

  function showWordLockFileError() {
    showStatus("This is a temporary Word lock file. Select the real .docx file, not the ~$ file.", true);
  }

  function formatRenderError(error) {
    var message = error && error.message ? error.message : String(error);
    if (/end of central directory|zip|package|corrupt|invalid/i.test(message)) {
      return "Unsupported or corrupt .docx file. " + message;
    }
    return message;
  }

  function installSanitizerPolicy() {
    if (!window.DOMPurify) {
      console.warn("DOMPurify is unavailable.");
      return;
    }

    DOMPurify.addHook("afterSanitizeAttributes", function (node) {
      stripUnsafeUrl(node, "href", false);
      stripUnsafeUrl(node, "src", true);

      if (node.hasAttribute && node.hasAttribute("target")) {
        node.setAttribute("rel", "noopener noreferrer");
      }

      Array.prototype.slice.call(node.attributes || []).forEach(function (attribute) {
        if (/^on/i.test(attribute.name)) {
          node.removeAttribute(attribute.name);
        }
      });
    });
  }

  function sanitizeNode(node) {
    node.innerHTML = sanitizeHtml(node.innerHTML);
    scrubCssUrls(node);
  }

  function sanitizeHtml(html) {
    if (!window.DOMPurify) {
      return "";
    }

    return DOMPurify.sanitize(html, {
      ADD_TAGS: ["style"],
      ADD_ATTR: ["style", "target"],
      FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "base"],
      FORBID_ATTR: ["srcdoc"],
      ALLOW_DATA_ATTR: false
    });
  }

  function stripUnsafeUrl(node, attributeName, imageOnly) {
    if (!node.hasAttribute || !node.hasAttribute(attributeName)) {
      return;
    }

    var value = (node.getAttribute(attributeName) || "").trim();
    var lower = value.toLowerCase();
    var isSafeImage = imageOnly && (/^data:image\//.test(lower) || /^blob:/.test(lower));
    var isSafeAnchor = !imageOnly && lower.charAt(0) === "#";

    if (!isSafeImage && !isSafeAnchor) {
      node.removeAttribute(attributeName);
    }
  }

  function addRecentFile(filePath, name) {
    var normalizedPath = normalizeLocalFilePath(filePath);
    var displayName = name || basename(normalizedPath);
    var nextKey = recentFileKey(normalizedPath, displayName);
    var recent = normalizeRecentFiles(state.prefs.recentFiles).filter(function (item) {
      return recentFileKey(item.path, item.name) !== nextKey;
    });

    recent.unshift({
      path: normalizedPath,
      name: displayName,
      openedAt: new Date().toISOString()
    });

    state.prefs.recentFiles = recent.slice(0, RECENT_LIMIT);
    savePreferences();
    renderRecentFiles();
  }

  function renderRecentFiles() {
    els.recentFiles.innerHTML = "";
    var normalizedRecent = normalizeRecentFiles(state.prefs.recentFiles);
    if (JSON.stringify(normalizedRecent) !== JSON.stringify(state.prefs.recentFiles)) {
      state.prefs.recentFiles = normalizedRecent;
      savePreferences();
    }

    if (!normalizedRecent.length) {
      var empty = document.createElement("div");
      empty.className = "recent-empty";
      empty.textContent = "No recent files";
      els.recentFiles.appendChild(empty);
      return;
    }

    var head = document.createElement("div");
    head.className = "recent-head";
    var lbl = document.createElement("span"); lbl.textContent = "Recent";
    var clearAll = document.createElement("button");
    clearAll.className = "recent-clear"; clearAll.type = "button"; clearAll.textContent = "Clear all";
    clearAll.addEventListener("click", function () { state.prefs.recentFiles = []; savePreferences(); renderRecentFiles(); });
    head.appendChild(lbl); head.appendChild(clearAll);
    els.recentFiles.appendChild(head);

    normalizedRecent.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "recent-file";

      var open = document.createElement("button");
      open.className = "recent-open"; open.type = "button";
      var label = displayFileTitle(item.name || basename(item.path)) || basename(item.path) || "Untitled";
      open.title = label;
      open.textContent = label;
      open.addEventListener("click", function () { loadFromPath(item.path); });

      var rm = document.createElement("button");
      rm.className = "recent-x"; rm.type = "button"; rm.textContent = "✕"; rm.title = "Remove from list";
      rm.addEventListener("click", function (e) { e.stopPropagation(); removeRecentFile(item.path); });

      row.appendChild(open); row.appendChild(rm);
      els.recentFiles.appendChild(row);
    });
  }

  function removeRecentFile(path) {
    state.prefs.recentFiles = normalizeRecentFiles(state.prefs.recentFiles).filter(function (i) { return i.path !== path; });
    savePreferences();
    renderRecentFiles();
  }

  function normalizeRecentFiles(files) {
    if (!Array.isArray(files)) {
      return [];
    }

    var seen = {};
    return files.map(function (item) {
      var path = normalizeLocalFilePath(item && item.path);
      var name = item && item.name ? item.name : basename(path);
      return {
        path: path,
        name: name,
        openedAt: item && item.openedAt ? item.openedAt : ""
      };
    }).filter(function (item) {
      if (!item.path && !item.name) {
        return false;
      }

      var key = recentFileKey(item.path, item.name);
      if (seen[key]) {
        return false;
      }

      seen[key] = true;
      return true;
    }).slice(0, RECENT_LIMIT);
  }

  function recentFileKey(filePath, name) {
    var normalizedPath = normalizeLocalFilePath(filePath);
    var title = displayFileTitle(name || basename(normalizedPath));
    return normalizeTextKey(title || normalizedPath);
  }

  function displayFileTitle(name) {
    return String(name || "").replace(/\.docx$/i, "");
  }

  function normalizeTextKey(value) {
    var text = String(value || "").trim();
    if (typeof text.normalize === "function") {
      text = text.normalize("NFC");
    }
    return text.toLowerCase();
  }

  function clearSearch() {
    clearSearchMarks();
    state.searchHits = [];
    state.currentSearchIndex = -1;
    updateSearchControls();
  }

  function runSearch(query) {
    clearSearchMarks();
    state.searchHits = [];
    state.currentSearchIndex = -1;

    var normalized = (query || "").trim();
    if (!normalized || !state.currentDocument) {
      updateSearchControls();
      return;
    }

    var regex = new RegExp(escapeRegExp(normalized), "gi");
    var walker = document.createTreeWalker(
      els.documentSurface,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (!node.nodeValue || !regex.test(node.nodeValue)) {
            regex.lastIndex = 0;
            return NodeFilter.FILTER_REJECT;
          }

          regex.lastIndex = 0;
          var parent = node.parentElement;
          if (!parent || /^(SCRIPT|STYLE|MARK)$/i.test(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );

    var textNodes = [];
    var next;
    while ((next = walker.nextNode())) {
      textNodes.push(next);
    }

    textNodes.forEach(function (textNode) {
      highlightTextNode(textNode, regex);
    });

    state.searchHits = Array.prototype.slice.call(els.documentSurface.querySelectorAll("mark.search-hit"));
    if (state.searchHits.length) {
      state.currentSearchIndex = 0;
      updateCurrentSearchHit();
    }
    updateSearchControls();
  }

  function highlightTextNode(textNode, regex) {
    var text = textNode.nodeValue;
    var fragment = document.createDocumentFragment();
    var lastIndex = 0;
    var match;

    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      var mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = match[0];
      fragment.appendChild(mark);
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.parentNode.replaceChild(fragment, textNode);
  }

  function clearSearchMarks() {
    var marks = Array.prototype.slice.call(els.documentSurface.querySelectorAll("mark.search-hit"));
    marks.forEach(function (mark) {
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
    els.documentSurface.normalize();
  }

  function moveSearch(direction) {
    if (!state.searchHits.length) {
      return;
    }

    state.currentSearchIndex = (state.currentSearchIndex + direction + state.searchHits.length) % state.searchHits.length;
    updateCurrentSearchHit();
    updateSearchControls();
  }

  function updateCurrentSearchHit() {
    state.searchHits.forEach(function (hit, index) {
      hit.classList.toggle("current", index === state.currentSearchIndex);
    });

    var current = state.searchHits[state.currentSearchIndex];
    if (current) {
      current.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }

  function updateSearchControls() {
    var total = state.searchHits.length;
    var current = total ? state.currentSearchIndex + 1 : 0;
    els.searchCount.textContent = current + "/" + total;
    els.prevSearchButton.disabled = total < 2;
    els.nextSearchButton.disabled = total < 2;
  }

  async function copySelectedText() {
    var text = getSelectedText();

    if (!text.trim()) {
      showStatus("Select text in the document before copying.", true, true);
      return;
    }

    try {
      await writeClipboardText(text);
      showStatus("Copied selected text.", false, true);
    } catch (error) {
      showStatus("Could not copy selection: " + error.message, true);
    }
  }

  function bundledTemplatePath() {
    try {
      if (state.csInterface && window.cep_node && cep_node.require) {
        return cep_node.require("path").join(state.csInterface.getSystemPath(SystemPath.EXTENSION), "assets", "ZH-Title.mogrt");
      }
      if (state.csInterface) {
        return state.csInterface.getSystemPath(SystemPath.EXTENSION) + "/assets/ZH-Title.mogrt";
      }
    } catch (e) {}
    return "";
  }

  // Built-in extra templates: any .mogrt/.ffx dropped into assets/templates/ shows as a
  // default chip automatically (no need to add it by hand).
  function bundledTemplates() {
    var out = [];
    try {
      var nr = getNodeRequire(); if (!nr || !state.csInterface) return out;
      var fs = nr("fs"), path = nr("path");
      var dir = path.join(state.csInterface.getSystemPath(SystemPath.EXTENSION), "assets", "templates");
      if (!fs.existsSync(dir)) return out;
      fs.readdirSync(dir).forEach(function (f) {
        if (/\.(mogrt|ffx)$/i.test(f)) out.push({ path: path.join(dir, f), name: f.replace(/\.[^.]+$/, "") });
      });
    } catch (e) {}
    return out;
  }

  // Let the user pick their own .mogrt title/animation template.
  function chooseTitleTemplate() {
    if (window.cep && window.cep.fs && typeof window.cep.fs.showOpenDialog === "function") {
      try {
        var r = window.cep.fs.showOpenDialog(false, false, "Add animation: .mogrt (Premiere) or .ffx (After Effects)", "", ["mogrt", "ffx"]);
        if (r && r.err === 0 && r.data && r.data.length) {
          setTitleTemplate(r.data[0], basename(r.data[0]));
          return;
        }
      } catch (e) {}
    }
    els.templateInput.value = "";
    els.templateInput.click();
  }

  // Add a picked .mogrt to the SAVED list (no duplicates) + make it active. Persists across reopens.
  function setTitleTemplate(path, name, previewUrl) {
    // Pickers (esp. CEP showOpenDialog) can hand back a file:// URL with %20-encoded
    // spaces. ExtendScript's File() needs a plain POSIX path, so normalize before we
    // store it — otherwise the saved template never resolves and apply falls to default.
    path = normalizeLocalFilePath(path || "");
    if (!path) return;
    if (!Array.isArray(state.prefs.savedTemplates)) state.prefs.savedTemplates = [];
    var exists = false;
    for (var i = 0; i < state.prefs.savedTemplates.length; i += 1) {
      if (state.prefs.savedTemplates[i].path === path) { exists = true; if (previewUrl) state.prefs.savedTemplates[i].preview = previewUrl; break; }
    }
    if (!exists) state.prefs.savedTemplates.push({ path: path, name: name || basename(path), preview: previewUrl || "" });
    state.prefs.activeTemplatePath = path;
    savePreferences();
    renderTitleTemplate();
    showStatus("Template saved + active: " + (name || basename(path)) + ". It stays saved — no need to re-upload.", false, true);
  }

  function activateTemplate(path) {
    state.prefs.activeTemplatePath = path || "";
    savePreferences();
    renderTitleTemplate();
  }

  // ── Online templates (downloaded from zhmotions.com/templates) ──
  function onlineTemplatesDir() {
    try {
      var nr = getNodeRequire(); if (!nr) return "";
      var os = nr("os"), p = nr("path"), fs = nr("fs");
      var dir = p.join(os.homedir(), "Library", "Application Support", "ZH Script Studio", "templates");
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      return dir;
    } catch (e) { return ""; }
  }
  function openOnlineTemplates() {
    showStatus("Loading online templates…", false, false);
    fetchTemplateManifest([DIRECT_BASE, RELAY_BASE], 0);   // try direct (static file) then relay
  }
  function fetchTemplateManifest(bases, idx) {
    if (idx >= bases.length) { showStatus("Couldn't load online templates — check your internet, then retry.", true); return; }
    var x = new XMLHttpRequest();
    try { x.open("GET", bases[idx] + "/templates/manifest.json?_=" + Date.now(), true); }
    catch (eo) { fetchTemplateManifest(bases, idx + 1); return; }
    x.timeout = 10000;
    x.onload = function () {
      var j; try { j = JSON.parse(x.responseText); } catch (e) { fetchTemplateManifest(bases, idx + 1); return; }
      TPL_BASE = bases[idx];   // serve preview assets from the same base that worked for the manifest
      var list = (j && j.templates) || [];
      var wantHost = state.hostIsAE ? "ae" : "ppro", wantExt = state.hostIsAE ? "ffx" : "mogrt";
      list = list.filter(function (t) { return (!t.host || t.host === wantHost) && (!t.file || new RegExp("\\." + wantExt + "$", "i").test(t.file)); });
      showStatus("Online templates loaded (" + list.length + ").", false, false);   // clear the "Loading…" state
      try { showOnlineTemplateModal(list); }
      catch (me) { showStatus("Template list couldn't open: " + (me && me.message ? me.message : me), true); }
    };
    x.onerror = x.ontimeout = function () { fetchTemplateManifest(bases, idx + 1); };   // next base
    try { x.send(); } catch (es) { fetchTemplateManifest(bases, idx + 1); }
  }
  // Cache-bust template assets so a re-uploaded preview always refreshes (CEF would
  // otherwise keep serving the old cached image/video at the same URL). Per panel session.
  var TPL_CB = Date.now();
  // Base for template ASSETS (preview images/videos). Set to whichever base served the manifest —
  // if zhmotions.com direct is challenged by lsrecaptcha, the relay (clean Cloudflare IP) serves the
  // images too. Hardcoding DIRECT_BASE meant previews silently 404'd / got the bot-challenge page.
  var TPL_BASE = DIRECT_BASE;
  function tplAssetUrl(name) { return TPL_BASE + "/templates/" + name + "?v=" + TPL_CB; }
  function showOnlineTemplateModal(list) {
    var old = document.getElementById("ssTplModal"); if (old) old.remove();
    var ov = document.createElement("div");
    ov.id = "ssTplModal";
    ov.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(10,6,4,.62);padding:18px;box-sizing:border-box;";
    var rows = list.length
      ? list.map(function (t, i) {
          var pv = t.preview
            ? '<img src="' + escapeHtml(tplAssetUrl(t.preview)) + '" style="width:72px;height:44px;object-fit:cover;border-radius:6px;flex:0 0 auto;" onerror="this.style.visibility=\'hidden\'">'
            : '<div style="width:72px;height:44px;border-radius:6px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;flex:0 0 auto;">🎬</div>';
          return '<div class="ss-tpl-row" data-i="' + i + '" style="display:flex;align-items:center;gap:10px;padding:8px 9px;border:1px solid var(--panel-line,#555);border-radius:8px;margin-bottom:6px;cursor:pointer;">' +
            pv + '<span style="flex:1;">' + escapeHtml(t.name || t.file) + '</span><span style="color:var(--zh-gold,#d4a017);font-size:11px;flex:0 0 auto;">Download ↓</span></div>';
        }).join("")
      : '<div style="opacity:.7;font-size:12px;padding:8px 0;">No online templates for ' + (state.hostIsAE ? "After Effects" : "Premiere") + " yet.</div>";
    ov.innerHTML = '<div style="background:var(--panel-bg-alt,#1c1c1c);border:1px solid var(--panel-line,#444);border-radius:14px;max-width:380px;width:100%;padding:18px;color:var(--panel-text,#eee);max-height:80vh;overflow:auto;">' +
      '<div style="font-size:15px;font-weight:800;margin-bottom:10px;">🌐 Online templates (' + (state.hostIsAE ? "AE .ffx" : "Premiere .mogrt") + ')</div>' +
      rows + '<div style="text-align:right;margin-top:8px;"><button id="ssTplClose" style="background:none;border:0;color:#aaa;cursor:pointer;font-size:12px;">Close</button></div></div>';
    document.body.appendChild(ov);
    document.getElementById("ssTplClose").onclick = function () { ssHidePreview(); ov.remove(); };
    ov.onclick = function (e) { if (e.target === ov) { ssHidePreview(); ov.remove(); } };
    Array.prototype.forEach.call(ov.querySelectorAll(".ss-tpl-row"), function (row) {
      var t = list[+row.getAttribute("data-i")];
      row.onclick = function () { ssHidePreview(); ov.remove(); downloadOnlineTemplate(t); };
      if (t && (t.previewVideo || t.preview)) {
        // previewVideo = animated .mp4 (extracted from the MOGRT, like Premiere's
        // Essential Graphics browser). Falls back to the static preview image.
        var hoverUrl = tplAssetUrl(t.previewVideo || t.preview);
        var hoverIsVideo = !!t.previewVideo;
        row.onmousemove = function (e) { ssHoverPreview(hoverUrl, e.clientX, e.clientY, hoverIsVideo); };
        row.onmouseleave = function () { ssHidePreview(); };
      }
    });
  }

  // Floating preview that follows the cursor (template hover). Plays the animated
  // .mp4 when one exists (like Premiere's Essential Graphics browser), else a static image.
  var SS_PREV_CSS = "position:fixed;z-index:10002;width:240px;border-radius:8px;box-shadow:0 12px 34px rgba(0,0,0,.55);pointer-events:none;display:none;border:1px solid #666;background:#111;";
  function ssHoverPreview(url, x, y, isVideo) {
    var img = document.getElementById("ssHoverPrev");
    if (!img) {
      img = document.createElement("img"); img.id = "ssHoverPrev";
      img.style.cssText = SS_PREV_CSS;
      img.onerror = function () { img.style.display = "none"; };
      document.body.appendChild(img);
    }
    var vid = document.getElementById("ssHoverPrevVid");
    if (!vid) {
      vid = document.createElement("video"); vid.id = "ssHoverPrevVid";
      vid.autoplay = true; vid.loop = true; vid.muted = true; vid.setAttribute("playsinline", "");
      vid.style.cssText = SS_PREV_CSS;
      vid.onerror = function () { vid.style.display = "none"; };
      document.body.appendChild(vid);
    }
    var el = isVideo ? vid : img, other = isVideo ? img : vid;
    other.style.display = "none";
    if (el.getAttribute("data-src") !== url) {
      el.setAttribute("data-src", url);
      el.src = url;
      if (isVideo) {
        // play() right after setting src fails (not loaded yet) → load + play on canplay, and retry.
        try { el.load(); } catch (e) {}
        el.oncanplay = function () { try { el.play(); } catch (e) {} };
        try { var p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      }
    } else if (isVideo) {
      try { if (el.paused) el.play(); } catch (e) {}
    }
    el.style.left = Math.max(8, Math.min(x + 16, window.innerWidth - 252)) + "px";
    el.style.top = Math.max(8, Math.min(y + 16, window.innerHeight - 170)) + "px";
    el.style.display = "block";
  }
  function ssHidePreview() {
    var ids = ["ssHoverPrev", "ssHoverPrevVid"], i, el;
    for (i = 0; i < ids.length; i += 1) {
      el = document.getElementById(ids[i]);
      if (el) { el.style.display = "none"; el.removeAttribute("data-src"); try { if (el.pause) el.pause(); } catch (e) {} }
    }
  }
  function downloadOnlineTemplate(t) {
    var nr = getNodeRequire();
    var dir = onlineTemplatesDir();
    if (!nr || !dir) { showStatus("Can't save the template locally (no file access).", true); return; }
    var file = String(t.file || "").replace(/[^\w.\-]/g, "");
    if (!file) { showStatus("Bad template entry.", true); return; }
    showStatus("Downloading " + (t.name || file) + "…", false, false);
    grabTemplateFile([DIRECT_BASE, RELAY_BASE], 0, file, t, dir, nr);   // try direct then relay
  }
  function grabTemplateFile(bases, idx, file, t, dir, nr) {
    if (idx >= bases.length) { showStatus("Download failed — check internet, then retry.", true); return; }
    var x = new XMLHttpRequest();
    try { x.open("GET", bases[idx] + "/templates/" + encodeURIComponent(file) + "?_=" + Date.now(), true); }
    catch (eo) { grabTemplateFile(bases, idx + 1, file, t, dir, nr); return; }
    x.responseType = "arraybuffer";
    x.timeout = 60000;
    x.onload = function () {
      try {
        if (x.status >= 400 || !x.response || x.response.byteLength < 8) { grabTemplateFile(bases, idx + 1, file, t, dir, nr); return; }
        var buf = nr("buffer").Buffer.from(new Uint8Array(x.response));
        var dest = nr("path").join(dir, file);
        nr("fs").writeFileSync(dest, buf);
        var pvUrl = t.preview ? tplAssetUrl(t.preview) : "";
        setTitleTemplate(dest, t.name || file.replace(/\.[^.]+$/, ""), pvUrl);   // save + activate (+ preview for hover)
      } catch (e) { showStatus("Couldn't save the template: " + e.message, true); }
    };
    x.onerror = x.ontimeout = function () { grabTemplateFile(bases, idx + 1, file, t, dir, nr); };
    try { x.send(); } catch (es) { grabTemplateFile(bases, idx + 1, file, t, dir, nr); }
  }

  function removeTemplate(path) {
    // Panel-DOWNLOADED file (in our templates dir) → delete the local copy so orphans don't pile
    // up. A custom file the user picked from elsewhere is left untouched.
    try {
      var nr = getNodeRequire(), dir = onlineTemplatesDir();
      if (nr && dir && path && path.indexOf(dir) === 0 && nr("fs").existsSync(path)) nr("fs").unlinkSync(path);
    } catch (e) {}
    state.prefs.savedTemplates = (state.prefs.savedTemplates || []).filter(function (t) { return t.path !== path; });
    if (state.prefs.activeTemplatePath === path) state.prefs.activeTemplatePath = "";
    savePreferences();
    renderTitleTemplate();
  }

  // Render the saved-template chips: Default + each saved one. Active highlighted; ✕ removes.
  function renderTitleTemplate() {
    if (!els.templateName) return;
    var saved = state.prefs.savedTemplates || [];
    var active = state.prefs.activeTemplatePath || "";
    var html = '<span class="tpl-lead">🎬 Title template:</span>';
    html += '<button type="button" class="tpl-chip' + (active === "" ? " active" : "") + '" data-tpl="">ZH Default</button>';
    // Built-in extra templates (assets/templates/) — no ✕, they ship with the panel.
    bundledTemplates().forEach(function (t) {
      html += '<button type="button" class="tpl-chip' + (active === t.path ? " active" : "") + '" data-tpl="' +
        escapeHtml(t.path) + '">' + escapeHtml(t.name) + '</button>';
    });
    saved.forEach(function (t) {
      html += '<button type="button" class="tpl-chip' + (active === t.path ? " active" : "") + '" data-tpl="' +
        escapeHtml(t.path) + '"' + (t.preview ? ' data-preview="' + escapeHtml(t.preview) + '"' : '') + '>' + escapeHtml(t.name) +
        '<span class="tpl-x" data-rm="' + escapeHtml(t.path) + '">✕</span></button>';
    });
    els.templateName.innerHTML = html;
    els.templateName.hidden = false;
    els.templateName.querySelectorAll(".tpl-chip").forEach(function (chip) {
      chip.addEventListener("click", function (e) {
        e.stopPropagation();
        if (e.target.classList.contains("tpl-x")) { removeTemplate(e.target.getAttribute("data-rm")); return; }
        activateTemplate(chip.getAttribute("data-tpl"));
      });
      var pv = chip.getAttribute("data-preview");
      if (pv) {
        chip.addEventListener("mousemove", function (e) { ssHoverPreview(pv, e.clientX, e.clientY); });
        chip.addEventListener("mouseleave", function () { ssHidePreview(); });
      }
    });
    try { renderTemplateGrid(); } catch (e) {}   // keep the Templates-tab card grid in sync
  }

  // ── Templates tab: card grid (new design) ──
  var tplxFilter = "all", tplxQuery = "";
  var tplxOnline = [];          // cached online catalog (each has a preview thumbnail)
  var tplxOnlineLoaded = false;
  function templateItems() {
    // Preview lookup from the FULL manifest, matched by NAME (host-independent) — so local/bundled
    // templates show their thumbnail + video even when the host filter would drop the online entry
    // (e.g. the .mogrt previews are host:"ppro" but you're in AE).
    var pvMap = {};
    tplxOnline.forEach(function (t) {
      var k = (t.name || t.file || "").toLowerCase(); if (!k) return;
      pvMap[k] = { preview: t.preview ? tplAssetUrl(t.preview) : "",
        hover: (t.previewVideo || t.preview) ? tplAssetUrl(t.previewVideo || t.preview) : "", isVideo: !!t.previewVideo };
    });
    function withPv(it) { var p = pvMap[(it.name || "").toLowerCase()]; if (p && p.preview) { it.preview = p.preview; it.hover = p.hover; it.isVideo = p.isVideo; } return it; }

    var items = [withPv({ path: "", name: "ZH Default Title", preview: "", builtin: true })];
    try { bundledTemplates().forEach(function (t) { items.push(withPv({ path: t.path, name: t.name, preview: "", builtin: true })); }); } catch (e) {}
    (state.prefs.savedTemplates || []).forEach(function (t) { items.push(withPv({ path: t.path, name: t.name, preview: t.preview || "", saved: true })); });

    // Online-only catalog entries (host-appropriate + not already local) → downloadable cards.
    var have = {}; items.forEach(function (it) { have[(it.name || "").toLowerCase()] = 1; });
    var wantHost = state.hostIsAE ? "ae" : "ppro", wantExt = state.hostIsAE ? "ffx" : "mogrt";
    tplxOnline.forEach(function (t) {
      var nm = t.name || t.file || ""; if (!nm || have[nm.toLowerCase()]) return;
      if (t.host && t.host !== wantHost) return;
      if (t.file && !new RegExp("\\." + wantExt + "$", "i").test(t.file)) return;
      items.push({ online: true, file: t.file, name: nm, preview: t.preview ? tplAssetUrl(t.preview) : "",
        hover: (t.previewVideo || t.preview) ? tplAssetUrl(t.previewVideo || t.preview) : "", isVideo: !!t.previewVideo, _t: t });
    });
    return items;
  }
  function renderTemplateGrid() {
    var grid = document.getElementById("tplxGrid"); if (!grid) return;
    var active = state.prefs.activeTemplatePath || "";
    var items = templateItems().filter(function (it) {
      if (tplxFilter === "saved" && !it.saved) return false;
      if (tplxFilter === "lower" && !/lower/i.test(it.name)) return false;
      if (tplxQuery && it.name.toLowerCase().indexOf(tplxQuery) < 0) return false;
      return true;   // "all" + "titles" → every template (they're all title templates)
    });
    var html = items.map(function (it, i) {
      var thumb = it.preview
        ? '<img src="' + escapeHtml(it.preview) + '" onerror="this.style.display=\'none\';this.parentNode.innerHTML=\'🎬\'">'
        : '🎬';
      var addBtn = it.online
        ? '<button type="button" class="tplx-add" data-dl="' + i + '">Add ↓</button>'
        : '<button type="button" class="tplx-add" data-add="' + escapeHtml(it.path) + '">' + (active === it.path ? "✓ Active" : "Add ↓") + '</button>';
      var hov = it.hover || it.preview || "";
      return '<div class="tplx-card' + (active === it.path && !it.online ? " active" : "") + '"' +
        (hov ? ' data-preview="' + escapeHtml(hov) + '"' + (it.isVideo ? ' data-video="1"' : '') : '') + '>' +
        '<div class="tplx-thumb">' + thumb + '</div>' +
        '<div class="tplx-name">' + escapeHtml(it.name) + (it.online ? ' <span class="tplx-tag">online</span>' : '') + '</div>' +
        addBtn +
        (it.saved ? '<span class="tplx-rm" data-rm="' + escapeHtml(it.path) + '">✕</span>' : '') +
        '</div>';
    }).join("");
    if (!html) html = '<div class="tplx-empty">No templates here yet.</div>';
    html += '<div class="tplx-card tplx-add-card"><div class="tplx-thumb">＋</div>' +
      '<div class="tplx-name">Add your own</div>' +
      '<button type="button" class="tplx-add" id="tplxBrowse">🌐 Refresh</button>' +
      '<button type="button" class="tplx-add ghost" id="tplxFromFile">＋ File</button></div>';
    grid.innerHTML = html;
    // Keep a parallel array so data-dl can map back to the online template object.
    var rendered = items;
    Array.prototype.forEach.call(grid.querySelectorAll(".tplx-card"), function (card) {
      var pv = card.getAttribute("data-preview");
      if (pv) {
        var isVid = card.getAttribute("data-video") === "1";
        card.addEventListener("mousemove", function (e) { ssHoverPreview(pv, e.clientX, e.clientY, isVid); });
        card.addEventListener("mouseleave", function () { ssHidePreview(); });
      }
    });
    grid.querySelectorAll("[data-add]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); ssHidePreview(); activateTemplate(b.getAttribute("data-add")); showStatus("Template set — use +Title / Batch to insert.", false, true); });
    });
    grid.querySelectorAll("[data-dl]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); ssHidePreview(); var it = rendered[+b.getAttribute("data-dl")]; if (it && it._t) downloadOnlineTemplate(it._t); });
    });
    grid.querySelectorAll(".tplx-rm").forEach(function (x) {
      x.addEventListener("click", function (e) { e.stopPropagation(); removeTemplate(x.getAttribute("data-rm")); });
    });
    var br = document.getElementById("tplxBrowse"); if (br) br.addEventListener("click", function () { loadOnlineTemplates(true); });
    var ff = document.getElementById("tplxFromFile"); if (ff) ff.addEventListener("click", function () { chooseTitleTemplate(); });
  }
  // Pull the online manifest straight into the grid (so cards show real preview thumbnails),
  // instead of only opening the separate modal. Tries direct → relay (relay bypasses lsrecaptcha).
  function loadOnlineTemplates(force) {
    if (tplxOnlineLoaded && !force) { renderTemplateGrid(); return; }
    var bases = [DIRECT_BASE, RELAY_BASE];
    (function tryBase(idx) {
      if (idx >= bases.length) { tplxOnlineLoaded = true; renderTemplateGrid(); return; }
      var x = new XMLHttpRequest();
      try { x.open("GET", bases[idx] + "/templates/manifest.json?_=" + Date.now(), true); } catch (e) { tryBase(idx + 1); return; }
      x.timeout = 10000;
      x.onload = function () {
        var j; try { j = JSON.parse(x.responseText); } catch (e) { tryBase(idx + 1); return; }
        TPL_BASE = bases[idx];   // serve preview assets from the base that worked
        tplxOnline = (j && j.templates) || [];   // keep the FULL manifest; host filter applied in templateItems
        tplxOnlineLoaded = true;
        renderTemplateGrid();
      };
      x.onerror = x.ontimeout = function () { tryBase(idx + 1); };
      try { x.send(); } catch (e) { tryBase(idx + 1); }
    })(0);
  }
  function wireTemplateTab() {
    var s = document.getElementById("tplxSearch");
    if (s) s.addEventListener("input", function () { tplxQuery = (s.value || "").toLowerCase().trim(); renderTemplateGrid(); });
    var f = document.getElementById("tplxFilters");
    if (f) f.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".tplx-chip") : null;
      if (!b) return;
      tplxFilter = b.getAttribute("data-filter") || "all";
      f.querySelectorAll(".tplx-chip").forEach(function (c) { c.classList.toggle("active", c === b); });
      renderTemplateGrid();
    });
    try { loadOnlineTemplates(false); } catch (e) {}   // populate grid with online previews on load
  }

  // Build a double-quoted ExtendScript string literal with \uXXXX for non-ASCII.
  // This is the reliable way to pass Unicode (Bengali) through evalScript — no decodeURIComponent.
  function esEscape(s) {
    s = String(s == null ? "" : s);
    var out = '"', i, c;
    for (i = 0; i < s.length; i += 1) {
      c = s.charCodeAt(i);
      if (c === 0x22) out += '\\"';
      else if (c === 0x5C) out += '\\\\';
      else if (c === 0x0A) out += '\\n';
      else if (c === 0x0D) out += '\\r';
      else if (c === 0x09) out += '\\t';
      else if (c < 32 || c > 126) out += '\\u' + ('0000' + c.toString(16)).slice(-4);
      else out += s.charAt(i);
    }
    return out + '"';
  }

  // mode: "caption" (one cue) | "batch" (each line a cue) | "marker"
  // overrideText: when given (e.g. from Paste), use it instead of the document selection.
  function sendToTimeline(mode, overrideText) {
    var text = (typeof overrideText === "string" && overrideText) ? overrideText : getSelectedText();
    if (!text.trim()) {
      showStatus("Select text in the document first.", true, true);
      return;
    }
    if (!state.csInterface) {
      showStatus("This works inside Premiere Pro or After Effects.", true);
      return;
    }

    var dur = parseFloat(els.durationInput && els.durationInput.value) || 4;
    if (dur < 0.5) dur = 0.5;
    // Active saved template wins; otherwise the bundled ZH-Title.mogrt.
    // normalize heals any already-stored file:// URL from older builds.
    var mogrtPath = normalizeLocalFilePath(state.prefs.activeTemplatePath || "") || bundledTemplatePath();
    var effStyle = (window.zhEffectStyle ? window.zhEffectStyle() : "pop");
    // The Effect chip IS the animation choice — apply it directly. Don't gate title effects behind
    // the (subtitle-oriented) "Animated" toggle: that made picking Type-on/Slide/Glow do nothing.
    // The "None" chip = a deliberately static title.
    var effAnimated = !!effStyle && effStyle !== "none";
    var options = encodeURIComponent(JSON.stringify({ durationSeconds: dur, gapSeconds: 0, mode: mode, fontSize: 64, color: "#FFFFFF", mogrtPath: mogrtPath, animated: effAnimated, animStyle: effStyle, hlWords: getMarkedWords(), hlColor: "#ffe14d" }));
    // \u-escaped literal — ExtendScript parses Unicode natively (decodeURIComponent mangles Bengali in Premiere → ??????).
    var encText = esEscape(text);
    var fn = mode === "batch" ? "pasteBatchToTimeline"
           : mode === "marker" ? "addMarker"
           : "pasteTextToTimeline";
    var script = mode === "marker"
      ? "$.zhScriptStudio." + fn + "(" + encText + ")"
      : "$.zhScriptStudio." + fn + "(" + encText + "," + JSON.stringify(options) + ")";

    state.csInterface.evalScript(script, function (result) {
      var response = parseHostResponse(result);
      showStatus(response.message, !response.ok, false); // keep visible (diagnostics/errors)
    });
  }

  function getSelectedText() {
    var selection = window.getSelection ? window.getSelection() : null;
    return selection ? selection.toString() : "";
  }

  // Stamp the real build version into the UI (header badge + Help modal) so the installed version is
  // always visible — no more guessing whether a new .zxp actually loaded vs a cached old panel.
  function stampVersion() {
    var v = "v" + EXT_VERSION;
    var ver = document.querySelector(".ver"); if (ver) ver.textContent = v;
    var nm = document.querySelector(".v3-name");
    if (nm && nm.parentNode && !document.getElementById("zhVerBadge")) {
      var b = document.createElement("span"); b.id = "zhVerBadge"; b.textContent = v;
      b.style.cssText = "font-size:9px;font-weight:700;color:var(--v-gold,#d4a017);border:1px solid var(--v-gold,#d4a017);border-radius:6px;padding:1px 5px;margin-left:6px;vertical-align:middle;opacity:.85;";
      nm.parentNode.insertBefore(b, nm.nextSibling);
    }
  }

  // Hormozi highlight: the words the user MARKED (.zh-mark spans) within the current selection
  // (or, if nothing selected, anywhere in the document). Passed to the host so those words pop.
  function getMarkedWords() {
    var out = [];
    try {
      var sel = window.getSelection ? window.getSelection() : null;
      var range = (sel && sel.rangeCount && !sel.isCollapsed) ? sel.getRangeAt(0) : null;
      var marks = els.documentSurface ? els.documentSurface.querySelectorAll(".zh-mark") : [];
      for (var i = 0; i < marks.length; i += 1) {
        if (range && range.intersectsNode && !range.intersectsNode(marks[i])) continue;
        var w = (marks[i].textContent || "").replace(/\s+/g, " ").trim();
        if (w) out.push(w);
      }
    } catch (e) {}
    return out;
  }

  // Make the script editable in-panel (fix typos like a Word file; Enter = new line).
  function toggleEditMode() {
    state.editing = !state.editing;
    var surface = els.documentSurface;
    surface.contentEditable = state.editing ? "true" : "false";
    surface.classList.toggle("editing", state.editing);
    var editBtn = document.getElementById("editButton");
    var saveBtn = document.getElementById("saveButton");
    if (editBtn) editBtn.classList.toggle("active", state.editing);
    if (saveBtn) saveBtn.hidden = !state.editing;
    if (state.editing) {
      surface.focus();
      showStatus("Edit mode ON — fix typos, Enter = new line. Click 💾 to save.", false, true);
    } else {
      showStatus("Edit mode off.", false, true);
    }
  }

  // Save in-panel edits back to disk. .txt/.srt overwrite; .docx saved as an edited .txt.
  function saveEdits() {
    var filePath = state.currentFilePath;
    var text = els.documentSurface.innerText || "";
    if (!filePath) {
      showStatus("No file path — re-open the script from disk to save.", true, true);
      return;
    }
    try {
      var ext = (filePath.split(".").pop() || "").toLowerCase();
      if (ext === "txt" || ext === "srt") {
        writeLocalTextFile(filePath, text);
        showStatus("Saved to " + basename(filePath) + ".", false, true);
      } else {
        var out = filePath.replace(/\.[^.]+$/, "") + " (edited).txt";
        writeLocalTextFile(out, text);
        showStatus("Saved edited text as " + basename(out) + " (original .docx kept).", false, true);
      }
    } catch (e) {
      showStatus("Could not save: " + e.message, true);
    }
  }

  // Auto subtitle: grab the timeline audio automatically (like Premiere), transcribe (Bengali) → .srt.
  var STT_API = apiRoot() + "/api.php";

  // Show the user's Auto Subtitle minutes for the month in the dock.
  function refreshQuota() {
    var lic = getStoredLicense();
    var badge = document.getElementById("quotaBadge");
    if (!badge || !lic || !lic.key) return;
    try {
      var x = new XMLHttpRequest();
      x.open("GET", STT_API + "?action=stt_quota_status&key=" + encodeURIComponent(lic.key), true);
      x.onload = function () {
        try {
          var j = JSON.parse(x.responseText);
          if (j.status === "success") {
            badge.textContent = "🎤 " + j.remaining + "/" + j.quota + " min" + (j.free ? " · free" : "");
            badge.classList.toggle("low", j.remaining <= 2);
            badge.hidden = false;
          }
        } catch (e) {}
      };
      x.send();
    } catch (e) {}
  }

  function autoSubMain(mode) {
    state.sttMode = (mode === "transcribe") ? "transcribe" : "subtitle";
    showStatus(state.sttMode === "transcribe" ? "📝 Transcribe started…" : "🎤 Auto Subtitle started…", false, false); // instant feedback
    var lic = getStoredLicense();
    if (!lic || !lic.key) { showStatus("Activate your license first.", true, true); return; }
    if (!state.csInterface) { showStatus("This works inside Premiere Pro (open it there).", true, false); return; }
    // Grab the project folder so the .srt / transcript saves next to the project by default.
    try {
      state.csInterface.evalScript("$.zhScriptStudio.zhProjectPath()", function (r) {
        try {
          var resp = parseHostResponse(r);
          if (resp.ok && resp.path) {
            var nr2 = getNodeRequire();
            state.projectDir = nr2 ? nr2("path").dirname(resp.path) : "";
          }
        } catch (e) {}
      });
    } catch (e) {}
    // After Effects: render the composition's audio synchronously, then upload it directly.
    if (state.hostIsAE) {
      showStatus("Rendering the composition audio…", false, false);
      state.csInterface.evalScript("$.zhScriptStudio.exportCompAudio()", function (result) {
        var resp = parseHostResponse(result);
        if (resp.ok && resp.path) {
          state.aeAudioStart = parseFloat(resp.start) || 0;   // Work-Area offset → captions land at the right time
          uploadAudioPath(resp.path, "comp-audio.wav");   // ready file — upload now (no waiting)
        } else if (/undefined|is not a function|EvalScript/i.test(String(result))) {
          showStatus("Please reload the panel (close + reopen), then try Auto Subtitle again.", true, false);
        } else {
          showStatus("Audio render failed: " + (resp.message || String(result).slice(0, 120)), true, false);
        }
      });
      return;
    }

    showStatus("Encoding the timeline audio…", false, false);
    var presetPath = "";
    try {
      var pth = cep_node.require("path");
      presetPath = pth.join(state.csInterface.getSystemPath(SystemPath.EXTENSION), "client", "assets", "STT-Audio.epr");
      if (!cep_node.require("fs").existsSync(presetPath)) presetPath = pth.join(state.csInterface.getSystemPath(SystemPath.EXTENSION), "assets", "STT-Audio.epr");
    } catch (e) {}
    state.csInterface.evalScript("$.zhScriptStudio.exportSequenceAudio(" + esEscape(presetPath) + ")", function (result) {
      var resp = parseHostResponse(result);
      if (resp.ok && resp.path) {
        waitForAudioThenUpload(resp.path, 0, -1);
      } else if (/undefined|is not a function|EvalScript/i.test(String(result))) {
        // host script not reloaded — the new function isn't loaded yet
        showStatus("Please fully reload: close this panel + reopen it (or restart Premiere), then try Auto Sub again.", true, false);
      } else {
        showStatus("Auto encode failed: " + (resp.message || String(result).slice(0, 120)), true, false);
      }
    });
  }

  // Wait for the async audio export to FULLY finish. The file must stop growing for a
  // sustained window (~7s) — a brief pause mid-encode must not trigger a partial upload.
  function waitForAudioThenUpload(path, tries, lastSize, stable) {
    if (tries > 600) { showStatus("Audio encode timed out. Try again or use a shorter range.", true, false); return; }
    var size = -1;
    try { var nr = getNodeRequire(); if (nr && nr("fs").existsSync(path)) size = nr("fs").statSync(path).size; } catch (e) {}
    if (size > 2000 && size === lastSize) { stable = (stable || 0) + 1; } else { stable = 0; }
    // ~7s of no growth (5 checks × 1.5s) = encode finished.
    if (size > 2000 && stable >= 5) {
      showStatus("Audio ready (" + Math.round(size / 1048576) + " MB). Uploading…", false, false);
      uploadAudioPath(path, "timeline.wav");
      return;
    }
    showStatus(size > 0 ? ("Encoding the timeline audio… (" + Math.round(size / 1048576) + " MB)") : ("Encoding the timeline audio… (" + tries + "s)"), false, false);
    setTimeout(function () { waitForAudioThenUpload(path, tries + 1, size, stable); }, 1500);
  }

  // Read a local audio file (node) → upload as a Blob.
  // Downsample a PCM-16 WAV to 16 kHz MONO before upload. STT only needs 16 kHz mono, and AE
  // renders 48 kHz stereo (≈6× bigger) which can blow past the server's upload limit (413).
  // Pure-JS (no ffmpeg). Returns a new temp path, or the original if it can't/needn't convert.
  function downsampleWavFile(srcPath) {
    var fd = null;
    state.dsDiag = "";
    try {
      var nr = getNodeRequire(); if (!nr) { state.dsDiag = "no-node"; return srcPath; }
      var fs = nr("fs"), os = nr("os"), path = nr("path");
      // STREAM the file — a long comp can be 100s of MB; reading it whole would OOM the panel
      // (that was the "203 MB stuck at 1%": readFileSync threw, so the giant original uploaded).
      fd = fs.openSync(srcPath, "r");
      var head = Buffer.alloc(65536);
      var hn = fs.readSync(fd, head, 0, 65536, 0); head = head.slice(0, hn);
      var magic = head.toString("ascii", 0, 4);   // RIFF/RF64 = WAV (LE); FORM = AIFF (BE)
      var fileSize = fs.statSync(srcPath).size;
      var audioFormat = 1, channels, rate, bits, dataStart, dataLen, bigEndian = false;
      if (magic === "RIFF" || magic === "RF64") {
        if (head.toString("ascii", 8, 12) !== "WAVE") { state.dsDiag = "notwav:" + magic; fs.closeSync(fd); return srcPath; }
        var fmtOff = head.indexOf("fmt ", 12, "ascii"), dataOff = head.indexOf("data", 12, "ascii");
        if (fmtOff < 0 || dataOff < 0) { state.dsDiag = "nochunk(fmt=" + fmtOff + ",data=" + dataOff + ")"; fs.closeSync(fd); return srcPath; }
        audioFormat = head.readUInt16LE(fmtOff + 8); channels = head.readUInt16LE(fmtOff + 10);
        rate = head.readUInt32LE(fmtOff + 12); bits = head.readUInt16LE(fmtOff + 22);
        dataStart = dataOff + 8; dataLen = head.readUInt32LE(dataOff + 4);
      } else if (magic === "FORM" && head.toString("ascii", 8, 12) === "AIFF") {
        bigEndian = true;
        var commOff = head.indexOf("COMM", 12, "ascii"), ssndOff = head.indexOf("SSND", 12, "ascii");
        if (commOff < 0 || ssndOff < 0) { state.dsDiag = "noaiffchunk"; fs.closeSync(fd); return srcPath; }
        channels = head.readUInt16BE(commOff + 8); bits = head.readUInt16BE(commOff + 14);
        // sampleRate = 80-bit IEEE extended float at COMM+16
        var eo = commOff + 16, exp = ((head[eo] & 0x7f) << 8) | head[eo + 1];
        var hi = ((head[eo + 2] << 24) | (head[eo + 3] << 16) | (head[eo + 4] << 8) | head[eo + 5]) >>> 0;
        var lo = ((head[eo + 6] << 24) | (head[eo + 7] << 16) | (head[eo + 8] << 8) | head[eo + 9]) >>> 0;
        rate = Math.round((hi * 4294967296 + lo) * Math.pow(2, (exp - 16383) - 63));
        var ssndDataOffset = head.readUInt32BE(ssndOff + 8);   // usually 0
        dataStart = ssndOff + 16 + ssndDataOffset;
        dataLen = head.readUInt32BE(ssndOff + 4) - 8 - ssndDataOffset;
      } else { state.dsDiag = "notwav:" + magic; fs.closeSync(fd); return srcPath; }

      state.dsDiag = (bigEndian ? "aiff" : "wav") + "/" + audioFormat + "/" + bits + "bit/" + channels + "ch/" + rate;
      if (!channels || channels < 1 || !bits || bits < 8 || !rate || rate < 8000) { state.dsDiag += " bad"; fs.closeSync(fd); return srcPath; }
      var bps = bits / 8, frameBytes = bps * channels;
      function readSample(b, o) {
        if (bigEndian) {
          if (bits === 16) { var w = (b[o] << 8) | b[o + 1]; return (w & 0x8000) ? w - 0x10000 : w; }
          if (bits === 24) { var v3 = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; if (v3 & 0x800000) v3 -= 0x1000000; return (v3 / 256) | 0; }
          if (bits === 32) { var v4 = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); return (v4 / 65536) | 0; }
          if (bits === 8)  return b[o] << 8;
          return 0;
        }
        if (audioFormat === 3 && bits === 32) return Math.max(-32768, Math.min(32767, (b.readFloatLE(o) * 32767) | 0));
        if (bits === 16) return b.readInt16LE(o);
        if (bits === 32) return (b.readInt32LE(o) / 65536) | 0;
        if (bits === 24) { var v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (v & 0x800000) v -= 0x1000000; return (v / 256) | 0; }
        if (bits === 8)  return (b[o] - 128) * 256;
        return 0;
      }
      var TARGET = 16000;
      if (!bigEndian && rate <= TARGET && channels === 1 && bits === 16 && audioFormat === 1) { fs.closeSync(fd); return srcPath; }  // already minimal
      if (dataLen <= 0 || dataStart + dataLen > fileSize) dataLen = fileSize - dataStart;
      var numFrames = Math.floor(dataLen / frameBytes);
      var ratio = Math.max(1, rate / TARGET), outFrames = Math.floor(numFrames / ratio);
      var out = Buffer.alloc(outFrames * 2);                 // 16-bit mono out (small: ~32 MB for 17 min)
      var BLOCK = (1 << 20);                                 // ~1M frames per read
      var blockBuf = Buffer.alloc(BLOCK * frameBytes);
      var oi = 0, startFrame = 0;
      while (oi < outFrames && startFrame < numFrames) {
        var want = Math.min(BLOCK, numFrames - startFrame) * frameBytes;
        var got = fs.readSync(fd, blockBuf, 0, want, dataStart + startFrame * frameBytes);
        var gotFrames = Math.floor(got / frameBytes); if (gotFrames <= 0) break;
        var endFrame = startFrame + gotFrames;
        while (oi < outFrames) {
          var sf = Math.floor(oi * ratio); if (sf >= endFrame) break;
          var rel = (sf - startFrame) * frameBytes, s = 0;
          for (var c = 0; c < channels; c += 1) s += readSample(blockBuf, rel + c * bps);
          out.writeInt16LE(Math.max(-32768, Math.min(32767, (s / channels) | 0)), oi * 2); oi += 1;
        }
        startFrame = endFrame;
      }
      fs.closeSync(fd); fd = null;
      if (oi < outFrames) out = out.slice(0, oi * 2);
      var h = Buffer.alloc(44);
      h.write("RIFF", 0); h.writeUInt32LE(36 + out.length, 4); h.write("WAVE", 8);
      h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(TARGET, 24); h.writeUInt32LE(TARGET * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write("data", 36); h.writeUInt32LE(out.length, 40);
      var outPath = path.join(os.tmpdir(), "zh-stt16-" + Date.now() + ".wav");
      fs.writeFileSync(outPath, Buffer.concat([h, out]));
      state.dsDiag = "";   // success → no diagnostic
      return outPath;
    } catch (e) { state.dsDiag = "err:" + (e && e.message ? e.message : e); try { if (fd !== null) getNodeRequire()("fs").closeSync(fd); } catch (e2) {} return srcPath; }
  }

  function uploadAudioPath(path, name) {
    try {
      var nr = getNodeRequire();
      var small = downsampleWavFile(path);   // 16 kHz mono → fits the server limit
      var sz = 0; try { sz = nr("fs").statSync(small).size; } catch (e) {}
      // Still too big to upload anywhere (relay caps ~100 MB)? Don't attempt a doomed upload —
      // tell the user WHY the shrink failed [ds:reason] + the fix (a shorter Work Area).
      if (sz > 95 * 1048576) {
        showStatus("Audio is " + (sz / 1048576).toFixed(0) + " MB — couldn't compress it" + (state.dsDiag ? " [" + state.dsDiag + "]" : "") + ". In AE set a shorter Work Area (B start, N end) over the part you need, then run Auto Subtitle.", true, false);
        return;
      }
      var buf = nr("fs").readFileSync(small);
      var blob = new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)], { type: "audio/wav" });
      uploadAudioForSubtitle(blob, name);
    } catch (e) { showStatus("Could not read the exported audio: " + e.message, true); }
  }

  function uploadAudioForSubtitle(fileOrBlob, name) {
    var lic = getStoredLicense();
    if (!lic || !lic.key) { showStatus("Activate your license first.", true, true); return; }
    var mb = (fileOrBlob && fileOrBlob.size) ? (fileOrBlob.size / 1048576).toFixed(1) + " MB" : "";
    // If the audio is still big, surface WHY the downsampler didn't shrink it (format/error).
    var dsNote = (state.dsDiag && fileOrBlob && fileOrBlob.size > 12 * 1048576) ? " [ds:" + state.dsDiag + "]" : "";
    showStatus("Uploading audio" + (mb ? " (" + mb + ")" : "") + dsNote + " + transcribing… can take a minute.", false, false);
    var fd = new FormData();
    fd.append("audio", fileOrBlob, name || "audio.wav");
    fd.append("key", lic.key);
    var langEl = document.getElementById("subLang");
    fd.append("lang", (langEl && langEl.value) || "bn-BD");
    var wpcEl = document.getElementById("wordsPerCue");
    fd.append("wpc", (wpcEl && wpcEl.value) || "0");
    var tlEl = document.getElementById("subTranslate");
    var tlVal = (tlEl && tlEl.value) || "";
    // Transcribe: get the transcript in the SPOKEN language (tl=""), then prose-translate the FULL
    // text afterwards (cleaner than joining subtitle-fragment translations). Remember the target.
    if (state.sttMode === "transcribe") { state.transcribeTl = tlVal; tlVal = ""; }
    fd.append("tl", tlVal);
    var x = new XMLHttpRequest();
    // ALWAYS upload through the relay: the direct origin's firewall chokes on uploads bigger than
    // ~5 MB (holds the connection open → "stuck at 1%" / 503 / timeout). The relay forwards from a
    // clean IP and handles large uploads fine (tested to 50 MB).
    x.open("POST", RELAY_BASE + "/api.php?action=stt_start", true);
    x.timeout = 300000;
    var lastLoaded = 0, lastMove = Date.now(), watchdog = null;
    function clearWatch() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }
    if (x.upload) {
      x.upload.onprogress = function (ev) {
        if (ev.loaded > lastLoaded) { lastLoaded = ev.loaded; lastMove = Date.now(); }
        if (ev.lengthComputable && ev.loaded < ev.total) showStatus("Uploading audio" + (mb ? " " + mb : "") + "… " + Math.round(ev.loaded / ev.total * 100) + "%", false, false);
      };
      // Upload done → server is now transcribing (chunked Chirp 2). Keep the user informed.
      x.upload.onload = function () { clearWatch(); showStatus("Transcribing with Chirp 2… (a longer clip takes a minute, please wait)", false, false); };
    }
    // Stall watchdog: if the upload makes NO progress for 25s (a flagged-IP firewall holding the
    // connection open without responding — neither onerror nor onload fires), abort and fail over
    // to the relay. This is the common "stuck at 0–1%" on a flagged network.
    watchdog = setInterval(function () {
      if (Date.now() - lastMove > 25000) {
        clearWatch();
        try { x.abort(); } catch (e) {}
        if (sttFailover()) return;
        showStatus("Upload stalled (no progress). Check internet / switch network, then retry.", true);
      }
    }, 5000);
    // ANY upload failure that smells like the host firewall (HTML challenge, empty body,
    // network reset, gateway 5xx) → switch to the clean Worker relay and retry. Covers the
    // many shapes the firewall takes (challenge page / connection reset / empty response).
    function sttFailover() {
      state.sttChallengeTries = (state.sttChallengeTries || 0) + 1;
      if (state.sttChallengeTries > 4) { state.sttChallengeTries = 0; return false; }
      if (apiRoot() === DIRECT_BASE) switchToRelay();   // first failure on direct → relay
      showStatus("Connection issue — retrying" + (apiRoot() === RELAY_BASE ? " via relay" : "") + "…", false, false);
      setTimeout(function () { uploadAudioForSubtitle(fileOrBlob, name); }, 2500);
      return true;
    }
    x.onload = function () {
      clearWatch();
      var j;
      try { j = JSON.parse(x.responseText); }
      catch (e) {
        var rt = String(x.responseText || "");
        if (x.status === 413) { state.sttChallengeTries = 0; showStatus("Audio is too large for the server. Select a shorter part of the timeline and try again.", true); return; }
        // HTML challenge OR empty/garbage body OR gateway error → failover to the relay.
        if (isChallengeHTML(rt) || rt.trim() === "" || x.status >= 500) {
          if (sttFailover()) return;
          showStatus("Server is busy / firewall blocking (HTTP " + x.status + "). Wait a moment or switch network, then retry.", true);
          return;
        }
        showStatus("Transcribe start failed (HTTP " + x.status + ": " + rt.slice(0, 80) + ")", true); return;
      }
      state.sttChallengeTries = 0;
      if (j.status !== "success") {
        if (isQuotaMessage(j.message)) showBuyStatus(j.message);
        else showStatus("Transcribe failed: " + (j.message || "unknown"), true);
        return;
      }
      if (j.done) { finishSubtitle(j, name || "audio"); return; }   // short clip — instant result, no GCS
      if (j.op) { pollSubtitle(j.op, lic.key, name || "audio", 0); return; }
      showStatus("Transcribe failed: unexpected server response.", true);
    };
    // Network-level failure (connection reset — often the firewall) → try the relay.
    x.onerror = function () { clearWatch(); if (sttFailover()) return; showStatus("No connection to the server. Check your internet and retry.", true); };
    x.ontimeout = function () { clearWatch(); if (sttFailover()) return; showStatus("Upload timed out — try a shorter selection.", true); };
    x.send(fd);
  }
  // Parse an .srt → cues [{start, end, text}] in seconds (for animated subtitles).
  function srtToCues(srt) {
    var cues = [];
    var blocks = String(srt || "").replace(/\r/g, "").split(/\n\s*\n/);
    var tc = function (s) {
      var m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
      if (!m) return 0;
      return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    };
    for (var i = 0; i < blocks.length; i += 1) {
      var lines = blocks[i].split("\n").filter(function (l) { return l.trim() !== ""; });
      if (!lines.length) continue;
      if (/^\d+$/.test(lines[0].trim())) lines.shift();           // cue number
      if (!lines.length) continue;
      var arrow = /-->/.test(lines[0]) ? lines.shift() : "";
      if (!arrow) continue;
      var parts = arrow.split("-->");
      var text = lines.join("\n").trim();   // keep line breaks (dual-language stack + multi-line cues)
      if (!text) continue;
      cues.push({ start: tc(parts[0]), end: tc(parts[1] || ""), text: text });
    }
    return cues;
  }

  // Strip SRT indices + timecodes → clean paragraph text for a transcript.
  function srtToPlainText(srt) {
    return String(srt || "")
      .replace(/\r/g, "")
      .replace(/^\s*\d+\s*$/gm, "")                                   // cue numbers
      .replace(/^\s*[\d:,]+\s*-->\s*[\d:,]+.*$/gm, "")                // timecodes
      .split("\n").map(function (l) { return l.trim(); }).filter(Boolean).join(" ")
      .replace(/\s{2,}/g, " ").trim();
  }

  // Transcribe mode: put the text in the panel (editable) + save a .txt transcript.
  function finishTranscript(j) {
    if (!j.srt) { showStatus(j.message || "No speech detected in the audio.", true, true); return; }
    var text = srtToPlainText(j.srt);
    if (!text) { showStatus("No speech detected.", true, true); return; }
    // If the user chose a Translate target, translate the FULL transcript as prose (clean).
    var tt = state.transcribeTl || "";
    if (tt) {
      showStatus("Translating transcript…", false, false);
      var lic = getStoredLicense();
      var xt = new XMLHttpRequest();
      xt.open("POST", RELAY_BASE + "/api.php?action=ss_translate_text", true);
      xt.timeout = 120000;
      xt.onload = function () {
        var out = text;
        try { var jr = JSON.parse(xt.responseText); if (jr && jr.text) out = jr.text; } catch (e) {}
        deliverTranscript(out);
      };
      xt.onerror = xt.ontimeout = function () { deliverTranscript(text); };  // fall back to untranslated
      var fd = new FormData();
      fd.append("key", (lic && lic.key) || "");
      fd.append("text", text);
      fd.append("tl", tt);
      xt.send(fd);
      return;
    }
    deliverTranscript(text);
  }

  // Save transcript to project/Desktop + load into the panel.
  function deliverTranscript(text) {
    var nr = getNodeRequire();
    var stamp = new Date().toISOString().slice(0, 10);
    var defName = (state.currentFilePath
      ? basename(state.currentFilePath).replace(/\.[^.]+$/, "")
      : "ZH-Transcript-" + stamp) + ".txt";

    // Default save = the Premiere project folder. Fallbacks: open script's folder → Desktop.
    var savePath = "";
    try {
      if (state.projectDir && nr) savePath = nr("path").join(state.projectDir, defName);
      else if (state.currentFilePath) savePath = state.currentFilePath.replace(/\.[^.\/\\]+$/, "") + "-transcript.txt";
      else if (nr) savePath = nr("path").join(nr("os").homedir(), "Desktop", defName);
    } catch (e) {}

    var savedNote = "";
    if (savePath) {
      try { writeLocalTextFile(savePath, text); savedNote = " · saved to " + savePath; }
      catch (e) { savedNote = " · couldn't write the file"; }
    }
    // Load into the panel as an editable document.
    try { renderPlainText(text, "Transcript", "", false); } catch (e) {}
    showStatus("📝 Transcript ready" + savedNote, false, false);
    try { refreshQuota(); } catch (e) {}
  }

  // The SELECTED AE animation for subtitle layers: a chosen .ffx preset (active template), the
  // chosen built-in style, and whether Animated is On. So AE subtitles use what the user picked.
  function aeSubOptsEnc() {
    var ap = normalizeLocalFilePath((state.prefs && state.prefs.activeTemplatePath) || "");
    var style = (window.zhCaptionStyle ? window.zhCaptionStyle() : ((state.prefs && state.prefs.aeAnimStyle) || "pop"));
    return encodeURIComponent(JSON.stringify({
      // The caption-style CARD is the control now — every style except "Clean"/"None" animates,
      // regardless of the (titles) Animated toggle. Clean = minimal subtle fade.
      animated: style !== "clean" && style !== "none",
      style: style,
      ffx: /\.ffx$/i.test(ap) ? ap : ""
    }));
  }

  // Got the .srt (sync or after polling) → save + auto-add to a caption track.
  // Translate each caption line and stack "original\ntranslation" → a dual-language SRT.
  function buildDualSrt(srt, target, cb) {
    var cues = srtToCues(srt);
    if (!cues.length) { cb(srt); return; }
    var src = cues.map(function (c) { return String(c.text || "").replace(/\s*\n\s*/g, " ").trim(); }).join("\n");
    var lic = getStoredLicense() || {};
    var x = new XMLHttpRequest();
    try { x.open("POST", apiRoot() + "/api.php?action=ss_translate_text", true); } catch (e) { cb(srt); return; }
    x.timeout = 120000;
    x.onload = function () {
      var trans = null;
      try { var jr = JSON.parse(x.responseText); if (jr && jr.text) trans = String(jr.text).split("\n"); } catch (e) {}
      var ok = trans && trans.length === cues.length;
      var out = "", i;
      for (i = 0; i < cues.length; i += 1) {
        var o = String(cues[i].text || "").replace(/\s*\n\s*/g, " ").trim();
        var t = ok ? String(trans[i] || "").trim() : "";
        var txt = t ? (o + "\n" + t) : o;
        out += (i + 1) + "\r\n" + srtTimecode(cues[i].start) + " --> " + srtTimecode(cues[i].end) + "\r\n" + txt + "\r\n\r\n";
      }
      cb(out);
    };
    x.onerror = x.ontimeout = function () { cb(srt); };   // translation failed → original only
    var fd = new FormData();
    fd.append("key", lic.key || ""); fd.append("text", src); fd.append("tl", target);
    try { x.send(fd); } catch (e) { cb(srt); }
  }

  function finishSubtitle(j, audioName) {
    if (state.sttMode === "transcribe") { finishTranscript(j); return; }
    if (!j.srt) { showStatus(j.message || "No speech detected in the audio.", true, true); return; }
    // Dual language: rebuild the SRT as "original\ntranslation" per cue, then continue.
    if (window.zhDualLangOn && window.zhDualLangOn() && !j._dual) {
      var dTgt = (document.getElementById("subTranslate") || {}).value || "en";
      if (dTgt) { showStatus("Adding translation…", false, false); buildDualSrt(j.srt, dTgt, function (dsrt) { j.srt = dsrt; j._dual = true; finishSubtitle(j, audioName); }); return; }
    }

    // After Effects: place timed text-layer subtitles in the composition (no caption track).
    if (state.hostIsAE) {
      var aeOff = state.aeAudioStart || 0;   // Work-Area start → shift captions to their real comp time
      var cues = srtToCues(j.srt).map(function (c) { return { text: c.text, start: c.start + aeOff, dur: Math.max(0.4, c.end - c.start) }; });
      if (!cues.length) { showStatus("No subtitles found.", true, false); return; }
      // Save the .srt next to project / Desktop too.
      try {
        var nrA = getNodeRequire();
        var sp = nrA ? nrA("path").join((state.projectDir || nrA("os").homedir() + "/Desktop"), "ZH-Subtitles-" + new Date().toISOString().slice(0,10) + ".srt") : "";
        if (sp) writeLocalTextFile(sp, j.srt);
      } catch (e) {}
      showStatus("Adding subtitles to the composition…", false, false);
      var enc = encodeURIComponent(JSON.stringify(cues));
      state.csInterface.evalScript("$.zhScriptStudio.addAESubtitles(" + JSON.stringify(enc) + "," + JSON.stringify(aeSubOptsEnc()) + ")", function (r) {
        var rr = parseHostResponse(r);
        showStatus(rr.message, !rr.ok, false);
        try { refreshQuota(); } catch (e) {}
      });
      return;
    }

    try {
      var nr = getNodeRequire();
      var stamp = new Date().toISOString().slice(0, 10);
      var srtName = (state.currentFilePath ? basename(state.currentFilePath).replace(/\.[^.]+$/, "") : "ZH-Subtitles-" + stamp) + ".srt";
      // Default save = the Premiere project folder. Fallback: temp.
      var srtPath = "";
      try {
        if (state.projectDir && nr) srtPath = nr("path").join(state.projectDir, srtName);
        else if (nr) srtPath = nr("path").join(nr("os").tmpdir(), "zh-subs-" + Date.now() + ".srt");
        else srtPath = String(audioName).replace(/\.[^.]+$/, "") + ".srt";
      } catch (e) { srtPath = String(audioName).replace(/\.[^.]+$/, "") + ".srt"; }
      writeLocalTextFile(srtPath, j.srt);
      var savedNote = state.projectDir ? " · saved " + srtName + " to project folder" : "";
      if (!state.csInterface) { showStatus("Subtitles ready → " + srtPath, false, false); return; }

      // ANIMATED mode: place each cue as a MOGRT title (active/selected template, else default).
      if (state.animatedSubs) {
        var cues = srtToCues(j.srt);
        if (!cues.length) { showStatus("No subtitles found to animate.", true, false); return; }
        var mogrtPath = normalizeLocalFilePath(state.prefs.activeTemplatePath || "") || bundledTemplatePath();
        showStatus("Placing " + cues.length + " animated subtitles…", false, false);
        state.csInterface.evalScript(
          "$.zhScriptStudio.placeAnimatedSubtitles(" + esEscape(JSON.stringify(cues)) + "," + esEscape(mogrtPath) + ")",
          function (r3) {
            var rr = parseHostResponse(r3);
            showStatus(rr.message + savedNote, !rr.ok, false);
            try { refreshQuota(); } catch (e) {}
          });
        return;
      }

      showStatus("Adding subtitles to the timeline…", false, false);
      state.csInterface.evalScript("$.zhScriptStudio.importCaptions(" + esEscape(srtPath) + ")", function (r2) {
        var rr = parseHostResponse(r2);
        showStatus(rr.message + savedNote, !rr.ok, false);
        try { refreshQuota(); } catch (e) {}
      });
    } catch (e) { showStatus("Transcribed, but could not add: " + e.message, true); }
  }

  function pollSubtitle(op, key, audioName, tries) {
    if (tries > 120) { showStatus("Transcription timed out. Try a shorter clip.", true); return; }
    var x = new XMLHttpRequest();
    var wpcEl = document.getElementById("wordsPerCue");
    var wpc = (wpcEl && wpcEl.value) || "0";
    var tlEl = document.getElementById("subTranslate");
    // Dual language: get the ORIGINAL captions from the server (tl=""), then add the
    // translation as a second line client-side (buildDualSrt). Otherwise pass tl through.
    var tl = (window.zhDualLangOn && window.zhDualLangOn()) ? "" : ((tlEl && tlEl.value) || "");
    // Poll via the relay too — same path the job was created through, immune to the direct firewall.
    x.open("GET", RELAY_BASE + "/api.php?action=stt_poll&op=" + encodeURIComponent(op) + "&key=" + encodeURIComponent(key) + "&wpc=" + encodeURIComponent(wpc) + "&tl=" + encodeURIComponent(tl), true);
    x.onload = function () {
      var j;
      try { j = JSON.parse(x.responseText); }
      catch (e) {
        // Non-JSON (transient proxy/HTML challenge/empty body). The job is still running
        // server-side — keep polling instead of killing the whole transcription.
        if (tries < 120) { showStatus("Transcribing… (" + (tries + 1) + ")", false, false); setTimeout(function () { pollSubtitle(op, key, audioName, tries + 1); }, 4000); return; }
        showStatus("Poll failed (server said: " + String(x.responseText).slice(0, 80) + ")", true); return;
      }
      if (j.status !== "success") {
        if (isQuotaMessage(j.message)) showBuyStatus(j.message);
        else showStatus("Transcribe error: " + (j.message || ""), true);
        return;
      }
      if (!j.done) { showStatus("Transcribing… (" + (tries + 1) + ")", false, false); setTimeout(function () { pollSubtitle(op, key, audioName, tries + 1); }, 4000); return; }
      finishSubtitle(j, audioName);
    };
    // Transient network drop during polling — retry rather than abort.
    x.onerror = function () {
      if (tries < 120) { setTimeout(function () { pollSubtitle(op, key, audioName, tries + 1); }, 4000); return; }
      showStatus("Poll connection lost.", true);
    };
    // Each poll transcribes ~2 audio chunks server-side (~40s). A short timeout would fire
    // a SECOND concurrent poll while the first is still working — they race, one finishes and
    // deletes the job files, the other reports "Job expired". Keep it well above the work time.
    x.timeout = 120000;
    x.ontimeout = function () {
      if (tries < 120) { setTimeout(function () { pollSubtitle(op, key, audioName, tries + 1); }, 4000); return; }
      showStatus("Poll timed out.", true);
    };
    x.send();
  }

  // Build a timecoded .srt from selected text (or whole script) and save it next to the file.
  // Split phrase cues into N-word groups, distributing each phrase's real [start,dur] across its
  // groups by word share — so word-by-word captions stay inside the phrase's true voice window.
  function splitCuesToWords(cues, wpc) {
    var out = [], i, g;
    for (i = 0; i < cues.length; i += 1) {
      var words = String(cues[i].text || "").split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      var groups = [];
      for (g = 0; g < words.length; g += wpc) groups.push(words.slice(g, g + wpc).join(" "));
      var gdur = cues[i].dur / groups.length;
      for (g = 0; g < groups.length; g += 1) out.push({ text: groups[g], start: cues[i].start + g * gdur, dur: Math.max(0.25, gdur) });
    }
    return out;
  }
  function generateSubtitles() {
    var source = getSelectedText().trim();
    if (!source) source = (els.documentSurface.innerText || "").trim();
    if (!source) { showStatus("Open or select script text first.", true, true); return; }

    var wpc = parseInt((document.getElementById("wordsPerCue") || {}).value || "0", 10) || 0;
    var cues;
    // If the opened file is an SRT, use its REAL timecodes (synced to voice) instead of estimating.
    // Split each cue to N words (Words/line) so word-by-word stays on the phrase's real time window.
    var srtCues = state.srtRaw ? srtToCues(state.srtRaw) : [];
    if (srtCues.length) {
      cues = srtCues.map(function (c) { return { text: c.text, start: c.start, dur: Math.max(0.4, c.end - c.start) }; });
      if (wpc >= 1 && wpc <= 4) cues = splitCuesToWords(cues, wpc);
      showStatus("Captions placed on the SRT's real timing" + (wpc ? " (" + wpc + " word/line)" : "") + ".", false, true);
    } else {
      var lines = splitIntoCues(source);
      if (!lines.length) { showStatus("No text to caption.", true, true); return; }
      var baseDur = parseFloat(els.durationInput && els.durationInput.value) || 0;
      cues = []; var cursor = 0;
      for (var i = 0; i < lines.length; i += 1) {
        // reading-speed estimate (~14 chars/sec) unless user forced a fixed Dur
        var dur = baseDur >= 0.5 ? baseDur : Math.max(1.2, Math.min(7, lines[i].length / 14));
        cues.push({ text: lines[i], start: cursor, dur: dur });
        cursor += dur;
      }
    }

    // After Effects has no caption track — build timed subtitle text layers instead.
    if (state.hostIsAE && state.csInterface) {
      var enc = encodeURIComponent(JSON.stringify(cues));
      state.csInterface.evalScript("$.zhScriptStudio.addAESubtitles(" + JSON.stringify(enc) + "," + JSON.stringify(aeSubOptsEnc()) + ")", function (result) {
        var resp = parseHostResponse(result);
        showStatus(resp.message, !resp.ok, false);
      });
      return;
    }

    // Premiere / file workflow → timecoded .srt for a caption track.
    var srt = "";
    for (var j = 0; j < cues.length; j += 1) {
      srt += (j + 1) + "\r\n" + srtTimecode(cues[j].start) + " --> " + srtTimecode(cues[j].start + cues[j].dur) +
        "\r\n" + cues[j].text + "\r\n\r\n";
    }
    var outPath = subtitleOutputPath();
    if (!outPath) { showStatus("Open the script from disk first so I know where to save the .srt.", true, true); return; }
    try {
      writeLocalTextFile(outPath, srt);
      showStatus("Generated " + cues.length + " subtitles → " + basename(outPath) + ". In Premiere: File ▸ Import this .srt, then drag it to a caption track.", false, false);
    } catch (e) {
      showStatus("Could not save subtitles: " + e.message, true);
    }
  }

  // Split full script text into short subtitle cues: by line, sentence (. ! ? । ;), then wrap long ones.
  // Function words that read awkwardly when left dangling at the END of a caption
  // line — we prefer to push them onto the next line. English set; the check is a
  // no-op for other languages, which still benefit from the punctuation/length logic.
  var CUE_DANGLE_SET = (function () {
    var s = {}, w = ("a an the and or but nor so yet for of to in on at by as is are was were be been with from into onto " +
      "that this these those my your his her its our their if than then who which what when while because about over " +
      "under per not no do does did has have had will would can could should may might must").split(" ");
    for (var i = 0; i < w.length; i += 1) s[w[i]] = 1;
    return s;
  })();
  function cueWordKey(w) { return String(w).toLowerCase().replace(/[^a-z0-9]+/gi, ""); }

  // Grammar-aware line builder: greedily fills up to ~maxChars, breaks right after
  // strong internal punctuation (a natural pause) once the line is half full, and
  // never ends a line on a dangling function word — it slides that word down instead.
  function smartSplitSentence(sentence, maxChars) {
    var words = sentence.split(/\s+/).filter(Boolean);
    var lines = [], i = 0;
    while (i < words.length) {
      var line = [words[i]], j = i + 1;
      while (j < words.length) {
        if ((line.join(" ") + " " + words[j]).length > maxChars) break;
        line.push(words[j]); j += 1;
        if (/[,;:।—-]$/.test(words[j - 1]) && line.join(" ").length >= maxChars * 0.5) break;
      }
      while (line.length > 1 && j < words.length && CUE_DANGLE_SET[cueWordKey(line[line.length - 1])]) {
        j -= 1; line.pop();
      }
      lines.push(line.join(" "));
      i = j;
    }
    return lines;
  }

  function splitIntoCues(text) {
    text = String(text || "").replace(/\r/g, "").trim();
    if (!text) return [];
    var MAX = 42;   // broadcast-standard single caption line length
    var cues = [];
    text.split(/\n+/).forEach(function (block) {
      block = block.trim();
      if (!block) return;
      // each sentence is a natural pause boundary — never merge two into one cue
      var sentences = block.match(/[^.!?।;]+[.!?।;]+|[^.!?।;]+$/g) || [block];
      sentences.forEach(function (s) {
        s = s.trim();
        if (!s) return;
        smartSplitSentence(s, MAX).forEach(function (piece) { if (piece) cues.push(piece); });
      });
    });
    return cues;
  }

  function subtitleOutputPath() {
    if (state.currentFilePath) return state.currentFilePath.replace(/\.[^.\/\\]+$/, "") + ".srt";
    // fallback: Desktop
    try {
      if (state.csInterface) {
        var sep = "/";
        return state.csInterface.getSystemPath(SystemPath.USER_DATA).replace(/[^\/\\]+[\/\\]?$/, "") + sep + "ZH-Subtitles.srt";
      }
    } catch (e) {}
    return "";
  }

  function srtTimecode(totalSeconds) {
    var ms = Math.round(totalSeconds * 1000);
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var s = Math.floor(ms / 1000); ms -= s * 1000;
    function p(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
    return p(h, 2) + ":" + p(m, 2) + ":" + p(s, 2) + "," + p(ms, 3);
  }

  function writeLocalTextFile(filePath, text) {
    var nodeRequire = getNodeRequire();
    if (nodeRequire) { nodeRequire("fs").writeFileSync(filePath, text, "utf8"); return; }
    if (window.cep && window.cep.fs && typeof window.cep.fs.writeFile === "function") {
      var r = window.cep.fs.writeFile(filePath, text, window.cep.encoding && window.cep.encoding.UTF8);
      if (r && r.err !== 0) throw new Error("CEP write error " + r.err + ".");
      return;
    }
    throw new Error("File writing is unavailable in this runtime.");
  }

  // Colour / highlight / clear the currently selected text in the document.
  function colorSelection(value) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      showStatus("Select text in the script first.", true, true);
      return;
    }
    var range = sel.getRangeAt(0);
    if (!els.documentSurface.contains(range.commonAncestorContainer)) {
      showStatus("Select text inside the script.", true, true);
      return;
    }

    // RESET: unwrap any colour/highlight marks touching the selection (true clear).
    if (value === "reset") {
      var marks = els.documentSurface.querySelectorAll(".zh-mark");
      var cleared = 0;
      Array.prototype.forEach.call(marks, function (m) {
        var touches = false;
        try { touches = range.intersectsNode(m); } catch (e) { touches = range.commonAncestorContainer === m || m.contains(range.commonAncestorContainer); }
        if (touches) {
          var parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
          parent.removeChild(m);
          parent.normalize();
          cleared += 1;
        }
      });
      sel.removeAllRanges();
      showStatus(cleared ? "Cleared colour." : "No coloured text in the selection.", false, true);
      return;
    }

    var span = document.createElement("span");
    span.className = "zh-mark";
    if (value === "hl-yellow") { span.style.backgroundColor = "#fff59d"; span.style.color = "#1a1206"; }
    else { span.style.color = value; }
    try {
      range.surroundContents(span);
    } catch (e) {
      try {
        var frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
      } catch (e2) {
        showStatus("Could not mark this selection (spans mixed formatting).", true, true);
        return;
      }
    }
    sel.removeAllRanges();
    showStatus(value === "reset" ? "Cleared colour." : "Marked selected text.", false, true);
  }

  function parseHostResponse(result) {
    try {
      var parsed = JSON.parse(result) || {};
      parsed.ok = Boolean(parsed.ok);
      parsed.message = parsed.message || (parsed.ok ? "Done." : "Timeline paste failed.");
      return parsed; // keep all fields (path, placed, count, …)
    } catch (error) {
      return {
        ok: false,
        message: result || "Timeline paste failed."
      };
    }
  }

  async function writeClipboardText(text) {
    // navigator.clipboard is often permission-denied inside CEP — fall through to execCommand.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (e) { /* fall through to execCommand */ }
    }

    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    var copied = document.execCommand("copy");
    document.body.removeChild(textarea);

    if (!copied) {
      throw new Error("clipboard copy was blocked");
    }
  }

  function showStatus(message, isError, autoClear) {
    els.statusMessage.textContent = message;
    els.statusMessage.classList.toggle("error", Boolean(isError));
    els.statusMessage.classList.add("visible");

    if (autoClear) {
      window.setTimeout(function () {
        if (els.statusMessage.textContent === message) {
          clearStatus();
        }
      }, 2500);
    }
  }

  function clearStatus() {
    els.statusMessage.textContent = "";
    els.statusMessage.classList.remove("visible", "error");
  }

  // True when the server says the monthly Auto Subtitle minutes are used up.
  function isQuotaMessage(msg) {
    return /limit reached|min left|minutes? left|add-?on at|resets on/i.test(String(msg || ""));
  }

  // Open a URL in the user's default browser (CEP — no in-panel navigation).
  function openExternal(url) {
    try { if (state.csInterface && state.csInterface.openURLInDefaultBrowser) { state.csInterface.openURLInDefaultBrowser(url); return; } } catch (e) {}
    try { if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) { window.cep.util.openURLInDefaultBrowser(url); return; } } catch (e) {}
    try { window.open(url, "_blank"); } catch (e) {}
  }

  // Out-of-minutes: show the limit message + an "Upgrade" action that sends a request
  // straight to the admin (who approves → minutes raised), plus a "buy on site" fallback.
  function showBuyStatus(message) {
    els.statusMessage.innerHTML = "";
    els.statusMessage.classList.add("error", "visible");
    var span = document.createElement("span");
    span.textContent = (message || "Auto Subtitle minutes finished for this month.") + "  ";
    var btn = document.createElement("a");
    btn.href = "#";
    btn.textContent = "⬆ Request upgrade";
    btn.style.cssText = "color:#ffd34d;font-weight:700;text-decoration:underline;cursor:pointer;";
    btn.onclick = function (e) { e.preventDefault(); requestUpgrade(); };
    var sep = document.createElement("span");
    sep.textContent = "  ·  ";
    var shop = document.createElement("a");
    shop.href = "#";
    shop.textContent = "buy on site";
    shop.style.cssText = "color:#ffd34d;text-decoration:underline;cursor:pointer;opacity:0.85;";
    shop.onclick = function (e) { e.preventDefault(); openExternal("https://zhmotions.com/shop"); };
    els.statusMessage.appendChild(span);
    els.statusMessage.appendChild(btn);
    els.statusMessage.appendChild(sep);
    els.statusMessage.appendChild(shop);
  }

  // Fallback plans if the server list can't be fetched (admin edits the live list in admin.html).
  var DEFAULT_UPGRADE_PLANS = [
    { label: "+150 minutes / month", minutes: 150, price: 999, sub: "valid 1 year" },
    { label: "Unlimited — 1000 min/mo", minutes: 1000, price: 1500, sub: "valid 1 year" }
  ];

  // Open the upgrade flow: pick plan → pay to the shown number → paste Transaction ID → send.
  function requestUpgrade() {
    var lic = getStoredLicense();
    if (!lic || !lic.key) { showStatus("Activate your license first.", true, true); return; }
    openUpgradeModal(lic.key);
  }

  function openUpgradeModal(key) {
    var old = document.getElementById("ssUpModal"); if (old) old.remove();
    var ov = document.createElement("div");
    ov.id = "ssUpModal";
    ov.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;background:rgba(0,0,0,0.72);z-index:100000;display:flex;align-items:center;justify-content:center;padding:14px;font-family:inherit;box-sizing:border-box;";
    var box = document.createElement("div");
    box.style.cssText = "background:#1b1b1b;color:#eee;border:1px solid #d4a017;border-radius:14px;max-width:330px;width:100%;padding:18px;font-size:13px;max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.6);";
    ov.appendChild(box);
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });

    function header() {
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">'
        + '<span style="font-weight:800;color:#ffd34d;font-size:15px;flex:1;">Upgrade Auto Subtitle</span>'
        + '<span id="ssUpClose" style="cursor:pointer;opacity:.6;font-size:16px;">✕</span></div>';
    }

    var plans = DEFAULT_UPGRADE_PLANS.slice();

    // Stage 1 — plan choice.
    function renderPlans() {
      var html = header() + '<div style="color:#aaa;margin-bottom:12px;">Pick a plan:</div>';
      plans.forEach(function (p, i) {
        html += '<div class="ssUpPlan" data-i="' + i + '" style="border:1px solid #444;border-radius:10px;padding:11px 12px;margin-bottom:9px;cursor:pointer;display:flex;align-items:center;gap:10px;">'
          + '<div style="flex:1;"><div style="font-weight:700;color:#fff;">' + escapeHtml(p.label) + '</div>'
          + '<div style="color:#aaa;font-size:11px;">' + escapeHtml(p.sub || "") + '</div></div>'
          + '<div style="font-weight:800;color:#ffd34d;">৳' + p.price + '</div></div>';
      });
      box.innerHTML = html;
      box.querySelector("#ssUpClose").onclick = function () { ov.remove(); };
      Array.prototype.forEach.call(box.querySelectorAll(".ssUpPlan"), function (el) {
        el.onclick = function () { renderPay(plans[parseInt(el.getAttribute("data-i"), 10)]); };
      });
    }

    // Stage 2 — payment + Transaction ID.
    function renderPay(plan) {
      box.innerHTML = header()
        + '<div style="background:#241c05;border:1px solid #6b520a;border-radius:10px;padding:11px;margin-bottom:11px;">'
        + '<div style="font-weight:700;color:#fff;">' + plan.label + ' — <span style="color:#ffd34d;">৳' + escapeHtml(String(plan.price)) + '</span></div>'
        + '<div id="ssUpPayInfo" style="color:#cbb; font-size:12px; margin-top:7px;">Loading payment number…</div></div>'
        + '<label style="color:#aaa;">Transaction ID (from bKash/Nagad)</label>'
        + '<input id="ssUpTrx" type="text" placeholder="e.g. 9KZ7A1B2C3" style="width:100%;margin:5px 0 10px;padding:8px;border-radius:8px;border:1px solid #555;background:#111;color:#fff;">'
        + '<label style="color:#aaa;">Note (optional — sender number etc.)</label>'
        + '<input id="ssUpNote" type="text" placeholder="optional" style="width:100%;margin:5px 0 12px;padding:8px;border-radius:8px;border:1px solid #555;background:#111;color:#fff;">'
        + '<div style="display:flex;gap:8px;">'
        + '<button id="ssUpBack" style="flex:0 0 auto;padding:9px 12px;border-radius:9px;border:1px solid #555;background:#222;color:#ccc;cursor:pointer;">← Back</button>'
        + '<button id="ssUpSend" style="flex:1;padding:9px;border-radius:9px;border:0;background:#d4a017;color:#1a1300;font-weight:800;cursor:pointer;">Send request</button></div>'
        + '<div id="ssUpMsg" style="margin-top:9px;font-size:12px;min-height:14px;"></div>';
      box.querySelector("#ssUpClose").onclick = function () { ov.remove(); };
      box.querySelector("#ssUpBack").onclick = renderPlans;

      // Fetch the live payment number (falls back to default).
      var info = box.querySelector("#ssUpPayInfo");
      var fb = "bKash / Nagad: <b style='color:#fff;'>01811199175</b> (Send Money)";
      try {
        var pq = new XMLHttpRequest();
        pq.open("GET", STT_API + "?action=pay_accounts_get&_=" + Date.now(), true);
        pq.timeout = 8000;
        pq.onload = function () {
          var txt = fb;
          try {
            var j = JSON.parse(pq.responseText);
            if (j && Array.isArray(j.accounts)) {
              var lines = j.accounts
                .filter(function (a) { return a && a.value && String(a.value).trim(); })
                .map(function (a) { return escapeHtml(a.label) + ": <b style='color:#fff;'>" + escapeHtml(a.value) + "</b>"; });
              if (lines.length) txt = lines.join("<br>");
            } else if (j && j.raw) {
              txt = escapeHtml(j.raw).replace(/\n/g, "<br>");
            }
          } catch (e) {}
          info.innerHTML = "Send <b style='color:#ffd34d;'>৳" + escapeHtml(String(plan.price)) + "</b> (Send Money) to:<br>" + txt + "<br><span style='color:#9a9;'>Then paste the Transaction ID below.</span>";
        };
        pq.onerror = pq.ontimeout = function () { info.innerHTML = "Send <b style='color:#ffd34d;'>৳" + escapeHtml(String(plan.price)) + "</b> to:<br>" + fb; };
        pq.send();
      } catch (e) { info.innerHTML = "Send ৳" + escapeHtml(String(plan.price)) + " to:<br>" + fb; }

      box.querySelector("#ssUpSend").onclick = function () {
        var trx = box.querySelector("#ssUpTrx").value.trim();
        var note = box.querySelector("#ssUpNote").value.trim();
        var msg = box.querySelector("#ssUpMsg");
        if (!trx) { msg.style.color = "#ff8a8a"; msg.textContent = "Enter the Transaction ID after paying."; return; }
        msg.style.color = "#aaa"; msg.textContent = "Sending…";
        var x = new XMLHttpRequest();
        x.open("POST", STT_API + "?action=ss_upgrade_request", true);
        x.timeout = 15000;
        x.onload = function () {
          var ok = false, m = "Request sent! Admin will confirm and add minutes.";
          try { var j = JSON.parse(x.responseText); ok = (j && j.status === "success"); if (j && j.message) m = j.message; } catch (e) { ok = true; }
          msg.style.color = ok ? "#7CFC9A" : "#ff8a8a"; msg.textContent = m;
          if (ok) { setTimeout(function () { ov.remove(); showStatus(m, false, false); }, 1400); }
        };
        x.onerror = function () { msg.style.color = "#ff8a8a"; msg.textContent = "Couldn't reach server — try again."; };
        x.ontimeout = function () { msg.style.color = "#ff8a8a"; msg.textContent = "Timed out — try again."; };
        var fd = new FormData();
        fd.append("key", key);
        fd.append("plan", plan.label);
        fd.append("minutes", plan.minutes);
        fd.append("price", plan.price);
        fd.append("trxid", trx);
        fd.append("note", note);
        x.send(fd);
      };
    }

    // Pull the admin-editable plan list, then show the chooser (fallback to defaults).
    box.innerHTML = header() + '<div style="color:#aaa;">Loading plans…</div>';
    document.body.appendChild(ov);
    try {
      var pl = new XMLHttpRequest();
      pl.open("GET", STT_API + "?action=ss_plans_get&_=" + Date.now(), true);
      pl.timeout = 8000;
      pl.onload = function () {
        try { var j = JSON.parse(pl.responseText); if (j && j.plans && j.plans.length) plans = j.plans; } catch (e) {}
        renderPlans();
      };
      pl.onerror = pl.ontimeout = function () { renderPlans(); };
      pl.send();
    } catch (e) { renderPlans(); }
  }

  function setBusy(isBusy) {
    els.openButton.disabled = isBusy;
    els.openButton.textContent = isBusy ? "Opening..." : "Open";
  }

  function showEmptyState(message) {
    els.documentSurface.className = "document-surface empty-state";
    els.documentSurface.innerHTML = "";
    var paragraph = document.createElement("p");
    paragraph.textContent = message;
    els.documentSurface.appendChild(paragraph);
  }

  function hasExtension(pathOrName, extension) {
    return String(pathOrName || "").toLowerCase().endsWith(extension);
  }

  function isWordLockFile(pathOrName) {
    return basename(pathOrName).indexOf("~$") === 0;
  }

  function normalizeLocalFilePath(pathOrUrl) {
    var value = String(pathOrUrl || "").trim();
    if (!/^file:\/\//i.test(value)) {
      return value;
    }

    try {
      var parsed = new URL(value);
      value = decodeURIComponent(parsed.pathname || "");
    } catch (error) {
      value = value.replace(/^file:\/\/localhost/i, "").replace(/^file:\/\//i, "");
      try {
        value = decodeURIComponent(value);
      } catch (decodeError) {
        value = value.replace(/%20/g, " ");
      }
    }

    if (/^\/[A-Za-z]:\//.test(value)) {
      value = value.slice(1);
    }

    return typeof value.normalize === "function" ? value.normalize("NFC") : value;
  }

  function basename(pathOrName) {
    return normalizeLocalFilePath(pathOrName).split(/[\\/]/).pop();
  }

  function base64ToArrayBuffer(base64) {
    var binary = window.atob(base64);
    var length = binary.length;
    var bytes = new Uint8Array(length);
    for (var index = 0; index < length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  function scrubCssUrls(root) {
    var styleElements = Array.prototype.slice.call(root.querySelectorAll("style"));
    styleElements.forEach(function (styleElement) {
      styleElement.textContent = scrubCssText(styleElement.textContent || "");
    });

    var styledElements = Array.prototype.slice.call(root.querySelectorAll("[style]"));
    styledElements.forEach(function (styledElement) {
      styledElement.setAttribute("style", scrubCssText(styledElement.getAttribute("style") || ""));
    });
  }

  function scrubCssText(cssText) {
    return cssText
      .replace(/@import[^;]+;/gi, "")
      .replace(/expression\s*\([^)]*\)/gi, "")
      .replace(/url\(\s*(['"]?)(?!data:image\/|blob:|#)[^)]+?\1\s*\)/gi, "url(\"\")");
  }

  function sanitizeFontFamily(value) {
    return String(value || DEFAULT_PREFS.fontFamily).replace(/[;"<>]/g, "").trim() || DEFAULT_PREFS.fontFamily;
  }

  function quoteFontFamily(value) {
    var names = sanitizeFontFamily(value).split(",").map(function (font) {
      var trimmed = font.trim();
      if (!trimmed) {
        return "";
      }
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(trimmed)) {
        return trimmed;
      }
      return "\"" + trimmed.replace(/"/g, "") + "\"";
    }).filter(Boolean);

    if (!names.length) {
      names.push("\"" + DEFAULT_PREFS.fontFamily + "\"");
    }
    if (!/serif|sans-serif|monospace|cursive|fantasy|system-ui/i.test(names[names.length - 1])) {
      names.push("sans-serif");
    }
    return names.join(", ");
  }

  function clampNumber(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function normalizeColor(value, fallback) {
    var color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isCepRuntime() {
    return Boolean(window.__adobe_cep__);
  }
}());
