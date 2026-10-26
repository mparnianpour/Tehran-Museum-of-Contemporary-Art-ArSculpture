import * as THREE from 'three';
import { loadPiece, createEnvironment, PHOTO, VIEWS } from './piece.js';

// 8th Wall's three.js module looks for a global THREE.
window.THREE = THREE;

const FOLLOW_ALPHA = 0.25;        // smoothing of later sightings of the photo
const FIND_WAIT = 4000;           // ms without finding the photo before offering to place by hand
const PLACE_DISTANCE = 12;        // how far away a hand-placed scene stands (world units, about metres)
const PLACE_TRIES = 3;            // taps a visitor gets to place the sculpture between the pillars

// Where people walk through the view, marked on the photo: the ceiling light and cross beam, and
// the three balconies. The target is softened there, so the photo is still found while people
// move about. Each area is traced row by row as [y, left, right], in photo pixels.
const PEOPLE = [
  [[278, 331, 365], [284, 303, 392], [290, 291, 407], [296, 285, 419], [302, 281, 429], [308, 281, 436],
    [314, 285, 446], [320, 290, 454], [326, 300, 464], [332, 313, 471], [338, 339, 480]],
  [[617, 215, 424], [623, 190, 554], [629, 176, 576], [635, 167, 591], [641, 163, 599], [647, 159, 600],
    [653, 156, 602], [659, 155, 603], [665, 154, 606], [671, 154, 607], [677, 155, 608], [683, 161, 611],
    [689, 170, 609], [695, 361, 488]],
  [[736, 206, 245], [742, 161, 333], [748, 144, 463], [754, 131, 490], [760, 125, 508], [766, 118, 525],
    [772, 112, 539], [778, 107, 556], [784, 102, 571], [790, 99, 585], [796, 95, 595], [802, 90, 598],
    [808, 88, 600], [814, 85, 603], [820, 85, 605], [826, 86, 607], [832, 499, 610], [838, 501, 612],
    [844, 536, 614], [850, 560, 616], [856, 586, 619], [862, 603, 622]],
  [[966, 329, 519], [972, 239, 544], [978, 206, 558], [984, 187, 567], [990, 169, 572], [996, 159, 576],
    [1002, 152, 580], [1008, 146, 583], [1014, 142, 586], [1020, 140, 590], [1026, 142, 595],
    [1032, 144, 597], [1038, 150, 603]],
];
const PEOPLE_MARGIN = 12;         // photo pixels the softening reaches past each marked edge
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
  targets: [],        // 8th Wall image target data: atrium.jpg, then the other views
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
  const ready = state.targets.length > 0 && !!state.piece && state.xrReady;
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
const canvas2d = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })];
};

// Blur away the detail where people walk (PEOPLE), with soft edges: the detector finds nothing to
// track there, and no hard edge is left round each area for it to latch onto instead.
function softenWherePeopleWalk(lum, crop) {
  const k = lum.width / crop.w;   // target pixels per photo pixel
  const toTarget = ([x, y]) => [(x - crop.x) * k, (y - crop.y) * k];
  const [mask, mg] = canvas2d(lum.width, lum.height);
  mg.fillStyle = '#000';            // opaque, so the soft edges stay in the colour, not the alpha
  mg.fillRect(0, 0, mask.width, mask.height);
  mg.fillStyle = mg.strokeStyle = '#fff';
  mg.lineJoin = 'round';
  mg.lineWidth = 2 * PEOPLE_MARGIN * k;
  for (const rows of PEOPLE) {
    const outline = [...rows.map(([y, l]) => [l, y]), ...rows.slice().reverse().map(([y, , r]) => [r, y])].map(toTarget);
    mg.beginPath();
    outline.forEach(([x, y], i) => (i ? mg.lineTo(x, y) : mg.moveTo(x, y)));
    mg.closePath();
    mg.fill();
    mg.stroke();
  }
  // soft edges and the blurred picture: halved again and again, then doubled back up the same
  // way, which blurs smoothly (one big jump would leave soft-edged blocks)
  const blur = (src, steps) => {
    const levels = [src];
    for (let i = 0; i < steps; i++) {
      const prev = levels[levels.length - 1];
      const [c, g] = canvas2d(Math.max(1, Math.round(prev.width / 2)), Math.max(1, Math.round(prev.height / 2)));
      g.imageSmoothingQuality = 'high';
      g.drawImage(prev, 0, 0, c.width, c.height);
      levels.push(c);
    }
    let up = levels[levels.length - 1];
    for (let i = levels.length - 2; i >= 0; i--) {
      const [c, g] = canvas2d(levels[i].width, levels[i].height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(up, 0, 0, c.width, c.height);
      up = c;
    }
    return up.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, lum.width, lum.height).data;
  };
  const soft = blur(mask, 3);
  const blurred = blur(lum, 4);
  const lg = lum.getContext('2d', { willReadFrequently: true });
  const px = lg.getImageData(0, 0, lum.width, lum.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const m = soft[i] / 255;
    px.data[i] = px.data[i + 1] = px.data[i + 2] = px.data[i] * (1 - m) + blurred[i] * m;
  }
  lg.putImageData(px, 0, 0);
}

// photo: atrium.jpg (PHOTO) or one of the other views; soften: blur where people walk (PEOPLE
// is traced on atrium.jpg only)
async function buildTarget(name, photo, soften) {
  const img = new Image();
  img.src = photo.src;
  await img.decode();
  const crop = { x: 0, y: photo.cropTop, w: img.naturalWidth, h: photo.cropHeight };
  const [lum, lg] = canvas2d(480, 640);
  lg.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, lum.width, lum.height);
  const px = lg.getImageData(0, 0, lum.width, lum.height);
  for (let i = 0; i < px.data.length; i += 4) {
    const y = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
    px.data[i] = px.data[i + 1] = px.data[i + 2] = y;
  }
  lg.putImageData(px, 0, 0);
  if (soften) softenWherePeopleWalk(lum, crop);
  const blob = await new Promise((r) => lum.toBlob(r, 'image/jpeg', 0.92));
  if (DEBUG) (window.__targetImages ||= {})[name] = lum.toDataURL('image/png');
  const now = Date.now();
  return {
    imagePath: URL.createObjectURL(blob),
    metadata: null,
    name,
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

const VIEW_BY_NAME = new Map(VIEWS.map((v) => [v.name, v]));

function onImagePose(detail, camera) {
  const pos = new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z);
  const quat = new THREE.Quaternion(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w).normalize();
  let scale = detail.scale * detail.scaledWidth;   // world size of 1 image width
  // one of the other views: where atrium.jpg's image space lies, from this one's
  const view = VIEW_BY_NAME.get(detail.name);
  if (view) {
    pos.add(view.toView.offset.clone().applyQuaternion(quat).multiplyScalar(scale));
    scale *= view.toView.scale;
  }
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
// A visitor gets PLACE_TRIES taps; after the last one the sculpture stays where it is.
// ---------------------------------------------------------------------------
let triesLeft = PLACE_TRIES;
const UP = new THREE.Vector3(0, 1, 0);
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _look = new THREE.Vector3();
const _basis = new THREE.Matrix4();

function placeByHand(clientX, clientY) {
  if (!state.running || !state.piece || triesLeft <= 0) return;
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
  triesLeft--;
  clearTimeout(findTimer);
  if (triesLeft > 0) setHint(`Placed. Tap again to move it (${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left)`);
  else setHint('Placed');
  findTimer = setTimeout(() => setHint(null), triesLeft > 0 ? 3500 : 2000);
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
    triesLeft = PLACE_TRIES;
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
        if (!anchor.placed) setHint(`Not found? Frame the pillars like the photo, then tap between them (${PLACE_TRIES} tries)`);
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
    imageTargetData: state.targets,
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
  triesLeft = PLACE_TRIES;
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
// atrium.jpg is needed; the other views only help, so one that fails to load is left out
Promise.all([
  buildTarget('atrium', PHOTO, true),
  ...VIEWS.map((v) => buildTarget(v.name, v, false).catch((e) => { console.warn(`${v.src} left out:`, e); return null; })),
])
  .then((t) => { state.targets = t.filter(Boolean); refreshStart(); })
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
