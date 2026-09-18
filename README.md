# Singularity

A public site that renders a photorealistic, raymarched black hole whose scale
and intensity are driven in real time by on-chain data for a Solana SPL token
launched on pump.fun.

Two data channels drive the visuals, and they behave differently on purpose:

- **Holder count → continuous size.** Live, but asymmetrically damped: the hole
  grows quickly as holders join and eases back only slowly if they leave.
- **Market cap → discrete tier unlocks.** Driven by **all-time-high** market
  cap, never live market cap. Once a tier is reached it is permanent. A crash
  never revokes a tier and never reverses a visual. Tiers are achievements, not
  a thermometer.

Stack: Next.js 15 (App Router) + TypeScript + Tailwind + Three.js (raw WebGL2
shaders, no react-three-fiber), deployed on Vercel, with Vercel KV (Upstash
Redis) persisting peak values across serverless invocations.

## Getting started

```bash
npm install
cp .env.example .env.local
npm run dev
```

With `MINT_ADDRESS` empty in `config/token.ts`, the app runs entirely on the
simulator (`DEMO_MODE`) — no Helius calls, no KV reads, no fabricated numbers.
You do not need any keys to develop the renderer.

## Configuration

`config/token.ts` is the single source of truth for token identity:
`MINT_ADDRESS`, `TOKEN_SYMBOL`, `TOKEN_NAME`, `TOTAL_SUPPLY`, `SOCIALS`, and
the derived `DEMO_MODE` flag. Set `MINT_ADDRESS` after launch; that one edit
flips the app from simulated to live.

`config/tiers.ts` is the tier table. Every visual and audio field there
(disk radius, brightness, turbulence, bloom, chromatic aberration, grain,
camera shake, jets, drone) is fed to the renderer as a **live uniform** — none
of it is duplicated as a constant inside a shader, so the whole look is tunable
from that one file.

## Environment variables

Copy `.env.example` to `.env.local` locally, and set the same variables in
Vercel under **Project → Settings → Environment Variables** (Production,
Preview, and Development).

| Variable | Public? | What it is |
| --- | --- | --- |
| `HELIUS_API_KEY` | **No — server only** | Solana RPC + DAS access for holder counts and supply |
| `KV_REST_API_URL` | **No — server only** | Vercel KV endpoint for the ratcheted peaks |
| `KV_REST_API_TOKEN` | **No — server only** | Vercel KV auth token |
| `HOLDER_COUNT_METHOD` | **No — server only** | `das` to prefer DAS `getTokenAccounts` over `getProgramAccounts` |
| `HOLDER_COUNT_RESOLVE_OWNERS` | **No — server only** | `1` to de-duplicate holders by wallet instead of by token account |
| `NEXT_PUBLIC_DEMO_MODE` | Yes | `1` forces the simulator even after launch |
| `NEXT_PUBLIC_SITE_URL` | Yes | Canonical origin for OpenGraph absolute URLs |

The server-only variables are read exclusively inside `app/api/**` route
handlers. They are never imported into a client component and never inlined
into the browser bundle.

### Getting a free Helius key

1. Go to <https://dashboard.helius.dev> and sign up (the free Developer plan is
   enough for this site's polling rate).
2. Open **API Keys** in the dashboard. A key is created for you on signup.
3. Copy the key string only — not the full `https://mainnet.helius-rpc.com/?api-key=…`
   URL. The route handlers assemble the RPC URL server-side so the key never
   reaches the client.
4. Put it in `.env.local` as `HELIUS_API_KEY=…`, and add the same value in
   Vercel.

### Getting a free Vercel KV instance

1. In the Vercel dashboard, open the project and go to the **Storage** tab.
2. **Create Database → KV** (Upstash Redis). The free/hobby tier is sufficient:
   the site stores a handful of scalar peak values.
3. Choose a region near your deployment region and create it.
4. **Connect Project** and select this project. Vercel injects
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` (plus read-only variants) into all
   environments automatically.
5. For local development, pull them down with `vercel env pull .env.local`.

KV is what makes the ratchet durable. Without it, peak market cap and peak
holder count would reset on every cold start and unlocked tiers would appear to
un-unlock — which the design forbids.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | Both suites below |
| `npm run verify:pda` | Checks base58, the ed25519 on-curve test and PDA derivation against known pump.fun addresses |
| `npm run verify:stats` | Checks the bonding curve decoder, the sustain guard, tier monotonicity, the cache and the demo feed |

## The data layer

`GET /api/stats` is the single data source for the renderer. Node runtime,
because the bonding curve PDA derivation needs `node:crypto` and because every
secret in the project is read there and nowhere else.

```jsonc
{
  "liveMarketCapUsd": 42137.8,   // live, display only
  "liveHolders": 318,            // live, drives camera distance
  "peakMarketCapUsd": 51204.0,   // ratcheted, sustain-guarded
  "peakHolders": 341,            // ratcheted, immediate
  "tierIndex": 3,                // from peakMarketCapUsd. Monotonic.
  "priceUsd": 0.0000421,
  "solUsd": 154.3,
  "graduated": false,
  "bondingProgress": 0.61,       // 0-1, pre-graduation only
  "source": "curve",             // curve | dexscreener | demo | stale
  "updatedAt": 1789740000000,
  "degraded": false
}
```

### Where the numbers come from

**Market cap, path A (primary, pre-graduation).** The pump.fun bonding curve
account is read directly with one `getAccountInfo` (1 credit) against the PDA
`["bonding-curve", mint]` under `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
Price comes from the virtual reserves:

```
price_in_sol = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6)
marketCap    = price_in_sol * solUsd * tokenTotalSupply
```

The account layout was verified against
[pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)
and is documented in full at the top of `lib/bondingCurve.ts`. Two things about
it have changed since the original program and both matter:

- The account has grown twice. Original curves are 49 bytes; current ones are
  125. The decoder therefore requires a *minimum* length and never an exact
  one — a strict check would reject valid accounts and break again on the next
  upgrade.
- A `quote_mint` field now exists at offset 83, so a curve is not necessarily
  denominated in SOL. When it is not wrapped SOL, `price_in_sol * solUsd` is
  silently wrong by whatever the quote asset is worth, so the route detects
  that and falls through to path B instead.

**Market cap, path B (post-graduation, and any time path A fails).**
DexScreener's `/latest/dex/tokens/{mint}`, keyless and ~300 req/min. The
deepest-liquidity pair wins, filtered to pairs where the mint is the *base*
token — that filter is not optional, because the endpoint also returns pairs
where the mint is the quote side and those report the other token's price.

**SOL/USD.** The deepest wrapped-SOL pair on DexScreener, cached 60s, with a
sanity band that rejects an implausible reading rather than dollarising the
whole site off a bad quote.

**Holders.** `getProgramAccounts` against the SPL Token program, filtered to
`dataSize: 165` and `memcmp` on the mint, with `dataSlice` trimming each
account to its 8-byte amount so a 5,000-holder token returns ~60KB instead of
1.2MB. Accounts with a zero balance are skipped, and so is the bonding curve's
own associated token account — it is a vault holding every unsold token, and
counting it would report one holder the moment the token launches with nobody
in it.

### Which holder-count method, and why

Both `getProgramAccounts` and DAS `getTokenAccounts` cost **10 credits per
call**. The difference is how many calls each needs:

| | calls | credits at 500 holders | at 5,000 holders |
| --- | --- | --- | --- |
| `getProgramAccounts` | always 1 | 10 | 10 |
| DAS `getTokenAccounts` | 1 per 1000 holders | 10 | 50 |

**`getProgramAccounts` is the default**: equal at launch, strictly cheaper from
the 1001st holder onward, and `dataSlice` keeps the payload small enough that
its one weakness — response size — does not bite. DAS is wired up as the
automatic fallback, because gPA is the call more likely to time out under load,
and `HOLDER_COUNT_METHOD=das` inverts the preference without a redeploy.

One caveat worth stating plainly: this choice is made from the credit
arithmetic and payload sizes, not from a live benchmark. Outbound access to
Helius was blocked from the build environment, so the two paths have not been
raced against the real mint. Both are implemented and switchable precisely so
that measurement can settle it after launch.

### Expected Helius credit burn

The origin request rate is capped by the CDN, not by traffic.
`s-maxage=15` means Vercel's edge answers from cache for 15 seconds, so the
route runs **~4 times per minute no matter how many people are on the site**.
Each of those runs only calls upstream if its own TTL has lapsed.

| Call | Credits | TTL | Calls/month | Credits/month |
| --- | --- | --- | --- | --- |
| `getAccountInfo` (bonding curve) | 1 | 15s | 4/min × 43,200 min = 172,800 | **172,800** |
| `getProgramAccounts` (holders) | 10 | 45s | 1.33/min × 43,200 min = 57,600 | **576,000** |
| DexScreener (price + SOL/USD) | 0 | 15s / 60s | — | **0** |
| | | | | **≈ 748,800** |

Working: 60/15 = 4 market-cap refreshes per minute; 60/45 = 1.33 holder
refreshes per minute. 60 × 24 × 30 = 43,200 minutes in a month.
(4 × 43,200 × 1) + (1.33 × 43,200 × 10) = 172,800 + 576,000 = **748,800
credits/month**, or about 25,000/day — roughly **75% of the 1M free tier**.

The honest caveat: the TTL cache is module-scope, so it is per warm lambda
instance. Vercel may run several concurrently across regions, and each keeps
its own 45s holder timer. Two active instances is ~1.5M credits/month and needs
the $49 Developer plan; four is ~3M, still comfortably inside that plan's 10M.
The KV snapshot exists partly to blunt this — a cold instance warms from the
shared last-known-good instead of immediately firing an uncached
`getProgramAccounts`.

Two levers if the burn ever matters: raising the holder TTL from 45s to 90s
takes the single-instance total from 748,800 to **460,800**, and the holder call
is 77% of the bill, so it is the only one worth tuning.

### How failure behaves

Every upstream call is wrapped, and the route never throws a 500. On failure it
serves the last known good values with `source: "stale"` and `degraded: true`,
while the peaks keep serving from KV untouched. If KV itself is unreachable the
peaks fall back to a per-instance memory store and `degraded` is set — a
possibly-reset peak beats a crashed route.

Nothing is fabricated. A degraded payload repeats numbers that were really read
earlier; it does not synthesise plausible ones. If a live value is missing
entirely it falls back to the corresponding ratcheted peak, which is still a
figure the token actually reached. Zero appears only when nothing has ever been
read successfully — which, for an unlaunched token, is simply the truth.

The whole upstream gather also races a 7-second deadline. Individual timeouts
compose badly: a curve read plus a DexScreener fallback plus a holder count
plus *its* fallback can serialise past Vercel's function limit, and a function
that gets killed returns exactly the 500 this route promises never to return.
Whatever has not arrived by the deadline is served from cache as stale, and the
abandoned fetch still populates the cache for the next request.

### The ratchet

`lib/peaks.ts` is where everything permanent lives. The two peaks are tracked
differently on purpose:

- **`peakHolders` commits immediately.** Holder count does not wick — a wallet
  either opened a token account or it did not.
- **`peakMarketCapUsd` is sustain-guarded.** Price does wick, and a single
  block of thin-liquidity buying must not permanently unlock a tier the token
  never actually held:

  ```
  live > candidatePeak          -> candidatePeak = live, streak = 1
  live >= candidatePeak * 0.97  -> streak += 1
  otherwise                     -> streak = 0, candidatePeak = live
  streak >= 3 && candidate > peak -> commit
  ```

  At the 15s market-cap TTL that is ~45 seconds of sustained price above the old
  peak before it counts: long enough to reject a one-block spike, short enough
  that a real breakout registers inside a minute.

A **stale poll advances nothing**. A stale sample repeats the previous value,
which would satisfy the "still within 3%" branch for free and let an outage
launder a wick into a committed peak.

`tierIndex` is derived from the committed peak *and* floored by the last
committed tier, so no code path — not a KV hiccup, not a decode error, not an
edit to the tier table — can lower it. Graduation is stored the same way, as a
one-way milestone, so a transient RPC failure cannot un-graduate the token.

### Demo mode

With `MINT_ADDRESS` empty or `NEXT_PUBLIC_DEMO_MODE=1`, the route runs on a
deterministic simulator: a pure function of wall-clock time, so two browsers in
the same second see the same numbers and a redeploy does not jump the
simulation. It runs a 45-minute cycle that climbs the whole tier table from
~$2K to ~$12M, with market cap moving in bursts and pullbacks and holders doing
a random walk with gentler pullbacks.

| Param | Does |
| --- | --- |
| `?demoTier=N` | Raise to at least tier N |
| `?demoMcap=X` | Pin the live market cap to X |
| `?resetPeak=1` | Wipe the demo peaks back to zero |

Any of these puts the request on a `demo` peak namespace that is completely
separate from the real mint's, which is what makes them safe to leave enabled
in production.

`demoTier` **cannot demote** — like every other tier movement here it only goes
up, so asking for a lower tier than the namespace has reached does nothing.
`?resetPeak=1&demoTier=N` is how you drop back down and replay a specific
transition. `demoMcap` still goes through the sustain guard, so holding a value
above the peak for three polls is what actually unlocks the tier — which is the
behaviour worth testing:

```bash
curl 'localhost:3000/api/stats?resetPeak=1&demoMcap=30000'  # streak 1, tier 0
curl 'localhost:3000/api/stats?demoMcap=30000'              # streak 2, tier 0
curl 'localhost:3000/api/stats?demoMcap=30000'              # streak 3, tier 2
curl 'localhost:3000/api/stats?demoMcap=1'                  # crash — still tier 2
```

### Client hook

`lib/useStats.ts` polls the route and exposes `{ stats, connected, lastError }`.
5s when the tab is visible, 15s when hidden, and exponential backoff from 5s to
a 60s ceiling on error. It is a `setTimeout` chain rather than `setInterval`
because the interval is not constant and because each poll must be scheduled
from the *end* of the last one, so a slow response can never stack requests.

It deliberately carries no smoothing. The asymmetric damping of the
holder-driven camera distance belongs in the render loop where it can be
frame-rate independent; doing it here would tie the easing to the poll interval.

## The render layer

The whole visual is **one fullscreen triangle running one fragment shader**.
There is no scene graph geometry, no `PerspectiveCamera`, and no projection
matrix anywhere — the image is raymarched per pixel from a ray.

| File | Role |
| --- | --- |
| `lib/gl/Renderer.ts` | WebGL2 context, frame loop, resize, teardown, quality governor |
| `lib/gl/FullscreenPass.ts` | The triangle, the material, and the uniforms |
| `lib/gl/OrbitCamera.ts` | Ray origin + orthonormal basis + FOV |
| `lib/gl/VisualState.ts` | Tier table → smoothed, ratcheted shader uniforms |
| `lib/gl/quality.ts` | Quality tiers, device detection, runtime governor |
| `lib/gl/shaders/blackhole.glsl.ts` | Geodesic marcher, accretion disk, jets |
| `lib/gl/shaders/*.glsl.ts` | GLSL as template literals |
| `components/RendererMount.tsx` | Attaches the renderer to the server-rendered canvas |
| `scripts/capture.ts` | Headless screenshot + frame-time harness |

### Why these choices

**One triangle, not a quad.** A quad is two triangles meeting on the screen
diagonal, and GPUs shade in 2x2 quads, so every pixel along that diagonal gets
shaded twice. One oversized triangle clipped to the viewport covers the same
pixels with none of that waste.

**`RawShaderMaterial`, not `ShaderMaterial`.** three.js injects a prelude of
matrices, attributes, and colour-management chunks into a `ShaderMaterial`, and
none of it applies to a raymarcher. Its tone mapping and sRGB chunks are also
written for GLSL 1 and do not compile under GLSL 3 — in that path three
declares neither `pc_fragColor` nor `gl_FragColor`. So the pass performs the
ACES and sRGB transforms itself, as a direct port of three's own functions, and
the renderer is configured to the matching values so any future
`ShaderMaterial` or post-processing pass produces identical pixels.

**No antialiasing, no depth buffer, no clear.** MSAA antialiases geometry
edges; this scene's only edges are off-screen. There is one primitive, so there
is nothing to occlude. And the triangle writes every pixel of the viewport, so
a clear is a guaranteed-redundant full-screen write.

**GLSL lives in `.ts` files, not `.glsl` files.** A `.glsl` import needs a
bundler loader configured identically for Turbopack (`next dev`) and webpack
(`next build`), or the production build breaks in a way development never
shows. Template literals need no loader and compose directly.

### The star field

`sampleSky(vec3 dir)` is a pure function of direction — no time, no camera, no
screen position, no derivatives. That is what makes it rock-solid under camera
motion: a star does not move between frames, the camera moves and the star is
wherever that direction says it is. Any time dependence at all, including an
animated dither, would reintroduce crawling.

Stars sit on a **cube-sphere grid**, not a lat/long grid, which pinches at the
poles and seams at the wrap. A tangent warp (`atan`) on each face makes grid
cells carry near-equal solid angle, taking the corner-to-centre density ratio
from ~5x down to ~1.4x. That warp is also very nearly an *isometry* — the scale
from face coordinates to radians is exactly PI/4 at a face centre and at every
edge midpoint, dipping only to 0.943 * PI/4 at the cube corners — so star
distances are measured in face coordinates and no star's 3D direction is ever
reconstructed.

Each of the three density octaves samples a **3x3 cell neighbourhood with
full-cell jitter**. Testing one cell per ray is cheaper, but it forces stars to
be inset from their cell edges so their falloff cannot be clipped, and that
dead margin around every cell is immediately legible as a lattice.

The point spread function is sized in **pixels, not radians**, so stars stay the
same apparent size at every resolution — and never shrink below ~0.8 pixels. A
sub-pixel star falls between sample points as the camera turns and blinks in and
out; that, not the hashing, is what makes cheap star fields twinkle.

Hashing uses the "hash without sine" functions rather than
`fract(sin(dot(p,k))*43758.5453)`. `sin` is implemented at wildly different
precisions across GPUs, so a sine hash yields a visibly different star field on
different devices and degenerates into stripes on some mobile drivers.

`sampleSky` returns **linear HDR radiance**, not display colour, and the values
are tuned against ACES specifically: ACES multiplies small inputs by roughly
0.1 and clips anything under ~0.0022 linear to black.

### The black hole

`traceBlackHole(vec3 origin, vec3 rayDir)` produces everything in the frame
that is not background sky, by integrating null geodesics through a
Schwarzschild metric in units where the Schwarzschild radius **rs = 1**.
Nothing is a textured sphere, a billboard, or a particle system.

**The integrator.** A photon's orbit in Schwarzschild obeys
`d²u/dφ² + u = (3/2) rs u²` with `u = 1/r`, which in Cartesian form with
`h = r × v` conserved is

```
accel = -1.5 * h² * pos / |pos|⁵
```

That is not an approximation of the trajectory *shape* — substituting
`r = 1/u` and reparameterising to φ recovers the orbit equation exactly. What
it gives up is the parameterisation: `|v|` drifts along the path because the
acceleration is not perpendicular to the velocity. That costs nothing here,
because every consumer wants a direction or a position, never a speed. `h` is
also conserved *exactly* by the update (`dh/dλ = r × a + v × v`, and `a` is
parallel to `r`), which is why the photon ring stays sharp over hundreds of
steps instead of drifting into a smear.

Two numbers fall out of this and appear nowhere in the source: the photon
sphere at r = 1.5, and the apparent shadow radius at `3√3/2 ≈ 2.598 rs`. That
is the whole point of integrating rather than faking — a hand-drawn disc of
radius 2.6 would not also produce the photon ring, and a hand-drawn ring would
not also bend the star field around it.

**Adaptive stepping** is why the ring is sharp and the rest is affordable. A
fixed step that resolves r = 1.5 is ~100x smaller than one that suffices at
r = 40. Two criteria run, and the smaller wins:

1. `dt ≤ stepScale · r` — geometric, keeps the step a fixed fraction of the
   distance to the hole.
2. `dt ≤ turnLimit / |accel|` — angular, bounds how far the ray may *turn* in
   one step.

Criterion 2 resolves the photon ring and is self-tuning, since `|accel|` is
largest exactly where the trajectory curves hardest. Criterion 1 makes most of
the screen nearly free: a ray with impact parameter 20 has `|accel| ≈ 0.004` at
closest approach, so it escapes in about a dozen steps.

**Disk crossings are detected by a sign change in `pos.y`** between steps and
interpolated to the exact plane, and the marcher does **not** stop at the first
hit. A strongly lensed ray dives through the disk, wraps behind the hole and
comes back through it; every crossing is accumulated. That is the entire
mechanism behind the far side of the disk appearing both above *and* below the
shadow. There is no second disk and no mirrored geometry.

This also means the camera must never sit exactly in the disk plane. A ray cast
from `y = 0` along the equator keeps `y = 0` for its whole geodesic, never
registers a crossing, and the near side of the disk silently vanishes. The
camera's elevation therefore has a **bias**, not a sweep through zero.

**Doppler beaming** is what sells it. At each crossing the local orbital speed
is `β = √(M/(r−2M))` with `M = rs/2` — exactly 0.5c at the ISCO, which is the
standard check that the expression is right — and

```
δ = 1 / (γ (1 + β⃗ · dir))
```

with `dir` running camera → emitter, so `−dir` is the emitter → observer
direction. Getting that sign backwards flips which limb is bright and *still
looks plausible*, which is why it is spelled out in the source. Intensity is
multiplied by δ³; even at δ³ the inner edge runs about 100:1 between its
approaching and receding limbs. Gravitational redshift contributes a further
`√(1 − 1/r)` on energy.

`dir` is the ray's **local** direction at the crossing, which after lensing is
nothing like the direction it left the camera with. Using the camera ray would
beam the lensed far side as if it were the near side, and the over-and-under
wrap would come out symmetric and dead.

**The disk is a slab, not a plane.** Optical depth at a crossing is
`density · opacity · 2H(r)/|dir.y|` — the analytic path length through a slab
of half-thickness `H(r)`, which is puffy at the inner edge and thin outside it.
That single term is what gives a zero-height crossing test real thickness: a
grazing ray accumulates many times the optical depth of a steep one, so the
disk turns opaque edge-on and translucent from above, which is most of why the
near limb reads as solid while the far side glows through it.

**Filament noise** is sampled on a circle — the angular coordinate arrives as
`(cos a, sin a)`, not as the angle — so it is seamless in φ with no tear at
±π, and scaling the circle's radius *is* the angular frequency, so the higher
octaves need no second `sin`/`cos`. It is strongly anisotropic: at r = 4 one
noise cell spans ~2.4 rs of arc but only ~0.34 rs of radius, so features come
out ~7x longer than they are wide. Keplerian shear (`ω ∝ r^-1.5`) advects it,
so the inner bands visibly outrun the outer ones and wind the filaments into
spirals. Nothing draws a spiral; the shear *is* the spiral.

**Colour.** The temperature profile is the physical `T ∝ r^-0.75`, shifted into
the observer's frame by `δ · √(1 − 1/r)` and read through a ramp that extends
*past* both tier colours — into ember below and blue-white above. Clamping to
the two tier stops instead would leave the disk uniformly lit no matter how
hard it is beamed. The tier hexes are authored in sRGB and decoded to linear
before they reach the GPU (`hexToLinearRgb`); skipping that decode is a factor
of ~3 on the green channel and renders a vivid ember disk as sepia.

**Jets** (tier 9+) are volumetric, integrated along the same march with the
emission scaled by `dt` so the result is independent of a step size that varies
by three orders of magnitude along one ray. They are gated behind
`uJetStrength > 0`, so at tiers 0–8 they cost one comparison per step. The fade
is a **linear 4-second ramp with a smoothstep ease**, latched on: no code path
lowers `jetStrength` once it has begun to rise, including `setTier(0)`.

**Two deliberate departures from physics**, both flagged in the source:

- The disk's inner edge is at **2.2 rs**, not the Schwarzschild ISCO at 3 rs.
  Gargantua is a near-extremal Kerr hole whose prograde ISCO sits just outside
  the horizon; stopping at 3 rs leaves a visible gap between the disk and the
  shadow that reads immediately as wrong. 2.2 is still outside the photon
  sphere at 1.5.
- Radial **brightness** falls as `r^-1.6`, not the Stefan–Boltzmann `r^-3` that
  `T ∝ r^-0.75` implies. Across the tier-11 disk (2.2 → 11.5 rs) `r^-3` is a
  143x falloff and tone maps the outer disk to black; `r^-1.6` is 14x, and once
  Doppler beaming is included the approaching inner limb still outshines the
  outer disk by roughly 45x. The *temperature* profile is left at the physical
  −0.75, so the colours stay honest.

### Tier uniforms

`lib/gl/VisualState.ts` is the only part of the renderer that knows tiers
exist. The tier table holds step values — a tier is a discrete achievement —
and the shader needs continuous ones, so this is the low-pass filter between
them. Interpolation is exponential smoothing with a frame-rate-independent
coefficient, `1 − exp(−dt/τ)`; the naive `x += (target − x) · k` form converges
at a speed that depends on frame rate.

It keeps its **own tier ratchet**, refusing any index lower than one it has
already seen. The authoritative ratchet lives in the data layer against the
KV-persisted ATH, but a stale poll, a degraded last-known-good value, or a tab
restored from bfcache could each hand the renderer a lower tier than it is
currently showing. The cheapest place to make a backwards visual impossible is
the last gate before the GPU.

### Quality tiers

A raymarched fragment shader is almost purely fill-rate bound, so the two
levers that matter are how many pixels get shaded and how much work each pixel
does. Both are in `lib/gl/quality.ts`: `maxPixelRatio`, `renderScale`, a hard
`maxPixels` ceiling (a 5K display at DPR 2 asks for ~14.7M pixels), and the
FBM octave counts and march budget, which arrive in the shader as `#define`s.

| Knob | high | medium | low |
| --- | --- | --- | --- |
| `marchSteps` | 300 | 180 | 90 |
| `marchStepScale` | 0.11 | 0.16 | 0.26 |
| `marchTurnLimit` | 0.055 | 0.085 | 0.15 |
| `diskFbmOctaves` | 3 | 3 | 2 |
| `skyFbmOctaves` | 5 | 4 | 3 |
| `renderScale` | 1.0 | 0.85 | 0.7 |
| `maxPixels` | 2.6M | 1.7M | 1.0M |

`marchSteps` dominates everything else in this table combined.
`marchTurnLimit` is the knob that resolves the photon ring — at 0.055 rad a ray
needs ~114 steps to orbit the photon sphere once — and is the first thing that
shows on a low tier.

The march budget is *both* a `#define` (`MARCH_STEPS`, the loop bound, so the
driver can allocate registers sanely) and a uniform (`uQualitySteps`, clamped
to that ceiling, so it can be changed without a recompile).

The governor is **downgrade-only**. A bidirectional one oscillates: it drops a
tier, the frame budget recovers *because* it dropped, it steps back up, and the
cycle repeats as periodic stuttering. One-directional is stable, and matches
the ratcheting philosophy of the rest of the site.

The frame loop is **cancelled outright** when the document is hidden. Browsers
throttle rAF in a hidden tab rather than stopping it, which still burns a
phone's battery rendering a shader nobody can see.

### Debug URL parameters

| Parameter | Effect |
| --- | --- |
| `?debug` | Frame time, active tier, pixel ratio and buffer size overlay |
| `?quality=low\|medium\|high` | Pin a tier instead of detecting one |
| `?t=33.4` | Freeze scene time, to inspect one fixed view |
| `?tier=9` | Pin a market-cap tier, 0–11. Jets unlock at 9 |
| `?fov=13` | Vertical field of view in degrees. Narrow values inspect the photon ring |
| `?steps=140` | Override the march budget, under the compiled ceiling |
| `?bench` | Pin a 1920x1080 buffer, measure frame time, publish `window.__singularityBench` |

They read from the URL rather than `NODE_ENV` because the governor's behaviour
on a real device is exactly what needs inspecting in production. `?t=` is how
two revisions of the shader get compared pixel for pixel — the elevation sweep
has a 134s period, so pinning scene time is also how the inclination is varied.

### Measuring frame time

`?bench` pins the drawing buffer to exactly 1920x1080 regardless of viewport or
device pixel ratio, **locks the quality tier** so the governor cannot step down
mid-run and report the average of two different shaders, discards twelve
warm-up frames, then times 120 `rAF` deltas. It times whole frames rather than
wrapping the draw call: a `gl.finish()` would give a tighter GPU number and a
worse answer, since it serialises a pipeline that normally overlaps.

Both the warm-up and the outlier rejection are expressed relative to the run
rather than in absolute milliseconds. A fixed "skip two seconds, discard frames
over 250ms" is a hardware assumption in disguise: it is 120 frames and a
sensible GC filter at 60fps, and it discards *every* frame on a software
rasteriser — reporting no result rather than a slow one. Warm-up is counted in
frames, and stalls are rejected at 4x the run's own median.

`scripts/capture.ts` drives the real page in a real browser rather than
re-implementing the shader in a test rig, because the thing most likely to be
wrong is the interaction between the quality defines, the uniform plumbing and
the GLSL:

```bash
npx next start                      # or: npm run dev
npm run capture                     # screenshots across tiers, times and quality
npm run bench                       # frame time at 1920x1080
```

Both report the **unmasked GPU string** alongside every measurement. On a
machine with no GPU, Chromium falls back to SwiftShader and rasterises on the
CPU; a SwiftShader frame time says something about the shader's instruction
count and nothing about whether it holds 60fps on real hardware. Set
`CHROMIUM_PATH` if Playwright's bundled browser is not the one to use.

## Non-negotiables

- No API key, keyed RPC URL, or secret in client code — ever.
- Never invent data. If an upstream call fails, degrade to the last known good
  value and flag it in the payload.
- Nothing that has unlocked ever un-unlocks. Tiers, jets, and cosmetic
  milestones are one-directional.
- 60fps on a 2020 MacBook Air, 30fps on a mid-range Android phone. The quality
  tier system is built in, not retrofitted.
