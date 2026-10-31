import * as THREE from 'three';
import { loadPiece, createEnvironment, PHOTO } from './piece.js';
import { createOcclusion } from './occlusion.js';
import { createTag } from './tag.js';

// 8th Wall's three.js module looks for a global THREE.
window.THREE = THREE;

const FOLLOW_ALPHA = 0.25;        // smoothing of later sightings of the photo
const FIND_WAIT = 4000;           // ms without finding the photo before offering to place by hand
const PLACE_DISTANCE = 12;        // the furthest a hand-placed scene stands (world units, about metres)
const PLACE_MIN = 0.8;            // ...and the nearest
const TAP_SIZE = 0.4;             // a tapped scene's size, as a share of the photo spanning the view
const PLACE_TRIES = 3;            // taps a visitor gets to place the sculpture by hand

const PARAMS = new URLSearchParams(location.search);
const DEBUG = PARAMS.has('debug');
const SETUP = PARAMS.has('setup');  // measuring where the scene sits relative to the position tag

// The position tag (marker/, tag.js): where the scene sits relative to it, measured once with
// ?setup, which shows it as a code: x, y, z (metres), qx, qy, qz, qw, then the size of one photo
// width (metres). Every phone that sees the tag then puts the scene in that same place, before the
// photograph or a tap. Until a code is filled in here the tag places nothing, unless this phone
// saved one in ?setup, or the address carries one (?tag=…, to try a code on any phone).
const TAG_SCENE = '';
const TAG_SAVED = 'simorgh-tag-scene';   // localStorage key for a code saved in ?setup
const TAG_EASE = 0.15;                   // how quickly the scene follows the tag's fit as it firms up

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  setup: $('setup'), ar: $('ar'), xrCanvas: $('xr-canvas'), start: $('start'), status: $('status'),
  error: $('error'), hint: $('hint'), back: $('back'),
};

// A code -> { pos, quat, size }, or null if it isn't one.
function readTagScene(code) {
  const n = String(code || '').split(',').map(Number);
  if (n.length !== 8 || !n.every(Number.isFinite) || n[7] <= 0) return null;
  const quat = new THREE.Quaternion(n[3], n[4], n[5], n[6]);
  if (quat.lengthSq() < 0.5) return null;
  return { pos: new THREE.Vector3(n[0], n[1], n[2]), quat: quat.normalize(), size: n[7] };
}
const tagSceneCode = ({ pos, quat, size }) => [
  ...pos.toArray().map((v) => v.toFixed(3)), ...quat.toArray().map((v) => v.toFixed(4)), size.toFixed(4),
].join(',');
function savedTagScene() {
  try { return localStorage.getItem(TAG_SAVED); } catch { return null; }
}
const tagScene = readTagScene(PARAMS.get('tag')) || readTagScene(savedTagScene()) || readTagScene(TAG_SCENE);
const useTag = SETUP || !!tagScene;

const state = {
  targets: [],        // 8th Wall image target data: the photograph
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

async function buildTarget(name, photo) {
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
  byTag: false,
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  scale: 1,
};
anchor.group.visible = false;
const _fwd = new THREE.Vector3();
const _normal = new THREE.Vector3();
let findTimer = 0;

// The photo's plane leans back (it looks up at the beam), and a tap made while looking up does
// too, but the sculpture hangs straight down: the scene is turned about the sculpture's centre
// until its up is the world's, facing the way the photo faces.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _across = new THREE.Vector3();
const _facing = new THREE.Vector3();
const _spotIn = new THREE.Vector3();
const _upright = new THREE.Matrix4();

function uprightOf(quat, out) {
  _across.set(1, 0, 0).applyQuaternion(quat).setY(0);
  if (_across.lengthSq() < 0.1) {
    // turned on its side: go by which way it faces (its face and its top both lean toward the viewer)
    _facing.set(0, 0, 1).applyQuaternion(quat).add(_spotIn.set(0, 1, 0).applyQuaternion(quat)).setY(0);
    _across.crossVectors(WORLD_UP, _facing);
  }
  _across.normalize();
  _facing.crossVectors(_across, WORLD_UP);
  return out.setFromRotationMatrix(_upright.makeBasis(_across, WORLD_UP, _facing));
}

function applyAnchor() {
  uprightOf(anchor.quat, anchor.group.quaternion);
  anchor.group.scale.setScalar(anchor.scale);
  // the sculpture's centre stays where the photo, the tap or the tag put it
  anchor.group.position.copy(anchor.pos);
  if (state.piece) {
    _spotIn.copy(state.piece.spot).multiplyScalar(anchor.scale);
    anchor.group.position.add(_facing.copy(_spotIn).applyQuaternion(anchor.quat))
      .sub(_spotIn.applyQuaternion(anchor.group.quaternion));
  }
}

function onImagePose(detail, camera) {
  if (anchor.byTag) return;   // the tag knows better
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
// building itself it is only found from about the spot it was taken. Instead: tap the point on
// the ceiling it hangs from. The light starts there and the sculpture hangs straight down below
// it, facing you, TAP_SIZE as wide as the view, as far away as what you tapped on (up to
// PLACE_DISTANCE: in a smaller room it stands in the room, not behind its walls), and world
// tracking keeps it in the room as you move.
// A visitor gets PLACE_TRIES taps; after the last one the sculpture stays where it is.
// ---------------------------------------------------------------------------
const TRIES = SETUP ? Infinity : PLACE_TRIES;   // setting up, as many as it takes
let triesLeft = TRIES;
const UP = new THREE.Vector3(0, 1, 0);
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _look = new THREE.Vector3();
const _basis = new THREE.Matrix4();

// How far ahead the tapped spot is, measured level: from a point the AR engine tracks there;
// PLACE_DISTANCE when it has none. Needs _ray and _z set.
function tappedDistance(clientX, clientY, rect) {
  let point = null;
  try {
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const hit = (XR8.XrController.hitTest(x, y, ['FEATURE_POINT']) || [])[0];
    if (hit) point = new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z);
  } catch { /* no hit test here: the default */ }
  const ahead = point ? point.sub(_ray.ray.origin).dot(_z) : PLACE_DISTANCE;
  return THREE.MathUtils.clamp(ahead, PLACE_MIN, PLACE_DISTANCE);
}

function placeByHand(clientX, clientY) {
  if (!state.running || !state.piece || triesLeft <= 0 || anchor.byTag) return;
  const { camera } = XR8.Threejs.xrScene();
  const rect = ui.xrCanvas.getBoundingClientRect();
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
  camera.updateMatrixWorld();
  _ray.setFromCamera(_ndc, camera);
  // the scene's plane: as far ahead as the tapped spot, facing back at the camera, upright
  // (unless the phone is tipped more than 60° up or down: then square to the view)
  camera.getWorldDirection(_look);
  _z.copy(_look).setY(0);
  if (_z.lengthSq() < 0.25) { _z.copy(_look); _y.set(0, 1, 0).applyQuaternion(camera.quaternion); }
  else _y.copy(UP);
  _z.normalize();
  const ahead = _ray.ray.direction.dot(_z);
  if (ahead < 0.1) return;
  const distance = tappedDistance(clientX, clientY, rect);
  const tap = _ray.ray.origin.clone().addScaledVector(_ray.ray.direction, distance / ahead);
  _z.negate();
  _x.crossVectors(_y, _z).normalize();
  _y.crossVectors(_z, _x);
  uprightOf(anchor.quat.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z)), anchor.quat);
  anchor.scale = (TAP_SIZE * 2 * distance) / camera.projectionMatrix.elements[0];   // a share of the photo spanning the view
  // its light starts where you tapped
  anchor.pos.copy(tap).sub(state.piece.source.clone().applyQuaternion(anchor.quat).multiplyScalar(anchor.scale));
  anchor.placed = true;
  anchor.byHand = true;
  anchor.group.visible = true;
  applyAnchor();
  triesLeft--;
  clearTimeout(findTimer);
  if (SETUP) setHint('Placed. Tap again to move it');
  else if (triesLeft > 0) setHint(`Placed. Tap again to move it (${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left)`);
  else setHint('Placed');
  findTimer = setTimeout(() => setHint(null), triesLeft > 0 ? 3500 : 2000);
}

// ---------------------------------------------------------------------------
// The position tag. Outside ?setup, once a code says where the scene sits relative to the tag,
// seeing the tag puts it there, the same place in the room on every phone. In ?setup the tag
// only measures: the photo or a tap places the scene, and the panel shows the code for it.
// ---------------------------------------------------------------------------
const tag = createTag();
let tagVersion = -1;
const tagTarget = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 };

function placeFromTag() {
  const t = tag.pose();
  if (!t || !state.piece) return;
  if (t.version !== tagVersion) {
    tagVersion = t.version;
    tagTarget.pos.copy(tagScene.pos).applyQuaternion(t.quaternion).multiplyScalar(t.scale).add(t.position);
    tagTarget.quat.copy(t.quaternion).multiply(tagScene.quat);
    tagTarget.scale = t.scale * tagScene.size;
    if (!anchor.byTag) {
      anchor.pos.copy(tagTarget.pos);
      anchor.quat.copy(tagTarget.quat);
      anchor.scale = tagTarget.scale;
      anchor.placed = true;
      anchor.byTag = true;
      anchor.byHand = false;
      anchor.group.visible = true;
      clearTimeout(findTimer);
      setHint(null);
    }
  }
  // each sighting firms the fit up: ease into it
  anchor.pos.lerp(tagTarget.pos, TAG_EASE);
  anchor.quat.slerp(tagTarget.quat, TAG_EASE);
  anchor.scale += (tagTarget.scale - anchor.scale) * TAG_EASE;
  applyAnchor();
}

// ?setup's panel
const setupUi = {
  panel: $('tag-setup'), fold: $('ts-fold'), tag: $('ts-tag'), scale: $('ts-scale'), scene: $('ts-scene'),
  code: $('ts-code'), actions: $('ts-actions'), copy: $('ts-copy'), link: $('ts-link'), save: $('ts-save'),
  forget: $('ts-forget'),
};
const MOVED_ENOUGH = 0.25;   // m the phone should move while seeing the tag, for distances in metres
let setupCode = '';
let setupShown = 0;
const _rel = new THREE.Vector3();
const _inv = new THREE.Quaternion();

function showSetup(now) {
  if (now - setupShown < 250) return;
  setupShown = now;
  const t = tag.pose();
  const info = window.__tag || {};
  if (!t) {
    setupUi.tag.textContent = 'Tag: not seen yet. Show it to the camera.';
    setupUi.scale.hidden = true;
  } else {
    const ago = (now - t.seenAt) / 1000;
    const measured = t.moved >= MOVED_ENOUGH;
    setupUi.tag.textContent = `Tag: seen ${t.sightings}×${ago < 1.5 ? `, ${info.distance} m away` : ', not in view now'}`
      + (measured ? '; distances measured' : '');
    setupUi.scale.hidden = measured;
    setupUi.scale.textContent = `Distances: step about or move the phone side to side with the tag in view (${Math.round(t.moved * 100)} of ${MOVED_ENOUGH * 100} cm)`;
  }

  setupCode = '';
  let placed = `Simorgh: placed by ${anchor.byHand ? 'your tap' : 'the photo'}`;
  if (t && anchor.placed) {
    // the scene in the tag's frame, in metres
    _inv.copy(t.quaternion).invert();
    _rel.copy(anchor.pos).sub(t.position).applyQuaternion(_inv).divideScalar(t.scale);
    const scene = { pos: _rel.clone(), quat: _inv.clone().multiply(anchor.quat), size: anchor.scale / t.scale };
    setupCode = tagSceneCode(scene);
    const spot = state.piece.spot.clone().applyQuaternion(scene.quat).multiplyScalar(scene.size).add(scene.pos);
    placed += `, ${(scene.size * state.piece.height).toFixed(1)} m tall, ${spot.length().toFixed(1)} m from the tag`;
    setupUi.code.textContent = setupCode;
  }
  setupUi.scene.textContent = anchor.placed ? placed
    : 'Simorgh: not placed. Point at the view in the photo, or tap the point on the ceiling it hangs from.';
  // the code and its buttons only once there is one, so the panel stays small while setting up
  const saved = !!savedTagScene();
  setupUi.code.hidden = !setupCode;
  setupUi.actions.hidden = !setupCode && !saved;
  for (const b of [setupUi.copy, setupUi.link, setupUi.save]) b.hidden = !setupCode;
  setupUi.forget.hidden = !saved;
}

async function copyText(text, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    window.prompt('Copy this:', text);
  }
  setTimeout(() => { button.textContent = label; }, 1500);
}
const testLink = () => `${location.origin}${location.pathname}?tag=${encodeURIComponent(setupCode)}`;
setupUi.copy.addEventListener('click', () => setupCode && copyText(setupCode, setupUi.copy));
setupUi.link.addEventListener('click', () => setupCode && copyText(testLink(), setupUi.link));
setupUi.save.addEventListener('click', () => {
  if (!setupCode) return;
  try {
    localStorage.setItem(TAG_SAVED, setupCode);
    setupUi.save.textContent = 'Saved';
  } catch {
    setupUi.save.textContent = 'Could not save';
  }
  setTimeout(() => { setupUi.save.textContent = 'Save on phone'; }, 2000);
});
// Hide folds the panel to its title, to see the whole scene; Show brings it back
setupUi.fold.addEventListener('click', () => {
  const folded = setupUi.panel.classList.toggle('folded');
  setupUi.fold.textContent = folded ? 'Show' : 'Hide';
  setupUi.fold.setAttribute('aria-expanded', String(!folded));
});
setupUi.forget.addEventListener('click', () => {
  try { localStorage.removeItem(TAG_SAVED); } catch { /* nothing saved */ }
  setupUi.forget.hidden = true;
});

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
// people in front of the sculpture hide it (?debug shows them magenta)
const occlusion = createOcclusion({ debug: DEBUG });
// what occlusion.js keeps clear of people: the piece, once it's placed
const placedPiece = () => (anchor.placed && state.piece ? state.piece.root : null);

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
    anchor.byTag = false;
    tagVersion = -1;
    triesLeft = TRIES;
    if (!anchor.group.children.length) anchor.group.add(state.piece.root);
    scene.add(anchor.group);
    occlusion.start({ scene, camera, canvas: ui.xrCanvas, target: placedPiece });
    if (useTag) tag.start({ camera, canvas: ui.xrCanvas });
    window.__xr = { scene, camera, renderer, anchor, tag, piece: state.piece };
  },
  onUpdate: () => {
    const now = performance.now();
    if (tagScene && !SETUP) placeFromTag();
    if (SETUP) showSetup(now);
    if (state.piece) state.piece.update((now - clockStart) / 1000, shade.light, occlusion.hides);
  },
  onCameraStatusChange: ({ status }) => {
    if (DEBUG) (window.__ev ||= []).push(['camera', status]);
    if (status === 'hasVideo' && !anchor.placed) {
      setHint(SETUP ? 'Setup: show the camera the tag, then place the Simorgh' : 'Point your camera at the view in the photo');
      clearTimeout(findTimer);
      findTimer = setTimeout(() => {
        if (!anchor.placed) setHint(`Not found? Tap the point on the ceiling it hangs from${SETUP ? '' : ` (${PLACE_TRIES} tries)`}`);
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
  setupUi.panel.hidden = !SETUP;
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
    occlusion.pipelineModule(),                          // people in front of the sculpture hide it
    ...(useTag ? [tag.pipelineModule()] : []),           // the position tag
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
  occlusion.stop();
  tag.stop();
  clearTimeout(findTimer);
  anchor.placed = false;
  anchor.byHand = false;
  anchor.byTag = false;
  anchor.group.visible = false;
  triesLeft = TRIES;
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
buildTarget('lantern', PHOTO)
  .then((t) => { state.targets = [t]; refreshStart(); })
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
