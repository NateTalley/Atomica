import '../src/renderer/list-controls.js';
import assert from 'node:assert/strict';
import test from 'node:test';

const L = globalThis.ListControls;

test('cycleKind flips loop and one-shot', () => {
  assert.equal(L.cycleKind('loop'), 'oneshot');
  assert.equal(L.cycleKind('oneshot'), 'loop');
  assert.equal(L.cycleKind(L.cycleKind('loop')), 'loop');
  assert.equal(L.isCyclableKind('loop'), true);
  assert.equal(L.isCyclableKind('oneshot'), true);
  assert.equal(L.isCyclableKind(null), false);
  assert.equal(L.isCyclableKind('—'), false);
});

test('scrubFraction and scrubSeconds stay inside the buffer', () => {
  assert.equal(L.scrubFraction(0, 100), 0);
  assert.equal(L.scrubFraction(50, 100), 0.5);
  assert.equal(L.scrubFraction(140, 100), 1);
  assert.equal(L.scrubFraction(-10, 100), 0);
  assert.equal(L.scrubFraction(10, 0), 0);
  assert.equal(L.scrubSeconds(0.5, 1), 0.5);
  assert.equal(L.scrubSeconds(1, 2), 1.99);
  assert.equal(L.scrubSeconds(0, 1), 0);
  assert.equal(L.scrubSeconds(0.5, 0), 0);
  assert.equal(L.scrubSeconds(0.2, 0.005), 0);
});

test('volumeOverride clears full scale and clamps', () => {
  assert.equal(L.volumeOverride(1), null);
  assert.equal(L.volumeOverride(0.999), null);
  assert.equal(L.volumeOverride(1.4), null);
  assert.equal(L.volumeOverride(0), 0);
  assert.equal(L.volumeOverride(-0.2), 0);
  assert.equal(L.volumeOverride(0.4), 0.4);
  assert.equal(L.volumeOverride(0.3333), 0.333);
  assert.equal(L.volumeOverride('nope'), null);
  assert.equal(L.auditionGain(0.5, 0.8), 0.4);
  assert.equal(L.auditionGain(undefined, undefined), 0.9);
});

test('batchPaths edits the selection only when the acted sample is in it', () => {
  const selected = new Set(['a', 'b', 'c']);
  assert.deepEqual(L.batchPaths(selected, 'b').sort(), ['a', 'b', 'c']);
  assert.deepEqual(L.batchPaths(selected, 'z'), ['z']);
  assert.deepEqual(L.batchPaths(new Set(), 'z'), ['z']);
  assert.deepEqual(L.batchPaths(selected, ''), []);
});

test('editorTarget follows the playing sample, then the last checked row', () => {
  assert.equal(L.editorTarget({ playingPath: 'b', anchorPath: 'a', anchorSelected: true }), 'b');
  assert.equal(L.editorTarget({ playingPath: null, anchorPath: 'a', anchorSelected: true }), 'a');
  assert.equal(L.editorTarget({ playingPath: '', anchorPath: 'a', anchorSelected: false }), null);
  assert.equal(L.editorTarget({}), null);
});

test('withinMaxDuration hides samples longer than the cap', () => {
  assert.equal(L.withinMaxDuration(59, true, 59), true);
  assert.equal(L.withinMaxDuration(59.01, true, 59), false);
  assert.equal(L.withinMaxDuration(120, false, 59), true);
  assert.equal(L.withinMaxDuration(null, true, 59), true);
  assert.equal(L.withinMaxDuration(10, true, 0), true);
});

test('rangeSelect unions the visible span and header state follows it', () => {
  const ordered = ['a', 'b', 'c', 'd'];
  const next = L.rangeSelect(new Set(['d']), ordered, 'a', 'c');
  assert.deepEqual([...next].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(L.headerCheckState(next, ordered), 'all');
  next.delete('b');
  assert.equal(L.headerCheckState(next, ordered), 'some');
  assert.equal(L.headerCheckState(new Set(), ordered), 'none');
  assert.equal(L.headerCheckState(new Set(['a']), []), 'none');
  const missing = L.rangeSelect(new Set(), ordered, 'missing', 'b');
  assert.deepEqual([...missing], ['b']);
});
