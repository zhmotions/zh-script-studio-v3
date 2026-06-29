# v3.0 deploy checklist (run when approved — NOT yet)

Current live = 2.0.56. v3.0 is staged as draft only.

## 1. Test in real apps (must pass before ship)
- [ ] Premiere: Open .docx/.txt/.srt → renders, select text works
- [ ] +Title / Batch / Marker / Copy → timeline
- [ ] Auto Subtitle (open sequence audio) → captions, quota shows
- [ ] Transcribe, From script
- [ ] Style chips (Pop/Karaoke/Type-on/Slide/Fade) apply
- [ ] Spoken + Translate + Words chips
- [ ] Bijoy toggle → open Bijoy .txt → shows Unicode
- [ ] Templates dock → Browse online → card grid + preview + download
- [ ] ⚙ Display settings (font incl. Bengali, size, colours, zoom)
- [ ] Help/Terms/License modal, license activate/change-key
- [ ] After Effects: titles + AE subtitles + aeStyle
- [ ] Dock tab switching, theme toggle, no console errors

## 2. Ship (after tests pass)
- [ ] Final deploy to installed `/Library/.../ZH Script Studio/` for last check
- [ ] Push source → github.com/zhmotions/zh-script-studio (scratchpad clone)
- [ ] GitHub release `v3.0.0` + `ZHScriptStudio-v3.0.0.zxp`
- [ ] Upload `ZHScriptStudio.zxp` → `public_html/scriptstudio/`
- [ ] api.php `SS_LATEST` 2.0.56 → 3.0.0 (line ~3085, line-targeted sed, `php -l`)
- [ ] Verify live: ss_version 3.0.0, download serves new zxp

## 3. Rollback (if needed)
- `_v2backup/index.html.v2backup` + `app.js.v2backup` → restore, rebuild, repackage
- Or reinstall 2.0.56 zxp

## Draft artifacts (ready now)
- `~/Desktop/ZHScriptStudio-3.0.0-DRAFT.zxp` (signed, NOT installed)
- `dist/` built at 3.0.0
- Source: client/ updated, `_v2backup/` safe
