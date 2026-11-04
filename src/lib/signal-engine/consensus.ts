/**
 * Hierarchical ensemble weights shared by the live signal engines.
 *
 * Technical indicators from the same family are often strongly correlated
 * (for example, several moving-average signals). Weighting every indicator as
 * an independent vote lets a large family dominate by headcount. This helper
 * first allocates weight across available engine families, then distributes a
 * family's share among its available engines according to measured
 * reliability. A family can never receive more than `maxFamilyShare` when
 * enough independent families are present.
 */
export type EngineReliability = {
  family: string;
  reliability: number;
  available?: boolean;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function cappedFamilyShares(scores: readonly { family: string; score: number }[], maxFamilyShare: number): Map<string, number> {
  const shares = new Map<string, number>();
  if (!scores.length) return shares;

  const requestedCap = Number.isFinite(maxFamilyShare) ? clamp(maxFamilyShare, 0, 1) : 0.4;
  const cap = Math.max(1 / scores.length, requestedCap);
  let remaining = [...scores];
  let budget = 1;
  while (remaining.length && budget > 1e-12) {
    const total = remaining.reduce((sum, row) => sum + row.score, 0);
    if (!(total > 0)) {
      const equal = budget / remaining.length;
      for (const row of remaining) shares.set(row.family, equal);
      break;
    }
    const capped = remaining.filter((row) => budget * row.score / total > cap + 1e-12);
    if (!capped.length) {
      for (const row of remaining) shares.set(row.family, budget * row.score / total);
      break;
    }
    for (const row of capped) {
      shares.set(row.family, cap);
      budget -= cap;
    }
    const cappedFamilies = new Set(capped.map((row) => row.family));
    remaining = remaining.filter((row) => !cappedFamilies.has(row.family));
  }
  return shares;
}

/**
 * Return one normalized weight per input item (in original order). Unavailable
 * items receive zero. Reliability is evidence for how much to trust an engine,
 * not a confidence score; non-finite or non-positive values are ignored.
 */
export function familyBalancedWeights(
  engines: readonly EngineReliability[],
  maxFamilyShare = 0.4,
): number[] {
  const output = Array<number>(engines.length).fill(0);
  const activeByFamily = new Map<string, number[]>();
  engines.forEach((engine, index) => {
    const family = engine.family.trim() || `engine-${index}`;
    if (engine.available === false || !Number.isFinite(engine.reliability) || engine.reliability <= 0) return;
    const indices = activeByFamily.get(family) ?? [];
    indices.push(index);
    activeByFamily.set(family, indices);
  });
  if (!activeByFamily.size) return output;

  const familyScores = [...activeByFamily.entries()].map(([family, indices]) => ({
    family,
    score: indices.reduce((sum, index) => sum + engines[index].reliability, 0) / indices.length,
  }));
  const shares = cappedFamilyShares(familyScores, maxFamilyShare);
  for (const [family, indices] of activeByFamily) {
    const total = indices.reduce((sum, index) => sum + engines[index].reliability, 0);
    const familyShare = shares.get(family) ?? 0;
    for (const index of indices) output[index] = familyShare * engines[index].reliability / total;
  }

  // Avoid small floating-point drift in callers that use the weights for
  // probabilities and engine-vote accounting.
  const total = output.reduce((sum, weight) => sum + weight, 0);
  if (total > 0 && Math.abs(total - 1) > 1e-12) {
    for (let index = 0; index < output.length; index += 1) output[index] /= total;
  }
  return output;
}
