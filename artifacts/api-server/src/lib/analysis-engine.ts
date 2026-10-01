export type AnalysisFamily = "matches" | "even-odd" | "over-under" | "rise-fall" | "all";

export interface TickAnalysisInput {
  symbol?: string;
  ticks: number[];
  family: AnalysisFamily;
  barrier?: number;
}

export interface AnalysisEngineSummary {
  name: string;
  description: string;
  score: number;
  signal: string;
  detail: string;
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

const ENGINE_DEFINITIONS: Array<Pick<AnalysisEngineSummary, "name" | "description">> = [
  { name: "Tick Frequency Engine", description: "Measures observation density in the supplied tick window." },
  { name: "Digit Frequency Engine", description: "Measures smoothed frequency of each observed last digit." },
  { name: "Rolling Frequency Engine", description: "Compares recent digit frequencies with the full analysis window." },
  { name: "Weighted Frequency Engine", description: "Uses linearly increasing weights so later observations matter more." },
  { name: "Recency-Weighted Frequency Engine", description: "Uses exponential decay to emphasize the newest observations." },
  { name: "Digit Distribution Engine", description: "Evaluates concentration, balance, and deviation from uniform digit mass." },
  { name: "Digit Transition Engine", description: "Models first-order digit-to-digit transition probabilities." },
  { name: "Sequential Pattern Engine", description: "Scores recurring two-digit sequences and local pattern concentration." },
  { name: "Repetition Engine", description: "Measures consecutive digit repetition and repeated directional outcomes." },
  { name: "Alternation Engine", description: "Measures parity and direction alternation in adjacent observations." },
  { name: "Streak Engine", description: "Measures current and longest directional streaks." },
  { name: "Streak Break Engine", description: "Estimates pressure for a sign change after the current streak." },
  { name: "Momentum Engine", description: "Combines EMA spread, regression slope, RSI, and return pressure." },
  { name: "Mean Reversion Engine", description: "Scores distance from rolling mean and oscillator extremes." },
  { name: "Exhaustion Engine", description: "Detects extended runs and extreme RSI or band positions." },
  { name: "Reversal Engine", description: "Detects opposing recent movement, negative autocorrelation, and oscillator reversal." },
  { name: "Persistence Engine", description: "Measures whether recent direction and digit states persist." },
  { name: "Continuation Engine", description: "Checks whether the latest move agrees with the prevailing trend." },
  { name: "Anomaly Detection Engine", description: "Scores unusual latest returns relative to the recent return distribution." },
  { name: "Outlier Detection Engine", description: "Uses robust median absolute deviation to identify price outliers." },
  { name: "Regime Detection Engine", description: "Classifies trend and volatility conditions into a current regime." },
  { name: "Market State Engine", description: "Summarizes the window as bullish, bearish, range-bound, or high-volatility." },
  { name: "Volatility Regime Engine", description: "Classifies the return scale as compressed, balanced, or expanded." },
  { name: "Randomness Detection Engine", description: "Combines entropy and uniformity evidence for randomness pressure." },
  { name: "Entropy Engine", description: "Measures information entropy in the observed digit distribution." },
  { name: "Pattern Stability Engine", description: "Compares early and recent distributions for structural stability." },
  { name: "Pattern Persistence Engine", description: "Measures repeated digit states and directional autocorrelation." },
  { name: "Signal Stability Engine", description: "Measures agreement across the independent engine scores." },
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

const weightedDigitDistribution = (values: number[], mode: "linear" | "exponential"): number[] => {
  const counts = Array.from({ length: 10 }, () => 0.25);
  let totalWeight = 2.5;
  const decayWindow = Math.max(3, values.length / 4);
  values.forEach((value, index) => {
    const weight = mode === "linear"
      ? index + 1
      : Math.exp((index - values.length + 1) / decayWindow);
    counts[lastDigit(value)] += weight;
    totalWeight += weight;
  });
  return counts.map((count) => count / totalWeight);
};

const distributionSimilarity = (left: number[], right: number[]): number =>
  clamp(1 - left.reduce((distance, probability, index) => (
    distance + Math.abs(probability - (right[index] ?? 0))
  ), 0) / 2, 0, 1);

const adjacentRate = (values: number[], predicate: (current: number, previous: number) => boolean): number => {
  if (values.length < 2) return 0;
  let matches = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (predicate(values[index], values[index - 1])) matches += 1;
  }
  return matches / (values.length - 1);
};

const longestDigitRun = (values: number[]): number => {
  const digits = values.map(lastDigit);
  if (digits.length === 0) return 0;
  let current = 1;
  let longest = 1;
  for (let index = 1; index < digits.length; index += 1) {
    current = digits[index] === digits[index - 1] ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
};

const currentDirectionRun = (returns: number[]): number => {
  if (returns.length === 0) return 0;
  const lastSign = Math.sign(returns[returns.length - 1]);
  if (lastSign === 0) return 0;
  let length = 1;
  for (let index = returns.length - 2; index >= 0 && Math.sign(returns[index]) === lastSign; index -= 1) {
    length += 1;
  }
  return length;
};

const robustZScore = (values: number[], value: number): number => {
  const center = median(values);
  const mad = median(values.map((candidate) => Math.abs(candidate - center)));
  return mad === 0 ? 0 : (value - center) / (1.4826 * mad);
};

const createEngine = (
  definition: Pick<AnalysisEngineSummary, "name" | "description">,
  score: number,
  signal: string,
  detail: string,
): AnalysisEngineSummary => ({
  ...definition,
  score: Math.round(clamp(score, 0, 100)),
  signal,
  detail,
});

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
  const digitValues = values.map(lastDigit);
  const rollingLength = Math.max(5, Math.floor(values.length / 3));
  const recentValues = values.slice(-rollingLength);
  const earlyValues = values.slice(0, Math.max(5, values.length - rollingLength));
  const recentDigits = digitDistribution(recentValues);
  const earlyDigits = digitDistribution(earlyValues);
  const weightedDigits = weightedDigitDistribution(values, "linear");
  const recencyWeightedDigits = weightedDigitDistribution(values, "exponential");
  const rollingStability = distributionSimilarity(earlyDigits, recentDigits);
  const repeatedDigitRate = adjacentRate(digitValues, (current, previous) => current === previous);
  const alternatingDigitRate = adjacentRate(
    digitValues,
    (current, previous) => current % 2 !== previous % 2,
  );
  const repeatingDirectionRate = adjacentRate(
    returns,
    (current, previous) => Math.sign(current) === Math.sign(previous) && Math.sign(current) !== 0,
  );
  const alternatingDirectionRate = adjacentRate(
    returns,
    (current, previous) => Math.sign(current) !== Math.sign(previous),
  );
  const currentRun = currentDirectionRun(returns);
  const lastReturn = returns[returns.length - 1] ?? 0;
  const lastReturnZ = returnDeviation === 0 ? 0 : (lastReturn - averageReturn) / returnDeviation;
  const robustLastZ = robustZScore(values, last);

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
  const barrierOptions = Array.from({ length: 8 }, (_, index) => index + 1).map((barrier) => {
    const overMass = digits.slice(barrier + 1).reduce((sum, probability) => sum + probability, 0);
    const underMass = digits.slice(0, barrier).reduce((sum, probability) => sum + probability, 0);
    const side = overMass >= underMass ? "OVER" : "UNDER";
    return {
      barrier,
      overProbability: overMass,
      underProbability: underMass,
      probability: Math.max(overMass, underMass),
      label: `${side} ${barrier}`,
    };
  });
  const selectedBarrier = input.barrier === undefined
    ? barrierOptions.reduce((best, option) => option.probability > best.probability ? option : best, barrierOptions[0])
    : barrierOptions[input.barrier - 1];
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
      label: selectedBarrier.label,
      probability: round(selectedBarrier.probability),
      confidence: confidenceFor(selectedBarrier.probability, 0.5, values.length),
      direction: "Barrier distribution",
      detail: input.barrier === undefined
        ? `The analysis selected barrier ${selectedBarrier.barrier}, which gives the strongest estimated winning-side probability across barriers 1–8. Digits equal to the barrier count as neither side.`
        : `The selected side has ${(selectedBarrier.probability * 100).toFixed(1)}% estimated digit mass; a digit equal to the barrier counts as neither side.`,
      tone: probabilityTone(selectedBarrier.probability),
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

  const pairCounts = new Map<string, number>();
  for (let index = 1; index < digitValues.length; index += 1) {
    const key = `${digitValues[index - 1]}→${digitValues[index]}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const dominantPair = [...pairCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  const dominantPairRate = dominantPair ? dominantPair[1] / Math.max(digitValues.length - 1, 1) : 0;
  const meanReversionPressure = clamp(
    0.55 * normalizedFeature(zScore, 2)
      + 0.45 * normalizedFeature(rsiValue - 50, 35),
    0,
    1,
  );
  const exhaustionPressure = clamp(
    Math.max(
      normalizedFeature(rsiValue - 50, 45),
      normalizedFeature(currentRun, Math.max(5, values.length / 4)),
      normalizedFeature(bollingerPosition - 0.5, 0.5),
    ),
    0,
    1,
  );
  const reversalPressure = clamp(
    0.4 * ((1 - autocorrelation) / 2)
      + 0.3 * (1 - repeatingDirectionRate)
      + 0.3 * (lastReturn * trendScore < 0 ? 1 : 0),
    0,
    1,
  );
  const persistenceStrength = clamp(
    0.5 * ((autocorrelation + 1) / 2) + 0.5 * repeatingDirectionRate,
    0,
    1,
  );
  const continuationStrength = clamp(
    0.5 * (lastReturn === 0 || trendScore === 0 ? 0.5 : Math.sign(lastReturn) === Math.sign(trendScore) ? 1 : 0)
      + 0.5 * ((autocorrelation + 1) / 2),
    0,
    1,
  );
  const anomalyPressure = clamp(Math.abs(lastReturnZ) / 3, 0, 1);
  const outlierPressure = clamp(Math.abs(robustLastZ) / 3, 0, 1);
  const normalizedChiSquare = clamp(chiSquareUniformity(values) / 18, 0, 1);
  const randomnessPressure = clamp(0.7 * (entropy / Math.log2(10)) + 0.3 * (1 - normalizedChiSquare), 0, 1);
  const patternPersistence = clamp(
    0.5 * repeatedDigitRate + 0.5 * ((autocorrelation + 1) / 2),
    0,
    1,
  );
  const marketState = volatilityRegime === "expanded" && Math.abs(trendScore) < 0.3
    ? "High volatility"
    : trendScore > 0.25
      ? "Bullish pressure"
      : trendScore < -0.25
        ? "Bearish pressure"
        : "Range-bound";

  const engineResults = [
    createEngine(
      ENGINE_DEFINITIONS[0],
      clamp(35 + values.length / 2, 0, 100),
      values.length >= 30 ? "Dense window" : "Short window",
      `${values.length} observations supplied; timestamps are not included, so this measures window density rather than wall-clock ticks per second.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[1],
      Math.max(...digits) * 100,
      `Digit ${digits.indexOf(Math.max(...digits))} lead`,
      `The most frequent smoothed digit has ${(Math.max(...digits) * 100).toFixed(1)}% mass.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[2],
      (1 - rollingStability) * 100,
      rollingStability < 0.7 ? "Recent shift" : "Stable rolling profile",
      `The recent window is ${(rollingStability * 100).toFixed(1)}% similar to the earlier distribution.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[3],
      Math.max(...weightedDigits) * 100,
      `Weighted digit ${weightedDigits.indexOf(Math.max(...weightedDigits))} lead`,
      "Linear recency weights emphasize later observations without fully discarding older ticks.",
    ),
    createEngine(
      ENGINE_DEFINITIONS[4],
      Math.max(...recencyWeightedDigits) * 100,
      `Recent digit ${recencyWeightedDigits.indexOf(Math.max(...recencyWeightedDigits))} lead`,
      "Exponential recency weighting gives the newest observations the strongest influence.",
    ),
    createEngine(
      ENGINE_DEFINITIONS[5],
      (1 - entropy / Math.log2(10)) * 100,
      entropy / Math.log2(10) < 0.8 ? "Concentrated" : "Diffuse",
      `Normalized digit entropy is ${(entropy / Math.log2(10)).toFixed(3)}; lower values indicate more concentration.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[6],
      Math.max(...transitions.fromLast) * 100,
      `Next digit ${transitions.fromLast.indexOf(Math.max(...transitions.fromLast))} lead`,
      `The strongest transition from the latest digit has ${(Math.max(...transitions.fromLast) * 100).toFixed(1)}% smoothed probability.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[7],
      dominantPairRate * 100,
      dominantPair ? `Pair ${dominantPair[0]}` : "No repeated pair",
      dominantPair ? `The most common adjacent digit pair occurs ${(dominantPairRate * 100).toFixed(1)}% of the time.` : "There are not enough adjacent observations for a repeated pair.",
    ),
    createEngine(
      ENGINE_DEFINITIONS[8],
      100 * (0.65 * repeatedDigitRate + 0.35 * repeatingDirectionRate),
      repeatedDigitRate > 0.2 ? "Repetition present" : "Low repetition",
      `Adjacent digit repetition is ${(repeatedDigitRate * 100).toFixed(1)}%; same-direction return repetition is ${(repeatingDirectionRate * 100).toFixed(1)}%.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[9],
      100 * (0.65 * alternatingDigitRate + 0.35 * alternatingDirectionRate),
      alternatingDigitRate > 0.55 ? "Alternating digits" : "Low alternation",
      `Digit parity alternates ${(alternatingDigitRate * 100).toFixed(1)}% of the time; directional signs alternate ${(alternatingDirectionRate * 100).toFixed(1)}%.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[10],
      clamp((run.longestRun / Math.max(returns.length, 1)) * 100, 0, 100),
      `${run.longestRun}-tick longest run`,
      `The window contains ${run.runCount} directional runs; the longest run is ${run.longestRun} ticks.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[11],
      clamp(50 + (currentRun - 1) * 12, 0, 100),
      currentRun >= 3 ? "Break pressure" : "No extended streak",
      `The current directional streak is ${currentRun} tick${currentRun === 1 ? "" : "s"} long.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[12],
      50 + Math.abs(trendScore) * 50,
      trendScore > 0.15 ? "Upward momentum" : trendScore < -0.15 ? "Downward momentum" : "Neutral momentum",
      `Trend score is ${trendScore.toFixed(3)} from EMA spread, slope, RSI, and autocorrelation.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[13],
      meanReversionPressure * 100,
      meanReversionPressure > 0.55 ? "Reversion pressure" : "Trend-compatible",
      `Mean distance, RSI, and Bollinger position produce ${(meanReversionPressure * 100).toFixed(1)}% reversion pressure.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[14],
      exhaustionPressure * 100,
      exhaustionPressure > 0.6 ? "Exhaustion risk" : "No exhaustion signal",
      `Run length, RSI extremes, and band position produce ${(exhaustionPressure * 100).toFixed(1)}% exhaustion pressure.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[15],
      reversalPressure * 100,
      reversalPressure > 0.55 ? "Reversal pressure" : "Continuation favored",
      `Autocorrelation, direction changes, and latest-move disagreement produce ${(reversalPressure * 100).toFixed(1)}% reversal pressure.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[16],
      persistenceStrength * 100,
      persistenceStrength > 0.55 ? "Persistent direction" : "Weak persistence",
      `Return autocorrelation and same-direction repetition produce ${(persistenceStrength * 100).toFixed(1)}% persistence.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[17],
      continuationStrength * 100,
      continuationStrength > 0.55 ? "Continuation aligned" : "Continuation weak",
      `The latest move agrees with the broader trend and lag-one return structure at ${(continuationStrength * 100).toFixed(1)}%.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[18],
      anomalyPressure * 100,
      anomalyPressure > 0.65 ? "Latest return is unusual" : "No return anomaly",
      `The latest return has a standardized magnitude of ${Math.abs(lastReturnZ).toFixed(2)}.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[19],
      outlierPressure * 100,
      outlierPressure > 0.65 ? "Robust price outlier" : "No robust outlier",
      `The latest price has a robust MAD z-score of ${Math.abs(robustLastZ).toFixed(2)}.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[20],
      50 + Math.abs(trendScore) * 30 + (volatilityRegime === "expanded" ? 20 : volatilityRegime === "compressed" ? 10 : 0),
      marketState,
      `Current regime combines ${volatilityRegime} volatility with a ${trendScore >= 0 ? "positive" : "negative"} trend score.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[21],
      50 + Math.abs(trendScore) * 50,
      marketState,
      `Market state is ${marketState.toLowerCase()} based on directional pressure and volatility.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[22],
      volatilityRegime === "expanded" ? 85 : volatilityRegime === "compressed" ? 35 : 60,
      `${volatilityRegime[0].toUpperCase()}${volatilityRegime.slice(1)} volatility`,
      `Absolute return scale is ${(atrProxy / Math.max(Math.abs(average), Number.EPSILON) * 100).toFixed(4)}% of the mean quote.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[23],
      randomnessPressure * 100,
      randomnessPressure > 0.65 ? "Randomness pressure" : "Structure detected",
      `Entropy and chi-square evidence produce ${(randomnessPressure * 100).toFixed(1)}% randomness pressure.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[24],
      (entropy / Math.log2(10)) * 100,
      entropy / Math.log2(10) > 0.8 ? "High entropy" : "Lower entropy",
      `The digit distribution contains ${entropy.toFixed(3)} bits of Shannon entropy.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[25],
      rollingStability * 100,
      rollingStability > 0.7 ? "Stable pattern" : "Pattern shift",
      `Early and recent digit distributions are ${(rollingStability * 100).toFixed(1)}% similar.`,
    ),
    createEngine(
      ENGINE_DEFINITIONS[26],
      patternPersistence * 100,
      patternPersistence > 0.55 ? "Pattern persists" : "Pattern weak",
      `Digit repetition and return autocorrelation produce ${(patternPersistence * 100).toFixed(1)}% pattern persistence.`,
    ),
  ];
  const engineScoreAverage = mean(engineResults.map((engine) => engine.score));
  const engineScoreDeviation = standardDeviation(engineResults.map((engine) => engine.score), engineScoreAverage);
  const signalStability = clamp(100 - engineScoreDeviation * 2, 0, 100);
  const engines: AnalysisEngineSummary[] = [
    ...engineResults,
    createEngine(
      ENGINE_DEFINITIONS[27],
      signalStability,
      signalStability > 70 ? "Stable agreement" : signalStability > 45 ? "Mixed agreement" : "Conflicting engines",
      `The independent engine scores have a ${engineScoreDeviation.toFixed(1)} point standard deviation.`,
    ),
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
    engines,
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