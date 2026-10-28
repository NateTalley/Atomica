import '../src/renderer/section-editor.js';
import { decodeMono } from '../src/main/analysis/dsp.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const S = globalThis.SectionEditor;

test('section drag clamps and keeps a minimum span', () => {
  assert.deepEqual(S.sectionFromDrag(0.2, 0.8, 0.02), { start: 0.2, end: 0.8 });
  assert.deepEqual(S.sectionFromDrag(0.8, 0.2, 0.02), { start: 0.2, end: 0.8 });
  const tiny = S.sectionFromDrag(0.5, 0.51, 0.05);
  assert.ok(tiny.end - tiny.start >= 0.05 - 1e-9);
  assert.ok(tiny.start >= 0 && tiny.end <= 1);
  const edge = S.sectionFromDrag(0.99, 1, 0.05);
  assert.equal(edge.end, 1);
  assert.ok(edge.end - edge.start >= 0.05 - 1e-9);
  assert.equal(S.minSpanFraction(1), 0.02);
  assert.ok(Math.abs(S.minSpanFraction(0.1) - 0.2) < 1e-12);
});

test('section seconds and loop offset stay inside the region', () => {
  const span = S.sectionSeconds(0.25, 0.75, 2);
  assert.equal(span.startSec, 0.5);
  assert.equal(span.endSec, 1.5);
  assert.equal(S.loopStartOffset(0.5, 1.5, 0), 0.5);
  assert.equal(S.loopStartOffset(0.5, 1.5, 1), 1);
  assert.ok(S.loopStartOffset(0.5, 1.5, 1.5) < 1.5);
  assert.equal(S.sectionSeconds(0, 1, 0).endSec, 0);
});

test('frame range trims and refuses a whole-file slice', () => {
  assert.deepEqual(S.frameRange(0.2, 0.8, 1000), { startFrame: 200, endFrame: 800 });
  assert.equal(S.isTrim(0.2, 0.8, 1000), true);
  assert.equal(S.isTrim(0, 1, 1000), false);
  assert.equal(S.isTrimFraction(0, 1), false);
  assert.equal(S.isTrimFraction(0, 0.5), true);
  assert.deepEqual(S.frameRange(0, 0, 10).endFrame, 1);
});

test('playback rate is clamped to the sample-wide audition range', () => {
  assert.equal(S.clampRate(1), 1);
  assert.equal(S.clampRate(0.5), 0.5);
  assert.equal(S.clampRate(0.1), 0.25);
  assert.equal(S.clampRate(8), 2);
  assert.equal(S.clampRate(3), 2);
  assert.deepEqual(S.normalizeSection({ start: 0.8, end: 0.2, loop: 1, rate: 9 }), {
    start: 0.2, end: 0.8, loop: true, rate: 2,
  });
  assert.equal(S.clampRate('nope'), 1);
  assert.equal(S.formatRate(0.5), '50%');
  assert.equal(S.formatRate(1), '100%');
});

test('cut names keep the original and stay wav files in the same folder', () => {
  assert.equal(S.cutFileName('kick.wav', []), 'kick (cut).wav');
  assert.equal(S.cutFileName('kick.wav', ['kick (cut).wav']), 'kick (cut) 2.wav');
  assert.equal(S.cutFileName('kick.mp3', []), 'kick (cut).wav');
  assert.equal(S.wavFileName('loop.flac'), 'loop.wav');
  assert.equal(S.uniqueFileName('room.wav', ['room.wav']), 'room 2.wav');
  assert.equal(S.wavFileName('../secret.wav'), 'secret.wav');
  assert.equal(S.uniqueFileName('c_gamma (cut).wav', ['a_alpha.wav']), 'c_gamma (cut).wav');
});

test('encodeWav roundtrips through the app decoder', async () => {
  const sr = 8000;
  const n = 1600;
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5;
  const wav = S.encodeWav([ch], sr);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), sr);
  const file = path.join(os.tmpdir(), `section-editor-${process.pid}.wav`);
  await fs.writeFile(file, wav);
  try {
    const decoded = await decodeMono(file, 10);
    assert.equal(decoded.sr, sr);
    assert.ok(Math.abs(decoded.data.length - n) <= 1);
    let err = 0;
    const m = Math.min(decoded.data.length, n);
    for (let i = 0; i < m; i++) err = Math.max(err, Math.abs(decoded.data[i] - ch[i]));
    assert.ok(err < 1 / 1000, `quantization error ${err}`);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
});

test('stereo encode keeps both channels and mixDown averages them', () => {
  const left = Float32Array.from([0.5, 0.5]);
  const right = Float32Array.from([-0.5, 0.5]);
  const wav = S.encodeWav([left, right], 8000);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(dv.getUint16(22, true), 2);
  assert.equal(dv.getUint32(40, true), 8);
  const mixed = S.mixDown([left, right]);
  assert.ok(Math.abs(mixed[0]) < 1e-6);
  assert.ok(Math.abs(mixed[1] - 0.5) < 1e-6);
  const peaks = S.peakEnvelope(left, 2);
  assert.equal(peaks.length, 2);
  assert.ok(peaks[0] > 100);
});
