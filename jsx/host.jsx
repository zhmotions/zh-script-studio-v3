/* global app, $, CompItem, Sequence, File, Folder */
/*
 * ZH Script Studio — host bridge (Premiere Pro + After Effects).
 * Sends document text to the active timeline as captions, batch subtitles,
 * styled text layers, or markers. UTF-8 throughout for Bengali/Unicode scripts.
 */
(function () {
  function safeString(value) {
    if (value === undefined || value === null) return "";
    return String(value);
  }

  function json(ok, message, extra) {
    var out = { ok: ok, message: message };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) out[k] = extra[k]; } }
    return JSON.stringify(out);
  }

  function cleanTimelineText(value) {
    return safeString(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");
  }

  function parseOptions(optionsJson) {
    var o = {};
    try { o = JSON.parse(decodeURIComponent(safeString(optionsJson))) || {}; } catch (e) { o = {}; }
    return {
      durationSeconds: Math.max(0.3, parseFloat(o.durationSeconds) || 4),
      gapSeconds: Math.max(0, parseFloat(o.gapSeconds) || 0),
      fontSize: Math.max(8, parseInt(o.fontSize, 10) || 64),
      color: safeString(o.color || "#FFFFFF"),
      mode: safeString(o.mode || "caption"),
      mogrtPath: safeString(o.mogrtPath || ""),
      animated: (o.animated === true || o.animated === "true"),  // panel's Animated toggle
      animStyle: safeString(o.animStyle || "pop"),               // built-in AE animation style
      hlWords: (o.hlWords && o.hlWords.length) ? o.hlWords : [],  // Hormozi: marked words to pop
      hlColor: safeString(o.hlColor || "#ffe14d")                // highlight colour (default yellow)
    };
  }

  function pad(value, length) {
    var text = String(value);
    while (text.length < length) text = "0" + text;
    return text;
  }

  function srtTime(seconds) {
    var totalMs = Math.max(0, Math.round(seconds * 1000));
    var ms = totalMs % 1000, totalSeconds = Math.floor(totalMs / 1000);
    var sec = totalSeconds % 60, totalMinutes = Math.floor(totalSeconds / 60);
    var min = totalMinutes % 60, hr = Math.floor(totalMinutes / 60);
    return pad(hr, 2) + ":" + pad(min, 2) + ":" + pad(sec, 2) + "," + pad(ms, 3);
  }

  function findProjectItemByName(container, name) {
    if (!container || !container.children) return null;
    for (var i = 0; i < container.children.numItems; i += 1) {
      var child = container.children[i];
      if (child && child.name === name) return child;
      var nested = findProjectItemByName(child, name);
      if (nested) return nested;
    }
    return null;
  }

  function splitLines(text) {
    var raw = cleanTimelineText(text).split("\n");
    var lines = [];
    for (var i = 0; i < raw.length; i += 1) {
      var t = raw[i].replace(/^\s+|\s+$/g, "");
      if (t.length) lines.push(t);
    }
    return lines;
  }

  // ── Premiere: write an SRT (one or many cues) + attach as a caption track ──
  // Robust against Premiere 2025/2026 import quirks: writes a clean UTF-8 SRT to a stable
  // location, imports into the root bin, and surfaces the real error if anything fails.
  function premiereCaptions(cues) {
    if (!app.project || !app.project.activeSequence) {
      return json(false, "Open an active Premiere Pro sequence first.");
    }
    var sequence = app.project.activeSequence;
    var position = sequence.getPlayerPosition();
    var startSeconds = position ? position.seconds : 0;

    // Build SRT body — captions start at 0 so Premiere always accepts; createCaptionTrack
    // then drops the track at the playhead. Blank line terminator + trailing newline.
    var t = 0, body = "";
    for (var i = 0; i < cues.length; i += 1) {
      var s = t, e = t + cues[i].dur;
      body += (i + 1) + "\r\n" + srtTime(s) + " --> " + srtTime(e) + "\r\n" + cues[i].text + "\r\n\r\n";
      t = e + cues[i].gap;
    }

    // Stable path next to the project (temp folders sometimes trip the importer).
    var baseFolder = Folder.temp;
    try {
      if (app.project.path) {
        var pf = new File(app.project.path).parent;
        if (pf && pf.exists) baseFolder = pf;
      }
    } catch (eP) {}
    var fileName = "zh-script-" + (new Date()).getTime() + ".srt";
    var outFile = new File(baseFolder.fsName + "/" + fileName);
    outFile.encoding = "UTF-8";
    if (!outFile.open("w")) return json(false, "Could not write the subtitle file. Save your project first, then retry.");
    outFile.write(body);
    outFile.close();

    try {
      app.project.importFiles([outFile.fsName], true, app.project.rootItem, false);
    } catch (eImp) {
      try { outFile.remove(); } catch (e2) {}
      return json(false, "SRT import failed: " + eImp.toString() + ". Save the project to a real folder and retry.");
    }
    // Find the imported item — Premiere may keep or drop the .srt extension.
    var baseName = fileName.replace(/\.srt$/i, "");
    var projectItem = findItemMatching(app.project.rootItem, [fileName, baseName]);
    if (!projectItem) {
      // SRT is in the project bin even if we can't auto-place it.
      return json(true, "Subtitles imported to the project bin. Drag '" + fileName + "' onto your sequence, then right-click → Upgrade Captions to Graphics for editable text.", { imported: true, placed: false });
    }

    var created = null, capErr = "";
    try {
      if (typeof Sequence !== "undefined" && Sequence.CAPTION_FORMAT_SUBTITLE !== undefined) {
        created = sequence.createCaptionTrack(projectItem, startSeconds, Sequence.CAPTION_FORMAT_SUBTITLE);
      } else {
        created = sequence.createCaptionTrack(projectItem, startSeconds);
      }
    } catch (eCap) { capErr = eCap.toString(); }
    if (created) {
      return json(true, "Added " + cues.length + " caption" + (cues.length > 1 ? "s" : "") + " at the playhead. (Right-click → Upgrade Captions to Graphics for editable text.)", { count: cues.length, placed: true });
    }

    // Fallback: createCaptionTrack is flaky across Premiere builds. Drop the imported caption
    // item straight onto the TOP video track at the playhead — same result as a manual drag.
    try {
      var vts = sequence.videoTracks;
      if (vts && vts.numTracks > 0) {
        var track = vts[vts.numTracks - 1];                 // topmost track → overlays video
        if (track && (track.overwriteClip || track.insertClip)) {
          if (track.overwriteClip) track.overwriteClip(projectItem, startSeconds);
          else                     track.insertClip(projectItem, startSeconds);
          return json(true, "Placed subtitles on the timeline at the playhead. (Right-click → Upgrade Captions to Graphics for editable text.)", { count: cues.length, placed: true });
        }
      }
    } catch (eIns) { capErr = capErr || eIns.toString(); }

    return json(true, "Subtitles imported to the bin (auto-place unavailable" + (capErr ? ": " + capErr : "") + "). Drag '" + fileName + "' onto your sequence, then Upgrade Captions to Graphics.", { imported: true, placed: false });
  }

  // Find a project item whose name equals or starts with any of the given names.
  function findItemMatching(container, names) {
    if (!container || !container.children) return null;
    for (var i = 0; i < container.children.numItems; i += 1) {
      var child = container.children[i];
      if (child) {
        var nm = safeString(child.name);
        for (var n = 0; n < names.length; n += 1) {
          if (nm === names[n] || nm.indexOf(names[n]) === 0) return child;
        }
      }
      var nested = findItemMatching(child, names);
      if (nested) return nested;
    }
    return null;
  }

  // Find a project item by its on-disk media path — rename-proof (Premiere mangles names with
  // spaces / "(...)"), and unambiguous when several same-named .srt files sit in the bin.
  function findItemByPath(container, path) {
    if (!container || !container.children || !path) return null;
    for (var i = 0; i < container.children.numItems; i += 1) {
      var c = container.children[i];
      try {
        if (c && c.getMediaPath) {
          var mp = safeString(c.getMediaPath());
          if (mp && (mp === path || mp.replace(/\\/g, "/") === String(path).replace(/\\/g, "/"))) return c;
        }
      } catch (e) {}
      var nested = findItemByPath(c, path);
      if (nested) return nested;
    }
    return null;
  }

  function premiereMarker(text) {
    if (!app.project || !app.project.activeSequence) return json(false, "Open an active Premiere Pro sequence first.");
    var seq = app.project.activeSequence;
    var pos = seq.getPlayerPosition();
    var markers = seq.markers;
    var m = markers.createMarker(pos ? pos.seconds : 0);
    m.name = text.length > 60 ? text.substring(0, 60) : text;
    m.comments = text;
    return json(true, "Added a sequence marker at the playhead.");
  }

  // Fill the text on an inserted graphic/title clip via the "Text" component's source-text
  // property. Returns "OK..." on confirmed set (readback matches) or "DIAG:..." with details.
  function setMgtText(trackItem, text) {
    try {
      // PRIMARY: exposed MOGRT essential properties (AE-origin template with exposed Source Text).
      var mgt = null;
      try { mgt = trackItem.getMGTComponent ? trackItem.getMGTComponent() : null; } catch (eg) {}
      if (mgt && mgt.properties && mgt.properties.numItems > 0) {
        var ep = mgt.properties, elist = [], probe = text.substring(0, Math.min(5, text.length));
        for (var e0 = 0; e0 < ep.numItems; e0 += 1) elist.push(safeString(ep[e0].displayName));
        // pass 0 = only TEXT-named exposed props (Source Text), pass 1 = any. Only accept a set
        // that READS BACK as our text — never a false-positive on a colour/number property.
        for (var pass = 0; pass < 2; pass += 1) {
          for (var e = 0; e < ep.numItems; e += 1) {
            var epr = ep[e], dn = safeString(epr.displayName);
            if (pass === 0 && !/source text|^text$|title|caption|subtitle|script/i.test(dn)) continue;
            try {
              epr.setValue(text, true);
              var rb = ""; try { rb = safeString(epr.getValue()); } catch (er) { rb = ""; }
              if (rb.indexOf(probe) !== -1) return "OK@mgt/" + dn;
            } catch (es) {}
          }
        }
        return "DIAG:no editable Source Text in template. Exposed=[" + elist.join(", ") + "]";
      }
      // FALLBACK: raw Text component.
      var comps = trackItem.components;
      for (var c = 0; c < comps.numItems; c += 1) {
        var comp = comps[c];
        var cn = safeString(comp.displayName);
        if (!/text|graphic/i.test(cn)) continue;
        var props = comp.properties;
        var listed = [];
        for (var i = 0; i < props.numItems; i += 1) {
          listed.push(safeString(props[i].displayName));
        }
        // Try the source-text property first, then any, and VERIFY with a readback.
        function trySet(pr) {
          var dn = safeString(pr.displayName);
          var before = "";
          try { before = safeString(pr.getValue()); } catch (eg) {}
          var ok = false;
          try { pr.setValue(text, true); ok = true; } catch (e1) {
            try { pr.setValue(text); ok = true; } catch (e1b) {}
          }
          if (!ok) return null;
          var after = "";
          try { after = safeString(pr.getValue()); } catch (eg2) { after = "<?>"; }
          return { name: dn, before: before, after: after };
        }
        // pass 1: source-text-like
        for (var s = 0; s < props.numItems; s += 1) {
          var pn = safeString(props[s].displayName);
          if (/source text|^text$|title/i.test(pn)) {
            var r = trySet(props[s]);
            if (r) {
              if (r.after.indexOf(text.substring(0, 6)) !== -1) return "OK@" + cn + "/" + r.name;
              return "DIAG:set " + cn + "/" + r.name + " but readback='" + r.after.substring(0, 30) + "' props=[" + listed.join(", ") + "]";
            }
          }
        }
        return "DIAG:comp=" + cn + " (no source-text prop set) props=[" + listed.join(", ") + "]";
      }
      var names = [];
      for (var k = 0; k < comps.numItems; k += 1) names.push(safeString(comps[k].displayName));
      return "DIAG:no-text-comp; components=[" + names.join(", ") + "]";
    } catch (e) { return "DIAG:err " + e.toString(); }
  }

  // Insert editable MOGRT title clip(s) at the playhead with the given line(s).
  function premiereTitles(lines, mogrtPath, opts) {
    if (!app.project || !app.project.activeSequence) return json(false, "Open a Premiere Pro sequence first.");
    if (!mogrtPath) return json(false, "Title template path missing (reopen the panel).");
    var mf = new File(mogrtPath);
    if (!mf.exists) return json(false, "Title template not found. Reinstall the panel.");
    var seq = app.project.activeSequence;
    var pos = seq.getPlayerPosition();
    var t = pos ? pos.seconds : 0;
    var vTrack = Math.max(0, seq.videoTracks.numTracks - 1);
    var made = 0, filled = 0, diag = "";
    for (var i = 0; i < lines.length; i += 1) {
      var item = null;
      try { item = seq.importMGT(mf.fsName, t, vTrack, -1); }
      catch (e) { return json(false, "Title insert failed: " + e.toString()); }
      if (!item) return json(false, "Premiere did not insert the title (importMGT returned null).");
      made += 1;
      var res = setMgtText(item, lines[i]);
      if (res.indexOf("OK") === 0) filled += 1; else if (!diag) diag = res;
      // set clip duration = start + durationSeconds (trim the default MOGRT length)
      try {
        var startSec = item.start.seconds;
        var endTime = new Time();
        endTime.seconds = startSec + opts.durationSeconds;
        item.end = endTime;
      } catch (eDur) {}
      // advance to the end of this clip for the next title
      try { t = item.end.seconds + opts.gapSeconds; } catch (eT) { t += opts.durationSeconds + opts.gapSeconds; }
    }
    var msg = "Added " + made + " editable title" + (made > 1 ? "s" : "") + " at the playhead";
    if (filled === made) msg += " with your text.";
    else if (filled === 0) msg += " — text not auto-filled [" + diag + "]";
    else msg += " (some need manual text edit).";
    return json(true, msg, { count: made, filled: filled, diag: diag });
  }

  // Smooth easy-ease on all keys of a property (any dimension).
  function easeKeys(prop) {
    try {
      var dim = 1;
      try { var v = prop.valueAtTime(0, false); dim = (v instanceof Array) ? v.length : 1; } catch (eD) {}
      for (var k = 1; k <= prop.numKeys; k += 1) {
        var ein = [], eout = [];
        for (var d = 0; d < dim; d += 1) { ein.push(new KeyframeEase(0, 60)); eout.push(new KeyframeEase(0, 60)); }
        prop.setTemporalEaseAtKey(k, ein, eout);
      }
    } catch (e) {}
  }

  // Apply a custom .ffx animation preset to ONE layer, with its keyframes landing at `atTime`.
  // applyPreset drops keyframes at the comp's CURRENT time and onto ALL selected layers — so we
  // deselect everything, select only this layer, and move the playhead to the layer's start.
  // (That's why a user's .ffx "didn't work": its keyframes were applied at time 0 on the wrong layers.)
  // Collect every animated (keyframed) property under a group, recursively.
  function collectAnimProps(group, arr) {
    try {
      for (var i = 1; i <= group.numProperties; i += 1) {
        var p = group.property(i);
        if (p.numKeys && p.numKeys > 0) arr.push(p);
        else if (p.numProperties && p.numProperties > 0) collectAnimProps(p, arr);
      }
    } catch (e) {}
  }
  // Shift ALL of a layer's keyframes so the animation STARTS at targetStart. applyPreset often
  // drops keyframes at comp time 0 regardless of the playhead, so on a subtitle that begins at 30s
  // the values are there but the motion already happened off-screen — this re-aligns it.
  function shiftLayerKeys(layer, targetStart) {
    var props = []; collectAnimProps(layer, props);
    if (!props.length) return 0;
    var minT = Infinity, i, k;
    for (i = 0; i < props.length; i += 1) { try { if (props[i].keyTime(1) < minT) minT = props[i].keyTime(1); } catch (e) {} }
    if (minT === Infinity) return 0;
    var delta = targetStart - minT;
    if (Math.abs(delta) < 0.001) return props.length;   // already aligned
    for (i = 0; i < props.length; i += 1) {
      var p = props[i];
      try { for (k = p.numKeys; k >= 1; k -= 1) p.setKeyTime(k, p.keyTime(k) + delta); } catch (e) {}
    }
    return props.length;
  }

  function applyPresetAt(comp, layer, file, atTime) {
    try {
      for (var dl = 1; dl <= comp.numLayers; dl += 1) { try { comp.layer(dl).selected = false; } catch (eS0) {} }
      layer.selected = true;
      var prevT = comp.time;
      try { comp.time = atTime; } catch (eT) {}
      layer.applyPreset(file);
      try { shiftLayerKeys(layer, atTime); } catch (eShift) {}   // re-align keyframes to the layer's start
      try { comp.time = prevT; } catch (eT2) {}
      return true;
    } catch (e) { return false; }
  }

  // Apply the bounce to the SELECTED properties of a layer. opts:
  //   props  = ["scale","position","rotation"]  (default ["scale"])
  //   e, g   = elasticity / gravity (manual). Auto picks sensible defaults.
  //   dropPx = position drop-in distance.
  // PURE-KEYFRAME bounce (no expression — works on every AE version + expression engine). Each chosen
  // property snaps in then OVERSHOOTS past its target with decreasing bounces (eased), like a ball.
  //   e (elasticity 0.1–0.95) → overshoot size · g (gravity) → snap speed.
  function applyBounceSystem(layer, t, opts) {
    opts = opts || {};
    var props = (opts.props && opts.props.length) ? opts.props : ["scale"];
    var e = (opts.e > 0) ? opts.e : 0.65;
    var of = Math.max(0.10, Math.min(0.36, e * 0.38));            // overshoot fraction of the move
    var g = (opts.g > 0) ? opts.g : 4000;
    var d = Math.max(0.16, Math.min(0.42, 1500 / g));             // snap-in time (snappier g → shorter)
    var dropPx = (opts.dropPx == null) ? 130 : opts.dropPx;
    var tr = layer.property("Transform");
    var i, k;
    // Bounce a value: from → (overshoot past to) → settle. Works for scalars and arrays.
    function bounceTo(p, fromV, toV) {
      var isArr = (toV.length !== undefined);
      function over(sign, frac) {                                 // toV + (toV-fromV)*sign*frac
        if (!isArr) return toV + (toV - fromV) * sign * frac;
        var v = []; for (var j = 0; j < toV.length; j += 1) v[j] = toV[j] + (toV[j] - fromV[j]) * sign * frac; return v;
      }
      try {
        p.setValueAtTime(t, fromV);
        p.setValueAtTime(t + d, over(1, of));                     // overshoot past target (biggest)
        p.setValueAtTime(t + d + 0.10, over(-1, of * 0.42));      // bounce back under
        p.setValueAtTime(t + d + 0.19, over(1, of * 0.16));       // small overshoot
        p.setValueAtTime(t + d + 0.26, toV);                      // settle
        try { easeKeys(p); } catch (e2) {}
      } catch (e3) {}
    }
    for (i = 0; i < props.length; i += 1) {
      var name = String(props[i]).toLowerCase();
      if (name === "scale") {
        var sc = tr.property("Scale"), sv = sc.value, sf = [];
        for (k = 0; k < sv.length; k += 1) sf[k] = 0;
        bounceTo(sc, sf, sv);                                     // 0 → original scale, bouncing
      } else if (name === "position") {
        var pos = tr.property("Position"), base = pos.value, pf = [];
        for (k = 0; k < base.length; k += 1) pf[k] = base[k];
        pf[1] -= Math.abs(dropPx);                                // drop in from above
        bounceTo(pos, pf, base);
      } else if (name === "rotation") {
        var rot = tr.property("Rotation"), rv = rot.value;
        bounceTo(rot, rv - 18, rv);                               // rotate in
      }
    }
    try { var op = tr.property("Opacity"); op.setValueAtTime(t, 0); op.setValueAtTime(t + 0.10, 100); try { easeKeys(op); } catch (eE) {} } catch (eO) {}
  }

  // Apply a built-in animation STYLE to a text layer between t (in) and outP (out).
  // Position moves are relative to wherever the layer already sits (so it works for centred
  // titles AND bottom subtitles). Returns nothing; always wrapped so a failure is harmless.
  function applyAEAnim(layer, style, t, outP) {
    try {
      var tr = layer.property("Transform");
      var op = tr.property("Opacity"), sc = tr.property("Scale"), pos = tr.property("Position");
      var base = pos.value;
      var inT = 0.40, outT = 0.30;
      style = String(style || "fade").toLowerCase();
      if (style === "none") return;   // deliberately static title — no animation

      if (style === "typewriter") {
        // Type-on: an Opacity=0 text animator over a Range Selector whose Start sweeps 0→100%.
        // (The selector defaults to PERCENTAGE units, so animate the Start in %, not index — the
        // old index-based version did nothing because units never matched.)
        try {
          var animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
          var ag = animators.addProperty("ADBE Text Animator");
          ag.property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity").setValue(0);
          var sel = ag.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
          var startProp = sel.property(1);   // Range Selector "Start" (first property, % units)
          var revealDur = Math.min(Math.max(0.6, (outP - t) * 0.6), 2.2);
          startProp.setValueAtTime(t, 0);             // 0% → whole word selected → all hidden
          startProp.setValueAtTime(t + revealDur, 100); // 100% → nothing selected → fully revealed
          try { easeKeys(startProp); } catch (eK) {}
          op.setValueAtTime(t, 100);
          if (outP - t > outT + 0.2) { op.setValueAtTime(outP - outT, 100); op.setValueAtTime(outP, 0); easeKeys(op); }
          return;
        } catch (eTw) { /* fall through to fade */ }
      }

      // Clone the position (keeps 2D vs 3D dimensions — a 2-element set on a 3D layer throws,
      // which silently killed the whole animation).
      function pAt(dx, dy) { var v = []; for (var k = 0; k < base.length; k += 1) v[k] = base[k]; v[0] += dx; v[1] += dy; return v; }
      // Uniform scale that matches the layer's dimension count (2D=[x,y], 3D=[x,y,z]) — a 2-element
      // set on a 3D layer throws and silently kills the whole animation (same trap as pAt above).
      function sAt(p) { var sv = sc.value, o = []; for (var k = 0; k < sv.length; k += 1) o[k] = p; return o; }
      if (style === "slide-up") {
        // Whole-line slide-up + fade (pure Transform keyframes — reliable on every AE version).
        pos.setValueAtTime(t, pAt(0, 100)); pos.setValueAtTime(t + inT, pAt(0, 0));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      } else if (style === "slide-down") {
        pos.setValueAtTime(t, pAt(0, -90)); pos.setValueAtTime(t + inT, pAt(0, 0));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      } else if (style === "slide-left") {
        pos.setValueAtTime(t, pAt(140, 0)); pos.setValueAtTime(t + inT, pAt(0, 0));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      } else if (style === "pop") {
        sc.setValueAtTime(t, sAt(55)); sc.setValueAtTime(t + inT, sAt(110)); sc.setValueAtTime(t + inT + 0.12, sAt(100));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      } else if (style === "scale") {
        sc.setValueAtTime(t, sAt(80)); sc.setValueAtTime(t + inT, sAt(100));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      } else if (style === "bounce") {
        // Realistic bounce via the decaying-sine expression system (overshoot → settle, physics-like).
        applyBounceSystem(layer, t, { props: ["scale"] });
        return;   // applyBounceSystem owns Scale/Opacity keyframes + expression
      } else if (style === "karaoke") {
        // Per-word highlight: each cue is one word (wpc=1). Paint it the accent gold + a quick scale
        // pop so the spoken word "lights up" karaoke-style as it appears.
        try { var ktd = layer.property("Source Text").value; ktd.applyFill = true; ktd.fillColor = [0.831, 0.627, 0.090]; layer.property("Source Text").setValue(ktd); } catch (eKar) {}
        sc.setValueAtTime(t, sAt(60)); sc.setValueAtTime(t + inT, sAt(110)); sc.setValueAtTime(t + inT + 0.1, sAt(100));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      } else if (style === "glow") {
        // Glow: add the Glow effect with a VISIBLE radius + scale-fade in.
        // (Bug before: radius was set to 1.4 — effectively invisible. 0002=Threshold, 0003=Radius,
        //  0004=Intensity.)
        try {
          var par = layer.property("ADBE Effect Parade");
          if (par && (par.canAddProperty ? par.canAddProperty("ADBE Glo2") : true)) {
            var glo = par.addProperty("ADBE Glo2");
            try { glo.property("ADBE Glo2-0002").setValue(50); } catch (eGt) {}   // Threshold %
            try { glo.property("ADBE Glo2-0003").setValue(34); } catch (eGr) {}   // Radius (visible)
            try { glo.property("ADBE Glo2-0004").setValue(1.8); } catch (eGi) {}  // Intensity
          }
        } catch (eGlow) {}
        sc.setValueAtTime(t, sAt(82)); sc.setValueAtTime(t + inT, sAt(100));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      } else if (style === "hormozi") {
        // Hormozi caption: a punchy scale-pop in. The yellow keyword highlight is added separately
        // (addAESubtitles → applyKeywordHighlight on the auto-detected power words).
        sc.setValueAtTime(t, sAt(62)); sc.setValueAtTime(t + inT, sAt(108)); sc.setValueAtTime(t + inT + 0.1, sAt(100));
        op.setValueAtTime(t, 0); op.setValueAtTime(t + 0.12, 100);
      } else { // fade / clean — minimal, no scale punch
        op.setValueAtTime(t, 0); op.setValueAtTime(t + inT, 100);
      }
      if (outP - t > inT + outT) { op.setValueAtTime(outP - outT, 100); op.setValueAtTime(outP, 0); }
      try { easeKeys(op); } catch (e1) {}
      try { if (sc.numKeys) easeKeys(sc); } catch (e2) {}
      try { if (pos.numKeys) easeKeys(pos); } catch (e3) {}
    } catch (e) {}
  }

  // Keyword highlight: colour the given words inside a text layer yellow.
  // PRIMARY = the modern per-character CharacterRange API (AE 24.3+/2026) — sets the keyword chars'
  // fill directly, RELIABLE (no text-animator selector, which is the flaky path that broke slide).
  // FALLBACK (old AE) = a character-index Range Selector animator.
  function applyKeywordHighlight(layer, words, hex) {
    if (!words || !words.length) return;
    try {
      var st = layer.property("Source Text");
      var src = String(st.value.text || "");
      var rgb = hexToRgb(hex || "#ffe14d");
      var w, word, idx;
      // --- Reliable path: CharacterRange ---
      if (typeof st.characterRange === "function") {
        var any = false;
        for (w = 0; w < words.length; w += 1) {
          word = String(words[w] || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
          if (!word) continue;
          idx = src.indexOf(word); if (idx < 0) continue;
          try {
            var cr = st.characterRange(idx, idx + word.length);
            try { cr.applyFill = true; } catch (eAf) {}
            cr.fillColor = rgb;
            any = true;
          } catch (eCR) {}
        }
        if (any) return;
      }
      // --- Fallback path: text-animator range selector (older AE) ---
      var animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
      for (w = 0; w < words.length; w += 1) {
        word = String(words[w] || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        if (!word) continue;
        idx = src.indexOf(word); if (idx < 0) continue;
        try {
          var ag = animators.addProperty("ADBE Text Animator");
          var ap = ag.property("ADBE Text Animator Properties");
          try { ap.addProperty("ADBE Text Fill Color").setValue(rgb); } catch (eFc) {}
          var sel = ag.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
          try { sel.property("ADBE Text Range Units").setValue(2); } catch (eU) {}
          sel.property("ADBE Text Percent Start").setValue(idx);
          sel.property("ADBE Text Percent End").setValue(idx + word.length);
        } catch (eW) {}
      }
    } catch (e) {}
  }

  // ── After Effects: animated styled text layer(s) / marker ──
  function aeTextLayers(lines, opts) {
    if (!app.project || !(app.project.activeItem instanceof CompItem)) {
      return json(false, "Open an active composition first.");
    }
    app.beginUndoGroup("ZH Script Studio Insert");
    var comp = app.project.activeItem, t = comp.time, made = 0, diagAE = "";
    for (var i = 0; i < lines.length; i += 1) {
      var layer = comp.layers.addText(lines[i]);
      var lnm2 = String(lines[i]).replace(/[\r\n]+/g, " ").substring(0, 40);
      layer.name = lnm2 ? lnm2 : ("ZH Script " + (i + 1));
      try {
        var td = layer.property("Source Text").value;
        td.fontSize = opts.fontSize;
        td.fillColor = hexToRgb(opts.color);
        td.applyFill = true;
        try { td.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (eJ) {}
        applyScriptFont(td, lines[i]);
        layer.property("Source Text").setValue(td);
      } catch (e) {}

      layer.startTime = t; layer.inPoint = t;
      var outP = Math.min(comp.duration, t + opts.durationSeconds);
      layer.outPoint = outP;

      // Center anchor (so scale pops from the middle) + center on screen.
      try {
        var r = layer.sourceRectAtTime(t, false);
        layer.property("Transform").property("Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
        layer.property("Transform").property("Position").setValue([comp.width / 2, comp.height / 2]);
      } catch (eC) {}

      // Animation source — the chosen Effect chip WINS:
      //   • a real effect (pop / typewriter / slide-up / glow / bounce) → apply that built-in style.
      //   • "none" → no built-in effect. If a custom .ffx template is active, let ITS preset animate
      //              the layer; otherwise a clean static title.
      // (No dependence on a separate "Animated" toggle — picking an effect IS the intent.)
      var aStyle = opts.animStyle || "pop";
      if (aStyle === "none") {
        if (opts.mogrtPath && /\.ffx$/i.test(opts.mogrtPath)) {
          var pf = new File(opts.mogrtPath);
          if (pf.exists) { if (!applyPresetAt(comp, layer, pf, t) && !diagAE) diagAE = "preset failed to apply"; }
          else if (!diagAE) diagAE = "preset file not found";
        }
      } else {
        applyAEAnim(layer, aStyle, t, outP);
      }

      // Hormozi keyword highlight: words the user MARKED in the script pop in the accent colour.
      try { if (opts.hlWords && opts.hlWords.length) applyKeywordHighlight(layer, opts.hlWords, opts.hlColor); } catch (eHl) {}

      t = outP + opts.gapSeconds; made += 1;
    }
    app.endUndoGroup();
    var aeMsg = "Added " + made + " animated text layer" + (made > 1 ? "s" : "") + " to the composition.";
    if (diagAE) aeMsg += " [" + diagAE + "]";
    return json(true, aeMsg, { count: made });
  }

  function aeMarker(text) {
    if (!app.project || !(app.project.activeItem instanceof CompItem)) return json(false, "Open an active composition first.");
    var comp = app.project.activeItem;
    var mm = new MarkerValue(text.length > 60 ? text.substring(0, 60) : text);
    mm.comment = text;
    comp.markerProperty.setValueAtTime(comp.time, mm);
    return json(true, "Added a composition marker at the playhead.");
  }

  // If the text has Bengali characters, switch to a Bengali-capable font so it renders (not tofu).
  function applyScriptFont(td, text) {
    try {
      if (/[\u0980-\u09FF]/.test(text)) {
        // HindSiliguri-SemiBold is auto-installed with the panel (same as the default MOGRT).
        var candidates = ["HindSiliguri-SemiBold", "HindSiliguri-Regular", "NotoSansBengali-Regular", "KohinoorBangla-Regular", "BanglaSangamMN"];
        for (var i = 0; i < candidates.length; i += 1) {
          try { td.font = candidates[i]; break; } catch (e) {}
        }
      }
    } catch (eF) {}
    return td;
  }

  function hexToRgb(hex) {
    var h = safeString(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substring(0, 2), 16) / 255;
    var g = parseInt(h.substring(2, 4), 16) / 255;
    var b = parseInt(h.substring(4, 6), 16) / 255;
    if (isNaN(r) || isNaN(g) || isNaN(b)) return [1, 1, 1];
    return [r, g, b];
  }

  var isAE = function () {
    try {
      if (typeof BridgeTalk !== "undefined" && BridgeTalk.appName) {
        return BridgeTalk.appName.toLowerCase().indexOf("aftereffects") === 0;
      }
    } catch (e) {}
    return typeof CompItem !== "undefined" && typeof importMGT === "undefined";
  };

  $.zhScriptStudio = {
    // After Effects subtitles: timed lower-third text layers from cues [{text,start,dur}].
    addAESubtitles: function (encCues, encOpts) {
      try {
        var cues = JSON.parse(decodeURIComponent(safeString(encCues)));
        if (!cues || !cues.length) return json(false, "No subtitle text.");
        if (!app.project || !(app.project.activeItem instanceof CompItem)) {
          return json(false, "Open an active composition first.");
        }
        // opts: { animated, style, ffx } — the SELECTED animation. ffx = a chosen .ffx preset path.
        var sOpts = {};
        try { sOpts = encOpts ? JSON.parse(decodeURIComponent(safeString(encOpts))) : {}; } catch (eO) { sOpts = {}; }
        var sFfx = (sOpts.ffx && /\.ffx$/i.test(sOpts.ffx) && new File(sOpts.ffx).exists) ? new File(sOpts.ffx) : null;
        var comp = app.project.activeItem;
        app.beginUndoGroup("ZH Script Studio Subtitles");
        // Cues are absolute from the comp start (audio was rendered from 0), so anchor at 0 —
        // NOT comp.time (the playhead), or every subtitle shifts by the playhead position.
        var base = 0, made = 0;
        for (var i = 0; i < cues.length; i += 1) {
          var c = cues[i];
          var layer = comp.layers.addText(safeString(c.text));
          // Name the layer by its text (trimmed) so subtitles are identifiable in the timeline.
          var lnm = safeString(c.text).replace(/[\r\n]+/g, " ").substring(0, 40);
          layer.name = lnm ? lnm : ("Subtitle " + (i + 1));
          try {
            var td = layer.property("Source Text").value;
            td.fontSize = 48; td.applyFill = true; td.fillColor = [1, 1, 1];
            try { td.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (eJ) {}
            applyScriptFont(td, safeString(c.text));
            // Caption-style colour/treatment — set on the WHOLE TextDocument (reliable; no per-char
            // animator/CharacterRange which is flaky across AE builds). This is what makes each style
            // visibly DIFFERENT (not just all "pop").
            if (sOpts.style === "hormozi") {
              // Hormozi: UPPERCASE + YELLOW fill + thick black stroke.
              try { td.text = safeString(c.text).toUpperCase(); } catch (eUc) {}
              td.fontSize = 64;
              td.applyFill = true; td.fillColor = [1, 0.86, 0.18];   // yellow
              try { td.applyStroke = true; td.strokeColor = [0, 0, 0]; td.strokeWidth = Math.max(5, td.fontSize * 0.14); td.strokeOverFill = false; } catch (eStk) {}
            } else if (sOpts.style === "karaoke") {
              // Karaoke: GOLD word (each cue is 1 word via wpc=1 → reads word-by-word).
              td.applyFill = true; td.fillColor = [1, 0.78, 0.12];
            }
            layer.property("Source Text").setValue(td);
          } catch (eS) {}
          var st = base + (parseFloat(c.start) || 0);
          var outP = Math.min(comp.duration, st + (parseFloat(c.dur) || 2));
          layer.startTime = st; layer.inPoint = st; layer.outPoint = outP;
          try {
            var r = layer.sourceRectAtTime(st, false);
            layer.property("Transform").property("Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
            layer.property("Transform").property("Position").setValue([comp.width / 2, comp.height * 0.85]);
          } catch (eP) {}
          // The chosen caption STYLE wins (Karaoke/Hormozi/Pop/Clean). Only fall back to a custom
          // .ffx template when style = "none" — otherwise an active title template (e.g. New Glow)
          // would hijack every caption and the viral style would never show.
          if (sOpts.style === "none") {
            if (sFfx) applyPresetAt(comp, layer, sFfx, st);
          } else if (sOpts.animated) {
            applyAEAnim(layer, sOpts.style || "pop", st, outP);
          }
          made += 1;
        }
        app.endUndoGroup();
        return json(true, "Added " + made + " subtitle layer" + (made > 1 ? "s" : "") + " to the composition.", { count: made });
      } catch (e) {
        return json(false, "Subtitle error: " + e.toString());
      }
    },

    getHostInfo: function () {
      return JSON.stringify({
        name: safeString(app && app.name),
        version: safeString(app && app.version),
        buildName: safeString(app && app.buildName),
        buildNumber: safeString(app && app.buildNumber)
      });
    },

    // After Effects: render the active comp's audio to a temp WAV (for Auto Subtitle / STT).
    // Synchronous render — returns the finished file path (ready:true) so the panel uploads immediately.
    exportCompAudio: function () {
      try {
        if (!app.project || !(app.project.activeItem instanceof CompItem)) return json(false, "Open an active composition first.");
        var comp = app.project.activeItem;
        var out = new File(Folder.temp.fsName + "/zh-stt-" + (new Date()).getTime() + ".wav");
        var rq = app.project.renderQueue;
        // Pause any already-queued items so we render ONLY our audio job.
        var paused = [];
        for (var i = 1; i <= rq.numItems; i += 1) {
          try { if (rq.item(i).status === RQItemStatus.QUEUED) { rq.item(i).render = false; paused.push(rq.item(i)); } } catch (eq) {}
        }
        var rqItem = rq.items.add(comp);
        // If the user set a Work Area shorter than the comp, render ONLY that — lets a long comp
        // be transcribed in a manageable chunk (the panel offsets the captions by aeAudioStart).
        var areaStart = 0;
        try {
          if (comp.workAreaDuration && comp.workAreaDuration < comp.duration - 0.01) {
            rqItem.timeSpanStart = comp.workAreaStart;
            rqItem.timeSpanDuration = comp.workAreaDuration;
            areaStart = comp.workAreaStart;
          }
        } catch (eW) {}
        var om = rqItem.outputModule(1);
        // The audio output-module template isn't always literally called "WAV" (AE version /
        // language differs). Applying a wrong/absent name silently leaves the DEFAULT module —
        // which renders the comp's VIDEO (200+ MB, not a WAV → can't be transcribed). So search
        // the actual template list for an audio one and apply that.
        var tApplied = "";
        try {
          var names = om.templates;   // array of available output-module template names
          var prefer = ["WAV", "AIFF", "Audio Only", "audio only"];
          for (var pi = 0; pi < prefer.length && !tApplied; pi += 1) {
            for (var ni = 0; ni < names.length; ni += 1) {
              if (String(names[ni]).toLowerCase() === prefer[pi].toLowerCase()) { om.applyTemplate(names[ni]); tApplied = names[ni]; break; }
            }
          }
          if (!tApplied) {   // fall back to any template whose name mentions wav/aiff/audio
            for (var nj = 0; nj < names.length; nj += 1) {
              if (/wav|aiff|audio/i.test(String(names[nj]))) { om.applyTemplate(names[nj]); tApplied = names[nj]; break; }
            }
          }
        } catch (eT) {}
        if (!tApplied) {
          try { rqItem.remove(); } catch (e9) {}
          return json(false, "No WAV audio-output template found in After Effects. Once: Composition → Add to Render Queue → Output Module → set Format = WAV, click the disk icon to save it as a template named \"WAV\", then run Auto Subtitle again.");
        }
        try { om.file = out; } catch (eF) { return json(false, "Could not set audio output file: " + eF.toString()); }
        rqItem.render = true;
        try { rq.render(); } catch (eR) { try { rqItem.remove(); } catch (e2) {} return json(false, "Audio render failed: " + eR.toString()); }
        try { rqItem.remove(); } catch (e3) {}
        for (var p = 0; p < paused.length; p += 1) { try { paused[p].render = true; } catch (e4) {} }
        // AE may name the output with the comp suffix — find the actual rendered file.
        var f = out;
        if (!f.exists) {
          // AE's WAV module may append the comp name → find the newest zh-stt-* file.
          var alt = Folder.temp.getFiles("zh-stt-*");
          if (alt && alt.length) {
            var newest = alt[0];
            for (var a = 1; a < alt.length; a += 1) {
              try { if (alt[a].modified.getTime() > newest.modified.getTime()) newest = alt[a]; } catch (em) {}
            }
            f = newest;
          }
        }
        if (!f || !f.exists) return json(false, "Audio rendered but file not found.");
        // Guard: make sure we produced a WAV (RIFF/RF64), not a video — else don't hand a 200 MB
        // video to the uploader.
        try {
          var chk = new File(f.fsName); chk.encoding = "BINARY"; chk.open("r");
          var magic = chk.read(4); chk.close();
          if (magic !== "RIFF" && magic !== "RF64" && magic !== "FORM") {   // FORM = AIFF (also fine)
            return json(false, "After Effects rendered " + (tApplied || "the default") + " (not audio). Set the Output Module Format to WAV or AIFF and retry.");
          }
        } catch (eC) {}
        return json(true, "ready", { path: f.fsName, ready: true, start: areaStart });
      } catch (e) {
        return json(false, "Comp audio export error: " + e.toString());
      }
    },

    // Export the active sequence's audio to a temp 16kHz mono WAV (for auto subtitle / STT).
    exportSequenceAudio: function (encPreset) {
      try {
        if (isAE()) return json(false, "In After Effects, Auto Subtitle uses the composition audio — use the AE path.");
        if (!app.project || !app.project.activeSequence) return json(false, "Open a Premiere Pro sequence first.");
        var preset = safeString(encPreset);
        var pf = new File(preset);
        if (!pf.exists) return json(false, "Audio preset missing — reinstall the panel.");
        var seq = app.project.activeSequence;
        var out = new File(Folder.temp.fsName + "/zh-stt-" + (new Date()).getTime() + ".wav");
        // exportAsMediaDirect renders asynchronously — start it and hand the path back;
        // the panel waits for the file to finish, then uploads it behind the scenes.
        try { seq.exportAsMediaDirect(out.fsName, pf.fsName, 0); } catch (eE) { return json(false, "Audio export failed: " + eE.toString()); }
        return json(true, "started", { path: out.fsName });
      } catch (e) {
        return json(false, "Audio export error: " + e.toString());
      }
    },

    // Return the current Premiere project file path (so the panel saves .srt / .txt next to it).
    zhProjectPath: function () {
      try {
        var p = (app.project && app.project.path) ? String(app.project.path) : "";
        return json(true, "ok", { path: p });
      } catch (e) { return json(false, e.toString()); }
    },

    // Import a finished .srt onto a caption track at the playhead (full-auto subtitle).
    importCaptions: function (encPath) {
      try {
        if (isAE()) return json(false, "Caption track is Premiere-only. The .srt was saved — import it in After Effects.");
        if (!app.project || !app.project.activeSequence) return json(false, "Open a Premiere sequence first.");
        var f = new File(safeString(encPath));
        if (!f.exists) return json(false, "Subtitle file not found.");
        var seq = app.project.activeSequence;
        // Auto-subtitle cues are absolute from the sequence start (audio was exported from 0),
        // so the caption track must start at 0 — NOT the playhead, or every caption shifts.
        var startSec = 0;
        try { app.project.importFiles([f.fsName], true, app.project.rootItem, false); }
        catch (eImp) { return json(false, "Subtitle import failed: " + eImp.toString()); }
        // Find the just-imported item by PATH first (rename-proof), then by name as a fallback.
        var base = f.name.replace(/\.srt$/i, "");
        var item = findItemByPath(app.project.rootItem, f.fsName) || findItemMatching(app.project.rootItem, [f.name, base]);
        if (!item) return json(true, "Subtitles saved + imported to the bin — drag the .srt onto your sequence. [item-not-found]", { placed: false });

        var diag = "";
        var created = null;
        try {
          if (typeof Sequence !== "undefined" && Sequence.CAPTION_FORMAT_SUBTITLE !== undefined)
            created = seq.createCaptionTrack(item, startSec, Sequence.CAPTION_FORMAT_SUBTITLE);
          else created = seq.createCaptionTrack(item, startSec);
        } catch (eCap) { diag = "cap:" + eCap.toString(); }
        if (created) return json(true, "✅ Subtitles added to a caption track!", { placed: true });

        // Fallback: createCaptionTrack is flaky across Premiere builds. Drop the imported caption
        // item onto the TOP video track at the sequence start — same result as a manual drag.
        try {
          var vts = seq.videoTracks;
          if (vts && vts.numTracks > 0) {
            var track = vts[vts.numTracks - 1];
            if (track && track.overwriteClip)      { track.overwriteClip(item, startSec); return json(true, "✅ Subtitles placed on the timeline!", { placed: true }); }
            else if (track && track.insertClip)    { track.insertClip(item, startSec);    return json(true, "✅ Subtitles placed on the timeline!", { placed: true }); }
          }
        } catch (eIns) { diag += (diag ? " | " : "") + "ins:" + eIns.toString(); }
        return json(true, "Subtitles imported to the bin — drag the .srt onto your sequence." + (diag ? " [" + diag + "]" : ""), { placed: false });
      } catch (e) {
        return json(false, "Caption add error: " + e.toString());
      }
    },

    // Animated subtitles: place each cue as a MOGRT title at its own timecode, using the
    // active template (the one the user selected) or the bundled ZH default. encCues = JSON
    // array [{start, end, text}] (seconds, absolute from sequence 0).
    placeAnimatedSubtitles: function (encCues, encMogrt) {
      try {
        if (isAE()) return json(false, "Animated subtitles work in Premiere Pro here.");
        if (!app.project || !app.project.activeSequence) return json(false, "Open a Premiere sequence first.");
        var mf = new File(safeString(encMogrt));
        if (!mf.exists) return json(false, "Animation template not found — reopen the panel.");
        var cues;
        try { cues = JSON.parse(safeString(encCues)); } catch (eP) { return json(false, "Could not read the subtitle cues."); }
        if (!cues || !cues.length) return json(false, "No subtitles to place.");
        var seq = app.project.activeSequence;
        var vTrack = Math.max(0, seq.videoTracks.numTracks - 1);
        var made = 0, filled = 0, diag = "";
        for (var i = 0; i < cues.length; i += 1) {
          var c = cues[i];
          var start = parseFloat(c.start) || 0;
          var end = parseFloat(c.end); if (!(end > start)) end = start + 2;
          var item = null;
          try { item = seq.importMGT(mf.fsName, start, vTrack, -1); }
          catch (eI) { return json(false, "Title insert failed at " + start.toFixed(1) + "s: " + eI.toString()); }
          if (!item) continue;
          made += 1;
          var res = setMgtText(item, String(c.text || ""));
          if (res.indexOf("OK") === 0) filled += 1; else if (!diag) diag = res;
          try { var et = new Time(); et.seconds = end; item.end = et; } catch (eD) {}
        }
        var msg = "✨ Added " + made + " animated subtitle" + (made !== 1 ? "s" : "");
        msg += (filled === made) ? " with your text." : (filled === 0 ? " — text not auto-filled [" + diag + "]" : " (some need a manual text edit).");
        return json(true, msg, { count: made, filled: filled, placed: true });
      } catch (e) {
        return json(false, "Animated subtitle error: " + e.toString());
      }
    },

    // Bounce script: apply the bounce style to the SELECTED text layer(s) in the active comp
    // (falls back to ALL text layers if none selected). Reusable on any text, independent of insert.
    bounceSelectedLayers: function (optsJson) {
      try {
        if (!isAE()) return json(false, "Bounce script is After Effects only.");
        if (!app.project || !(app.project.activeItem instanceof CompItem)) return json(false, "Open an active composition first.");
        // opts from the panel: { props:["scale","position","rotation"], mode:"auto"|"manual", e, g }
        var o = {}; try { o = optsJson ? JSON.parse(decodeURIComponent(safeString(optsJson))) : {}; } catch (eO) { o = {}; }
        var props = (o.props && o.props.length) ? o.props : ["scale", "position"];
        var bo = { props: props };
        if (o.mode === "manual") { if (o.e > 0) bo.e = o.e; if (o.g > 0) bo.g = o.g; }   // else auto defaults
        var comp = app.project.activeItem;
        var targets = [], i, j;
        var sel = comp.selectedLayers;
        for (i = 0; i < sel.length; i += 1) { if (sel[i] instanceof TextLayer) targets.push(sel[i]); }
        if (!targets.length) { for (j = 1; j <= comp.numLayers; j += 1) { if (comp.layer(j) instanceof TextLayer) targets.push(comp.layer(j)); } }
        if (!targets.length) return json(false, "No text layer found — select a text layer first.");
        app.beginUndoGroup("ZH Bounce");
        var done = 0;
        for (i = 0; i < targets.length; i += 1) {
          applyBounceSystem(targets[i], targets[i].inPoint, bo);
          done += 1;
        }
        app.endUndoGroup();
        return json(true, "🪀 Bounced " + done + " text layer" + (done !== 1 ? "s" : "") + ".", { count: done });
      } catch (e) {
        return json(false, "Bounce failed: " + e.toString());
      }
    },

    // Single selection → one caption / text layer at the playhead.
    pasteTextToTimeline: function (encodedText, optionsJson) {
      try {
        var text = cleanTimelineText(safeString(encodedText));
        if (!text) return json(false, "Select text in the document first.");
        var opts = parseOptions(optionsJson);
        if (opts.mode === "marker") return isAE() ? aeMarker(text) : premiereMarker(text);
        // caption + default → editable AE-MOGRT title (Premiere) / styled text layer (AE)
        if (isAE()) return aeTextLayers([text], opts);
        return premiereTitles([text], opts.mogrtPath, opts);
      } catch (error) {
        return json(false, "Insert failed: " + error.toString());
      }
    },

    // Whole selection split by line → sequential editable titles / layers.
    pasteBatchToTimeline: function (encodedText, optionsJson) {
      try {
        var lines = splitLines(safeString(encodedText));
        if (!lines.length) return json(false, "Select multiple lines in the document first.");
        var opts = parseOptions(optionsJson);
        if (isAE()) return aeTextLayers(lines, opts);
        return premiereTitles(lines, opts.mogrtPath, opts);
      } catch (error) {
        return json(false, "Batch insert failed: " + error.toString());
      }
    },

    // Selection → marker at the playhead (script navigation).
    addMarker: function (encodedText) {
      try {
        var text = cleanTimelineText(safeString(encodedText));
        if (!text) return json(false, "Select text in the document first.");
        return isAE() ? aeMarker(text) : premiereMarker(text);
      } catch (error) {
        return json(false, "Marker failed: " + error.toString());
      }
    }
  };

  // Back-compat alias for the previous panel namespace.
  $.wordViewerPanel = $.zhScriptStudio;
}());
