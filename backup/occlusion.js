// occlusion.js
// People who come between the phone and the sculpture hide it, the way ar-test's
// people-occlusion does: several times a second, the part of the camera picture round the
// sculpture and its light goes through a person-segmentation model (MediaPipe's selfie
// segmenter), and wherever a person is found an invisible mask is drawn before the scene, so the
// sculpture, its light and its dust aren't drawn there and the person shows through.
//
// - This finds people. Other things clearly in front of the sculpture (the big pillars beside
//   you, the railing) are left to depth.js, the depth tracker, which only hides when it's sure.
// - Assumes people are in front of the sculpture, true for visitors on the ramp.
// - Only the area round the sculpture is analysed, which keeps people big enough for the model to
//   find them and keeps it fast.
// - The model and its runtime are in lib/mediapipe, so nothing is loaded from Google. If they fail
//   to load, the piece works as before, without hiding (see the console).

import * as THREE from 'three';

const ASSET_DIR = new URL('../lib/mediapipe/', import.meta.url).href;
const MODEL_FILE = 'selfie_segmenter.tflite';
const MASK_SIZE = 256;
const MAX_FPS = 15;          // segmentation runs per second, at most; lower it if phones get hot
const THRESHOLD = 0.4;       // person confidence needed to hide the sculpture; lower = a little wider cut-out
const ROI_SCALE = 1.8;       // the area analysed, relative to the sculpture and its light on screen

// Full-screen quad in clip space, just inside the near plane, so its depth beats everything.
const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, -0.9999, 1.0);
}`;

const FRAGMENT_SHADER = `
uniform sampler2D uMask;
uniform vec4 uRect;          // the analysed square on screen: u0, v0, u1, v1 (v from the top)
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec2 s = vec2(vUv.x, 1.0 - vUv.y);
  vec2 m = (s - uRect.xy) / (uRect.zw - uRect.xy);
  if (m.x < 0.0 || m.x > 1.0 || m.y < 0.0 || m.y > 1.0) discard;
  if (texture2D(uMask, m).r < uThreshold) discard;
  gl_FragColor = vec4(1.0, 0.0, 0.6, 1.0);  // only seen with ?debug
}`;

export function createOcclusion({ debug = false } = {}) {
  let status = 'idle';       // idle, loading, ready, failed
  let segmenter = null;
  let running = false;
  let video = null;
  let camera = null;
  let canvas = null;
  let target = null;         // () => the object to keep clear of people (the piece), or null
  let lastRun = -Infinity;
  let lastTimestamp = 0;
  const rect = { u0: 0, v0: 0, u1: 1, v1: 1 };

  const maskData = new Uint8Array(MASK_SIZE * MASK_SIZE * 4);
  const maskTexture = new THREE.DataTexture(maskData, MASK_SIZE, MASK_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  maskTexture.magFilter = maskTexture.minFilter = THREE.LinearFilter;
  maskTexture.generateMipmaps = false;
  maskTexture.needsUpdate = true;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMask: { value: maskTexture },
      uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uThreshold: { value: THRESHOLD },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    // Depth only. Depth writes need the depth test enabled, hence ALWAYS instead of off.
    colorWrite: debug,
    depthWrite: true,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e6;   // drawn before every other object
  mesh.visible = false;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropCanvas.height = MASK_SIZE;
  const cropCtx = cropCanvas.getContext('2d');
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  const info = { status, ms: 0, people: 0 };
  window.__occlusion = info;

  async function load() {
    status = info.status = 'loading';
    try {
      const vision = await import(`${ASSET_DIR}vision_bundle.js`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${ASSET_DIR}wasm`);
      const create = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${ASSET_DIR}${MODEL_FILE}`, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      try {
        segmenter = await create('GPU');
      } catch (e) {
        console.warn('[occlusion] GPU segmentation unavailable, using CPU', e);
        segmenter = await create('CPU');
      }
      status = info.status = 'ready';
    } catch (e) {
      status = info.status = 'failed';
      console.warn('[occlusion] could not load person segmentation; nothing will be hidden', e);
    }
  }

  // The object's box on screen (uv, v from the top), or null when it isn't on screen.
  function screenRect(obj) {
    box.setFromObject(obj);
    if (box.isEmpty()) return null;
    const { min, max } = box;
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    let behind = 0;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
      corner.applyMatrix4(camera.matrixWorldInverse);
      if (corner.z > -camera.near) { behind++; continue; }
      corner.applyMatrix4(camera.projectionMatrix);
      u0 = Math.min(u0, (corner.x + 1) / 2);
      u1 = Math.max(u1, (corner.x + 1) / 2);
      v0 = Math.min(v0, (1 - corner.y) / 2);
      v1 = Math.max(v1, (1 - corner.y) / 2);
    }
    if (behind === 8) return null;
    if (behind > 0) return { u0: 0, v0: 0, u1: 1, v1: 1 };   // partly behind the camera: the whole view
    u0 = Math.max(0, u0); v0 = Math.max(0, v0); u1 = Math.min(1, u1); v1 = Math.min(1, v1);
    return u1 > u0 && v1 > v0 ? { u0, v0, u1, v1 } : null;
  }

  function update() {
    const obj = running && target && target();
    if (!obj || status !== 'ready' || !video || !video.videoWidth || (video.readyState !== undefined && video.readyState < 2)) {
      mesh.visible = false;
      return;
    }
    camera.updateMatrixWorld();
    const r = screenRect(obj);
    if (!r) { mesh.visible = false; return; }
    const now = performance.now();
    if (now - lastRun < 1000 / MAX_FPS) return;   // keep showing the last mask
    lastRun = now;

    // The camera picture fills the canvas without distortion, centred and cropped ("cover"), as
    // 8th Wall's camera renderer draws it. Map the screen box into camera pixels.
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(cw / vw, ch / vh);
    const offX = (cw - vw * scale) / 2;
    const offY = (ch - vh * scale) / 2;
    const cx = ((r.u0 + r.u1) / 2) * cw;
    const cy = ((r.v0 + r.v1) / 2) * ch;
    const sideCanvas = Math.max((r.u1 - r.u0) * cw, (r.v1 - r.v0) * ch) * ROI_SCALE;
    let side = Math.min(sideCanvas / scale, vw, vh);
    side = Math.max(side, Math.min(vw, vh) * 0.1);
    const sx = Math.min(Math.max((cx - offX) / scale - side / 2, 0), vw - side);
    const sy = Math.min(Math.max((cy - offY) / scale - side / 2, 0), vh - side);
    cropCtx.drawImage(video, sx, sy, side, side, 0, 0, MASK_SIZE, MASK_SIZE);

    const timestamp = Math.max(Math.round(now), lastTimestamp + 1);
    lastTimestamp = timestamp;
    let ok = false;
    try {
      segmenter.segmentForVideo(cropCanvas, timestamp, (result) => {
        const masks = result.confidenceMasks;
        if (!masks || !masks.length) return;
        const conf = masks[masks.length - 1].getAsFloat32Array();
        const n = Math.min(conf.length, MASK_SIZE * MASK_SIZE);
        let people = 0;
        for (let i = 0; i < n; i++) {
          maskData[i * 4] = conf[i] * 255;
          if (conf[i] >= THRESHOLD) people++;
        }
        info.people = people;
        ok = true;
      });
    } catch (e) {
      console.warn('[occlusion] segmentation failed for this frame', e);
    }
    info.ms = Math.round(performance.now() - now);
    if (!ok) { mesh.visible = false; return; }
    maskTexture.needsUpdate = true;
    rect.u0 = (sx * scale + offX) / cw;
    rect.v0 = (sy * scale + offY) / ch;
    rect.u1 = ((sx + side) * scale + offX) / cw;
    rect.v1 = ((sy + side) * scale + offY) / ch;
    material.uniforms.uRect.value.set(rect.u0, rect.v0, rect.u1, rect.v1);
    mesh.visible = true;
  }

  const _p = new THREE.Vector3();
  return {
    // add after XR8.Threejs's module: it keeps the camera picture and updates the mask each frame
    pipelineModule() {
      return {
        name: 'occlusion',
        onCameraStatusChange: ({ status: s, video: v }) => { if (s === 'hasVideo' && v) video = v; },
        onUpdate: () => update(),
      };
    },

    // start hiding: the scene to draw the mask in, the camera, the canvas shown, and a function
    // giving the object to keep clear of people (the piece), or null while it isn't placed
    start(opts) {
      ({ camera, canvas, target } = opts);
      if (!mesh.parent) opts.scene.add(mesh);
      if (status === 'idle') load();
      running = true;
    },

    stop() {
      running = false;
      mesh.visible = false;
    },

    // whether a person stands in front of this point (world space)
    hides(world) {
      if (!mesh.visible || !camera) return false;
      _p.copy(world).project(camera);
      const u = ((_p.x + 1) / 2 - rect.u0) / (rect.u1 - rect.u0);
      const v = ((1 - _p.y) / 2 - rect.v0) / (rect.v1 - rect.v0);
      if (u < 0 || v < 0 || u >= 1 || v >= 1) return false;
      return maskData[(((v * MASK_SIZE) | 0) * MASK_SIZE + ((u * MASK_SIZE) | 0)) * 4] >= THRESHOLD * 255;
    },
  };
}
