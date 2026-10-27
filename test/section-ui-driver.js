(async () => {
  const waitFor = async (fn, ms = 8000, label = '') => {
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
    const notice = document.getElementById('notice');
    throw new Error(`timeout ${label}: ${JSON.stringify(last)} notice=${notice && !notice.hidden ? notice.textContent : ''} n=${dataset && dataset.n} playing=${playingIdx}`);
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

  const pointer = (canvas, type, frac) => {
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width * frac,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      pointerType: 'mouse',
    }));
  };

  const dragSection = (from, to) => {
    const canvas = document.getElementById('seWave');
    pointer(canvas, 'pointerdown', from);
    pointer(canvas, 'pointermove', (from + to) / 2);
    pointer(canvas, 'pointermove', to);
    pointer(canvas, 'pointerup', to);
  };

  await waitFor(() => dataset && dataset.n >= 4, 8000, 'dataset');
  document.getElementById('viewList').click();
  await waitFor(() => rowFor('c_gamma.wav'), 8000, 'rows');

  const log = [];
  const gammaIdx = () => dataset.names.indexOf('c_gamma.wav');
  const gammaPath = () => dataset.paths[gammaIdx()];

  // Untouched samples still audition the whole file at unity speed.
  press(rowFor('a_alpha.wav').querySelector('.list-name'));
  await waitFor(() => playingIdx === dataset.names.indexOf('a_alpha.wav') && currentSource && playBuf, 8000, 'play-alpha');
  if (currentSource.loop) throw new Error('default playback looped');
  if (Math.abs(currentSource.playbackRate.value - 1) > 0.001) throw new Error('default rate ' + currentSource.playbackRate.value);
  press(rowFor('a_alpha.wav').querySelector('.list-name'));
  await waitFor(() => playingIdx < 0 && !currentSource);
  log.push('samples without a section still play once at full speed');

  rowFor('c_gamma.wav').querySelector('.list-section-btn').click();
  await waitFor(() => !document.getElementById('sectionEditor').hidden
    && document.getElementById('seWave').getBoundingClientRect().width > 80);
  if (document.getElementById('seTitle').textContent !== 'c_gamma.wav') {
    throw new Error('editor title ' + document.getElementById('seTitle').textContent);
  }
  if (!document.getElementById('seLoop').checked) throw new Error('section loop defaulted off');

  dragSection(0.2, 0.8);
  const picked = sectionByPath.get(gammaPath());
  if (!picked || Math.abs(picked.start - 0.2) > 0.03 || Math.abs(picked.end - 0.8) > 0.03) {
    throw new Error('selection ' + JSON.stringify(picked));
  }
  log.push('drag on the section waveform sets the region');

  document.getElementById('sePlay').click();
  await waitFor(() => playingIdx === gammaIdx() && currentSource && currentSource.loop && playBuf && playBuf.duration > 0.5);
  const dur = playBuf.duration;
  if (Math.abs(currentSource.loopStart - dur * 0.2) > dur * 0.05) {
    throw new Error('loopStart ' + currentSource.loopStart + ' of ' + dur);
  }
  if (Math.abs(currentSource.loopEnd - dur * 0.8) > dur * 0.05) {
    throw new Error('loopEnd ' + currentSource.loopEnd + ' of ' + dur);
  }
  log.push('playback loops only the selected section');

  const rate = document.getElementById('seRate');
  rate.value = '50';
  rate.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => currentSource && Math.abs(currentSource.playbackRate.value - 0.5) < 0.001);
  if (sectionByPath.get(gammaPath()).rate !== 0.5) throw new Error('rate was not stored on the sample');
  log.push('speed is the sample-wide playback rate');

  const originalBytes = (await window.atomica.readAudio(gammaPath())).byteLength;
  document.getElementById('seSaveAs').click();
  await waitFor(() => !document.getElementById('nameDialog').hidden);
  const suggested = document.getElementById('nameDialogInput').value;
  if (!suggested.toLowerCase().includes('(cut)')) throw new Error('suggested name ' + suggested);
  document.getElementById('nameDialogOk').click();
  await waitFor(() => dataset.names.some((n) => n.includes('(cut)')));
  const cutName = dataset.names.find((n) => n.includes('(cut)'));
  const cutIdx = dataset.names.indexOf(cutName);
  const cutDur = dataset.features.duration[cutIdx];
  if (!(cutDur > 0.5 && cutDur < 0.7)) throw new Error('cut duration ' + cutDur);
  if (Math.abs(dataset.features.duration[gammaIdx()] - 1) > 0.05) throw new Error('original duration changed');
  const originalAfter = (await window.atomica.readAudio(gammaPath())).byteLength;
  if (originalAfter !== originalBytes) throw new Error('original file rewritten ' + originalAfter);
  const cutBytes = await window.atomica.readAudio(dataset.paths[cutIdx]);
  if (String.fromCharCode(cutBytes[0], cutBytes[1], cutBytes[2], cutBytes[3]) !== 'RIFF') throw new Error('cut is not a wav');
  if (cutBytes.byteLength >= originalBytes) throw new Error('cut was not shorter');
  log.push('save as new writes the section and keeps the original file');

  const cutRow = rowFor(cutName);
  const rowDump = [...document.querySelectorAll('#listRows .list-row')]
    .map((r) => `${r.dataset.idx}:${r.querySelector('.list-name').textContent}`).join(' | ');
  if (!cutRow) throw new Error('no cut row ' + rowDump + ' names=' + dataset.names.join(','));
  cutRow.querySelector('.list-section-btn').click();
  await waitFor(() => {
    const ed = document.getElementById('sectionEditor');
    const title = document.getElementById('seTitle').textContent;
    const width = document.getElementById('seWave').getBoundingClientRect().width;
    if (!ed.hidden && title === cutName && width > 80) return true;
    throw new Error(`row=${cutRow.querySelector('.list-name').textContent}#${cutRow.dataset.idx} title=${title} hidden=${ed.hidden} w=${Math.round(width)} rows=${rowDump}`);
  }, 2500, 'open-cut');
  dragSection(0, 0.5);
  const cutPath = dataset.paths[dataset.names.indexOf(cutName)];
  const half = sectionByPath.get(cutPath);
  if (!half || half.end > 0.55) throw new Error('second selection ' + JSON.stringify(half));
  const replaceBtn = document.getElementById('seSave');
  const saveAsBtn = document.getElementById('seSaveAs');
  if (replaceBtn.textContent !== 'Replace original…') throw new Error('replace label ' + replaceBtn.textContent);
  if (replaceBtn.classList.contains('primary') || !saveAsBtn.classList.contains('primary')) {
    throw new Error('save as new should be the primary button');
  }
  if (!(saveAsBtn.compareDocumentPosition(replaceBtn) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    throw new Error('save as new should come before replace');
  }
  replaceBtn.click();
  await waitFor(() => !document.getElementById('nameDialog').hidden);
  const confirmTitle = document.getElementById('nameDialogTitle').textContent;
  if (!confirmTitle.startsWith('Overwrite "') || !confirmTitle.includes('with this section?')) {
    throw new Error('confirm ' + confirmTitle);
  }
  document.getElementById('nameDialogOk').click();
  await waitFor(() => {
    const i = dataset.names.indexOf(cutName);
    return i >= 0 && dataset.features.duration[i] > 0.2 && dataset.features.duration[i] < 0.4;
  });
  const replacedDur = dataset.features.duration[dataset.names.indexOf(cutName)];
  const stillOriginal = (await window.atomica.readAudio(gammaPath())).byteLength;
  if (stillOriginal !== originalBytes) throw new Error('in-place save touched the original');
  if (!dataset.names.includes('c_gamma.wav')) throw new Error('original sample dropped from the library');
  log.push('save in place overwrites only the cut file');

  // The editor stays on the replaced file. Pull a fresh region so the screenshot shows a section.
  await waitFor(() => !document.getElementById('sectionEditor').hidden
    && document.getElementById('seTitle').textContent === cutName);
  dragSection(0.25, 0.75);
  const speed = document.getElementById('seRate');
  speed.value = '50';
  speed.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('seLoop').checked = true;
  document.getElementById('seLoop').dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('sePlay').click();
  await waitFor(() => currentSource && currentSource.loop && Math.abs(currentSource.playbackRate.value - 0.5) < 0.001);

  return {
    ok: true,
    log,
    cutName,
    cutDur,
    replacedDur,
    originalBytes,
    loopStart: currentSource.loopStart,
    loopEnd: currentSource.loopEnd,
    rate: currentSource.playbackRate.value,
  };
})()
