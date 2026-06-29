// ZH Script Studio v3.0 — dock tab switching (visual only; all feature logic lives in app.js).
// Loaded as an external file because the panel CSP is script-src 'self' (no inline scripts).
(function () {
  document.addEventListener("click", function (e) {
    var t = e.target.closest(".v3-tab");
    if (!t) return;
    var dock = t.getAttribute("data-dock");
    document.querySelectorAll(".v3-tab").forEach(function (x) {
      x.classList.toggle("active", x === t);
    });
    document.querySelectorAll(".v3-pane").forEach(function (p) {
      p.classList.toggle("active", p.getAttribute("data-dockpane") === dock);
    });
  });
})();
