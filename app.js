import * as THREE from 'three';
import { loadPiece, createEnvironment, PHOTO } from './piece.js';

// 8th Wall's three.js module looks for a global THREE.
window.THREE = THREE;

const FOLLOW_ALPHA = 0.25;        // smoothing of later sightings of the photo
const FIND_WAIT = 4000;           // ms without finding the photo before offering to place by hand
const PLACE_DISTANCE = 12;        // how far away a hand-placed scene stands (world units, about metres)
const DEBUG = new URLSearchParams(location.search).has('debug');

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  setup: $('setup'), ar: $('ar'), xrCanvas: $('xr-canvas'), start: $('start'), status: $('status'),
  error: $('error'), hint: $('hint'), back: $('back'),
};

const state = {
  target: null,       // 8th Wall image target data
  piece: null,
  xrReady: false,
  running: false,
  worldTracking: true,
  progress: 0,
};

function showError(text) {
  ui.error.hidden = !text;
  ui.error.textContent = text || '';
}

function setHint(text) {
  if (text) { ui.hint.textContent = text; ui.hint.classList.remove('found'); }
  else ui.hint.classList.add('found');
}

function refreshStart() {
  const ready = !!state.target && !!state.piece && state.xrReady;
  ui.start.disabled = !ready;
  if (ready) ui.status.textContent = '';
  else if (!state.piece) ui.status.textContent = `Loading the Simorgh… ${Math.round(state.progress * 100)}%`;
  else ui.status.textContent = 'Loading the AR engine…';
}

// ---------------------------------------------------------------------------
// The photograph → 8th Wall image target, built in the browser.
// Same output as 8th Wall's image-target-cli: the centre 3:4 region as a
// 480×640 greyscale "luminance" image.
// ---------------------------------------------------------------------------
async function buildTarget() {
  const img = new Image();
  img.src = PHOTO.src;
  await img.decode();
  const crop = { x: 0, y: PHOTO.cropTop, w: img.naturalWidth, h: PHOTO.cropHeight };
  const lum = document.createElement('canvas');
  lum.width = 480;
  lum.height = 640;
  const lg = lum.getContext('2d', { willReadFrequently: true });
  lg.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, lum.width, lum.height);
  const px = lg.getImageData(0, 0, lum.width, lum.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const y = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
    px.data[i] = px.data[i + 1] = px.data[i + 2] = y;
  }
  lg.putImageData(px, 0, 0);
  const blob = await new Promise((r) => lum.toBlob(r, 'image/jpeg', 0.92));
  const now = Date.now();
  return {
    imagePath: URL.createObjectURL(blob),
    metadata: null,
    name: 'atrium',
    type: 'PLANAR',
    properties: {
      top: crop.y, left: crop.x, width: crop.w, height: crop.h,
      isRotated: false, originalWidth: img.naturalWidth, originalHeight: img.naturalHeight,
    },
    resources: {},
    created: now,
    updated: now,
  };
}

// ---------------------------------------------------------------------------
// Placement: the piece is fixed to the photo. Each sighting of the photo moves it
// there (smoothed); with world tracking it stays put when the photo leaves the view.
// ---------------------------------------------------------------------------
const anchor = {
  group: new THREE.Group(),
  placed: false,
  byHand: false,
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  scale: 1,
};
anchor.group.visible = false;
const _fwd = new THREE.Vector3();
const _normal = new THREE.Vector3();
let findTimer = 0;

function applyAnchor() {
  anchor.group.position.copy(anchor.pos);
  anchor.group.quaternion.copy(anchor.quat);
  anchor.group.scale.setScalar(anchor.scale);
}

function onImagePose(detail, camera) {
  const pos = new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z);
  const quat = new THREE.Quaternion(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w).normalize();
  const scale = detail.scale * detail.scaledWidth;   // world size of 1 image width
  if (!anchor.placed || anchor.byHand) {
    anchor.pos.copy(pos); anchor.quat.copy(quat); anchor.scale = scale;
    anchor.placed = true;
    anchor.byHand = false;
    anchor.group.visible = true;
    clearTimeout(findTimer);
    setHint(null);
  } else {
    // weighted by how head-on the photo is seen: glancing views are the least reliable
    camera.getWorldDirection(_fwd);
    _normal.set(0, 0, 1).applyQuaternion(quat);
    const facing = Math.abs(_fwd.dot(_normal));
    const alpha = FOLLOW_ALPHA * THREE.MathUtils.clamp((facing - 0.2) / 0.5, 0.15, 1);
    anchor.pos.lerp(pos, alpha);
    anchor.quat.slerp(quat, alpha);
    anchor.scale += (scale - anchor.scale) * alpha;
  }
  applyAnchor();
}

// ---------------------------------------------------------------------------
// Placing by hand, for the real atrium. The photo is matched as a flat picture, so in the
// building itself it is only found from the exact spot it was taken. Instead: frame the
// pillars like the photo and tap between them. The scene stands there, upright and facing
// you, as wide as the view, and world tracking keeps it in the room as you move.
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _look = new THREE.Vector3();
const _basis = new THREE.Matrix4();

function placeByHand(clientX, clientY) {
  if (!state.running || !state.piece) return;
  const { camera } = XR8.Threejs.xrScene();
  const rect = ui.xrCanvas.getBoundingClientRect();
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
  camera.updateMatrixWorld();
  _ray.setFromCamera(_ndc, camera);
  // the scene's plane: PLACE_DISTANCE ahead of the camera, facing back at it, upright
  // (unless the phone is tipped more than 60° up or down: then square to the view)
  camera.getWorldDirection(_look);
  _z.copy(_look).setY(0);
  if (_z.lengthSq() < 0.25) { _z.copy(_look); _y.set(0, 1, 0).applyQuaternion(camera.quaternion); }
  else _y.copy(UP);
  _z.normalize();
  const ahead = _ray.ray.direction.dot(_z);
  if (ahead < 0.1) return;
  const tap = _ray.ray.origin.clone().addScaledVector(_ray.ray.direction, PLACE_DISTANCE / ahead);
  _z.negate();
  _x.crossVectors(_y, _z).normalize();
  _y.crossVectors(_z, _x);
  anchor.quat.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
  anchor.scale = (2 * PLACE_DISTANCE) / camera.projectionMatrix.elements[0];   // the photo spans the view
  // the sculpture's spot lands where you tapped
  anchor.pos.copy(tap).sub(state.piece.spot.clone().applyQuaternion(anchor.quat).multiplyScalar(anchor.scale));
  anchor.placed = true;
  anchor.byHand = true;
  anchor.group.visible = true;
  applyAnchor();
  clearTimeout(findTimer);
  setHint('Placed. Tap again to move it.');
  findTimer = setTimeout(() => setHint(null), 2500);
}

let tapFrom = null;
ui.xrCanvas.addEventListener('pointerdown', (e) => { tapFrom = [e.clientX, e.clientY]; });
ui.xrCanvas.addEventListener('pointerup', (e) => {
  if (tapFrom && Math.hypot(e.clientX - tapFrom[0], e.clientY - tapFrom[1]) < 12) placeByHand(e.clientX, e.clientY);
  tapFrom = null;
});

// ---------------------------------------------------------------------------
// 8th Wall session
// ---------------------------------------------------------------------------
const shade = window.Shade.pipelineModule();
shade.onError = (e) => showError('The shade could not start: ' + e.message);
const clockStart = performance.now();

const arModule = {
  name: 'simorgh',
  onStart: () => {
    const { scene, camera, renderer } = XR8.Threejs.xrScene();
    // Don't change the pixel ratio here: 8th Wall sizes this renderer to match
    // the camera feed, and changing it shifts the 3D layer off the image.
    renderer.toneMapping = THREE.AgXToneMapping;
    scene.environment = createEnvironment(renderer);
    renderer.getContext().useProgram(null);
    renderer.resetState();

    camera.position.set(0, 1.6, 0);
    XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });

    anchor.placed = false;
    anchor.byHand = false;
    anchor.group.visible = false;
    if (!anchor.group.children.length) anchor.group.add(state.piece.root);
    scene.add(anchor.group);
    window.__xr = { scene, camera, renderer, anchor };
  },
  onUpdate: () => {
    if (state.piece) state.piece.update((performance.now() - clockStart) / 1000, shade.light);
  },
  onCameraStatusChange: ({ status }) => {
    if (DEBUG) (window.__ev ||= []).push(['camera', status]);
    if (status === 'hasVideo' && !anchor.placed) {
      setHint('Point your camera at the view in the photo');
      clearTimeout(findTimer);
      findTimer = setTimeout(() => {
        if (!anchor.placed) setHint('Not found? Frame the pillars like the photo, then tap between them');
      }, FIND_WAIT);
    }
    if (status === 'failed' || status === 'denied') {
      stopAR();
      showError('Camera access is off. Allow the camera for this site in your browser settings, then try again.');
    }
  },
  onException: (err) => {
    console.error(err);
    stopAR();
    showError('The camera view stopped: ' + String((err && err.message) || err || ''));
  },
  listeners: [
    { event: 'reality.imagefound', process: ({ detail }) => onImagePose(detail, XR8.Threejs.xrScene().camera) },
    { event: 'reality.imageupdated', process: ({ detail }) => onImagePose(detail, XR8.Threejs.xrScene().camera) },
    { event: 'reality.imagelost', process: () => { if (DEBUG) (window.__ev ||= []).push(['lost']); } },
  ],
};

function startAR() {
  if (ui.start.disabled || state.running) return;
  showError('');

  const device = XR8.XrConfig.device();
  const mobileOk = XR8.XrDevice.isDeviceBrowserCompatible({ allowedDevices: device.MOBILE_AND_HEADSETS });
  state.worldTracking = mobileOk;
  if (!mobileOk && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    showError('This browser can\'t run the camera view. Open the page in Safari (iPhone) or Chrome (Android).');
    return;
  }

  // Everything below runs inside the tap, so iOS can show its camera and motion prompts.
  ui.setup.hidden = true;
  ui.ar.hidden = false;
  document.body.dataset.state = 'ar';
  setHint('Starting camera…');
  ui.xrCanvas.style.display = 'block';

  XR8.XrController.configure({
    imageTargetData: [state.target],
    disableWorldTracking: !state.worldTracking,
  });
  XR8.clearCameraPipelineModules();
  XR8.addCameraPipelineModules([
    window.XRExtras.FullWindowCanvas.pipelineModule(),   // sizes the canvas to the screen
    XR8.GlTextureRenderer.pipelineModule(),              // the plain camera feed
    shade,                                               // the Turrell shade over it, flickering
    XR8.Threejs.pipelineModule(),                        // the Simorgh and the beams, drawn over both
    XR8.XrController.pipelineModule(),                   // world tracking + the image target
    arModule,
  ]);
  state.running = true;
  XR8.run({
    canvas: ui.xrCanvas,
    allowedDevices: state.worldTracking ? device.MOBILE_AND_HEADSETS : device.ANY,
  });
}

function stopAR() {
  if (state.running) {
    state.running = false;
    try { XR8.stop(); } catch { /* already stopped */ }
    try { XR8.clearCameraPipelineModules(); } catch { /* ignore */ }
  }
  clearTimeout(findTimer);
  anchor.placed = false;
  anchor.byHand = false;
  anchor.group.visible = false;
  ui.ar.hidden = true;
  ui.xrCanvas.style.display = 'none';
  ui.setup.hidden = false;
  document.body.dataset.state = 'setup';
  refreshStart();
}

ui.start.addEventListener('click', startAR);
ui.back.addEventListener('click', stopAR);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
refreshStart();
buildTarget()
  .then((t) => { state.target = t; refreshStart(); })
  .catch((e) => { console.error(e); showError('The photograph could not be loaded.'); });
loadPiece({ onProgress: (p) => { state.progress = p; refreshStart(); } })
  .then((p) => { state.piece = p; refreshStart(); })
  .catch((e) => { console.error(e); showError('The Simorgh could not be loaded.'); });

function onXrLoaded() {
  state.xrReady = true;
  refreshStart();
}
if (window.XR8) onXrLoaded();
else window.addEventListener('xrloaded', onXrLoaded, { once: true });
