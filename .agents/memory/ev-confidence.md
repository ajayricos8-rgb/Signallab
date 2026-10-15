---
name: EV confidence convention
description: Every signal shows a confidence derived from expected value; how the figures are produced and where they must stay consistent.
---

Every signal surface (Over/Under, Even/Odd, Matches, Rise/Fall tools and the premium bots) reports a **confidence computed from expected value**, not from a raw hit rate. `src/lib/ev-confidence.ts` is the single implementation:

- `assessExpectedValue` — binary contract expectancy `EV = q·P − S` per unit staked, mapped onto 0–1 confidence: `0.5 + ROI / (2 · EV_CONFIDENCE_ROI_SCALE)` with `EV_CONFIDENCE_ROI_SCALE = 0.1` (50 % = zero EV, 100 % = +10 % return per unit staked).
- Two payout bases: `live-payout` (real Deriv proposal ask + payout, EV in money) and `fair-payout` (zero-margin price built from a stated reference rate; EV is model lift, no house margin). Never invent a payout.
- `discountedEdgeProbability` — shrinks the model's edge over the reference by its own sampling error (± one-sided 95 %) before the EV is taken; this is what keeps noise on a long-shot contract from producing a strong confidence. The headline `confidence` uses the conservative probability, `pointConfidence` the point estimate.
- `evidenceReliability` — weights only the evidence terms a surface actually reports (held-out skill, agreement, family support, sample, dispersion) and halves everything when market structure shifted.

Over/Under publishes `report.prediction` (barrier + OVER/UNDER + EV confidence) from `runOverUnderEnsemble` **independently of the strict eligibility gates** — a completed scan must never end in “analysis blocked”. The gates stay visible as `prediction.caveats` and `prediction.grade` (`gated` | `research`); `report.selected` keeps its old gate-only meaning, and `tests/over-under-engines.test.mjs` asserts both. The Rise/Fall tool follows the same shape with `ScanSnapshot.prediction` (0.50 even-money break-even).

**Why:** the product owner asked for a usable signal instead of a blocked tile, and for an EV-based confidence on every signal in every tool. Honesty rules stay: no fabricated payouts, reasons are shown, and the copy never promises profitability.

**How to apply:** add new signals by calling `assessExpectedValue`/`discountedEdgeProbability`/`evidenceReliability` rather than inventing another confidence formula, and keep the surface copy pointing at the basis note from the assessment.
