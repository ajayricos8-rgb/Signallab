// Layer 2b — OPTIMAL ENSEMBLE COMBINATION.
//
// Both signal panels combine their engines with a hand-built rule: a family
// budget times a per-engine reliability factor of exp(k · measured skill).
// That rule is reasonable but not optimal, and its inputs (an accuracy or Brier
// skill measured on a few hundred rows) are noisy, so the weights themselves
// carry estimation error that shows up directly as error in the probability.
//
// This module learns the combination instead: it solves for the weights that
// minimise the squared error of the combined forecast, subject to
//   * weights summing to 1 (the combination stays a probability),
//   * weights being non-negative (no betting against an engine),
//   * a ridge penalty pulling the solution toward the equal-weight average
//     (the shrinkage is what turns a noisy optimum into a precise one).
//
// The ridge strength and the trust placed in the learned weights are both
// chosen by purged walk-forward cross-validation, and the learned combination
// is only blended in when it beats the hand-built one out of sample. So this
// layer can improve accuracy, but it can never degrade it below the existing
// panel.
import { clamp, mean, pairedImprovementZ } from './stats.ts';

/** Solve `A · x = b` in place by Gauss–Jordan elimination with partial pivoting. */
function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = column; entry <= size; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (!factor) continue;
      for (let entry = column; entry <= size; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row[size]);
}

/** Euclidean projection onto the probability simplex (Duchi et al., 2008). */
export function projectToSimplex(weights: readonly number[]): number[] {
  const size = weights.length;
  if (!size) return [];
  const sorted = [...weights].sort((left, right) => right - left);
  let cumulative = 0;
  let threshold = 0;
  for (let index = 0; index < size; index += 1) {
    cumulative += sorted[index];
    const candidate = (cumulative - 1) / (index + 1);
    if (index === size - 1 || sorted[index + 1] <= candidate) { threshold = candidate; break; }
  }
  return weights.map((weight) => Math.max(0, weight - threshold));
}

export type StackingRow = {
  /** One forecast per engine; `null` when an engine had no estimate. */
  forecasts: readonly (number | null)[];
  /** Realised outcome (0 or 1) for this row. */
  outcome: 0 | 1;
};

export type StackWeightsResult = {
  weights: number[];
  /** Ridge strength that was used. */
  lambda: number;
  /** Out-of-fold Brier of the learned combination. */
  crossValidatedBrier: number | null;
  /** Out-of-fold Brier of the equal-weight combination on the same rows. */
  baselineBrier: number | null;
  /** 1 − cvBrier / baselineBrier. */
  skill: number | null;
  sample: number;
};

/**
 * Ridge-regularised, simplex-constrained least squares.
 *
 * The equality constraint Σw = 1 has a closed form, so the fit is one small
 * linear solve ((k+1)² for k engines) instead of an iterative projection —
 * fast enough to run per contract, per market, inside a worker.
 *
 * Missing engine forecasts are imputed with that engine's own mean forecast, and
 * the ridge target is the equal-weight vector, so an engine that is mostly
 * absent is pulled back to the average rather than rewarded for noise.
 */
export function constrainedRidgeWeights(rows: readonly StackingRow[], engineCount: number, lambda: number): number[] {
  if (engineCount <= 0 || !rows.length) return Array<number>(Math.max(0, engineCount)).fill(0);
  const columnMeans = Array.from({ length: engineCount }, (_, engine) => {
    let total = 0;
    let count = 0;
    for (const row of rows) {
      const value = row.forecasts[engine];
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      total += value;
      count += 1;
    }
    return count ? total / count : 0.5;
  });
  const uniform = 1 / engineCount;
  const gram: number[][] = Array.from({ length: engineCount + 1 }, () => Array<number>(engineCount + 1).fill(0));
  const right = Array<number>(engineCount + 1).fill(0);
  for (const row of rows) {
    const features = Array.from({ length: engineCount }, (_, engine) => {
      const value = row.forecasts[engine];
      return value === null || value === undefined || !Number.isFinite(value) ? columnMeans[engine] : value;
    });
    for (let left = 0; left < engineCount; left += 1) {
      right[left] += features[left] * row.outcome;
      gram[left][engineCount] += 1;
      for (let inner = 0; inner < engineCount; inner += 1) gram[left][inner] += features[left] * features[inner];
    }
    right[engineCount] = 1;
  }
  for (let left = 0; left < engineCount; left += 1) {
    gram[left][left] += lambda;
    right[left] += lambda * uniform;
    gram[engineCount][left] = 1;
  }
  gram[engineCount][engineCount] = 0;
  const solution = solveLinearSystem(gram, right);
  const raw = solution ? solution.slice(0, engineCount) : Array<number>(engineCount).fill(uniform);
  const projected = projectToSimplex(raw.map((weight) => (Number.isFinite(weight) ? weight : uniform)));
  const total = projected.reduce((sum, weight) => sum + weight, 0);
  return total > 1e-12 ? projected.map((weight) => weight / total) : Array<number>(engineCount).fill(uniform);
}

/** Combined forecast of one row under `weights`, renormalised over the engines that answered. */
function predictRow(row: StackingRow, weights: readonly number[]): number {
  let forecast = 0;
  let weightTotal = 0;
  for (let engine = 0; engine < weights.length; engine += 1) {
    const value = row.forecasts[engine];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    forecast += weights[engine] * value;
    weightTotal += weights[engine];
  }
  return weightTotal > 1e-9 ? clamp(forecast / weightTotal, 1e-4, 1 - 1e-4) : 0.5;
}

function brierOf(rows: readonly StackingRow[], weights: readonly number[]): number {
  if (!rows.length) return 0;
  let total = 0;
  for (const row of rows) total += (predictRow(row, weights) - row.outcome) ** 2;
  return total / rows.length;
}

/**
 * Ridge strengths, expressed as a fraction of the sample size so the penalty
 * keeps the same meaning whether 200 or 2,000 rows are available (the normal
 * equations scale with n).
 */
const LAMBDA_GRID = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4];

/**
 * Fit the combination weights, choosing the ridge strength by purged
 * walk-forward cross-validation inside the supplied rows (never on the holdout
 * the signal is scored with). Returns the out-of-fold skill of the learned
 * combination against an equal-weight average on the same rows.
 */
export function fitStackWeights(
  rows: readonly StackingRow[],
  engineCount: number,
  options: { lambdas?: readonly number[]; minimum?: number } = {},
): StackWeightsResult {
  const lambdas = options.lambdas ?? LAMBDA_GRID;
  const uniform = Array<number>(engineCount).fill(1 / Math.max(1, engineCount));
  if (rows.length < (options.minimum ?? 40) || engineCount <= 0) {
    return { weights: uniform, lambda: lambdas[0], crossValidatedBrier: null, baselineBrier: null, skill: null, sample: rows.length };
  }
  // Chronological in-sample selection of lambda: rows are already ordered, and
  // purged folds keep each fit strictly before the rows it scores.
  const minimum = Math.max(30, Math.floor(rows.length * 0.3));
  const folds = 4;
  const step = Math.max(1, Math.floor((rows.length - minimum) / folds));
  // Per-fold squared errors for every candidate ridge strength (and for the
  // equal-weight baseline). Keeping the whole matrix lets the selection use a
  // paired comparison instead of two independent averages.
  const perFold = lambdas.map((lambda) => {
    const errors: number[] = [];
    const baselineErrors: number[] = [];
    for (let start = minimum; start + step <= rows.length; start += step) {
      const trainRows = rows.slice(0, start);
      const testRows = rows.slice(start, start + step);
      const weights = constrainedRidgeWeights(trainRows, engineCount, lambda * trainRows.length);
      for (const row of testRows) {
        errors.push((predictRow(row, weights) - row.outcome) ** 2);
        baselineErrors.push((predictRow(row, uniform) - row.outcome) ** 2);
      }
    }
    return { lambda, errors, baselineErrors };
  }).filter((candidate) => candidate.errors.length);

  if (!perFold.length) return { weights: uniform, lambda: lambdas[0], crossValidatedBrier: null, baselineBrier: null, skill: null, sample: rows.length };

  const scored = perFold.map((candidate) => ({
    lambda: candidate.lambda,
    brier: mean(candidate.errors),
    baseline: mean(candidate.baselineErrors),
  }));
  scored.sort((left, right) => left.brier - right.brier);
  const champion = scored[0];

  // ONE-STANDARD-ERROR RULE. The plain cross-validation minimum is a biased
  // selector: with several near-equivalent ridges it picks whichever one
  // happened to fit this sample's noise, which is the least precise choice
  // available. Taking the strongest ridge whose out-of-fold Brier is within one
  // standard error of the best keeps the simplicity (lower variance) without
  // giving up measurable accuracy — the standard parsimony rule for
  // regularisation paths.
  let selected = champion;
  const championErrors = perFold.find((candidate) => candidate.lambda === champion.lambda)!.errors;
  for (const candidate of [...perFold].sort((left, right) => right.lambda - left.lambda)) {
    const z = pairedImprovementZ(championErrors, candidate.errors);
    // Walking from the strongest ridge down, the first one that is not
    // significantly worse than the cross-validation minimum wins.
    if (z >= -1) {
      selected = { lambda: candidate.lambda, brier: mean(candidate.errors), baseline: mean(candidate.baselineErrors) };
      break;
    }
  }
  const weights = constrainedRidgeWeights(rows, engineCount, selected.lambda * rows.length);
  return {
    weights,
    lambda: selected.lambda * rows.length,
    crossValidatedBrier: selected.brier,
    baselineBrier: selected.baseline,
    skill: selected.baseline > 1e-12 ? 1 - selected.brier / selected.baseline : null,
    sample: rows.length,
  };
}

/**
 * How much of a learned combination to trust, measured against a reference
 * combination on rows neither was fitted on. `cap` bounds the trust so a single
 * lucky holdout cannot hand the whole vote to a fitted model.
 */
export function blendWeight(
  learned: readonly number[],
  reference: readonly number[],
  rows: readonly StackingRow[],
  options: { cap?: number; grid?: readonly number[] } = {},
): { alpha: number; skill: number | null; brier: number | null; baselineBrier: number | null } {
  const cap = options.cap ?? 0.6;
  const grid = options.grid ?? [0, 0.25, 0.5, 0.75, 1];
  if (!rows.length) return { alpha: 0, skill: null, brier: null, baselineBrier: null };
  const mix = (alpha: number) => learned.map((weight, index) => (1 - alpha) * (reference[index] ?? 0) + alpha * weight);
  const baseline = brierOf(rows, reference);
  let bestAlpha = 0;
  let bestBrier = baseline;
  for (const alpha of grid) {
    if (alpha > cap + 1e-9) continue;
    const score = brierOf(rows, mix(alpha));
    if (score < bestBrier - 1e-12) { bestBrier = score; bestAlpha = alpha; }
  }
  return {
    alpha: bestAlpha,
    skill: baseline > 1e-12 ? 1 - bestBrier / baseline : null,
    brier: bestBrier,
    baselineBrier: baseline,
  };
}

/** Mix two weight vectors. */
export function mixWeights(left: readonly number[], right: readonly number[], alpha: number): number[] {
  const weight = clamp(alpha, 0, 1);
  const size = Math.max(left.length, right.length);
  const output = Array.from({ length: size }, (_, index) => (1 - weight) * (left[index] ?? 0) + weight * (right[index] ?? 0));
  const total = output.reduce((sum, value) => sum + value, 0);
  return total > 1e-12 ? output.map((value) => value / total) : output.fill(1 / Math.max(1, size));
}
