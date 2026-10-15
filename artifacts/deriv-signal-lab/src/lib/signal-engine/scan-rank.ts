// Cross-market ranking, kept free of engine code so the UI bundle stays small.
import type { DigitMarketAnalysis } from './digit-signal.ts';
import type { RiseFallMarketAnalysis } from './rise-fall-signal.ts';

type Rankable = Pick<DigitMarketAnalysis, 'kind' | 'symbol' | 'best'> | Pick<RiseFallMarketAnalysis, 'kind' | 'symbol' | 'best'>;

/** Highest confidence wins; ties go to broader agreement, then larger edge. */
export function rankScanResults<T extends Rankable>(results: readonly T[]): T[] {
  const edgeOf = (result: Rankable) => (result.kind === 'digit' ? result.best.edgeRatio : Math.abs(result.best.consensusScore));
  return [...results].sort((a, b) =>
    b.best.confidence - a.best.confidence
    || b.best.tally.weightedAgreement - a.best.tally.weightedAgreement
    || edgeOf(b) - edgeOf(a)
    || a.symbol.localeCompare(b.symbol));
}
