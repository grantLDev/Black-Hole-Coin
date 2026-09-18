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
| `NEXT_PUBLIC_DEMO_MODE` | Yes | `1` forces the simulator even after launch |
| `NEXT_PUBLIC_SITE_URL` | Yes | Canonical origin for OpenGraph absolute URLs |

The three server-only variables are read exclusively inside `app/api/**` route
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

## Non-negotiables

- No API key, keyed RPC URL, or secret in client code — ever.
- Never invent data. If an upstream call fails, degrade to the last known good
  value and flag it in the payload.
- Nothing that has unlocked ever un-unlocks. Tiers, jets, and cosmetic
  milestones are one-directional.
- 60fps on a 2020 MacBook Air, 30fps on a mid-range Android phone. The quality
  tier system is built in, not retrofitted.
