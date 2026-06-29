# ZH Script Studio v3.0 — DRAFT (not released)

Status: **draft / next update.** Current live build = 2.0.56. Do NOT ship until
tested in real Premiere + After Effects.

## What's new

### Fresh, document-centric UI
- Rebuilt as a tabbed dock: **Titles · Captions · Templates**, with the script
  surface always visible so select-then-act never breaks.
- New dark + gold theme, card/chip controls (AutoCaption-grade look).
- Doc toolbar: Open · Find-in-script · Edit · Save · Close.
- ⚙ Display settings + Help/Terms/License preserved.

### Bengali-first (the differentiator)
- **⇄ Bijoy → Unicode** converter — paste/open legacy Bijoy (SutonnyMJ) Bengali,
  it auto-converts to Unicode. Core map + left-vowel reorder. Verified on
  আমি / বাংলা / কেমন / আপনি / সবাই / দিন.
- **Dual বাংলা+EN** caption toggle (UI + state; host stacking = Phase 3).
- Bengali fonts already bundled (Noto Sans/Serif Bengali, Vrinda).

### Captions
- **Style chips:** Pop · Karaoke · Type-on · Slide · Fade. Karaoke reuses
  1-word-per-caption (wpc=1). Pop/Type/Slide/Fade map to existing AE styles.
- Spoken language + Translate-to + Words/line preserved (7 languages each).

## Unchanged / preserved (no regression)
All 70 element IDs + functional classes kept → app.js logic untouched. Open,
+Title, Batch, Marker, Copy, Auto Subtitle, Transcribe, From-script, templates,
mark-text colours, reading settings, license, quota, update bar, review prompt.

## Pending — Phase 3 (needs host.jsx + real Premiere/AE test)
- Karaoke per-word highlight (active word colour in host)
- Hormozi keyword highlight (bold/scale keywords)
- Glow caption style
- Dual-language host stacking (two caption layers)
- aeStyleBtn vs cstyle-btn dedupe

## Files changed
- `client/index.html` — new layout (rewrite, IDs preserved)
- `client/css/styles.css` — v3 theme appended
- `client/js/v3-ui.js` — dock tab switching (new)
- `client/js/v3-features.js` — Bijoy converter + style/toggle wiring (new)
- `client/js/app.js` — 3 hooks: caption style read ×2, Bijoy on renderPlainText
- `CSXS/manifest.xml` — 3.0.0
- Backups: `_v2backup/` (instant revert)
