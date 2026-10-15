/**
 * Rise/Fall consensus — every engine votes on one published direction.
 *
 * The scanner already computes rolling-window reads, trend, Dow-style swing
 * structure, momentum, breadth, volatility-normalised ROC, EMA50 position and
 * expiry-specific historical outcomes. This module turns all of them, plus the
 * deep quantitative engine (Hurst, fractal dimension, Markov continuation,
 * tick imbalance) and the rule-based AI synthesis, into counted votes with a
 * single evidence confidence score.
 *
 * Confidence is an evidence score. It is not a calibrated win probability, not a
 * payout or expected-value model, and not a promise about the next tick.
 */
import type { Bias, HistoricalOutcomes, RiseFallAnalysis } from './rise-fall-analysis.ts';
import { analyzeRiseFall as analyzeRiseFallQuant, type RiseFallMetrics } from './quant/rise-fall.ts';
import { riseFallInsight } from './quant/ai-insights.ts';
import { buildConsensus, clamp01, confidenceFactor, engineVote, scale, type EngineVote, type SignalConsensus, type VoteStance } from './signal-confidence.ts';

export type RiseFallHorizon = { unit: 'ticks' | 'minutes'; value: number };

export type RiseFallConsensusInput = {
  marketCode: string;
  marketName: string;
  analysis: RiseFallAnalysis;
  prices: readonly number[];
  fresh: boolean;
  historyLoaded: boolean;
  tickCount: number;
  horizon: RiseFallHorizon;
  historical: HistoricalOutcomes;
  directionalSupport: number | null;
  qualified: boolean;
  gateReasons: readonly string[];
  /** Pre-computed deep-quant metrics; pass one per market to avoid refitting. */
  quant?: RiseFallMetrics | null;
};

/** Deep-quant window: enough history for Hurst/fractal stability, still fast. */
const QUANT_WINDOW = 600;

/**
 * Tick depth the scanner asks for before a market is gate-qualified. Data
 * quality reaches its ceiling here; a shallower live feed is discounted rather
 * than treated as equally trustworthy.
 */
export const REQUIRED_CONSENSUS_TICKS = 500;

export function horizonLabel(horizon: RiseFallHorizon): string {
  return `${horizon.value} ${horizon.unit === 'ticks' ? (horizon.value === 1 ? 'tick' : 'ticks') : (horizon.value === 1 ? 'minute' : 'minutes')}`;
}

/** Fit the deep quantitative engine once per market per scan. */
export function riseFallQuantMetrics(prices: readonly number[]): RiseFallMetrics | null {
  const window = prices.slice(-QUANT_WINDOW);
  return window.length >= 30 ? analyzeRiseFallQuant(window) : null;
}

function stanceFromScore(score: number | null, sign: number, threshold = 0.1): VoteStance {
  if (score === null || !Number.isFinite(score)) return 'neutral';
  const aligned = score * sign;
  if (aligned > threshold) return 'support';
  if (aligned < -threshold) return 'oppose';
  return 'neutral';
}

/**
 * Direction the scan publishes. A WAIT composite still leans somewhere, so the
 * votes are measured against that lean and the low agreement shows up honestly
 * in the confidence score instead of hiding behind a missing signal.
 */
export function publishedDirection(analysis: RiseFallAnalysis): { direction: Bias; sign: number; leaned: boolean } {
  if (analysis.bias !== 'WAIT') return { direction: analysis.bias, sign: analysis.bias === 'RISE' ? 1 : -1, leaned: false };
  const lean = Math.abs(analysis.biasScore) >= 0.05 ? (analysis.biasScore > 0 ? 1 : -1) : 0;
  return { direction: lean === 0 ? 'WAIT' : lean > 0 ? 'RISE' : 'FALL', sign: lean || 1, leaned: true };
}

export function riseFallConsensus(input: RiseFallConsensusInput): SignalConsensus {
  const { analysis, historical, directionalSupport } = input;
  const { direction, sign, leaned } = publishedDirection(analysis);
  const quant = input.quant === undefined ? riseFallQuantMetrics(input.prices) : input.quant;
  const votes: EngineVote[] = [];

  // ENGINES 1–5 — rolling-window consensus reads.
  for (const window of analysis.windows) {
    votes.push(engineVote({
      id: `window-${window.window}`, label: `Rolling window · ${window.window} ticks`, family: 'rolling-windows',
      stance: stanceFromScore(window.score, sign), strength: clamp01(Math.abs(window.score ?? 0)), weight: window.score === null ? 0 : 0.07,
      detail: window.score === null
        ? `Fewer than ${window.window} validated ticks, so this window abstains.`
        : `${window.direction} read (${window.up} up / ${window.down} down / ${window.flat} flat) with score ${window.score.toFixed(2)}.`,
    }));
  }

  // ENGINE 6 — multi-window trend composite.
  votes.push(engineVote({
    id: 'trend', label: 'Trend composite', family: 'trend',
    stance: stanceFromScore(analysis.trendScore, sign, 0.12), strength: scale(Math.abs(analysis.trendScore), 0.6), weight: 0.12,
    detail: `Trend score ${analysis.trendScore.toFixed(2)} across the rolling windows (${analysis.trendScore * sign > 0.12 ? 'aligned' : analysis.trendScore * sign < -0.12 ? 'opposed' : 'not decisive'} with ${direction}).`,
  }));

  // ENGINE 7 — Dow-style swing structure.
  const requiredStructure = direction === 'RISE' ? 'Higher highs and higher lows' : direction === 'FALL' ? 'Lower highs and lower lows' : '';
  const structureAligned = requiredStructure !== '' && analysis.dowStructure === requiredStructure;
  votes.push(engineVote({
    id: 'swing-structure', label: 'Swing structure · 3-tick pivots', family: 'structure',
    stance: stanceFromScore(analysis.dowScore, sign, 0.12), strength: scale(Math.abs(analysis.dowScore), 0.6) * (structureAligned ? 1 : 0.7), weight: 0.12,
    detail: `${analysis.dowStructure} (score ${analysis.dowScore.toFixed(2)})${structureAligned ? ` — confirms ${direction}` : ` — does not confirm ${direction || 'the lean'}`}.`,
  }));

  // ENGINE 8 — momentum (RSI / MACD / rate of change).
  votes.push(engineVote({
    id: 'momentum', label: 'Momentum · RSI, MACD, ROC', family: 'momentum',
    stance: stanceFromScore(analysis.momentumScore, sign, 0.1), strength: scale(Math.abs(analysis.momentumScore), 0.6), weight: 0.12,
    detail: `Momentum score ${analysis.momentumScore.toFixed(2)} · RSI ${analysis.rsi14 === null ? '—' : analysis.rsi14.toFixed(1)} · MACD histogram ${analysis.macdHistogram === null ? '—' : analysis.macdHistogram.toFixed(5)}.`,
  }));

  // ENGINE 9 — 100-tick breadth.
  votes.push(engineVote({
    id: 'breadth', label: 'Breadth · 100-tick up/down balance', family: 'breadth',
    stance: stanceFromScore(analysis.breadthScore, sign, 0.1), strength: scale(Math.abs(analysis.breadthScore), 0.6), weight: 0.08,
    detail: `${analysis.upPercent100 === null ? '—' : analysis.upPercent100.toFixed(1)}% up versus ${analysis.downPercent100 === null ? '—' : analysis.downPercent100.toFixed(1)}% down (score ${analysis.breadthScore.toFixed(2)}).`,
  }));

  // ENGINE 10 — volatility-normalised rate of change.
  votes.push(engineVote({
    id: 'roc-volatility', label: 'Volatility-normalised ROC20', family: 'volatility',
    stance: stanceFromScore(analysis.rocScore, sign, 0.1), strength: scale(Math.abs(analysis.rocScore), 0.6), weight: 0.08,
    detail: `ROC score ${analysis.rocScore.toFixed(2)} · volatility regime ${analysis.volatilityRegime}${analysis.volatilityRatio === null ? '' : ` (ratio ${analysis.volatilityRatio.toFixed(2)})`}.`,
  }));

  // ENGINE 11 — position relative to EMA50.
  votes.push(engineVote({
    id: 'ema-position', label: 'EMA50 position', family: 'position',
    stance: stanceFromScore(analysis.ema50Score, sign, 0.1), strength: scale(Math.abs(analysis.ema50Score), 0.6), weight: 0.07,
    detail: `EMA50 score ${analysis.ema50Score.toFixed(2)} · EMA 9/21/50 ${analysis.ema9 === null ? '—' : analysis.ema9.toFixed(4)} / ${analysis.ema21 === null ? '—' : analysis.ema21.toFixed(4)} / ${analysis.ema50 === null ? '—' : analysis.ema50.toFixed(4)}.`,
  }));

  // ENGINE 12 — expiry-specific observed outcomes.
  const alignedCount = direction === 'RISE' ? historical.rise : direction === 'FALL' ? historical.fall : 0;
  const oppositeCount = direction === 'RISE' ? historical.fall : direction === 'FALL' ? historical.rise : 0;
  votes.push(engineVote({
    id: 'expiry-history', label: `Observed outcomes · ${horizonLabel(input.horizon)}`, family: 'historical-outcomes',
    stance: directionalSupport === null ? 'neutral' : directionalSupport > 0.05 ? (direction === 'WAIT' ? 'neutral' : 'support') : directionalSupport < -0.05 ? 'oppose' : 'neutral',
    strength: scale(Math.abs(directionalSupport ?? 0), 0.5), weight: directionalSupport === null ? 0 : 0.14,
    detail: directionalSupport === null
      ? `No non-equal outcomes at ${horizonLabel(input.horizon)} (${historical.sample} comparisons), so this engine abstains.`
      : `${alignedCount} aligned versus ${oppositeCount} opposite of ${historical.sample} completed ${horizonLabel(input.horizon)} comparisons (${(directionalSupport * 100).toFixed(1)}% net alignment).`,
  }));

  // ENGINE 13 — deep quantitative engine (Hurst, fractal, Markov, imbalance).
  if (quant) {
    const continuation = (quant.markovTrend.pRiseGiven1 - 0.5) * 2;
    const composite = clamp01(Math.abs(quant.trendBias * 0.6 + continuation * 0.4));
    const raw = quant.trendBias * 0.6 + continuation * 0.4;
    const meanReverting = quant.hurst < 0.45;
    const stance = stanceFromScore(raw, sign, 0.08);
    votes.push(engineVote({
      id: 'deep-quant', label: 'Deep quant · Hurst, fractal, Markov', family: 'quant',
      stance: meanReverting && stance === 'support' ? 'neutral' : stance,
      strength: composite * (meanReverting ? 0.6 : 1),
      weight: meanReverting && stance === 'support' ? 0.05 : 0.12,
      detail: `Trend bias ${(quant.trendBias * 100).toFixed(1)}% · P(rise | 1 up tick) ${(quant.markovTrend.pRiseGiven1 * 100).toFixed(1)}% · Hurst ${quant.hurst.toFixed(2)} (${meanReverting ? 'mean-reverting regime, so continuation votes are discounted' : quant.hurst > 0.55 ? 'trending regime' : 'near random walk'}) · fractal dimension ${quant.fractalDimension.toFixed(2)} · tick imbalance ${(quant.imbalance * 100).toFixed(1)}%.`,
    }));
  } else {
    votes.push(engineVote({
      id: 'deep-quant', label: 'Deep quant · Hurst, fractal, Markov', family: 'quant',
      stance: 'neutral', strength: 0, weight: 0,
      detail: `Fewer than 30 validated ticks in the last ${QUANT_WINDOW}, so the deep quantitative engine abstains.`,
    }));
  }

  // ENGINE 14 — rule-based AI synthesis of the deterministic outputs. It stays
  // on the list and abstains openly when there is too little history, so the
  // published engine count never silently changes between scans.
  if (quant) {
    const insight = riseFallInsight(quant);
    const verdictSign = insight.verdict === 'Bullish bias' ? 1 : insight.verdict === 'Bearish bias' ? -1 : 0;
    votes.push(engineVote({
      id: 'ai-synthesis', label: 'AI synthesis · regime verdict', family: 'ai',
      stance: verdictSign === 0 ? 'neutral' : verdictSign === sign ? 'support' : 'oppose',
      strength: verdictSign === 0 ? 0 : scale(Math.abs(quant.trendBias), 0.6),
      weight: verdictSign === 0 ? 0 : 0.1,
      detail: `${insight.verdict}. ${insight.bullets[0] ?? ''} ${insight.risk}`,
    }));
  } else {
    votes.push(engineVote({
      id: 'ai-synthesis', label: 'AI synthesis · regime verdict', family: 'ai',
      stance: 'neutral', strength: 0, weight: 0,
      detail: `Fewer than 30 validated ticks in the last ${QUANT_WINDOW}, so the synthesis engine has no regime verdict and abstains.`,
    }));
  }

  const agreement = buildConsensus({ votes, factors: [] });
  // Coverage: how much of the engine room had enough evidence to vote. Weighted
  // agreement only spans the engines that voted, so scaling by coverage stops a
  // near-empty feed from scoring a perfect agreement on one lone supporter.
  const voting = votes.filter((vote) => vote.weight > 0).length;
  const participation = votes.length ? voting / votes.length : 0;
  const coveredAgreement = agreement.weightedAgreement * participation;
  // Freshness alone is not depth: a live feed with 40 ticks is far weaker
  // evidence than a live feed with the 500 the scanner asks for, so quality is
  // the product of both. A full-depth feed still scores 1.
  const freshness = input.fresh ? 1 : input.historyLoaded ? 0.5 : 0.15;
  const depth = scale(input.tickCount, REQUIRED_CONSENSUS_TICKS);
  const dataQuality = clamp01(freshness * (0.2 + 0.8 * depth));

  const factors = [
    confidenceFactor({
      id: 'engine-consensus', label: 'Weighted engine agreement', score: coveredAgreement, weight: 0.22,
      detail: `${agreement.enginesAgreed} of ${agreement.enginesTotal} engines support ${direction === 'WAIT' ? 'the leading lean' : direction}; ${(agreement.weightedAgreement * 100).toFixed(0)}% of the voting weight agrees, and ${voting} of ${votes.length} engines had enough evidence to vote (${(participation * 100).toFixed(0)}% coverage).`,
    }),
    confidenceFactor({
      id: 'engine-breadth', label: 'Engine-family breadth', score: agreement.familiesTotal ? agreement.familiesAgreed / agreement.familiesTotal : 0, weight: 0.1,
      detail: `${agreement.familiesAgreed} of ${agreement.familiesTotal} engine families point the same way.`,
    }),
    confidenceFactor({
      id: 'composite-strength', label: 'Composite evidence strength', score: scale(Math.abs(analysis.biasScore), 0.6), weight: 0.18,
      detail: `Composite bias score ${analysis.biasScore.toFixed(2)} (${analysis.entryState}).`,
    }),
    confidenceFactor({
      id: 'expiry-alignment', label: `Expiry alignment · ${horizonLabel(input.horizon)}`, score: directionalSupport === null ? 0 : scale(directionalSupport, 0.5), weight: 0.18,
      detail: directionalSupport === null ? 'No directional outcomes could be measured at this duration.' : `Net historical alignment ${(directionalSupport * 100).toFixed(1)}% at ${horizonLabel(input.horizon)}.`,
    }),
    confidenceFactor({
      id: 'outcome-sample', label: 'Observed outcome sample', score: scale(historical.sample, 200), weight: 0.1,
      detail: `${historical.sample} completed comparisons (${historical.rise} rise / ${historical.fall} fall / ${historical.unchanged} unchanged).`,
    }),
    confidenceFactor({
      id: 'data-quality', label: 'Feed and data quality', score: dataQuality, weight: 0.12,
      detail: `${input.tickCount} validated ticks · history ${input.historyLoaded ? 'loaded' : 'missing'} · live feed ${input.fresh ? 'fresh' : 'stale or unconfirmed'}.`,
    }),
    confidenceFactor({
      id: 'evidence-gates', label: 'Evidence gates', score: input.qualified ? 1 : 0.35, weight: 0.1,
      detail: input.qualified ? 'Every data, technical and expiry gate passed.' : `Gates not passed: ${input.gateReasons.slice(0, 2).join(' ') || 'insufficient aligned evidence'}.`,
    }),
  ];

  return buildConsensus({ votes, factors });
}
