# DBot Space: public feature review

Reviewed 30 October 2026. This is a partial comparison, not an inventory of authenticated or premium functionality. Public text and menu labels do not establish how the underlying features work or whether they are available to a particular account.

## Publicly visible sources

- [Binarytool](https://www.binarytool.site/) exposes Dashboard, Bot Builder, Manual Digit Trader, Free Bots, Sequence Bots, Hedging Tool, AI Signal, NeuraPulse AI, Quick Bot, Analysis Tools, Auto Trader, DTrader, Chart, Copy Trading and Deriv Course. Most of these are marked locked without login. Its publicly visible builder mentions XML import, alternate markets, a simultaneous volatility scan, Virtual Hook, bulk purchase, custom notifications, contract modifiers and barrier settings. A label alone does not establish its exact rules, safety or availability.
- [RiskManagers](https://riskmanagers.site/) publicly exposes Load Bot, device XML import, Special Bots, Digits and Risk labels. The site's logged-in functionality and the precise contents of these sections were not accessible in this review. Do not infer feature parity from the labels.

## What Signal Lab already has

DBot Space has an embedded Blockly builder, XML import, chart, a strategy store, a quick-strategy flow and AI copilot. Signal Lab shares volatility data with DBot and provides trading and analysis elsewhere in the app. Some custom blocks provide scanning, virtual ledger, hedging and risk logic. These existing tools are not necessarily equivalent to similarly named features on either reference site: the bot-store presets now share one AI multi-market scan that reads every market Signal Lab streams at the same moment, but it is a model ranking rather than a contract-verified price scanner, and the virtual ledger is not necessarily a Virtual Hook switcher.

## Added in this iteration

- **Digits & risk** tab: a simultaneous read-only view of the volatility markets already streamed by Signal Lab, with a selectable sample window, feed freshness, verified digit counts, even/odd shares and per-digit distribution.
- An isolated loss-sequence and payout calculator. It shows full-loss exposure and break-even from user-entered hypothetical values. It does not enforce limits or interact with DBot orders.
- The embedded builder remains mounted when this tab is open; changing tabs does not intentionally stop a bot.

## Not verified or implemented here

No claim is made that the two reference sites have been reproduced. Their locked areas require user-provided screenshots or specifications. Copy trading, third-party premium/free bot catalogues, trade execution, a Virtual Hook switcher, bulk trading and a contract-verified automated scanner have **not** been copied or newly implemented in this iteration. Never treat the digit monitor as a trade signal or as a test of contract availability. The scenario planner is not an account-level risk control.
