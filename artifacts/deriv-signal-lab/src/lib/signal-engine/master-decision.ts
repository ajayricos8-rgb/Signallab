// Layer 6 — MASTER DECISION: the engines, the AI and the calculations become
// one model with one decisive answer and one measured validity window.
//
// The layers below answer different questions and each was audited on its own:
//   Layer 1 (market-state)      — is there structure in this market at all?
//   Layer 2 (the predictors)    — what is the probability of this outcome?
//   Layer 3 (confirmation)      — does that probability survive calibration?
//   Layer 4 (research library)  — does an independent model suite agree?
//   Layer 5 (precision + entry) — how well is the number known, and when is it
//                                 worth entering?
//
// What was missing is the decision that joins them. A user does not trade a
// probability, a calibration report and an entry plan separately: they trade
// ONE call, at ONE moment, and that call stops being worth taking after some
// number of ticks. This module produces exactly that:
//
//   1. POOL. Every evidence source that has demonstrated out-of-sample skill
//      is weighted by that skill and its independent sample, then pooled in
//      log-odds space. Sources derived from the same data (the AI stack reads
//      the same engine rows) carry a correlation credit so the same evidence is
//      not counted twice. A source with no measured skill gets no weight: it is
//      still reported, but it cannot move the decision.
//
//   2. RECONCILE. The published probability is the calibrated chain's estimate.
//      The pool is an independent committee. When they disagree, the decision
//      is pulled toward the committee by at most a quarter of the gap, and never
//      more than 0.15 log-odds (~3.7 points at even odds), so a committee of
//      correlated measurements can never overrule the audited chain.
//
//   3. DECIDE. The edge must clear its own measured standard error (z ≥ 1.645
//      for a decisive call, z ≥ 0.5 for a speculative one), the edge must have
//      survived across the chronological thirds of the holdout, and the entry
//      must be reachable. Otherwise the honest verdict is NO_EDGE — the best
//      candidate is still returned and the bot can still trade it, but the
//      master does not pretend it measured an edge.
//
//   4. EXPIRE. How long does the edge last? For every replayed signal we hold
//      the prediction fixed and move the entry later by 0…maxLag ticks. The
//      hit rate on those delayed entries measures how fast the edge decays.
//      The validity window is the last lag whose edge is still at least half
//      the initial edge, positive, AND whose one-sided 90% Wilson lower bound
//      still clears the fair rate. Both the delayed overlap and the overlap
//      already present between replayed rows are removed from the effective
//      sample first, so a 5-tick contract replayed every 2 ticks cannot count
//      the same increments as fresh evidence. That window — not a constant —
//      is what the bot is allowed to wait for, and the plan is capped by it.
//
// Pure module: no I/O, no DOM, no clock reads, no mutation of its inputs. Every
// value is structured-clone friendly, so it runs inside the scan Web Workers.
import { entryWindowMs, type EntryPlan, type EntryTrigger } from './entry.ts';
import { clamp, normalCdf, normalPValue, wilsonInterval } from './stats.ts';
import type { SignalStrength } from './confidence.ts';

export type MasterSourceId = 'engines' | 'ai' | 'analysis' | 'research';

export type MasterSourceInput = {
  id: MasterSourceId;
  label: string;
  /** Live probability this source gives the traded outcome (null = no view). */
  probability: number | null;
  /** Measured out-of-sample Brier skill versus the no-edge rate. */
  skill: number | null;
  /** Independent holdout rows behind that skill. */
  sample: number;
  /**
   * Correlation credit (0–1). The AI stack is fitted on the same engine rows,
   * so it shares the prediction family's budget instead of adding a full
   * independent vote. Defaults to 1.
   */
  familyCredit?: number;
  detail?: string;
};

export type MasterSource = {
  id: MasterSourceId;
  label: string;
  probability: number | null;
  /** No-edge probability used as the reference for this source's margin. */
  fair: number;
  skill: number | null;
  sample: number;
  /** Normalized weight in the final pool (0 when the source had no weight). */
  weight: number;
  /** logit(probability) − logit(fair). Positive = supports the outcome. */
  margin: number;
  /** How this source stands relative to the decision that was taken. */
  stance: 'supports' | 'opposes' | 'neutral' | 'unmeasured';
  detail: string;
};

export type MasterPool = {
  /** Skill-weighted pool probability for the traded outcome. */
  probability: number;
  /** Pool margin in log-odds versus the no-edge rate. */
  margin: number;
  /** Sources that carried weight. */
  sources: number;
  /** Weighted share of the pool that pointed the same way as the decision. */
  support: number;
  /** Standard error of the pooled mean margin, in log-odds. */
  standardErrorLogit: number;
};

export type MasterPersistencePoint = {
  /** Ticks of delay between the signal and the entry. */
  lag: number;
  sample: number;
  hits: number;
  rate: number | null;
  /** Hit rate minus the no-edge rate, in probability points. */
  edgePts: number | null;
  /** z-score of that edge after the overlap correction. */
  z: number | null;
  /** One-sided 90% Wilson lower bound for the hit rate. */
  lower: number | null;
};

export type MasterValidity = {
  /** Ticks after which this signal stops being worth entering (≥ 1). */
  ticks: number;
  /** The same window in wall-clock milliseconds at the measured tick cadence. */
  ms: number;
  /** `measured-decay` when replay rows existed; `immediate-only` otherwise. */
  method: 'measured-decay' | 'immediate-only';
  /** Replayed signals behind the curve. */
  sample: number;
  initialEdgePts: number;
  finalEdgePts: number;
  /** First lag whose edge fell to ≤ half the initial edge. */
  halfLifeTicks: number | null;
  /** Share of the chronological thirds whose lag-0 edge was positive. */
  stability: number;
  /** True when the 90% lower bound at the last valid lag still clears fair. */
  lowerBoundClearsFair: boolean;
  /** The full decay curve, including lags outside the window. */
  curve: MasterPersistencePoint[];
};

export type MasterEntryDecision = {
  action: 'enter-now' | 'enter-on-trigger' | 'no-edge';
  trigger: EntryTrigger;
  /** Effective ticks the entry may take (never longer than the validity). */
  windowTicks: number;
  /** Effective wall-clock window in milliseconds. */
  windowMs: number;
  /** True when the entry trigger passed its own out-of-sample validation. */
  validated: boolean;
  /** Measured reach rate of the trigger, when the replay measured it. */
  reachRate: number | null;
  /** One sentence the user and the bot can act on. */
  instruction: string;
};

export type MasterVerdict = 'TRADE_NOW' | 'TRADE_ON_ENTRY' | 'SPECULATIVE' | 'NO_EDGE';

export type MasterDecision = {
  family: 'digit' | 'rise-fall';
  label: string;
  verdict: MasterVerdict;
  /** 1–99 evidence score for the DECISION (it is not a win probability). */
  conviction: number;
  /** The probability the decision was taken on (chain probability, reconciled). */
  probability: number;
  /** The chain's published probability before reconciliation. */
  publishedProbability: number;
  fair: number;
  /** Probability points over the no-edge rate. */
  edgePts: number;
  /** Edge divided by its measured standard error. */
  edgeZ: number | null;
  /** One-sided p-value that the edge is positive. */
  pValue: number | null;
  /** Combined measurement error of the edge, in probability units. */
  standardError: number | null;
  /** The independent committee's own probability (null when nothing had skill). */
  pooled: MasterPool | null;
  /** True when the committee materially moved the published probability. */
  reconciled: boolean;
  sources: MasterSource[];
  validity: MasterValidity;
  entry: MasterEntryDecision;
  /** The published evidence tier, carried through for the UI. */
  strength: SignalStrength;
  /** True only when every gate passed: edge, significance, stability, entry. */
  decisive: boolean;
  /** One-line, action-first summary. */
  headline: string;
  /** Why the decision was taken, in plain language. */
  reasons: string[];
  /** Conditions that make the decision stale before it expires. */
  invalidate: string[];
  /**
   * Ranking score used to pick the strongest candidate across contracts and
   * markets. Verdict dominates; conviction and edge significance break ties.
   */
  priority: number;
};

/** A replayed signal: entry origin and the tick its contract expired on. */
export type ValidityRow = { origin: number; exit: number };

export type ValidityInput = {
  /** Chronological replayed signals. */
  rows: readonly ValidityRow[];
  /**
   * Outcome of the traded call when the entry is delayed by `lag` ticks:
   * 1 = won, 0 = lost, null = not observable (past the end of the data).
   */
  outcome: (row: ValidityRow, lag: number) => 0 | 1 | null;
  /** No-edge probability of the traded outcome. */
  fair: number;
  /** Largest delay inspected. Defaults to 10 ticks. */
  maxLag?: number;
  /** Minimum rows a lag must retain to stay inside the window. */
  minimumSample?: number;
};

export type MasterDecisionInput = {
  family: 'digit' | 'rise-fall';
  label: string;
  fair: number;
  /** Probability published by the chain (confirmation → research → precision). */
  publishedProbability: number;
  /** Its measured standard error, when the precision layer produced one. */
  publishedStandardError: number | null;
  /** The chain's evidence score, 1–99. */
  publishedConfidence: number;
  strength: SignalStrength;
  sources: readonly MasterSourceInput[];
  /** Replayed signals and the lookup for a delayed expiry. */
  validity: ValidityInput;
  /** Measured median milliseconds between ticks on this market. */
  tickSpacingMs: number;
  entry: EntryPlan;
  /** 0–1 maturity of the tick sample (freshness, structure, size). */
  dataQuality: number;
  /** True when the analysis layer could measure the market's structure. */
  marketMeasured: boolean;
  /** True when the analysis layer measured no exploitable structure. */
  marketRandom: boolean;
  /** True when the analysis layer's structure check passed. */
  structureStable: boolean;
  /** Confirmation layer: the edge survived its out-of-sample calibration. */
  confirmed: boolean;
  /** Research library: a validated ensemble contradicts this call. */
  contradicted: boolean;
};

const LOGIT_FLOOR = 1e-4;
const Z_TRADE = 1.645; // one-sided 5%
const Z_STRONG = 2.326; // one-sided 1%
const MAX_RECONCILE_LOGIT = 0.15;
const RECONCILE_SHARE = 0.25;
/** Largest entry window this layer will ever allow, in ticks. */
const MAX_WINDOW_TICKS = 12;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function safeProbability(value: number): number {
  return clamp(value, 0.0005, 0.9995);
}

function logit(probability: number): number {
  const p = clamp(probability, LOGIT_FLOOR, 1 - LOGIT_FLOOR);
  return Math.log(p / (1 - p));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-clamp(value, -30, 30)));
}

/**
 * Weight of one evidence source.
 *
 * `skill` is an out-of-sample Brier skill (0.01–0.05 is meaningful, 0.03 is
 * strong). `tanh(30 × skill)` maps it to 0.29 / 0.76 / 0.91 so a proven source
 * leads but a marginally better one cannot dominate the pool. The sample factor
 * `n / (n + 50)` stops a thin holdout from speaking as loudly as 500 rows. A
 * source with no positive skill — or fewer than 20 rows — gets zero: it is
 * reported and coloured, never counted.
 */
export function sourceWeight(source: MasterSourceInput): number {
  if (!finite(source.probability)) return 0;
  const sample = clamp(finite(source.sample) ? source.sample : 0, 0, 5_000);
  const skill = clamp(finite(source.skill) ? source.skill : 0, 0, 0.25);
  if (skill <= 0 || sample < 20) return 0;
  const reliability = Math.tanh(30 * skill);
  const sampleWeight = sample / (sample + 50);
  const credit = clamp(finite(source.familyCredit) ? (source.familyCredit as number) : 1, 0, 1);
  return reliability * sampleWeight * credit;
}

function poolSources(input: readonly MasterSourceInput[], fair: number): {
  sources: MasterSource[];
  pooled: MasterPool | null;
  totalWeight: number;
} {
  const reference = logit(safeProbability(fair));
  const raw = input.map((source) => {
    const weight = sourceWeight(source);
    const probability = finite(source.probability) ? safeProbability(source.probability as number) : null;
    const margin = probability === null ? 0 : logit(probability) - reference;
    return { source, weight, probability, margin };
  });
  const totalWeight = raw.reduce((total, row) => total + row.weight, 0);
  const weighted = raw.filter((row) => row.weight > 0);
  const weightedCount = weighted.length;
  const sources: MasterSource[] = raw.map((row) => {
    const stance: MasterSource['stance'] =
      row.probability === null ? 'unmeasured' : Math.abs(row.margin) < 0.01 ? 'neutral' : row.margin > 0 ? 'supports' : 'opposes';
    return {
      id: row.source.id,
      label: row.source.label,
      probability: row.probability,
      fair,
      skill: finite(row.source.skill) ? row.source.skill : null,
      sample: Math.max(0, Math.round(finite(row.source.sample) ? row.source.sample : 0)),
      weight: totalWeight > 0 ? row.weight / totalWeight : 0,
      margin: row.margin,
      stance,
      detail: row.source.detail ?? '',
    };
  });
  if (!weightedCount) return { sources, pooled: null, totalWeight };

  let margin = 0;
  let sumSquares = 0;
  for (const row of weighted) {
    const weight = row.weight / totalWeight;
    margin += weight * row.margin;
    sumSquares += weight * weight;
  }
  // Standard error of the weighted mean of heterogeneous sources: the weighted
  // scatter of their margins over the effective number of independent votes.
  let scatter = 0;
  if (weightedCount >= 2 && sumSquares < 1 - 1e-9) {
    let weightedVariance = 0;
    for (const row of weighted) weightedVariance += (row.weight / totalWeight) * (row.margin - margin) ** 2;
    scatter = Math.sqrt(weightedVariance / (1 - sumSquares));
  }
  const standardErrorLogit = weightedCount >= 2 ? scatter / Math.sqrt(weightedCount) : 0;
  const support = weighted.reduce((total, row) => total + (row.margin > 0 === margin > 0 ? row.weight / totalWeight : 0), 0);
  return {
    sources,
    pooled: {
      probability: sigmoid(reference + margin),
      margin,
      sources: weightedCount,
      support,
      standardErrorLogit,
    },
    totalWeight,
  };
}

/**
 * Measure how long an edge survives after the signal.
 *
 * For lag L the prediction is unchanged and the contract is allowed to expire
 * L ticks later, so the hit rate at L is what a user who waits L ticks actually
 * gets. Delayed outcomes overlap more as L grows, so the effective sample is
 * discounted by `n / (1 + L / span)`, where `span` is the contract's own
 * origin→exit distance. The window ends at the first lag that loses either half
 * the original edge or the minimum sample.
 */
export function measureValidity(input: ValidityInput, tickSpacingMs: number): MasterValidity {
  const spacing = finite(tickSpacingMs) && tickSpacingMs > 0 ? tickSpacingMs : 1_000;
  const fair = clamp(finite(input.fair) ? input.fair : 0.5, 0.001, 0.999);
  const rows = [...input.rows]
    .filter((row) => finite(row.origin) && finite(row.exit) && row.exit >= row.origin)
    .sort((left, right) => left.origin - right.origin || left.exit - right.exit);
  const sample = rows.length;
  const minimum = Math.max(12, Math.round(finite(input.minimumSample) ? (input.minimumSample as number) : 0) || Math.max(12, Math.min(30, Math.round(sample * 0.5))));
  if (sample < minimum) {
    return {
      ticks: 1,
      ms: Math.max(250, Math.round(spacing)),
      method: 'immediate-only',
      sample,
      initialEdgePts: 0,
      finalEdgePts: 0,
      halfLifeTicks: null,
      stability: 0,
      lowerBoundClearsFair: false,
      curve: [],
    };
  }
  const maxLag = clamp(Math.round(finite(input.maxLag) ? (input.maxLag as number) : 10), 1, 30);
  // Every observed span (origin → exit) is at least one tick; use the median so
  // a single irregular contract cannot set the overlap correction for all rows.
  const spans = rows.map((row) => Math.max(1, row.exit - row.origin)).sort((left, right) => left - right);
  const span = spans[Math.floor(spans.length / 2)] ?? 1;
  // Replay rows are not automatically independent: a 5-tick contract replayed
  // every 2 ticks reuses 3 of its 5 outcome increments between neighbours. The
  // lag correction below only priced the DELAYED overlap; at lag 0 the rows
  // themselves were still counted as fresh evidence, which inflated the sample,
  // narrowed the Wilson band, and let noisy edges claim a longer window. The
  // base overlap factor divides by that reuse before any lag is added.
  const originGaps: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const gap = rows[index].origin - rows[index - 1].origin;
    if (finite(gap) && gap > 0) originGaps.push(gap);
  }
  originGaps.sort((left, right) => left - right);
  const stride = originGaps[Math.floor(originGaps.length / 2)] ?? span;
  const baseOverlap = Math.max(1, span / Math.max(1, stride));

  const curve: MasterPersistencePoint[] = [];
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let hits = 0;
    let observed = 0;
    for (const row of rows) {
      const outcome = input.outcome(row, lag);
      if (outcome !== 0 && outcome !== 1) continue;
      observed += 1;
      hits += outcome;
    }
    if (observed === 0) {
      curve.push({ lag, sample: 0, hits: 0, rate: null, edgePts: null, z: null, lower: null });
      continue;
    }
    const rate = hits / observed;
    const edge = rate - fair;
    const effective = Math.max(1, observed / (baseOverlap + lag / span));
    const deviation = Math.sqrt(Math.max(1e-9, fair * (1 - fair)));
    const z = edge / (deviation / Math.sqrt(effective));
    curve.push({
      lag,
      sample: observed,
      hits,
      rate,
      edgePts: 100 * edge,
      z,
      lower: wilsonInterval(hits, observed, 1.2816).lower,
    });
  }

  const initial = curve[0];
  if (initial.rate === null || !finite(initial.edgePts) || initial.edgePts <= 0) {
    return {
      ticks: 1,
      ms: Math.max(250, Math.round(spacing)),
      method: 'measured-decay',
      sample,
      initialEdgePts: initial.edgePts ?? 0,
      finalEdgePts: initial.edgePts ?? 0,
      halfLifeTicks: null,
      stability: 0,
      lowerBoundClearsFair: false,
      curve,
    };
  }

  // Stability: the same edge sign in every chronological third.
  const thirds = 3;
  let agreeing = 0;
  for (let third = 0; third < thirds; third += 1) {
    const from = Math.floor((sample * third) / thirds);
    const to = Math.floor((sample * (third + 1)) / thirds);
    let hits = 0;
    let observed = 0;
    for (let index = from; index < to; index += 1) {
      const outcome = input.outcome(rows[index], 0);
      if (outcome !== 0 && outcome !== 1) continue;
      observed += 1;
      hits += outcome;
    }
    if (observed > 0 && hits / observed > fair) agreeing += 1;
  }
  const stability = agreeing / thirds;
  // An edge that only existed in one third of the holdout is not stable enough
  // to invite a delayed entry: keep the immediately-tradeable tick only.
  if (stability < 2 / 3) {
    return {
      ticks: 1,
      ms: Math.max(250, Math.round(spacing)),
      method: 'measured-decay',
      sample,
      initialEdgePts: initial.edgePts,
      finalEdgePts: initial.edgePts,
      halfLifeTicks: 0,
      stability,
      lowerBoundClearsFair: (initial.lower ?? -1) > fair,
      curve,
    };
  }

  const threshold = Math.max(0.5 * initial.edgePts, 0.2);
  let ticks = 1;
  let finalEdge = initial.edgePts;
  let halfLife: number | null = null;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    const point = curve[lag];
    if (!point || point.rate === null || !finite(point.edgePts)) break;
    if (halfLife === null && (point.edgePts as number) <= 0.5 * initial.edgePts) halfLife = lag;
    if (point.sample < minimum) break;
    // The sample behind a delayed lag must still be independent enough to
    // measure: overlapping replays do not become more informative by waiting.
    if (point.sample / (baseOverlap + lag / span) < Math.max(12, minimum / 2)) break;
    if ((point.edgePts as number) < threshold || (point.edgePts as number) <= 0) break;
    // A delayed entry has to be justified by the LOWER bound, not just the
    // point estimate: if the 90% Wilson bound at this lag includes the fair
    // rate, the analysis has not measured a positive edge for a late entrant,
    // and the window stops at the previous lag. This is what keeps the
    // published window short on noisy edges instead of letting a lucky point
    // estimate buy extra ticks.
    if (point.lower === null || point.lower <= fair) break;
    ticks = lag;
    finalEdge = point.edgePts as number;
  }
  const last = curve[ticks];
  return {
    ticks,
    ms: Math.max(250, Math.round(ticks * spacing)),
    method: 'measured-decay',
    sample,
    initialEdgePts: initial.edgePts,
    finalEdgePts: finalEdge,
    halfLifeTicks: halfLife,
    stability,
    lowerBoundClearsFair: last?.lower !== null && last?.lower !== undefined ? last.lower > fair : false,
    curve,
  };
}

/** True when the plan's trigger earned its wait out of sample. */
function triggerEarnedWait(entry: EntryPlan): boolean {
  if (entry.trigger === 'immediate' || !entry.measured) return false;
  if (entry.validation) return entry.validation.passed;
  return finite(entry.edgeGainPts) && (entry.edgeGainPts as number) > 0;
}

function signedPoints(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function secondsText(ms: number): string {
  if (ms < 1_000) return '<1 s';
  const seconds = ms / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/**
 * Fuse every measured source into one decision with one validity window.
 * Deterministic and side-effect free: the same inputs always produce the same
 * decision, and the inputs are never mutated.
 */
export function buildMasterDecision(input: MasterDecisionInput): MasterDecision {
  const fair = clamp(finite(input.fair) ? input.fair : 0.5, 0.001, 0.999);
  const published = safeProbability(finite(input.publishedProbability) ? input.publishedProbability : fair);
  const publishedError = finite(input.publishedStandardError) && (input.publishedStandardError as number) > 0
    ? (input.publishedStandardError as number)
    : null;
  const { sources, pooled } = poolSources(input.sources, fair);
  const reference = logit(fair);
  const publishedMargin = logit(published) - reference;

  // Reconcile the calibrated chain with the independent committee. The
  // adjustment is deliberately small and bounded: the chain owns the mapping,
  // the committee only gets to nudge it when the two disagree.
  let decisionMargin = publishedMargin;
  let reconciled = false;
  if (pooled && pooled.sources >= 2 && Math.abs(pooled.margin - publishedMargin) > 0.02) {
    const adjustment = clamp(RECONCILE_SHARE * (pooled.margin - publishedMargin), -MAX_RECONCILE_LOGIT, MAX_RECONCILE_LOGIT);
    if (Math.abs(adjustment) > 1e-9) {
      decisionMargin += adjustment;
      reconciled = true;
    }
  }
  const probability = safeProbability(sigmoid(reference + decisionMargin));
  const edge = probability - fair;
  // Delta-method conversion of the pool's log-odds error into probability units.
  const consensusError = pooled ? probability * (1 - probability) * pooled.standardErrorLogit : 0;
  const standardError = publishedError !== null
    ? Math.hypot(publishedError, consensusError)
    : consensusError > 1e-9 ? consensusError : null;
  const edgeZ = standardError !== null && standardError > 1e-9 ? edge / standardError : null;
  const pValue = edgeZ === null ? null : 1 - normalCdf(edgeZ);

  const measuredValidity = measureValidity(input.validity, input.tickSpacingMs);
  const material = Math.max(0.005, 0.01 * fair);
  const stability = measuredValidity.stability;
  const stable = stability >= 2 / 3;
  const support = pooled?.support ?? 0;
  const decisiveEdge = edge > material;
  const significant = edgeZ !== null && edgeZ >= Z_TRADE;
  const speculative = edgeZ !== null && edgeZ >= 0.5;
  // A decisive call needs either the calibration layer's confirmation or a
  // corroborating pool of at least two skill-weighted sources. A high z alone
  // on a single unconfirmed source is not enough to call it decisive.
  const confirmedEnough = input.confirmed || (pooled?.sources ?? 0) >= 2;

  const waitEarned = triggerEarnedWait(input.entry);
  let stage: 'trade' | 'speculative' | 'none';
  if (!decisiveEdge || !speculative) stage = 'none';
  else if (significant && stable && confirmedEnough && !input.contradicted && measuredValidity.ticks >= 1) stage = 'trade';
  else stage = 'speculative';

  // Without a material, significant edge there is nothing to time: the window
  // collapses to the next tick and the decay curve stays in the audit trail for
  // transparency. Reporting a 5-tick window next to "no measured edge" would be
  // a contradiction, and a longer window would invite chasing noise.
  const spacing = finite(input.tickSpacingMs) && input.tickSpacingMs > 0 ? input.tickSpacingMs : 1_000;
  const validity: MasterValidity = stage === 'none'
    ? { ...measuredValidity, ticks: 1, ms: Math.max(250, Math.round(spacing)) }
    : measuredValidity;

  let action: MasterEntryDecision['action'];
  if (stage === 'none') action = 'no-edge';
  else if (stage === 'speculative') action = 'enter-now';
  else action = waitEarned ? 'enter-on-trigger' : 'enter-now';
  const verdict: MasterVerdict = stage === 'none'
    ? 'NO_EDGE'
    : stage === 'speculative'
      ? 'SPECULATIVE'
      : action === 'enter-now' ? 'TRADE_NOW' : 'TRADE_ON_ENTRY';

  // The plan may already carry a tighter cap (it is written back from this
  // layer, but a re-decision on a stored plan must stay inside it). The window
  // is always the stricter of the measured validity and the plan's own cap.
  const planCap = finite(input.entry.validForTicks) ? Math.round(input.entry.validForTicks as number) : validity.ticks;
  const allowedTicks = Math.max(1, Math.min(validity.ticks, planCap));
  const windowTicks = action === 'enter-now'
    ? 1
    : clamp(Math.min(input.entry.windowTicks, allowedTicks), 1, MAX_WINDOW_TICKS);
  const planWindowMs = entryWindowMs(input.entry, input.tickSpacingMs);
  const validityCapMs = Math.max(250, windowTicks * spacing);
  const windowMs = action === 'enter-now'
    ? validityCapMs
    : Math.max(250, Math.min(planWindowMs, validityCapMs));

  // The master's own evidence score. Half is the audited chain's confidence,
  // half is the statistical posterior that the edge is positive, then stability,
  // source agreement, a measured validity window and a validated entry add
  // bounded credit. The bonuses only apply once the edge has cleared its noise
  // floor, and the score is capped by the verdict: a NO_EDGE call can never
  // advertise more than 45/100, and a speculative one no more than 70/100.
  const posterior = edgeZ === null ? 0.5 : clamp(normalCdf(edgeZ), 0, 0.999);
  const evidenceScore = 100 * posterior;
  const bonus = stage === 'none'
    ? 0
    : 8 * (stability - 0.5) +
      8 * (support - 0.5) +
      4 * clamp(validity.ticks / 4, 0, 1) +
      (waitEarned ? 3 : 0) +
      (input.structureStable ? 1 : -2) +
      (input.contradicted ? -8 : 0);
  const rawConviction = 0.55 * clamp(input.publishedConfidence, 1, 99) + 0.45 * evidenceScore + bonus;
  const convictionCap = stage === 'none' ? 45 : stage === 'speculative' ? 70 : 99;
  const conviction = Math.round(clamp(Math.min(rawConviction, convictionCap), 1, 99));

  const stanceOf = (source: MasterSource): MasterSource['stance'] =>
    source.probability === null ? 'unmeasured' : edge > 0 ? (source.margin > 0.01 ? 'supports' : source.margin < -0.01 ? 'opposes' : 'neutral') : edge < 0 ? (source.margin < -0.01 ? 'supports' : source.margin > 0.01 ? 'opposes' : 'neutral') : source.stance;
  const finalSources = sources.map((source) => ({ ...source, stance: stanceOf(source) }));
  const supportWeight = finalSources.reduce((total, source) => total + (source.stance === 'supports' ? source.weight : 0), 0);

  const label = input.label;
  const entryLabel = input.entry.label.toLowerCase();
  const validText = `valid ~${validity.ticks} tick${validity.ticks === 1 ? '' : 's'} (~${secondsText(validity.ms)})`;
  let headline: string;
  if (stage === 'trade' && action === 'enter-on-trigger') {
    headline = `${label} on ${entryLabel} · edge ${signedPoints(100 * edge)} pts (z ${edgeZ?.toFixed(1)}) · ${validText}`;
  } else if (stage === 'trade') {
    headline = `${label} now · edge ${signedPoints(100 * edge)} pts (z ${edgeZ?.toFixed(1)}) · ${validText}`;
  } else if (stage === 'speculative') {
    headline = `${label} · edge inside its error bar (z ${edgeZ?.toFixed(1)}) · speculative, ${validText}`;
  } else {
    headline = `${label} · no measured short-term edge (z ${edgeZ === null ? '—' : edgeZ.toFixed(1)}) · best candidate only`;
  }

  const reasons: string[] = [];
  if (pooled) {
    reasons.push(
      `The independent committee pooled ${pooled.sources} source${pooled.sources === 1 ? '' : 's'} at ${(100 * pooled.probability).toFixed(1)}% against a ${(100 * fair).toFixed(1)}% no-edge rate; ${(100 * supportWeight).toFixed(0)}% of its weight supports this side.`,
    );
  } else {
    reasons.push('No independent source has demonstrated out-of-sample skill on this market, so the decision rests on the audited chain alone.');
  }
  if (standardError !== null) {
    reasons.push(
      `The published edge of ${signedPoints(100 * edge)} points is ${edgeZ === null ? 'unmeasured' : `${edgeZ.toFixed(2)} standard errors`} over the fair rate; a z below 1.645 is not a decisive edge.`,
    );
  } else {
    reasons.push('The published edge has no measured standard error, so it cannot be certified as decisive.');
  }
  if (validity.method === 'measured-decay') {
    reasons.push(
      `On ${validity.sample} replayed signals the edge decayed from ${validity.initialEdgePts.toFixed(1)} to ${validity.finalEdgePts.toFixed(1)} points over ${validity.ticks} tick${validity.ticks === 1 ? '' : 's'} (${validity.stability * 3}/3 chronological thirds agreed).`,
    );
  } else {
    reasons.push(`Only ${validity.sample} replayed signal${validity.sample === 1 ? '' : 's'} were available, so the signal is treated as valid for the next tick only.`);
  }
  if (input.entry.trigger === 'immediate') {
    reasons.push('The entry replay found no timing edge to wait for: the analysis buys at the next tick.');
  } else if (waitEarned) {
    reasons.push(`The ${entryLabel} earned its wait out of sample (${input.entry.validation ? `${input.entry.validation.sample} newer signals` : `${signedPoints(input.entry.edgeGainPts ?? 0)} points`}), so the entry waits inside the measured window.`);
  } else {
    reasons.push(`The ${entryLabel} did not beat buying at the signal on newer rows, so the master enters at the next tick instead of waiting.`);
  }
  if (input.contradicted) reasons.push('The research library validated a contrary estimate; the verdict cannot be decisive.');
  if (input.marketRandom) reasons.push('The analysis engines measured no exploitable market structure; only measured out-of-sample skill can carry this call.');
  if (!input.marketMeasured) reasons.push('The market could not be measured reliably yet; treat the decision as provisional.');
  if (input.dataQuality < 0.9) reasons.push(`Data quality is ${(input.dataQuality * 100).toFixed(0)}% of a full sample, which lowers the evidence score.`);
  if (reconciled) reasons.push('The independent committee disagreed with the calibrated chain, so the decision probability was pulled a bounded quarter of the way toward it.');

  const invalidate: string[] = [
    `The entry window closes after ${action === 'enter-on-trigger' ? windowTicks : 1} tick${(action === 'enter-on-trigger' ? windowTicks : 1) === 1 ? '' : 's'} (~${secondsText(windowMs)}).`,
    'A newer Run Analysis replaces this snapshot; the bot refuses analyses older than 15 minutes.',
  ];
  if (input.entry.trigger === 'quote' && input.entry.priceLevel !== null) {
    invalidate.push('The quote trades through the entry level without a fill, or gaps past the no-chase band.');
  }
  if (input.entry.trigger === 'digit') {
    invalidate.push('The tick context the entry needs does not print inside the window.');
  }
  if (!input.structureStable) invalidate.push('The market structure changes again before entry; re-run the analysis.');
  if (verdict === 'NO_EDGE') invalidate.push('The measured edge is smaller than its own error bar; a decisive entry needs a fresh analysis with a larger edge.');
  if (verdict === 'SPECULATIVE') invalidate.push('The edge has not cleared 1.645 standard errors; only a speculative stake is justified.');

  const instruction = action === 'no-edge'
    ? `No measured edge on ${label}. The candidate is shown for completeness, but the analysis cannot certify a short-term entry.`
    : action === 'enter-now'
      ? `Open ${label} at the next tick${stage === 'trade' ? ` — only ${validText}` : ' — speculative, size down'}.`
      : `Open ${label} on the ${entryLabel} within ${windowTicks} tick${windowTicks === 1 ? '' : 's'} (~${secondsText(windowMs)}); the edge is worth entering for ${validText}.`;

  const priority =
    conviction +
    (stage === 'trade' && action === 'enter-now' ? 6 : stage === 'trade' ? 4 : stage === 'speculative' ? -10 : -25) +
    clamp(edgeZ ?? 0, -2, 3) +
    (waitEarned ? 1 : 0);

  return {
    family: input.family,
    label,
    verdict,
    conviction,
    probability,
    publishedProbability: published,
    fair,
    edgePts: 100 * edge,
    edgeZ,
    pValue,
    standardError,
    pooled,
    reconciled,
    sources: finalSources,
    validity,
    entry: {
      action,
      trigger: input.entry.trigger,
      windowTicks,
      windowMs,
      validated: waitEarned,
      reachRate: finite(input.entry.reachRate) ? input.entry.reachRate : null,
      instruction,
    },
    strength: input.strength,
    decisive: stage === 'trade',
    headline,
    reasons,
    invalidate,
    priority,
  };
}

/** One sentence for a ledger line, bot page or export. */
export function describeMasterDecision(decision: MasterDecision): string {
  return `${decision.headline}. ${decision.entry.instruction}`;
}

/** True when this decision should be preferred when ranking candidates. */
export function masterPriority(decision: MasterDecision | null | undefined): number {
  return decision ? decision.priority : -100;
}

/** Upper-tail p-value helper kept next to the model for the UI/exports. */
export function oneSidedPValue(zScore: number | null): number | null {
  return finite(zScore) ? 1 - normalCdf(zScore) : null;
}

// Re-exported so a caller that only imports this module can format the same
// two-sided value the rest of the workspace uses.
export const masterNormalPValue = normalPValue;
