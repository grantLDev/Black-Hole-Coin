# Notes for future agents

Start with `README.md` — it is the real documentation and it is long on purpose.
This file holds the decisions that are easy to undo by accident, because they
look like tuning constants and are not.

## Visual direction: ominous and deep, never sparkly

Settled 2026-09-19 after a direct look at the rendered page. The frame should
read as **deep, dark and ominous**. Anything that reads as busy, flashy or
glittery is wrong, however physically defensible it is. Three rules came out of
that, and all three are enforced in code rather than by taste:

**1. Nothing in the sky is smaller than one screen pixel.** A point spread
function narrower than the thing sampling it is a star that blinks in and out
as the camera turns. The finest of the three star octaves — a haze of pinpricks
0.8 pixels across — was **deleted**, not enlarged, and the two that remain are
floored at 1.2 screen pixels. Do not add a fine layer back. If the sky needs
more unresolved light, that is what the Milky Way FBM in `milkyWay()` is for.

**2. No stars near the shadow.** Around the black hole a single pixel covers a
huge patch of sky, so the star field there is below the sampling limit *by
construction* and sparkles at any resolution. `traceBlackHole` accumulates each
ray's total deflection and passes `sampleSky` a `spread` factor; stars are
dimmed by `1/spread²` and gone by 2.6. The knobs are `LENS_STARS_FREE` in
`blackhole.glsl.ts` and `LENS_STARS_FULL` / `LENS_STARS_NONE` in `sky.glsl.ts`.
This is not a screen-space vignette — it follows the hole wherever it sits in
the frame, and it makes the most expensive rays in the scene the cheapest to
finish. The smooth Milky Way is never faded; it has no sampling problem.

**3. Star density and brightness are deliberately low.** Both remaining layers
were thinned by about a third and the bright end pulled from magnitude 14 to 8.
A magnitude-14 star saturates to white across several pixels and keeps a halo
for several more, which reads as a lens flare. Raising these back is a visual
regression, not a fix.

## Resolution: supersampled by default

Settled at the same time, in response to the same look. The page renders **above
native resolution** — `minPixelRatio` in `lib/gl/quality.ts` is a *floor* under
the pixel ratio, 2.0 on the top tier, so on an ordinary 1x display the drawing
buffer is 2x2 device pixels per screen pixel and the browser downsamples it.
This is the single largest quality win available here: the photon ring is a
one-pixel feature, and undersampled it renders as a dotted, beaded line instead
of a continuous arc.

It costs 4x the fill rate, knowingly. `maxPixels` and the downgrade thresholds
(40fps on high, 30fps on medium) were all moved to match, and the governor
stepping a slow machine down is the system working as designed. **Sharpness was
chosen over frame rate here on purpose** — do not "fix" the frame time by
lowering `minPixelRatio` without saying so.

Two things depend on each other and will break quietly if only one is changed:

- `uPixelAngle` is the angle of one **screen** pixel, not one drawing-buffer
  pixel. `Renderer` computes the supersample factor with
  `bufferPixelsPerScreenPixel()` and `FullscreenPass.setPixelScale()` multiplies
  it in. Size the star field against the raw buffer instead and a 2x buffer
  halves every star, which hands back exactly the sub-pixel twinkle rule 1
  exists to prevent — raising the resolution would make the sky *worse*.
- The bottom tier is exempt from all of the above (`minPixelRatio` 1,
  `renderScale` 0.85). It is the net a struggling phone falls into and there is
  nothing below it to fall to.

## Verifying a visual change

Do not merge a change to the shader on reasoning alone; look at it.

```
npm run dev &                      # or npm run build && npm start
npm run capture                    # screenshots across tiers, times and fovs
SHOTS=photon-ring,shadow-edge npm run capture    # just the frames you touched
```

The capture harness drives the real page in a real browser, so it exercises the
quality defines, the uniform plumbing and the GLSL together. On a machine with
no GPU it falls back to SwiftShader and takes seconds per frame; the frame times
it reports then mean nothing, but the pixels are correct. A WebGL program that
fails to link shows up only as a page error in that harness — the canvas just
stays black, which is also what a correct shadow looks like.

`npm run typecheck && npm run verify` must both pass. Note that GLSL lives in
`.ts` template literals: a backtick inside a shader comment ends the literal and
produces a baffling TypeScript syntax error.
