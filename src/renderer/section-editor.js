// Pure helpers for the sample section editor. No DOM.
// Classic script in the renderer (globalThis.SectionEditor); imported by main and unit tests.
//
// Playback speed is sample-wide. The engine plays one AudioBufferSourceNode, and that
// node has a single playbackRate, so a looped section and the rest of the audition share it.
(function (root) {
  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }

  // Audition rate. Web Audio playbackRate also changes pitch; 1 is unchanged.
  function clampRate(rate) {
    const n = Number(rate);
    if (!Number.isFinite(n)) return 1;
    const c = Math.min(2, Math.max(0.25, n));
    return Math.round(c * 100) / 100;
  }

  // Persisted library boundaries. Speed stays inside the audition cap.
  function normalizeSection(sec) {
    if (!sec || typeof sec !== 'object') return null;
    const start = clamp01(sec.start);
    const end = clamp01(sec.end == null ? 1 : sec.end);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      loop: !!sec.loop,
      rate: clampRate(sec.rate == null ? 1 : sec.rate),
    };
  }

  function formatRate(rate) {
    return `${Math.round(clampRate(rate) * 100)}%`;
  }

  // Shortest selection, as a fraction of the file, so a drag still makes an audible slice.
  function minSpanFraction(duration) {
    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0) return 0.02;
    return Math.min(0.5, Math.max(0.005, 0.02 / d));
  }

  function sectionFromDrag(a, b, minSpan) {
    const min = Number.isFinite(minSpan) && minSpan > 0 ? Math.min(0.5, minSpan) : 0.01;
    let start = clamp01(Math.min(a, b));
    let end = clamp01(Math.max(a, b));
    if (end - start < min) {
      if (start + min <= 1) end = start + min;
      else {
        end = 1;
        start = Math.max(0, 1 - min);
      }
    }
    return { start, end };
  }

  function sectionSeconds(start, end, duration) {
    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0) return { startSec: 0, endSec: 0 };
    let s = clamp01(Math.min(start, end)) * d;
    let e = clamp01(Math.max(start, end)) * d;
    const minDur = Math.min(0.02, d);
    if (e - s < minDur) {
      if (s + minDur <= d) e = s + minDur;
      else {
        e = d;
        s = Math.max(0, d - minDur);
      }
    }
    return { startSec: s, endSec: e };
  }

  // Keep a seek inside the loop, a hair before loopEnd so playback doesn't skip the region.
  function loopStartOffset(startSec, endSec, wantSec) {
    const s = Number(startSec);
    const e = Number(endSec);
    const start = Number.isFinite(s) ? Math.max(0, s) : 0;
    if (!Number.isFinite(e) || e <= start) return start;
    const pad = Math.min(0.01, (e - start) / 4);
    let w = Number(wantSec);
    if (!Number.isFinite(w)) w = start;
    return Math.min(e - pad, Math.max(start, w));
  }

  function frameRange(start, end, length) {
    const n = Math.max(0, Math.floor(Number(length) || 0));
    if (!n) return { startFrame: 0, endFrame: 0 };
    let a = Math.floor(clamp01(Math.min(start, end)) * n);
    let b = Math.ceil(clamp01(Math.max(start, end)) * n);
    if (b <= a) b = Math.min(n, a + 1);
    if (a >= n) a = n - 1;
    if (b > n) b = n;
    return { startFrame: a, endFrame: b };
  }

  function isTrim(start, end, length) {
    const n = Math.floor(Number(length) || 0);
    if (n <= 1) return false;
    const { startFrame, endFrame } = frameRange(start, end, n);
    return endFrame - startFrame < n;
  }

  function isTrimFraction(start, end) {
    const a = clamp01(Math.min(start, end));
    const b = clamp01(Math.max(start, end));
    return b - a < 0.999;
  }

  function extname(name) {
    const i = String(name).lastIndexOf('.');
    if (i <= 0) return '';
    return name.slice(i);
  }

  function sanitizeFileName(name) {
    const base = String(name || '').split(/[/\\]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, '').trim();
    return base || 'sample.wav';
  }

  function wavFileName(name) {
    const base = sanitizeFileName(name);
    const ext = extname(base).toLowerCase();
    if (ext === '.wav' || ext === '.wave') return base;
    const stem = ext ? base.slice(0, -ext.length) : base;
    return `${stem || 'sample'}.wav`;
  }

  function uniqueFileName(wanted, taken) {
    const set = new Set((taken || []).map((n) => String(n).toLowerCase()));
    const safe = wavFileName(wanted);
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    if (!set.has(safe.toLowerCase())) return safe;
    let i = 2;
    let candidate = `${stem} ${i}${ext}`;
    while (set.has(candidate.toLowerCase())) {
      i += 1;
      candidate = `${stem} ${i}${ext}`;
    }
    return candidate;
  }

  function cutFileName(originalName, taken) {
    const wav = wavFileName(originalName);
    const ext = extname(wav);
    const stem = wav.slice(0, wav.length - ext.length);
    return uniqueFileName(`${stem} (cut)${ext}`, taken);
  }

  function asFloat32(ch) {
    if (ch instanceof Float32Array) return ch;
    if (ArrayBuffer.isView(ch)) return new Float32Array(ch.buffer, ch.byteOffset, ch.length);
    if (Array.isArray(ch)) return Float32Array.from(ch);
    return null;
  }

  function mixDown(channels) {
    const src = [];
    for (const ch of channels || []) {
      const data = asFloat32(ch);
      if (data && data.length) src.push(data);
    }
    if (!src.length) return new Float32Array(0);
    const n = src.reduce((m, c) => Math.min(m, c.length), Infinity);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const c of src) s += c[i] || 0;
      out[i] = s / src.length;
    }
    return out;
  }

  function peakEnvelope(data, bins = 128) {
    const peaks = new Uint8Array(bins);
    if (!data || !data.length) return peaks;
    const binSize = data.length / bins;
    for (let i = 0; i < bins; i++) {
      const start = Math.floor(i * binSize);
      const end = Math.max(start + 1, Math.floor((i + 1) * binSize));
      let max = 0;
      for (let j = start; j < end && j < data.length; j++) {
        const a = Math.abs(data[j]);
        if (a > max) max = a;
      }
      peaks[i] = Math.min(255, Math.round(max * 255));
    }
    return peaks;
  }

  // 16-bit PCM WAV. Interleaved, little-endian. Matches the tone files the app already writes.
  function encodeWav(channels, sampleRate) {
    const src = [];
    for (const ch of channels || []) {
      const data = asFloat32(ch);
      if (data && data.length) src.push(data);
    }
    if (!src.length) throw new Error('empty audio');
    const frames = src.reduce((m, c) => Math.min(m, c.length), Infinity);
    if (!frames) throw new Error('empty audio');
    const sr = Math.round(Number(sampleRate));
    if (!Number.isFinite(sr) || sr < 1000 || sr > 384000) throw new Error('unsupported sample rate');
    const nCh = src.length;
    if (nCh > 8) throw new Error('too many channels');
    const blockAlign = nCh * 2;
    const dataBytes = frames * blockAlign;
    const out = new Uint8Array(44 + dataBytes);
    const dv = new DataView(out.buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, nCh, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * blockAlign, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, dataBytes, true);
    let o = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        let s = src[c][i];
        if (!Number.isFinite(s)) s = 0;
        s = Math.max(-1, Math.min(1, s));
        const q = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
        dv.setInt16(o, Math.max(-32768, Math.min(32767, q)), true);
        o += 2;
      }
    }
    return out;
  }

  root.SectionEditor = {
    clampRate,
    normalizeSection,
    formatRate,
    minSpanFraction,
    sectionFromDrag,
    sectionSeconds,
    loopStartOffset,
    frameRange,
    isTrim,
    isTrimFraction,
    wavFileName,
    uniqueFileName,
    cutFileName,
    mixDown,
    peakEnvelope,
    encodeWav,
  };
})(globalThis);
