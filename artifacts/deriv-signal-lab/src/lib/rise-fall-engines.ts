// Rise/Fall engine council: every rolling window, technical engine and the AI
// synthesis layer casts a RISE / FALL / NEUTRAL vote so each completed scan can
// report how many engines agree with the emitted signal and at what confidence.
import type { EngineVote } from './engine-consensus.ts';
import type { HistoricalOutcomes, RiseFallAnalysis } from './rise-fall-analysis.ts';
import { analyzeRiseFall as analyzeRiseFallQuant } from './quant/rise-fall.ts';
import { riseFallInsight } from './quant/ai-insights.ts';

const RISE = 'RISE';
const FALL = 'FALL';
const NEUTRAL = 'WAIT';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function scoreVote(id: string, label: string, score: number, scale: number, note: string): EngineVote {
  const direction = score >= 0 ? RISE : FALL;
  const magnitude = clamp01(Math.abs(score) / scale);
  if (Math.abs(score) < scale * 0.18) {
    return { id, label, side: NEUTRAL, strength: 0.15, note };
  }
  return { id, label, side: direction, strength: clamp01(0.25 + magnitude * 0.75), note };
}

/**
 * Build the full rise/fall council for one market. `historical` is the
 * expiry-specific outcome comparison at the horizon under evaluation.
 */
export function riseFallCouncil(
  analysis: RiseFallAnalysis,
  historical: HistoricalOutcomes | null,
  prices: readonly number[],
): EngineVote[] {
  const votes: EngineVote[] = [];

  for (const window of analysis.windows) {
    const score = window.score ?? 0;
    votes.push(scoreVote(
      `window-${window.window}`,
      `Rolling window · ${window.window} ticks`,
      score,
      1,
      `${window.direction} · score ${score >= 0 ? '+' : ''}${score.toFixed(3)}`,
    ));
  }

  votes.push(scoreVote('trend', 'Composite trend engine', analysis.trendScore, 1, `Trend score ${analysis.trendScore >= 0 ? '+' : ''}${analysis.trendScore.toFixed(3)}`));
  votes.push(scoreVote('swing-structure', 'Dow swing structure', analysis.dowScore, 1, analysis.dowStructure));
  votes.push(scoreVote('momentum', 'RSI / EMA / MACD momentum', analysis.momentumScore, 1, `Momentum score ${analysis.momentumScore >= 0 ? '+' : ''}${analysis.momentumScore.toFixed(3)}`));
  votes.push(scoreVote('breadth', '100-tick breadth engine', analysis.breadthScore, 1, `Breadth score ${analysis.breadthScore >= 0 ? '+' : ''}${analysis.breadthScore.toFixed(3)}`));
  votes.push(scoreVote('roc20', 'Volatility-normalized ROC20', analysis.rocScore, 1, `ROC score ${analysis.rocScore >= 0 ? '+' : ''}${analysis.rocScore.toFixed(3)}`));
  votes.push(scoreVote('ema50', 'EMA50 position engine', analysis.ema50Score, 1, `EMA50 score ${analysis.ema50Score >= 0 ? '+' : ''}${analysis.ema50Score.toFixed(3)}`));

  if (analysis.rsi14 !== null) {
    const deviation = (analysis.rsi14 - 50) / 50;
    votes.push(scoreVote('rsi', 'RSI · 14', deviation, 1, `RSI ${analysis.rsi14.toFixed(1)}`));
  }
  if (analysis.macdHistogram !== null) {
    const scale = Math.max(1e-9, Math.abs(analysis.averageTickMove14 ?? 1) * 2);
    votes.push(scoreVote('macd', 'MACD histogram', analysis.macdHistogram / scale, 1, `MACD histogram ${analysis.macdHistogram.toPrecision(4)}`));
  }

  if (prices.length >= 30) {
    const quant = analyzeRiseFallQuant(prices);
    votes.push(scoreVote('markov-continuation', 'Markov tick continuation', (quant.markovTrend.pRiseGiven1 - 0.5) * 2, 1, `P(rise | 1 up tick) ${(quant.markovTrend.pRiseGiven1 * 100).toFixed(1)}%`));
    votes.push(scoreVote('momentum-quant', 'Quant momentum engine', quant.trendBias, 1, `Quant trend bias ${quant.trendBias >= 0 ? '+' : ''}${quant.trendBias.toFixed(2)} · Hurst ${quant.hurst.toFixed(2)}`));
    const insight = riseFallInsight(quant);
    const insightSide = insight.verdict.startsWith('Bullish') ? RISE : insight.verdict.startsWith('Bearish') ? FALL : NEUTRAL;
    votes.push({
      id: 'ai-synthesis', label: 'AI synthesis layer', side: insightSide,
      strength: insightSide === NEUTRAL ? 0.15 : 0.6, note: insight.verdict,
    });
  }

  if (historical && historical.sample > 0) {
    const directional = historical.rise + historical.fall;
    if (directional > 0) {
      const support = (historical.rise - historical.fall) / directional;
      votes.push(scoreVote(
        'historical-outcomes', 'Expiry-specific historical outcomes', support, 1,
        `${historical.rise} rise vs ${historical.fall} fall over ${historical.sample} completed outcomes`,
      ));
    }
  }

  return votes;
}
