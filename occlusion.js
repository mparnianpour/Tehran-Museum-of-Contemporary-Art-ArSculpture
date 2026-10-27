// occlusion.js
// Real things in front of the sculpture hide it: people, pillars, the railing. A few times a
// second a depth model (Depth Anything V2 Small) guesses how near each part of the camera view
// is. That guess only says what is nearer than what, so the AR engine's tracked points (spots
// in the room it has measured) turn it into distances in the scene's own units. A pass drawn
// before everything else writes those distances into the depth buffer, so whatever is nearer
// than the sculpture, its light or its dust is drawn over them.
// Until the model has loaded and enough tracked points are in view, nothing is hidden.

import * as THREE from 'three';

const MODEL_URL = new URL('model/depth.onnx', import.meta.url).href;
const ORT_URL = new URL('lib/onnxruntime/ort.webgpu.min.mjs', import.meta.url).href;
const ORT_DIR = new URL('lib/onnxruntime/', import.meta.url).href;
const SIZE = 308;              // the model looks at a square this many pixels across
const SQUARE = 1.4;            // ...cut from the view round the sculpture, this many screen widths across
const INTERVAL = 150;          // ms between depth guesses, at most
const MIN_POINTS = 12;         // tracked points needed in the square to scale a guess
const NEARER = 0.6;            // a real thing hides the sculpture only when it is at most 60% as far away:
                               // clearly in front, like someone near you or the big pillars beside you.
                               // The inner pillars and the ceiling the light falls on, about as far as
                               // the sculpture, never do (the guess isn't sharp enough to split them)
const STALE = 1500;            // ms a guess is kept when the next one can't be scaled
const FAR = 1e4;               // the deepest distance kept (scene units)
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const OCCLUDER_VS = `
uniform vec4 rect;   // the square on screen: centre x, y and half width, half height (-1..1)
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(rect.xy + position.xy * rect.zw, 0.0, 1.0);
}`;

const OCCLUDER_FS = `
uniform sampler2D depthMap;   // distance, 24-bit in rgb (of FAR); a = 0 where unknown
uniform float far;
uniform float nearer;
uniform vec2 proj;            // the camera's projection matrix, elements 10 and 14
uniform float focusDepth;     // how far away the sculpture is
uniform float show;           // ?debug: tint what would hide the sculpture
varying vec2 vUv;
void main() {
  vec4 t = texture2D(depthMap, vec2(vUv.x, 1.0 - vUv.y));
  float z = far * dot(floor(t.rgb * 255.0 + 0.5), vec3(65536.0, 256.0, 1.0)) / 16777215.0;
  float depth = 1.0;
  // written as if NEARER times further away, so only things clearly in front win the depth test
  if (t.a > 0.5 && z > 0.0) depth = clamp((-proj.x + proj.y / (z / nearer)) * 0.5 + 0.5, 0.0, 1.0);
  gl_FragDepthEXT = depth;
  float hides = t.a > 0.5 && z / nearer < focusDepth ? 1.0 : 0.0;
  gl_FragColor = vec4(vec3(1.0, 0.25, 0.1) * hides * show, 1.0);
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

export function createOcclusion({ debug = false } = {}) {
  let session = null;
  let loading = null;
  let running = false;
  let video = null;
  let points = [];
  let scene = null;
  let camera = null;
  let canvas = null;
  let focus = null;

  // the guess currently drawn: distances on the model's square, and where the square is on screen
  const zmap = new Float32Array(SIZE * SIZE);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const texture = new THREE.DataTexture(pixels, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  const square = { x0: 0, y0: 0, side: 1, cw: 1, ch: 1 };
  let shownAt = 0;

  const material = new THREE.ShaderMaterial({
    vertexShader: OCCLUDER_VS,
    fragmentShader: OCCLUDER_FS,
    uniforms: {
      rect: { value: new THREE.Vector4() },
      depthMap: { value: texture },
      far: { value: FAR },
      nearer: { value: NEARER },
      focusDepth: { value: 0 },
      proj: { value: new THREE.Vector2() },
      show: { value: debug ? 0.6 : 0 },
    },
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
    colorWrite: debug,
    blending: THREE.AdditiveBlending,
  });
  material.extensions.fragDepth = true;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;   // before everything it hides
  mesh.visible = false;
  mesh.onBeforeRender = (r, s, cam) => {
    material.uniforms.proj.value.set(cam.projectionMatrix.elements[10], cam.projectionMatrix.elements[14]);
  };

  const input = document.createElement('canvas');
  input.width = input.height = SIZE;
  const ctx = input.getContext('2d', { willReadFrequently: true });
  const tensorData = new Float32Array(3 * SIZE * SIZE);
  const status = { backend: null, ms: 0, points: 0, inliers: 0, error: null };
  window.__occlusion = status;

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

  // The square of the view the model looks at, centred on the sculpture, in canvas pixels.
  function placeSquare(target) {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const p = target.clone().project(camera);
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

  async function step() {
    if (!session || !video || (video.readyState !== undefined && video.readyState < 2)) return;
    const target = focus && focus();
    const sq = target && placeSquare(target);
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

    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = d[i] - fit.b;
      const z = g > 1e-6 ? Math.min(fit.a / g, FAR) : FAR;
      zmap[i] = z;
      const q = Math.round((z / FAR) * 16777215);
      pixels[i * 4] = (q >> 16) & 255;
      pixels[i * 4 + 1] = (q >> 8) & 255;
      pixels[i * 4 + 2] = q & 255;
      pixels[i * 4 + 3] = z < FAR ? 255 : 0;
    }
    texture.needsUpdate = true;
    Object.assign(square, sq);
    material.uniforms.focusDepth.value = -target.clone().applyMatrix4(camera.matrixWorldInverse).z;
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
        console.warn('occlusion:', e);
      }
      await sleep(Math.max(30, INTERVAL - (performance.now() - t0)));
    }
  }

  const _p = new THREE.Vector3();
  return {
    // add after XR8.XrController's module: it keeps the camera picture and the tracked points
    pipelineModule() {
      return {
        name: 'occlusion',
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
