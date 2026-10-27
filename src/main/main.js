import { app, BrowserWindow, Menu, ipcMain, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import '../renderer/list-controls.js';
import '../renderer/section-editor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const LIST_SELF_TEST = process.argv.includes('--list-self-test');
const SECTION_SELF_TEST = process.argv.includes('--section-self-test');
const SECTION_DEMO = process.argv.includes('--section-demo');
if (LIST_SELF_TEST) {
  app.setPath('userData', path.join(os.tmpdir(), 'atomica-list-self-test'));
} else if (SECTION_SELF_TEST || SECTION_DEMO) {
  app.setPath('userData', path.join(os.tmpdir(), 'atomica-section-self-test'));
}
const AUDIO_EXT = new Set(['.wav', '.wave', '.mp3', '.flac', '.ogg', '.oga']);
const SCALARS = ['brightness', 'pitch', 'loudness', 'duration', 'attack', 'noisiness', 'flux', 'rolloff'];
const PEAK_BINS = 128;
const CACHE_VERSION = 2;
const TITLEBAR_H = 32; // must match #titlebar height in style.css
const INSTRUMENTS = [
  { label: 'Kick', prompt: 'the sound of a kick drum' },
  { label: 'Snare', prompt: 'the sound of a snare drum' },
  { label: 'Clap', prompt: 'the sound of a clap or handclap' },
  { label: 'Hi-hat', prompt: 'the sound of a hi-hat cymbal' },
  { label: 'Cymbal', prompt: 'the sound of a crash or ride cymbal' },
  { label: 'Tom', prompt: 'the sound of a tom drum' },
  { label: 'Perc', prompt: 'the sound of percussion' },
  { label: 'Bass', prompt: 'the sound of a bass' },
  { label: 'Synth', prompt: 'the sound of a synthesizer' },
  { label: 'Pad', prompt: 'the sound of a synth pad' },
  { label: 'Lead', prompt: 'the sound of a synth lead' },
  { label: 'Vocal', prompt: 'the sound of a vocal sample' },
  { label: 'FX', prompt: 'the sound of a sound effect or riser' },
  { label: 'Guitar', prompt: 'the sound of a guitar' },
  { label: 'Keys', prompt: 'the sound of a piano or keyboard' },
  { label: 'Strings', prompt: 'the sound of strings' },
  { label: 'Brass', prompt: 'the sound of brass instruments' },
  { label: 'Atmosphere', prompt: 'the sound of an atmosphere or texture' },
];
const GENRES = [
  { label: 'Hip-hop', prompt: 'a hip hop music sample' },
  { label: 'Trap', prompt: 'a trap music sample' },
  { label: 'House', prompt: 'a house music sample' },
  { label: 'Techno', prompt: 'a techno music sample' },
  { label: 'Drum & Bass', prompt: 'a drum and bass sample' },
  { label: 'Jungle', prompt: 'a jungle music sample' },
  { label: 'Funk', prompt: 'a funk music sample' },
  { label: 'Soul', prompt: 'a soul music sample' },
  { label: 'Jazz', prompt: 'a jazz music sample' },
  { label: 'Rock', prompt: 'a rock music sample' },
  { label: 'Metal', prompt: 'a metal music sample' },
  { label: 'Ambient', prompt: 'an ambient music sample' },
  { label: 'Cinematic', prompt: 'a cinematic soundtrack sample' },
  { label: 'Latin', prompt: 'a latin music sample' },
  { label: 'Reggae', prompt: 'a reggae or dancehall sample' },
  { label: 'R&B', prompt: 'an rnb music sample' },
  { label: 'Pop', prompt: 'a pop music sample' },
  { label: 'Experimental', prompt: 'an experimental electronic sample' },
];
const ALL_TAG_PROMPTS = [...INSTRUMENTS, ...GENRES].map((c) => c.prompt);

const INSTRUMENT_HINTS = [
  { label: 'Kick', re: /\bkicks?\b|\bbd\b|bassdrum|bass drum/i },
  { label: 'Snare', re: /\bsnares?\b|\bsd\b/i },
  { label: 'Clap', re: /\bclaps?\b/i },
  { label: 'Hi-hat', re: /\bhi[\s-]*hats?\b|\bhats?\b|\bhh\b/i },
  { label: 'Cymbal', re: /\bcymbals?\b|\bcrash\b|\bride\b/i },
  { label: 'Tom', re: /\btoms?\b/i },
  { label: 'Perc', re: /\bperc(ussion)?\b|\bshaker\b|\bconga\b|\bbongo\b/i },
  { label: 'Bass', re: /\bbass(es)?\b|\bsub\b/i },
  { label: 'Synth', re: /\bsynths?\b/i },
  { label: 'Pad', re: /\bpads?\b/i },
  { label: 'Lead', re: /\bleads?\b/i },
  { label: 'Vocal', re: /\bvocals?\b|\bvox\b|\bvoice\b/i },
  { label: 'FX', re: /\bfx\b|\briser\b|\bimpact\b|\bsweep\b/i },
  { label: 'Guitar', re: /\bguitars?\b|\bgtr\b/i },
  { label: 'Keys', re: /\bkeys?\b|\bpiano\b|\brhodes\b/i },
  { label: 'Strings', re: /\bstrings?\b|\bviolin\b/i },
  { label: 'Brass', re: /\bbrass\b|\bhorn\b|\btrumpet\b/i },
];
const GENRE_HINTS = [
  { label: 'Hip-hop', re: /hip\s*hop|hiphop|boom\s*bap|old\s*school/i },
  { label: 'Trap', re: /\btrap\b/i },
  { label: 'House', re: /\bhouse\b/i },
  { label: 'Techno', re: /\btechno\b/i },
  { label: 'Drum & Bass', re: /drum\s*(and|&)\s*bass|\bdnb\b|\bd\&b\b/i },
  { label: 'Jungle', re: /\bjungle\b/i },
  { label: 'Funk', re: /\bfunk\b/i },
  { label: 'Soul', re: /\bsoul\b/i },
  { label: 'Jazz', re: /\bjazz\b/i },
  { label: 'Rock', re: /\brock\b/i },
  { label: 'Metal', re: /\bmetal\b/i },
  { label: 'Ambient', re: /\bambient\b/i },
  { label: 'Cinematic', re: /\bcinematic\b|\btrailer\b/i },
  { label: 'Latin', re: /\blatin\b|\bsalsa\b|\bsamba\b/i },
  { label: 'Reggae', re: /\breggae\b|\bdancehall\b/i },
  { label: 'R&B', re: /\brn[b']\b|\br\s*&\s*b\b/i },
];

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
  playlists: [],  // [{ id, name, paths: [] }]
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
    if (Array.isArray(s.playlists)) state.playlists = s.playlists;
  } catch { /* first run */ }
}

function ensureFavoritesPlaylist() {
  const has = state.playlists.some((p) => String(p.name || '').toLowerCase() === 'favorites');
  if (has) return false;
  state.playlists.unshift({ id: 'pl_favorites', name: 'favorites', paths: [] });
  return true;
}

async function saveSettings() {
  try {
    await fs.writeFile(settingsFile(), JSON.stringify({
      folders: state.folders, useEmbeddings: state.useEmbeddings, params: state.params,
      playlists: state.playlists,
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
      library.set(e.p, { p: e.p, mt: e.mt, sz: e.sz, f: e.f, mfcc: e.mfcc, emb, peaks, override: (e.override && typeof e.override === 'object') ? e.override : null });
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
        override: e.override || null,
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
    enqueueEmbedJob({ type: 'embed-text', texts: ALL_TAG_PROMPTS }, [], (msg) => {
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

function pathHints(filePath) {
  const blob = `${path.basename(path.dirname(filePath))} ${path.basename(filePath, path.extname(filePath))}`;
  const spaced = blob.replace(/[._-]+/g, ' ');
  let instrument = null, genre = null;
  for (const h of INSTRUMENT_HINTS) if (h.re.test(spaced)) { instrument = h.label; break; }
  for (const h of GENRE_HINTS) if (h.re.test(spaced)) { genre = h.label; break; }
  return { instrument, genre };
}

function argmaxSlice(emb, start, n) {
  const dim = Math.min(emb.length, textEmbedDim || emb.length);
  let best = -1, bestS = -Infinity, second = -Infinity;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = (start + i) * textEmbedDim;
    for (let d = 0; d < dim; d++) s += emb[d] * textEmbeds[off + d];
    if (s > bestS) { second = bestS; bestS = s; best = i; }
    else if (s > second) second = s;
  }
  return { idx: best, conf: bestS === -Infinity ? 0 : bestS, gap: bestS - second };
}

function classifyTags(e) {
  const hints = pathHints(e.p);
  let instrument = hints.instrument;
  let genre = hints.genre;
  if (e.emb && textEmbeds && textEmbedDim) {
    const inst = argmaxSlice(e.emb, 0, INSTRUMENTS.length);
    if (inst.idx >= 0 && inst.conf >= 0.11 && inst.gap >= 0.01) instrument = INSTRUMENTS[inst.idx].label;
    else if (!instrument && inst.idx >= 0 && inst.conf >= 0.08) instrument = INSTRUMENTS[inst.idx].label;
    const gen = argmaxSlice(e.emb, INSTRUMENTS.length, GENRES.length);
    if (gen.idx >= 0 && gen.conf >= 0.10 && gen.gap >= 0.008) genre = GENRES[gen.idx].label;
    else if (!genre && gen.idx >= 0 && gen.conf >= 0.08) genre = GENRES[gen.idx].label;
  }
  if (hints.genre) genre = hints.genre;
  return {
    instrument: instrument || (e.emb && textEmbeds ? 'Uncategorized' : '—'),
    genre: genre || '—',
  };
}

// Manual corrections (from list Edit mode) overlay the model's guess. Overlaid at
// dataset-build time so the auto value is still there if the user clears an override.
function applyOverride(e, tags) {
  const o = e.override;
  if (!o) return tags;
  if (o.instrument != null) tags.instrument = o.instrument;
  if (o.genre != null) tags.genre = o.genre;
  return tags;
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

    const needRhythm = [...library.values()].filter((e) => e.f && e.f.kind == null);
    if (needRhythm.length) await fillRhythm(needRhythm);

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

function fillRhythm(entries) {
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
      w.postMessage({ type: 'rhythm', path: e.p });
    };
    progress('rhythm', 0, total, `Detecting loops 0/${total}`, true);
    for (let i = 0; i < nWorkers; i++) {
      const w = new Worker(new URL('./analysis/analysis-worker.js', import.meta.url));
      w.idle = false;
      workers.push(w);
      w.on('message', (msg) => {
        if (msg.type !== 'rhythm-result') return;
        done++;
        if (!msg.error) {
          const e = library.get(msg.path);
          if (e && e.f) {
            e.f.kind = msg.kind || 'oneshot';
            e.f.bpm = msg.bpm ?? null;
          }
        }
        progress('rhythm', done, total, `Detecting loops ${done}/${total}`);
        dispatch(w);
      });
      w.on('error', (e) => {
        console.error('rhythm worker error:', e);
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
            override: (prev && prev.override) || null,
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
    genres: new Array(n),
    kinds: new Array(n),
    bpms: new Array(n),
    volumes: new Array(n),
    peaks,
    features: Object.fromEntries(SCALARS.map((k) => [k, new Array(n)])),
  };
  for (let i = 0; i < n; i++) {
    const e = library.get(datasetOrder[i]);
    ds.names[i] = path.basename(e.p);
    ds.folders[i] = path.basename(path.dirname(e.p));
    ds.hasEmb[i] = !!e.emb;
    if (e.peaks && e.peaks.length === PEAK_BINS) peaks.set(e.peaks, i * PEAK_BINS);
    const tags = applyOverride(e, classifyTags(e));
    ds.categories[i] = tags.instrument;
    ds.genres[i] = tags.genre;
    const kind = (e.override && e.override.kind) || (e.f && e.f.kind) || null;
    ds.kinds[i] = kind;
    ds.bpms[i] = kind === 'loop' ? (e.f && e.f.bpm != null ? e.f.bpm : null) : null;
    const vol = e.override && typeof e.override.volume === 'number' ? e.override.volume : 1;
    ds.volumes[i] = Math.min(1, Math.max(0, vol));
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
    playlists: state.playlists,
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

  // ---- playlists ----
  ipcMain.handle('playlists:get', () => state.playlists);

  ipcMain.handle('playlists:create', async (_e, name) => {
    const pl = { id: `pl_${Date.now()}`, name: name || 'Untitled', paths: [] };
    state.playlists.push(pl);
    await saveSettings();
    return state.playlists;
  });

  ipcMain.handle('playlists:rename', async (_e, id, name) => {
    const pl = state.playlists.find((p) => p.id === id);
    if (pl) { pl.name = name || 'Untitled'; await saveSettings(); }
    return state.playlists;
  });

  ipcMain.handle('playlists:delete', async (_e, id) => {
    state.playlists = state.playlists.filter((p) => p.id !== id);
    await saveSettings();
    return state.playlists;
  });

  ipcMain.handle('playlists:add', async (_e, id, paths) => {
    const pl = state.playlists.find((p) => p.id === id);
    if (pl) {
      const existing = new Set(pl.paths);
      for (const p of paths) if (!existing.has(p)) pl.paths.push(p);
      await saveSettings();
    }
    return state.playlists;
  });

  ipcMain.handle('playlists:remove', async (_e, id, pathOrPaths) => {
    const pl = state.playlists.find((p) => p.id === id);
    if (pl) {
      const drop = new Set(Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths]);
      pl.paths = pl.paths.filter((p) => !drop.has(p));
      await saveSettings();
    }
    return state.playlists;
  });

  ipcMain.handle('playlists:reorder', async (_e, id, from, to) => {
    const pl = state.playlists.find((p) => p.id === id);
    if (pl && from >= 0 && from < pl.paths.length && to >= 0 && to < pl.paths.length) {
      const [item] = pl.paths.splice(from, 1);
      pl.paths.splice(to, 0, item);
      await saveSettings();
    }
    return state.playlists;
  });

  ipcMain.handle('request-dataset', () => {
    const ds = buildDataset();
    if (hasAnyEmb() && !textEmbeds) {
      ensureTextEmbeds().then(() => sendDataset());
    }
    return ds;
  });

  // ---- manual tag corrections ----
  ipcMain.handle('tags:vocab', () => ({
    instruments: INSTRUMENTS.map((x) => x.label),
    genres: GENRES.map((x) => x.label),
    kinds: ['oneshot', 'loop'],
  }));

  ipcMain.handle('sample:setTags', async (_e, samplePath, patch) => {
    const paths = Array.isArray(samplePath) ? samplePath : [samplePath];
    const targets = paths.map((p) => library.get(p)).filter(Boolean);
    if (!targets.length) throw new Error('unknown sample');
    for (const entry of targets) applyTagPatch(entry, patch || {});
    await saveCache();
    sendDataset();
    return true;
  });

  ipcMain.handle('sample:saveSection', (_e, req) => saveSampleSection(req));
}

// Write the selected PCM back as 16-bit WAV. Copy keeps the source file; replace overwrites it.
async function saveSampleSection(req) {
  const sourcePath = req && req.path;
  const entry = sourcePath ? library.get(sourcePath) : null;
  if (!entry) throw new Error('unknown sample');
  if (scanning) throw new Error('library is scanning');
  const mode = req.mode === 'replace' ? 'replace' : 'copy';
  if (!Array.isArray(req.channels) || !req.channels.length) throw new Error('empty section');
  const frames = req.channels.reduce((m, ch) => Math.min(m, (ch && ch.length) || 0), Infinity);
  if (!frames) throw new Error('empty section');
  if (frames > 192000 * 60 * 10) throw new Error('section is too long to save');

  const dir = path.dirname(sourcePath);
  let names = [];
  try { names = await fs.readdir(dir); } catch { throw new Error('sample folder is not writable'); }
  const base = path.basename(sourcePath);
  const ext = path.extname(sourcePath).toLowerCase();
  let fileName;
  if (mode === 'replace' && (ext === '.wav' || ext === '.wave')) fileName = base;
  else if (mode === 'replace') fileName = SectionEditor.uniqueFileName(SectionEditor.wavFileName(base), names);
  else fileName = SectionEditor.uniqueFileName(req.fileName || SectionEditor.cutFileName(base, names), names);
  const dest = path.join(dir, fileName);
  if (path.resolve(path.dirname(dest)) !== path.resolve(dir)) throw new Error('refusing to write outside the sample folder');
  if (mode === 'copy' && path.resolve(dest) === path.resolve(sourcePath)) throw new Error('refusing to overwrite the original');

  const wav = SectionEditor.encodeWav(req.channels, req.sampleRate);
  await fs.writeFile(dest, wav);

  let analyzed;
  let warning = '';
  try {
    const { analyzeFile } = await import('./analysis/dsp.js');
    analyzed = await analyzeFile(dest, false);
  } catch (err) {
    const mono = SectionEditor.mixDown(req.channels);
    const sr = Math.round(Number(req.sampleRate)) || 44100;
    analyzed = {
      features: { ...(entry.f || {}), duration: mono.length / sr },
      mfcc: entry.mfcc ? entry.mfcc.slice() : new Array(13).fill(0),
      peaks: SectionEditor.peakEnvelope(mono),
    };
    warning = (err && err.message) || String(err);
  }

  const st = await fs.stat(dest);
  let playlistsChanged = false;
  if (mode === 'replace') {
    if (dest !== sourcePath) {
      library.delete(sourcePath);
      for (const pl of state.playlists) {
        let hit = false;
        pl.paths = pl.paths.map((p) => {
          if (p !== sourcePath) return p;
          hit = true;
          return dest;
        });
        if (hit) playlistsChanged = true;
      }
      try { await fs.unlink(sourcePath); }
      catch (err) { warning = warning || `Saved ${fileName}, but the old file is still on disk (${err.message})`; }
    }
    entry.p = dest;
    entry.mt = st.mtimeMs;
    entry.sz = st.size;
    entry.f = analyzed.features;
    entry.mfcc = analyzed.mfcc;
    entry.emb = null;
    entry.peaks = analyzed.peaks;
    library.set(dest, entry);
  } else {
    library.set(dest, {
      p: dest,
      mt: st.mtimeMs,
      sz: st.size,
      f: analyzed.features,
      mfcc: analyzed.mfcc,
      emb: null,
      peaks: analyzed.peaks,
      override: entry.override ? { ...entry.override } : null,
    });
  }

  await saveCache();
  if (playlistsChanged) await saveSettings();
  sendDataset();
  if (!SECTION_SELF_TEST && !LIST_SELF_TEST && state.params.mode === 'similarity') {
    try { computeLayout(state.params); } catch (err) { console.error('layout after section save:', err); }
  }
  return {
    path: dest,
    name: path.basename(dest),
    previousPath: sourcePath,
    mode,
    duration: analyzed.features && analyzed.features.duration,
    warning,
  };
}

function applyTagPatch(entry, patch) {
  const next = { ...(entry.override || {}) };
  if (patch.kind !== undefined) {
    if (patch.kind === null || patch.kind === '') delete next.kind;
    else next.kind = patch.kind === 'loop' ? 'loop' : 'oneshot';
  }
  if (patch.instrument !== undefined) {
    if (!patch.instrument || patch.instrument === '—') delete next.instrument;
    else next.instrument = String(patch.instrument);
  }
  if (patch.genre !== undefined) {
    if (!patch.genre || patch.genre === '—') delete next.genre;
    else next.genre = String(patch.genre);
  }
  if (patch.volume !== undefined) {
    const v = ListControls.volumeOverride(patch.volume);
    if (v == null) delete next.volume;
    else next.volume = v;
  }
  entry.override = Object.keys(next).length ? next : null;
}

// ------------------------------------------------------------ list self-test fixtures

function writeToneWav(filePath) {
  const sr = 44100;
  const n = sr;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.2;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return fs.writeFile(filePath, Buffer.concat([header, data]));
}

async function installFixtureLibrary(dir) {
  await fs.mkdir(dir, { recursive: true });
  const specs = [
    ['a_alpha.wav', 'oneshot', 100],
    ['b_beta.wav', 'oneshot', 110],
    ['c_gamma.wav', 'loop', 120],
    ['d_delta.wav', 'loop', 130],
  ];
  for (const [name, kind, bpm] of specs) {
    const filePath = path.join(dir, name);
    await writeToneWav(filePath);
    const peaks = new Uint8Array(PEAK_BINS);
    for (let i = 0; i < PEAK_BINS; i++) peaks[i] = Math.round(180 * Math.abs(Math.sin(i / 5)) + 20);
    library.set(filePath, {
      p: filePath,
      mt: 1,
      sz: 1000,
      f: {
        duration: 1, loudness: -12, brightness: 0.4, noisiness: 0.2,
        rolloff: 0.5, flux: 0.1, pitch: 60, attack: 0.02, kind, bpm,
      },
      mfcc: new Array(13).fill(0),
      emb: null,
      peaks,
      override: null,
    });
  }
  for (const pl of state.playlists) {
    if (String(pl.name || '').toLowerCase() === 'favorites') pl.paths = [];
  }
}

async function seedListSelfTest() {
  library.clear();
  await installFixtureLibrary(path.join(os.tmpdir(), 'atomica-list-fixtures'));
}

async function seedSectionSelfTest() {
  library.clear();
  const dir = path.join(os.tmpdir(), 'atomica-section-fixtures');
  await fs.rm(dir, { recursive: true, force: true });
  await installFixtureLibrary(dir);
}

async function runListSelfTest() {
  const shotDir = '/opt/cursor/artifacts';
  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      await fs.mkdir(shotDir, { recursive: true });
      await fs.writeFile(path.join(shotDir, name), img.toPNG());
    } catch (e) { console.error('capture failed:', e); }
  };
  try {
    const driver = await fs.readFile(path.join(__dirname, '../../test/list-ui-driver.js'), 'utf8');
    const result = await Promise.race([
      win.webContents.executeJavaScript(driver, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('list ui driver timed out')), 25000)),
    ]);
    console.log('LIST_UI', JSON.stringify(result));
    if (!result || !result.ok) throw new Error('list ui driver failed');
    await shot('list-controls.png');
    console.log('LIST_UI OK');
    app.exit(0);
  } catch (e) {
    console.error('LIST_UI FAIL', e);
    await shot('list-controls-fail.png');
    app.exit(1);
  }
}

async function runSectionSelfTest() {
  const shotDir = '/opt/cursor/artifacts';
  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      await fs.mkdir(shotDir, { recursive: true });
      await fs.writeFile(path.join(shotDir, name), img.toPNG());
    } catch (e) { console.error('capture failed:', e); }
  };
  try {
    const driver = await fs.readFile(path.join(__dirname, '../../test/section-ui-driver.js'), 'utf8');
    const result = await Promise.race([
      win.webContents.executeJavaScript(driver, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('section ui driver timed out')), 45000)),
    ]);
    console.log('SECTION_UI', JSON.stringify(result));
    if (!result || !result.ok) throw new Error('section ui driver failed');
    await shot('section-editor.png');
    console.log('SECTION_UI OK');
    app.exit(0);
  } catch (e) {
    console.error('SECTION_UI FAIL', e);
    await shot('section-editor-fail.png');
    app.exit(1);
  }
}

// ------------------------------------------------------------ app

async function createWindow() {
  // Frameless title bar so the File menu lives in the window chrome (VS Code style).
  // Windows/Linux keep native min/max/close via the overlay; macOS gets traffic lights.
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#000000',
    title: 'Atomica',
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),
    titleBarStyle: 'hidden',
    ...(mac
      ? { trafficLightPosition: { x: 12, y: (TITLEBAR_H - 14) / 2 } }
      : { titleBarOverlay: { color: '#0d0a07', symbolColor: '#e6b45e', height: TITLEBAR_H } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  if (SMOKE || LIST_SELF_TEST || SECTION_SELF_TEST) {
    win.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
  }
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await loadSettings();
  if (ensureFavoritesPlaylist()) await saveSettings();
  await loadCache();
  if (LIST_SELF_TEST) await seedListSelfTest();
  if (SECTION_SELF_TEST || SECTION_DEMO) await seedSectionSelfTest();
  registerIpc();
  await createWindow();
  if (library.size) {
    // push cached data to renderer once it asks (request-dataset) — nothing to do here
  }
  if (state.folders.length && !LIST_SELF_TEST && !SECTION_SELF_TEST && !SECTION_DEMO) rescan();
  if (LIST_SELF_TEST) {
    setTimeout(() => { runListSelfTest(); }, 700);
  } else if (SECTION_SELF_TEST) {
    setTimeout(() => { runSectionSelfTest(); }, 700);
  } else if (SMOKE) {
    setTimeout(async () => {
      try {
        const pl = await win.webContents.executeJavaScript(`(async () => {
          document.getElementById('sideTabPl').click();
          const names = [...document.querySelectorAll('#playlistList .pl-name')].map((n) => n.textContent);
          document.getElementById('newPlaylist').click();
          const dialogOpen = !document.getElementById('nameDialog').hidden;
          document.getElementById('nameDialogInput').value = '__smoke_tmp__';
          document.getElementById('nameDialogOk').click();
          await new Promise((r) => setTimeout(r, 400));
          const afterCreate = [...document.querySelectorAll('#playlistList .pl-name')].map((n) => n.textContent);
          const tmp = [...document.querySelectorAll('#playlistList .pl-item')]
            .find((li) => li.querySelector('.pl-name')?.textContent === '__smoke_tmp__');
          tmp?.querySelector('.pl-x')?.click();
          await new Promise((r) => setTimeout(r, 400));
          const afterDelete = [...document.querySelectorAll('#playlistList .pl-name')].map((n) => n.textContent);
          return { names, dialogOpen, afterCreate, afterDelete };
        })()`);
        console.log('PLAYLISTS', JSON.stringify(pl));
        if (!pl.names.some((n) => String(n).toLowerCase() === 'favorites')) {
          throw new Error('favorites playlist missing');
        }
        if (!pl.dialogOpen) throw new Error('name dialog did not open');
        if (!pl.afterCreate.includes('__smoke_tmp__')) throw new Error('create did not add playlist');
        if (pl.afterDelete.includes('__smoke_tmp__')) throw new Error('delete did not remove playlist');
      } catch (e) {
        console.error('playlist check failed:', e);
        app.exit(1);
        return;
      }
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
