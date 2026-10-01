export interface ReturnDiagnostics {
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
  chiSquarePValue: number;
}

const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const variance = (values: number[], average = mean(values)): number =>
  values.length ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length : 0;

const autocorrelation = (values: number[], lag: number): number => {
  if (values.length <= lag + 1) return 0;
  const average = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = lag; index < values.length; index += 1) {
    numerator += (values[index] - average) * (values[index - lag] - average);
  }
  for (const value of values) denominator += (value - average) ** 2;
  return denominator === 0 ? 0 : Math.max(-1, Math.min(1, numerator / denominator));
};

const logGamma = (value: number): number => {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const z = value - 1;
  let series = 0.9999999999998099;
  coefficients.forEach((coefficient, index) => {
    series += coefficient / (z + index + 1);
  });
  const t = z + coefficients.length - 0.5;
  return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(series);
};

const regularizedGammaQ = (a: number, x: number): number => {
  if (x <= 0) return 1;
  if (a <= 0) return 0;
  const logScale = -x + a * Math.log(x) - logGamma(a);
  const epsilon = 1e-14;
  const floor = 1e-300;

  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    let ap = a;
    for (let index = 0; index < 500; index += 1) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * epsilon) break;
    }
    const p = sum * Math.exp(logScale);
    return Math.max(0, Math.min(1, 1 - p));
  }

  let b = x + 1 - a;
  let c = 1 / floor;
  let d = 1 / Math.max(b, floor);
  let fraction = d;
  for (let index = 1; index < 500; index += 1) {
    const an = -index * (index - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < floor) d = floor;
    c = b + an / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    fraction *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return Math.max(0, Math.min(1, Math.exp(logScale) * fraction));
};

const runsTest = (values: number[]): { zScore: number; pValue: number } => {
  const signs = values.map(Math.sign).filter((sign) => sign !== 0);
  const positive = signs.filter((sign) => sign > 0).length;
  const negative = signs.length - positive;
  if (positive === 0 || negative === 0 || signs.length < 3) return { zScore: 0, pValue: 1 };

  let observedRuns = 1;
  for (let index = 1; index < signs.length; index += 1) {
    if (signs[index] !== signs[index - 1]) observedRuns += 1;
  }
  const total = positive + negative;
  const expected = 1 + (2 * positive * negative) / total;
  const runVariance = (
    2 * positive * negative * (2 * positive * negative - total)
  ) / (total ** 2 * (total - 1));
  if (runVariance <= 0) return { zScore: 0, pValue: 1 };
  const zScore = (observedRuns - expected) / Math.sqrt(runVariance);
  const pValue = regularizedGammaQ(0.5, (zScore ** 2) / 2);
  return { zScore, pValue };
};

const trendTStatistic = (values: number[]): number => {
  const n = values.length;
  if (n < 3) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let sxx = 0;
  let sxy = 0;
  values.forEach((value, index) => {
    sxx += (index - xMean) ** 2;
    sxy += (index - xMean) * (value - yMean);
  });
  if (sxx === 0) return 0;
  const slope = sxy / sxx;
  const residualSum = values.reduce((sum, value, index) => (
    sum + (value - (yMean + slope * (index - xMean))) ** 2
  ), 0);
  const standardError = Math.sqrt((residualSum / (n - 2)) / sxx);
  return standardError === 0 ? 0 : slope / standardError;
};

const structuralShiftZ = (values: number[]): number => {
  const midpoint = Math.floor(values.length / 2);
  const early = values.slice(0, midpoint);
  const late = values.slice(midpoint);
  if (early.length < 2 || late.length < 2) return 0;
  const standardError = Math.sqrt(variance(early) / early.length + variance(late) / late.length);
  return standardError === 0 ? 0 : (mean(late) - mean(early)) / standardError;
};

export function analyzeReturnDiagnostics(returns: number[], prices: number[], chiSquare: number): ReturnDiagnostics {
  const autocorrelationByLag = Array.from({ length: 5 }, (_, index) => autocorrelation(returns, index + 1));
  const maxLag = Math.min(5, Math.max(returns.length - 1, 0));
  const ljungBoxQ = returns.length > 0
    ? returns.length * (returns.length + 2) * autocorrelationByLag
      .slice(0, maxLag)
      .reduce((sum, correlation, index) => sum + (correlation ** 2) / (returns.length - index - 1), 0)
    : 0;
  const ljungBoxPValue = maxLag > 0 ? regularizedGammaQ(maxLag / 2, ljungBoxQ / 2) : 1;

  const average = mean(returns);
  const deviation = Math.sqrt(variance(returns, average));
  const skew = deviation === 0 ? 0 : mean(returns.map((value) => ((value - average) / deviation) ** 3));
  const excessKurtosis = deviation === 0
    ? 0
    : mean(returns.map((value) => ((value - average) / deviation) ** 4)) - 3;
  const jarqueBera = returns.length > 0
    ? (returns.length / 6) * (skew ** 2 + (excessKurtosis ** 2) / 4)
    : 0;
  const normalityPValue = regularizedGammaQ(1, jarqueBera / 2);
  const runs = runsTest(returns);
  const volatilityAutocorrelation = autocorrelation(returns.map((value) => value ** 2), 1);
  const structuralShiftZScore = structuralShiftZ(returns);
  const sortedReturns = [...returns].sort((left, right) => left - right);
  const valueAtRisk95 = sortedReturns.length
    ? sortedReturns[Math.floor((sortedReturns.length - 1) * 0.05)]
    : 0;
  const tail = returns.filter((value) => value <= valueAtRisk95);
  let peak = prices[0] ?? 0;
  let maxDrawdown = 0;
  prices.forEach((price) => {
    peak = Math.max(peak, price);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - price) / peak);
  });
  const correlationPenalty = autocorrelationByLag.reduce((sum, value) => sum + Math.max(0, value), 0);
  const effectiveSampleSize = returns.length
    ? Math.max(1, Math.min(returns.length, returns.length / (1 + 2 * correlationPenalty)))
    : 0;

  return {
    autocorrelationByLag,
    ljungBoxQ,
    ljungBoxPValue,
    jarqueBera,
    normalityPValue,
    runsZScore: runs.zScore,
    runsPValue: runs.pValue,
    trendTStatistic: trendTStatistic(returns),
    volatilityAutocorrelation,
    structuralShiftZScore,
    valueAtRisk95,
    expectedShortfall95: mean(tail),
    maxDrawdown,
    effectiveSampleSize,
    chiSquarePValue: regularizedGammaQ(4.5, chiSquare / 2),
  };
}