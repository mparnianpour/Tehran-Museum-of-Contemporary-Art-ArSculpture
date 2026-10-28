# Simorgh: AR sculpture, Tehran Museum of Contemporary Art

A web AR piece for the atrium of the Tehran Museum of Contemporary Art. Point a phone up at the
beam between the inner pillars (or at the photograph of that view, `lantern.jpg`) and the Simorgh,
a polished silver sculpture, hangs in the opening under the beam, held in a warm light falling
from the ceiling. The room around it dims to a deep blue and its light flickers. A printed tag in
the atrium gives every phone the same place for it.

**Live:** https://mparnianpour.github.io/Tehran-Museum-of-Contemporary-Art-ArSculpture/

**Previous version (backup):** https://mparnianpour.github.io/Tehran-Museum-of-Contemporary-Art-ArSculpture/backup/
(the piece as it was before the new photo and the tag: the view down the atrium between the
pillars, `atrium.jpg` and its three side views, hiding behind people and near things; commit `5859256`)

## Using it

1. Open the link on a phone (Safari on iPhone, Chrome on Android) and tap **Start camera**.
2. Point the camera at the position tag, at the photograph, or at the view in the photograph.
3. In the atrium itself, if neither is found after a few seconds: frame the view like the
   photograph, then tap where the Simorgh goes. You get three tries; the scene stays where the
   last one put it, and holds there as you move. It stands as far away as what you tap on (up
   to 12 m), so tapped anywhere else, say at home, it stands in that room.

The sculpture's spot and size are traced on the photograph (`SPOT`, `SCULPTURE_HEIGHT` in
`piece.js`: the middle of the circle marked on it, nine tenths of the circle's height).

## The position tag

The photograph is matched as a flat picture, so each phone places the Simorgh a little
differently, and in the building itself only from about where the photo was taken. The position
tag fixes that: a printed AprilTag (`marker/simorgh-tag-a4.pdf`) stuck in the atrium. Every phone
that sees it works out where the tag is, and puts the Simorgh in the same spot relative to it,
wherever the phone stands. The tag wins over the photograph and over taps.

Setting it up, once:

1. Print `marker/simorgh-tag-a4.pdf` at 100% (Actual size, not Fit to page). The black square
   must measure 16.0 cm; the bar under it 10.0 cm.
2. Stick it flat and upright on a wall or pillar, roughly facing where people stand, at about
   eye height, as close to where the Simorgh hangs as you can (the closer, the more exact). Tape
   all four corners. Don't move it afterwards.
3. Open the page with `?setup` added to the address, start the camera, and show it the tag. Walk
   a step or two, or move the phone from side to side, while the tag stays in view, until the
   panel says **Distances: measured**.
4. Place the Simorgh where it belongs: point at the view in the photograph, or tap the spot. The
   panel shows a code (where the Simorgh sits relative to the tag), with its height and distance
   from the tag as a check.
5. **Copy code** and send it to be built in (`TAG_SCENE` in `app.js`); from then on every phone
   uses it. Meanwhile, **Save on this phone** uses it on that phone, and **Copy test link** gives
   an address that tries it on any phone.

How it works (`tag.js`, `tag-worker.js`): several times a second the camera picture is searched
for the tag, off the main thread, and its corners are found to a fraction of a pixel. All the
sightings, each with where the phone was, are fitted together: where the tag is, which way it
faces, and how many of the AR engine's units make a metre. Up is taken from the phone, which is
why the tag has to hang upright. In a test with the tag 3-5 m away the Simorgh landed within
about 3 cm of the right spot after a few seconds; from 6 m, nearly head-on, within about 20 cm.

Once the sculpture is placed, people who come between the phone and it hide it, as in ar-test's
people occlusion: several times a second the camera picture round the sculpture goes through a
person-segmentation model (MediaPipe's selfie segmenter, in `lib/mediapipe`), and where it finds
a person the sculpture, its light and its dust aren't drawn (`occlusion.js`). It loads after the
camera starts and hides nothing until it's ready. Add `?debug` to the address to see what it
hides, in magenta. Walls, pillars and the railing never hide it: the depth tracker that tried to
was taken out, since it cut dark holes in the light when the photo placed the sculpture far off.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The page: start screen, camera view, and the `?setup` panel |
| `app.js` | The AR session: places the scene from the tag, the photograph, or where you tap |
| `piece.js` | The scene: the sculpture, the light and its pattern, dust, glints |
| `occlusion.js` | People in front of the sculpture hide it |
| `tag.js`, `tag-worker.js` | The position tag: finds it and works out where it is in the room |
| `shade.js` | The shade over the camera view (from the Turrell walls work): 55%, deep blue, flickering |
| `lantern.jpg` | The photograph the camera looks for |
| `marker/` | The position tag to print (A4 PDF) |
| `backup/` | The previous version, kept live in case this one misbehaves |
| `model/simorgh.glb` | The sculpture |
| `model/depth.onnx` | The backup's depth model: Depth Anything V2 Small, cut to 308×308 and compressed |
| `lib/` | 8th Wall engine, XRExtras, three.js, MediaPipe person segmentation, js-aruco2; ONNX Runtime Web (the backup's) |

The look is set by named constants at the top of `piece.js` (the light's source, bell shape,
warmth, the sculpture's size and height) and `shade.js` (shade, blue cast, flicker).

## Credits

AR engine: 8th Wall © Niantic Spatial, Inc., used under its [engine license](lib/8thwall/LICENSE),
provided without warranty. [three.js](lib/three/LICENSE) (MIT) and
[XRExtras](lib/xrextras/LICENSE). Person segmentation: [MediaPipe](lib/mediapipe/README.txt)
(Apache-2.0). Depth, in the backup: [Depth Anything V2 Small](model/depth-LICENSE.txt) (Apache-2.0; ONNX export
by fabio-sim/Depth-Anything-ONNX, Apache-2.0), run with [ONNX Runtime Web](lib/onnxruntime/LICENSE)
(MIT). Tag detection: [js-aruco2](lib/js-aruco2/LICENSE.txt) (MIT); the tag is AprilTag 36h11
(AprilRobotics, BSD 2-Clause).
