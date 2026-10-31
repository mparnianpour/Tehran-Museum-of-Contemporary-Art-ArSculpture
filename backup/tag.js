// tag.js
// The position tag: a printed AprilTag (family 36h11, ID 0; marker/simorgh-tag-a4.pdf) fixed in
// the atrium. Every phone that sees it finds where the tag is, and from that the same place for
// the Simorgh, wherever the phone stands: app.js keeps the scene's place relative to the tag
// (measured once with ?setup), not to the photograph or to whoever tapped.
//
// - The camera picture is searched for the tag several times a second, in tag-worker.js
//   (js-aruco2, in lib/js-aruco2).
// - Its four corners give where it is from the phone, in metres: the black square is TAG_SIZE wide.
// - The tag doesn't move, so all its sightings, each with where the phone was (the AR engine
//   tracks that), are fitted together: one sighting of a small square alone wobbles.
// - The tag must hang upright, on a wall or pillar: which way is up comes from the phone, which
//   knows it far better than a small square seen from afar; only the way the tag faces, and where
//   it is, come from the tag.
// - The AR engine's world isn't exactly in metres. How many of its units make a metre is found
//   from how the phone moves while it sees the tag. Until the phone has moved a little it is taken
//   as one, which shows only once the phone moves: from where it stands the scene looks right.

import * as THREE from 'three';

export const TAG_ID = 0;
export const TAG_SIZE = 0.16;      // the printed black square's side, metres
const WORKER_URL = new URL('tag-worker.js', import.meta.url);
const MAX_SIDE = 960;              // the camera picture is searched at most this many pixels across
const INTERVAL = 120;              // ms between searches...
const SETTLED_INTERVAL = 500;      // ...and once the tag's place is well known
const SETTLED = 40;                // sightings for that
const KEEP = 120;                  // sightings averaged, the latest...
const KEEP_MS = 45000;             // ...from at most this long ago (the world drifts slowly)
const MAX_TURN = 0.8;              // rad/s: no search while the phone turns faster (blur, lag)
const JUMP = 0.01;                 // new sightings missing the fit by this much (about 8 pixels)...
const JUMPS = 4;                   // ...this many times running: the world was reset, start again

// ---------------------------------------------------------------------------
// The tag's pose from the phone, from its corners
// ---------------------------------------------------------------------------

// Solves A x = b (n×n), or null if it can't.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// corners: the tag's corners as seen, top left, top right, bottom right, bottom left, each as
// [u, v] = [x / -z, y / -z] in three.js camera space (x right, y up, looking down -z).
// Returns the tag in camera space, from this one view: its rotation (x along its top edge, y up
// it, z out of its face) and centre (metres), or null.
export function poseFromCorners(corners, size = TAG_SIZE) {
  const h = size / 2;
  const model = [[-h, h], [h, h], [h, -h], [-h, -h]];
  // the homography from the tag's face to the view
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = model[i];
    const [u, v] = corners[i];
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
  }
  const H = solve(A, b);
  if (!H) return null;
  // (u, v, 1) ∝ (x, y, -z), so its columns, the last row negated, are the rotation's first two
  // columns and the centre, all times one unknown factor
  const c1 = new THREE.Vector3(H[0], H[3], -H[6]);
  const c2 = new THREE.Vector3(H[1], H[4], -H[7]);
  const c3 = new THREE.Vector3(H[2], H[5], -1);
  let k = 2 / (c1.length() + c2.length());
  if (c3.z * k > 0) k = -k;   // the tag is in front of the camera
  c1.multiplyScalar(k);
  c2.multiplyScalar(k);
  const centre = c3.multiplyScalar(k);
  // the nearest true rotation: the two columns squared up evenly
  c1.normalize();
  c2.normalize();
  const sum = c1.clone().add(c2).normalize();
  const diff = c1.clone().sub(c2).normalize();
  const x = sum.clone().add(diff).normalize();
  const y = sum.clone().sub(diff).normalize();
  const z = x.clone().cross(y);
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return { rotation, centre };
}

// ---------------------------------------------------------------------------
// Sightings -> the tag's place in the world
// ---------------------------------------------------------------------------
// The tag hangs upright, so its pose in the world is: where it is (p), which way its face points
// round the vertical (heading), and how the print is turned on the wall (roll). With the world
// units in a metre (scale), that's six numbers, found together so that the tag they describe,
// seen from where the phone was each time, has its corners where they were seen: all sightings
// at once, each from its own place, which pins the facing down far better than any one of them.

const PRIOR = 0.0125;      // how strongly the scale is held at one unit a metre while nothing says otherwise
const HUBER = 0.002;       // corners further off than this (about 1.5 pixels) count for less: a bad sighting can't drag the rest
const ITERATIONS = 12;

// The model's corners (tag face, metres): top left, top right, bottom right, bottom left.
const H = TAG_SIZE / 2;
const MODEL = [[-H, H], [H, H], [H, -H], [-H, -H]];

// Each sighting: c = where the camera was (world), m = its rotation as a 3×3 world -> camera
// (row-major), uv = the corners seen, as in poseFromCorners. Fills out with the corners' misses.
// params: [heading, roll, px, py, pz, log scale]
function misses(params, sightings, out) {
  const [heading, roll, px, py, pz, logScale] = params;
  const scale = Math.exp(logScale);
  const ch = Math.cos(heading), sh = Math.sin(heading), cr = Math.cos(roll), sr = Math.sin(roll);
  let k = 0;
  for (const s of sightings) {
    const m = s.m;
    for (let j = 0; j < 4; j++) {
      const [mx, my] = MODEL[j];
      // the corner in the world: turned on the wall, then round the vertical, scaled, moved
      const vx = mx * cr - my * sr;
      const vy = mx * sr + my * cr;
      const wx = px + scale * vx * ch - s.c[0];
      const wy = py + scale * vy - s.c[1];
      const wz = pz - scale * vx * sh - s.c[2];
      const x = m[0] * wx + m[1] * wy + m[2] * wz;
      const y = m[3] * wx + m[4] * wy + m[5] * wz;
      const z = m[6] * wx + m[7] * wy + m[8] * wz;
      if (z > -1e-3) { out[k++] = 1; out[k++] = 1; continue; }   // behind the camera: far off
      out[k++] = x / -z - s.uv[j][0];
      out[k++] = y / -z - s.uv[j][1];
    }
  }
  out[k] = PRIOR * logScale;
  return out;
}

function costOf(r, weights) {
  let cost = 0;
  for (let i = 0; i < r.length; i++) cost += weights[i] * r[i] * r[i];
  return cost;
}

// Levenberg-Marquardt from a start, with corners far off counting less (Huber).
function refine(sightings, start) {
  const n = sightings.length * 8 + 1;
  let params = start.slice();
  let r = misses(params, sightings, new Float64Array(n));
  const weights = new Float64Array(n).fill(1);
  const reweigh = () => {
    for (let i = 0; i < n - 1; i++) weights[i] = Math.abs(r[i]) <= HUBER ? 1 : HUBER / Math.abs(r[i]);
  };
  reweigh();
  let cost = costOf(r, weights);
  let damping = 1e-3;
  const J = Array.from({ length: 6 }, () => new Float64Array(n));
  const trial = new Float64Array(n);
  const STEP = [1e-5, 1e-5, 1e-5, 1e-5, 1e-5, 1e-5];
  for (let it = 0; it < ITERATIONS; it++) {
    for (let a = 0; a < 6; a++) {
      const p = params.slice();
      p[a] += STEP[a];
      misses(p, sightings, J[a]);
      for (let i = 0; i < n; i++) J[a][i] = (J[a][i] - r[i]) / STEP[a];
    }
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const g = new Array(6).fill(0);
    for (let a = 0; a < 6; a++) {
      for (let b = a; b < 6; b++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += weights[i] * J[a][i] * J[b][i];
        A[a][b] = A[b][a] = sum;
      }
      let sum = 0;
      for (let i = 0; i < n; i++) sum += weights[i] * J[a][i] * r[i];
      g[a] = -sum;
    }
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const D = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + damping) + 1e-12 : v)));
      const step = solve(D, g);
      if (!step) { damping *= 10; continue; }
      const p = params.map((v, a) => v + step[a]);
      misses(p, sightings, trial);
      const c = costOf(trial, weights);
      if (c < cost) {
        params = p;
        r.set(trial);
        damping = Math.max(damping / 3, 1e-7);
        improved = true;
        if (step.every((v) => Math.abs(v) < 1e-6)) it = ITERATIONS;
      } else damping *= 4;
    }
    if (!improved) break;
    reweigh();
    cost = costOf(r, weights);
  }
  return { params, cost, r };
}

// One sighting's own guess, for a start: where the tag is from how big it looks, and which way
// it faces and how it's turned from poseFromCorners (which a small square makes rough).
function guessFrom(s, seen) {
  let side = 0;
  const mid = [0, 0];
  for (let i = 0; i < 4; i++) {
    const [a, b] = [s.uv[i], s.uv[(i + 1) % 4]];
    side += Math.hypot(b[0] - a[0], b[1] - a[1]) / 4;
    mid[0] += a[0] / 4;
    mid[1] += a[1] / 4;
  }
  const p = new THREE.Vector3(mid[0], mid[1], -1).normalize().multiplyScalar(TAG_SIZE / Math.max(side, 1e-6))
    .applyQuaternion(s.q).add(new THREE.Vector3(...s.c));
  const face = s.q.clone().multiply(seen.rotation);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(face);
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(face);
  const heading = Math.atan2(normal.x, normal.z);
  const roll = Math.atan2(across.y, across.x * Math.cos(heading) - across.z * Math.sin(heading));
  return [heading, roll, p.x, p.y, p.z, 0];
}

// The tag's place from all its sightings. last: the previous result's params, or null.
// Returns { params, position, quaternion (upright: y up, z out of its face), scale (world units
// a metre), moved (m the phone moved across the sightings), miss (typical corner miss) }.
export function fitTag(sightings, last) {
  if (!sightings.length) return null;
  const starts = [];
  if (last) starts.push(last);
  // fresh starts from the newest sighting: its own heading, the mirror one a small square can't
  // tell from it, and facing the camera head-on
  const s = sightings[sightings.length - 1];
  const seen = poseFromCorners(s.uv);
  if (seen) {
    const g = guessFrom(s, seen);
    const toTag = new THREE.Vector3(g[2] - s.c[0], 0, g[4] - s.c[2]);
    const headOn = Math.atan2(-toTag.x, -toTag.z);
    if (last) g[5] = last[5];
    starts.push(g, [2 * headOn - g[0], ...g.slice(1)], [headOn, ...g.slice(1)]);
  }
  let best = null;
  for (const start of starts) {
    const result = refine(sightings, start);
    if (!best || result.cost < best.cost) best = result;
  }
  if (!best) return null;
  const [heading, , px, py, pz, logScale] = best.params;
  const scale = Math.exp(logScale);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  // how far the phone moved across them, in metres
  const mean = [0, 0, 0];
  for (const x of sightings) for (let i = 0; i < 3; i++) mean[i] += x.c[i] / sightings.length;
  let spread = 0;
  for (const x of sightings) spread += (x.c[0] - mean[0]) ** 2 + (x.c[1] - mean[1]) ** 2 + (x.c[2] - mean[2]) ** 2;
  const sorted = Array.from(best.r.subarray(0, best.r.length - 1), Math.abs).sort((a, b) => a - b);
  return {
    params: best.params,
    position: new THREE.Vector3(px, py, pz),
    quaternion,
    scale,
    moved: Math.sqrt(spread / sightings.length) / scale,
    miss: sorted[sorted.length >> 1],
  };
}

// How far one sighting's corners are from where a fit puts them (largest, as in misses).
function newestMiss(params, sighting) {
  const r = misses(params, [sighting], new Float64Array(9));
  let worst = 0;
  for (let i = 0; i < 8; i++) worst = Math.max(worst, Math.abs(r[i]));
  return worst;
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------
export function createTag() {
  let worker = null;
  let status = 'idle';         // idle, ready, failed
  let running = false;
  let video = null;
  let camera = null;
  let canvas = null;
  let busy = false;
  let lastRun = -Infinity;
  let lastTurn = null;
  let jumps = 0;
  let nextId = 1;
  let pose = null;
  let version = 0;
  let lastSeen = -Infinity;
  const sightings = [];
  const pending = new Map();   // search id -> the camera when its picture was taken
  let spare = null;            // a pixel buffer back from the worker, reused
  const grab = document.createElement('canvas');
  const grabCtx = grab.getContext('2d', { willReadFrequently: true });
  const info = { status, picture: '', found: 0, sightings: 0, distance: 0, moved: 0, scale: 1, miss: 0, ms: 0 };
  window.__tag = info;

  function load() {
    try {
      worker = new Worker(WORKER_URL);
      worker.onmessage = ({ data }) => onFound(data);
      worker.onerror = (e) => {
        status = info.status = 'failed';
        busy = false;
        console.warn('[tag] the tag search could not run; the tag is ignored', e);
      };
      status = info.status = 'ready';
    } catch (e) {
      status = info.status = 'failed';
      console.warn('[tag] the tag search could not start; the tag is ignored', e);
    }
  }

  const _q = new THREE.Quaternion();
  function turning(now) {
    camera.getWorldQuaternion(_q);
    const was = lastTurn;
    lastTurn = { q: _q.clone(), t: now };
    if (!was || now - was.t > 500) return false;
    return was.q.angleTo(_q) / ((now - was.t) / 1000 + 1e-3) > MAX_TURN;
  }

  function search() {
    if (!running || status !== 'ready' || busy || !video || !video.videoWidth
      || (video.readyState !== undefined && video.readyState < 2)) return;
    const now = performance.now();
    const turnFast = turning(now);
    if (now - lastRun < (sightings.length >= SETTLED ? SETTLED_INTERVAL : INTERVAL) || turnFast) return;
    lastRun = now;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const f = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    const w = Math.round(vw * f);
    const h = Math.round(vh * f);
    if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; spare = null; info.picture = `${w}×${h}`; }
    grabCtx.drawImage(video, 0, 0, w, h);
    const image = grabCtx.getImageData(0, 0, w, h);
    const pixels = spare && spare.byteLength === image.data.byteLength ? spare : new ArrayBuffer(image.data.byteLength);
    new Uint8ClampedArray(pixels).set(image.data);
    spare = null;
    // the camera as it was for this picture, to place what's found in it
    camera.updateMatrixWorld();
    const id = nextId++;
    pending.set(id, {
      world: camera.matrixWorld.clone(),
      unproject: camera.projectionMatrixInverse.clone(),
      cw: canvas.clientWidth, ch: canvas.clientHeight, vw, vh, f, t: now,
    });
    busy = true;
    worker.postMessage({ id, width: w, height: h, pixels }, [pixels]);
  }

  const _v = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  const _rot = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  function onFound({ id, tags, pixels }) {
    busy = false;
    spare = pixels;
    const shot = pending.get(id);
    pending.delete(id);
    if (!shot || !running) return;
    info.ms = Math.round(performance.now() - shot.t);
    info.found = tags.length;
    const tag = tags.filter((t) => t.id === TAG_ID).sort((a, b) => a.errors - b.errors)[0];
    if (!tag) return;
    // corners: picture pixels -> the screen (the camera picture fills it, centred and cropped,
    // as 8th Wall draws it) -> directions from the camera
    const scale = Math.max(shot.cw / shot.vw, shot.ch / shot.vh);
    const offX = (shot.cw - shot.vw * scale) / 2;
    const offY = (shot.ch - shot.vh * scale) / 2;
    const uv = tag.corners.map(([px, py]) => {
      const sx = (px / shot.f) * scale + offX;
      const sy = (py / shot.f) * scale + offY;
      _v.set((sx / shot.cw) * 2 - 1, 1 - (sy / shot.ch) * 2, 0.5).applyMatrix4(shot.unproject);
      return [_v.x / -_v.z, _v.y / -_v.z];
    });
    const seen = poseFromCorners(uv);
    if (!seen) return;
    shot.world.decompose(_pos, _rot, _scale);
    _m.makeRotationFromQuaternion(_rot).transpose();   // world -> camera
    const e = _m.elements;   // column-major
    const sighting = {
      c: [_pos.x, _pos.y, _pos.z],
      q: _rot.clone(),
      m: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]],
      uv,
      t: shot.t,
    };
    sightings.push(sighting);
    const now = performance.now();
    while (sightings.length > KEEP || (sightings.length && now - sightings[0].t > KEEP_MS)) sightings.shift();

    let fit = fitTag(sightings, pose && pose.params);
    if (!fit) { sightings.pop(); return; }
    // the newest sighting far off what the rest say, again and again: the world was reset (or
    // the tag moved), so start again from the latest
    if (sightings.length > JUMPS) {
      jumps = newestMiss(fit.params, sighting) > JUMP ? jumps + 1 : 0;
      if (jumps >= JUMPS) {
        sightings.splice(0, sightings.length - JUMPS);
        jumps = 0;
        fit = fitTag(sightings, null);
        if (!fit) return;
      }
    }
    pose = fit;
    version++;
    lastSeen = now;
    Object.assign(info, {
      sightings: sightings.length, distance: +(seen.centre.length()).toFixed(2), moved: +fit.moved.toFixed(2),
      scale: +fit.scale.toFixed(3), miss: +(fit.miss * 1000).toFixed(2),
    });
  }

  return {
    // add after XR8.Threejs's module: it keeps the camera picture and searches it now and then
    pipelineModule() {
      return {
        name: 'tag',
        onCameraStatusChange: ({ status: s, video: v }) => { if (s === 'hasVideo' && v) video = v; },
        onUpdate: () => search(),
      };
    },

    // start looking: the camera and the canvas shown
    start(opts) {
      ({ camera, canvas } = opts);
      if (status === 'idle') load();
      running = true;
    },

    // stop, and forget where it was: the next session's world is a new one
    stop() {
      running = false;
      busy = false;
      pending.clear();
      sightings.length = 0;
      pose = null;
      lastTurn = null;
      jumps = 0;
      Object.assign(info, { sightings: 0, distance: 0, moved: 0, scale: 1 });
    },

    // the tag's place in the world, from all the sightings so far, or null before the first:
    // { position, quaternion (upright: y up, z out of its face), scale (world units a metre),
    //   moved (m), sightings, version (goes up with each change), seenAt (performance.now()) }
    pose() {
      return pose && { ...pose, sightings: sightings.length, version, seenAt: lastSeen };
    },
  };
}
