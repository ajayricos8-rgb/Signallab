// Cross-market ranking, kept free of engine code so the UI bundle stays small.
import type { DigitMarketAnalysis } from './digit-signal.ts';
import type { RiseFallMarketAnalysis } from './rise-fall-signal.ts';

type Rankable = Pick<DigitMarketAnalysis, 'kind' | 'symbol' | 'best'> | Pick<RiseFallMarketAnalysis, 'kind' | 'symbol' | 'best'>;

/**
 * Layer 6 decides the ranking, then the older evidence score breaks ties.
 *
 * The master's priority already folds the verdict (decisive / on-trigger /
 * speculative / no edge), the conviction, the edge z-score and whether the
 * planned entry earned its wait. A signal the master certified as tradeable
 * therefore outranks a market that only has a high confidence score. The
 * optional chain keeps a stale, pre-Layer-6 result in the in-memory cache from
 * crashing the scan; such a result sinks to the bottom until it is re-analysed.
 */
export function rankScanResults<T extends Rankable>(results: readonly T[]): T[] {
  const edgeOf = (result: Rankable) => (result.kind === 'digit' ? result.best.edgeRatio : Math.abs(result.best.consensusScore));
  const masterOf = (result: Rankable) => result.best.master?.priority ?? -100;
  return [...results].sort((a, b) =>
    masterOf(b) - masterOf(a)
    || b.best.confidence - a.best.confidence
    || b.best.tally.weightedAgreement - a.best.tally.weightedAgreement
    || edgeOf(b) - edgeOf(a)
    || a.symbol.localeCompare(b.symbol));
}
