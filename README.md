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

## Non-negotiables

- No API key, keyed RPC URL, or secret in client code — ever.
- Never invent data. If an upstream call fails, degrade to the last known good
  value and flag it in the payload.
- Nothing that has unlocked ever un-unlocks. Tiers, jets, and cosmetic
  milestones are one-directional.
- 60fps on a 2020 MacBook Air, 30fps on a mid-range Android phone. The quality
  tier system is built in, not retrofitted.
