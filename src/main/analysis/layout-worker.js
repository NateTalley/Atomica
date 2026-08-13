// Worker thread: 2D layout of the combined feature vectors (UMAP or PCA).
import { parentPort } from 'node:worker_threads';

function pca2(X, n, dim) {
  // matrix-free power iteration on the covariance, 2 components with deflation
  const mu = new Float64Array(dim);
  for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) mu[d] += X[i * dim + d];
  for (let d = 0; d < dim; d++) mu[d] /= n;

  const covMul = (v, ortho) => {
    const w = new Float64Array(dim);
    const mv = mu.reduce((s, m, d) => s + m * v[d], 0);
    let S = 0;
    for (let i = 0; i < n; i++) {
      let s = -mv;
      const base = i * dim;
      for (let d = 0; d < dim; d++) s += X[base + d] * v[d];
      S += s;
      for (let d = 0; d < dim; d++) w[d] += X[base + d] * s;
    }
    for (let d = 0; d < dim; d++) w[d] = (w[d] - mu[d] * S) / n;
    if (ortho) {
      const p = ortho.reduce((s, o, d) => s + o * w[d], 0);
      for (let d = 0; d < dim; d++) w[d] -= ortho[d] * p;
    }
    return w;
  };

  const iterate = (ortho) => {
    let v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) v[d] = Math.sin(d * 12.9898 + (ortho ? 4.1414 : 0)) * 0.5 + 0.1;
    for (let it = 0; it < 60; it++) {
      v = covMul(v, ortho);
      let nrm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      for (let d = 0; d < dim; d++) v[d] /= nrm;
    }
    return v;
  };

  const v1 = iterate(null);
  const v2 = iterate(v1);
  const pos = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let a = 0, b = 0;
    for (let d = 0; d < dim; d++) {
      const c = X[base + d] - mu[d];
      a += c * v1[d];
      b += c * v2[d];
    }
    pos[i * 2] = a;
    pos[i * 2 + 1] = b;
  }
  return pos;
}

function normalizePositions(pos, n) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 2], y = pos[i * 2 + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const ext = Math.max(maxX - minX, maxY - minY, 1e-9) / 2;
  for (let i = 0; i < n; i++) {
    pos[i * 2] = (pos[i * 2] - cx) / ext;
    pos[i * 2 + 1] = (pos[i * 2 + 1] - cy) / ext;
  }
  return pos;
}

parentPort.on('message', async (msg) => {
  const { token, buffer, n, dim, method, params } = msg;
  const X = new Float32Array(buffer);
  let pos = null;

  if (method === 'umap' && n >= 16) {
    try {
      const { UMAP } = await import('umap-js');
      const rows = new Array(n);
      for (let i = 0; i < n; i++) rows[i] = Array.from(X.subarray(i * dim, (i + 1) * dim));
      const umap = new UMAP({
        nComponents: 2,
        nNeighbors: Math.max(2, Math.min(params.nNeighbors || 15, n - 1)),
        minDist: Math.min(Math.max(params.minDist ?? 0.1, 0), 0.99),
        spread: 1.0,
      });
      const nEpochs = umap.initializeFit(rows);
      for (let e = 0; e < nEpochs; e++) {
        umap.step();
        if (e % 25 === 0) parentPort.postMessage({ token, progress: e / nEpochs });
      }
      const emb = umap.getEmbedding();
      pos = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { pos[i * 2] = emb[i][0]; pos[i * 2 + 1] = emb[i][1]; }
    } catch (err) {
      parentPort.postMessage({ token, warning: 'UMAP failed, falling back to PCA: ' + String((err && err.message) || err) });
      pos = null;
    }
  }
  if (!pos) pos = pca2(X, n, dim);

  normalizePositions(pos, n);
  parentPort.postMessage({ token, positions: pos }, [pos.buffer]);
});
