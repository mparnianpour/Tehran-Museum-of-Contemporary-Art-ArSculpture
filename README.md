# Simorgh: AR sculpture, Tehran Museum of Contemporary Art

A web AR piece for the atrium of the Tehran Museum of Contemporary Art. Point a phone at the
atrium (or at the photograph of it, `atrium.jpg`) and the Simorgh, a polished silver sculpture,
hangs between the two inner pillars, held in a warm light falling from the ceiling. The room
around it dims to a deep blue and its light flickers.

**Live:** https://mparnianpour.github.io/Tehran-Museum-of-Contemporary-Art-ArSculpture/

**Previous version (backup):** https://mparnianpour.github.io/Tehran-Museum-of-Contemporary-Art-ArSculpture/backup/
(the piece as it was before real things could hide it, commit `539ccb9`)

## Using it

1. Open the link on a phone (Safari on iPhone, Chrome on Android) and tap **Start camera**.
2. Point the camera at the photograph, or at the atrium framed like the photograph.
3. In the atrium itself, if it isn't found after a few seconds: frame the pillars like the
   photograph, then tap the spot between them. You get three tries; the scene stays where the
   last one put it, and holds there as you move.

People walking along the balconies, or across the ceiling light, don't stop the photograph
being found: those areas are softened in the image the camera looks for (`PEOPLE` in `app.js`).

`atrium.jpg` is the parent photograph: the scene is placed from it. Three more photos from
nearby spots on the ramp (`views/`) help find the atrium from more places. Each is tied to
`atrium.jpg` by the inner pillars (`TIE` and `VIEW_SHOTS` in `piece.js`), so whichever one the
camera sees, the sculpture lands in the same place.

Once the sculpture is placed, real things that come in front of it hide it: people, pillars,
the railing. A few times a second a depth model guesses how near each part of the camera view
is, and the points the AR engine has tracked in the room turn that guess into distances; what
is clearly nearer than the sculpture (at most 60% as far away) is drawn over it
(`occlusion.js`). It needs the model to load (about 45 MB the first time, after the camera
starts) and enough tracked points in view, so it starts a little after the sculpture appears;
until then, and on phones where it can't run, the sculpture simply shows as before. Add
`?debug` to the address to see, tinted red, what would hide the sculpture.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The page: start screen and camera view |
| `app.js` | The AR session: finds the photograph, or places the scene where you tap |
| `piece.js` | The scene: the sculpture, the light and its pattern, dust, glints |
| `occlusion.js` | Real things in front of the sculpture hide it |
| `shade.js` | The shade over the camera view (from the Turrell walls work): 55%, deep blue, flickering |
| `atrium.jpg` | The photograph the camera looks for |
| `views/` | More photos of the atrium from nearby spots, found as well |
| `backup/` | The previous version, kept live in case this one misbehaves |
| `model/simorgh.glb` | The sculpture |
| `model/depth.onnx` | The depth model: Depth Anything V2 Small, cut to 308×308 and compressed |
| `lib/` | 8th Wall engine, XRExtras, three.js, ONNX Runtime Web |

The look is set by named constants at the top of `piece.js` (the light's source, bell shape,
warmth, the sculpture's size and height) and `shade.js` (shade, blue cast, flicker).

## Credits

AR engine: 8th Wall © Niantic Spatial, Inc., used under its [engine license](lib/8thwall/LICENSE),
provided without warranty. [three.js](lib/three/LICENSE) (MIT) and
[XRExtras](lib/xrextras/LICENSE). Depth: [Depth Anything V2 Small](model/depth-LICENSE.txt)
(Apache-2.0; ONNX export by fabio-sim/Depth-Anything-ONNX, Apache-2.0), run with
[ONNX Runtime Web](lib/onnxruntime/LICENSE) (MIT).
