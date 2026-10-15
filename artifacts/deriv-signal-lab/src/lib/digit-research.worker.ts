import { analyzeDigits, type DigitAnalysis } from './digit-analysis.ts';
import { runResearchRanking, type DigitFamily, type DigitRankingFeed, type DigitRankingResult } from './digit-signals.ts';

export type DigitResearchRequest = { family: DigitFamily; feed: DigitRankingFeed; selectedDuration: number | null };
export type DigitResearchProgress = { progress: { percent: number; phase: string } };
export type DigitResearchResult = { analysis: DigitAnalysis; ranking: DigitRankingResult };
export type DigitResearchError = { error: string };
export type DigitResearchResponse = DigitResearchResult | DigitResearchError;
export type DigitResearchMessage = DigitResearchProgress | DigitResearchResponse;

export function isProgressMessage(message: DigitResearchMessage): message is DigitResearchProgress {
  return 'progress' in message;
}

// Local training and chronological evaluation never block the trading UI.
// Progress is streamed so the tool can show a real percentage while the models
// fit, and the finished signal arrives in the same message channel.
self.onmessage = (event: MessageEvent<DigitResearchRequest>) => {
  try {
    const { family, feed, selectedDuration } = event.data;
    self.postMessage({ progress: { percent: 1, phase: 'Reading validated ticks' } } satisfies DigitResearchProgress);
    const analysis = analyzeDigits(feed.ticks);
    const ranking = runResearchRanking(family, feed, analysis, selectedDuration, (percent, phase) => {
      self.postMessage({ progress: { percent: Math.max(0, Math.min(100, Math.round(percent))), phase } } satisfies DigitResearchProgress);
    });
    self.postMessage({ progress: { percent: 100, phase: 'Analysis complete' } } satisfies DigitResearchProgress);
    self.postMessage({ analysis, ranking } satisfies DigitResearchResponse);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'The research engines could not finish.' } satisfies DigitResearchResponse);
  }
};
