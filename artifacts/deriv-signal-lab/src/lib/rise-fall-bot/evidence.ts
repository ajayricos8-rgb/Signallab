// EVIDENCE ENGINE — what the same rule did on the ticks already collected, and
// what Deriv's live proposal makes of it.
//
// Two separate questions are answered here:
//   1. `evaluateSignalEvidence` replays the decision rule over the verified
//      ticks the feed already delivered and counts how often the direction it
//      would have named was right `horizonTicks` later. It is an in-sample
//      historical count, not a calibrated forecast.
//   2. `evaluateProposalEconomics` turns one real Deriv proposal (ask price and
//      payout) plus that historical rate into break-even and expected value.
//
// Nothing is invented when data is missing: an unavailable horizon, an empty
// sample or a proposal without a payout all come back as null with a note.
import { ruleFiresAtIndex } from './decision.ts';
import type { ProposalEconomics, RiseFallConfig, RiseFallDirection, SignalEvidence } from './types.ts';

/** Bounds the replay so a decision cycle stays fast on a 2,000-tick buffer. */
export const EVIDENCE_MAX_QUOTES = 1_200;

/** Removes binary floating-point noise from money this module derives. */
export function normalizeMoney(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function emptyEvidence(direction: RiseFallDirection, horizonTicks: number | null, note: string): SignalEvidence {
  return {
    direction,
    horizonTicks,
    occurrences: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    winRate: null,
    pushRate: null,
    baselineWinRate: null,
    sufficient: false,
    note,
  };
}

/**
 * Replays the configured rule across the collected ticks.
 *
 * A "push" is an expiry level exactly equal to the entry level: Deriv returns
 * the stake, so it is counted separately instead of being folded into a win or
 * a loss. `horizonTicks` is null for second- or minute-based expiries, because
 * tick history cannot price a wall-clock horizon honestly.
 */
export function evaluateSignalEvidence(input: {
  quotes: readonly number[];
  config: RiseFallConfig;
  direction: RiseFallDirection;
  pipSize: number | null;
  horizonTicks: number | null;
}): SignalEvidence {
  const { quotes, config, direction, pipSize, horizonTicks } = input;
  if (horizonTicks === null || !Number.isFinite(horizonTicks) || horizonTicks < 1) {
    return emptyEvidence(direction, horizonTicks, 'Historical evidence needs a tick-based expiry; seconds and minutes cannot be replayed on tick history.');
  }
  const horizon = Math.floor(horizonTicks);
  const total = quotes.length;
  const firstIndex = Math.max(config.tickWindow - 1, total - EVIDENCE_MAX_QUOTES);
  const lastIndex = total - 1 - horizon;
  if (lastIndex <= firstIndex) {
    return emptyEvidence(direction, horizon, `Not enough tick history yet: replaying ${horizon} ticks ahead needs more than ${config.tickWindow + horizon} verified ticks.`);
  }

  let occurrences = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let baselineDecisive = 0;
  let baselineWins = 0;

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const entry = quotes[index];
    const exit = quotes[index + horizon];
    if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
    const rose = exit > entry;
    const fell = exit < entry;
    if (rose || fell) {
      baselineDecisive += 1;
      if ((direction === 'CALL' && rose) || (direction === 'PUT' && fell)) baselineWins += 1;
    }
    if (ruleFiresAtIndex(quotes, index, config, pipSize) !== direction) continue;
    occurrences += 1;
    if (rose === fell) pushes += 1;
    else if ((direction === 'CALL' && rose) || (direction === 'PUT' && fell)) wins += 1;
    else losses += 1;
  }

  const decisive = wins + losses;
  return {
    direction,
    horizonTicks: horizon,
    occurrences,
    wins,
    losses,
    pushes,
    winRate: decisive > 0 ? wins / decisive : null,
    pushRate: occurrences > 0 ? pushes / occurrences : null,
    baselineWinRate: baselineDecisive > 0 ? baselineWins / baselineDecisive : null,
    sufficient: occurrences >= config.minEvidenceSample,
    note: occurrences === 0
      ? `The rule never fired in the last ${lastIndex - firstIndex + 1} ticks at this ${horizon}-tick horizon.`
      : `${occurrences} historical firing(s) of the same rule at a ${horizon}-tick horizon on the ticks already collected; in-sample count, not a calibrated forecast.`,
  };
}

/**
 * Economics of one order against Deriv's own proposal.
 *
 *   break-even = ask / payout
 *   EV         = q·(payout − ask) + push·0 − (1 − q − push)·ask
 *
 * `winRate` is the historical rate of the decisive outcomes and `pushRate` the
 * share of expiries that returned the stake, so the two must not exceed 1.
 */
export function evaluateProposalEconomics(input: {
  askPrice: number;
  payout: number | null;
  stake: number;
  winRate: number | null;
  pushRate?: number | null;
}): ProposalEconomics | null {
  const { askPrice, payout, stake, winRate } = input;
  if (!Number.isFinite(askPrice) || askPrice <= 0) return null;
  if (payout === null || !Number.isFinite(payout) || payout <= askPrice) return null;
  if (winRate === null || !Number.isFinite(winRate)) return null;
  const pushRate = clamp(Number.isFinite(input.pushRate ?? NaN) ? (input.pushRate as number) : 0, 0, 1);
  const q = clamp(winRate, 0, 1);
  const lossRate = clamp(1 - q - pushRate, 0, 1);
  const breakEvenProbability = clamp(askPrice / payout, 0, 1);
  const expectedValue = normalizeMoney(q * (payout - askPrice) - lossRate * askPrice);
  return {
    askPrice: normalizeMoney(askPrice),
    payout: normalizeMoney(payout),
    breakEvenProbability,
    expectedValue,
    edge: q - breakEvenProbability,
    returnOnStake: Number.isFinite(stake) && stake > 0 ? normalizeMoney(expectedValue / stake) : null,
  };
}

export type QuoteCheck = { ok: boolean; issues: string[] };

/**
 * Pre-purchase check of a live proposal.
 *
 * The bot buys on a `stake` basis, so Deriv's ask price must match the stake
 * the operator configured within a small tolerance; anything else means the
 * quote is not the order the risk engine sized, and the purchase is refused
 * rather than adjusted silently.
 */
export function validateRiseFallQuote(input: {
  askPrice: number;
  payout: number | null;
  stake: number;
  spot: number | null;
  spotTime: number | null;
  now: number;
  maxAgeMs: number;
  serverClockOffsetMs?: number | null;
}): QuoteCheck {
  const issues: string[] = [];
  const { askPrice, payout, stake, spot, spotTime, now, maxAgeMs } = input;
  const offset = Number.isFinite(input.serverClockOffsetMs ?? NaN) ? (input.serverClockOffsetMs as number) : 0;

  if (!Number.isFinite(askPrice) || askPrice <= 0) issues.push('Deriv returned no usable ask price.');
  else if (!Number.isFinite(stake) || stake <= 0) issues.push('The stake is not a positive amount.');
  else if (askPrice > stake * 1.02) issues.push(`Deriv's ask price ${askPrice.toFixed(2)} exceeds the configured stake ${stake.toFixed(2)}; the order was not sent.`);
  else if (askPrice < stake * 0.5) issues.push(`Deriv's ask price ${askPrice.toFixed(2)} is far below the configured stake ${stake.toFixed(2)}; the quote does not describe this order.`);

  if (payout === null || !Number.isFinite(payout)) issues.push('Deriv returned no payout, so the contract cannot be priced.');
  else if (payout <= askPrice) issues.push('The payout does not exceed the ask price, so the contract can never be profitable.');

  if (spot === null || !Number.isFinite(spot) || spot <= 0) issues.push('The proposal carries no entry spot.');
  if (spotTime === null || !Number.isFinite(spotTime) || spotTime <= 0) {
    issues.push('The proposal carries no spot time, so its age cannot be verified.');
  } else {
    const ageMs = Math.abs(now + offset - spotTime * 1_000);
    if (ageMs > maxAgeMs) issues.push(`The proposal's spot is ${Math.round(ageMs / 1_000)}s old, older than the ${Math.round(maxAgeMs / 1_000)}s limit.`);
  }

  return { ok: issues.length === 0, issues };
}
