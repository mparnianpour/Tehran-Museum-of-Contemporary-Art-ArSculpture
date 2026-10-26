// piece.js
// What appears on the photograph: the Simorgh standing between the two inner pillars, in a
// warm light falling from the ceiling right above it like a downlight on a wall, with dust
// drifting in the beam.
//
// Image space: the tracked part of the photo is 1 unit wide, centred on the origin, in the XY
// plane (+Y = up the photo) with +Z pointing out of it, toward the viewer.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ---------------------------------------------------------------------------
// The photograph (atrium.jpg). 8th Wall tracks its centre 3:4 band.
// ---------------------------------------------------------------------------
const W = 721;
const H = 1280;
const CROP_H = Math.round(W / 0.75);
const CROP_TOP = Math.round((H - CROP_H) / 2);
export const PHOTO = { src: 'atrium.jpg', width: W, height: H, cropTop: CROP_TOP, cropHeight: CROP_H };

// A pixel of the photo -> image space.
const at = (x, y, z = 0) => new THREE.Vector3((x - W / 2) / W, (CROP_TOP + CROP_H / 2 - y) / W, z);

// ---------------------------------------------------------------------------
// More photos of the atrium, from other spots on the ramp (views/, each already cut to 3:4,
// 720×960). Seeing any of them places the piece too. Each is tied to atrium.jpg through the
// inner pillars, the plane the sculpture hangs in: the light fixture on the beam between their
// tops, and the gap between them on the rows below it (photo pixels; atrium.jpg's in TIE).
// ---------------------------------------------------------------------------
const TIE = { light: [362, 315], gap: [306, 410] };
const VIEW_SHOTS = [
  { name: 'view-1', src: 'views/view-1.jpg', light: [355, 226], gap: [293, 418] },
  { name: 'view-2', src: 'views/view-2.jpg', light: [374, 10], gap: [307, 436] },
  { name: 'view-3', src: 'views/view-3.jpg', light: [358, 154], gap: [299, 413] },
];
const VIEW_W = 720;
const VIEW_H = 960;

// toView: a point of atrium.jpg's image space -> the view's (p × scale + offset)
export const VIEWS = VIEW_SHOTS.map((v) => {
  const k = (v.gap[1] - v.gap[0]) / (TIE.gap[1] - TIE.gap[0]);   // view pixels per atrium.jpg pixel
  const scale = (k * W) / VIEW_W;
  const light = new THREE.Vector3((v.light[0] - VIEW_W / 2) / VIEW_W, (VIEW_H / 2 - v.light[1]) / VIEW_W, 0);
  const offset = light.sub(at(...TIE.light).multiplyScalar(scale));
  return { name: v.name, src: v.src, width: VIEW_W, height: VIEW_H, cropTop: 0, cropHeight: VIEW_H, toView: { scale, offset } };
});

// ---------------------------------------------------------------------------
// Settings (all in photo pixels, traced from the photo)
// ---------------------------------------------------------------------------
const MODEL_URL = new URL('model/simorgh.glb', import.meta.url).href;
const GAP = [308, 409];          // facing edges of the two inner pillars
const MODEL_Y = 530;             // the sculpture's centre
const FILL = 0.92;               // share of the gap the sculpture's width takes

// Pillars that come between a visitor and the sculpture as they walk round the atrium, each
// traced as [y, left edge, right edge] on two rows and running from `top` to `bottom`.
// The two big pillars beside the viewpoint hide everything behind them. Their outer edges lie
// past the photo's sides: a guess at their width (about 2.5 inner pillars).
const NEAR_PILLARS = [
  { rows: [[200, -272, 145], [1121, -279, 138]], top: -1500, bottom: 2800 },
  { rows: [[200, 569, 986], [1121, 579, 996]], top: -1500, bottom: 2800 },
];
const NEAR_SHARE = 0.33;         // how far away the big pillars stand, as a share of the inner pillars'
                                 // distance (measured from photos of the atrium taken at two distances)
// The two inner pillars, either side of the sculpture, hide the sculpture itself; the light
// still falls on them.
const INNER_PILLARS = [
  { rows: [[360, 251, 306], [1121, 248, 305]], top: 0, bottom: 1150 },
  { rows: [[360, 411, 469], [1121, 413, 472]], top: 0, bottom: 1150 },
];
const VIEW_DISTANCE = 1.2;       // where atrium.jpg was taken from, in image widths in front of it
                                 // (a phone camera's 44° across the photo)

const SOURCE = [359, 150];       // the light, on the ceiling right above the sculpture
const BEAM_ANGLE = 13;           // the beam's half-angle, degrees
const CONE_TAN = Math.tan(THREE.MathUtils.degToRad(BEAM_ANGLE));
const OPENING = 6;               // the light's own size where it leaves the ceiling
// The light's pattern, shaped like profile 25 (photo pixels):
const BELL_WIDTH = 115;          // half-width of the bright bell once it has opened out
const BELL_TOP = 90;             // how far below the source it takes to open (the rounded top)
const BELL_FADE = 300;           // the bell dims by e (about 2.7×) every this far down
const COLUMN_FADE = 480;         // the brighter column down the middle lasts longer
const SPILL_WIDTH = 210;         // the faint wide glow round it
const LIGHT_END = 760;           // how far down the light has faded out completely
const WARMTH = 0.9;              // how warm the light is: 1 = full sunlight colour, 0.9 = 10% less
// A colour with its warmth scaled by WARMTH (pulled toward the grey of the same brightness).
function warm(r, g, b) {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return [r, g, b].map((v) => l + (v - l) * WARMTH);
}
const rgba = (r, g, b, a) => `rgba(${warm(r, g, b).map(Math.round).join(',')},${a})`;
const CONE_CORE = new THREE.Color(...warm(1.0, 0.91, 0.70));   // sunlight at the heart of the cone
const CONE_HAZE = new THREE.Color(...warm(0.95, 0.68, 0.36));  // golden lit haze at its edges
const LIGHT_STRENGTH = 0.75;
const SOURCE_SIZE = [84, 24];    // the bright opening on the ceiling, seen from below (width, height)
const DUST = 260;                // motes drifting in the light
const DUST_SIZE = 3.2;           // photo pixels
const SPOT_INTENSITY = 5;        // the cone's real light on the sculpture
const ENV_INTENSITY = 1.15;      // the room's light on the sculpture, before it flickers
const LIGHT_ON_SILVER = 1.4;     // how brightly the silver shows the light from above
const GLINTS = 6;                // sparkles where the silver reflects the light straight out
const GLINT_SIZE = 30;           // photo pixels
const HALO = 0.3;                // light scattered off the sculpture into the haze

// ---------------------------------------------------------------------------
// The light, like a downlight's pattern on a wall (profile 25 in the reference sheet): a small
// source on the ceiling, a bright bell of light right under it with a rounded top, a brighter
// column carrying on down its middle as the bell fades, and a faint wide glow round it all.
// Drawn on the wall behind the sculpture.
// ---------------------------------------------------------------------------
const NOISE = `
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                 mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                 mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    a *= 0.5;
  }
  return s;
}`;

const LIGHT_VS = `
varying vec3 vPos;
varying vec2 vUv;
void main() {
  vPos = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LIGHT_FS = `
uniform float time;
uniform vec2 source;       // the light on the ceiling
uniform float bellWidth;   // see the settings of the same names (image units)
uniform float bellTop;
uniform float bellFade;
uniform float columnFade;
uniform float spillWidth;
uniform float end;
uniform vec3 core;
uniform vec3 haze;
uniform float strength;
varying vec3 vPos;
varying vec2 vUv;
${NOISE}
void main() {
  float h = source.y - vPos.y;                      // how far below the source
  float x = abs(vPos.x - source.x);
  float below = smoothstep(-0.004, 0.006, h);
  // the bell's edge rounds over the top like a dome, then runs down almost straight, opening slowly
  float t = clamp(h / bellTop, 0.0, 1.0);
  float w = bellWidth * (sqrt(1.0 - (1.0 - t) * (1.0 - t)) + 0.12 * max(h - bellTop, 0.0) / bellTop) + 0.002;
  float bell = (1.0 - smoothstep(w * 0.4, w * 1.15, x)) * exp(-max(h, 0.0) / bellFade) * below;
  float column = exp(-pow(x / (w * 0.32), 2.0)) * exp(-max(h, 0.0) / columnFade) * below;
  float spill = exp(-pow(x / spillWidth, 2.0)) * exp(-max(h, 0.0) / (bellFade * 1.3)) * smoothstep(-0.02, 0.02, h);
  float fade = 1.0 - smoothstep(end * 0.55, end, h);
  float sides = smoothstep(0.0, 0.1, vUv.x) * smoothstep(1.0, 0.9, vUv.x);   // the card's edges never show
  float mist = 0.9 + 0.2 * fbm(vPos * 8.0 + vec3(0.0, time * 0.04, time * 0.03));
  float lit = (bell * (0.7 + 0.6 * column) + 0.5 * column + 0.3 * spill) * fade * sides * mist;
  vec3 col = mix(haze, core, clamp(0.3 + 0.7 * (bell + column), 0.0, 1.0));
  gl_FragColor = vec4(col * lit * strength, 1.0);
}`;

// The light on the wall behind the sculpture: a card in the photo's plane, hanging from `source`.
function createLight(source, wallZ) {
  const end = LIGHT_END / W;
  const halfWidth = Math.min((SPILL_WIDTH * 1.9) / W, 0.46);
  const above = 30 / W;
  const g = new THREE.PlaneGeometry(halfWidth * 2, end + above);
  g.translate(source.x, source.y + above - (end + above) / 2, wallZ);
  const material = new THREE.ShaderMaterial({
    vertexShader: LIGHT_VS,
    fragmentShader: LIGHT_FS,
    uniforms: {
      time: { value: 0 },
      source: { value: new THREE.Vector2(source.x, source.y) },
      bellWidth: { value: BELL_WIDTH / W },
      bellTop: { value: BELL_TOP / W },
      bellFade: { value: BELL_FADE / W },
      columnFade: { value: COLUMN_FADE / W },
      spillWidth: { value: SPILL_WIDTH / W },
      end: { value: end },
      core: { value: CONE_CORE },
      haze: { value: CONE_HAZE },
      strength: { value: LIGHT_STRENGTH },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

// ---------------------------------------------------------------------------
// Dust: motes drifting slowly down through the light, catching it as they turn.
// Moved on the GPU; each mote has three random numbers.
// ---------------------------------------------------------------------------
const DUST_VS = `
attribute vec3 seed;
uniform float time;
uniform vec3 apex;
uniform float spread;
uniform float opening;
uniform float coneLength;
uniform float zFloor;
uniform float size;
uniform float pixelScale;    // half the drawing buffer's height, in pixels
varying float vGlow;
void main() {
  float h = fract(seed.x + time * (0.004 + 0.006 * seed.z));
  float a = seed.y * 6.2832 + sin(time * 0.21 + seed.z * 9.0) * 0.4;
  float r = sqrt(fract(seed.z * 7.13)) * 0.9;
  float down = h * coneLength;
  float R = r * (opening + spread * down);
  vec3 p = apex + vec3(cos(a) * R, -down, sin(a) * R);
  p.x += sin(time * 0.37 + seed.y * 20.0) * 0.004;
  p.z = max(p.z, zFloor);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, size * (0.6 + 0.8 * seed.z) * projectionMatrix[1][1] * pixelScale / -mv.z);
  float twinkle = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(time * (0.8 + 2.0 * seed.x) + seed.y * 40.0), 2.0);
  vGlow = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.55, 0.9, h)) * (1.0 - r * 0.8) * twinkle * exp(-h * 1.2);
}`;

const DUST_FS = `
uniform vec3 color;
varying float vGlow;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = pow(max(1.0 - d, 0.0), 2.0);
  gl_FragColor = vec4(color * a * vGlow, 1.0);
}`;

function createDust(apex, length, zFloor) {
  const seeds = new Float32Array(DUST * 3);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST * 3), 3));   // placed in the shader
  g.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
  const uniforms = {
    time: { value: 0 },
    apex: { value: apex },
    spread: { value: CONE_TAN },
    opening: { value: OPENING / W },
    coneLength: { value: length },
    zFloor: { value: zFloor },
    size: { value: DUST_SIZE / W },
    pixelScale: { value: 500 },
    color: { value: CONE_CORE },
  };
  const points = new THREE.Points(g, new THREE.ShaderMaterial({
    vertexShader: DUST_VS,
    fragmentShader: DUST_FS,
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  points.frustumCulled = false;
  points.renderOrder = 3;
  const buffer = new THREE.Vector2();
  points.onBeforeRender = (renderer) => { uniforms.pixelScale.value = renderer.getDrawingBufferSize(buffer).y / 2; };
  return points;
}

// The source: a soft white glow where the light comes through the ceiling (drawn round,
// squashed by the sprite into an opening seen from below).
function sourceTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.00, rgba(255, 253, 240, 1));
  grad.addColorStop(0.08, rgba(255, 244, 215, 0.9));
  grad.addColorStop(0.25, rgba(255, 215, 150, 0.35));
  grad.addColorStop(0.60, rgba(255, 190, 110, 0.08));
  grad.addColorStop(1.00, rgba(255, 175, 90, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// The light on the silver: inside the cone, the faces turned up to the source brighten and
// the curves throw highlights back from it; underneath stays in the room's dim light.
// ---------------------------------------------------------------------------
const SILVER_VS_PARS = `
uniform mat4 imageFromWorld;
varying vec3 vImgPos;
varying vec3 vImgNormal;`;

const SILVER_VS = `
vImgPos = (imageFromWorld * modelMatrix * vec4(transformed, 1.0)).xyz;
vImgNormal = mat3(imageFromWorld) * mat3(modelMatrix) * objectNormal;`;

const SILVER_FS_PARS = `
uniform vec3 coneApex;      // the source, in image space
uniform float coneSpread;   // tan of the cone's half-angle
uniform float coneOpening;  // its radius where it leaves the ceiling
uniform vec3 coneCam;       // the camera, in image space
uniform vec3 coneTint;
uniform float lightOnSilver;
uniform vec3 pillarMin[${INNER_PILLARS.length}];   // the inner pillars, as boxes in image space
uniform vec3 pillarMax[${INNER_PILLARS.length}];
varying vec3 vImgPos;
varying vec3 vImgNormal;

// Whether an inner pillar stands between the camera and this point of the silver.
bool behindPillar() {
  vec3 d = vImgPos - coneCam;
  d = mix(vec3(1e-6), d, step(1e-6, abs(d)));
  for (int i = 0; i < ${INNER_PILLARS.length}; i++) {
    vec3 a = (pillarMin[i] - coneCam) / d;
    vec3 b = (pillarMax[i] - coneCam) / d;
    vec3 lo = min(a, b);
    vec3 hi = max(a, b);
    float enter = max(max(lo.x, lo.y), lo.z);
    float leave = min(min(hi.x, hi.y), hi.z);
    if (enter < leave && leave > 0.0 && enter < 1.0) return true;
  }
  return false;
}

vec3 coneLight() {
  vec3 N = normalize(vImgNormal);
  vec3 V = normalize(coneCam - vImgPos);
  vec3 toSource = coneApex - vImgPos;
  float off = length(toSource.xz) / max(coneOpening + toSource.y * coneSpread, 1e-4);
  float inside = (1.0 - smoothstep(0.7, 1.05, off)) * step(0.0, toSource.y);
  vec3 L = normalize(toSource);
  float facing = max(dot(N, L), 0.0);
  float glint = pow(max(dot(reflect(-L, N), V), 0.0), 24.0);
  return coneTint * inside * (0.45 * facing + 2.4 * glint) * lightOnSilver;
}`;

function lightSilverFromAbove(materials, uniforms) {
  for (const m of materials) {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>' + SILVER_VS_PARS)
        .replace('#include <fog_vertex>', '#include <fog_vertex>' + SILVER_VS);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>' + SILVER_FS_PARS)
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (behindPillar()) discard;')
        .replace('#include <opaque_fragment>', 'outgoingLight += coneLight();\n#include <opaque_fragment>');
    };
    m.customProgramCacheKey = () => 'silver-in-cone';
  }
}

// ---------------------------------------------------------------------------
// The pillars, as blocks in image space. Each is laid out from the photo's own viewpoint,
// VIEW_DISTANCE straight out from its centre: from there a block covers exactly the pillar
// traced on the photo, and as a visitor walks it slides across the view as the pillar does.
// Square in section: as deep as it is wide.
// ---------------------------------------------------------------------------
function pillarCorners(p, zMid) {
  const D = VIEW_DISTANCE;
  const [[y0, l0, r0], [y1, l1, r1]] = p.rows;
  const edgesAt = (y) => {
    const k = (y - y0) / (y1 - y0);
    return [l0 + (l1 - l0) * k, r0 + (r1 - r0) * k];
  };
  const shrink = (D - zMid) / D;                 // photo size -> size at the pillar's depth
  const half = (((r0 - l0) / W) * shrink) / 2;   // half its width, and so half its depth
  const zFront = zMid + half;
  const zBack = zMid - half;
  // an edge seen against the middle of the view shows the pillar's back corner, an outer edge its front one
  const edgeX = (x, isRight) => {
    const u = (x - W / 2) / W;
    const z = (isRight ? u < 0 : u > 0) ? zBack : zFront;
    return (u * (D - z)) / D;
  };
  const corners = [];
  for (const y of [p.top, p.bottom]) {
    const [l, r] = edgesAt(y);
    const v = ((CROP_TOP + CROP_H / 2 - y) / W) * shrink;
    for (const z of [zFront, zBack]) corners.push(new THREE.Vector3(edgeX(l, false), v, z), new THREE.Vector3(edgeX(r, true), v, z));
  }
  return corners;   // [top, bottom] × [front, back] × [left, right]
}

const BLOCK_FACES = [[0, 1, 4, 5], [2, 3, 6, 7], [0, 2, 4, 6], [1, 3, 5, 7], [0, 1, 2, 3], [4, 5, 6, 7]];
function blockGeometry(corners) {
  const g = new THREE.BufferGeometry().setFromPoints(corners);
  g.setIndex(BLOCK_FACES.flatMap(([a, b, c, d]) => [a, b, c, b, d, c]));
  return g;
}

// Whether the line from a to b passes through the box.
function crosses(a, b, box) {
  let enter = 0;
  let leave = 1;
  for (const k of ['x', 'y', 'z']) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) {
      if (a[k] < box.min[k] || a[k] > box.max[k]) return false;
      continue;
    }
    const t0 = (box.min[k] - a[k]) / d;
    const t1 = (box.max[k] - a[k]) / d;
    enter = Math.max(enter, Math.min(t0, t1));
    leave = Math.min(leave, Math.max(t0, t1));
    if (enter > leave) return false;
  }
  return true;
}

// Glints: the spots on the silver that throw the light straight back at someone in front of
// the photo. Found once from the model's vertices; each keeps its reflected direction, so
// it only sparkles when the phone is in line with it.
function findGlints(model, apex, count) {
  const found = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const L = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  model.traverse((o) => {
    if (!o.isMesh) return;
    nm.getNormalMatrix(o.matrixWorld);
    const pos = o.geometry.attributes.position;
    const nor = o.geometry.attributes.normal;
    for (let i = 0; i < pos.count; i += 2) {
      p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      if (n.z <= 0.2) continue;
      L.subVectors(apex, p);
      if (L.y <= 0 || Math.hypot(L.x, L.z) > (OPENING / W + L.y * CONE_TAN) * 0.9) continue;
      L.normalize();
      const r = n.clone().multiplyScalar(2 * n.dot(L)).sub(L);   // the light, reflected
      if (r.z > 0.93) found.push({ pos: p.clone(), dir: r, score: r.z });
    }
  });
  // the best few, spread out over the sculpture
  found.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const g of found) {
    if (picked.length >= count) break;
    if (picked.every((q) => q.pos.distanceTo(g.pos) > 0.016)) picked.push(g);
  }
  return picked;
}

function glintTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const core = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  core.addColorStop(0.00, 'rgba(255,255,255,1)');
  core.addColorStop(0.07, 'rgba(255,255,255,0.9)');
  core.addColorStop(0.22, rgba(255, 230, 180, 0.3));
  core.addColorStop(1.00, rgba(255, 205, 140, 0));
  g.fillStyle = core;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter';
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [[0, 64, 128, 64, 0, 63, 128, 2], [64, 0, 64, 128, 63, 0, 2, 128]]) {
    const ray = g.createLinearGradient(x0, y0, x1, y1);
    ray.addColorStop(0, 'rgba(255,255,255,0)');
    ray.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    ray.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = ray;
    g.fillRect(rx, ry, rw, rh);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.0, rgba(255, 225, 170, 0.55));
  grad.addColorStop(0.4, rgba(255, 195, 120, 0.2));
  grad.addColorStop(1.0, rgba(255, 170, 90, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Reflections: the polished silver mirrors a dim blue room with pale blue lights in it.
// Kept alive with its PMREM generator: 8th Wall restores the last-used GL program between frames.
// ---------------------------------------------------------------------------
export function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment(renderer);
  const tint = new THREE.Color(0.30, 0.45, 1.0);
  room.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.isMeshBasicMaterial) o.material.color.multiply(tint).multiplyScalar(1.2);   // the lights
    else o.material.color.setRGB(0.05, 0.08, 0.22);                                            // walls and boxes
  });
  return pmrem.fromScene(room, 0.04).texture;
}

// ---------------------------------------------------------------------------
// The piece
// ---------------------------------------------------------------------------
export async function loadPiece({ onProgress, debug = false } = {}) {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL, (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });
  const model = gltf.scene;
  const materials = new Set();
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    materials.add(o.material);
  });

  // Fit the sculpture's width to the gap between the pillars, centred between them,
  // its back resting on the photo.
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const s = (((GAP[1] - GAP[0]) * FILL) / W) / size.x;
  const spot = at((GAP[0] + GAP[1]) / 2, MODEL_Y);
  const depth = size.z * s;
  model.scale.setScalar(s);
  model.position.set(spot.x - centre.x * s, spot.y - centre.y * s, -box.min.z * s + 0.002);

  const root = new THREE.Group();
  root.add(model);
  root.updateMatrixWorld(true);

  // The light falls from the source on the wall behind the sculpture; dust drifts in the air
  // in front of it, in the beam, down through the sculpture's depth.
  const z = depth / 2 + 0.002;
  const apex = at(SOURCE[0], SOURCE[1], z);
  const wallLight = createLight(apex, 0.0015);
  const dust = createDust(apex, LIGHT_END / W, 0.002);
  root.add(wallLight, dust);

  // The pillars. The big ones beside the viewpoint only fill the depth buffer, so whatever is
  // behind them isn't drawn; the inner ones hide the sculpture in its own shader (behindPillar),
  // so the light still falls on them. ?debug shows them: near blue, inner pink.
  const blocks = [
    ...NEAR_PILLARS.map((p) => ({ corners: pillarCorners(p, VIEW_DISTANCE * (1 - NEAR_SHARE)), near: true })),
    ...INNER_PILLARS.map((p) => ({ corners: pillarCorners(p, z), near: false })),
  ].map((b) => ({ ...b, geometry: blockGeometry(b.corners), box: new THREE.Box3().setFromPoints(b.corners) }));
  const hider = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  for (const b of blocks) {
    if (b.near) {
      const mesh = new THREE.Mesh(b.geometry, hider);
      mesh.renderOrder = -1;   // before everything it hides
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    if (debug) {
      const shown = new THREE.Mesh(b.geometry, new THREE.MeshBasicMaterial({
        color: b.near ? 0x3a7bff : 0xff3ad0, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }));
      shown.renderOrder = 5;
      shown.frustumCulled = false;
      root.add(shown);
    }
  }
  const inner = blocks.filter((b) => !b.near).map((b) => b.box);

  const source = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sourceTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
  }));
  source.position.copy(apex).setZ(z + 0.004);
  source.scale.set(SOURCE_SIZE[0] / W, SOURCE_SIZE[1] / W, 1);
  source.renderOrder = 3;
  root.add(source);

  // its real light on the sculpture: steady, not part of the flickering room
  const target = new THREE.Object3D();
  target.position.copy(spot).setZ(z);
  const spotLight = new THREE.SpotLight(new THREE.Color(...warm(1.0, 0.91, 0.76)), SPOT_INTENSITY, 0, THREE.MathUtils.degToRad(BEAM_ANGLE) * 1.4, 0.6, 0);
  spotLight.position.copy(apex);
  spotLight.target = target;
  root.add(target, spotLight);

  // The light on the silver
  const silver = {
    imageFromWorld: { value: new THREE.Matrix4() },
    coneApex: { value: apex },
    coneSpread: { value: CONE_TAN },
    coneOpening: { value: OPENING / W },
    coneCam: { value: new THREE.Vector3() },
    coneTint: { value: CONE_CORE },
    lightOnSilver: { value: LIGHT_ON_SILVER },
    pillarMin: { value: inner.map((box) => box.min) },
    pillarMax: { value: inner.map((box) => box.max) },
  };
  lightSilverFromAbove(materials, silver);
  // image space follows the photo, wherever the AR session has put it
  const syncSilver = (renderer, scene, camera) => {
    silver.imageFromWorld.value.copy(root.matrixWorld).invert();
    silver.coneCam.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(silver.imageFromWorld.value);
  };
  model.traverse((o) => { if (o.isMesh) o.onBeforeRender = syncSilver; });

  const glintMap = glintTexture();
  const glints = findGlints(model, apex, GLINTS).map((g, i) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glintMap, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, toneMapped: false,
    }));
    sprite.position.copy(g.pos);
    sprite.renderOrder = 4;
    root.add(sprite);
    return { sprite, dir: g.dir, phase: i * 2.399 };
  });

  // light scattered off the sculpture into the haze, glowing behind it
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: HALO,
  }));
  halo.position.copy(spot).setZ(0.001);
  halo.scale.setScalar(size.y * s * 1.7);
  halo.renderOrder = 1;
  root.add(halo);

  const toCam = new THREE.Vector3();
  return {
    root,
    spot,   // the sculpture's centre, in image space

    // time in seconds; light = the room's light this frame (1 = steady), from the shade's flicker
    update(time, light) {
      wallLight.material.uniforms.time.value = time;
      dust.material.uniforms.time.value = time;
      for (const m of materials) m.envMapIntensity = ENV_INTENSITY * light;
      // a glint shows when the phone is in line with its reflection, and twinkles; a pillar in
      // the way hides it (glints are drawn over everything, so they're checked here)
      for (const g of glints) {
        toCam.copy(silver.coneCam.value).sub(g.sprite.position).normalize();
        const aligned = Math.pow(Math.max(toCam.dot(g.dir), 0), 6);
        const twinkle = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(time * 2.1 + g.phase), 3);
        const hidden = blocks.some((b) => crosses(silver.coneCam.value, g.sprite.position, b.box));
        const k = hidden ? 0 : aligned * twinkle;
        g.sprite.material.opacity = k;
        g.sprite.scale.setScalar((GLINT_SIZE / W) * (0.5 + 0.5 * k));
        g.sprite.material.rotation = time * 0.3 + g.phase;
      }
    },
  };
}
