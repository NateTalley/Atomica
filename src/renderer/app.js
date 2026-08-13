'use strict';

const $ = (id) => document.getElementById(id);
const api = window.atomica;

const FEATURES = [
  ['brightness', 'Brightness'],
  ['pitch', 'Pitch'],
  ['loudness', 'Loudness'],
  ['duration', 'Duration'],
  ['attack', 'Attack'],
  ['noisiness', 'Noisiness'],
  ['flux', 'Movement'],
  ['rolloff', 'Rolloff'],
];
const WEIGHT_KEYS = [
  ['embedding', 'AI timbre (CLAP)'],
  ['mfcc', 'Timbre (MFCC)'],
  ['brightness', 'Brightness'],
  ['pitch', 'Pitch'],
  ['loudness', 'Loudness'],
  ['duration', 'Duration'],
  ['attack', 'Attack'],
  ['noisiness', 'Noisiness'],
];

let dataset = null;          // {n, paths, names, folders, hasEmb, features, peaks, categories}
let params = null;
let starmap = null;
let simPositions = null;     // last similarity layout from main
let filterText = '';
let playingIdx = -1;
let listSort = { key: 'name', dir: 1 };
let listFiltered = [];
const PEAK_BINS = 128;
const LIST_ROW_H = 36;
const LIST_WAVE_W = 160;
const LIST_WAVE_H = 28;

// ------------------------------------------------------------ init

async function init() {
  starmap = new Starmap($('map'), {
    onHover: handleHover,
    onClick: handleClick,
    onDragStart: (i) => api.startDrag(dataset.paths[i]),
    onRightClick: (i) => api.reveal(dataset.paths[i]),
  });

  const st = await api.getState();
  params = st.params;
  $('useEmb').checked = st.useEmbeddings;
  renderFolders(st.folders);
  buildControls();
  syncControls();
  setView(params.view || 'map', true);

  api.onDataset((ds) => { applyDataset(ds, false); });
  api.onPositions(({ positions }) => {
    simPositions = new Float32Array(positions.buffer || positions);
    if (params.mode === 'similarity') starmap.setPositions(simPositions, true);
  });
  api.onProgress(showProgress);
  api.onNotice(showNotice);

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopAudio(); });

  if (st.sampleCount) {
    const ds = await api.requestDataset();
    applyDataset(ds, true);
  } else {
    $('empty').hidden = false;
  }
}

function applyDataset(ds, computeIfNeeded) {
  dataset = ds;
  if (dataset && dataset.peaks && !(dataset.peaks instanceof Uint8Array)) {
    dataset.peaks = new Uint8Array(dataset.peaks);
  }
  rebuildFolderColors();
  $('empty').hidden = ds.n > 0;
  starmap.setData(ds.n);
  restyle();
  updateStatus();
  refreshList(true);
  if (!ds.n) return;
  if (params.mode === 'axes') {
    starmap.setPositions(axesPositions(), false);
    starmap.fit();
  } else if (simPositions && simPositions.length === ds.n * 2) {
    starmap.setPositions(simPositions, false);
    starmap.fit();
  } else if (computeIfNeeded) {
    api.computeLayout(params); // cached library, no layout yet
  }
}

// ------------------------------------------------------------ controls

function buildControls() {
  const wDiv = $('weights');
  for (const [key, label] of WEIGHT_KEYS) {
    const row = document.createElement('div');
    row.className = 'wrow';
    row.innerHTML = `${label} <span class="val" id="wv_${key}"></span>
      <input type="range" id="w_${key}" min="0" max="2" step="0.05">`;
    wDiv.appendChild(row);
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      params.weights[key] = parseFloat(input.value);
      $(`wv_${key}`).textContent = input.value;
      persistParams();
    });
  }

  for (const sel of [$('axisX'), $('axisY')]) {
    for (const [key, label] of FEATURES) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = label;
      sel.appendChild(o);
    }
  }
  const cb = $('colorBy');
  cb.innerHTML = '<option value="folder">Folder</option>';
  for (const [key, label] of FEATURES) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = label;
    cb.appendChild(o);
  }

  $('tabSim').addEventListener('click', () => setMode('similarity'));
  $('tabAxes').addEventListener('click', () => setMode('axes'));
  $('method').addEventListener('change', () => { params.method = $('method').value; persistParams(); });
  $('nNeighbors').addEventListener('input', () => {
    params.nNeighbors = parseInt($('nNeighbors').value, 10);
    $('nNeighborsVal').textContent = params.nNeighbors;
    persistParams();
  });
  $('minDist').addEventListener('input', () => {
    params.minDist = parseFloat($('minDist').value);
    $('minDistVal').textContent = params.minDist.toFixed(2);
    persistParams();
  });
  $('applyMap').addEventListener('click', () => { if (dataset && dataset.n) api.computeLayout(params); });

  $('axisX').addEventListener('change', () => { params.axes.x = $('axisX').value; persistParams(); axesRefresh(); });
  $('axisY').addEventListener('change', () => { params.axes.y = $('axisY').value; persistParams(); axesRefresh(); });
  $('colorBy').addEventListener('change', () => { params.colorBy = $('colorBy').value; persistParams(); restyle(); });
  $('sizeBy').addEventListener('change', () => { params.sizeBy = $('sizeBy').value; persistParams(); restyle(); });
  $('volume').addEventListener('input', () => {
    params.volume = parseInt($('volume').value, 10) / 100;
    $('volumeVal').textContent = `${$('volume').value}%`;
    if (masterGain && audioCtx) masterGain.gain.setValueAtTime(params.volume, audioCtx.currentTime);
    persistParams();
  });
  $('search').addEventListener('input', () => { filterText = $('search').value.toLowerCase(); restyle(); refreshList(true); });

  $('addFolder').addEventListener('click', async () => renderFolders(await api.pickFolder()));
  $('rescanBtn').addEventListener('click', () => api.rescan());
  $('useEmb').addEventListener('change', () => api.setEmbeddings($('useEmb').checked));

  $('viewMap').addEventListener('click', () => setView('map'));
  $('viewList').addEventListener('click', () => setView('list'));
  $('listHead').addEventListener('click', (e) => {
    const key = e.target.dataset && e.target.dataset.sort;
    if (!key || key === 'waveform') return;
    if (listSort.key === key) listSort.dir *= -1;
    else { listSort.key = key; listSort.dir = 1; }
    for (const el of $('listHead').querySelectorAll('span')) {
      el.classList.toggle('sort-active', el.dataset.sort === listSort.key);
    }
    refreshList(true);
  });
  $('listScroll').addEventListener('scroll', () => renderListWindow());
  window.addEventListener('resize', () => { if (params && params.view === 'list') renderListWindow(); });
  bindListPointer();
}

function syncControls() {
  $('method').value = params.method;
  $('nNeighbors').value = params.nNeighbors;
  $('nNeighborsVal').textContent = params.nNeighbors;
  $('minDist').value = params.minDist;
  $('minDistVal').textContent = Number(params.minDist).toFixed(2);
  for (const [key] of WEIGHT_KEYS) {
    $(`w_${key}`).value = params.weights[key] ?? 0.3;
    $(`wv_${key}`).textContent = (params.weights[key] ?? 0.3).toFixed(2);
  }
  $('axisX').value = params.axes.x;
  $('axisY').value = params.axes.y;
  $('colorBy').value = params.colorBy;
  $('sizeBy').value = params.sizeBy;
  const vol = params.volume == null ? 0.9 : params.volume;
  $('volume').value = Math.round(vol * 100);
  $('volumeVal').textContent = `${Math.round(vol * 100)}%`;
  setMode(params.mode, true);
}

function setView(view, initial = false) {
  params.view = view === 'list' ? 'list' : 'map';
  $('viewMap').classList.toggle('active', params.view === 'map');
  $('viewList').classList.toggle('active', params.view === 'list');
  $('map').hidden = params.view !== 'map';
  $('listWrap').hidden = params.view !== 'list';
  updateStatusHints();
  if (!initial) persistParams();
  if (params.view === 'map') {
    starmap.dirty = true;
    starmap.fit();
  } else {
    refreshList(true);
  }
}

function updateStatusHints() {
  $('statusRight').innerHTML = params.view === 'list'
    ? 'click&nbsp;=&nbsp;play / stop&nbsp;&nbsp;·&nbsp;&nbsp;drag row&nbsp;=&nbsp;drop into DAW&nbsp;&nbsp;·&nbsp;&nbsp;right-click&nbsp;=&nbsp;show in Explorer'
    : 'click&nbsp;=&nbsp;play / stop&nbsp;&nbsp;·&nbsp;&nbsp;drag star&nbsp;=&nbsp;drop into DAW&nbsp;&nbsp;·&nbsp;&nbsp;right-click&nbsp;=&nbsp;show in Explorer&nbsp;&nbsp;·&nbsp;&nbsp;wheel&nbsp;=&nbsp;zoom';
}

function setMode(mode, initial = false) {
  params.mode = mode;
  $('tabSim').classList.toggle('active', mode === 'similarity');
  $('tabAxes').classList.toggle('active', mode === 'axes');
  $('simPanel').hidden = mode !== 'similarity';
  $('axesPanel').hidden = mode !== 'axes';
  if (!initial) persistParams();
  if (!dataset || !dataset.n) return;
  if (mode === 'axes') {
    starmap.setPositions(axesPositions(), !initial);
  } else if (simPositions && simPositions.length === dataset.n * 2) {
    starmap.setPositions(simPositions, !initial);
  } else {
    api.computeLayout(params);
  }
}

let persistTimer = null;
function persistParams() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => api.setParams(params), 400);
}

function renderFolders(folders) {
  const ul = $('folderList');
  ul.innerHTML = '';
  folders.forEach((f, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f;
    name.title = f;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Remove folder';
    x.addEventListener('click', async () => renderFolders(await api.removeFolder(i)));
    li.append(name, x);
    ul.appendChild(li);
  });
}

// ------------------------------------------------------------ axes mode layout

function robustRange(values) {
  const vals = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return [0, 1];
  const lo = vals[Math.floor(vals.length * 0.02)];
  const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))];
  return hi > lo ? [lo, hi] : [lo - 0.5, lo + 0.5];
}

function axisValues(key) {
  const raw = dataset.features[key];
  if (key === 'duration') return raw.map((v) => (v == null ? null : Math.log1p(v)));
  return raw;
}

function axesPositions() {
  const xs = axisValues(params.axes.x);
  const ys = axisValues(params.axes.y);
  const [x0, x1] = robustRange(xs);
  const [y0, y1] = robustRange(ys);
  const n = dataset.n;
  const pos = new Float32Array(n * 2);
  // deterministic small jitter so identical values don't stack into one dot
  const jitter = (i) => (Math.sin(i * 127.1 + 311.7) % 1) * 0.012;
  for (let i = 0; i < n; i++) {
    const xv = xs[i], yv = ys[i];
    pos[i * 2] = xv == null ? -1.06 : Math.max(-1, Math.min(1, ((xv - x0) / (x1 - x0)) * 1.84 - 0.92)) + jitter(i);
    pos[i * 2 + 1] = yv == null ? -1.06 : Math.max(-1, Math.min(1, ((yv - y0) / (y1 - y0)) * 1.84 - 0.92)) + jitter(i + 7919);
  }
  return pos;
}

function axesRefresh() {
  if (params.mode === 'axes' && dataset && dataset.n) starmap.setPositions(axesPositions(), true);
}

// ------------------------------------------------------------ styling

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// Hashing folder names to hues collides badly at small folder counts, so hues are
// dealt out by golden angle over the sorted folder list — maximally far apart.
let folderColors = new Map();
function rebuildFolderColors() {
  folderColors = new Map();
  const names = [...new Set(dataset.folders)].sort();
  names.forEach((name, i) => {
    const hue = (i * 0.618033988749895) % 1;
    folderColors.set(name, hslToRgb(hue, 0.62, i % 2 ? 0.7 : 0.58));
  });
}

// brand gradient: low = deep orange, high = pale yellow
function stellarColor(t) {
  const lo = [1.0, 0.35, 0.12], mid = [1.0, 0.76, 0.18], hi = [1.0, 0.95, 0.72];
  const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
  return t < 0.5 ? mix(lo, mid, t * 2) : mix(mid, hi, (t - 0.5) * 2);
}

function percentileRanks(values) {
  const idx = values.map((v, i) => [v == null || !Number.isFinite(v) ? -Infinity : v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Float32Array(values.length);
  for (let r = 0; r < idx.length; r++) ranks[idx[r][1]] = idx.length > 1 ? r / (idx.length - 1) : 0.5;
  return ranks;
}

function restyle() {
  if (!dataset || !dataset.n) return;
  const n = dataset.n;
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const alphas = new Float32Array(n);

  let colorRanks = null;
  if (params.colorBy !== 'folder') colorRanks = percentileRanks(dataset.features[params.colorBy]);
  let sizeRanks = null;
  if (params.sizeBy !== 'uniform') sizeRanks = percentileRanks(dataset.features[params.sizeBy]);

  for (let i = 0; i < n; i++) {
    const c = params.colorBy === 'folder' ? folderColors.get(dataset.folders[i]) : stellarColor(colorRanks[i]);
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
    sizes[i] = sizeRanks ? 5.5 + 10 * Math.pow(sizeRanks[i], 1.4) : 8;
    let visible = sampleVisible(i);
    alphas[i] = visible ? 1.0 : 0.05;
  }
  starmap.setStyle(colors, sizes, alphas);
  updateStatus();
}

function sampleVisible(i) {
  if (!filterText || !dataset) return true;
  if (dataset.names[i].toLowerCase().includes(filterText)) return true;
  if (dataset.folders[i].toLowerCase().includes(filterText)) return true;
  const cat = dataset.categories && dataset.categories[i];
  return !!(cat && cat.toLowerCase().includes(filterText));
}

// ------------------------------------------------------------ list view

function refreshList(rebuildOrder) {
  if (!dataset) {
    listFiltered = [];
    renderListWindow();
    return;
  }
  if (rebuildOrder) {
    const idxs = [];
    for (let i = 0; i < dataset.n; i++) if (sampleVisible(i)) idxs.push(i);
    const dir = listSort.dir;
    const key = listSort.key;
    idxs.sort((a, b) => {
      let cmp = 0;
      if (key === 'duration') {
        const da = dataset.features.duration[a], db = dataset.features.duration[b];
        cmp = (da ?? -1) - (db ?? -1);
      } else if (key === 'category') {
        cmp = String(dataset.categories[a] || '').localeCompare(String(dataset.categories[b] || ''), undefined, { sensitivity: 'base' });
      } else {
        cmp = dataset.names[a].localeCompare(dataset.names[b], undefined, { numeric: true, sensitivity: 'base' });
      }
      return cmp * dir || a - b;
    });
    listFiltered = idxs;
    $('listSpacer').style.height = `${listFiltered.length * LIST_ROW_H}px`;
  }
  renderListWindow();
}

function renderListWindow() {
  const rowsEl = $('listRows');
  const scroll = $('listScroll');
  if (!rowsEl || !scroll || $('listWrap').hidden) return;
  const n = listFiltered.length;
  const viewH = scroll.clientHeight || 400;
  const start = Math.max(0, Math.floor(scroll.scrollTop / LIST_ROW_H) - 8);
  const end = Math.min(n, Math.ceil((scroll.scrollTop + viewH) / LIST_ROW_H) + 8);
  rowsEl.style.transform = `translateY(${start * LIST_ROW_H}px)`;

  const needed = end - start;
  while (rowsEl.childElementCount < needed) {
    rowsEl.appendChild(makeListRow());
  }
  while (rowsEl.childElementCount > needed) {
    rowsEl.removeChild(rowsEl.lastChild);
  }

  for (let r = 0; r < needed; r++) {
    const idx = listFiltered[start + r];
    paintListRow(rowsEl.children[r], idx);
  }
}

function makeListRow() {
  const row = document.createElement('div');
  row.className = 'list-row';
  const canvas = document.createElement('canvas');
  canvas.width = LIST_WAVE_W * 2;
  canvas.height = LIST_WAVE_H * 2;
  canvas.draggable = false;
  const dur = document.createElement('div');
  dur.className = 'list-dur';
  const name = document.createElement('div');
  name.className = 'list-name';
  const cat = document.createElement('div');
  cat.className = 'list-cat';
  row.append(canvas, dur, name, cat);
  return row;
}

function paintListRow(row, idx) {
  row.dataset.idx = String(idx);
  row.classList.toggle('playing', idx === playingIdx);
  drawWaveform(row.querySelector('canvas'), idx);
  const dur = dataset.features.duration[idx];
  row.querySelector('.list-dur').textContent = dur != null ? formatDur(dur) : '—';
  const name = row.querySelector('.list-name');
  name.textContent = dataset.names[idx];
  name.title = dataset.paths[idx];
  const cat = dataset.categories ? dataset.categories[idx] : '—';
  const badge = row.querySelector('.list-cat');
  badge.textContent = cat;
  badge.classList.toggle('dim', cat === '—' || cat === 'Uncategorized' || cat === '…');
}

function formatDur(sec) {
  if (sec < 10) return `${sec.toFixed(2)} s`;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function drawWaveform(canvas, idx) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(26, 20, 14, 0.9)';
  ctx.fillRect(0, 0, w, h);
  const mid = h / 2;
  const peaks = dataset.peaks;
  ctx.fillStyle = '#ffc107';
  if (!peaks) {
    ctx.fillRect(0, mid - 1, w, 2);
    return;
  }
  const off = idx * PEAK_BINS;
  const barW = w / PEAK_BINS;
  for (let i = 0; i < PEAK_BINS; i++) {
    const amp = (peaks[off + i] || 0) / 255;
    const bh = Math.max(1, amp * (h * 0.86));
    ctx.globalAlpha = 0.45 + amp * 0.55;
    ctx.fillRect(i * barW, mid - bh / 2, Math.max(1, barW - 0.5), bh);
  }
  ctx.globalAlpha = 1;
}

function bindListPointer() {
  const rowsEl = $('listRows');
  let downPos = null;
  let downIdx = -1;
  let dragStarted = false;

  rowsEl.addEventListener('mousedown', (e) => {
    if (e.button === 2) return;
    const row = e.target.closest('.list-row');
    if (!row) return;
    downIdx = parseInt(row.dataset.idx, 10);
    downPos = { x: e.clientX, y: e.clientY };
    dragStarted = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (downIdx < 0 || !downPos || dragStarted) return;
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) {
      dragStarted = true;
      api.startDrag(dataset.paths[downIdx]);
    }
  });

  window.addEventListener('mouseup', () => {
    if (downIdx >= 0 && !dragStarted) handleClick(downIdx);
    downPos = null;
    downIdx = -1;
    dragStarted = false;
  });

  rowsEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('.list-row');
    if (!row || !dataset) return;
    api.reveal(dataset.paths[parseInt(row.dataset.idx, 10)]);
  });
}

// ------------------------------------------------------------ interaction

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(midi) {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

function handleHover(idx, mx, my) {
  const tip = $('tooltip');
  if (idx < 0 || !dataset) { tip.hidden = true; return; }
  const f = dataset.features;
  const parts = [`${f.duration[idx] != null ? f.duration[idx].toFixed(2) : '?'} s`];
  if (f.pitch[idx] != null) parts.push(noteName(f.pitch[idx]));
  if (f.brightness[idx] != null) parts.push(`${Math.round(Math.pow(2, f.brightness[idx]))} Hz`);
  if (f.loudness[idx] != null) parts.push(`${f.loudness[idx].toFixed(1)} dB`);
  tip.innerHTML = `<div class="t-name"></div><div class="t-meta"></div>`;
  tip.querySelector('.t-name').textContent = dataset.names[idx];
  tip.querySelector('.t-meta').textContent = `${dataset.folders[idx]}  ·  ${parts.join('  ·  ')}`;
  tip.hidden = false;
  const wrap = $('mapWrap');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = mx + 16, y = my + 14;
  if (x + tw > wrap.clientWidth - 8) x = mx - tw - 12;
  if (y + th > wrap.clientHeight - 8) y = my - th - 12;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  $('statusLeft').textContent = dataset.paths[idx];
}

// ------------------------------------------------------------ audio

let audioCtx = null;
let currentSource = null;
let masterGain = null;
let playGen = 0;
let playPending = false;

function clearPlayingHighlight() {
  playingIdx = -1;
  if (starmap) starmap.setPlaying(-1);
  if (params && params.view === 'list') renderListWindow();
}

function stopSource() {
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }
  masterGain = null;
}

function stopAudio() {
  playGen++;
  playPending = false;
  stopSource();
  clearPlayingHighlight();
}

async function handleClick(idx) {
  if (!dataset) return;
  if (playingIdx === idx && (currentSource || playPending)) {
    stopAudio();
    return;
  }
  playGen++;
  const gen = playGen;
  stopSource();
  playingIdx = idx;
  playPending = true;
  starmap.setPlaying(idx);
  if (params.view === 'list') renderListWindow();
  try {
    const bytes = await api.readAudio(dataset.paths[idx]);
    if (!audioCtx) audioCtx = new AudioContext();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let buf;
    try {
      buf = await audioCtx.decodeAudioData(ab);
    } catch {
      // Chromium rejects ADPCM, A-law/mu-law and MP3-in-WAV; the main process
      // decodes those itself (mono) so they can still be auditioned
      const pcm = await api.decodeAudio(dataset.paths[idx]);
      const data = pcm.data instanceof Float32Array ? pcm.data : new Float32Array(pcm.data.buffer || pcm.data);
      buf = audioCtx.createBuffer(1, data.length, pcm.sr);
      buf.copyToChannel(data, 0);
    }
    if (gen !== playGen) return;
    stopSource();
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const gain = audioCtx.createGain();
    gain.gain.value = params.volume == null ? 0.9 : params.volume;
    src.connect(gain).connect(audioCtx.destination);
    src.onended = () => {
      if (gen !== playGen) return;
      currentSource = null;
      masterGain = null;
      playPending = false;
      clearPlayingHighlight();
    };
    src.start();
    currentSource = src;
    masterGain = gain;
    playPending = false;
  } catch (e) {
    if (gen !== playGen) return;
    playPending = false;
    clearPlayingHighlight();
    showNotice({ kind: 'warn', msg: `Can't play ${dataset.names[idx]}: ${e.message}` });
  }
}

// ------------------------------------------------------------ status / progress

function updateStatus() {
  if (!dataset || !dataset.n) {
    $('statusLeft').textContent = 'No samples yet';
    return;
  }
  const withEmb = dataset.hasEmb.filter(Boolean).length;
  let txt = `${dataset.n.toLocaleString()} samples`;
  if (withEmb) txt += `  ·  ${withEmb.toLocaleString()} with AI embedding`;
  if (filterText) {
    let vis = 0;
    for (let i = 0; i < dataset.n; i++) if (sampleVisible(i)) vis++;
    txt += `  ·  ${vis.toLocaleString()} match filter`;
  }
  $('statusLeft').textContent = txt;
}

function showProgress({ phase, done, total, msg }) {
  const wrap = $('progressWrap');
  if (phase === 'idle') {
    wrap.hidden = true;
    updateStatus();
    return;
  }
  wrap.hidden = false;
  $('progressBar').style.width = total ? `${Math.round((done / total) * 100)}%` : '15%';
  $('progressText').textContent = msg || phase;
}

let noticeTimer = null;
function showNotice({ msg }) {
  const el = $('notice');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 9000);
}

init();
