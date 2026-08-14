// WebGL star-map renderer: additive glowing point sprites with pan/zoom,
// picking, and animated layout transitions. No dependencies.
'use strict';

class Starmap {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;
    this.gl = canvas.getContext('webgl', { antialias: false, depth: false, premultipliedAlpha: true });
    if (!this.gl) throw new Error('WebGL unavailable');

    this.n = 0;
    this.posFrom = null;   // Float32Array n*2
    this.posTo = null;
    this.posCur = null;
    this.animStart = 0;
    this.animDur = 900;
    this.colors = null;    // Float32Array n*3
    this.sizes = null;     // Float32Array n
    this.alphas = null;    // Float32Array n

    this.view = { cx: 0, cy: 0, scale: 300 }; // world -> px
    this.baseScale = 300;
    this.hover = -1;
    this.playingIdx = -1;
    this.playingAt = 0;
    this.dirty = true;

    this._initGL();
    this._initDust();
    this._bindEvents();

    const loop = () => { this._frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _initGL() {
    const gl = this.gl;
    const vs = `
      attribute vec2 aPos;
      attribute vec3 aCol;
      attribute float aSize;
      attribute float aAlpha;
      uniform vec2 uCenter;
      uniform float uScale;
      uniform vec2 uViewport;
      uniform float uSizeScale;
      varying vec3 vCol;
      varying float vAlpha;
      void main() {
        vec2 p = (aPos - uCenter) * uScale;
        gl_Position = vec4(2.0 * p.x / uViewport.x, 2.0 * p.y / uViewport.y, 0.0, 1.0);
        gl_PointSize = aSize * uSizeScale;
        vCol = aCol;
        vAlpha = aAlpha;
      }`;
    const fs = `
      precision mediump float;
      varying vec3 vCol;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        if (r > 1.0) discard;
        float glow = exp(-3.5 * r * r) - 0.03;
        float core = smoothstep(0.32, 0.0, r);
        vec3 col = vCol * glow + vec3(1.0) * core * 0.65;
        gl_FragColor = vec4(col * vAlpha, 1.0);
      }`;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aCol: gl.getAttribLocation(prog, 'aCol'),
      aSize: gl.getAttribLocation(prog, 'aSize'),
      aAlpha: gl.getAttribLocation(prog, 'aAlpha'),
      uCenter: gl.getUniformLocation(prog, 'uCenter'),
      uScale: gl.getUniformLocation(prog, 'uScale'),
      uViewport: gl.getUniformLocation(prog, 'uViewport'),
      uSizeScale: gl.getUniformLocation(prog, 'uSizeScale'),
    };
    this.bufPos = gl.createBuffer();
    this.bufCol = gl.createBuffer();
    this.bufSize = gl.createBuffer();
    this.bufAlpha = gl.createBuffer();
    // one-point buffers for hover/playing overlays
    this.bufOne = { pos: gl.createBuffer(), col: gl.createBuffer(), size: gl.createBuffer(), alpha: gl.createBuffer() };
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive: overlapping stars bloom to white
  }

  _initDust() {
    // faint static background starfield in screen space (world coords regenerated on data fit)
    const gl = this.gl;
    const N = 420;
    this.dustN = N;
    const pos = new Float32Array(N * 2);
    const col = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const alpha = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 2] = (Math.random() * 2 - 1) * 4;
      pos[i * 2 + 1] = (Math.random() * 2 - 1) * 4;
      const t = Math.random();
      col[i * 3] = 0.75 + 0.25 * t;
      col[i * 3 + 1] = 0.38 + 0.35 * t;
      col[i * 3 + 2] = 0.12 + 0.12 * t;
      size[i] = 1 + Math.random() * 2;
      alpha[i] = 0.04 + Math.random() * 0.08;
    }
    this.dust = { pos, col, size, alpha };
    this.bufDust = { pos: gl.createBuffer(), col: gl.createBuffer(), size: gl.createBuffer(), alpha: gl.createBuffer() };
    const load = (buf, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); };
    load(this.bufDust.pos, pos);
    load(this.bufDust.col, col);
    load(this.bufDust.size, size);
    load(this.bufDust.alpha, alpha);
  }

  // ------------------------------------------------ data

  setData(n) {
    this.n = n;
    this.posCur = new Float32Array(n * 2);
    this.posFrom = null;
    this.posTo = null;
    this.colors = new Float32Array(n * 3).fill(0.7);
    this.sizes = new Float32Array(n).fill(6);
    this.alphas = new Float32Array(n).fill(1);
    this._upload(this.bufCol, this.colors);
    this._upload(this.bufSize, this.sizes);
    this._upload(this.bufAlpha, this.alphas);
    this._upload(this.bufPos, this.posCur);
    this.dirty = true;
  }

  setPositions(pos, animate = true) {
    if (!this.n) return;
    if (!animate || !this.posTo) {
      this.posCur.set(pos);
      this.posTo = pos.slice();
      this.posFrom = null;
      this._upload(this.bufPos, this.posCur);
      this.fit();
    } else {
      this.posFrom = this.posCur.slice();
      this.posTo = pos.slice();
      this.animStart = performance.now();
    }
    this.dirty = true;
  }

  setStyle(colors, sizes, alphas) {
    if (colors) { this.colors = colors; this._upload(this.bufCol, colors); }
    if (sizes) { this.sizes = sizes; this._upload(this.bufSize, sizes); }
    if (alphas) { this.alphas = alphas; this._upload(this.bufAlpha, alphas); }
    this.dirty = true;
  }

  setHover(idx) {
    if (idx !== this.hover) { this.hover = idx; this.dirty = true; }
  }

  setPlaying(idx) {
    this.playingIdx = idx;
    this.playingAt = performance.now();
    this.dirty = true;
  }

  fit() {
    if (!this.n) return;
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.view.cx = 0;
    this.view.cy = 0;
    this.view.scale = Math.min(w, h) * 0.44;
    this.baseScale = this.view.scale;
    this.dirty = true;
  }

  _upload(buf, data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  // ------------------------------------------------ interaction

  screenToWorld(mx, my) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return {
      x: this.view.cx + (mx - w / 2) / this.view.scale,
      y: this.view.cy - (my - h / 2) / this.view.scale,
    };
  }

  pick(mx, my) {
    if (!this.n || !this.posCur) return -1;
    const pt = this.screenToWorld(mx, my);
    const rWorld = 9 / this.view.scale; // 9 px pick radius
    let best = -1, bestD = rWorld * rWorld;
    for (let i = 0; i < this.n; i++) {
      if (this.alphas[i] < 0.15) continue; // filtered out
      const dx = this.posCur[i * 2] - pt.x;
      const dy = this.posCur[i * 2 + 1] - pt.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  _bindEvents() {
    const c = this.canvas;
    let panning = false;
    let downPos = null;
    let downIdx = -1;
    let dragStarted = false;

    c.addEventListener('mousedown', (e) => {
      if (e.button === 2) return;
      const idx = this.pick(e.offsetX, e.offsetY);
      downPos = { x: e.offsetX, y: e.offsetY };
      downIdx = idx;
      dragStarted = false;
      panning = idx < 0;
    });

    c.addEventListener('mousemove', (e) => {
      if (downPos && downIdx >= 0 && !dragStarted) {
        const d = Math.hypot(e.offsetX - downPos.x, e.offsetY - downPos.y);
        if (d > 6) {
          dragStarted = true;
          if (this.handlers.onDragStart) this.handlers.onDragStart(downIdx);
        }
        return;
      }
      if (panning && downPos) {
        this.view.cx -= (e.offsetX - downPos.x) / this.view.scale;
        this.view.cy += (e.offsetY - downPos.y) / this.view.scale;
        downPos = { x: e.offsetX, y: e.offsetY };
        this.dirty = true;
        return;
      }
      const idx = this.pick(e.offsetX, e.offsetY);
      this.setHover(idx);
      if (this.handlers.onHover) this.handlers.onHover(idx, e.offsetX, e.offsetY);
    });

    window.addEventListener('mouseup', (e) => {
      if (downPos && downIdx >= 0 && !dragStarted) {
        if (this.handlers.onClick) this.handlers.onClick(downIdx);
      }
      downPos = null;
      downIdx = -1;
      panning = false;
      dragStarted = false;
    });

    c.addEventListener('mouseleave', () => {
      this.setHover(-1);
      if (this.handlers.onHover) this.handlers.onHover(-1, 0, 0);
    });

    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = this.pick(e.offsetX, e.offsetY);
      if (idx >= 0 && this.handlers.onRightClick) this.handlers.onRightClick(idx);
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.pow(1.0016, -e.deltaY);
      const before = this.screenToWorld(e.offsetX, e.offsetY);
      this.view.scale = Math.min(Math.max(this.view.scale * factor, this.baseScale * 0.72), this.baseScale * 60);
      const after = this.screenToWorld(e.offsetX, e.offsetY);
      this.view.cx += before.x - after.x;
      this.view.cy += before.y - after.y;
      this.dirty = true;
    }, { passive: false });

    window.addEventListener('resize', () => { this.dirty = true; });
  }

  // ------------------------------------------------ rendering

  _frame() {
    const now = performance.now();
    let animating = false;

    if (this.posFrom && this.posTo) {
      let t = (now - this.animStart) / this.animDur;
      if (t >= 1) {
        this.posCur.set(this.posTo);
        this.posFrom = null;
      } else {
        const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
        for (let i = 0; i < this.n * 2; i++) {
          this.posCur[i] = this.posFrom[i] + (this.posTo[i] - this.posFrom[i]) * e;
        }
        animating = true;
      }
      this._upload(this.bufPos, this.posCur);
      this.dirty = true;
    }

    const playingPulse = this.playingIdx >= 0 && now - this.playingAt < 900;
    if (playingPulse) this.dirty = true;

    if (!this.dirty) return;
    this.dirty = animating || playingPulse;

    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.uViewport, w, h);

    const zoomBoost = Math.pow(this.view.scale / this.baseScale, 0.28);
    const bind = (bufs) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
      gl.enableVertexAttribArray(this.loc.aPos);
      gl.vertexAttribPointer(this.loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.col);
      gl.enableVertexAttribArray(this.loc.aCol);
      gl.vertexAttribPointer(this.loc.aCol, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.size);
      gl.enableVertexAttribArray(this.loc.aSize);
      gl.vertexAttribPointer(this.loc.aSize, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.alpha);
      gl.enableVertexAttribArray(this.loc.aAlpha);
      gl.vertexAttribPointer(this.loc.aAlpha, 1, gl.FLOAT, false, 0, 0);
    };

    // background dust (fixed world coords, slight parallax via halved pan)
    gl.uniform2f(this.loc.uCenter, this.view.cx * 0.5, this.view.cy * 0.5);
    gl.uniform1f(this.loc.uScale, this.baseScale * 0.5);
    gl.uniform1f(this.loc.uSizeScale, dpr);
    bind(this.bufDust);
    gl.drawArrays(gl.POINTS, 0, this.dustN);

    if (!this.n) return;

    gl.uniform2f(this.loc.uCenter, this.view.cx, this.view.cy);
    gl.uniform1f(this.loc.uScale, this.view.scale);
    gl.uniform1f(this.loc.uSizeScale, dpr * zoomBoost);
    bind({ pos: this.bufPos, col: this.bufCol, size: this.bufSize, alpha: this.bufAlpha });
    gl.drawArrays(gl.POINTS, 0, this.n);

    // overlays: hovered point ring + playing pulse
    const overlay = (idx, sizeMul, alpha) => {
      if (idx < 0 || idx >= this.n) return;
      const p = new Float32Array([this.posCur[idx * 2], this.posCur[idx * 2 + 1]]);
      const ccol = new Float32Array([
        Math.min(1, this.colors[idx * 3] + 0.35),
        Math.min(1, this.colors[idx * 3 + 1] + 0.35),
        Math.min(1, this.colors[idx * 3 + 2] + 0.35),
      ]);
      const sz = new Float32Array([this.sizes[idx] * sizeMul]);
      const al = new Float32Array([alpha]);
      this._upload(this.bufOne.pos, p);
      this._upload(this.bufOne.col, ccol);
      this._upload(this.bufOne.size, sz);
      this._upload(this.bufOne.alpha, al);
      bind(this.bufOne);
      gl.drawArrays(gl.POINTS, 0, 1);
    };

    if (this.hover >= 0) overlay(this.hover, 2.1, 0.9);
    if (playingPulse) {
      const t = (now - this.playingAt) / 900;
      overlay(this.playingIdx, 2.2 + t * 4, (1 - t) * 0.8);
    }
  }
}

window.Starmap = Starmap;
