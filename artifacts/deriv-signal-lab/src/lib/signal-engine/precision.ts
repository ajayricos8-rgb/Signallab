// Layer 3c — PRECISION: winner's-curse correction and honest intervals.
//
// Every scan ranks many candidates at once (up to 16 contracts or 25 durations
// per market, times every market in the scan) and reports the winner. The
// winner of a noisy contest is not the best candidate — it is the luckiest one.
// Two classical statistics fix that, and both are used here:
//
// 1. RANDOM-EFFECTS (DerSimonian–Laird / empirical-Bayes) SHRINKAGE.
//    Each candidate's edge `e_j` is observed with a standard error `s_j`. Under
//    the null "no candidate anywhere has an edge", the standardised edges
//    e_j/s_j are ~N(0,1) and Cochran's Q = Σ (e_j/s_j)² is ~χ²(m−1). The excess
//    of Q over its null expectation estimates τ², the variance of the TRUE
//    edges. Each edge is then shrunk by its reliability τ²/(τ² + s_j²):
//      * pure noise  → Q ≈ m−1 → τ² = 0  → every edge collapses to zero;
//      * real edges  → Q ≫ m−1 → τ² > 0  → large, well-measured edges survive,
//                                          small or noisy ones shrink hard.
//    This is the minimum-MSE estimator under a no-edge prior, so it improves
//    accuracy AND precision at the same time: it cannot be gamed by scanning
//    more markets, because more candidates raise the bar for Q.
//
// 2. WINNER'S-CURSE (selection) CORRECTION ON THE REPORTED EDGE.
//    Even after shrinkage, the maximum of m noisy estimates is biased upward by
//    roughly E[max of m standard normals] · s. We subtract that bias from the
//    selected candidate only, using the partial (0.6) correction the confidence
//    layer already applies to z-scores, so the two stay consistent.
//
// Nothing here can create an edge. Every operation either leaves an estimate
// alone or moves it toward "no edge".
import { chiSquarePValue, clamp, normalCdf } from './stats.ts';

/** Prior sd of a true edge when the pool is too small to estimate τ. */
const PRIOR_EDGE_SD = 0.05;

export type CandidateEstimate = {
  /** Measured edge of this candidate over its no-edge (fair) probability. */
  edge: number;
  /** Standard error of that edge, in probability units. */
  standardError: number;
};

export type Heterogeneity = {
  /** Candidates pooled. */
  count: number;
  /** Cochran's Q: Σ (edge / standardError)². */
  q: number;
  degreesOfFreedom: number;
  /** P-value of Q under the null "every true edge is zero". */
  pValue: number;
  /** DerSimonian–Laird estimate of the variance of the true edges. */
  tau: number;
  /** I²: share of the spread in observed edges not explained by noise (0–1). */
  iSquared: number;
  /** True when the pool shows more dispersion than noise alone explains. */
  heterogeneous: boolean;
};

/**
 * Šidák-corrected critical z for "this candidate is individually significant",
 * given `count` candidates inspected. It grows with the pool so that scanning
 * more markets cannot manufacture standouts.
 */
export function standoutThreshold(count: number): number {
  if (count < 2) return 3;
  // Two-sided 5% family-wise error: 1 − (1 − α/2)^count = 0.05.
  const perCandidate = 1 - 0.95 ** (1 / count);
  return Math.max(2.5, inverseNormalCdf(1 - perCandidate / 2));
}

/** Inverse standard normal CDF by bisection (accurate to ~1e-10). */
export function inverseNormalCdf(probability: number): number {
  const target = clamp(probability, 1e-9, 1 - 1e-9);
  let low = -12;
  let high = 12;
  for (let step = 0; step < 80; step += 1) {
    const middle = (low + high) / 2;
    if (normalCdf(middle) < target) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

/**
 * Cochran's Q test for heterogeneity plus the DerSimonian–Laird τ².
 *
 * `heterogeneous` is deliberately strict: τ² stays 0 unless Q exceeds its null
 * expectation by a margin that clears a one-sided 10% chi-square test, so a
 * pool of noise cannot bootstrap itself into "real dispersion exists".
 */
export function heterogeneity(candidates: readonly CandidateEstimate[]): Heterogeneity {
  const usable = candidates.filter((candidate) => Number.isFinite(candidate.edge) && Number.isFinite(candidate.standardError) && candidate.standardError > 1e-9);
  const count = usable.length;
  const degreesOfFreedom = Math.max(0, count - 1);
  const empty: Heterogeneity = { count, q: 0, degreesOfFreedom, pValue: 1, tau: 0, iSquared: 0, heterogeneous: false };
  if (count < 3) return empty;

  let q = 0;
  let weightTotal = 0;
  let weightSquaredTotal = 0;
  for (const candidate of usable) {
    const weight = 1 / candidate.standardError ** 2;
    q += weight * candidate.edge ** 2;
    weightTotal += weight;
    weightSquaredTotal += weight ** 2;
  }
  const pValue = chiSquarePValue(q, degreesOfFreedom);
  // One-sided 10% critical value of χ²(df) — approximated with the Wilson–
  // Hilferty cube-root transform, accurate to ~0.5% for df ≥ 1.
  const critical = degreesOfFreedom * (1 - 2 / (9 * degreesOfFreedom) + 1.2816 * Math.sqrt(2 / (9 * degreesOfFreedom))) ** 3;
  const excess = q - degreesOfFreedom;
  const denominator = weightTotal - weightSquaredTotal / weightTotal;
  const tau = excess > 0 && denominator > 1e-12 ? Math.sqrt(excess / denominator) : 0;
  const iSquared = q > 1e-12 ? clamp(excess / q, 0, 1) : 0;
  return {
    count,
    q,
    degreesOfFreedom,
    pValue,
    tau,
    iSquared,
    heterogeneous: excess > 0 && q > critical && tau > 1e-6,
  };
}

export type Standout = {
  index: number;
  /** Standardised edge (edge / standardError). */
  z: number;
};

export type ShrinkageResult = {
  /** τ² used to shrink the non-standout candidates (0 when their spread is noise). */
  tau: number;
  /** τ²/(τ² + s²), or 1 for a candidate that cleared the standout bar. */
  factors: number[];
  /** Shrunken edges, in input order. */
  edges: number[];
  /** Candidates that cleared the individually-significant bar. */
  standouts: Standout[];
  /** z-score each candidate had to beat to be treated as a standout. */
  standoutThreshold: number;
  /** Winner's-curse points removed from a selected candidate, per unit of its own standard error. */
  selectionBiasUnits: number;
  heterogeneity: Heterogeneity;
  /** Heterogeneity of the pool AFTER the standouts were removed from it. */
  trimmedHeterogeneity: Heterogeneity;
};

/**
 * Shrink every candidate's edge toward zero by its own measurement error.
 *
 * The dispersion of the TRUE edges (τ²) is estimated with a TRIMMED
 * random-effects fit, not a plain one, and that matters: the pool is a mixture
 * of a few real edges and a lot of noise, and a plain DerSimonian–Laird fit
 * lets one or two large edges inflate τ² for everybody — one genuine contract
 * would then license the noise in the other fifteen. So candidates that are
 * individually significant at the Šidák-corrected bar are set aside first and
 * τ² is estimated from the remainder:
 *
 *   standouts  → keep their measured edge (the winner's-curse correction for
 *                the act of selecting is returned separately, per unit of the
 *                selected candidate's own standard error);
 *   the rest   → shrunk by τ²_null/(τ²_null + s²), which is zero whenever
 *                their spread is fully explained by noise.
 *
 * Net effect: noise pools collapse to nothing, and a real edge is never
 * propped up by — nor diluted by — the candidates around it.
 */
export function shrinkEdges(
  candidates: readonly CandidateEstimate[],
  options: {
    /**
     * An independent, out-of-sample source measured a real edge (for the
     * callers here: the analysis prior passed its own Brier-skill gate). Only
     * then may a small pool fall back to a specified prior instead of
     * collapsing to zero — a market where nothing independent found structure
     * still publishes no edge just because it was measured on few candidates.
     */
    independentEdge?: boolean;
  } = {},
): ShrinkageResult {
  const measurable = candidates
    .map((candidate, index) => ({ index, candidate, usable: Number.isFinite(candidate.edge) && Number.isFinite(candidate.standardError) && candidate.standardError > 1e-9 }))
    .filter((row) => row.usable);
  const threshold = standoutThreshold(measurable.length);
  const zScores = new Map<number, number>();
  const standouts: Standout[] = [];
  for (const row of measurable) {
    const z = row.candidate.edge / row.candidate.standardError;
    zScores.set(row.index, z);
    if (Math.abs(z) >= threshold) standouts.push({ index: row.index, z });
  }
  const trimmedPool = candidates.filter((_, index) => !zScores.has(index) || Math.abs(zScores.get(index) as number) < threshold);
  const trimmed = heterogeneity(trimmedPool);
  const full = heterogeneity(candidates);
  // Empirical Bayes needs at least three candidates before Cochran's Q can say
  // anything about the spread of TRUE edges. With one or two (a single duration,
  // or a two-market scan) τ² is unidentifiable, and collapsing it to zero
  // declared every edge imaginary — a genuine 5-point edge measured on one
  // duration was published as a coin flip. With a small pool we therefore fall
  // back to a SPECIFIED prior (PRIOR_EDGE_SD) instead of an estimated one, which
  // is the standard empirical-Bayes answer when τ is unidentified: an edge of
  // unknown size, typically small, and still shrunk by its own standard error.
  const smallPool = measurable.length < 3;
  const tau = smallPool
    ? options.independentEdge ? PRIOR_EDGE_SD : 0
    : trimmed.heterogeneous ? trimmed.tau : 0;
  const factors = candidates.map((candidate, index) => {
    if (!Number.isFinite(candidate.edge) || !Number.isFinite(candidate.standardError) || candidate.standardError <= 1e-9) return 0;
    if (Math.abs(zScores.get(index) ?? 0) >= threshold) return 1;
    return tau ** 2 / (tau ** 2 + candidate.standardError ** 2);
  });
  const edges = candidates.map((candidate, index) => (Number.isFinite(candidate.edge) ? candidate.edge : 0) * factors[index]);
  // Expected maximum of `m` standard normals, at the same 0.6 partial
  // correction the confidence layer uses for the best-of-pool z penalty. A
  // caller that selects the top candidate subtracts
  // `selectionBiasUnits × that candidate's standard error`.
  const selectionBiasUnits = measurable.length >= 2 ? 0.6 * Math.sqrt(2 * Math.log(Math.max(2, measurable.length))) : 0;
  return {
    tau,
    factors,
    edges,
    standouts,
    standoutThreshold: threshold,
    selectionBiasUnits,
    heterogeneity: full,
    trimmedHeterogeneity: trimmed,
  };
}

/**
 * Standard error of a mean win-rate measured on `sample` rows, inflated for
 * first-order serial correlation. Overlapping replay rows are the norm in this
 * code base, and ignoring the autocorrelation would understate every interval.
 */
export function rateStandardError(rate: number, sample: number, lagOneAutocorrelation: number | null = null): number {
  if (!(sample > 0)) return 0;
  const variance = Math.max(1e-9, rate * (1 - rate));
  const inflation = 1 + 2 * Math.max(0, Math.min(0.9, lagOneAutocorrelation ?? 0));
  return Math.sqrt(variance * inflation / sample);
}

/** First-order autocorrelation of a numeric series (null when unmeasurable). */
export function lagOneAutocorrelation(values: readonly number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length < 12) return null;
  const center = usable.reduce((total, value) => total + value, 0) / usable.length;
  let variance = 0;
  let covariance = 0;
  for (let index = 0; index < usable.length; index += 1) variance += (usable[index] - center) ** 2;
  for (let index = 1; index < usable.length; index += 1) covariance += (usable[index] - center) * (usable[index - 1] - center);
  if (!(variance > 1e-12)) return null;
  return clamp(covariance / variance, -0.99, 0.99);
}

export type AccuracyAudit = {
  sample: number;
  /** Forecast probabilities. */
  forecasts: number[];
  /** Realised outcomes. */
  outcomes: number[];
  /** Mean forecast. */
  meanForecast: number;
  /** Realised frequency. */
  observedRate: number;
  /** Mean forecast − realised rate (positive = overconfident). */
  bias: number;
  /** Standard error of that bias. */
  standardError: number;
  /** z-score of the bias; |z| ≥ 2 means the model is measurably miscalibrated. */
  biasZ: number;
  /** Root mean squared error of the forecasts. */
  rmse: number;
  /** Empirical coverage of the nominal 95% intervals, when intervals are given. */
  coverage: number | null;
};

/**
 * Out-of-sample audit of a probability stream: how far the numbers on the
 * screen were from the frequencies that actually happened, and whether that gap
 * is larger than chance. This is the definition of accuracy used by every
 * simulation test in `tests/signal-calibration.test.mjs`.
 */
export function accuracyAudit(forecasts: readonly number[], outcomes: readonly (0 | 1)[]): AccuracyAudit {
  const sample = Math.min(forecasts.length, outcomes.length);
  const usableForecasts: number[] = [];
  const usableOutcomes: number[] = [];
  for (let index = 0; index < sample; index += 1) {
    if (!Number.isFinite(forecasts[index])) continue;
    usableForecasts.push(forecasts[index]);
    usableOutcomes.push(outcomes[index]);
  }
  const n = usableForecasts.length;
  const empty: AccuracyAudit = {
    sample: n, forecasts: usableForecasts, outcomes: usableOutcomes, meanForecast: 0,
    observedRate: 0, bias: 0, standardError: 0, biasZ: 0, rmse: 0, coverage: null,
  };
  if (!n) return empty;
  const meanForecast = usableForecasts.reduce((total, value) => total + value, 0) / n;
  const observedRate = usableOutcomes.reduce((total, value) => total + value, 0) / n;
  let squared = 0;
  for (let index = 0; index < n; index += 1) squared += (usableForecasts[index] - usableOutcomes[index]) ** 2;
  const standardError = rateStandardError(observedRate, n, lagOneAutocorrelation(usableForecasts));
  return {
    sample: n,
    forecasts: usableForecasts,
    outcomes: usableOutcomes,
    meanForecast,
    observedRate,
    bias: meanForecast - observedRate,
    standardError,
    biasZ: standardError > 1e-9 ? (meanForecast - observedRate) / standardError : 0,
    rmse: Math.sqrt(squared / n),
    coverage: null,
  };
}
