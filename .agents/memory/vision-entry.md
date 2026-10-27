---
name: Vision entry switch
description: Why the AI Vision Over/Under bot can analyse every tick and still open nothing, and the four changes that stop it.
---

The bot is a strategy file (`src/lib/bot-store/bots/ai-vision-over-under.xml`), so its entries depend on
DBot's cycle: **tick block → trade options → purchase conditions → purchase → after purchase → trade again**.
Four separate things in that cycle could each swallow every entry, and all four are now guarded:

1. **Warm-up.** `getPlan()` used to return `null` below 80 ticks. Combined with a market block that switched
   every two seconds, a session could stay below the floor forever, so the AI never produced a decision.
   The floor is now `MIN_TICKS_TO_READ = 12` (`vision-entry.mjs`) and below it the market's last decision is
   handed back instead of nothing.
2. **Invalid prediction.** `vision_barrier` returned `-1` when there was no plan; `trade_definition_tradeoptions`
   turns that into `prediction: -1`, which the API rejects and `Bot.purchase` retries forever. `readBarrier` /
   `readDirection` now fall back to the last priced barrier, then to the neutral *Over 0* (nine winning digits).
3. **Payout latency.** `getPlan` awaited `ensurePayouts` (up to 20 proposals, hard-capped at 4 s per attempt,
   once per market per 30 s window). On a two-second market that is a missed tick per switch. The plan now
   prices on `peekPayouts` (cache/storage/modelled ladder) and refreshes in the background; only the explicit
   refresh block waits.
4. **The gate itself.** With the bars off, `go` required `bias > 0`; on a fair index the shrunk blend sits at
   the fair odds, so a plan could name a barrier and then refuse to buy it. Relaxed plans now always trade
   (`forced` is reported honestly in the reason and summary), and `entryDecision` in `vision-entry.mjs` adds
   the memory/neutral fallback when there is no plan at all.

**Pacing** is `createEntryPacer` (one position per `DEFAULT_ENTRY_GAP_MS = 2 000`). The XML marks an entry with
`vision_mark_entry` immediately before the purchase and holds the *cycle* with `vision_wait_entry` before
`trade_again`, so trade options are rebuilt from a fresh decision rather than a two-second-old one.

**Coherence:** only `vision_analyse` rebuilds the plan (`getPlan(overrides, { fresh: true })`); every other block
reads the cached plan for up to `PLAN_REUSE_MS = 15 000`. Rebuilding per getter used to let the barrier in the
trade options differ from the barrier in the purchase conditions.

**Why:** the user reported the bot analysing and choosing markets but never opening a position. Three of the
four traps above are silent — no error, no journal line — which is why the wait is now *named* ("warming up —
3/12 ticks on this market") instead of hidden.

**How to apply:** keep the four guards when editing the bot; `tests/ai-vision-bot.test.mjs` asserts the wiring,
`tests/vision-entry.test.mjs` the pacing and fallbacks, and `tests/vision-engine.test.mjs` that a relaxed plan
always carries a buyable contract. Never reintroduce a blocking await inside `getPlan`.
