// ZH Script Studio v3.0 — new feature helpers (loaded before app.js; CSP script-src 'self').
// 1) Bijoy (legacy ASCII) → Bengali Unicode converter
// 2) caption Style chips + Bijoy / Dual-language toggles, wired into the existing flow.
(function () {
  "use strict";

  /* ─── 1. Bijoy → Unicode ─────────────────────────────────────────────
     Core SutonnyMJ/Bijoy ASCII map + left-vowel reorder. Covers common
     Bengali text; complex conjuncts may need follow-up with real samples. */
  var MULTI = [
    ["c·", "ৎ"], ["q¡", "ক্ষ"], ["k¦", "ঞ্জ"], ["–", "্র"], ["ª", "্য"], ["©", "র্"]
  ];
  var MAP = {
    // vowels (independent)
    "A": "অ", "Av": "আ", "B": "ই", "C": "ঈ", "D": "উ", "E": "ঊ", "F": "ঋ",
    "G": "এ", "H": "ঐ", "I": "ও", "J": "ঔ",
    // consonants
    "K": "ক", "L": "খ", "M": "গ", "N": "ঘ", "O": "ঙ",
    "P": "চ", "Q": "ছ", "R": "জ", "S": "ঝ", "T": "ঞ",
    "U": "ট", "V": "ঠ", "W": "ড", "X": "ঢ", "Y": "ণ",
    "Z": "ত", "_": "থ", "`": "দ", "a": "ধ", "b": "ন",
    "c": "প", "d": "ফ", "e": "ব", "f": "ভ", "g": "ম",
    "h": "য", "i": "র", "j": "ল", "k": "শ", "l": "ষ",
    "m": "স", "n": "হ", "o": "ড়", "p": "ঢ়", "q": "য়",
    // vowel signs (kar)
    "v": "া", "w": "ি", "x": "ী", "y": "ু", "z": "ূ", "…": "ৃ",
    "‡": "ে", "ˆ": "ৈ", "Š": "ো", "Œ": "ৌ",
    // signs
    "s": "ং", "t": "ঃ", "u": "ঁ", "&": "্", "ª": "্য", "©": "র্",
    // digits
    "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪",
    "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯"
  };
  var LEFT_VOWELS = "িেৈোৌ"; // rendered left of consonant → in Bijoy they precede it

  function bijoyToUnicode(input) {
    var s = String(input == null ? "" : input);
    var i, out = s;
    for (i = 0; i < MULTI.length; i += 1) out = out.split(MULTI[i][0]).join(MULTI[i][1]);
    // longest-key first so multi-char ASCII (e.g. "Av") wins over "A"
    var keys = Object.keys(MAP).sort(function (a, b) { return b.length - a.length; });
    var res = "", n = out.length;
    for (i = 0; i < n;) {
      var hit = null;
      for (var k = 0; k < keys.length; k += 1) {
        if (out.substr(i, keys[k].length) === keys[k]) { hit = keys[k]; break; }
      }
      if (hit) { res += MAP[hit]; i += hit.length; }
      else { res += out[i]; i += 1; }
    }
    // reorder: a left-vowel that sits BEFORE a consonant moves AFTER it
    res = res.replace(new RegExp("([" + LEFT_VOWELS + "])([কখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়])", "g"),
      function (_, v, c) { return c + v; });
    return res;
  }
  window.ZHBijoy = { toUnicode: bijoyToUnicode };

  /* ─── 2. Caption style chips + toggles ──────────────────────────────── */
  function activate(group, btn) {
    group.forEach(function (b) { b.classList.toggle("active", b === btn); });
  }
  document.addEventListener("DOMContentLoaded", function () {
    // style chips → hidden #captionStyle. Karaoke = 1 word/caption (reuse wpc=1).
    var styleBtns = Array.prototype.slice.call(document.querySelectorAll(".cstyle-btn"));
    var styleHidden = document.getElementById("captionStyle");
    styleBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        activate(styleBtns, b);
        var v = b.getAttribute("data-style");
        if (styleHidden) styleHidden.value = v;
        if (v === "karaoke") {
          var w1 = document.querySelector('.wpc-btn[data-wpc="1"]');
          if (w1) w1.click();
        }
      });
    });
  });

  // app.js reads this for the host animation style. Karaoke is driven by wpc=1,
  // so the underlying clip animation falls back to a real AE style (pop).
  window.zhCaptionStyle = function () {
    var el = document.getElementById("captionStyle");
    var s = el && el.value ? el.value : "pop";
    return s === "karaoke" ? "pop" : s;
  };
  window.zhBijoyOn = function () {
    var el = document.getElementById("bijoyToggle");
    return !!(el && el.checked);
  };
  window.zhDualLangOn = function () {
    var el = document.getElementById("dualLangToggle");
    return !!(el && el.checked);
  };
})();
