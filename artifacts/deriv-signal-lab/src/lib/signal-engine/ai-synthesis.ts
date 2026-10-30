// Layer 5: quant measurement engines + rule-based AI synthesis.
//
// The scan already folds the predictor ensemble, the analysis engines, the
// confirmation layer and the 300-entry research library into every candidate.
// This layer adds the independent quant measurement suite (digit distribution,
// parity runs, recurrence/FFT structure, Hurst/RSI/MACD/Bollinger behaviour)
// and synthesises all of it into one verdict with a cross-window stability
// check, so every signal carries a plain-language explanation of the market
// from every angle the workspace can measure. Pure and deterministic: no
// network, no LLM, no mutation of the calibrated probabilities.
import { analyzeEvenOdd, type EvenOddMetrics } from '../quant/even-odd.ts';
import { analyzeMatches, type MatchesMetrics } from '../quant/matches.ts';
import { analyzeOverUnder, type OverUnderMetrics } from '../quant/over-under.ts';
import { analyzeRiseFall, hurstExponent, type RiseFallMetrics } from '../quant/rise-fall.ts';
import { evenOddInsight, matchesInsight, overUnderInsight, riseFallInsight, type Insight } from '../quant/ai-insights.ts';
import { availableWindows } from '../quant/core.ts';

export type DigitSynthesisFamily = 'over-under' | 'even-odd' | 'matches';

export type QuantConsensus = {
  /** Trailing windows the stability check ran on. */
  windows: number;
  /** Windows that agree with the reported direction. */
  agreeing: number;
  direction: string | null;
  detail: string;
};

export type AiSynthesis = {
  family: DigitSynthesisFamily | 'rise-fall';
  verdict: string;
  bullets: string[];
  risk: string;
  consensus: QuantConsensus;
  metrics: OverUnderMetrics | EvenOddMetrics | MatchesMetrics | RiseFallMetrics;
};

const CONSENSUS_WINDOWS = [100, 250, 500, 1_000, 2_000] as const;

function windowsFor(length: number): number[] {
  const available = new Set(availableWindows(length));
  return CONSENSUS_WINDOWS.filter((size) => available.has(size));
}

function parityConsensus(digits: readonly number[]): QuantConsensus {
  const windows = windowsFor(digits.length);
  const signs = windows.map((size) => {
    const slice = digits.slice(-size);
    let even = 0;
    for (const digit of slice) if (digit % 2 === 0) even += 1;
    const share = even / slice.length;
    return Math.abs(share - 0.5) < 0.04 ? 0 : share > 0.5 ? 1 : -1;
  });
  const direction = signs.filter((sign) => sign > 0).length >= signs.filter((sign) => sign < 0).length ? 1 : -1;
  const agreeing = signs.filter((sign) => sign === direction).length;
  const hasSignal = signs.some((sign) => sign !== 0);
  return {
    windows: signs.length,
    agreeing: hasSignal ? agreeing : 0,
    direction: hasSignal ? (direction > 0 ? 'even-biased' : 'odd-biased') : null,
    detail: hasSignal
      ? `${agreeing}/${signs.length} trailing windows agree on a ${direction > 0 ? 'even' : 'odd'} bias.`
      : `No parity bias survives across ${signs.length} trailing windows; parity looks fair.`,
  };
}

function digitConsensus(digits: readonly number[]): QuantConsensus {
  const windows = windowsFor(digits.length);
  const hot = (slice: readonly number[]) => {
    const counts = Array(10).fill(0);
    for (const digit of slice) counts[digit] += 1;
    const expected = slice.length / 10;
    const z = counts.map((count: number) => (count - expected) / Math.sqrt(slice.length * 0.09));
    return z.reduce((best: number, value: number, index: number) => (value > z[best] ? index : best), 0);
  };
  const overall = hot(digits);
  const agreeingList = windows.map((size) => {
    const slice = digits.slice(-size);
    const counts = Array(10).fill(0);
    for (const digit of slice) counts[digit] += 1;
    const expected = slice.length / 10;
    const z = (counts[overall] - expected) / Math.sqrt(slice.length * 0.09);
    return hot(slice) === overall && z >= 1.5;
  });
  const agreeing = agreeingList.filter(Boolean).length;
  const hasSignal = agreeing > 0;
  return {
    windows: agreeingList.length,
    agreeing,
    direction: hasSignal ? `digit ${overall} hot` : null,
    detail: hasSignal
      ? `Digit ${overall} runs hot in ${agreeing}/${agreeingList.length} trailing windows (z ≥ 1.5).`
      : `No digit stays hot across ${agreeingList.length} trailing windows; the distribution looks uniform.`,
  };
}

function regimeConsensus(prices: readonly number[]): QuantConsensus {
  const windows = windowsFor(prices.length);
  const classes = windows.map((size) => {
    const hurst = hurstExponent(prices.slice(-size));
    return hurst > 0.55 ? 1 : hurst < 0.45 ? -1 : 0;
  });
  const trending = classes.filter((value) => value > 0).length;
  const reverting = classes.filter((value) => value < 0).length;
  const direction = trending >= reverting ? 1 : -1;
  const agreeing = Math.max(trending, reverting);
  const hasSignal = agreeing > 0;
  return {
    windows: classes.length,
    agreeing,
    direction: hasSignal ? (direction > 0 ? 'trending' : 'mean-reverting') : null,
    detail: hasSignal
      ? `${agreeing}/${classes.length} trailing windows agree the path is ${direction > 0 ? 'trending (Hurst > 0.55)' : 'mean-reverting (Hurst < 0.45)'}.`
      : `Hurst stays near 0.5 across ${classes.length} trailing windows; the path behaves like a random walk.`,
  };
}

function withConsensus(insight: Insight, family: AiSynthesis['family'], consensus: QuantConsensus, metrics: AiSynthesis['metrics']): AiSynthesis {
  return {
    family,
    verdict: insight.verdict,
    bullets: [...insight.bullets, consensus.detail],
    risk: insight.risk,
    consensus,
    metrics,
  };
}

/** Quant measurements + AI verdict for a digit family, with cross-window stability. */
export function synthesizeDigitAi(family: DigitSynthesisFamily, digits: readonly number[]): AiSynthesis {
  if (family === 'even-odd') {
    const metrics = analyzeEvenOdd(digits);
    return withConsensus(evenOddInsight(metrics), family, parityConsensus(digits), metrics);
  }
  if (family === 'matches') {
    const metrics = analyzeMatches(digits);
    return withConsensus(matchesInsight(metrics), family, digitConsensus(digits), metrics);
  }
  const metrics = analyzeOverUnder(digits);
  return withConsensus(overUnderInsight(metrics), family, digitConsensus(digits), metrics);
}

/** Quant measurements + AI verdict for the Rise/Fall family, with cross-window stability. */
export function synthesizeRiseFallAi(prices: readonly number[]): AiSynthesis {
  const metrics = analyzeRiseFall(prices);
  return withConsensus(riseFallInsight(metrics), 'rise-fall', regimeConsensus(prices), metrics);
}
