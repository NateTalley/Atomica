# Task 0 audit — how the app analyzes audio today

Audited at commit `d2f8cce` (plus the uncommitted rebrand edits), 2026-10-10.
Nothing in `src/` was changed. The app was not run for this audit: this machine has no Node
install and no `node_modules`, so everything below is read from the source and from the
model files on the Hugging Face Hub.

## 1. CLAP runtime

CLAP runs through **transformers.js** (`@huggingface/transformers` ^3.3.0), which uses
onnxruntime-node underneath. It lives in a dedicated worker thread,
`src/main/analysis/embed-worker.js`, started from `main.js` (`ensureEmbedWorker`). Audio and
text embedding share that one worker because onnxruntime-node cannot be loaded in two threads.
There is no Python sidecar.

Decoding and DSP run in separate worker threads (`analysis-worker.js`, up to 4), which hand
48 kHz audio to the main process, which batches it (8 clips) to the embed worker.

## 2. Model

| | |
|---|---|
| Model id | `Xenova/clap-htsat-unfused` (ONNX export of `laion/clap-htsat-unfused`: HTSAT-tiny, no fusion, 630k-audioset weights) |
| File loaded | `onnx/audio_model_quantized.onnx` (`dtype: 'q8'`, 8-bit quantized) |
| SHA-256 | `3fcff2c8824e7bcb83a983f2a49edab3b60cbcf4872ac70efee517355173bd1f` |
| Output | `audio_embeds`, 512-d projected embedding, L2-normalized in the worker |
| Cache | `<userData>/models` |

**Risk: silent model switch.** If loading the quantized file throws, the worker falls back to
the full-precision model without recording which one it used:

```js
try {
  model = await ClapAudioModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' });
} catch {
  model = await ClapAudioModelWithProjection.from_pretrained(MODEL_ID);
}
```

Embeddings from the two files are close but not identical, and the cache does not store which
model produced an embedding. Heads are trained on the quantized model.

## 3. Preprocessing

All of it is deterministic.

1. **Decode** (`dsp.js` `decodeToMono`): only the first 12 s of the file
   (`MAX_ANALYZE_SEC = 12`). WAV is parsed natively, FLAC through `@wasm-audio-decoders/flac`,
   everything else through `audio-decode`.
2. **Mono**: plain mean of all channels (`mixToMono`).
3. **Resample to 48 kHz** with linear interpolation and no anti-alias filter
   (`resampleLinear`), capped at 480 000 samples:
   ```js
   if (wantAudio48) audio48 = resampleLinear(data, sr, EMBED_SR, EMBED_SR * EMBED_MAX_SEC);
   ```
4. **Feature extraction**: transformers.js `ClapFeatureExtractor` with the model's
   `preprocessor_config.json` (64 mel bands, n_fft 1024, hop 480, 50–14 000 Hz,
   `padding: "repeatpad"`, `truncation: "rand_trunc"`).

Consequences:

- **Audio shorter than 10 s is repeat-padded.** A 400 ms kick is tiled about 25 times before
  embedding. This is the behavior the plan (§1a) wanted to compare against zero-padding.
- **Audio longer than 10 s: only the first 10 s is embedded.** No windowing, no pooling.
  `rand_trunc` never fires because the clip is already capped at exactly 480 000 samples.
  A stem that starts with silence gets an embedding of silence.
- No loudness normalization.

## 4. Current classification

Zero-shot, in `main.js` (`classifyTags`). Each file gets exactly one instrument and one genre.

- Prompts: 18 instruments (`Kick, Snare, Clap, Hi-hat, Cymbal, Tom, Perc, Bass, Synth, Pad,
  Lead, Vocal, FX, Guitar, Keys, Strings, Brass, Atmosphere`) and 18 genres, each a fixed
  sentence such as `"the sound of a kick drum"`.
- Score: dot product of the audio embedding with each text embedding; take the argmax.
- Accept if cosine ≥ 0.11 and the gap to the runner-up ≥ 0.01 (genre: 0.10 / 0.008). Below
  that, a filename/folder regex hint wins; with no hint, the argmax is still used if ≥ 0.08,
  otherwise `Uncategorized`. A genre regex hint always overrides the model.
- User corrections are stored per file as `override: { instrument, genre }` and overlaid when
  the dataset is built, so the detected value is kept.

There is no multi-label output, no hat open/closed split, no 808, no pluck, no woodwind.

## 5. Existing tempo, kind and pitch code (`dsp.js`)

- **Kind** (`detectRhythm`): `oneshot` or `loop` only, from filename words (`loop`, `one shot`,
  an explicit BPM), duration, a sustain ratio and autocorrelation strength. There is no `full`.
- **BPM**: autocorrelation of a time-domain onset envelope (frame RMS of the first difference,
  hop 1024 at the file's own sample rate), parabolic interpolation, then folded into 70–175.
  An explicit `NNN bpm` / `bpm NNN` in the file or folder name wins if it is within tolerance
  of the estimate or an octave of it. BPM is rounded to an integer and dropped for one-shots.
  There is no length-based candidate, no alternative BPM and no ambiguity score.
- **Pitch** (`pitchTrack`): normalized autocorrelation at 11 025 Hz over the first 6 s, 30–1000 Hz,
  median semitone. It feeds the starmap `pitch` feature only; no note name is shown.

Because of the 12 s decode cap, BPM for long loops is estimated from the first 12 s
(`fullDuration` is still the true length).

## 6. Persistence

Two JSON files in `app.getPath('userData')`, no database.

- `settings.json`: folders, `useEmbeddings`, layout params, playlists.
- `cache.json`: `{ version: 2, entries: [...] }`, rewritten in full after each scan. One entry:

```js
{ p,            // absolute path (the identity; there is no content hash)
  mt, sz,       // mtime and size, used to detect changes
  f: { duration, loudness, brightness, noisiness, rolloff, flux, pitch, attack, kind, bpm },
  mfcc: [13],
  emb,          // base64 Float32Array(512) or null
  peaks,        // base64 Uint8Array(128)
  override }    // { instrument?, genre? } or null
```

Instrument and genre tags are not stored; they are recomputed from `emb` on every load.
A moved or renamed file loses its override.

## 7. UI

`src/renderer/app.js`. BPM and tags appear in the list view rows (`.list-kind`, `.list-bpm`,
tag chips; around line 686), in the sidebar filter chips (`filterKind`, instrument, genre),
in search text (`"<n> bpm"`), and as starmap color modes (`kind`, `instrument`, `genre`).
List edit mode has dropdowns for kind, instrument and genre.

## 8. Tests and build

None. `package.json` has only `start` and `smoke` (`electron . --smoke`). No test runner,
linter, bundler or CI.

## Can the app emit a raw embedding from a script?

No. Smallest way to add it: a `scripts/embed-cli.js` that imports `analyzeFile` from `dsp.js`
and runs the same `AutoProcessor` + `ClapAudioModelWithProjection` calls as the embed worker,
printing one JSON line per file. It needs no Electron, only Node and `npm ci`.

## What this means for the training plan

- Part 1 of the plan assumes the `laion_clap` PyTorch checkpoint. That would not match the app.
  `training/embed.py` instead runs the **same quantized ONNX file** with onnxruntime and
  reimplements the decode, mono, linear-resample and repeat-pad steps above.
- **The parity check has not been run**, because Node is not installed here. Until it is, the
  Python and JS preprocessing are only matched by construction. The realistic sources of drift
  are MP3 decoding (libsndfile vs mpg123) and the two mel implementations.
- Decisions that need sign-off before any app change: zero-pad vs repeat-pad for one-shots,
  windowing long files instead of using the first 10 s, pinning the quantized model (or
  recording which model produced each cached embedding), and adding a content hash.
