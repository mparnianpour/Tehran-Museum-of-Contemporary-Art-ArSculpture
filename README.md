# Simorgh: AR sculpture, Tehran Museum of Contemporary Art

A web AR piece for the atrium of the Tehran Museum of Contemporary Art. Point a phone at the
atrium (or at the photograph of it, `atrium.jpg`) and the Simorgh, a polished silver sculpture,
hangs between the two inner pillars, held in a warm light falling from the ceiling. The room
around it dims to a deep blue and its light flickers.

**Live:** https://mparnianpour.github.io/Tehran-Museum-of-Contemporary-Art-ArSculpture/

## Using it

1. Open the link on a phone (Safari on iPhone, Chrome on Android) and tap **Start camera**.
2. Point the camera at the photograph, or at the atrium framed like the photograph.
3. In the atrium itself, if it isn't found after a few seconds: frame the pillars like the
   photograph, then tap the spot between them. You get three tries; the scene stays where the
   last one put it, and holds there as you move.

People walking along the balconies, or across the ceiling light, don't stop the photograph
being found: those areas are softened in the image the camera looks for (`PEOPLE` in `app.js`).

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The page: start screen and camera view |
| `app.js` | The AR session: finds the photograph, or places the scene where you tap |
| `piece.js` | The scene: the sculpture, the light and its pattern, dust, glints |
| `shade.js` | The shade over the camera view (from the Turrell walls work): 55%, deep blue, flickering |
| `atrium.jpg` | The photograph the camera looks for |
| `model/simorgh.glb` | The sculpture |
| `lib/` | 8th Wall engine, XRExtras, three.js |

The look is set by named constants at the top of `piece.js` (the light's source, bell shape,
warmth, the sculpture's size and height) and `shade.js` (shade, blue cast, flicker).

## Credits

AR engine: 8th Wall © Niantic Spatial, Inc., used under its [engine license](lib/8thwall/LICENSE),
provided without warranty. [three.js](lib/three/LICENSE) (MIT) and
[XRExtras](lib/xrextras/LICENSE).
