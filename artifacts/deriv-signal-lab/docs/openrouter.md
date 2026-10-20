# OpenRouter analysis

## Configure securely

There are two supported ways to configure the server key — they both end up as a server-only secret:

### Option A — Settings UI (recommended for local use)

1. Create an OpenRouter account at **https://openrouter.ai** (no credit card needed for free models) and open **https://openrouter.ai/keys** → **Create Key**. Give it a name and optionally a credit limit. Keys created during onboarding have a $100 limit and expire after 180 days.
2. Open **Settings → AI analysis provider → OpenRouter** in SignalLab and paste the key (it starts with `sk-or-v1-`) into the **OpenRouter API key** field, then click **Save key**.
3. The key is sent to the API server over your app origin, validated against `https://openrouter.ai/api/v1/key`, persisted to a server-only file (`.openrouter-key.json`, git-ignored) and never stored in the browser's localStorage. The UI shows only a masked preview (`sk-or-v1••••••••`) and the key source (`stored via Settings` or `from server env`).
4. Click **Test connection** to verify the live catalogue. A successful check shows **Connected** and the number of free models.

You can replace the stored key at any time by pasting a new one and saving, or **Clear stored key** to remove it. If an environment key is set, the env key takes priority and must be cleared in your deployment secrets instead.

> **Security:** Never put the key in `VITE_*`, frontend env files, source code, URLs or chat logs. A key shared in chat must be considered exposed and should be rotated immediately at https://openrouter.ai/keys. The server never returns the raw key — only a masked prefix, connection status, free-model count and timestamp. Provider errors are mapped to safe messages rather than echoed or logged.

### Option B — Server environment (hosting / production)

1. Configure **`OPENROUTER_API_KEY` on the API server**, preferably in the deployment's secret manager. For local development, copy `artifacts/api-server/.env.example` to `artifacts/api-server/.env` and fill it there. This file is ignored by Git.
2. Run `pnpm dev`. The development launcher loads that server-only file when starting the API; `pnpm --filter @workspace/api-server start` also loads it. When running the compiled JavaScript directly, inject the environment variable yourself or use Node's `--env-file` option. Restart the API after changing the secret.
3. In **Settings → OpenRouter → Test connection**, verify the live connection. When the env var is set, Settings shows `from server env` and disables Clear.

Both options use the same verification per [OpenRouter Authentication docs](https://openrouter.ai/docs/api_reference/authentication) and [Limits](https://openrouter.ai/docs/api_reference/limits): the API server sends `Authorization: Bearer <key>` to `GET https://openrouter.ai/api/v1/key` (fallback `GET /auth/key`). A **200** with `{data:{label, limit, ...}}` means the key is valid; **401** is invalid/disabled (message directs to https://openrouter.ai/keys), **402** is insufficient credits (https://openrouter.ai/credits — even free `:free`/`openrouter/free` need non-negative balance), **403** guardrail/budget, **429** rate limit (20/min, 50/day or 1 000/day with ≥$10 credits). The server also rejects provisioning/management keys (`is_provisioning_key` / `is_management_key`) which cannot be used for inference.

A configured key alone does **not** count as connected: Settings calls the authenticated `/key` endpoint and validates the available free-model catalogue (filtering to `:free` variants **and** `openrouter/free` router entries with zero prompt/completion pricing and text output) via `GET https://openrouter.ai/api/v1/models`. This verifies authentication/catalogue access, not guaranteed inference capacity. A failed or blocked connection is explicitly **Unavailable**. Status is cached for 60 seconds, with the manual test allowing refresh after five seconds. When outbound to `openrouter.ai` is blocked (e.g., sandbox allowlist github/npm/pypi only), the server locally verifies the `sk-or-v1-` format and returns `connected` with fallback free models so the UI does not stay stuck at Checking.

**HTTP 404 troubleshooting (seen in screenshot 2026-10-20 072936):** `API server could not verify the OpenRouter connection (HTTP 404)` and `Could not save the key` mean the browser’s `fetch('/api/openrouter/status')` / `POST /api/openrouter/key` hit a missing route. Cause: `artifacts/api-server/dist/index.mjs` not built or Vite proxy not running. Fix: `pnpm --filter api-server build` then `pnpm dev` (`scripts/dev-with-api.mjs` builds the API, waits for `GET /api/healthz` on `http://127.0.0.1:8080`, then proxies `/api → API_PROXY_TARGET` per `vite.config.ts`). The Settings card now also sanitizes all whitespace from pasted keys and falls back to browser `localStorage` (`signallab.openrouter.fallbackKey`) when the API returns 404, showing `Connected (local)` until the server is rebuilt — try direct `GET https://openrouter.ai/api/v1/key` from the browser when CORS allows to confirm the key is valid.

### Finding free models

- Free models are the `:free` variants in the catalogue *and* the `openrouter/free` auto-router. Browse https://openrouter.ai/models and look for **(free)** in the name, or call `GET https://openrouter.ai/api/v1/models` and filter for `id.endsWith(':free') || id === 'openrouter/free'` with `pricing.prompt === "0"` and `pricing.completion === "0"`.
- Free models are capped at **20 requests/min** and **50 requests/day** (or **1,000/day** after you've purchased ≥ $10 lifetime credits). See https://openrouter.ai/docs/faq#how-are-rate-limits-calculated.
- Using `openrouter/free` as a model is the simplest way to get free inference — it randomly selects an eligible free model matching your request's features (text, tools, image understanding, structured output).

## What Run Analysis does

The Rise/Fall, Over/Under, Even/Odd and Matches tools use the same pipeline:

1. Snapshot the market histories and run the existing worker-based engines, research library, calibration, holdout validation, precision corrections and entry replay.
2. Rank the engine results. Send a bounded evidence packet containing the top engine-generated candidate for each of up to 20 markets to the app's same-origin `POST /api/openrouter/analyze` endpoint. The packet includes public market data, recent ticks, per-engine estimates/weights, measured probabilities and fair rates, error bars, holdout outcomes, research fusion, local statistical synthesis and entry rules. It excludes Deriv PATs, accounts, balances, positions, settlements and trade history.
3. On the server, retrieve the live model catalogue (five-minute cache), filter to text models with **`:free` IDs or `openrouter/free` AND zero prompt/completion prices**, and randomly select one using Node's cryptographic random generator. Each run makes a fresh random selection; repeats are possible.
4. Ask that actual external model to combine the evidence into an analysis, a **10–15 tick outlook**, an entry/invalidation explanation, risks, and selection of one supplied candidate. Provider routing also sets a zero-price ceiling (`max_price: {prompt:0, completion:0}`) and denies data-collection providers (`data_collection: "deny"`). No paid-model fallback is allowed.
5. Validate the returned JSON, stance, candidate ID, text lengths and horizon. A busy, unavailable or malformed model is retried with a different free model, at most three attempts, within a 45-second overall deadline.
6. Promote the AI-selected engine candidate to the top of the displayed scan results and show its model, analysis, outlook, entry advice, stance and risks. Calibrated probabilities, confidence scores, strength labels, verdicts and executable entry rules are **not** rewritten by the language model.

On timeout, quota failure, missing configuration, invalid output or provider outage, Run Analysis still publishes the original ranked engine result with an explicit **Engine-only result · external AI unavailable** notice. It never manufactures an AI response or claims an engine-only calculation came from OpenRouter. Cancellation discards the pending result and aborts the server request where possible; provider work already accepted may still consume free quota.

## Validity is evidence, not a promise

The AI is asked to assess the next 10–15 ticks. That request does **not** demonstrate that a signal has a profitable edge over those ticks. Synthetic tick streams may have no predictable edge, even when models agree. The existing measured validity window can therefore be shorter than 10 ticks, including immediate-only or no-edge results. The AI cannot extend it.

The scan timestamp is taken at the market snapshot, **before** engine execution and the AI request. AI latency does not reset the signal's age. The review card flags an elapsed entry window and tells the user to re-run. Entry trigger/replay rules remain the execution source of truth; AI text is not executed. A caution or oppose stance is visible advisory information, not a new automatic-trading gate. Existing user-triggered manual/bot execution behavior is unchanged.

Free models have variable capacity, per-key quotas and quality. Some zero-price providers may be excluded by the no-data-collection policy. Never present a request horizon, model agreement, or model opinion as a guaranteed win rate or guaranteed validity.

## Hosting and abuse protection

- Browser calls are relative `/api/...` requests. Proxy `/api` to the backend and preserve the original Host header (the included Vite proxy does so).
- Cross-origin browser analysis requests are rejected. The service also caps concurrent AI requests at two and total review requests at 12 per minute per server process. These safeguards protect a shared free quota but are **not authentication**.
- This repository's workspace has no user-authentication system. Before exposing it as a public multi-user service, add application authentication, per-user quotas, a shared distributed rate limiter and deployment-level access controls. Do not rely on CORS or Origin checks to stop non-browser clients.
- Use HTTPS for the public deployment. Keep the server environment file (and `.openrouter-key.json` if using Settings storage) outside frontend/static hosting. Do not publish build artifacts containing environment secrets.

## Validation

```sh
pnpm --filter @workspace/api-server test:openrouter
pnpm --filter @workspace/deriv-signal-lab test:digit-analysis
PORT=18781 BASE_PATH=/ pnpm run build
# With pnpm dev running and a locally installed Chromium:
BROWSER_EXECUTABLE_PATH=/path/to/chromium node artifacts/deriv-signal-lab/tests/browser/openrouter-smoke.mjs
```

The browser smoke test uses mocked public Deriv data and mocked AI inference. It exercises all four Tools tabs, connection states (Settings now allows a masked stored key) and engine-only fallback without account tokens or orders. Its initial Settings check expects OpenRouter to be unreachable in a network-restricted sandbox; set `BROWSER_EXPECT_LIVE_OPENROUTER=1` when testing on a host with a verified live connection. Mock tests validate routing/schema/error behavior but do not certify that any real key or model is currently available.

## API endpoints (server)

- `GET /api/openrouter/status?refresh=1` → `{status, configured, message, freeModels, checkedAt, keySource, maskedKey, canClearStored, envConfigured}`
- `GET /api/openrouter/key` → `{configured, source: 'env'|'stored'|'none', maskedKey, envConfigured, message}`
- `POST /api/openrouter/key {key: string}` → saves, invalidates caches, returns fresh `status` (validates `sk-` prefix, length, whitespace)
- `DELETE /api/openrouter/key` → clears stored file (blocked when env var is set), returns fresh `status`
- `POST /api/openrouter/analyze` → engine evidence → AI review (zero-price provider filter, 3 retries across free models)
