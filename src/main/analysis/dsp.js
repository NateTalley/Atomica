// Audio decoding + DSP feature extraction. Runs inside analysis worker threads.
import fs from 'node:fs/promises';
import path from 'node:path';
import FFT from 'fft.js';

const MAX_ANALYZE_SEC = 12;   // analyze at most this much audio per file
const EMBED_SR = 48000;       // CLAP expects 48 kHz mono
const EMBED_MAX_SEC = 10;     // CLAP max input length
export const PEAK_BINS = 128;

export function peakEnvelope(data, bins = PEAK_BINS) {
  const peaks = new Uint8Array(bins);
  if (!data.length) return peaks;
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

export async function peaksFromFile(filePath) {
  const { data } = await decodeToMono(filePath, MAX_ANALYZE_SEC);
  return peakEnvelope(data);
}

// ---------------------------------------------------------------- decoding

function str4(dv, off) {
  return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
}

// WAVE_FORMAT_* tags, for both dispatch and legible error messages.
const WAV_PCM = 0x0001, WAV_ADPCM_MS = 0x0002, WAV_FLOAT = 0x0003;
const WAV_ALAW = 0x0006, WAV_MULAW = 0x0007, WAV_ADPCM_IMA = 0x0011;
const WAV_MPEG = 0x0050, WAV_MP3 = 0x0055, WAV_EXTENSIBLE = 0xfffe;
const WAV_NAMES = {
  [WAV_PCM]: 'PCM', [WAV_ADPCM_MS]: 'Microsoft ADPCM', [WAV_FLOAT]: 'IEEE float',
  [WAV_ALAW]: 'A-law', [WAV_MULAW]: 'mu-law', [WAV_ADPCM_IMA]: 'IMA/DVI ADPCM',
  [WAV_MPEG]: 'MPEG layer 1/2', [WAV_MP3]: 'MP3', 0x0031: 'GSM 6.10', 0x0002: 'Microsoft ADPCM',
};
const wavFormatName = (tag) =>
  `${WAV_NAMES[tag] || 'unknown'} (0x${tag.toString(16).padStart(4, '0')})`;

// Splits a RIFF/WAVE file into its fmt description and data chunk bounds.
function parseWavChunks(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.byteLength < 44) throw new Error('too short to be a WAV');
  const magic = str4(dv, 0);
  // RF64 is the >4 GB variant; its chunk layout matches RIFF closely enough to read
  if ((magic !== 'RIFF' && magic !== 'RF64') || str4(dv, 8) !== 'WAVE') throw new Error('not RIFF/WAVE');
  let off = 12;
  let fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = str4(dv, off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16) {
      const cbSize = size >= 18 ? dv.getUint16(body + 16, true) : 0;
      fmt = {
        tag: dv.getUint16(body, true),
        ch: dv.getUint16(body + 2, true),
        sr: dv.getUint32(body + 4, true),
        blockAlign: dv.getUint16(body + 12, true),
        bits: dv.getUint16(body + 14, true),
        // ADPCM variants declare samples-per-block here; extensible hides the real tag in a GUID
        samplesPerBlock: cbSize >= 2 && size >= 20 ? dv.getUint16(body + 18, true) : 0,
        subTag: cbSize >= 22 && size >= 26 ? dv.getUint16(body + 24, true) : 0,
        extBody: body + 18,
        extLen: Math.max(0, size - 18),
        dv,
      };
    } else if (id === 'data') {
      dataOff = body;
      // a 0 or bogus size means "rest of file" — common in streamed/truncated WAVs
      if (size === 0 || size === 0xffffffff || size > dv.byteLength - body) size = dv.byteLength - body;
      dataLen = size;
      if (magic === 'RF64') break; // RF64 sizes live in a ds64 chunk; take the rest of the file
    }
    off = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0 || !fmt.ch || !fmt.sr) throw new Error('malformed WAV (no fmt/data chunk)');
  const tag = fmt.tag === WAV_EXTENSIBLE ? fmt.subTag : fmt.tag;
  return { dv, fmt, tag, dataOff, dataLen };
}

// --- companded 8-bit formats -------------------------------------------------

const alawTable = new Float32Array(256);
const mulawTable = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  let a = i ^ 0x55;
  const aSign = a & 0x80;
  const aExp = (a >> 4) & 0x07;
  const aMant = a & 0x0f;
  let av = aExp === 0 ? (aMant << 4) + 8 : ((aMant << 4) + 0x108) << (aExp - 1);
  alawTable[i] = (aSign ? -av : av) / 32768;

  const u = ~i & 0xff;
  const uSign = u & 0x80;
  const uExp = (u >> 4) & 0x07;
  const uMant = u & 0x0f;
  const uv = (((uMant << 3) + 0x84) << uExp) - 0x84;
  mulawTable[i] = (uSign ? -uv : uv) / 32768;
}

// --- IMA / DVI ADPCM ---------------------------------------------------------

const IMA_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
  449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
  9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

function decodeImaAdpcm(dv, dataOff, dataLen, fmt, maxFrames) {
  const ch = fmt.ch;
  const blockAlign = fmt.blockAlign || (4 * ch);
  if (blockAlign <= 4 * ch) throw new Error('bad IMA ADPCM block align');
  const spb = fmt.samplesPerBlock || ((blockAlign - 4 * ch) * 2) / ch + 1;
  const nBlocks = Math.floor(dataLen / blockAlign);
  const total = nBlocks * spb;
  const out = new Float32Array(Math.min(total, maxFrames));
  const pred = new Int32Array(ch), idx = new Int32Array(ch);
  const tmp = Array.from({ length: ch }, () => new Int32Array(spb));
  let w = 0;

  for (let b = 0; b < nBlocks && w < out.length; b++) {
    let p = dataOff + b * blockAlign;
    const blockEnd = p + blockAlign;
    for (let c = 0; c < ch; c++) {
      pred[c] = dv.getInt16(p, true);
      idx[c] = Math.min(88, Math.max(0, dv.getUint8(p + 2)));
      tmp[c][0] = pred[c];
      p += 4;
    }
    // after the headers, data arrives as 4-byte words cycling through channels,
    // each word holding 8 nibbles (low nibble first) for that channel
    let s = 1;
    while (s < spb && p + 4 * ch <= blockEnd) {
      for (let c = 0; c < ch; c++) {
        let sc = s;
        for (let k = 0; k < 4; k++) {
          const byte = dv.getUint8(p++);
          for (let half = 0; half < 2; half++) {
            const nib = half ? (byte >> 4) & 0x0f : byte & 0x0f;
            const step = IMA_STEP[idx[c]];
            let diff = step >> 3;
            if (nib & 1) diff += step >> 2;
            if (nib & 2) diff += step >> 1;
            if (nib & 4) diff += step;
            if (nib & 8) diff = -diff;
            let v = pred[c] + diff;
            pred[c] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
            idx[c] = Math.min(88, Math.max(0, idx[c] + IMA_INDEX[nib]));
            if (sc < spb) tmp[c][sc++] = pred[c];
          }
        }
      }
      s += 8;
    }
    for (let i = 0; i < spb && w < out.length; i++) {
      let acc = 0;
      for (let c = 0; c < ch; c++) acc += tmp[c][i];
      out[w++] = acc / ch / 32768;
    }
  }
  return { out, totalFrames: total };
}

// --- Microsoft ADPCM ---------------------------------------------------------

const MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const MS_COEF1 = [256, 512, 0, 192, 240, 460, 392];
const MS_COEF2 = [0, -256, 0, 64, 0, -208, -232];

function decodeMsAdpcm(dv, dataOff, dataLen, fmt, maxFrames) {
  const ch = fmt.ch;
  const blockAlign = fmt.blockAlign;
  const headerLen = 7 * ch;
  if (!blockAlign || blockAlign <= headerLen) throw new Error('bad MS ADPCM block align');
  const spb = fmt.samplesPerBlock || (blockAlign - headerLen) * 2 / ch + 2;
  // coefficient pairs may be overridden in the fmt extension
  let coef1 = MS_COEF1, coef2 = MS_COEF2;
  if (fmt.extLen >= 4) {
    const nCoef = fmt.dv.getUint16(fmt.extBody + 2, true);
    if (nCoef > 0 && nCoef <= 32 && fmt.extLen >= 4 + nCoef * 4) {
      coef1 = []; coef2 = [];
      for (let i = 0; i < nCoef; i++) {
        coef1.push(fmt.dv.getInt16(fmt.extBody + 4 + i * 4, true));
        coef2.push(fmt.dv.getInt16(fmt.extBody + 6 + i * 4, true));
      }
    }
  }
  const nBlocks = Math.floor(dataLen / blockAlign);
  const total = nBlocks * spb;
  const out = new Float32Array(Math.min(total, maxFrames));
  const predIdx = new Int32Array(ch), delta = new Int32Array(ch);
  const s1 = new Int32Array(ch), s2 = new Int32Array(ch);
  const clamp = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);
  let w = 0;

  for (let b = 0; b < nBlocks && w < out.length; b++) {
    let p = dataOff + b * blockAlign;
    const blockEnd = p + blockAlign;
    for (let c = 0; c < ch; c++) predIdx[c] = Math.min(coef1.length - 1, dv.getUint8(p++));
    for (let c = 0; c < ch; c++) { delta[c] = dv.getInt16(p, true); p += 2; }
    for (let c = 0; c < ch; c++) { s1[c] = dv.getInt16(p, true); p += 2; }
    for (let c = 0; c < ch; c++) { s2[c] = dv.getInt16(p, true); p += 2; }

    // the two seed samples are emitted before any nibble is read
    let acc2 = 0, acc1 = 0;
    for (let c = 0; c < ch; c++) { acc2 += s2[c]; acc1 += s1[c]; }
    if (w < out.length) out[w++] = acc2 / ch / 32768;
    if (w < out.length) out[w++] = acc1 / ch / 32768;

    for (let s = 2; s < spb && p < blockEnd; s++) {
      let acc = 0;
      for (let c = 0; c < ch; c++) {
        // nibbles alternate channels every sample, high nibble first
        const byte = dv.getUint8(p);
        const nib = (s * ch + c) % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
        if ((s * ch + c) % 2 === 1) p++;
        const signed = nib > 7 ? nib - 16 : nib;
        let v = (s1[c] * coef1[predIdx[c]] + s2[c] * coef2[predIdx[c]]) >> 8;
        v = clamp(v + signed * delta[c]);
        s2[c] = s1[c];
        s1[c] = v;
        delta[c] = Math.max(16, (MS_ADAPT[nib] * delta[c]) >> 8);
        acc += v;
      }
      if (w < out.length) out[w++] = acc / ch / 32768;
    }
  }
  return { out, totalFrames: total };
}

// --- dispatch ----------------------------------------------------------------

// Native WAV decode, mixed to mono. Throws for formats needing an async decoder.
function parseWav(buf, maxSec) {
  const { dv, fmt, tag, dataOff, dataLen } = parseWavChunks(buf);
  const ch = fmt.ch;
  const maxFrames = Math.ceil(maxSec * fmt.sr);

  if (tag === WAV_ADPCM_IMA || tag === WAV_ADPCM_MS) {
    const dec = tag === WAV_ADPCM_IMA
      ? decodeImaAdpcm(dv, dataOff, dataLen, fmt, maxFrames)
      : decodeMsAdpcm(dv, dataOff, dataLen, fmt, maxFrames);
    return { sr: fmt.sr, data: dec.out, fullDuration: dec.totalFrames / fmt.sr };
  }

  const bytesPer = tag === WAV_ALAW || tag === WAV_MULAW ? 1 : fmt.bits >> 3;
  const frameBytes = bytesPer * ch;
  if (!frameBytes) throw new Error(`unsupported WAV format ${wavFormatName(tag)} ${fmt.bits}-bit`);
  const totalFrames = Math.floor(dataLen / frameBytes);
  const frames = Math.min(totalFrames, maxFrames);
  const out = new Float32Array(frames);

  // resolve the per-sample reader once rather than re-branching inside the loop
  let read;
  if (tag === WAV_PCM && fmt.bits === 16) read = (p) => dv.getInt16(p, true) / 32768;
  else if (tag === WAV_PCM && fmt.bits === 24) read = (p) => {
    let x = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
    if (x & 0x800000) x -= 0x1000000;
    return x / 8388608;
  };
  else if (tag === WAV_PCM && fmt.bits === 32) read = (p) => dv.getInt32(p, true) / 2147483648;
  else if (tag === WAV_PCM && fmt.bits === 8) read = (p) => (dv.getUint8(p) - 128) / 128;
  else if (tag === WAV_FLOAT && fmt.bits === 32) read = (p) => dv.getFloat32(p, true);
  else if (tag === WAV_FLOAT && fmt.bits === 64) read = (p) => dv.getFloat64(p, true);
  else if (tag === WAV_ALAW) read = (p) => alawTable[dv.getUint8(p)];
  else if (tag === WAV_MULAW) read = (p) => mulawTable[dv.getUint8(p)];
  else throw new Error(`unsupported WAV format ${wavFormatName(tag)} ${fmt.bits}-bit`);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    let p = dataOff + i * frameBytes;
    for (let c = 0; c < ch; c++, p += bytesPer) acc += read(p);
    out[i] = acc / ch;
  }
  return { sr: fmt.sr, data: out, fullDuration: totalFrames / fmt.sr };
}

function mixToMono(channels, length) {
  const chans = (channels || []).filter((c) => c && c.length);
  if (!chans.length || !length) return new Float32Array(0);
  const n = Math.min(length, ...chans.map((c) => c.length));
  const out = new Float32Array(n);
  for (const chData of chans) for (let i = 0; i < n; i++) out[i] += chData[i];
  if (chans.length > 1) for (let i = 0; i < n; i++) out[i] /= chans.length;
  return out;
}

function isFlacMagic(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, Math.min(4, buf.byteLength));
  return u8.length >= 4 && u8[0] === 0x66 && u8[1] === 0x4c && u8[2] === 0x61 && u8[3] === 0x43; // fLaC
}

// Native FLAC (and Ogg-FLAC). audio-decode calls decoder.decode() without flush,
// which can yield empty/truncated PCM; decodeFile() parses the whole file.
async function decodeFlac(buf, maxSec) {
  const { FLACDecoder } = await import('@wasm-audio-decoders/flac');
  const dec = new FLACDecoder();
  await dec.ready;
  try {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const res = await dec.decodeFile(u8);
    const chans = res && res.channelData;
    if (!chans || !chans.length || !res.samplesDecoded) throw new Error('FLAC produced no audio');
    const sr = res.sampleRate;
    if (!sr) throw new Error('FLAC missing sample rate');
    const frames = Math.min(res.samplesDecoded, Math.ceil(maxSec * sr));
    return { sr, data: mixToMono(chans, frames), fullDuration: res.samplesDecoded / sr };
  } finally {
    dec.free();
  }
}

// MP3/MPEG payload wrapped in a WAV container: hand the raw bitstream to the
// MP3 decoder, since node-wav only understands PCM and float.
async function decodeMpegInWav(buf, maxSec) {
  const { fmt, dataOff, dataLen } = parseWavChunks(buf);
  const payload = new Uint8Array(buf.buffer, buf.byteOffset + dataOff, dataLen);
  const { MPEGDecoder } = await import('mpg123-decoder');
  const dec = new MPEGDecoder();
  await dec.ready;
  try {
    const res = dec.decode(payload);
    if (!res.channelData.length || !res.samplesDecoded) throw new Error('MP3-in-WAV produced no audio');
    const sr = res.sampleRate || fmt.sr;
    const frames = Math.min(res.samplesDecoded, Math.ceil(maxSec * sr));
    return { sr, data: mixToMono(res.channelData, frames), fullDuration: res.samplesDecoded / sr };
  } finally {
    dec.free();
  }
}

// Exposed for playback: the renderer's decodeAudioData can't handle ADPCM or
// companded WAVs, so it falls back to decoding here.
export function decodeMono(filePath, maxSec) {
  return decodeToMono(filePath, maxSec);
}

async function decodeToMono(filePath, maxSec) {
  const buf = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let wavError = null;
  if (ext === '.wav' || ext === '.wave') {
    try {
      return parseWav(buf, maxSec);
    } catch (e) {
      wavError = e;
      // compressed payloads need an async decoder, which parseWav can't run
      try {
        const { tag } = parseWavChunks(buf);
        if (tag === WAV_MP3 || tag === WAV_MPEG) return await decodeMpegInWav(buf, maxSec);
      } catch (e2) { wavError = e2; }
    }
  }
  if (ext === '.flac' || isFlacMagic(buf)) {
    try {
      return await decodeFlac(buf, maxSec);
    } catch (e) {
      throw new Error(`FLAC decode failed: ${e.message || e}`);
    }
  }
  const { default: decodeAudio } = await import('audio-decode');
  let ab;
  try {
    ab = await decodeAudio(buf);
  } catch (e) {
    const why = wavError ? `${wavError.message}; ${e.message || e}` : (e.message || e);
    throw new Error(String(why));
  }
  const sr = ab.sampleRate;
  const frames = Math.min(ab.length, Math.ceil(maxSec * sr));
  const channels = [];
  for (let c = 0; c < ab.numberOfChannels; c++) channels.push(ab.getChannelData(c));
  return { sr, data: mixToMono(channels, frames), fullDuration: ab.duration };
}

export function resampleLinear(data, srIn, srOut, maxOutLen = Infinity) {
  if (srIn === srOut) return data.length <= maxOutLen ? data.slice() : data.slice(0, maxOutLen);
  const outLen = Math.min(Math.floor((data.length * srOut) / srIn), maxOutLen);
  const out = new Float32Array(outLen);
  const ratio = srIn / srOut;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const t = x - i0;
    out[i] = data[i0] * (1 - t) + data[i1] * t;
  }
  return out;
}

// ---------------------------------------------------------------- helpers

const fftCache = new Map();
function getFFT(size) {
  let f = fftCache.get(size);
  if (!f) { f = new FFT(size); fftCache.set(size, f); }
  return f;
}

const hannCache = new Map();
function hann(size) {
  let w = hannCache.get(size);
  if (!w) {
    w = new Float32Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    hannCache.set(size, w);
  }
  return w;
}

const N_MEL = 26;
const N_MFCC = 13;
const melCache = new Map();
function melFilterbank(sr, fftSize) {
  const key = `${sr}:${fftSize}`;
  let fb = melCache.get(key);
  if (fb) return fb;
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const nBins = fftSize / 2;
  const binHz = sr / fftSize;
  const mLo = mel(30), mHi = mel(Math.min(sr / 2, 16000));
  const centers = [];
  for (let i = 0; i < N_MEL + 2; i++) centers.push(imel(mLo + ((mHi - mLo) * i) / (N_MEL + 1)) / binHz);
  fb = [];
  for (let m = 1; m <= N_MEL; m++) {
    const lo = centers[m - 1], mid = centers[m], hi = centers[m + 1];
    const taps = [];
    for (let b = Math.max(0, Math.ceil(lo)); b < Math.min(nBins, Math.floor(hi) + 1); b++) {
      const w = b < mid ? (b - lo) / (mid - lo) : (hi - b) / (hi - mid);
      if (w > 0) taps.push([b, w]);
    }
    fb.push(taps);
  }
  melCache.set(key, fb);
  return fb;
}

// ---------------------------------------------------------------- pitch

function pitchTrack(data, sr) {
  const target = 11025;
  const ds = resampleLinear(data, sr, target, target * 6); // first 6 s is plenty
  const N = 1024, hop = 1024;
  const minLag = Math.floor(target / 1000); // 1000 Hz
  const maxLag = Math.floor(target / 30);   // 30 Hz
  const semis = [];
  let energetic = 0;
  for (let start = 0; start + N + maxLag < ds.length; start += hop) {
    let r0 = 0;
    for (let i = 0; i < N; i++) r0 += ds[start + i] * ds[start + i];
    if (r0 < 1e-6) continue;
    energetic++;
    const vals = new Float32Array(maxLag - minLag + 1);
    let globalMax = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0, den = 0;
      for (let i = 0; i < N; i += 2) { // stride 2: 2x faster, plenty accurate for voicing
        const a = ds[start + i], b = ds[start + i + lag];
        num += a * b;
        den += a * a + b * b;
      }
      const v = den > 0 ? (2 * num) / den : 0;
      vals[lag - minLag] = v;
      if (v > globalMax) globalMax = v;
    }
    // a periodic signal peaks at every multiple of its period — take the
    // smallest-lag local maximum near the global max to avoid subharmonics
    let bestLag = -1;
    if (globalMax > 0.7) {
      for (let lag = minLag + 1; lag < maxLag; lag++) {
        const v = vals[lag - minLag];
        if (v >= 0.92 * globalMax && v >= vals[lag - minLag - 1] && v >= vals[lag - minLag + 1]) {
          bestLag = lag;
          break;
        }
      }
    }
    if (bestLag > 0) {
      // parabolic interpolation around the peak for sub-bin accuracy
      const y0 = vals[bestLag - minLag - 1], y1 = vals[bestLag - minLag], y2 = vals[bestLag - minLag + 1];
      const denom = y0 - 2 * y1 + y2;
      const shift = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
      const freq = target / (bestLag + shift);
      semis.push(69 + 12 * Math.log2(freq / 440));
    }
  }
  if (!energetic || semis.length / energetic < 0.25) return null;
  semis.sort((a, b) => a - b);
  return semis[Math.floor(semis.length / 2)];
}

// ---------------------------------------------------------------- loop / BPM

function parseNameHints(filePath) {
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const folder = path.basename(path.dirname(filePath)).toLowerCase();
  const blob = `${folder} ${base}`;
  const spaced = blob.replace(/[._-]+/g, ' ');
  let namedBpm = null;
  const re = /(?:^|[^0-9])(\d{2,3})\s*bpm\b|\bbpm\s*[_-]?(\d{2,3})(?:[^0-9]|$)/gi;
  let m;
  while ((m = re.exec(spaced))) {
    const b = parseInt(m[1] || m[2], 10);
    if (b >= 50 && b <= 220) namedBpm = b;
  }
  const isLoopName = /\b(loops?|lps?)\b/.test(spaced);
  const isOneshotName = /\b(one\s*shots?|1\s*shots?)\b/.test(spaced);
  return { namedBpm, isLoopName, isOneshotName };
}

function foldBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  while (bpm < 70 && bpm * 2 <= 200) bpm *= 2;
  while (bpm > 175 && bpm / 2 >= 70) bpm /= 2;
  if (bpm < 50 || bpm > 220) return null;
  return bpm;
}

function beatFit(duration, bpm) {
  if (!bpm || duration < 0.4) return 0;
  const beats = duration * bpm / 60;
  const nearest = Math.round(beats);
  if (nearest < 1) return 0;
  const err = Math.abs(beats - nearest);
  return err < 0.08 ? 1 : Math.max(0, 1 - err * 5);
}

function onsetEnvelope(data, hop) {
  const n = Math.max(1, Math.floor(data.length / hop));
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const start = i * hop;
    const end = Math.min(start + hop, data.length);
    for (let j = start + 1; j < end; j++) {
      const d = data[j] - data[j - 1];
      s += d * d;
    }
    env[i] = Math.sqrt(s / Math.max(1, end - start));
  }
  return env;
}

export function detectRhythm(data, sr, fullDuration, filePath, frameRms, hop) {
  const hints = parseNameHints(filePath);
  const n = frameRms.length;
  const frameDur = hop / sr;
  const maxR = frameRms.reduce((a, b) => (b > a ? b : a), 0) || 1e-12;
  const cut = Math.max(1, Math.floor(n * 0.25));
  let head = 0, tail = 0, active = 0;
  for (let i = 0; i < n; i++) {
    if (frameRms[i] > 0.12 * maxR) active++;
    if (i < cut) head += frameRms[i];
    if (i >= n - cut) tail += frameRms[i];
  }
  const sustain = (tail / cut) / (head / cut + 1e-12);
  const activeFrac = n ? active / n : 0;

  let bpm = null;
  let periodStr = 0;
  if (n >= 24 && fullDuration >= 0.5) {
    const env = onsetEnvelope(data, hop);
    const nov = new Float32Array(env.length);
    for (let i = 1; i < env.length; i++) nov[i] = Math.max(0, env[i] - env[i - 1]);
    let mean = 0;
    for (let i = 0; i < nov.length; i++) mean += nov[i];
    mean /= nov.length;
    for (let i = 0; i < nov.length; i++) nov[i] = Math.max(0, nov[i] - mean);
    let ac0 = 0;
    for (let i = 0; i < nov.length; i++) ac0 += nov[i] * nov[i];
    const minLag = Math.max(2, Math.round(0.27 / frameDur)); // ~220 BPM
    const maxLag = Math.min(nov.length - 3, Math.round(Math.min(4, fullDuration * 0.5) / frameDur));
    let bestLag = -1, best = 0;
    if (ac0 > 1e-12 && maxLag > minLag) {
      for (let lag = minLag; lag <= maxLag; lag++) {
        let s = 0;
        const lim = nov.length - lag;
        for (let i = 0; i < lim; i++) s += nov[i] * nov[i + lag];
        if (s > best) { best = s; bestLag = lag; }
      }
      periodStr = best / ac0;
      if (bestLag > 0) {
        let lag = bestLag;
        if (bestLag > minLag && bestLag < maxLag) {
          const y0 = (() => {
            let s = 0;
            const lim = nov.length - (bestLag - 1);
            for (let i = 0; i < lim; i++) s += nov[i] * nov[i + bestLag - 1];
            return s;
          })();
          const y2 = (() => {
            let s = 0;
            const lim = nov.length - (bestLag + 1);
            for (let i = 0; i < lim; i++) s += nov[i] * nov[i + bestLag + 1];
            return s;
          })();
          const denom = y0 - 2 * best + y2;
          if (Math.abs(denom) > 1e-12) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
        }
        bpm = foldBpm(60 / (lag * frameDur));
      }
    }
  }

  if (hints.namedBpm) {
    if (!bpm || Math.abs(foldBpm(bpm * 2) - hints.namedBpm) < 4 || Math.abs(foldBpm(bpm / 2) - hints.namedBpm) < 4
      || Math.abs(bpm - hints.namedBpm) < 8 || hints.isLoopName) {
      bpm = hints.namedBpm;
      periodStr = Math.max(periodStr, 0.35);
    }
  }

  const fit = beatFit(fullDuration, bpm);
  let kind;
  if (hints.isOneshotName && !hints.isLoopName && !hints.namedBpm) kind = 'oneshot';
  else if (hints.isLoopName || hints.namedBpm) kind = 'loop';
  else if (fullDuration < 0.4) kind = 'oneshot';
  else if (fullDuration < 0.85 && sustain < 0.4 && periodStr < 0.22) kind = 'oneshot';
  else if (periodStr >= 0.26 && fullDuration >= 0.65) kind = 'loop';
  else if (fit > 0.75 && bpm && fullDuration >= 0.6) kind = 'loop';
  else if (sustain >= 0.55 && activeFrac >= 0.72 && fullDuration >= 1.15) kind = 'loop';
  else kind = 'oneshot';

  if (kind !== 'loop') bpm = null;
  else if (bpm) bpm = Math.round(bpm);

  return { kind, bpm };
}

export async function rhythmFromFile(filePath) {
  const { sr, data, fullDuration } = await decodeToMono(filePath, MAX_ANALYZE_SEC);
  const N = 2048, hop = 1024;
  const nFrames = Math.max(1, Math.floor((data.length - N) / hop) + 1);
  const frameRms = [];
  for (let fr = 0; fr < nFrames; fr++) {
    const start = fr * hop;
    let rms = 0;
    for (let i = 0; i < N; i++) {
      const s = start + i < data.length ? data[start + i] : 0;
      rms += s * s;
    }
    frameRms.push(Math.sqrt(rms / N));
  }
  return detectRhythm(data, sr, fullDuration, filePath, frameRms, hop);
}

// ---------------------------------------------------------------- main entry

export async function analyzeFile(filePath, wantAudio48) {
  const { sr, data, fullDuration } = await decodeToMono(filePath, MAX_ANALYZE_SEC);
  if (!data.length) throw new Error('empty audio');

  const N = 2048, hop = 1024;
  const fft = getFFT(N);
  const win = hann(N);
  const fb = melFilterbank(sr, N);
  const nBins = N / 2;
  const binHz = sr / N;

  const input = new Float64Array(N);
  const spec = fft.createComplexArray();
  const mags = new Float32Array(nBins);
  const prevMags = new Float32Array(nBins);

  const frameRms = [];
  const cents = [], rolls = [], flats = [], fluxes = [];
  const mfccSum = new Float64Array(N_MFCC);
  const logMel = new Float64Array(N_MEL);
  let specFrames = 0;
  let maxRms = 0;

  const nFrames = Math.max(1, Math.floor((data.length - N) / hop) + 1);
  for (let fr = 0; fr < nFrames; fr++) {
    const start = fr * hop;
    let rms = 0;
    for (let i = 0; i < N; i++) {
      const s = start + i < data.length ? data[start + i] : 0;
      input[i] = s * win[i];
      rms += s * s;
    }
    rms = Math.sqrt(rms / N);
    frameRms.push(rms);
    if (rms > maxRms) maxRms = rms;
  }
  const rmsThresh = Math.max(1e-5, maxRms * 0.05);

  for (let fr = 0; fr < nFrames; fr++) {
    if (frameRms[fr] <= rmsThresh) continue;
    const start = fr * hop;
    for (let i = 0; i < N; i++) input[i] = (start + i < data.length ? data[start + i] : 0) * win[i];
    fft.realTransform(spec, input);

    let sum = 0, wsum = 0, logSum = 0;
    for (let b = 0; b < nBins; b++) {
      const re = spec[2 * b], im = spec[2 * b + 1];
      const m = Math.sqrt(re * re + im * im);
      mags[b] = m;
      sum += m;
      wsum += m * b * binHz;
      logSum += Math.log(m + 1e-12);
    }
    if (sum < 1e-9) continue;

    cents.push(wsum / sum);
    // rolloff (85% of magnitude)
    let acc = 0, roll = nBins - 1;
    const targetSum = sum * 0.85;
    for (let b = 0; b < nBins; b++) { acc += mags[b]; if (acc >= targetSum) { roll = b; break; } }
    rolls.push(Math.max(roll, 1) * binHz);
    // flatness: geometric mean / arithmetic mean
    flats.push(Math.exp(logSum / nBins) / (sum / nBins));
    // flux vs previous spectral frame
    if (specFrames > 0) {
      let fx = 0;
      for (let b = 0; b < nBins; b++) { const d = mags[b] - prevMags[b]; if (d > 0) fx += d * d; }
      fluxes.push(Math.sqrt(fx) / (sum / nBins + 1e-12) / nBins);
    }
    prevMags.set(mags);
    // MFCC
    for (let m = 0; m < N_MEL; m++) {
      let e = 0;
      const taps = fb[m];
      for (let t = 0; t < taps.length; t++) { const mg = mags[taps[t][0]]; e += mg * mg * taps[t][1]; }
      logMel[m] = Math.log(e + 1e-10);
    }
    for (let k = 1; k <= N_MFCC; k++) {
      let c = 0;
      for (let m = 0; m < N_MEL; m++) c += logMel[m] * Math.cos((Math.PI * k * (m + 0.5)) / N_MEL);
      mfccSum[k - 1] += c;
    }
    specFrames++;
  }

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  // overall loudness over active frames
  let rsum = 0, rcount = 0;
  for (const r of frameRms) if (r > rmsThresh) { rsum += r * r; rcount++; }
  const loudness = 20 * Math.log10(Math.sqrt(rcount ? rsum / rcount : 1e-10) + 1e-10);

  // attack: time to reach 90% of peak envelope
  let attackFrame = 0;
  for (let fr = 0; fr < frameRms.length; fr++) { if (frameRms[fr] >= 0.9 * maxRms) { attackFrame = fr; break; } }
  const attack = Math.log10((attackFrame * hop) / sr + 0.002);

  const centroid = mean(cents) || binHz;
  const features = {
    duration: fullDuration,
    loudness,
    brightness: Math.log2(Math.max(centroid, 20)),
    noisiness: mean(flats),
    rolloff: Math.log2(Math.max(mean(rolls), 20)),
    flux: mean(fluxes),
    pitch: pitchTrack(data, sr),
    attack,
  };
  const rhythm = detectRhythm(data, sr, fullDuration, filePath, frameRms, hop);
  features.kind = rhythm.kind;
  features.bpm = rhythm.bpm;
  const mfcc = Array.from(mfccSum, (v) => (specFrames ? v / specFrames : 0));

  let audio48 = null;
  if (wantAudio48) audio48 = resampleLinear(data, sr, EMBED_SR, EMBED_SR * EMBED_MAX_SEC);
  const peaks = peakEnvelope(data);

  return { features, mfcc, audio48, peaks };
}
