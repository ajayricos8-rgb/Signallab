// Meta-engine & multi-model decision aggregator.

export type ConfidenceInput = {
  riseFallBias?: number; // -1..1
  evenOddBias?: number; // -1..1 (positive = even)
  overUnderLift?: number; // probability lift
  matchesExtremeDrought?: number; // 0..1
};

export function confidenceScore(input: ConfidenceInput): number {
  let score = 50;
  if (input.riseFallBias !== undefined) score += input.riseFallBias * 15;
  if (input.evenOddBias !== undefined) score += input.evenOddBias * 10;
  if (input.overUnderLift !== undefined) score += input.overUnderLift * 100 * 2;
  if (input.matchesExtremeDrought !== undefined) score += input.matchesExtremeDrought * 10;
  return Math.max(0, Math.min(100, score));
}

export type DrawdownState = { consecutiveLosses: number; peakEquity: number; equity: number; volatility: number };
export function drawdownGuard(state: DrawdownState): { stakeMultiplier: number; circuitBreaker: boolean; reason: string } {
  const dd = state.peakEquity > 0 ? (state.peakEquity - state.equity) / state.peakEquity : 0;
  let mult = 1;
  if (state.consecutiveLosses >= 3) mult *= 0.5;
  if (state.consecutiveLosses >= 5) mult *= 0.5;
  if (dd > 0.1) mult *= 0.5;
  if (dd > 0.2) mult = 0;
  const cb = mult === 0;
  return { stakeMultiplier: mult, circuitBreaker: cb, reason: cb ? 'Circuit breaker: drawdown exceeded 20%.' : dd > 0.1 ? 'Reduced stake: drawdown > 10%.' : state.consecutiveLosses >= 3 ? 'Reduced stake: loss streak.' : 'Normal.' };
}

export type AssetScan = { symbol: string; edge: number; confidence: number; family: string };
export function multiAssetScanner(scans: AssetScan[]): AssetScan[] {
  return [...scans].sort((a, b) => b.edge * b.confidence - a.edge * a.confidence);
}
