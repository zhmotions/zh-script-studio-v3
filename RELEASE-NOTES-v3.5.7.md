# ZH Script Studio v3.5.7

First non-beta release.

## Viral caption styles (Bengali-safe)
- **Hormozi** — yellow word-by-word reveal (Based-On-Words selector, Ease Low 100, fills-over-strokes)
- **Karaoke, Beasty, Spotlight, Letter Rise** — one whole word per cue (clean, no mid-letter paint, no Bengali conjunct break)
- **Neon, Chrome, Pop, Clean** — whole-layer effects
- No text-animator selector splits Bengali glyphs anymore

## Auto Subtitle
- Long videos now **finish reliably** — 1 chunk per poll + progress saved after each chunk, so a gateway-killed poll never loses work or gets stuck
- Captions no longer overlap (cues time-sorted, out-point clamped to next cue)

## Templates
- Online templates show a **live animated preview** (video thumbnail, like Premiere's Essential Graphics)

## Distribution
- Download is now a **.zip** (holds the .zxp + install readme) so Mac cleaners / Gatekeeper stop deleting the raw .zxp
- License emails link to the zip; bundle keys list a download button per app

## v3.5.7
- Online template video previews now actually play in the card (CEF muted-autoplay enabled).
