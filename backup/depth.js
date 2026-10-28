// depth.js
// The depth tracker. A few times a second a depth model (Depth Anything V2 Small) guesses how
// near each part of the camera view is. That guess only says what is nearer than what, so the
// AR engine's tracked points (spots in the room it has measured) turn it into distances in the
// scene's own units. Two uses:
// - app.js asks it how far away the spot is that a visitor taps on, so a tapped scene stands at
//   that distance;
// - things clearly in front of the sculpture (the big pillars beside you, the railing) hide it,
//   with a mask drawn before the scene like occlusion.js's people mask. People are found by
//   occlusion.js; this is for everything else.
// It only hides when it's sure: when the guess and the tracked points agree well, and where a
// spot reads as in front in two guesses running. Until the model has loaded and enough tracked
// points are in view, it hides nothing.

import * as THREE from 'three';

const MODEL_URL = new URL('../model/depth.onnx', import.meta.url).href;
const ORT_URL = new URL('../lib/onnxruntime/ort.webgpu.min.mjs', import.meta.url).href;
const ORT_DIR = new URL('../lib/onnxruntime/', import.meta.url).href;
const SIZE = 308;              // the model looks at a square this many pixels across
const SQUARE = 1.4;            // ...cut from the view round the sculpture, this many screen widths across
const INTERVAL = 150;          // ms between depth guesses, at most
const MIN_POINTS = 12;         // tracked points needed in the square to scale a guess
const NEARER = 0.6;            // a real thing hides the sculpture only when it is at most 60% as far away:
                               // clearly in front, like someone near you or the big pillars beside you.
                               // The inner pillars and the ceiling the light falls on, about as far as
                               // the sculpture, never do (the guess isn't sharp enough to split them)
const STALE = 1500;            // ms a guess is kept when the next one can't be scaled
const AGREE = 0.5;             // share of the tracked points that must agree with the guess for it to hide
const FAR = 1e4;               // the deepest distance kept (scene units)
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// The square on screen, just inside the near plane, so its depth beats everything.
const OCCLUDER_VS = `
uniform vec4 rect;   // the square on screen: centre x, y and half width, half height (-1..1)
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(rect.xy + position.xy * rect.zw, -0.9999, 1.0);
}`;

const OCCLUDER_FS = `
uniform sampler2D mask;   // 1 where something real stands clearly in front of the sculpture, softened
varying vec2 vUv;
void main() {
  if (texture2D(mask, vec2(vUv.x, 1.0 - vUv.y)).r <= 0.5) discard;
  gl_FragColor = vec4(1.0, 0.25, 0.1, 1.0);  // only seen with ?debug
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// d = a / z + b, fitted to [1/z, d] pairs; RANSAC over pairs, then least squares on the inliers.
// null when the points don't agree well enough to trust.
export function fitDepthScale(pairs, tolerance) {
  const n = pairs.length;
  if (n < MIN_POINTS) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [iz] of pairs) { lo = Math.min(lo, iz); hi = Math.max(hi, iz); }
  if (hi - lo <= 0) return null;
  let best = null;
  for (let k = 0; k < 200; k++) {
    const [z1, d1] = pairs[(Math.random() * n) | 0];
    const [z2, d2] = pairs[(Math.random() * n) | 0];
    if (Math.abs(z1 - z2) < 0.1 * (hi - lo)) continue;
    const a = (d1 - d2) / (z1 - z2);
    if (!(a > 0)) continue;
    const b = d1 - a * z1;
    let count = 0;
    for (const [iz, d] of pairs) if (Math.abs(d - (a * iz + b)) < tolerance) count++;
    if (!best || count > best.count) best = { a, b, count };
  }
  if (!best || best.count < Math.max(MIN_POINTS * 0.75, 0.4 * n)) return null;
  // least squares on the inliers
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (const [iz, d] of pairs) {
    if (Math.abs(d - (best.a * iz + best.b)) >= tolerance) continue;
    sx += iz; sy += d; sxx += iz * iz; sxy += iz * d; m++;
  }
  const den = m * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return { a: best.a, b: best.b, inliers: best.count, points: n };
  const a = (m * sxy - sx * sy) / den;
  const b = (sy - a * sx) / m;
  return a > 0 ? { a, b, inliers: m, points: n } : null;
}

export function createDepth({ debug = false } = {}) {
  let session = null;
  let loading = null;
  let running = false;
  let video = null;
  let points = [];
  let scene = null;
  let camera = null;
  let canvas = null;
  let focus = null;

  // the latest guess: distances on the model's square, where the square is on screen, and the mask
  // drawn from them (blurred, then cut at a half, which rounds its edges instead of leaving blocks)
  const zmap = new Float32Array(SIZE * SIZE);
  const hard = new Float32Array(SIZE * SIZE);
  const before = new Float32Array(SIZE * SIZE);   // the previous guess's mask, before blurring
  let beforeAt = -Infinity;
  const beforeSquare = { x0: 0, y0: 0, side: 1 };   // and where its square was on screen
  const soft = new Float32Array(SIZE * SIZE);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const texture = new THREE.DataTexture(pixels, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const square = { x0: 0, y0: 0, side: 1, cw: 1, ch: 1 };
  let shownAt = 0;
  let mapAt = -Infinity;

  const material = new THREE.ShaderMaterial({
    vertexShader: OCCLUDER_VS,
    fragmentShader: OCCLUDER_FS,
    uniforms: {
      rect: { value: new THREE.Vector4() },
      mask: { value: texture },
    },
    // Depth only. Depth writes need the depth test enabled, hence ALWAYS instead of off.
    colorWrite: debug,
    depthWrite: true,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e6;   // before everything it hides
  mesh.visible = false;

  const input = document.createElement('canvas');
  input.width = input.height = SIZE;
  const ctx = input.getContext('2d', { willReadFrequently: true });
  const tensorData = new Float32Array(3 * SIZE * SIZE);
  const status = { backend: null, ms: 0, points: 0, inliers: 0, error: null };
  window.__depth = status;

  async function load() {
    try {
      const ort = await import(ORT_URL);
      ort.env.wasm.numThreads = 1;      // threads need cross-origin isolation, which GitHub Pages can't give
      ort.env.wasm.wasmPaths = ORT_DIR;
      for (const ep of navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']) {
        try {
          session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: [ep] });
          status.backend = ep;
          session.ort = ort;
          break;
        } catch (e) {
          console.warn(`depth model on ${ep} failed:`, e);
        }
      }
    } catch (e) {
      status.error = String(e.message || e);
      console.warn('depth model not loaded; nothing will be hidden:', e);
    }
  }

  // The square of the view the model looks at, in canvas pixels: centred on the sculpture, or on
  // the middle of the screen before it's placed (where a visitor taps to place it).
  function placeSquare(target) {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const p = target ? target.clone().project(camera) : new THREE.Vector3();
    if (p.z > 1 || Math.abs(p.x) > 1.6 || Math.abs(p.y) > 1.6) return null;   // well off screen
    const side = Math.min(ch, cw * SQUARE);
    let cx = (p.x * 0.5 + 0.5) * cw;
    let cy = (0.5 - p.y * 0.5) * ch;
    cx = side >= cw ? cw / 2 : THREE.MathUtils.clamp(cx, side / 2, cw - side / 2);
    cy = THREE.MathUtils.clamp(cy, side / 2, ch - side / 2);
    return { x0: cx - side / 2, y0: cy - side / 2, side, cw, ch };
  }

  // The camera picture fills the canvas, centre-cropped; take the square's part of it.
  function grab(sq) {
    const vw = video.videoWidth || video.width;
    const vh = video.videoHeight || video.height;
    const s = Math.max(sq.cw / vw, sq.ch / vh);
    const ox = (sq.cw - vw * s) / 2;
    const oy = (sq.ch - vh * s) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(video, (sq.x0 - ox) / s, (sq.y0 - oy) / s, sq.side / s, sq.side / s, 0, 0, SIZE, SIZE);
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const plane = SIZE * SIZE;
    for (let i = 0; i < plane; i++) {
      for (let k = 0; k < 3; k++) tensorData[k * plane + i] = (px[i * 4 + k] / 255 - MEAN[k]) / STD[k];
    }
  }

  function sample(d, u, v) {
    const x = THREE.MathUtils.clamp(u, 0, SIZE - 1.001);
    const y = THREE.MathUtils.clamp(v, 0, SIZE - 1.001);
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const i = y0 * SIZE + x0;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + SIZE] * (1 - fx) + d[i + SIZE + 1] * fx) * fy;
  }

  // box blur, 2 pixels each way, of src into dst
  function blur(src, dst) {
    const R = 2;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let sum = 0, n = 0;
        for (let k = Math.max(0, x - R); k <= Math.min(SIZE - 1, x + R); k++) { sum += src[y * SIZE + k]; n++; }
        dst[y * SIZE + x] = sum / n;
      }
    }
    const col = new Float32Array(SIZE);
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) col[y] = dst[y * SIZE + x];
      for (let y = 0; y < SIZE; y++) {
        let sum = 0, n = 0;
        for (let k = Math.max(0, y - R); k <= Math.min(SIZE - 1, y + R); k++) { sum += col[k]; n++; }
        dst[y * SIZE + x] = sum / n;
      }
    }
  }

  async function step() {
    if (!session || !video || (video.readyState !== undefined && video.readyState < 2)) return;
    const target = focus && focus();
    const sq = placeSquare(target);
    if (!sq) { if (performance.now() - shownAt > STALE) mesh.visible = false; return; }
    // tracked points in the square, as [u, v, 1/distance]; too few and the guess can't be scaled,
    // so the model isn't run at all
    camera.updateMatrixWorld();
    const seen = [];
    const p = new THREE.Vector3();
    for (const w of points) {
      p.set(w.position.x, w.position.y, w.position.z).applyMatrix4(camera.matrixWorldInverse);
      const z = -p.z;
      if (!(z > 0.05)) continue;
      p.applyMatrix4(camera.projectionMatrix);
      const u = (((p.x * 0.5 + 0.5) * sq.cw - sq.x0) / sq.side) * SIZE;
      const v = (((0.5 - p.y * 0.5) * sq.ch - sq.y0) / sq.side) * SIZE;
      if (u >= 0 && v >= 0 && u <= SIZE - 1 && v <= SIZE - 1) seen.push([u, v, 1 / z]);
    }
    status.points = seen.length;
    if (seen.length < MIN_POINTS) { if (performance.now() - shownAt > STALE) mesh.visible = false; return; }
    grab(sq);

    const t0 = performance.now();
    const { ort } = session;
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensorData, [1, 3, SIZE, SIZE]) });
    const d = out[session.outputNames[0]].data;
    status.ms = Math.round(performance.now() - t0);

    // [1/distance, the model's guess there] for each tracked point
    const pairs = seen.map(([u, v, iz]) => [iz, sample(d, u, v)]);
    let dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < d.length; i += 7) { dmin = Math.min(dmin, d[i]); dmax = Math.max(dmax, d[i]); }
    const fit = fitDepthScale(pairs, 0.06 * (dmax - dmin));
    status.inliers = fit ? fit.inliers : 0;
    if (!fit) { if (performance.now() - shownAt > STALE) mesh.visible = false; return; }
    const sure = fit.inliers >= AGREE * pairs.length;   // too many disagreeing points: measure, but don't hide

    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = d[i] - fit.b;
      zmap[i] = g > 1e-6 ? Math.min(fit.a / g, FAR) : FAR;   // unknown counts as far: it hides nothing
    }
    Object.assign(square, sq);
    mapAt = performance.now();
    if (!target) { mesh.visible = false; return; }   // nothing placed yet: the distances are only for taps

    if (!sure) { if (performance.now() - shownAt > STALE) mesh.visible = false; return; }

    // the mask: 1 where something stands at most NEARER times as far away as the sculpture, in this
    // guess and at the same spot on screen in the one before, so a flicker of the guess hides nothing.
    // (Where the previous guess didn't reach, or is too old, this one decides alone.)
    const limit = NEARER * -target.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const recent = performance.now() - beforeAt < STALE;
    const k = sq.side / beforeSquare.side;
    const dx = ((sq.x0 - beforeSquare.x0) / beforeSquare.side) * SIZE;
    const dy = ((sq.y0 - beforeSquare.y0) / beforeSquare.side) * SIZE;
    const now = soft;   // borrowed until the blur below
    for (let i = 0; i < SIZE * SIZE; i++) now[i] = zmap[i] < limit ? 1 : 0;
    for (let v = 0; v < SIZE; v++) {
      for (let u = 0; u < SIZE; u++) {
        const pu = Math.round(dx + (u + 0.5) * k - 0.5);
        const pv = Math.round(dy + (v + 0.5) * k - 0.5);
        const inside = recent && pu >= 0 && pv >= 0 && pu < SIZE && pv < SIZE;
        hard[v * SIZE + u] = now[v * SIZE + u] * (inside ? before[pv * SIZE + pu] : 1);
      }
    }
    before.set(now);
    beforeAt = performance.now();
    Object.assign(beforeSquare, { x0: sq.x0, y0: sq.y0, side: sq.side });
    blur(hard, soft);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const m = Math.round(soft[i] * 255);
      pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = m;
      pixels[i * 4 + 3] = 255;
    }
    texture.needsUpdate = true;
    material.uniforms.rect.value.set(
      ((sq.x0 + sq.side / 2) / sq.cw) * 2 - 1, 1 - ((sq.y0 + sq.side / 2) / sq.ch) * 2,
      sq.side / sq.cw, sq.side / sq.ch,
    );
    mesh.visible = true;
    shownAt = performance.now();
  }

  let generation = 0;   // a stop and a quick start again mustn't leave two loops running
  async function loop(gen) {
    while (running && gen === generation) {
      const t0 = performance.now();
      try {
        await step();
      } catch (e) {
        status.error = String(e.message || e);
        console.warn('depth:', e);
      }
      await sleep(Math.max(30, INTERVAL - (performance.now() - t0)));
    }
  }

  const _p = new THREE.Vector3();
  return {
    // add after XR8.XrController's module: it keeps the camera picture and the tracked points
    pipelineModule() {
      return {
        name: 'depth',
        onCameraStatusChange: ({ status: s, video: v }) => { if (s === 'hasVideo' && v) video = v; },
        onUpdate: ({ processCpuResult }) => {
          const r = processCpuResult && processCpuResult.reality;
          if (r && r.worldPoints) points = r.worldPoints;
        },
      };
    },

    // start guessing: the scene and camera to draw into, the canvas shown, and a function giving
    // the sculpture's position in the world (null while it isn't placed)
    start(opts) {
      ({ scene, camera, canvas, focus } = opts);
      if (!mesh.parent) scene.add(mesh);
      if (!loading) loading = load();
      if (!running) {
        running = true;
        const gen = ++generation;
        loading.then(() => loop(gen));
      }
    },

    stop() {
      running = false;
      mesh.visible = false;
      points = [];
    },

    // how far away the real thing under a point of the screen is (scene units), from the latest
    // guess; null when there's no recent guess there
    depthAt(clientX, clientY) {
      if (!canvas || performance.now() - mapAt > STALE) return null;
      const r = canvas.getBoundingClientRect();
      const u = Math.round(((clientX - r.left - square.x0) / square.side) * SIZE);
      const v = Math.round(((clientY - r.top - square.y0) / square.side) * SIZE);
      if (u < 2 || v < 2 || u > SIZE - 3 || v > SIZE - 3) return null;
      const near = [];   // the middle of a small patch round the tap: what was tapped, not an edge beside it
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) near.push(zmap[(v + dy) * SIZE + u + dx]);
      near.sort((a, b) => a - b);
      const z = near[near.length >> 1];
      return z < FAR ? z : null;
    },

    // whether a real thing stands in front of this point (world space)
    hides(world) {
      if (!mesh.visible || !camera) return false;
      _p.copy(world).applyMatrix4(camera.matrixWorldInverse);
      const z = -_p.z;
      if (!(z > 0)) return false;
      _p.applyMatrix4(camera.projectionMatrix);
      const u = (((_p.x * 0.5 + 0.5) * square.cw - square.x0) / square.side) * SIZE;
      const v = (((0.5 - _p.y * 0.5) * square.ch - square.y0) / square.side) * SIZE;
      if (u < 0 || v < 0 || u > SIZE - 1 || v > SIZE - 1) return false;
      return zmap[(v | 0) * SIZE + (u | 0)] / NEARER < z;
    },
  };
}
