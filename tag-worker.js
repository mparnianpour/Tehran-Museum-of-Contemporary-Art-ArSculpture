// tag-worker.js
// Looks for the position tag in camera pictures sent by tag.js, off the main thread so the view
// doesn't stutter. Replies with each tag found: its id, the bits read wrong, and its corners in
// the picture's pixels (top left, top right, bottom right, bottom left of the printed tag).

importScripts('lib/js-aruco2/cv.js', 'lib/js-aruco2/aruco.js', 'lib/js-aruco2/apriltag_36h11.js');

// A tag read with more wrong bits than this is ignored: 36h11 codes differ in 11 bits or more, so
// 3 still corrects a smudge or a glare spot, but a random dark square almost never passes.
const MAX_ERRORS = 3;
const detector = new AR.Detector({ dictionaryName: 'APRILTAG_36h11', maxHammingDistance: MAX_ERRORS + 1 });

// The grey picture at a point between pixels.
function sample(grey, x, y) {
  const w = grey.width;
  const x0 = Math.max(0, Math.min(w - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(grey.height - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const i = y0 * w + x0;
  const d = grey.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}

// The detector's corners lie on whole pixels, inside the black square. Each edge is found again
// to a fraction of a pixel, where the picture crosses halfway from the black inside to the white
// outside, at points along it; a line is fitted through them, and the corners are where the
// lines meet. Corners go round clockwise on the picture, so each edge's outside is to its left.
function refineCorners(grey, corners) {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 8) return corners;
    const ex = (b.x - a.x) / len;
    const ey = (b.y - a.y) / len;
    const nx = ey;                       // outward
    const ny = -ex;
    const reach = Math.max(2.5, len / 16);
    const points = [];
    const steps = Math.min(24, Math.floor(len / 3));
    for (let k = 1; k < steps; k++) {
      const s = 0.12 + (0.76 * k) / steps;
      const px = a.x + (b.x - a.x) * s;
      const py = a.y + (b.y - a.y) * s;
      const dark = sample(grey, px - nx * reach, py - ny * reach);
      const light = sample(grey, px + nx * reach, py + ny * reach);
      if (light - dark < 30) continue;   // no clear edge here (glare, shadow)
      const mid = (dark + light) / 2;
      let prev = dark;
      for (let t = -reach + 0.25; t <= reach; t += 0.25) {
        const v = sample(grey, px + nx * t, py + ny * t);
        if (v >= mid) {
          const at = t - 0.25 + (0.25 * (mid - prev)) / Math.max(v - prev, 1e-6);
          points.push([px + nx * at, py + ny * at]);
          break;
        }
        prev = v;
      }
    }
    if (points.length < 4) return corners;
    // the line through them: their centre and main direction
    let mx = 0, my = 0;
    for (const [x, y] of points) { mx += x; my += y; }
    mx /= points.length; my /= points.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of points) {
      sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ x: mx, y: my, dx: Math.cos(angle), dy: Math.sin(angle) });
  }
  const refined = [];
  for (let i = 0; i < 4; i++) {
    const p = lines[(i + 3) % 4];        // the edge coming into corner i
    const q = lines[i];                  // the edge leaving it
    const det = p.dx * q.dy - p.dy * q.dx;
    if (Math.abs(det) < 1e-6) return corners;
    const t = ((q.x - p.x) * q.dy - (q.y - p.y) * q.dx) / det;
    const c = { x: p.x + p.dx * t, y: p.y + p.dy * t };
    if (Math.hypot(c.x - corners[i].x, c.y - corners[i].y) > 4) return corners;   // something went wrong
    refined.push(c);
  }
  return refined;
}

self.onmessage = ({ data }) => {
  const { id, width, height, pixels } = data;
  let tags = [];
  try {
    tags = detector.detect({ width, height, data: new Uint8ClampedArray(pixels) }).map((m) => ({
      id: m.id,
      errors: m.hammingDistance,
      corners: refineCorners(detector.grey, m.corners).map((c) => [c.x, c.y]),
    }));
  } catch (e) {
    console.warn('[tag] detection failed for this picture', e);
  }
  self.postMessage({ id, tags, pixels }, [pixels]);
};
