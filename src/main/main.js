import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const AUDIO_EXT = new Set(['.wav', '.wave', '.mp3', '.flac', '.ogg', '.oga']);
const SCALARS = ['brightness', 'pitch', 'loudness', 'duration', 'attack', 'noisiness', 'flux', 'rolloff'];
const PEAK_BINS = 128;
const CACHE_VERSION = 2;
const CATEGORIES = [
  { label: 'Kick', prompt: 'the sound of a kick drum' },
  { label: 'Snare', prompt: 'the sound of a snare drum' },
  { label: 'Clap', prompt: 'the sound of a clap or handclap' },
  { label: 'Hi-hat', prompt: 'the sound of a hi-hat cymbal' },
  { label: 'Cymbal', prompt: 'the sound of a crash or ride cymbal' },
  { label: 'Tom', prompt: 'the sound of a tom drum' },
  { label: 'Perc', prompt: 'the sound of percussion' },
  { label: 'Bass', prompt: 'the sound of a bass one-shot' },
  { label: 'Synth', prompt: 'the sound of a synthesizer' },
  { label: 'Pad', prompt: 'the sound of a synth pad' },
  { label: 'Lead', prompt: 'the sound of a synth lead' },
  { label: 'Vocal', prompt: 'the sound of a vocal sample' },
  { label: 'FX', prompt: 'the sound of a sound effect or riser' },
  { label: 'Guitar', prompt: 'the sound of a guitar' },
  { label: 'Keys', prompt: 'the sound of a piano or keyboard' },
  { label: 'Strings', prompt: 'the sound of strings' },
  { label: 'Loop', prompt: 'the sound of a musical loop' },
  { label: 'Atmosphere', prompt: 'the sound of an atmosphere or texture' },
];
const CATEGORY_PROMPTS = CATEGORIES.map((c) => c.prompt);

let win = null;

// ------------------------------------------------------------ state

const defaultParams = () => ({
  mode: 'similarity',
  method: 'umap',
  nNeighbors: 15,
  minDist: 0.1,
  weights: {
    embedding: 1.0, mfcc: 0.6, brightness: 0.5, pitch: 0.4,
    loudness: 0.3, duration: 0.4, attack: 0.3, noisiness: 0.3,
  },
  axes: { x: 'brightness', y: 'pitch' },
  colorBy: 'folder',
  sizeBy: 'loudness',
  view: 'map',
  volume: 0.9,
});

const state = {
  folders: [],
  useEmbeddings: true,
  params: defaultParams(),
};

// path -> { p, mt, sz, f: {..features}, mfcc: [], emb: Float32Array|null, peaks: Uint8Array|null }
const library = new Map();
let datasetOrder = []; // stable ordering of paths for the current dataset

const userDir = () => app.getPath('userData');
const settingsFile = () => path.join(userDir(), 'settings.json');
const cacheFile = () => path.join(userDir(), 'cache.json');
const modelsDir = () => path.join(userDir(), 'models');

// settings/cache may be hand-edited on Windows and arrive with a UTF-8 BOM
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

async function loadSettings() {
  try {
    const s = JSON.parse(stripBom(await fs.readFile(settingsFile(), 'utf8')));
    if (Array.isArray(s.folders)) state.folders = s.folders;
    if (typeof s.useEmbeddings === 'boolean') state.useEmbeddings = s.useEmbeddings;
    if (s.params) state.params = { ...defaultParams(), ...s.params, weights: { ...defaultParams().weights, ...(s.params.weights || {}) } };
  } catch { /* first run */ }
}

async function saveSettings() {
  try {
    await fs.writeFile(settingsFile(), JSON.stringify({
      folders: state.folders, useEmbeddings: state.useEmbeddings, params: state.params,
    }, null, 2));
  } catch (e) { console.error('saveSettings:', e); }
}

async function loadCache() {
  try {
    const c = JSON.parse(stripBom(await fs.readFile(cacheFile(), 'utf8')));
    if ((c.version !== 1 && c.version !== 2) || !Array.isArray(c.entries)) return;
    for (const e of c.entries) {
      let emb = null;
      if (e.emb) {
        const raw = Buffer.from(e.emb, 'base64');
        emb = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      }
      let peaks = null;
      if (e.peaks) {
        const raw = Buffer.from(e.peaks, 'base64');
        peaks = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
        if (peaks.length !== PEAK_BINS) peaks = null;
      }
      library.set(e.p, { p: e.p, mt: e.mt, sz: e.sz, f: e.f, mfcc: e.mfcc, emb, peaks });
    }
  } catch { /* no cache yet */ }
}

function packB64(typed) {
  if (!typed) return null;
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');
}

async function saveCache() {
  try {
    const entries = [];
    for (const e of library.values()) {
      entries.push({
        p: e.p, mt: e.mt, sz: e.sz, f: e.f, mfcc: e.mfcc,
        emb: packB64(e.emb),
        peaks: packB64(e.peaks),
      });
    }
    await fs.writeFile(cacheFile(), JSON.stringify({ version: CACHE_VERSION, entries }));
  } catch (e) { console.error('saveCache:', e); }
}

// ------------------------------------------------------------ messaging

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
let lastProgressAt = 0;
function progress(phase, done, total, msg, force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < 150) return;
  lastProgressAt = now;
  send('progress', { phase, done, total, msg });
}

// ------------------------------------------------------------ scanning

async function walk(dir, out, depth = 0) {
  if (depth > 12) return;
  let items;
  try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) await walk(full, out, depth + 1);
    else if (it.isFile() && AUDIO_EXT.has(path.extname(it.name).toLowerCase())) {
      try {
        const st = await fs.stat(full);
        if (st.size > 0 && st.size < 300 * 1024 * 1024) out.push({ path: full, mt: st.mtimeMs, sz: st.size });
      } catch { /* unreadable */ }
    }
  }
}

// ------------------------------------------------------------ workers

let embedFatal = false;
const EMBED_BATCH = 8;
// Exactly one worker: onnxruntime-node fatals if its native addon is loaded in
// more than one worker thread. It persists across rescans to keep the model warm.
const embedder = { worker: null, busy: false, onResult: null };
const embedJobs = [];

function ensureEmbedWorker() {
  if (!embedder.worker) {
    embedder.worker = new Worker(new URL('./analysis/embed-worker.js', import.meta.url), {
      workerData: { cacheDir: modelsDir() },
    });
    embedder.worker.on('message', (msg) => {
      embedder.busy = false;
      const cb = embedder.onResult;
      embedder.onResult = null;
      if (cb) cb(msg);
      pumpEmbedJobs();
    });
    embedder.worker.on('error', (e) => {
      console.error('embed worker crashed:', e);
      const paths = embedder.currentPaths || [];
      embedder.busy = false;
      embedder.worker = null;
      const cb = embedder.onResult;
      embedder.onResult = null;
      if (cb) cb({ type: 'embed-error', paths, error: String(e.message || e) });
      pumpEmbedJobs();
    });
  }
  return embedder.worker;
}

function enqueueEmbedJob(msg, transfers, handler) {
  embedJobs.push({ msg, transfers: transfers || [], handler });
  pumpEmbedJobs();
}

function pumpEmbedJobs() {
  if (embedder.busy || !embedJobs.length) return;
  const job = embedJobs.shift();
  const ew = ensureEmbedWorker();
  if (!ew) {
    job.handler({ type: 'embed-fatal', error: 'embed worker unavailable' });
    pumpEmbedJobs();
    return;
  }
  embedder.busy = true;
  embedder.currentPaths = job.msg.items ? job.msg.items.map((it) => it.path) : [];
  embedder.onResult = job.handler;
  ew.postMessage(job.msg, job.transfers);
}

let textEmbeds = null; // Float32Array nLabels * dim
let textEmbedDim = 0;
let textEmbedInflight = null;

function hasAnyEmb() {
  for (const e of library.values()) if (e.emb) return true;
  return false;
}

async function ensureTextEmbeds() {
  if (textEmbeds) return textEmbeds;
  if (textEmbedInflight) return textEmbedInflight;
  textEmbedInflight = new Promise((resolve) => {
    enqueueEmbedJob({ type: 'embed-text', texts: CATEGORY_PROMPTS }, [], (msg) => {
      if (msg.type === 'text-embedded' && msg.embeds) {
        textEmbeds = msg.embeds;
        textEmbedDim = msg.dim;
        resolve(textEmbeds);
      } else {
        console.warn('text embed failed:', msg.error);
        textEmbedInflight = null;
        resolve(null);
      }
    });
  });
  return textEmbedInflight;
}

function classifyEmb(emb) {
  if (!emb || !textEmbeds) return { category: null, conf: 0 };
  const nLab = CATEGORIES.length;
  const dim = Math.min(emb.length, textEmbedDim || emb.length);
  let best = -1, bestS = -Infinity, second = -Infinity;
  for (let i = 0; i < nLab; i++) {
    let s = 0;
    const off = i * textEmbedDim;
    for (let d = 0; d < dim; d++) s += emb[d] * textEmbeds[off + d];
    if (s > bestS) { second = bestS; bestS = s; best = i; }
    else if (s > second) second = s;
  }
  if (best < 0 || bestS < 0.12 || bestS - second < 0.015) {
    return { category: 'Uncategorized', conf: bestS === -Infinity ? 0 : bestS };
  }
  return { category: CATEGORIES[best].label, conf: bestS };
}

let scanning = false;
async function rescan() {
  if (scanning) return;
  scanning = true;
  try {
    progress('scan', 0, 0, 'Scanning folders…', true);
    const found = [];
    for (const folder of state.folders) await walk(folder, found);

    const foundMap = new Map(found.map((f) => [f.path, f]));
    for (const key of [...library.keys()]) if (!foundMap.has(key)) library.delete(key);

    const todo = found.filter((f) => {
      const e = library.get(f.path);
      if (!e || e.mt !== f.mt || e.sz !== f.sz) return true;
      if (state.useEmbeddings && !e.emb) return true; // embeddings newly enabled
      return false;
    });

    progress('scan', 0, 0, `Found ${found.length} samples, ${todo.length} to analyze`, true);
    if (todo.length) await analyzeFiles(todo);

    const needPeaks = [...library.values()].filter((e) => !e.peaks);
    if (needPeaks.length) await fillPeaks(needPeaks);

    if (hasAnyEmb()) {
      progress('classify', 0, 0, 'Categorizing samples…', true);
      await ensureTextEmbeds();
    }

    await saveCache();
    sendDataset();
    if (state.params.mode === 'similarity' && library.size) computeLayout(state.params);
    progress('idle', 0, 0, '', true);
  } catch (e) {
    console.error('rescan failed:', e);
    progress('idle', 0, 0, 'Scan failed: ' + e.message, true);
  } finally {
    scanning = false;
  }
}

function fillPeaks(entries) {
  return new Promise((resolve) => {
    const total = entries.length;
    let next = 0, done = 0;
    const nWorkers = Math.min(Math.max(1, os.cpus().length - 1), 4, total);
    const workers = [];
    const finish = () => {
      for (const w of workers) w.terminate();
      resolve();
    };
    const dispatch = (w) => {
      if (next >= total) {
        w.idle = true;
        if (workers.every((x) => x.idle)) finish();
        return;
      }
      const e = entries[next++];
      w.postMessage({ type: 'peaks', path: e.p });
    };
    for (let i = 0; i < nWorkers; i++) {
      const w = new Worker(new URL('./analysis/analysis-worker.js', import.meta.url));
      w.idle = false;
      workers.push(w);
      w.on('message', (msg) => {
        if (msg.type !== 'peaks-result') return;
        done++;
        if (!msg.error && msg.peaks) {
          const e = library.get(msg.path);
          if (e) e.peaks = msg.peaks;
        }
        progress('peaks', done, total, `Waveforms ${done}/${total}`);
        dispatch(w);
      });
      w.on('error', (e) => {
        console.error('peaks worker error:', e);
        w.idle = true;
        if (workers.every((x) => x.idle)) finish();
      });
      dispatch(w);
    }
    if (!nWorkers) finish();
  });
}

function analyzeFiles(files) {
  return new Promise((resolve) => {
    const total = files.length;
    const wantEmb = state.useEmbeddings;
    let next = 0, analyzed = 0, embedded = 0, embTotal = 0;
    let analysisDone = false;
    let pendingEmbedJobs = 0;

    const nWorkers = Math.min(Math.max(1, os.cpus().length - 1), 4, total);
    const workers = [];
    const embedQueue = [];

    const maybeFinish = () => {
      if (analysisDone && (!wantEmb || embedFatal || (embedQueue.length === 0 && pendingEmbedJobs === 0))) {
        for (const w of workers) w.terminate();
        progress('analyze', total, total, 'Analysis complete', true);
        resolve();
      }
    };

    const pumpEmbed = () => {
      if (!wantEmb || embedFatal) return maybeFinish();
      // hold a partial batch back until analysis is done, then flush whatever's left
      if (!embedQueue.length || (embedQueue.length < EMBED_BATCH && !analysisDone)) return maybeFinish();
      const items = embedQueue.splice(0, EMBED_BATCH);
      pendingEmbedJobs++;
      enqueueEmbedJob({ type: 'embed-batch', items }, items.map((it) => it.audio.buffer), (msg) => {
        pendingEmbedJobs--;
        if (msg.type === 'embedded') {
          msg.paths.forEach((p, i) => {
            const e = library.get(p);
            if (e) e.emb = msg.embs[i];
          });
          embedded += msg.paths.length;
          progress('embed', embedded, embTotal, `AI analysis ${embedded}/${embTotal}`);
        } else if (msg.type === 'embed-fatal') {
          embedFatal = true;
          embedQueue.length = 0;
          send('notice', { kind: 'warn', msg: 'AI similarity model unavailable (' + msg.error + '). Using DSP features only.' });
        } else if (msg.type === 'embed-error') {
          console.warn('embed batch failed:', msg.error);
          embedded += (msg.paths || []).length;
        }
        pumpEmbed();
      });
    };

    const dispatch = (w) => {
      // simple backpressure so decoded audio doesn't pile up for the embedder
      if (next >= total || embedQueue.length > 24) {
        if (next >= total) {
          w.idle = true;
          // pumpEmbed, not maybeFinish: a partial final batch still needs flushing
          if (workers.every((x) => x.idle)) { analysisDone = true; pumpEmbed(); }
        } else {
          setTimeout(() => { if (!w.idle) dispatch(w); }, 250);
        }
        return;
      }
      const f = files[next++];
      w.currentMeta = f;
      w.postMessage({ type: 'file', path: f.path, wantAudio48: wantEmb && !embedFatal });
    };

    for (let i = 0; i < nWorkers; i++) {
      const w = new Worker(new URL('./analysis/analysis-worker.js', import.meta.url));
      w.idle = false;
      workers.push(w);
      w.on('message', (msg) => {
        if (msg.type !== 'result') return;
        analyzed++;
        if (msg.error) {
          console.warn('analyze failed:', msg.path, msg.error);
          library.delete(msg.path);
        } else {
          const meta = w.currentMeta;
          const prev = library.get(msg.path);
          library.set(msg.path, {
            p: msg.path, mt: meta.mt, sz: meta.sz,
            f: msg.features, mfcc: msg.mfcc,
            emb: prev && prev.emb ? prev.emb : null,
            peaks: msg.peaks || (prev && prev.peaks) || null,
          });
          if (msg.audio48 && wantEmb && !embedFatal) {
            embTotal++;
            embedQueue.push({ path: msg.path, audio: msg.audio48 });
            pumpEmbed();
          }
        }
        progress('analyze', analyzed, total, `Analyzing ${analyzed}/${total}`);
        if (analyzed % 500 === 0) saveCache();
        dispatch(w);
      });
      w.on('error', (e) => {
        console.error('analysis worker error:', e);
        w.idle = true;
        if (workers.every((x) => x.idle)) { analysisDone = true; maybeFinish(); }
      });
      dispatch(w);
    }
    if (!nWorkers) { analysisDone = true; maybeFinish(); }
  });
}

// ------------------------------------------------------------ dataset & layout

function buildDataset() {
  datasetOrder = [...library.keys()].sort();
  const n = datasetOrder.length;
  const peaks = new Uint8Array(n * PEAK_BINS);
  const ds = {
    n,
    paths: datasetOrder,
    names: new Array(n),
    folders: new Array(n),
    hasEmb: new Array(n),
    categories: new Array(n),
    categoryConf: new Array(n),
    peaks,
    features: Object.fromEntries(SCALARS.map((k) => [k, new Array(n)])),
  };
  for (let i = 0; i < n; i++) {
    const e = library.get(datasetOrder[i]);
    ds.names[i] = path.basename(e.p);
    ds.folders[i] = path.basename(path.dirname(e.p));
    ds.hasEmb[i] = !!e.emb;
    if (e.peaks && e.peaks.length === PEAK_BINS) peaks.set(e.peaks, i * PEAK_BINS);
    const cls = classifyEmb(e.emb);
    ds.categories[i] = !e.emb ? '—' : (!textEmbeds ? '…' : (cls.category || 'Uncategorized'));
    ds.categoryConf[i] = cls.conf;
    for (const k of SCALARS) ds.features[k][i] = e.f[k] ?? null;
  }
  return ds;
}

function sendDataset() {
  send('dataset', buildDataset());
}

function zscore(cols, n, dim) {
  // cols: Float64Array n*dim, in place; NaN -> column mean (i.e. 0 after scoring)
  for (let d = 0; d < dim; d++) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) { const v = cols[i * dim + d]; if (Number.isFinite(v)) { sum += v; cnt++; } }
    const mean = cnt ? sum / cnt : 0;
    let vs = 0;
    for (let i = 0; i < n; i++) {
      let v = cols[i * dim + d];
      if (!Number.isFinite(v)) v = mean;
      v -= mean;
      cols[i * dim + d] = v;
      vs += v * v;
    }
    const sd = Math.sqrt(vs / Math.max(1, cnt)) || 1;
    for (let i = 0; i < n; i++) cols[i * dim + d] /= sd;
  }
}

function buildVectors(params) {
  const n = datasetOrder.length;
  const w = params.weights || {};
  const anyEmb = state.useEmbeddings && datasetOrder.some((p) => library.get(p).emb);
  const embDim = anyEmb ? 512 : 0;
  const mfccDim = 13;
  const scalarKeys = ['brightness', 'pitch', 'loudness', 'duration', 'attack', 'noisiness'];
  const dim = scalarKeys.length + mfccDim + embDim;
  const X = new Float64Array(n * dim);

  for (let i = 0; i < n; i++) {
    const e = library.get(datasetOrder[i]);
    let o = i * dim;
    for (const k of scalarKeys) {
      let v = e.f[k];
      if (k === 'duration') v = Math.log1p(v);
      X[o++] = v == null ? NaN : v;
    }
    for (let d = 0; d < mfccDim; d++) X[o++] = e.mfcc ? e.mfcc[d] : NaN;
    if (embDim) {
      if (e.emb) for (let d = 0; d < embDim; d++) X[o++] = e.emb[d];
      else for (let d = 0; d < embDim; d++) X[o++] = NaN;
    }
  }
  zscore(X, n, dim);

  // group scaling: each group's total std mass = its weight
  const out = new Float32Array(n * dim);
  const scale = new Float64Array(dim);
  let o = 0;
  for (const k of scalarKeys) scale[o++] = w[k] ?? 0.3;
  for (let d = 0; d < mfccDim; d++) scale[o++] = (w.mfcc ?? 0.6) / Math.sqrt(mfccDim);
  for (let d = 0; d < embDim; d++) scale[o++] = (w.embedding ?? 1) / Math.sqrt(embDim);
  for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) out[i * dim + d] = X[i * dim + d] * scale[d];
  return { vectors: out, dim, n };
}

let layoutWorker = null;
let layoutToken = 0;

function computeLayout(params) {
  const n = datasetOrder.length;
  if (!n) return;
  const token = ++layoutToken;
  if (layoutWorker) { layoutWorker.terminate(); layoutWorker = null; }
  const { vectors, dim } = buildVectors(params);
  layoutWorker = new Worker(new URL('./analysis/layout-worker.js', import.meta.url));
  layoutWorker.on('message', (msg) => {
    if (msg.token !== layoutToken) return;
    if (msg.progress != null) progress('layout', Math.round(msg.progress * 100), 100, `Computing map ${Math.round(msg.progress * 100)}%`);
    if (msg.warning) send('notice', { kind: 'warn', msg: msg.warning });
    if (msg.positions) {
      send('positions', { positions: msg.positions });
      progress('idle', 0, 0, '', true);
      layoutWorker.terminate();
      layoutWorker = null;
    }
  });
  layoutWorker.on('error', (e) => console.error('layout worker:', e));
  progress('layout', 0, 100, 'Computing map…', true);
  layoutWorker.postMessage(
    { token, buffer: vectors.buffer, n, dim, method: params.method || 'umap', params },
    [vectors.buffer],
  );
}

// ------------------------------------------------------------ drag icon (tiny generated PNG)

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeDragIcon() {
  const S = 24;
  const rgba = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - S / 2 + 0.5, dy = y - S / 2 + 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) / (S / 2);
      const glow = Math.max(0, 1 - r);
      const a = Math.round(255 * Math.pow(glow, 1.6));
      const i = (y * S + x) * 4;
      rgba[i] = 255; rgba[i + 1] = 168; rgba[i + 2] = 40; rgba[i + 3] = a;
    }
  }
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

// ------------------------------------------------------------ IPC

function registerIpc() {
  const dragIcon = makeDragIcon();

  ipcMain.handle('get-state', () => ({
    folders: state.folders,
    useEmbeddings: state.useEmbeddings,
    params: state.params,
    sampleCount: library.size,
  }));

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return state.folders;
    for (const f of r.filePaths) if (!state.folders.includes(f)) state.folders.push(f);
    await saveSettings();
    rescan();
    return state.folders;
  });

  ipcMain.handle('remove-folder', async (_e, idx) => {
    const removed = state.folders.splice(idx, 1)[0];
    if (removed) {
      for (const key of [...library.keys()]) {
        if (key.startsWith(removed + path.sep) || key === removed) library.delete(key);
      }
      await saveSettings();
      await saveCache();
      sendDataset();
      if (state.params.mode === 'similarity' && library.size) computeLayout(state.params);
    }
    return state.folders;
  });

  ipcMain.handle('rescan', () => { rescan(); });

  ipcMain.handle('set-params', async (_e, params) => {
    state.params = params;
    await saveSettings();
  });

  ipcMain.handle('compute-layout', async (_e, params) => {
    state.params = params;
    await saveSettings();
    computeLayout(params);
  });

  ipcMain.handle('set-embeddings', async (_e, enabled) => {
    state.useEmbeddings = !!enabled;
    if (enabled) embedFatal = false;
    await saveSettings();
    if (enabled) rescan(); // analyze anything missing an embedding
  });

  ipcMain.handle('read-audio', async (_e, p) => {
    if (!library.has(p)) throw new Error('unknown sample');
    return await fs.readFile(p);
  });

  // Fallback for formats Chromium won't decode (ADPCM, A-law/mu-law, MP3-in-WAV).
  ipcMain.handle('decode-audio', async (_e, p) => {
    if (!library.has(p)) throw new Error('unknown sample');
    const { decodeMono } = await import('./analysis/dsp.js');
    const { sr, data } = await decodeMono(p, 120);
    return { sr, data };
  });

  ipcMain.on('start-drag', (e, p) => {
    if (!library.has(p)) return;
    e.sender.startDrag({ file: p, icon: dragIcon });
  });

  ipcMain.on('reveal', (_e, p) => {
    if (library.has(p)) shell.showItemInFolder(p);
  });

  ipcMain.handle('request-dataset', () => {
    const ds = buildDataset();
    if (hasAnyEmb() && !textEmbeds) {
      ensureTextEmbeds().then(() => sendDataset());
    }
    return ds;
  });
}

// ------------------------------------------------------------ app

async function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#000000',
    title: 'Atomica',
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  if (SMOKE) {
    win.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
  }
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await loadSettings();
  await loadCache();
  registerIpc();
  await createWindow();
  if (library.size) {
    // push cached data to renderer once it asks (request-dataset) — nothing to do here
  }
  if (state.folders.length) rescan();
  if (SMOKE) {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        const shot = process.env.SMOKE_SHOT;
        if (shot) await fs.writeFile(shot, img.toPNG());
      } catch (e) { console.error('capture failed:', e); }
      if (process.env.SMOKE_AUDIO) {
        try {
          const report = await win.webContents.executeJavaScript(`(async () => {
            const out = [];
            const ctx = new AudioContext();
            for (let i = 0; i < dataset.n; i++) {
              const p = dataset.paths[i];
              let route = 'native', ok = false, err = '';
              try {
                const bytes = await window.atomica.readAudio(p);
                const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                const buf = await ctx.decodeAudioData(ab);
                ok = buf.length > 0;
              } catch {
                route = 'fallback';
                try {
                  const pcm = await window.atomica.decodeAudio(p);
                  const d = pcm.data instanceof Float32Array ? pcm.data : new Float32Array(pcm.data.buffer || pcm.data);
                  const buf = ctx.createBuffer(1, d.length, pcm.sr);
                  buf.copyToChannel(d, 0);
                  let peak = 0;
                  for (let k = 0; k < d.length; k++) if (Math.abs(d[k]) > peak) peak = Math.abs(d[k]);
                  ok = buf.length > 0 && peak > 0.01;
                } catch (e2) { err = e2.message; }
              }
              out.push({ name: dataset.names[i], route, ok, err });
            }
            return out;
          })()`);
          for (const r of report) {
            console.log(`AUDIO ${r.ok ? 'OK  ' : 'FAIL'} ${String(r.name).padEnd(22)} via ${r.route} ${r.err}`);
          }
          console.log(`AUDIO SUMMARY ${report.filter((r) => r.ok).length}/${report.length} playable`);
        } catch (e) { console.error('audio check failed:', e); }
      }
      console.log('SMOKE OK');
      app.exit(0);
    }, Number(process.env.SMOKE_MS || 25000));
  }
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (e) => { console.error('uncaught:', e); if (SMOKE) app.exit(1); });
