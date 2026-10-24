// PAIR ECONOMICS — what two live High/Low Tick proposals are worth together.
//
// Each leg is priced with the same per-leg arithmetic the Rise/Fall bot uses:
// expected value = historical win rate × payout − ask price. A pair's expected
// value is the sum of its legs, and its outcome table shows what each possible
// settlement pattern pays. Both legs are bought at once, so a pair always costs
// the sum of the two asks; it can return at most one payout per winning leg.
import { evaluateProposalEconomics, validateRiseFallQuote, normalizeMoney, type QuoteCheck } from '../rise-fall-bot/evidence.ts';
import type { ProposalEconomics } from '../rise-fall-bot/types.ts';
import type { JointOutcomes } from './selection.ts';

export type LegProposal = {
  askPrice: number;
  payout: number | null;
  spot: number | null;
  spotTime: number | null;
};

/** Refuses a proposal whose price, payout or spot age does not describe the order the bot sized. */
export function validateLegProposal(input: {
  proposal: LegProposal;
  stake: number;
  now: number;
  maxAgeMs: number;
  serverClockOffsetMs?: number | null;
}): QuoteCheck {
  return validateRiseFallQuote({
    askPrice: input.proposal.askPrice,
    payout: input.proposal.payout,
    stake: input.stake,
    spot: input.proposal.spot,
    spotTime: input.proposal.spotTime,
    now: input.now,
    maxAgeMs: input.maxAgeMs,
    serverClockOffsetMs: input.serverClockOffsetMs,
  });
}

export type PairScenarios = {
  /** Net profit when both legs win; null when a payout is unknown. */
  bothWin: number | null;
  /** Net profit when only the High leg wins. */
  onlyHigh: number | null;
  /** Net profit when only the Low leg wins. */
  onlyLow: number | null;
  /** Net profit when neither leg wins: the full cost is lost. */
  neither: number;
};

export type PairEconomics = {
  totalAsk: number;
  high: ProposalEconomics | null;
  low: ProposalEconomics | null;
  /** Expected value of the pair in account currency, or null while a leg is unpriced. */
  expectedValue: number | null;
  /** Expected value per unit of total cost, or null when the pair is unpriced. */
  returnOnStake: number | null;
  scenarios: PairScenarios;
  note: string;
};

/**
 * Prices a pair from its two live proposals and their historical win rates.
 * A leg without a payout or without a rate is reported as unpriced; the pair
 * is never assumed profitable on the strength of the other leg.
 */
export function evaluatePairEconomics(input: {
  high: { askPrice: number; payout: number | null; winRate: number | null };
  low: { askPrice: number; payout: number | null; winRate: number | null };
  joint: JointOutcomes | null;
}): PairEconomics {
  const { high, low } = input;
  const totalAsk = normalizeMoney(high.askPrice + low.askPrice);
  const highEconomics = evaluateProposalEconomics({
    askPrice: high.askPrice,
    payout: high.payout,
    stake: high.askPrice,
    winRate: high.winRate,
  });
  const lowEconomics = evaluateProposalEconomics({
    askPrice: low.askPrice,
    payout: low.payout,
    stake: low.askPrice,
    winRate: low.winRate,
  });

  const payoutHigh = high.payout;
  const payoutLow = low.payout;
  const scenarios: PairScenarios = {
    bothWin: payoutHigh !== null && payoutLow !== null ? normalizeMoney(payoutHigh + payoutLow - totalAsk) : null,
    onlyHigh: payoutHigh !== null ? normalizeMoney(payoutHigh - totalAsk) : null,
    onlyLow: payoutLow !== null ? normalizeMoney(payoutLow - totalAsk) : null,
    neither: normalizeMoney(-totalAsk),
  };

  if (!highEconomics || !lowEconomics) {
    return {
      totalAsk,
      high: highEconomics,
      low: lowEconomics,
      expectedValue: null,
      returnOnStake: null,
      scenarios,
      note: unpricedNote(high, low),
    };
  }
  const expectedValue = normalizeMoney(highEconomics.expectedValue + lowEconomics.expectedValue);
  return {
    totalAsk,
    high: highEconomics,
    low: lowEconomics,
    expectedValue,
    returnOnStake: totalAsk > 0 ? normalizeMoney(expectedValue / totalAsk) : null,
    scenarios,
    note: `Pair expected value ${expectedValue.toFixed(4)} on a total cost of ${totalAsk.toFixed(2)}.`,
  };
}

type PricedLeg = { askPrice: number; payout: number | null; winRate: number | null };

function unpricedNote(high: PricedLeg, low: PricedLeg): string {
  const reasons: string[] = [];
  for (const [name, leg] of [['High Tick', high], ['Low Tick', low]] as const) {
    if (leg.payout === null) reasons.push(`${name} has no payout`);
    else if (leg.winRate === null) reasons.push(`${name} has no historical rate`);
    else if (leg.payout <= leg.askPrice) reasons.push(`${name} payout does not exceed its ask`);
  }
  return reasons.length ? `Pair unpriced: ${reasons.join('; ')}.` : 'Pair unpriced.';
}
