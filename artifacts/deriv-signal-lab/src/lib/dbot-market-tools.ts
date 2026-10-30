import type { FeedTick } from './market-feed.ts';

/** Descriptive counts only: no signals, recommendations or order placement. */
export function summarizeDigits(ticks: readonly FeedTick[], windowSize: number) {
  const size = Number.isFinite(windowSize) ? Math.max(1, Math.min(2000, Math.floor(windowSize))) : 100;
  const window = ticks.slice(-size);
  const counts = Array<number>(10).fill(0);
  for (const tick of window) {
    if (typeof tick.digit === 'number' && Number.isInteger(tick.digit) && tick.digit >= 0 && tick.digit <= 9) counts[tick.digit]++;
  }
  const sample = counts.reduce((sum, count) => sum + count, 0);
  const even = counts.reduce((sum, count, digit) => sum + (digit % 2 === 0 ? count : 0), 0);
  return { counts, sample, considered: window.length, even, odd: sample - even, lastDigit: window.at(-1)?.digit ?? null };
}

export type RiskScenario = { balance: number; stake: number; multiplier: number; losses: number; payout: number };

/** Illustrative full-loss ladder, not broker quotes or an enforced risk limit. */
export function calculateRiskScenario(input: RiskScenario) {
  const { balance, stake, multiplier, losses, payout } = input;
  if (![balance, stake, multiplier, losses, payout].every(Number.isFinite)
      || balance <= 0 || balance > 1e12 || stake <= 0 || stake > 1e9
      || multiplier < 1 || multiplier > 10 || !Number.isInteger(losses) || losses < 1 || losses > 12
      || payout <= 0 || payout > 1e12) return null;
  const ladder: Array<{ number: number; stake: number; cumulative: number; affordable: boolean }> = [];
  let cumulative = 0;
  let nextStake = stake;
  for (let i = 0; i < losses; i++) {
    cumulative += nextStake;
    ladder.push({ number: i + 1, stake: nextStake, cumulative, affordable: cumulative <= balance });
    nextStake *= multiplier;
  }
  return {
    ladder,
    totalLoss: cumulative,
    percentBalance: cumulative / balance * 100,
    breakEvenPercent: stake / payout * 100,
    payoutBelowStake: payout < stake,
  };
}
