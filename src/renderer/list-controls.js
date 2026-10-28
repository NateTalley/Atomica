// Pure helpers for the sample-list controls. No DOM.
// Classic script in the renderer (globalThis.ListControls); imported by main and unit tests.
(function (root) {
  function cycleKind(kind) {
    return kind === 'loop' ? 'oneshot' : 'loop';
  }

  function isCyclableKind(kind) {
    return kind === 'loop' || kind === 'oneshot';
  }

  function scrubFraction(x, width) {
    const w = Number(width);
    if (!Number.isFinite(w) || w <= 0) return 0;
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n / w));
  }

  // Fraction of the buffer, held a hair off the end so a seek doesn't end playback.
  function scrubSeconds(fraction, duration) {
    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0.01) return 0;
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    return Math.min(d * f, d - 0.01);
  }

  function clamp01(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  }

  // Level stored on the sample override. Full scale (and anything invalid) clears it.
  function volumeOverride(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const c = Math.min(1, Math.max(0, n));
    if (c >= 0.999) return null;
    return Math.round(c * 1000) / 1000;
  }

  function auditionGain(sampleVol, masterVol) {
    return clamp01(sampleVol, 1) * clamp01(masterVol, 0.9);
  }

  // Checked rows share an edit. An unchecked row edits only itself.
  function batchPaths(selected, actedPath) {
    if (actedPath && selected && typeof selected.has === 'function' && selected.has(actedPath)) {
      return [...selected];
    }
    return actedPath ? [actedPath] : [];
  }

  function rangeSelect(selected, orderedPaths, anchorPath, path) {
    const next = new Set(selected || []);
    const a = orderedPaths.indexOf(anchorPath);
    const b = orderedPaths.indexOf(path);
    if (a < 0 || b < 0) {
      if (path) next.add(path);
      return next;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) next.add(orderedPaths[i]);
    return next;
  }

  // Editor tab: the playing row, otherwise the last checked row. Never a list default.
  function editorTarget({ playingPath, anchorPath, anchorSelected } = {}) {
    if (playingPath) return playingPath;
    if (anchorPath && anchorSelected) return anchorPath;
    return null;
  }

  // Max-length filter. Unknown durations stay visible. Equal to the cap stays visible.
  function withinMaxDuration(duration, enabled, maxSeconds) {
    if (!enabled) return true;
    const max = Number(maxSeconds);
    if (!Number.isFinite(max) || max <= 0) return true;
    const d = Number(duration);
    if (!Number.isFinite(d)) return true;
    return d <= max + 1e-6;
  }

  function headerCheckState(selected, visiblePaths) {
    if (!visiblePaths || !visiblePaths.length) return 'none';
    let n = 0;
    for (const p of visiblePaths) if (selected && selected.has(p)) n++;
    if (n <= 0) return 'none';
    if (n >= visiblePaths.length) return 'all';
    return 'some';
  }

  root.ListControls = {
    cycleKind,
    isCyclableKind,
    scrubFraction,
    scrubSeconds,
    volumeOverride,
    auditionGain,
    batchPaths,
    rangeSelect,
    editorTarget,
    withinMaxDuration,
    headerCheckState,
  };
})(globalThis);
