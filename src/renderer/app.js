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

let dataset = null;          // {n, paths, names, folders, hasEmb, features, peaks, categories, genres, kinds, bpms}
let params = null;
let starmap = null;
let simPositions = null;     // last similarity layout from main
let filterText = '';
let filterKind = new Set();
let filterInstr = new Set();
let filterGenre = new Set();
let playingIdx = -1;
let listSort = { key: 'name', dir: 1 };
let listFiltered = [];
let playlists = [];
let activePlaylistId = null;   // when set, list/map shows only this playlist's samples
let playlistPlayQueue = null;  // array of sample indices for sequential playlist playback
let playlistPlayPos = -1;
let playlistPathSets = new Map(); // pl.id -> Set of paths, rebuilt when dataset or playlists change
let editingIdx = -1;           // dataset index whose row has its tag editor open (-1 = none)
let tagVocab = { instruments: [], genres: [], kinds: ['oneshot', 'loop'] };
let osDragPath = null;         // sample path of the current OS drag-out (drop into DAW or onto a playlist)
const PEAK_BINS = 128;
const LIST_ROW_H = 36;
const LIST_WAVE_W = 124;
const LIST_WAVE_H = 28;

// ------------------------------------------------------------ init

async function init() {
  starmap = new Starmap($('map'), {
    onHover: handleHover,
    onClick: handleClick,
    onDragStart: (i) => {
      osDragPath = dataset.paths[i];
      api.startDrag(osDragPath);
    },
    onRightClick: (i, x, y) => showContextMenu(i, x, y),
  });

  const st = await api.getState();
  params = st.params;
  playlists = st.playlists || [];
  try { tagVocab = await api.tagsVocab(); } catch { /* keep defaults */ }
  $('useEmb').checked = st.useEmbeddings;
  renderFolders(st.folders);
  renderPlaylists();
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

  // Escape closes an open row editor first; only stops playback when none is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('nameDialog').hidden) return;
    if (editingIdx >= 0) closeRowEditor();
    else stopAudio();
  });

  if (st.sampleCount) {
    const ds = await api.requestDataset();
    applyDataset(ds, true);
  } else {
    $('empty').hidden = false;
    renderTagFilters();
  }
}

function applyDataset(ds, computeIfNeeded) {
  dataset = ds;
  if (dataset && dataset.peaks && !(dataset.peaks instanceof Uint8Array)) {
    dataset.peaks = new Uint8Array(dataset.peaks);
  }
  rebuildFolderColors();
  rebuildTagColors();
  rebuildPlaylistPathSets();
  renderTagFilters();
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
  cb.innerHTML = '<option value="folder">Folder</option><option value="kind">One-shot / Loop</option><option value="instrument">Instrument</option><option value="genre">Genre</option>';
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
  $('clearFilters').addEventListener('click', () => {
    filterKind.clear();
    filterInstr.clear();
    filterGenre.clear();
    renderTagFilters();
    restyle();
    refreshList(true);
  });
  bindTagFilters();

  $('addFolder').addEventListener('click', async () => renderFolders(await api.pickFolder()));
  $('rescanBtn').addEventListener('click', () => api.rescan());
  $('useEmb').addEventListener('change', () => api.setEmbeddings($('useEmb').checked));
  bindFileMenu();
  bindSideTabs();

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
  bindPlaylistControls();
  bindContextMenu();
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
  if (params.view !== 'list') closeRowEditor(false);
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

function bindFileMenu() {
  const btn = $('fileMenuBtn');
  const menu = $('fileMenu');
  const wrap = $('fileMenuWrap');
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) setOpen(false);
  });
}

function bindSideTabs() {
  const tabs = [
    ['sideTabMap', 'panelMap'],
    ['sideTabType', 'panelType'],
    ['sideTabPl', 'panelPl'],
  ];
  for (const [tab] of tabs) {
    $(tab).addEventListener('click', () => {
      for (const [t, panel] of tabs) {
        $(t).classList.toggle('active', t === tab);
        $(panel).hidden = t !== tab;
      }
    });
  }
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

function hash01(i, seed) {
  const x = Math.sin(i * 127.1 + seed) * 43758.5453;
  return x - Math.floor(x);
}

// Linear in the robust range; tails ease out instead of stacking on a wall.
function softAxis(u) {
  const a = Math.abs(u);
  if (a <= 0.86) return u;
  const t = (a - 0.86) / 0.55;
  return Math.sign(u) * (0.86 + 0.28 * (1 - Math.exp(-2.4 * t)));
}

function axesPositions() {
  const xs = axisValues(params.axes.x);
  const ys = axisValues(params.axes.y);
  const [x0, x1] = robustRange(xs);
  const [y0, y1] = robustRange(ys);
  const n = dataset.n;
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const xv = xs[i], yv = ys[i];
    let x = xv == null ? -1.08 : ((xv - x0) / (x1 - x0) - 0.5) * 1.72;
    let y = yv == null ? -1.08 : ((yv - y0) / (y1 - y0) - 0.5) * 1.72;
    x = softAxis(x);
    y = softAxis(y);

    const edgeX = Math.max(0, Math.abs(x) - 0.5) / 0.6;
    const edgeY = Math.max(0, Math.abs(y) - 0.5) / 0.6;
    const jAmt = (e) => 0.014 + 0.22 * e * e;
    x += (hash01(i, 311.7) - 0.5) * jAmt(edgeX);
    y += (hash01(i, 7919.3) - 0.5) * jAmt(edgeY);
    // scatter along the wall so a row of maxed-out samples isn't a straight line
    x += (hash01(i, 1543.2) - 0.5) * 0.16 * edgeY * edgeY;
    y += (hash01(i, 9182.6) - 0.5) * 0.16 * edgeX * edgeX;

    const ax = Math.abs(x), ay = Math.abs(y);
    const m = Math.max(ax, ay, 1e-6);
    const rim = Math.max(0, (m - 0.42) / 0.75);
    const corner = (ax * ay) / (m * m);
    const s = 1 - 0.2 * rim * rim * corner;
    pos[i * 2] = x * s;
    pos[i * 2 + 1] = y * s;
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
let instrumentColors = new Map();
let genreColors = new Map();
function hueMap(names) {
  const map = new Map();
  const uniq = [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  uniq.forEach((name, i) => {
    const hue = (i * 0.618033988749895) % 1;
    map.set(name, hslToRgb(hue, 0.62, i % 2 ? 0.7 : 0.58));
  });
  return map;
}
function rebuildFolderColors() {
  folderColors = dataset ? hueMap(dataset.folders) : new Map();
}
function rebuildTagColors() {
  instrumentColors = dataset && dataset.categories ? hueMap(dataset.categories) : new Map();
  genreColors = dataset && dataset.genres ? hueMap(dataset.genres) : new Map();
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

  const discrete = params.colorBy === 'folder' || params.colorBy === 'kind' || params.colorBy === 'instrument' || params.colorBy === 'genre';
  let colorRanks = null;
  if (!discrete) colorRanks = percentileRanks(dataset.features[params.colorBy]);
  let sizeRanks = null;
  if (params.sizeBy !== 'uniform') sizeRanks = percentileRanks(dataset.features[params.sizeBy]);

  for (let i = 0; i < n; i++) {
    let c;
    if (params.colorBy === 'folder') c = folderColors.get(dataset.folders[i]);
    else if (params.colorBy === 'kind') c = dataset.kinds && dataset.kinds[i] === 'loop' ? [1.0, 0.38, 0.12] : [1.0, 0.82, 0.22];
    else if (params.colorBy === 'instrument') c = instrumentColors.get(dataset.categories[i]) || [1.0, 0.76, 0.18];
    else if (params.colorBy === 'genre') c = genreColors.get(dataset.genres && dataset.genres[i]) || [1.0, 0.38, 0.12];
    else c = stellarColor(colorRanks[i]);
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
  if (!dataset) return true;
  if (activePlaylistId) {
    const pl = playlists.find((p) => p.id === activePlaylistId);
    if (pl) {
      const pathSet = playlistPathSets.get(pl.id);
      if (pathSet && !pathSet.has(dataset.paths[i])) return false;
    }
  }
  if (filterKind.size) {
    const k = dataset.kinds && dataset.kinds[i];
    if (!filterKind.has(k)) return false;
  }
  if (filterInstr.size) {
    const t = (dataset.categories && dataset.categories[i]) || '';
    if (!filterInstr.has(t)) return false;
  }
  if (filterGenre.size) {
    const g = (dataset.genres && dataset.genres[i]) || '';
    if (!filterGenre.has(g)) return false;
  }
  if (!filterText) return true;
  const kind = dataset.kinds && dataset.kinds[i];
  const bpm = dataset.bpms && dataset.bpms[i];
  const hay = [
    dataset.names[i],
    dataset.folders[i],
    dataset.categories && dataset.categories[i] || '',
    dataset.genres && dataset.genres[i] || '',
    kind === 'loop' ? 'loop' : kind === 'oneshot' ? 'one-shot oneshot' : '',
    bpm != null ? `${bpm} bpm` : '',
  ].join(' ').toLowerCase();
  return hay.includes(filterText);
}

function tagCounts(get) {
  const m = new Map();
  if (!dataset) return m;
  for (let i = 0; i < dataset.n; i++) {
    const k = get(i);
    if (!k || k === '—' || k === '…') continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function fillChipRow(el, counts, selected, order, labels) {
  el.replaceChildren();
  const keys = (order || [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })))
    .filter((k) => counts.has(k));
  for (const key of [...selected]) if (!counts.has(key)) selected.delete(key);
  for (const key of keys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-chip' + (selected.has(key) ? ' on' : '');
    btn.dataset.key = key;
    btn.append(labels && labels[key] ? labels[key] : key);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(counts.get(key));
    btn.appendChild(n);
    el.appendChild(btn);
  }
  const heading = el.previousElementSibling;
  const empty = !keys.length;
  el.hidden = empty;
  if (heading && heading.tagName === 'H3') heading.hidden = empty;
}

function renderTagFilters() {
  const kinds = tagCounts((i) => dataset.kinds && dataset.kinds[i]);
  fillChipRow($('filterKind'), kinds, filterKind, ['oneshot', 'loop'], { oneshot: 'One-shot', loop: 'Loop' });
  fillChipRow($('filterInstr'), tagCounts((i) => dataset.categories && dataset.categories[i]), filterInstr);
  fillChipRow($('filterGenre'), tagCounts((i) => dataset.genres && dataset.genres[i]), filterGenre);
  const active = filterKind.size + filterInstr.size + filterGenre.size;
  $('clearFilters').hidden = !active;
}

function bindTagFilters() {
  const rows = [
    ['filterKind', filterKind],
    ['filterInstr', filterInstr],
    ['filterGenre', filterGenre],
  ];
  for (const [id, set] of rows) {
    $(id).addEventListener('click', (e) => {
      const btn = e.target.closest('.tag-chip');
      if (!btn) return;
      const key = btn.dataset.key;
      if (set.has(key)) set.delete(key);
      else set.add(key);
      renderTagFilters();
      restyle();
      refreshList(true);
    });
  }
}

function toggleListTag(el) {
  const val = el.dataset.val;
  if (!val || val === '—' || val === '…') return;
  const set = el.dataset.kind === 'genre' ? filterGenre : filterInstr;
  if (set.has(val)) set.delete(val);
  else set.add(val);
  renderTagFilters();
  restyle();
  refreshList(true);
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
      } else if (key === 'kind') {
        cmp = String(dataset.kinds[a] || '').localeCompare(String(dataset.kinds[b] || ''));
      } else if (key === 'bpm') {
        cmp = (dataset.bpms[a] ?? -1) - (dataset.bpms[b] ?? -1);
      } else if (key === 'tags' || key === 'category') {
        const ta = `${dataset.categories[a] || ''} ${dataset.genres && dataset.genres[a] || ''}`;
        const tb = `${dataset.categories[b] || ''} ${dataset.genres && dataset.genres[b] || ''}`;
        cmp = ta.localeCompare(tb, undefined, { sensitivity: 'base' });
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
  const kind = document.createElement('div');
  kind.className = 'list-kind';
  const bpm = document.createElement('div');
  bpm.className = 'list-bpm';
  const tags = document.createElement('div');
  tags.className = 'list-tags';
  const edit = document.createElement('button');
  edit.className = 'list-edit-btn';
  edit.type = 'button';
  edit.tabIndex = -1;
  edit.textContent = '✎';
  row.append(canvas, dur, name, kind, bpm, tags, edit);
  row.addEventListener('change', (e) => {
    const sel = e.target.closest('.list-edit-kind, .list-edit-instr, .list-edit-genre');
    if (sel) commitRowTags(row);
  });
  return row;
}

// The editor lives on one row at a time; rows are recycled by the virtual list,
// so the open editor is tracked by dataset index rather than by element.
function openRowEditor(idx) {
  if (editingIdx === idx) return;
  editingIdx = idx;
  renderListWindow();
  const row = $('listRows').querySelector('.list-row.editing');
  const first = row && row.querySelector('select');
  if (first) first.focus();
}

function closeRowEditor(repaint = true) {
  if (editingIdx < 0) return;
  editingIdx = -1;
  if (repaint) renderListWindow();
}

function makeTagSelect(cls, values, current) {
  const sel = document.createElement('select');
  sel.className = cls;
  const opts = values.includes(current) || current == null ? values : [current, ...values];
  for (const v of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

async function commitRowTags(row) {
  const idx = parseInt(row.dataset.idx, 10);
  if (!Number.isFinite(idx) || !dataset) return;
  const kind = row.querySelector('.list-edit-kind').value;
  const instrument = row.querySelector('.list-edit-instr').value;
  const genre = row.querySelector('.list-edit-genre').value;
  dataset.kinds[idx] = kind;
  dataset.categories[idx] = instrument === '—' ? '—' : instrument;
  dataset.genres[idx] = genre === '—' ? '—' : genre;
  if (kind !== 'loop') dataset.bpms[idx] = null;
  try {
    await api.setSampleTags(dataset.paths[idx], { kind, instrument, genre });
  } catch (e) {
    showNotice({ msg: `Couldn't save tags: ${e.message}` });
  }
  renderTagFilters();
  restyle();
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
  const kind = dataset.kinds ? dataset.kinds[idx] : null;
  const kindEl = row.querySelector('.list-kind');
  const bpm = dataset.bpms ? dataset.bpms[idx] : null;
  const bpmEl = row.querySelector('.list-bpm');
  const tags = row.querySelector('.list-tags');
  const instr = dataset.categories ? dataset.categories[idx] : '';
  const genre = dataset.genres ? dataset.genres[idx] : '';

  const editing = idx === editingIdx;
  row.classList.toggle('editing', editing);
  if (editing) {
    kindEl.classList.remove('loop');
    kindEl.replaceChildren(makeTagSelect('list-edit-kind', ['oneshot', 'loop'], kind === 'loop' ? 'loop' : 'oneshot'));
    // relabel the kind select options for readability
    const ks = kindEl.querySelector('select');
    for (const o of ks.options) o.textContent = o.value === 'loop' ? 'Loop' : 'One-shot';
    bpmEl.textContent = kind === 'loop' && bpm != null ? String(bpm) : '—';
    tags.classList.add('edit');
    tags.replaceChildren(
      makeTagSelect('list-edit-instr', ['—', ...tagVocab.instruments], instr && instr !== '…' ? instr : '—'),
      makeTagSelect('list-edit-genre', ['—', ...tagVocab.genres], genre && genre !== '…' ? genre : '—'),
    );
    return;
  }

  kindEl.textContent = kind === 'loop' ? 'Loop' : kind === 'oneshot' ? 'One-shot' : '—';
  kindEl.classList.toggle('loop', kind === 'loop');
  bpmEl.textContent = kind === 'loop' && bpm != null ? String(bpm) : '—';
  tags.classList.remove('edit');
  tags.replaceChildren();
  let any = false;
  if (instr && instr !== '—') {
    tags.appendChild(listTagChip(instr, 'instr', instr === 'Uncategorized' || instr === '…'));
    any = true;
  }
  if (genre && genre !== '—') {
    tags.appendChild(listTagChip(genre, 'genre', genre === 'Uncategorized' || genre === '…'));
    any = true;
  }
  if (!any) {
    const s = document.createElement('span');
    s.textContent = '—';
    s.className = 'dim';
    tags.appendChild(s);
  }
}

function listTagChip(val, kind, dim) {
  const s = document.createElement('span');
  s.textContent = val;
  s.dataset.val = val;
  s.dataset.kind = kind;
  if (kind === 'genre') s.classList.add('genre');
  if (dim) s.classList.add('dim');
  return s;
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

  rowsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.list-edit-btn');
    if (!btn) return;
    e.stopPropagation();
    const row = btn.closest('.list-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    if (idx === editingIdx) closeRowEditor();
    else openRowEditor(idx);
  });

  rowsEl.addEventListener('mousedown', (e) => {
    if (e.button === 2) return;
    if (e.target.closest('select')) return;
    if (e.target.closest('.list-edit-btn')) return;
    const editRow = e.target.closest('.list-row');
    if (editingIdx >= 0 && (!editRow || parseInt(editRow.dataset.idx, 10) !== editingIdx)) {
      closeRowEditor();
    }
    const chip = e.target.closest('.list-tags span');
    if (chip && chip.dataset.val) {
      toggleListTag(chip);
      downIdx = -1;
      downPos = null;
      return;
    }
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
      osDragPath = dataset.paths[downIdx];
      api.startDrag(osDragPath);
    }
  });

  window.addEventListener('mouseup', () => {
    if (downIdx >= 0 && !dragStarted) handleClick(downIdx);
    downPos = null;
    downIdx = -1;
    dragStarted = false;
  });

  // A sample dragged out of the app can be dropped back onto a playlist entry
  // (HTML5 drag events fire for OS drags re-entering the window). The dropped
  // file's path comes from dataTransfer; osDragPath is the fallback.
  document.addEventListener('mousedown', () => { osDragPath = null; });

  rowsEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('.list-row');
    if (!row || !dataset) return;
    const idx = parseInt(row.dataset.idx, 10);
    showContextMenu(idx, e.clientX, e.clientY);
  });

  $('listScroll').addEventListener('mousedown', (e) => {
    if (!e.target.closest('.list-row')) closeRowEditor();
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
  const kind = dataset.kinds && dataset.kinds[idx];
  if (kind === 'loop') {
    const bpm = dataset.bpms && dataset.bpms[idx];
    parts.push(bpm != null ? `Loop ${bpm} BPM` : 'Loop');
  } else if (kind === 'oneshot') {
    parts.push('One-shot');
  }
  if (dataset.categories && dataset.categories[idx] && dataset.categories[idx] !== '—') parts.push(dataset.categories[idx]);
  if (dataset.genres && dataset.genres[idx] && dataset.genres[idx] !== '—') parts.push(dataset.genres[idx]);
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
  playlistPlayQueue = null;
  playlistPlayPos = -1;
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
      // sequential playlist playback: advance to next track
      if (playlistPlayQueue && playlistPlayPos >= 0) {
        const nextPos = playlistPlayPos + 1;
        if (nextPos < playlistPlayQueue.length) {
          playlistPlayPos = nextPos;
          const nextIdx = playlistPlayQueue[nextPos];
          playingIdx = -1; // clear so handleClick doesn't think it's a toggle-stop
          handleClick(nextIdx);
          return;
        }
      }
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
  const img = $('progressLogo');
  if (phase === 'idle') {
    wrap.hidden = true;
    if (img) img.dataset.playing = '';
    updateStatus();
    return;
  }
  if (wrap.hidden && img) {
    img.src = img.getAttribute('src');
    img.dataset.playing = '1';
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

// ------------------------------------------------------------ playlists

function rebuildPlaylistPathSets() {
  playlistPathSets = new Map();
  if (!dataset || !dataset.paths) return;
  const pathIdx = new Map();
  for (let i = 0; i < dataset.paths.length; i++) pathIdx.set(dataset.paths[i], i);
  for (const pl of playlists) {
    const s = new Set();
    for (const p of pl.paths) if (pathIdx.has(p)) s.add(p);
    playlistPathSets.set(pl.id, s);
  }
}

function askName({ title, initial = '', confirmLabel = 'Create' }) {
  return new Promise((resolve) => {
    const overlay = $('nameDialog');
    const input = $('nameDialogInput');
    const ok = $('nameDialogOk');
    const cancel = $('nameDialogCancel');
    $('nameDialogTitle').textContent = title;
    ok.textContent = confirmLabel;
    input.value = initial;
    overlay.hidden = false;

    const finish = (value) => {
      overlay.hidden = true;
      overlay.removeEventListener('click', onOverlay);
      cancel.removeEventListener('click', onCancel);
      ok.removeEventListener('click', onOk);
      input.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onEsc, true);
      resolve(value);
    };
    const onCancel = () => finish(null);
    const onOk = () => finish(input.value);
    const onOverlay = (e) => { if (e.target === overlay) onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
    };
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };

    overlay.addEventListener('click', onOverlay);
    cancel.addEventListener('click', onCancel);
    ok.addEventListener('click', onOk);
    input.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onEsc, true);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

function bindPlaylistControls() {
  $('newPlaylist').addEventListener('click', async () => {
    const name = await askName({ title: 'Playlist name', initial: '', confirmLabel: 'Create' });
    if (name === null) return;
    playlists = await api.playlistsCreate(name.trim() || 'Untitled');
    renderPlaylists();
  });
}

function renderPlaylists() {
  const ul = $('playlistList');
  ul.replaceChildren();
  $('playlistEmptyHint').hidden = playlists.length > 0;
  playlists.forEach((pl) => {
    const li = document.createElement('li');
    li.className = 'pl-item' + (pl.id === activePlaylistId ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'pl-name';
    name.textContent = pl.name;
    name.title = `${pl.name} (${pl.paths.length} samples)`;
    name.addEventListener('click', () => togglePlaylistFilter(pl.id));
    const count = document.createElement('span');
    count.className = 'pl-count';
    count.textContent = String(pl.paths.length);
    const x = document.createElement('span');
    x.className = 'pl-x';
    x.textContent = '\u2715';
    x.title = 'Delete playlist';
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (activePlaylistId === pl.id) activePlaylistId = null;
      playlists = await api.playlistsDelete(pl.id);
      if (activePlaylistId && !playlists.find((p) => p.id === activePlaylistId)) activePlaylistId = null;
      renderPlaylists();
      restyle();
      refreshList(true);
    });
    li.append(name, count, x);
    makePlaylistDropTarget(li, pl);
    ul.appendChild(li);
  });
  renderPlaylistDetail();
}

// Accept a sample dragged out of the map/list (OS drag) dropped onto a playlist.
function makePlaylistDropTarget(el, pl) {
  el.addEventListener('dragover', (e) => {
    if (!osDragPath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drop-target');
    if (!osDragPath) return;
    e.preventDefault();
    // prefer the path Electron reports on the dropped File; fall back to the
    // path recorded when the drag started
    let p = osDragPath;
    try {
      if (e.dataTransfer.files.length && e.dataTransfer.files[0].path) p = e.dataTransfer.files[0].path;
    } catch { /* keep fallback */ }
    osDragPath = null;
    if (!dataset || !dataset.paths.includes(p)) return;
    playlists = await api.playlistsAdd(pl.id, [p]);
    rebuildPlaylistPathSets();
    renderPlaylists();
    showNotice({ msg: `Added "${p.split(/[\\/]/).pop()}" to "${pl.name}"` });
  });
}

// Detail view for the selected playlist: reorderable tracks, play-all, remove.
function renderPlaylistDetail() {
  const box = $('playlistDetail');
  const pl = playlists.find((p) => p.id === activePlaylistId);
  if (!pl) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren();

  const head = document.createElement('div');
  head.className = 'pl-detail-head';
  const title = document.createElement('span');
  title.className = 'pl-detail-name';
  title.textContent = pl.name;
  title.title = 'Double-click to rename';
  title.addEventListener('dblclick', async () => {
    const next = await askName({ title: 'Rename playlist', initial: pl.name, confirmLabel: 'Rename' });
    if (next === null) return;
    playlists = await api.playlistsRename(pl.id, next.trim() || pl.name);
    renderPlaylists();
  });
  const play = document.createElement('button');
  play.className = 'pl-play';
  play.type = 'button';
  play.textContent = '▶ Play all';
  play.disabled = !pl.paths.length;
  play.addEventListener('click', () => playPlaylist(pl));
  head.append(title, play);
  box.appendChild(head);

  if (!pl.paths.length) {
    const hint = document.createElement('div');
    hint.className = 'hint pl-empty-hint';
    hint.textContent = 'Empty. Drag samples here, or right-click any sample → Add to playlist.';
    makePlaylistDropTarget(hint, pl);
    box.appendChild(hint);
    return;
  }

  const pathToIdx = new Map();
  if (dataset && dataset.paths) {
    for (let i = 0; i < dataset.paths.length; i++) pathToIdx.set(dataset.paths[i], i);
  }

  const ol = document.createElement('ol');
  ol.className = 'pl-tracks';
  let dragFrom = -1;

  pl.paths.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'pl-track';
    li.draggable = true;
    const idx = pathToIdx.has(p) ? pathToIdx.get(p) : -1;
    if (idx < 0) li.classList.add('missing');
    if (idx >= 0 && idx === playingIdx) li.classList.add('playing');

    const num = document.createElement('span');
    num.className = 'pl-track-n';
    num.textContent = String(i + 1);
    const nm = document.createElement('span');
    nm.className = 'pl-track-name';
    nm.textContent = idx >= 0 ? dataset.names[idx] : p.split(/[\\/]/).pop();
    nm.title = p;
    if (idx >= 0) nm.addEventListener('click', () => handleClick(idx));
    const rm = document.createElement('span');
    rm.className = 'pl-track-x';
    rm.textContent = '✕';
    rm.title = 'Remove from playlist';
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      playlists = await api.playlistsRemove(pl.id, p);
      rebuildPlaylistPathSets();
      renderPlaylists();
      restyle();
      refreshList(true);
    });

    li.addEventListener('dragstart', (e) => {
      dragFrom = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    li.addEventListener('dragend', () => {
      dragFrom = -1;
      li.classList.remove('dragging');
      ol.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    });
    li.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      li.classList.remove('drop-target');
      const from = dragFrom;
      dragFrom = -1;
      if (from < 0 || from === i) return;
      playlists = await api.playlistsReorder(pl.id, from, i);
      renderPlaylists();
    });

    li.append(num, nm, rm);
    ol.appendChild(li);
  });
  box.appendChild(ol);
}

function togglePlaylistFilter(id) {
  if (activePlaylistId === id) activePlaylistId = null;
  else activePlaylistId = id;
  renderPlaylists();
  restyle();
  refreshList(true);
  if (params.view === 'map') starmap.fit();
}

// ---- context menu (right-click on map or list) ----

let ctxMenuIdx = -1;

function bindContextMenu() {
  document.addEventListener('click', (e) => {
    const m = $('ctxMenu');
    if (m && !m.hidden && !m.contains(e.target)) m.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('ctxMenu').hidden = true;
  });
}

function showContextMenu(idx, x, y) {
  if (!dataset || idx < 0) return;
  const menu = $('ctxMenu');
  ctxMenuIdx = idx;

  const items = [];
  // "Add to playlist >" submenu
  items.push({ label: 'Add to playlist\u2026', submenu: playlists.length ? playlists.map((pl) => ({
    label: `${pl.name} (${pl.paths.length})`,
    action: async () => {
      playlists = await api.playlistsAdd(pl.id, [dataset.paths[idx]]);
      rebuildPlaylistPathSets();
      renderPlaylists();
      showNotice({ msg: `Added "${dataset.names[idx]}" to "${pl.name}"` });
    },
  })) : [{ label: 'No playlists yet', disabled: true }] });

  // If in a playlist filter view, offer "Remove from this playlist"
  if (activePlaylistId) {
    const pl = playlists.find((p) => p.id === activePlaylistId);
    if (pl) {
      const path = dataset.paths[idx];
      if (pl.paths.includes(path)) {
        items.push({ label: `Remove from "${pl.name}"`, action: async () => {
          playlists = await api.playlistsRemove(pl.id, path);
          rebuildPlaylistPathSets();
          renderPlaylists();
          restyle();
          refreshList(true);
          showNotice({ msg: `Removed from "${pl.name}"` });
        }});
      }
    }
  }

  // Play as playlist (if in a playlist view)
  if (activePlaylistId) {
    const pl = playlists.find((p) => p.id === activePlaylistId);
    if (pl && pl.paths.length > 1) {
      items.push({ label: `\u25B6 Play "${pl.name}" sequentially`, action: () => playPlaylist(pl) });
    }
  }

  items.push({ label: 'Show in Explorer', action: () => api.reveal(dataset.paths[idx]) });

  // build menu DOM
  menu.replaceChildren();
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.disabled ? ' disabled' : '');
    el.textContent = item.label;
    if (!item.disabled && item.action) {
      el.addEventListener('click', () => { menu.hidden = true; item.action(); });
    }
    if (item.submenu) {
      const sub = document.createElement('div');
      sub.className = 'ctx-submenu';
      for (const subItem of item.submenu) {
        const subEl = document.createElement('div');
        subEl.className = 'ctx-item' + (subItem.disabled ? ' disabled' : '');
        subEl.textContent = subItem.label;
        if (!subItem.disabled && subItem.action) {
          subEl.addEventListener('click', () => { menu.hidden = true; subItem.action(); });
        }
        sub.appendChild(subEl);
      }
      el.classList.add('has-sub');
      el.appendChild(sub);
    }
    menu.appendChild(el);
  }

  menu.hidden = false;
  // position: clamp to viewport
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let mx = x, my = y;
  if (mx + mw > vw - 4) mx = vw - mw - 4;
  if (my + mh > vh - 4) my = vh - mh - 4;
  menu.style.left = `${mx}px`;
  menu.style.top = `${my}px`;
}

// ---- sequential playlist playback ----

function playPlaylist(pl) {
  if (!dataset || !pl.paths.length) return;
  const pathToIdx = new Map();
  for (let i = 0; i < dataset.paths.length; i++) pathToIdx.set(dataset.paths[i], i);
  const queue = pl.paths.map((p) => pathToIdx.get(p)).filter((i) => i != null && i >= 0);
  if (!queue.length) return;
  stopAudio();
  playlistPlayQueue = queue;
  playlistPlayPos = 0;
  handleClick(queue[0]);
}

init();
