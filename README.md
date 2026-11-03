# Deriv Signal Lab

Quant signal intelligence, algorithmic strategy lab, and visual bot automation for Deriv synthetic and forex markets.

## Features

- **Quant Signal Intelligence**: Multi-model prediction stack with 17 specialized digit engines across 8 statistical families (Dirichlet, PPM Markov, local-level Kalman filters, gap hazard curves, spectral persistence) and 15 quote engines with Ornstein–Uhlenbeck AR(1) level-reversion analytics.
- **Visual Bot Space (DBot)**: Strategy workspace with automated and manual execution templates, AI Even/Odd Switcher, AI Vision Over/Under, High-Low Tick Sniper, Rise/Fall Ensemble, Step-Markov Hedge, and Step Index 4-Tick Hedge strategies.
- **Deep Market Quant Analytics**: Digit distribution, Shannon/normalized entropy, Wald-Wolfowitz run tests, Pearson Chi-square goodness-of-fit, Hurst exponent, fractal dimension, and RSI imbalance.
- **Execution & Risk Management**: Integrated trade ticketing with live Deriv WebSocket quote streaming, Martingale ladder configuration, session loss limits, and take-profit thresholds.
- **Neural & Distilled Forge Models**: Real-time causal feature extraction and chronological validation for live trade qualification and veto checks.
- **Settings & API Hub**: Deriv App ID and API token management, risk controls, and automated calibration thresholds.

## Development

```bash
# Start development server on port 3000
npm run dev

# Run TypeScript typechecks
npm run lint

# Build production bundle
npm run build
```

## Deployment

`npm run build` writes the complete static app to `dist/`. The bot presets are
imported into that bundle, so a strategy edit is published by a new build, not
by editing a running deployment.

### Cloudflare Workers

`wrangler.jsonc` deploys `dist` as a Workers static-assets project named
`signallab`, the service the Cloudflare GitHub integration builds. The config is
strict JSON (no comments), pins Wrangler in `devDependencies`, and works with
both build paths:

- root directory `/`: deploy `npx wrangler deploy`, preview `npx wrangler preview`;
- legacy root directories (`artifacts/deriv-signal-lab`, `artifacts/api-server`,
  `artifacts/mockup-sandbox`): compatibility configs and package shims forward
  to the single root Vite build. `npm run build` publishes a copy of `dist` to
  each legacy path, so stale `--assets` or publish-directory settings cannot
  upload an empty directory.

`wrangler.jsonc` also declares `previews: {}` for the non-production
`wrangler preview` command, plus an explicit `env.production` with the same
Worker name, assets directory, and build command. That covers integrations
that invoke Wrangler with `--env production` instead of the default config.
The custom `build.command` calls
`scripts/cloudflare-build.mjs`, which runs `npm ci --include=dev` from the
committed `package-lock.json` before building. This makes the build repeatable
and keeps Vite available even when the build host sets `NODE_ENV=production`.
Wrangler therefore produces `dist` itself before an upload even if the
dashboard's optional build command is empty or stale; leaving the dashboard
build command as `npm run build` is also fine. The minimal
`pnpm-workspace.yaml` keeps the old
`pnpm --filter @workspace/deriv-signal-lab build` command working as a thin
wrapper around that same root build. `npm run check:deploy` validates these
settings before a manual deploy.

Each root build replaces—not merely overlays—the compatibility publish folders.
That removes obsolete hashed assets and ensures a legacy publish directory is
an exact copy of the freshly built app. `public/_headers` marks the
fingerprinted files under `/assets` immutable and keeps all non-fingerprinted
files out of the cache, so a completed deployment serves the new HTML, public
files, and hashed bundle immediately. Routing is deliberately not a
single-page-application fallback: `/dbot/index.html` is a real file the
embedded workspace loads, and a catch-all would answer a missing one with the
host app. For a manual deploy, run `npm run deploy`; the pinned local Wrangler
is used and nothing needs to be installed globally.
