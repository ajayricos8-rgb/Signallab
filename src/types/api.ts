export type CandleOpenForecastResponseLabel = 'RISE' | 'FALL';

export interface AnalysisEngineSummary {
  name: string;
  description: string;
  score: number;
  signal: string;
  detail: string;
}

export interface CandleOpenFeatures {
  emaSpreadAtr: number;
  rsi: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  atr: number;
  bollingerPosition: number;
  returnAutocorrelation: number;
  volatilityClustering: number;
  efficiencyRatio: number;
  openingGapAtr: number;
  upCandleRate: number;
  trendTStatistic: number;
}

export interface CandleOpenForecastResponse {
  symbol: string;
  intervalSeconds: number;
  candleEpoch: number;
  openPrice: number;
  label: CandleOpenForecastResponseLabel;
  probability: number;
  confidence: number;
  sampleSize: number;
  effectiveSampleSize: number;
  detail: string;
  engines: AnalysisEngineSummary[];
  features: CandleOpenFeatures;
  methodNote: string;
}

export interface AnalysisFactor {
  name: string;
  value: number;
  note: string;
  engine: string;
}

export type AnalysisPredictionTone = 'mint' | 'amber' | 'blue';

export interface AnalysisPrediction {
  family: string;
  label: string;
  probability: number;
  confidence: number;
  direction: string;
  detail: string;
  tone: AnalysisPredictionTone;
}

export type AnalysisSignalTone = 'mint' | 'amber' | 'blue';

export interface AnalysisSignal {
  label: string;
  direction: string;
  probability: number;
  confidence: number;
  detail: string;
  tone: AnalysisSignalTone;
}

export type AnalysisMetricsVolatilityRegime = 'compressed' | 'balanced' | 'expanded';

export interface AnalysisMetrics {
  mean: number;
  median: number;
  stdDev: number;
  coefficientVariation: number;
  min: number;
  max: number;
  range: number;
  skewness: number;
  kurtosis: number;
  zScore: number;
  slope: number;
  returnMean: number;
  returnStdDev: number;
  emaFast: number;
  emaSlow: number;
  rsi: number;
  atrProxy: number;
  bollingerPosition: number;
  lag1Autocorrelation: number;
  shannonEntropy: number;
  normalizedEntropy: number;
  chiSquare: number;
  chiSquarePValue: number;
  runCount: number;
  longestRun: number;
  positiveRate: number;
  lastDigitDistribution: number[];
  transitionMatrix: number[][];
  transitionFromLast: number[];
  nextDigitProbabilities: number[];
  volatilityRegime: AnalysisMetricsVolatilityRegime;
  digitCounts: number[];
  transitionCounts: number[][];
  autocorrelationByLag: number[];
  ljungBoxQ: number;
  ljungBoxPValue: number;
  jarqueBera: number;
  normalityPValue: number;
  runsZScore: number;
  runsPValue: number;
  trendTStatistic: number;
  volatilityAutocorrelation: number;
  structuralShiftZScore: number;
  valueAtRisk95: number;
  expectedShortfall95: number;
  maxDrawdown: number;
  effectiveSampleSize: number;
}

export interface AnalysisResponse {
  version: string;
  symbol: string;
  sampleSize: number;
  engines: AnalysisEngineSummary[];
  signal: AnalysisSignal;
  predictions: AnalysisPrediction[];
  factors: AnalysisFactor[];
  metrics: AnalysisMetrics;
  methodNote: string;
}
