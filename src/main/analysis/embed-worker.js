// Worker thread: CLAP audio + text embeddings via transformers.js (ONNX runtime).
// The model (~90 MB, quantized) is downloaded once and cached in userData/models.
// Audio and text share this worker: onnxruntime-node fatals if loaded in two threads.
import { parentPort, workerData } from 'node:worker_threads';

const MODEL_ID = 'Xenova/clap-htsat-unfused';
let audioPromise = null;
let textPromise = null;

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
