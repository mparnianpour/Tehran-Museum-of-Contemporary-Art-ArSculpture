# Simorgh: AR sculpture, Tehran Museum of Contemporary Art

A web AR piece for the atrium of the Tehran Museum of Contemporary Art. Point a phone at the
atrium (or at the photograph of it, `atrium.jpg`) and the Simorgh, a polished silver sculpture,
hangs between the two inner pillars, held in a warm light falling from the ceiling. The room
around it dims to a deep blue and its light flickers.

**Live:** https://mparnianpour.github.io/Tehran-Museum-of-Contemporary-Art-ArSculpture/

**Previous version (backup):** https://mparnianpour.github.io/Tehran-Museum-of-Contemporary-Art-ArSculpture/backup/
(the piece as it was before the depth tracker came back: hiding behind people only, commit `c9c299e`)

## Using it

1. Open the link on a phone (Safari on iPhone, Chrome on Android) and tap **Start camera**.
2. Point the camera at the photograph, or at the atrium framed like the photograph.
3. In the atrium itself, if it isn't found after a few seconds: frame the pillars like the
   photograph, then tap the spot between them. You get three tries; the scene stays where the
   last one put it, and holds there as you move. It stands as far away as what you tap on (up
   to 12 m), so tapped anywhere else, say at home, it stands in that room.

People walking along the balconies, or across the ceiling light, don't stop the photograph
being found: those areas are softened in the image the camera looks for (`PEOPLE` in `app.js`).

`atrium.jpg` is the parent photograph: the scene is placed from it. Three more photos from
nearby spots on the ramp (`views/`) help find the atrium from more places. Each is tied to
`atrium.jpg` by the inner pillars (`TIE` and `VIEW_SHOTS` in `piece.js`), so whichever one the
camera sees, the sculpture lands in the same place.

Once the sculpture is placed, real things that come between the phone and it hide it:
- **People**, as in ar-test's people occlusion: several times a second the camera picture round the
  sculpture goes through a person-segmentation model (MediaPipe's selfie segmenter, in
  `lib/mediapipe`), and where it finds a person the sculpture, its light and its dust aren't drawn
  (`occlusion.js`).
- **Other things clearly in front of it** (the big pillars beside you, the railing), from the depth
  tracker (`depth.js`): a depth model guesses how near each part of the view is, and the points the
  AR engine has tracked in the room turn that guess into distances. It hides only what is at most
  60% as far away as the sculpture, only when the guess and the tracked points agree well, and only
  where a spot reads as in front in two guesses running, so walls and the ceiling the light falls
  on don't flicker into it. The same distances tell how far away a tapped spot is.

Both load after the camera starts (about 57 MB the first time) and hide nothing until they're
ready. Add `?debug` to the address to see what they hide: people in magenta, other things in
orange.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The page: start screen and camera view |
| `app.js` | The AR session: finds the photograph, or places the scene where you tap |
| `piece.js` | The scene: the sculpture, the light and its pattern, dust, glints |
| `occlusion.js` | People in front of the sculpture hide it |
| `depth.js` | The depth tracker: other things clearly in front hide it; how far away a tapped spot is |
| `shade.js` | The shade over the camera view (from the Turrell walls work): 55%, deep blue, flickering |
| `atrium.jpg` | The photograph the camera looks for |
| `views/` | More photos of the atrium from nearby spots, found as well |
| `backup/` | The previous version, kept live in case this one misbehaves |
| `model/simorgh.glb` | The sculpture |
| `model/depth.onnx` | The depth model: Depth Anything V2 Small, cut to 308×308 and compressed |
| `lib/` | 8th Wall engine, XRExtras, three.js, MediaPipe person segmentation, ONNX Runtime Web |

The look is set by named constants at the top of `piece.js` (the light's source, bell shape,
warmth, the sculpture's size and height) and `shade.js` (shade, blue cast, flicker).

## Credits

AR engine: 8th Wall © Niantic Spatial, Inc., used under its [engine license](lib/8thwall/LICENSE),
provided without warranty. [three.js](lib/three/LICENSE) (MIT) and
[XRExtras](lib/xrextras/LICENSE). Person segmentation: [MediaPipe](lib/mediapipe/README.txt)
(Apache-2.0). Depth: [Depth Anything V2 Small](model/depth-LICENSE.txt) (Apache-2.0; ONNX export
by fabio-sim/Depth-Anything-ONNX, Apache-2.0), run with [ONNX Runtime Web](lib/onnxruntime/LICENSE)
(MIT).
