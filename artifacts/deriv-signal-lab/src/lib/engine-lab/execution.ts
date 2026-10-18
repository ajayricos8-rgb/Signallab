// Pure execution checks. This module does not quote, authenticate, buy or change stake.
import type { DerivClosedPosition } from '../deriv-trading.ts';
import type { ResearchDecision, SettledReturn, ToolFamily } from './types.ts';

const CONTRACTS: Record<ToolFamily, readonly string[]> = {
  'rise-fall': ['CALL', 'PUT'],
  'over-under': ['DIGITOVER', 'DIGITUNDER'],
  'even-odd': ['DIGITEVEN', 'DIGITODD'],
  matches: ['DIGITMATCH'],
};

/** Input must be the current account's loaded closed positions, never another account's cache. */
export function scopeSettlements(positions: readonly DerivClosedPosition[], symbol: string, family: ToolFamily, currency: string): SettledReturn[] {
  if (!currency || !symbol) return [];
  const unique = new Map<number, SettledReturn>();
  for (const trade of positions) {
    if (!Number.isSafeInteger(trade.contractId) || trade.contractId <= 0) continue;
    if (trade.symbol !== symbol || trade.currency !== currency || !CONTRACTS[family].includes(trade.contractType ?? '')) continue;
    if (trade.buyPrice === null || !Number.isFinite(trade.buyPrice) || trade.buyPrice <= 0 || !Number.isFinite(trade.profit) || trade.sellTime === null || !Number.isFinite(trade.sellTime) || trade.sellTime <= 0) continue;
    unique.set(trade.contractId, { epoch: trade.sellTime, stake: trade.buyPrice, profit: trade.profit });
  }
  return [...unique.values()].sort((a, b) => a.epoch - b.epoch);
}

/** Missing/old reports fail closed for the bot, without hiding the ranked analysis candidate. */
export function researchExecutionIssue(decision?: ResearchDecision | null): string | null {
  if (!decision) return 'This signal has no research execution audit. Run Analysis again before automatic trading.';
  if (!decision.eligible || decision.action !== 'candidate') return `Observation-only signal. ${decision.reasons.join(' ')}`;
  return null;
}

/** Total payout includes returned stake: break-even = actual ask / total payout. */
export function quoteEconomics(probability: number | null | undefined, ask: number, payout: number | null) {
  if (probability == null || !Number.isFinite(probability) || probability < 0 || probability > 1 || !Number.isFinite(ask) || ask <= 0 || payout === null || !Number.isFinite(payout) || payout <= 0) {
    return { allowed: false, breakEven: null, expectedNet: null, reason: 'A finite signal probability, positive ask and actual total payout are required before automatic purchase.' };
  }
  const breakEven = ask / payout;
  const expectedNet = probability * payout - ask;
  // Small explicit margin above quoted break-even; this is still only estimated economics.
  const allowed = expectedNet > 0 && probability >= breakEven + 0.005;
  return { allowed, breakEven, expectedNet, reason: allowed
    ? 'Estimated quote economics clear break-even by at least 0.5 probability points; outcomes remain uncertain.'
    : `Quote rejected: estimated win probability ${(100 * probability).toFixed(2)}% does not clear the ${(100 * breakEven).toFixed(2)}% break-even rate plus the 0.5-point safety margin.` };
}
