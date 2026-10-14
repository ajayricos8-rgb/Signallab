import { analyzeDigits, type DigitAnalysis } from './digit-analysis.ts';
import { runResearchRanking, type DigitFamily, type DigitRankingFeed, type DigitRankingResult } from './digit-signals.ts';

export type DigitResearchRequest = { family: DigitFamily; feed: DigitRankingFeed; selectedDuration: number | null };
export type DigitResearchResponse = { analysis: DigitAnalysis; ranking: DigitRankingResult } | { error: string };

// Local training and chronological evaluation never block the trading UI.
self.onmessage = (event: MessageEvent<DigitResearchRequest>) => {
  try {
    const { family, feed, selectedDuration } = event.data;
    const analysis = analyzeDigits(feed.ticks);
    const ranking = runResearchRanking(family, feed, analysis, selectedDuration);
    self.postMessage({ analysis, ranking } satisfies DigitResearchResponse);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'The research engines could not finish.' } satisfies DigitResearchResponse);
  }
};
