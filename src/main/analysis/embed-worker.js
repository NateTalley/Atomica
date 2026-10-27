// Worker thread: CLAP audio + text embeddings via transformers.js (ONNX runtime).
// The model (~90 MB, quantized) is downloaded once and cached in userData/models.
// Audio and text share this worker: onnxruntime-node fatals if loaded in two threads.
import { parentPort, workerData } from 'node:worker_threads';

const MODEL_ID = 'Xenova/clap-htsat-unfused';
const WHISPER_ID = 'Xenova/whisper-tiny';
const WHISPER_SR = 16000;
let audioPromise = null;
let textPromise = null;
let whisperPromise = null;

async function ensureAudioModel() {
  if (!audioPromise) {
    audioPromise = (async () => {
      const { AutoProcessor, ClapAudioModelWithProjection, cat, env } = await import('@huggingface/transformers');
      env.cacheDir = workerData.cacheDir;
      env.allowLocalModels = false;
      const processor = await AutoProcessor.from_pretrained(MODEL_ID);
      let model;
      try {
        model = await ClapAudioModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });
      } catch {
        model = await ClapAudioModelWithProjection.from_pretrained(MODEL_ID);
      }
      return { processor, model, cat };
    })();
  }
  return audioPromise;
}

async function ensureTextModel() {
  if (!textPromise) {
    textPromise = (async () => {
      const { AutoTokenizer, ClapTextModelWithProjection, env } = await import('@huggingface/transformers');
      env.cacheDir = workerData.cacheDir;
      env.allowLocalModels = false;
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      let model;
      try {
        model = await ClapTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });
      } catch {
        model = await ClapTextModelWithProjection.from_pretrained(MODEL_ID);
      }
      return { tokenizer, model };
    })();
  }
  return textPromise;
}

async function ensureWhisper() {
  if (!whisperPromise) {
    whisperPromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = workerData.cacheDir;
        env.allowLocalModels = false;
        try {
          return await pipeline('automatic-speech-recognition', WHISPER_ID, { dtype: 'q8' });
        } catch {
          return await pipeline('automatic-speech-recognition', WHISPER_ID);
        }
      } catch (err) {
        whisperPromise = null;
        throw err;
      }
    })();
  }
  return whisperPromise;
}

function transcriptText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result.text === 'string') return result.text;
  return '';
}

// Whisper's window is 30s. Longer files are split and the text is joined.
async function transcribeAudio(asr, audio) {
  const data = audio instanceof Float32Array ? audio : Float32Array.from(audio || []);
  if (!data.length) return '';
  const chunk = 30 * WHISPER_SR;
  const parts = [];
  for (let off = 0; off < data.length; off += chunk) {
    const slice = data.subarray(off, Math.min(data.length, off + chunk));
    if (slice.length < WHISPER_SR * 0.2 && parts.length) break;
    const input = slice.length === data.length ? data : slice.slice();
    const result = await asr(input, { return_timestamps: false });
    const text = transcriptText(result).replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function l2NormalizeRows(data, n, dim) {
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += data[off + k] * data[off + k];
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < dim; k++) data[off + k] /= norm;
  }
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'embed-text') {
    try {
      const t = await ensureTextModel();
      const inputs = t.tokenizer(msg.texts, { padding: true, truncation: true });
      const out = await t.model(inputs);
      const src = out.text_embeds.data;
      const n = msg.texts.length;
      const dim = src.length / n;
      const embeds = Float32Array.from(src);
      l2NormalizeRows(embeds, n, dim);
      parentPort.postMessage({ type: 'text-embedded', embeds, dim, n }, [embeds.buffer]);
    } catch (err) {
      parentPort.postMessage({ type: 'text-error', error: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === 'transcribe') {
    try {
      const asr = await ensureWhisper();
      const text = await transcribeAudio(asr, msg.audio);
      parentPort.postMessage({ type: 'transcribed', path: msg.path, text });
    } catch (err) {
      parentPort.postMessage({
        type: 'transcribe-error',
        path: msg.path,
        error: String((err && err.message) || err),
      });
    }
    return;
  }

  if (msg.type !== 'embed-batch') return;
  const paths = msg.items.map((it) => it.path);
  let m;
  try {
    m = await ensureAudioModel();
  } catch (err) {
    // Model unavailable (offline / download failed): everything falls back to DSP-only.
    parentPort.postMessage({ type: 'embed-fatal', error: String((err && err.message) || err) });
    return;
  }
  try {
    // The feature extractor only takes one clip at a time, so extract each and
    // concatenate along the batch axis before a single forward pass.
    const each = [];
    for (const it of msg.items) each.push(await m.processor(it.audio));
    const keys = Object.keys(each[0]);
    const inputs = {};
    for (const k of keys) {
      inputs[k] = each.length === 1 ? each[0][k] : m.cat(each.map((e) => e[k]), 0);
    }
    const out = await m.model(inputs);
    const data = out.audio_embeds.data;
    const dim = data.length / msg.items.length;
    const embs = [];
    const transfers = [];
    for (let i = 0; i < msg.items.length; i++) {
      const emb = Float32Array.from(data.subarray(i * dim, (i + 1) * dim));
      let norm = 0;
      for (let k = 0; k < emb.length; k++) norm += emb[k] * emb[k];
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < emb.length; k++) emb[k] /= norm;
      embs.push(emb);
      transfers.push(emb.buffer);
    }
    parentPort.postMessage({ type: 'embedded', paths, embs }, transfers);
  } catch (err) {
    parentPort.postMessage({ type: 'embed-error', paths, error: String((err && err.message) || err) });
  }
});
