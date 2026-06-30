# ZH Script Studio v3.2.7 — BETA

Release date: 2026-06-30 · Status: **BETA** (verify the AE-specific animations in your After Effects build)

---

## ✨ New in 3.2.0

### Caption Style cards (discoverable, viral-ready)
The Captions tab now shows the styles as big selectable cards (replacing the small chips):
- **Karaoke** — each word highlights gold as spoken (1 word/line).
- **Hormozi** — bold keyword pop: power words auto-highlighted **yellow** + enlarged on each caption (built-in EN + Bangla power-word list).
- **Pop / Bounce** — scale punch in.
- **Clean** — minimal subtle fade.

Picking a card just works (no separate Animated toggle needed). Applies to both **Auto Subtitle** and **From-script** captions in After Effects.

### Templates tab
- Card grid pulls the **online catalog with preview thumbnails**; hover a card to **play the .mp4 preview** (fixed: play now waits for load).
- Previews matched by **name** so they show even when host (ppro/ae) differs.
- Search + filters (All / Titles / Lower-third / ★ Saved) + Add-your-own (Browse / File).

### Title effects
- **Effect chip wins on insert** — no Animated-toggle dependency. "None" = static (or use the active .ffx template's own animation).
- **Realistic Bounce system** — decaying-sine expression (overshoot → settle) on Scale + Position; tunable; keyframe fallback.
- **Glow** fixed (radius was invisible) · **Slide** = reliable whole-line slide-up · **Hormozi title** = marked (🎨) words pop yellow.

### Removed
- Copy button (unused).

## 🔧 Fixes (this cycle)
- Dual বাংলা/EN translation (line-count preserved).
- "Job expired" on long transcribe → idempotent finish.
- Long-audio STT memory crash → seek-read chunks.
- Settings panel size + open/close toggle.
- 3D-layer pop/scale crash · effect "stuck on Pop" · eval→JSON.parse · price escape.
- New hardened relay **api-relay-2** (path allowlist); old relay untouched for installed clients.

## ⚠️ Beta caveats (need real-AE verification)
- Hormozi/Karaoke keyword highlight uses AE Range-Selector property names that can vary by AE version — all wrapped with fallbacks (worst case: animates without the colour, no crash).
- Glow uses the Glow effect (`ADBE Glo2`); bounce uses an expression (auto-falls back to keyframes if expressions are disabled).
- Caption styles affect **AE text-layer** subtitles; Premiere caption-track text can't be per-word styled.

## Deploy (in order)
1. Cloudflare → Worker **api-relay-2** → paste `api-relay-2-worker.js` → Deploy.
2. Hostinger → upload `public_html/api.php`.
3. Install `ZHScriptStudio-v3.2.7-beta.zxp` (delete the old CEP extension folder first so it refreshes) → restart Premiere/AE.

## Files
- `ZHScriptStudio-v3.2.7-beta.zxp`
- `public_html/api.php`
- `api-relay-2-worker.js`
