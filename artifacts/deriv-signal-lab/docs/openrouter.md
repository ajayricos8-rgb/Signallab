# OpenRouter analysis

## Configure securely

1. Create or rotate an OpenRouter key. A key shared in chat must be considered exposed and should be rotated.
2. Configure **`OPENROUTER_API_KEY` on the API server**, preferably in the deployment's secret manager. For local development, copy `artifacts/api-server/.env.example` to `artifacts/api-server/.env` and fill it there. This file is ignored by Git.
3. Run `pnpm dev`. The development launcher loads that server-only file when starting the API; `pnpm --filter @workspace/api-server start` also loads it. When running the compiled JavaScript directly, inject the environment variable yourself or use Node's `--env-file` option. Restart the API after changing the secret.
4. In **Settings → OpenRouter → Test connection**, verify the live connection.

Never put the key in `VITE_*`, frontend environment files, source code, localStorage, browser request headers, URLs or commits. The Settings card intentionally has no key input, key preview, or key retrieval API. The server returns only a boolean configuration state, a connection status, safe messages, the free-model count and a timestamp. It never returns the key or the provider's key metadata. Provider errors are mapped to safe messages rather than echoed or logged.

The API server must have outbound HTTPS access to `https://openrouter.ai/api/v1`. A configured key alone does **not** count as connected: Settings calls the authenticated `/key` endpoint and validates the available free-model catalogue. This verifies authentication/catalogue access, not guaranteed inference capacity. A failed or blocked connection is explicitly **Unavailable**. Status is cached for 60 seconds, with the manual test allowing refresh after five seconds.

## What Run Analysis does

The Rise/Fall, Over/Under, Even/Odd and Matches tools use the same pipeline:

1. Snapshot the market histories and run the existing worker-based engines, research library, calibration, holdout validation, precision corrections and entry replay.
2. Rank the engine results. Send a bounded evidence packet containing the top engine-generated candidate for each of up to 20 markets to the app's same-origin `POST /api/openrouter/analyze` endpoint. The packet includes public market data, recent ticks, per-engine estimates/weights, measured probabilities and fair rates, error bars, holdout outcomes, research fusion, local statistical synthesis and entry rules. It excludes Deriv PATs, accounts, balances, positions, settlements and trade history.
3. On the server, retrieve the live model catalogue (five-minute cache), filter to text models with **`:free` IDs AND zero prompt/completion prices**, and randomly select one using Node's cryptographic random generator. Each run makes a fresh random selection; repeats are possible.
4. Ask that actual external model to combine the evidence into an analysis, a **10–15 tick outlook**, an entry/invalidation explanation, risks, and selection of one supplied candidate. Provider routing also sets a zero-price ceiling and denies data-collection providers. No paid-model fallback is allowed.
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
- Use HTTPS for the public deployment. Keep the server environment file outside frontend/static hosting. Do not publish build artifacts containing environment secrets.

## Validation

```sh
pnpm --filter @workspace/api-server test:openrouter
pnpm --filter @workspace/deriv-signal-lab test:digit-analysis
PORT=18781 BASE_PATH=/ pnpm run build
# With pnpm dev running and a locally installed Chromium:
BROWSER_EXECUTABLE_PATH=/path/to/chromium node artifacts/deriv-signal-lab/tests/browser/openrouter-smoke.mjs
```

The browser smoke test uses mocked public Deriv data and mocked AI inference. It exercises all four Tools tabs, connection states and engine-only fallback without account tokens or orders. Its initial Settings check expects OpenRouter to be unreachable in a network-restricted sandbox; set `BROWSER_EXPECT_LIVE_OPENROUTER=1` when testing on a host with a verified live connection. Mock tests validate routing/schema/error behavior but do not certify that any real key or model is currently available.
