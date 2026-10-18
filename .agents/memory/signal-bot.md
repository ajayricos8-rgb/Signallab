---
name: Signal bot (mini bottom trade menu)
description: How Load and Run turns a finished analysis into automated, sequential trades, and which settings come from where.
---

Every Tools tab ends in the mini bottom trade menu (`components/trade-dock.tsx`). When **Run Analysis** finishes, the dock pops itself open (if it was minimized) and shows **Load and Run** next to the manual Trade button. Pressing it opens the mini bot page (`components/signal-bot-window.tsx`) above the dock and starts trading the signal that produced it.

Division of settings, which is the whole point of the feature:

- **From the analysis**: market, contract type, barrier/target digit, tick (or minute) duration, the number of runs (`recommendedRuns` — STRONG ≈ 20, MODERATE ≈ 12, WEAK ≈ 6, ±1 run per 10 confidence points away from 60) and the **entry** the trade should be opened on (`plan.entry`, see `signal-engine.md`).
- **From the trade menu**: the stake typed into the ticket, the martingale ladder (multiplier + max steps), the stop loss (consecutive losses, 0 = off), an optional runs override (0 = use the analysis) and the **Entry misses** box, which only decides what happens on a run where the planned entry never arrives: `analysis` (default — enter at the signal price when the window closes, exactly the policy the replay scored) or `skip` (drop that run). Neither mode can change where the entry comes from; the retired `market` (buy immediately) and `level` (wait for an unmeasured level) modes are sanitised back to `analysis`.

Every run is armed on the entry first: `planRunEntry` re-bases the level on the latest feed quote (`rebaseEntryPlan`, so run 12 waits for the same measured move run 1 did), pushes a `waiting` row, and `hooks/use-signal-bot.ts` polls the shared public feed every 250 ms through `evaluateEntry`. The entry is never rebuilt here — it is the plan the engine produced, and `planRunEntry` is only reached with a plan that passed `isEntryPlan` (which includes the analysis provenance in `EntryPlan.evidence`); a signal without one is refused with "run Analysis again" instead of being traded. Ticks and the wall-clock deadline both end the wait; then the run buys (or is skipped in `skip` mode) and the loop continues with the contract settlement below. `entryWatch` is the live state the bot page renders (level, gap, ticks waited/left).

Rules live in pure modules so they stay testable: `lib/signal-bot/plan.ts` (runs, ladder sizing, entry decisions, stop decisions, settlement patience, summary) and `lib/signal-bot/types.ts`. `hooks/use-signal-bot.ts` owns the ordering: arm entry → wait → quote → buy → wait for that contract to settle → next run, one contract open at a time, with a 4 s account refresh as a backstop for the `proposal_open_contract` stream. `MarketFeedProvider` therefore sits above `SignalBotProvider` in `App.tsx`: the entry wait needs live ticks even while the user is on another workspace tab.

State lives in `components/signal-bot-provider.tsx`, mounted above the workspace tabs inside `DerivTradingProvider`, so switching tool or workspace tab never kills a run. The bot page itself is rendered by whichever trade menu is mounted, so it always sits directly above the ticket it belongs to; while the user is away from Tools the run continues with only the trade-history badge as a visible cue.

**Why:** the user asked for a bot that mirrors the ticket they configured by hand, so the stake and martingale must be read from the dock rather than duplicated in a separate bot form, while the tradeable terms must come from the analysis so the bot can never drift from the signal it was started on.

**Load and Run always trades.** The research library's execution gates used to relabel the button **Observation only** and disable it (`researchExecutionIssue`), and `quoteEconomics` used to throw before `confirmBuy` whenever the live payout did not clear break-even. Both were removed: a finished analysis with an entry plan must be tradeable. `researchAdvisory` returns one sentence that is printed on the trade menu and on the bot page (`bot-research-advisory`), and the payout check is recorded in the run's `note` (`economicsNote`). Everything else that can refuse a run is still a real refusal: not connected, invalid stake, an entry that did not come out of an analysis, or an analysis older than 15 minutes.

**How to apply:**
- Stop only blocks new purchases and closes a run that is still waiting for its entry as `skipped`. A contract Deriv already accepted keeps running to expiry, and its row still fills in when Deriv reports it (the settlement watcher is detached, not dropped).
- Reset clears the page (runs, totals, error) and returns the bot to `idle`; it is only offered when the bot is not running.
- A skipped entry never charged the account, so it is not counted in `summary.staked` (which counts rows with a contract id) and it does not move the losing streak.
- Never let the bot trade an entry that did not come out of a run: the dock and the hook both check `isEntryPlan(plan.entry)`, and the plan carries `evidence` (engines, AI probability, the analysis's rating vs the no-edge rate, the replay rule) that the tools and the bot page print so the user can see where the entry came from.
- Add new order types by extending `lib/deriv-trading.ts` and the plan types — never by sending ad-hoc messages from the hook.
- `tests/signal-bot.test.mjs` covers the run count, the ladder, the entry decisions, the stop decisions and the summary.
- `plan.research` carries the fusion (`agreeing/total` models, weight, probability points, validated) from the analysis into the bot page; `plan.researchDecision` is advisory only.
