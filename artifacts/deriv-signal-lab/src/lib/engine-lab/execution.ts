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

/**
 * Plain-language advice, not a gate.
 *
 * The research gates used to block automatic execution ("observation only"),
 * which left a finished analysis with a Load and Run button that could not be
 * pressed. The ranked signal is what the user asked for and the bot now trades
 * it, so this text only travels with the run as information the user can act
 * on: it never disables a button and never blocks a purchase.
 */
export function researchAdvisory(decision?: ResearchDecision | null): string | null {
  if (!decision) return 'No research audit is attached to this signal; the bot trades the analysis estimate as it stands.';
  if (!decision.eligible || decision.action !== 'candidate') {
    const reasons = decision.reasons.filter((reason) => !reason.startsWith('Evidence gates passed'));
    return `Analysis, prediction and entry advice: ${reasons.join(' ') || 'the evidence gates did not pass for this contract.'}`;
  }
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
