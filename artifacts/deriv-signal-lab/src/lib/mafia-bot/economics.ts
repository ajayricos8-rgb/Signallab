// Money management, stake sizing and the pair's economics.
//
// A Mafia pair buys two four-tick Rise/Fall contracts on the same market at the
// same moment, one CALL and one PUT. Exactly one of them wins, unless the price
// ends the window where it started, in which case both lose. So a pair has
// three outcomes:
//
//   primary wins → primaryPayout − (primaryCost + coverCost)
//   cover wins   → coverPayout   − (primaryCost + coverCost)
//   flat         → −(primaryCost + coverCost)
//
// With equal stakes and Deriv's ~1.9× payout both winning branches are about
// −0.05 of the pair's cost, i.e. the pair is a GUARANTEED small loss. Sizing the
// cover below the primary is what makes one branch pay for both; that in turn
// raises the probability the primary direction must hit. Both numbers are
// computed here from the live quotes, and the gate compares the measured
// probability against the break-even this file derives — never against a
// constant.
import type { MafiaBotConfig } from './types.ts';
import { roundMoney } from './types.ts';

export type MafiaSizing = {
  primaryStake: number;
  coverStake: number;
  totalStake: number;
  /** Null when nothing was capped away. */
  cappedBy: string | null;
  blocked: boolean;
  reasons: string[];
  reasonCodes: string[];
};

/**
 * Applies the money-management settings to the next pair.
 *
 * Order matters: the stake mode produces a base, `maxStake` clamps it, the
 * balance-share cap scales the whole pair down, and the cover is derived from
 * the final primary so the hedge ratio the operator set is the one that gets
 * bought. A pair that cannot afford both legs above Deriv's minimum is blocked
 * rather than quietly bought one-legged.
 */
export function sizeMafiaPair(
  config: MafiaBotConfig,
  input: { balance: number | null; consecutiveLosingPairs: number },
): MafiaSizing {
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  let cappedBy: string | null = null;

  const losses = Math.max(0, Math.trunc(input.consecutiveLosingPairs));
  let raw: number;
  if (config.stakeMode === 'fixed-fraction') {
    if (input.balance === null || input.balance <= 0) {
      return {
        primaryStake: 0,
        coverStake: 0,
        totalStake: 0,
        cappedBy: null,
        blocked: true,
        reasons: ['Fixed-fraction sizing needs the live balance, which is not available yet.'],
        reasonCodes: ['BALANCE_UNKNOWN'],
      };
    }
    raw = (input.balance * config.fixedFractionPercent) / 100;
    reasons.push(`Fixed fraction: ${config.fixedFractionPercent}% of ${input.balance.toFixed(2)} = ${raw.toFixed(2)}.`);
    reasonCodes.push('SIZED_FIXED_FRACTION');
  } else if (config.stakeMode === 'martingale') {
    const steps = Math.min(losses, config.maxMartingaleSteps);
    raw = config.primaryStake * config.martingaleFactor ** steps;
    reasons.push(steps > 0
      ? `Martingale: ${config.primaryStake.toFixed(2)} × ${config.martingaleFactor} ^ ${steps} (${losses} losing pair${losses === 1 ? '' : 's'}, capped at ${config.maxMartingaleSteps} steps).`
      : `Martingale at its base stake — no losing pair is standing in the way.`);
    reasonCodes.push(steps > 0 ? 'SIZED_MARTINGALE_STEP' : 'SIZED_BASE');
  } else {
    raw = config.primaryStake;
    reasons.push(`Flat stake: ${config.primaryStake.toFixed(2)} per primary leg.`);
    reasonCodes.push('SIZED_BASE');
  }

  let primary = Math.min(raw, config.maxStake);
  if (primary < raw) {
    cappedBy = 'maxStake';
    reasons.push(`Primary leg capped at the maximum stake ${config.maxStake.toFixed(2)}.`);
    reasonCodes.push('CAPPED_MAX_STAKE');
  }

  const share = () => (input.balance === null ? null : (input.balance * config.maxStakeShareOfBalance) / 100);
  const balanceCap = share();
  const ratio = config.hedgeRatioPercent / 100;
  const uncoveredTotal = (stake: number) => stake + stake * ratio;
  const floorMoney = (value: number) => Math.floor(value * 100) / 100;

  if (balanceCap !== null && uncoveredTotal(primary) > balanceCap && balanceCap > 0) {
    // Both legs are floored to cents, never rounded up, so the pair can never
    // risk more than the share cap it was sized against.
    primary = floorMoney(balanceCap / (1 + ratio));
    cappedBy = 'balanceShare';
    reasons.push(`Pair scaled to ${config.maxStakeShareOfBalance}% of the ${input.balance?.toFixed(2)} balance, so one pair risks at most ${balanceCap.toFixed(2)}.`);
    reasonCodes.push('CAPPED_BALANCE_SHARE');
  } else {
    primary = roundMoney(primary);
  }

  let cover = roundMoney(primary * ratio);

  if (primary < config.minStake) {
    return {
      primaryStake: 0,
      coverStake: 0,
      totalStake: 0,
      cappedBy,
      blocked: true,
      reasons: [...reasons, `The primary leg would be ${primary.toFixed(2)}, below Deriv's minimum ${config.minStake.toFixed(2)}.`],
      reasonCodes: [...reasonCodes, 'PRIMARY_BELOW_MIN_STAKE'],
    };
  }
  if (cover < config.minStake) {
    return {
      primaryStake: primary,
      coverStake: cover,
      totalStake: roundMoney(primary + cover),
      cappedBy,
      blocked: true,
      reasons: [...reasons, `The ${config.hedgeRatioPercent}% cover leg would be ${cover.toFixed(2)}, below Deriv's minimum ${config.minStake.toFixed(2)}. Raise the stake or the hedge ratio.`],
      reasonCodes: [...reasonCodes, 'COVER_BELOW_MIN_STAKE'],
    };
  }

  const totalStake = roundMoney(primary + cover);
  if (input.balance !== null && totalStake > input.balance) {
    return {
      primaryStake: primary,
      coverStake: cover,
      totalStake,
      cappedBy,
      blocked: true,
      reasons: [...reasons, `Both legs cost ${totalStake.toFixed(2)} and the balance is ${input.balance.toFixed(2)}.`],
      reasonCodes: [...reasonCodes, 'INSUFFICIENT_BALANCE'],
    };
  }

  return { primaryStake: primary, coverStake: cover, totalStake, cappedBy, blocked: false, reasons, reasonCodes };
}

/**
 * The probability a measured estimate needs before it can be believed.
 *
 * An in-sample replay win rate is optimistic by roughly one standard error.
 * Subtracting `z` standard errors before comparing with the break-even is the
 * difference between "this looked good in the replay" and "this is likely to
 * survive the next pair".
 */
export function evidenceProbability(probability: number | null, samples: number, z: number): number | null {
  if (probability === null || !Number.isFinite(probability) || samples <= 0) return null;
  const clamped = Math.min(1, Math.max(0, probability));
  const standardError = Math.sqrt((clamped * (1 - clamped)) / samples);
  return Math.min(1, Math.max(0, clamped - Math.max(0, z) * standardError));
}

export type MafiaPairQuotes = {
  primaryAsk: number | null;
  coverAsk: number | null;
  primaryPayout: number | null;
  coverPayout: number | null;
};

export type MafiaPairEconomics = {
  primaryStake: number;
  coverStake: number;
  /** What the two legs actually cost (ask prices when known). */
  totalCost: number;
  primaryWinProfit: number | null;
  coverWinProfit: number | null;
  flatLoss: number;
  /** Probability the primary direction wins, as measured. */
  probability: number | null;
  /** Probability the window settles exactly level. */
  flatProbability: number;
  expectedValue: number | null;
  expectedValuePerStake: number | null;
  /** Primary-direction probability at which the pair's expected value is zero. */
  breakEvenProbability: number | null;
  /** True when even the winning branch loses money — an equal-stake pair, typically. */
  paysLessThanCost: boolean;
  reasons: string[];
  reasonCodes: string[];
};

/**
 * Prices the pair from the quotes that will actually be bought.
 *
 * `totalCost` uses each leg's ask price when Deriv reports one, because that is
 * the money that leaves the account. Payouts are total returns, so a leg's win
 * profit is `payout − cost`.
 */
export function evaluatePairEconomics(
  input: MafiaPairQuotes & {
    primaryStake: number;
    coverStake: number;
    probability: number | null;
    flatProbability?: number | null;
  },
): MafiaPairEconomics {
  const primaryCost = input.primaryAsk !== null && input.primaryAsk > 0 ? input.primaryAsk : input.primaryStake;
  const coverCost = input.coverAsk !== null && input.coverAsk > 0 ? input.coverAsk : input.coverStake;
  const totalCost = roundMoney(primaryCost + coverCost);
  const reasons: string[] = [];
  const reasonCodes: string[] = [];

  const primaryWinProfit = input.primaryPayout === null ? null : roundMoney(input.primaryPayout - totalCost);
  const coverWinProfit = input.coverPayout === null ? null : roundMoney(input.coverPayout - totalCost);
  const flat = Math.min(1, Math.max(0, input.flatProbability ?? 0));
  const probability = input.probability === null ? null : Math.min(1, Math.max(0, input.probability));

  const paysLessThanCost = primaryWinProfit !== null && coverWinProfit !== null
    && primaryWinProfit <= 0 && coverWinProfit <= 0;
  if (paysLessThanCost) {
    reasonCodes.push('PAIR_ALWAYS_LOSES');
    reasons.push(`Neither leg covers the pair cost of ${totalCost.toFixed(2)} when it wins — this hedge size cannot be profitable at these payouts.`);
  }

  let breakEvenProbability: number | null = null;
  if (primaryWinProfit !== null && coverWinProfit !== null) {
    // EV = p·A + (1 − f − p)·B − f·C  with A/B the two win profits and C the cost.
    const a = primaryWinProfit;
    const b = coverWinProfit;
    const denominator = a - b;
    if (Math.abs(denominator) < 1e-9) {
      reasonCodes.push('BREAK_EVEN_UNDEFINED');
      reasons.push('Both legs pay the same, so no probability makes this pair break even — only the flat risk is left.');
    } else {
      breakEvenProbability = Math.min(1, Math.max(0, (flat * totalCost - (1 - flat) * b) / denominator));
    }
  }

  let expectedValue: number | null = null;
  if (probability !== null && primaryWinProfit !== null && coverWinProfit !== null) {
    expectedValue = roundMoney(
      probability * primaryWinProfit + (1 - flat - probability) * coverWinProfit - flat * totalCost,
    );
    reasons.push(`Expected value ${expectedValue >= 0 ? '+' : ''}${expectedValue.toFixed(2)} per pair at a measured ${(probability * 100).toFixed(1)}% primary win rate.`);
    reasonCodes.push(expectedValue >= 0 ? 'EV_POSITIVE' : 'EV_NEGATIVE');
    if (breakEvenProbability !== null) {
      reasons.push(`Break-even primary win rate is ${(breakEvenProbability * 100).toFixed(1)}%; the cover leg is what sets it.`);
    }
  }

  return {
    primaryStake: input.primaryStake,
    coverStake: input.coverStake,
    totalCost,
    primaryWinProfit,
    coverWinProfit,
    flatLoss: -totalCost,
    probability,
    flatProbability: flat,
    expectedValue,
    expectedValuePerStake: expectedValue === null || totalCost <= 0 ? null : expectedValue / totalCost,
    breakEvenProbability,
    paysLessThanCost,
    reasons,
    reasonCodes,
  };
}
