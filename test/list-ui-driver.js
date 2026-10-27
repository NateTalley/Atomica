(async () => {
  const waitFor = async (fn, ms = 5000) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
      try {
        last = fn();
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('timeout: ' + JSON.stringify(last));
  };

  const rowFor = (name) => {
    const idx = dataset.names.indexOf(name);
    return [...document.querySelectorAll('#listRows .list-row')]
      .find((r) => Number(r.dataset.idx) === idx) || null;
  };

  const press = (el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.min(10, rect.width / 2);
    const y = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  };

  await waitFor(() => dataset && dataset.n >= 4 && dataset.volumes && dataset.volumes.length === dataset.n);
  document.getElementById('viewList').click();
  await waitFor(() => rowFor('a_alpha.wav') && rowFor('d_delta.wav'));

  const rows = ['a_alpha.wav', 'b_beta.wav', 'c_gamma.wav', 'd_delta.wav'].map(rowFor);
  if (rows.some((r) => !r)) throw new Error('missing row');
  for (const row of rows) {
    if (!row.querySelector('.list-check')) throw new Error('missing checkbox');
    if (!row.querySelector('.list-vol')) throw new Error('missing volume slider');
    if (!row.querySelector('canvas')) throw new Error('missing waveform');
  }
  if (rows[0].querySelector('.list-kind').textContent !== 'One-shot') throw new Error('a kind label');
  if (rows[2].querySelector('.list-kind').textContent !== 'Loop') throw new Error('c kind label');
  if (rows[2].querySelector('.list-bpm').textContent !== '120') throw new Error('c bpm');

  const log = [];
  const snap = () => dataset;

  // 1. Double-click the type word on one sample.
  let before = snap();
  rows[0].querySelector('.list-kind').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await waitFor(() => dataset !== before && dataset.kinds[dataset.names.indexOf('a_alpha.wav')] === 'loop');
  const a = dataset.names.indexOf('a_alpha.wav');
  const b = dataset.names.indexOf('b_beta.wav');
  const c = dataset.names.indexOf('c_gamma.wav');
  if (dataset.kinds[b] !== 'oneshot') throw new Error('single cycle touched b');
  await waitFor(() => rowFor('a_alpha.wav').querySelector('.list-bpm').textContent === '100');
  log.push('dblclick cycles one sample to loop and restores its BPM');

  // 2. Check two samples and cycle them together.
  rowFor('a_alpha.wav').querySelector('.list-check')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  rowFor('b_beta.wav').querySelector('.list-check')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitFor(() => selectedPaths.has(dataset.paths[a]) && selectedPaths.has(dataset.paths[b]) && selectedPaths.size === 2);
  before = snap();
  rowFor('a_alpha.wav').querySelector('.list-kind')
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await waitFor(() => dataset !== before
    && dataset.kinds[a] === 'oneshot'
    && dataset.kinds[b] === 'oneshot'
    && dataset.kinds[c] === 'loop');
  log.push('dblclick on a checked sample cycles every checked sample');

  // 3. Volume slider writes the same level onto the selection.
  const slider = rowFor('a_alpha.wav').querySelector('.list-vol');
  slider.value = '40';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => pendingVolumes.size === 0
    && Math.abs(dataset.volumes[a] - 0.4) < 0.001
    && Math.abs(dataset.volumes[b] - 0.4) < 0.001
    && Math.abs(dataset.volumes[c] - 1) < 0.001);
  const bSlider = rowFor('b_beta.wav').querySelector('.list-vol');
  if (bSlider.value !== '40') throw new Error('paired slider ' + bSlider.value);
  log.push('volume slider sets the checked samples together');

  // 4. Pencil editor applies one attribute to the selection.
  before = snap();
  rowFor('a_alpha.wav').querySelector('.list-edit-btn').click();
  const sel = rowFor('a_alpha.wav').querySelector('.list-edit-instr');
  if (!sel) throw new Error('editor did not open');
  sel.value = 'Guitar';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => dataset !== before
    && dataset.categories[a] === 'Guitar'
    && dataset.categories[b] === 'Guitar'
    && dataset.categories[c] !== 'Guitar');
  log.push('instrument edit applies to the selection');

  // 5. Context menu adds the selection to a playlist.
  showContextMenu(a, 240, 240);
  const fav = [...document.querySelectorAll('#ctxMenu .ctx-submenu .ctx-item')]
    .find((el) => el.textContent.toLowerCase().includes('favorites'));
  if (!fav) throw new Error('favorites submenu missing');
  fav.click();
  await waitFor(() => {
    const pl = playlists.find((p) => String(p.name).toLowerCase() === 'favorites');
    return pl && pl.paths.includes(dataset.paths[a]) && pl.paths.includes(dataset.paths[b])
      && !pl.paths.includes(dataset.paths[c]);
  });
  log.push('add to playlist takes the checked samples');

  // 6. Header checkbox and shift-click range.
  document.getElementById('listSelectAll').click();
  await waitFor(() => selectedPaths.size === 4);
  document.getElementById('listSelectAll').click();
  await waitFor(() => selectedPaths.size === 0);
  rowFor('a_alpha.wav').querySelector('.list-check')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  rowFor('c_gamma.wav').querySelector('.list-check')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  await waitFor(() => selectedPaths.size === 3
    && selectedPaths.has(dataset.paths[a])
    && selectedPaths.has(dataset.paths[b])
    && selectedPaths.has(dataset.paths[c]));
  document.getElementById('listSelectAll').click();
  await waitFor(() => selectedPaths.size === 4);
  document.getElementById('listSelectAll').click();
  await waitFor(() => selectedPaths.size === 0);
  log.push('header checkbox and shift-click select ranges');

  // 7. Drag the waveform playhead.
  press(rowFor('c_gamma.wav').querySelector('.list-name'));
  await waitFor(() => playingIdx === c && playBuf && currentSource && playBuf.duration > 0.5);
  const canvas = rowFor('c_gamma.wav').querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  const pointer = (type, x) => {
    const target = type === 'pointerdown' ? canvas : window;
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse',
    }));
  };
  pointer('pointerdown', rect.left + rect.width * 0.5);
  pointer('pointermove', rect.left + rect.width * 0.5);
  pointer('pointerup', rect.left + rect.width * 0.5);
  const dur = playBuf.duration;
  if (!(playOffset > dur * 0.35 && playOffset < dur * 0.65)) {
    throw new Error('playhead ' + playOffset + ' of ' + dur);
  }
  if (playingIdx !== c || !currentSource) throw new Error('scrub stopped playback');
  log.push('waveform drag seeks the playhead');

  // Leave a readable picture: two checks, a lowered slider, a mid-file playhead.
  rowFor('a_alpha.wav').querySelector('.list-check')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  rowFor('b_beta.wav').querySelector('.list-check')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  return {
    ok: true,
    log,
    kinds: dataset.kinds.slice(),
    volumes: dataset.volumes.slice(),
    playOffset,
    duration: dur,
  };
})()
