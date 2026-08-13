# Atomica

A star-map sample browser. Point it at your sample folders, and it charts every
sample as a star on a 2D map where nearby stars sound alike — then lets you
change what "alike" means.

No license server, no account, no phone-home. Your library never leaves the machine.

## Running it

```bash
npm install
```

```bash
npm start
```

First launch: click **+ Add folder**, pick your sample directories, and let it
analyze. Analysis is cached, so subsequent launches are instant and a rescan only
touches files that are new or changed.

## Using the map

| Action | Result |
| --- | --- |
| Click a star | Auditions the sample |
| Drag a star out | Drops the actual file into your DAW |
| Right-click a star | Shows the file in Explorer |
| Wheel | Zoom |
| Drag empty space | Pan |
| Esc | Stop playback |

## The two mapping modes

**Similarity** is the Cosmos-style view: a dimensionality reduction over every
sample's feature vector, so acoustically similar samples land near each other.
Unlike Cosmos, the inputs are yours to change:

- **Method** — UMAP produces tight, well-separated clusters. PCA is linear,
  instant, and reproducible; good for very large libraries or when you want the
  axes to stay stable as the library grows.
- **Neighbors** — low values emphasize fine local structure (many small islands),
  high values emphasize the library's overall shape.
- **Min distance** — how tightly points may pack within a cluster.
- **Feature weights** — the important one. Every feature's contribution to
  "similar" is a slider. Zero out *AI timbre* and raise *Pitch* to get a map
  organized by note. Raise *Attack* and *Duration* to separate one-shots from
  sustained material. Weights are the total standard-deviation mass each feature
  group contributes, so they're directly comparable across groups.

Changes to weights or method need **Recompute map** (the layout runs in a
background thread; the map animates from the old positions to the new ones).

**Axes** puts a feature you choose on each axis — brightness against duration,
pitch against noisiness, and so on. This mode is instant and needs no recompute,
and it's the one to use when you want to *find* something rather than browse.

Display is independent of layout: color and size can be driven by any feature
(or by folder), and the search box dims everything that doesn't match.

## What gets measured

Per sample, in worker threads:

- **DSP features** — duration, loudness, spectral centroid (brightness), spectral
  rolloff, spectral flatness (noisiness), spectral flux (movement), attack time,
  and 13 MFCCs for timbre. Pitch comes from a normalized autocorrelation tracker
  with subharmonic rejection and parabolic peak interpolation; unpitched material
  correctly reports no pitch.
- **CLAP embedding** (optional) — a 512-dimensional neural audio embedding that
  captures perceptual similarity in a way hand-written features can't. The model
  (~90 MB, quantized ONNX) downloads once on first analysis and is cached.

Turn the CLAP checkbox off for a purely deterministic map built only from
features you can name — everything still works, just with less "sounds like"
intelligence.

## Performance

Roughly 80 ms per sample end to end with embeddings on (analysis parallelized
across cores, embeddings batched 8 at a time through one inference worker). A
20,000-sample library takes about half an hour once, then never again.

## Formats

WAV is decoded by a native parser covering the encodings that actually show up in
sample libraries, not just the two that most JS WAV readers handle:

| Tag | Format | Notes |
| --- | --- | --- |
| `0x0001` | PCM 8/16/24/32-bit | |
| `0x0003` | IEEE float 32/64-bit | |
| `0x0006` / `0x0007` | A-law / mu-law | |
| `0x0002` | Microsoft ADPCM | 4-bit, block-based |
| `0x0011` | IMA/DVI ADPCM | 4-bit, block-based |
| `0x0050` / `0x0055` | MPEG / MP3 in a WAV container | payload handed to the MP3 decoder |
| `0xFFFE` | WAVE_FORMAT_EXTENSIBLE | real format read from the SubFormat GUID |

RF64, missing or bogus `data` chunk sizes, odd-sized chunks, and metadata chunks
(`LIST`, `smpl`, `cue `, `JUNK`) before or after the audio are all tolerated.
MP3, FLAC, OGG, and Opus files go through the general decoder. Only the first 12
seconds of any file are analyzed.

Auditioning uses the browser's audio decoder where it can, and falls back to
decoding in the main process for the formats Chromium refuses — in practice the
ADPCM variants, which play back as mono.

Run `SMOKE_AUDIO=1` with the smoke target to check every sample in the configured
folders both analyzes and plays:

```bash
npm run smoke
```

## Where things live

```
src/main/
  main.js                  app lifecycle, scanning, caching, IPC, drag-out
  preload.cjs              context-isolated IPC bridge
  analysis/
    dsp.js                 decoding + feature extraction
    analysis-worker.js     per-file analysis (pool sized to CPU count)
    embed-worker.js        CLAP embeddings (single worker, batched)
    layout-worker.js       UMAP / PCA projection to 2D
src/renderer/
  index.html, style.css
  starmap.js               WebGL point renderer, picking, pan/zoom, transitions
  app.js                   UI wiring, styling, audition, axes layout
```

Settings and the analysis cache live in Electron's userData directory
(`%APPDATA%/atomica` on Windows). Deleting `cache.json` forces a full reanalysis.

## Notes

`embed-worker.js` must stay a single worker — `onnxruntime-node`'s native addon
crashes the process if loaded into more than one worker thread. Throughput comes
from batching, not from a pool.
