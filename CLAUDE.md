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

## The two channels are not symmetric, and the asymmetry is the project

Settled 2026-09-19, when the feed was first wired to the renderer. Four numbers
below look like tuning constants and are not; each of them is a rule the whole
design rests on, expressed as a float.

**`FALL_TAU_SECONDS = 60` in `lib/gl/holders.ts`.** Twenty-four times the rise
constant. This is the difference between a sell-off reading as *the hole
relaxing* and reading as *the hole collapsing*, and there is nothing else
separating those two readings — the frames are identical, only the duration
differs. Bringing it anywhere near the 2.5s rise constant makes the site
punish holders for leaving, which is the opposite of the intent.

**`PEAK_DISTANCE_SLACK = 1.15`.** The camera may ease out to 1.15x its
all-time-peak distance and no further, so the hole never looks smaller than
~87% of its peak size. This is the "nothing un-unlocks" rule applied to a
continuous quantity, and it is applied to the spring's TARGET rather than to
its output — clamping the output parks a permanent velocity against the clamp
and makes the hole twitch on every poll.

**`CAMERA_DISK_CLEARANCE = 1.35`.** The only rule in the renderer that
overrides a number the brief gives directly, and it exists because the brief's
two tables conflict: the holder mapping bottoms out at 5.5 rs and the tier-11
disk runs out to 11.5 rs, so at the top of both the camera sits inside its own
accretion disk. That renders correctly and looks like a tunnel. 1.35 is chosen
so the clamp does not engage at all at tier 0 (4.0 x 1.35 = 5.4 rs, just under
the mapping's minimum) and tightens as the disk grows. Lower it and the top
tiers start swallowing the camera; raise it much and the holder channel stops
moving the camera at all above tier 8. `npm run verify:feed` asserts both ends.

**`EVENT_SECONDS = 6` in `lib/gl/TierEvent.ts`.** Longer than anything inside
it — the last cue finishes at 5.0s — because it is the NON-OVERLAP guarantee,
not a duration. Shortening it to fit the cues means a queued run of promotions
starts landing ripples on top of a card that is still fading, and two
milestones destroy each other rather than reading as two.

Three structural rules that go with them:

1. **Nothing in the client recomputes a tier from live market cap.** The index
   comes from `stats.tierIndex`, which the server derives from the KV-persisted
   all-time high. There is no demotion path in `SceneDirector`, `VisualState`
   or `TierEventQueue`, and adding one is not a bug fix.
2. **A degraded payload changes nothing at all.** Not the tier, not the holder
   target, not one uniform. Taking the holder count from a flagged payload
   while ignoring its tier is a half-trusted payload, which is worse than
   either choice. The one exception is a session whose first payload is already
   degraded, which seeds and says so in the HUD.
3. **The first payload of a session adopts its tier silently.** A page load is
   not an unlock. `TierEventQueue.adopt` exists for exactly this and drains the
   queue so a stale event cannot fire later.

## The HUD runs on the renderer's clock, never on wall time

Same date, and it cost a real bug to learn. The tier card's fade was originally
a `setTimeout` for the unmount plus a rAF for the opacity. `?event=`, which
freezes the choreography clock for a screenshot, held the opacity at 1 while
the wall-clock timer deleted the card six real seconds later anyway — so
whether the card appeared in a capture depended on how slow the machine taking
it was.

One clock, or none. `Hud.tsx` polls `TierEventQueue` for both the opacity and
whether the event is still playing, and the card retires itself when the queue
says the slot ended. The same reasoning rules out a CSS keyframe: it keeps
running when `Renderer.stop()` cancels the frame loop on a hidden tab, so the
card would be gone when the viewer came back mid-unlock.

## Verifying a visual change

Do not merge a change to the shader on reasoning alone; look at it.

```
npm run dev &                      # or npm run build && npm start
npm run capture                    # screenshots across tiers, times and fovs
SHOTS=photon-ring,shadow-edge npm run capture    # just the frames you touched
```

Every shot is captured with `feed=0` and a pinned holder count. That is not
tidiness: the camera's orbit radius is holder-driven, so a live payload landing
between the warm-up frames and the shutter moves the camera, and the frame then
differs from its reference for reasons that have nothing to do with the change
being reviewed. A shot that needs its own framing sets `holders=` in its own
query, which wins because `URLSearchParams.get` returns the first occurrence.

`?event=` is the only way to photograph the 0.4-second ripple deliberately.
The wavefront starts just beyond the frame corner and reaches the centre at
0.34s, so `event=0.08` catches it entering and `event=0.27` catches it crossing
the shadow's edge — which is where it either bends the photon ring convincingly
or tears it in two.

The capture harness drives the real page in a real browser, so it exercises the
quality defines, the uniform plumbing and the GLSL together. On a machine with
no GPU it falls back to SwiftShader and takes seconds per frame; the frame times
it reports then mean nothing, but the pixels are correct. A WebGL program that
fails to link shows up only as a page error in that harness — the canvas just
stays black, which is also what a correct shadow looks like.

`npm run typecheck && npm run verify` must both pass. `verify:feed` is the one
that catches a broken channel: almost every way of getting the two channels
wrong produces a frame that looks perfectly fine on its own and only misbehaves
over a sequence — a symmetric spring is indistinguishable from an asymmetric
one in any single frame. Note that GLSL lives in
`.ts` template literals: a backtick inside a shader comment ends the literal and
produces a baffling TypeScript syntax error.
