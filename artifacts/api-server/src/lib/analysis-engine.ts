export type AnalysisFamily = "matches" | "even-odd" | "over-under" | "rise-fall" | "all";

export interface TickAnalysisInput {
  symbol?: string;
  ticks: number[];
  family: AnalysisFamily;
  barrier: number;
}

export interface AnalysisEngineSummary {
  name: string;
  description: string;
}

export interface AnalysisFactor {
  name: string;
  value: number;
  note: string;
  engine: string;
}

export interface AnalysisPrediction {
  family: string;
  label: string;
  probability: number;
  confidence: number;
  direction: string;
  detail: string;
  tone: "mint" | "amber" | "blue";
}

export interface AnalysisSignal {
  label: string;
  direction: string;
  probability: number;
  confidence: number;
  detail: string;
  tone: "mint" | "amber" | "blue";
}

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
  runCount: number;
  longestRun: number;
  positiveRate: number;
  lastDigitDistribution: number[];
  transitionMatrix: number[][];
  transitionFromLast: number[];
  nextDigitProbabilities: number[];
  volatilityRegime: "compressed" | "balanced" | "expanded";
}

export interface AnalysisResult {
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

const ENGINE_SUMMARIES: AnalysisEngineSummary[] = [
  {
    name: "Descriptive statistics",
    description: "Mean, median, dispersion, z-score, skewness, kurtosis, and range of the tick window.",
  },
  {
    name: "Digit distribution",
    description: "Smoothed last-digit frequencies, parity balance, barrier mass, entropy, and chi-square uniformity.",
  },
  {
    name: "Markov transitions",
    description: "First-order last-digit transition matrix blended with the unconditional digit distribution.",
  },
  {
    name: "Runs and autocorrelation",
    description: "Direction runs, longest streak, return autocorrelation, and positive-return rate.",
  },
  {
    name: "Momentum and mean reversion",
    description: "Fast and slow EMA gap, regression slope, RSI, Bollinger position, and directional pressure.",
  },
  {
    name: "Volatility regime",
    description: "Absolute return scale and dispersion classify the current window as compressed, balanced, or expanded.",
  },
  {
    name: "Ensemble scorer",
    description: "Combines independent feature groups and reports a probability with a conservative sample-size confidence.",
  },
];

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const round = (value: number, decimals = 4): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const variance = (values: number[], average = mean(values)): number =>
  values.length === 0 ? 0 : mean(values.map((value) => (value - average) ** 2));

const standardDeviation = (values: number[], average = mean(values)): number =>
  Math.sqrt(variance(values, average));

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const exponentialMovingAverage = (values: number[], span: number): number => {
  if (values.length === 0) return 0;
  const alpha = 2 / (Math.min(span, values.length) + 1);
  return values.slice(1).reduce((ema, value) => alpha * value + (1 - alpha) * ema, values[0]);
};

const linearSlope = (values: number[]): number => {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
};

const relativeReturns = (values: number[]): number[] =>
  values.slice(1).map((value, index) => value - values[index]);

const rsi = (returns: number[]): number => {
  if (returns.length === 0) return 50;
  const recent = returns.slice(-14);
  const gains = recent.filter((value) => value > 0);
  const losses = recent.filter((value) => value < 0).map(Math.abs);
  const averageGain = mean(gains);
  const averageLoss = mean(losses);
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
};

const lagOneAutocorrelation = (values: number[]): number => {
  if (values.length < 3) return 0;
  const average = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 1; index < values.length; index += 1) {
    numerator += (values[index] - average) * (values[index - 1] - average);
  }
  values.forEach((value) => {
    denominator += (value - average) ** 2;
  });
  return denominator === 0 ? 0 : clamp(numerator / denominator, -1, 1);
};

const lastDigit = (value: number): number => {
  const normalized = Math.abs(value).toString();
  const [whole, fraction = ""] = normalized.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const source = trimmedFraction.length > 0 ? trimmedFraction : whole;
  return Number(source[source.length - 1] ?? 0);
};

const digitDistribution = (values: number[]): number[] => {
  const counts = Array.from({ length: 10 }, () => 1);
  values.forEach((value) => {
    counts[lastDigit(value)] += 1;
  });
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.map((count) => count / total);
};

const transitionDistribution = (values: number[]): { matrix: number[][]; fromLast: number[] } => {
  const counts = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 1));
  const digits = values.map(lastDigit);
  for (let index = 1; index < digits.length; index += 1) {
    counts[digits[index - 1]][digits[index]] += 1;
  }
  const matrix = counts.map((row) => {
    const total = row.reduce((sum, count) => sum + count, 0);
    return row.map((count) => count / total);
  });
  return { matrix, fromLast: matrix[digits[digits.length - 1] ?? 0] };
};

const shannonEntropy = (distribution: number[]): number =>
  distribution.reduce((entropy, probability) => (
    probability > 0 ? entropy - probability * Math.log2(probability) : entropy
  ), 0);

const chiSquareUniformity = (values: number[]): number => {
  const counts = Array.from({ length: 10 }, () => 0);
  values.forEach((value) => {
    counts[lastDigit(value)] += 1;
  });
  const expected = values.length / 10;
  return expected === 0
    ? 0
    : counts.reduce((score, count) => score + (count - expected) ** 2 / expected, 0);
};

const runStats = (returns: number[]): { runCount: number; longestRun: number } => {
  const signs = returns.map((value) => (value > 0 ? 1 : value < 0 ? -1 : 0));
  if (signs.length === 0) return { runCount: 0, longestRun: 0 };
  let runCount = 1;
  let currentRun = 1;
  let longestRun = 1;
  for (let index = 1; index < signs.length; index += 1) {
    if (signs[index] === signs[index - 1]) {
      currentRun += 1;
    } else {
      runCount += 1;
      currentRun = 1;
    }
    longestRun = Math.max(longestRun, currentRun);
  }
  return { runCount, longestRun };
};

const confidenceFor = (probability: number, baseline: number, sampleSize: number): number => {
  const support = clamp(1 - Math.exp(-sampleSize / 30), 0.15, 0.95);
  const edge = Math.abs(probability - baseline) / Math.max(1 - baseline, 0.5);
  return Math.round(clamp(50 + edge * 42 * support, 50, 94));
};

const probabilityTone = (probability: number): "mint" | "amber" | "blue" =>
  probability >= 0.6 ? "mint" : probability >= 0.52 ? "amber" : "blue";

const normalizedFeature = (value: number, scale: number): number =>
  clamp(Math.abs(value) / Math.max(scale, Number.EPSILON), 0, 1);

export function analyzeTicks(input: TickAnalysisInput): AnalysisResult {
  const values = input.ticks.filter((value) => Number.isFinite(value) && value > 0).slice(-500);
  if (values.length < 5) {
    throw new Error("At least 5 positive finite ticks are required");
  }

  const returns = relativeReturns(values);
  const average = mean(values);
  const deviation = standardDeviation(values, average);
  const averageReturn = mean(returns);
  const returnDeviation = standardDeviation(returns, averageReturn);
  const last = values[values.length - 1];
  const zScore = deviation === 0 ? 0 : (last - average) / deviation;
  const thirdMoment = deviation === 0 ? 0 : mean(values.map((value) => ((value - average) / deviation) ** 3));
  const fourthMoment = deviation === 0 ? 0 : mean(values.map((value) => ((value - average) / deviation) ** 4)) - 3;
  const slope = linearSlope(values);
  const emaFast = exponentialMovingAverage(values, 5);
  const emaSlow = exponentialMovingAverage(values, 13);
  const rsiValue = rsi(returns);
  const atrProxy = mean(returns.map(Math.abs));
  const lastWindow = values.slice(-20);
  const windowMean = mean(lastWindow);
  const windowDeviation = standardDeviation(lastWindow, windowMean);
  const bandWidth = Math.max(windowDeviation * 4, Number.EPSILON);
  const bollingerPosition = clamp((last - (windowMean - 2 * windowDeviation)) / bandWidth, 0, 1);
  const autocorrelation = lagOneAutocorrelation(returns);
  const digits = digitDistribution(values);
  const transitions = transitionDistribution(values);
  const entropy = shannonEntropy(digits);
  const run = runStats(returns);
  const positiveRate = returns.length === 0
    ? 0.5
    : (returns.filter((value) => value > 0).length + returns.filter((value) => value === 0).length * 0.5) / returns.length;
  const volatilityRatio = atrProxy / Math.max(Math.abs(averageReturn) + returnDeviation, Number.EPSILON);
  const volatilityRegime: AnalysisMetrics["volatilityRegime"] =
    volatilityRatio < 0.65 ? "compressed" : volatilityRatio > 1.35 ? "expanded" : "balanced";

  const trendScore = clamp(
    0.36 * clamp((emaFast - emaSlow) / Math.max(deviation, Number.EPSILON), -1, 1)
      + 0.24 * clamp(slope / Math.max(atrProxy, Number.EPSILON), -1, 1)
      + 0.22 * ((rsiValue - 50) / 50)
      + 0.18 * autocorrelation,
    -1,
    1,
  );
  const riseProbability = clamp(0.5 + 0.3 * trendScore + 0.2 * (positiveRate - 0.5), 0.05, 0.95);
  const parityProbability = [0, 2, 4, 6, 8].reduce((sum, digit) => sum + digits[digit], 0);
  const overProbability = digits.slice(input.barrier + 1).reduce((sum, probability) => sum + probability, 0);
  const nextDigitProbabilities = transitions.fromLast.map((probability, digit) =>
    0.7 * probability + 0.3 * digits[digit]);
  const strongestDigit = nextDigitProbabilities.indexOf(Math.max(...nextDigitProbabilities));
  const matchProbability = nextDigitProbabilities[strongestDigit];

  const predictions: AnalysisPrediction[] = [
    {
      family: "matches",
      label: `MATCH ${strongestDigit}`,
      probability: round(matchProbability),
      confidence: confidenceFor(matchProbability, 0.1, values.length),
      direction: "Digit recurrence",
      detail: `Digit ${strongestDigit} leads the smoothed transition distribution from the latest digit.`,
      tone: probabilityTone(matchProbability),
    },
    {
      family: "even-odd",
      label: parityProbability >= 0.5 ? "EVEN" : "ODD",
      probability: round(Math.max(parityProbability, 1 - parityProbability)),
      confidence: confidenceFor(Math.max(parityProbability, 1 - parityProbability), 0.5, values.length),
      direction: "Parity balance",
      detail: `${parityProbability >= 0.5 ? "Even" : "Odd"} digits have the stronger smoothed mass in the current window.`,
      tone: probabilityTone(Math.max(parityProbability, 1 - parityProbability)),
    },
    {
      family: "over-under",
      label: overProbability >= 0.5 ? `OVER ${input.barrier}` : `UNDER ${input.barrier}`,
      probability: round(Math.max(overProbability, 1 - overProbability)),
      confidence: confidenceFor(Math.max(overProbability, 1 - overProbability), 0.5, values.length),
      direction: "Barrier distribution",
      detail: `Last-digit mass is ${overProbability >= 0.5 ? "above" : "at or below"} the selected barrier.`,
      tone: probabilityTone(Math.max(overProbability, 1 - overProbability)),
    },
    {
      family: "rise-fall",
      label: riseProbability >= 0.5 ? "RISE" : "FALL",
      probability: round(Math.max(riseProbability, 1 - riseProbability)),
      confidence: confidenceFor(Math.max(riseProbability, 1 - riseProbability), 0.5, values.length),
      direction: "Directional pressure",
      detail: `EMA spread, regression slope, RSI, return runs, and autocorrelation produce a ${riseProbability >= 0.5 ? "positive" : "negative"} directional bias.`,
      tone: probabilityTone(Math.max(riseProbability, 1 - riseProbability)),
    },
  ];

  const chosenPrediction = input.family === "all"
    ? predictions.reduce((best, prediction) => prediction.confidence > best.confidence ? prediction : best, predictions[0])
    : predictions.find((prediction) => prediction.family === input.family) ?? predictions[0];

  const digitEdge = normalizedFeature(Math.max(...digits) - 0.1, 0.2);
  const transitionEdge = normalizedFeature(Math.max(...transitions.fromLast) - 0.1, 0.2);
  const momentumEdge = normalizedFeature(trendScore, 1);
  const volatilityValue = volatilityRegime === "balanced" ? 60 : volatilityRegime === "expanded" ? 84 : 42;

  const metrics: AnalysisMetrics = {
    mean: round(average),
    median: round(median(values)),
    stdDev: round(deviation),
    coefficientVariation: round(deviation / Math.max(Math.abs(average), Number.EPSILON)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    range: round(Math.max(...values) - Math.min(...values)),
    skewness: round(thirdMoment),
    kurtosis: round(fourthMoment),
    zScore: round(zScore),
    slope: round(slope),
    returnMean: round(averageReturn),
    returnStdDev: round(returnDeviation),
    emaFast: round(emaFast),
    emaSlow: round(emaSlow),
    rsi: round(rsiValue),
    atrProxy: round(atrProxy),
    bollingerPosition: round(bollingerPosition),
    lag1Autocorrelation: round(autocorrelation),
    shannonEntropy: round(entropy),
    normalizedEntropy: round(entropy / Math.log2(10)),
    chiSquare: round(chiSquareUniformity(values)),
    runCount: run.runCount,
    longestRun: run.longestRun,
    positiveRate: round(positiveRate),
    lastDigitDistribution: digits.map((probability) => round(probability)),
    transitionMatrix: transitions.matrix.map((row) => row.map((probability) => round(probability))),
    transitionFromLast: transitions.fromLast.map((probability) => round(probability)),
    nextDigitProbabilities: nextDigitProbabilities.map((probability) => round(probability)),
    volatilityRegime,
  };

  return {
    version: "ensemble-v1",
    symbol: input.symbol ?? "unknown",
    sampleSize: values.length,
    engines: ENGINE_SUMMARIES,
    signal: {
      label: chosenPrediction.label,
      direction: chosenPrediction.direction,
      probability: chosenPrediction.probability,
      confidence: chosenPrediction.confidence,
      detail: chosenPrediction.detail,
      tone: chosenPrediction.tone,
    },
    predictions,
    factors: [
      {
        name: "Digit distribution",
        value: Math.round(digitEdge * 100),
        note: digitEdge > 0.55 ? "Concentrated" : "Balanced",
        engine: "Digit distribution",
      },
      {
        name: "Transition signal",
        value: Math.round(transitionEdge * 100),
        note: transitionEdge > 0.55 ? "Directional" : "Diffuse",
        engine: "Markov transitions",
      },
      {
        name: "Momentum pressure",
        value: Math.round(momentumEdge * 100),
        note: Math.abs(trendScore) > 0.55 ? (trendScore > 0 ? "Positive" : "Negative") : "Neutral",
        engine: "Momentum and mean reversion",
      },
      {
        name: "Volatility regime",
        value: volatilityValue,
        note: volatilityRegime[0].toUpperCase() + volatilityRegime.slice(1),
        engine: "Volatility regime",
      },
    ],
    metrics,
    methodNote: "Probabilities are smoothed estimates from the supplied tick window. Confidence reflects signal edge and sample size; it is not a probability of profit. Validate with walk-forward history and Brier/log-loss scores before relying on any engine.",
  };
}