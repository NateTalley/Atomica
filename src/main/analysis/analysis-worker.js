// Worker thread: decodes one file at a time and extracts DSP features.
import { parentPort } from 'node:worker_threads';
import { analyzeFile, peaksFromFile } from './dsp.js';

parentPort.on('message', async (msg) => {
  if (msg.type === 'peaks') {
    try {
      const peaks = await peaksFromFile(msg.path);
      parentPort.postMessage({ type: 'peaks-result', path: msg.path, peaks }, [peaks.buffer]);
    } catch (err) {
      parentPort.postMessage({ type: 'peaks-result', path: msg.path, error: String((err && err.message) || err) });
    }
    return;
  }
  if (msg.type !== 'file') return;
  try {
    const res = await analyzeFile(msg.path, msg.wantAudio48);
    const transfers = [];
    if (res.audio48) transfers.push(res.audio48.buffer);
    if (res.peaks) transfers.push(res.peaks.buffer);
    parentPort.postMessage(
      { type: 'result', path: msg.path, features: res.features, mfcc: res.mfcc, audio48: res.audio48, peaks: res.peaks },
      transfers,
    );
  } catch (err) {
    parentPort.postMessage({ type: 'result', path: msg.path, error: String((err && err.message) || err) });
  }
});
