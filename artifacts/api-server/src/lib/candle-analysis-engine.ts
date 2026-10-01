import type {
  AnalysisEngineSummary,
  CandleOpenAnalysisInput,
  CandleOpenForecastResponse,
} from "@workspace/api-zod";

type CandleBar = CandleOpenAnalysisInput["completedCandles"][number];

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const round = (value: number, decimals = 5): number => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
};

const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const standardDeviation = (values: number[]): number => {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const ema = (values: number[], period: number): number => {
  if (!values.length) return 0;
  const alpha = 2 / (Math.min(period, values.length) + 1);
  return values.slice(1).reduce((current, value) => alpha * value + (1 - alpha) * current, values[0]);
};

const autocorrelation = (values: number[], lag = 1): number => {
  if (values.length <= lag + 1) return 0;
  const average = mean(values);
  const denominator = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  if (denominator === 0) return 0;
  let numerator = 0;
  for (let index = lag; index < values.length; index += 1) {
    numerator += (values[index] - average) * (values[index - lag] - average);
  }
  return clamp(numerator / denominator, -1, 1);
};

const rsi = (returns: number[]): number => {
  const recent = returns.slice(-14);
  const gains = recent.filter((value) => value > 0);
  const losses = recent.filter((value) => value < 0).map(Math.abs);
  const gain = mean(gains);
  const loss = mean(losses);
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
};

const linearTrendT = (values: number[]): number => {
  if (values.length < 3) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let sxx = 0;
  let sxy = 0;
  values.forEach((value, index) => {
    sxx += (index - xMean) ** 2;
    sxy += (index - xMean) * (value - yMean);
  });
  if (!sxx) return 0;
  const slope = sxy / sxx;
  const residuals = values.map((value, index) => value - (yMean + slope * (index - xMean)));
  const standardError = Math.sqrt(mean(residuals.map((value) => value ** 2)) / Math.max(values.length - 2, 1) / sxx);
  return standardError === 0 ? 0 : slope / standardError;
};

const engine = (
  name: string,
  description: string,
  signedEvidence: number,
  signal: string,
  detail: string,
): AnalysisEngineSummary => ({
  name,
  description,
  score: Math.round(clamp(50 + 50 * Math.abs(signedEvidence), 0, 100)),
  signal,
  detail,
});

export function analyzeCandleOpen(input: CandleOpenAnalysisInput): CandleOpenForecastResponse {
  const candles = input.completedCandles.slice(-500);
  if (input.intervalSeconds !== 60) {
    throw new Error("Automatic candle forecasts currently require 60-second candles");
  }
  if (candles.length < 30) {
    throw new Error("At least 30 completed candles are required for a candle-open forecast");
  }

  let previousEpoch = -1;
  for (const candle of candles) {
    if (
      candle.epoch <= previousEpoch
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < candle.low
    ) {
      throw new Error("Candle history must be ordered and contain valid OHLC ranges");
    }
    previousEpoch = candle.epoch;
  }
  if (input.candleEpoch <= previousEpoch) {
    throw new Error("The forecast candle must begin after all supplied completed candles");
  }

  const closes = candles.map((candle) => candle.close);
  const logReturns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const last = candles[candles.length - 1];
  const fastEma = ema(closes, 8);
  const slowEma = ema(closes, 21);
  const trueRanges: number[] = [];
  const positiveDirectional: number[] = [];
  const negativeDirectional: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const prior = candles[index - 1];
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - prior.close),
      Math.abs(current.low - prior.close),
    ));
    const upwardMove = current.high - prior.high;
    const downwardMove = prior.low - current.low;
    positiveDirectional.push(upwardMove > downwardMove && upwardMove > 0 ? upwardMove : 0);
    negativeDirectional.push(downwardMove > upwardMove && downwardMove > 0 ? downwardMove : 0);
  }
  const atrWindow = trueRanges.slice(-14);
  const atr = mean(atrWindow);
  const safeAtr = Math.max(atr, Math.abs(last.close) * 1e-10, Number.EPSILON);
  const smoothedRange: number[] = [];
  const smoothedPlus: number[] = [];
  const smoothedMinus: number[] = [];
  for (let index = 0; index < trueRanges.length; index += 1) {
    const start = Math.max(0, index - 13);
    smoothedRange.push(mean(trueRanges.slice(start, index + 1)));
    smoothedPlus.push(mean(positiveDirectional.slice(start, index + 1)));
    smoothedMinus.push(mean(negativeDirectional.slice(start, index + 1)));
  }
  const dx = smoothedRange.map((range, index) => {
    if (range <= 0) return 0;
    const plus = (smoothedPlus[index] / range) * 100;
    const minus = (smoothedMinus[index] / range) * 100;
    return plus + minus === 0 ? 0 : (Math.abs(plus - minus) / (plus + minus)) * 100;
  });
  const adx = mean(dx.slice(-14));
  const plusDi = smoothedRange.length
    ? (smoothedPlus[smoothedPlus.length - 1] / Math.max(smoothedRange[smoothedRange.length - 1], Number.EPSILON)) * 100
    : 0;
  const minusDi = smoothedRange.length
    ? (smoothedMinus[smoothedMinus.length - 1] / Math.max(smoothedRange[smoothedRange.length - 1], Number.EPSILON)) * 100
    : 0;
  const rsiValue = rsi(logReturns);
  const closeWindow = closes.slice(-20);
  const closeMean = mean(closeWindow);
  const closeDeviation = standardDeviation(closeWindow);
  const bollingerPosition = clamp(
    closeDeviation === 0 ? 0.5 : (last.close - (closeMean - 2 * closeDeviation)) / (4 * closeDeviation),
    0,
    1,
  );
  const returnAutocorrelation = autocorrelation(logReturns, 1);
  const volatilityClustering = autocorrelation(logReturns.map((value) => value ** 2), 1);
  const efficiencyWindow = closes.slice(-21);
  const efficiencyPath = efficiencyWindow.slice(1).reduce((sum, value, index) => sum + Math.abs(value - efficiencyWindow[index]), 0);
  const efficiencyRatio = efficiencyPath === 0
    ? 0
    : Math.abs(efficiencyWindow[efficiencyWindow.length - 1] - efficiencyWindow[0]) / efficiencyPath;
  const openingGapAtr = (input.openPrice - last.close) / safeAtr;
  const upCandleRate = candles.filter((candle) => candle.close > candle.open).length / candles.length;
  const lastRange = Math.max(last.high - last.low, Number.EPSILON);
  const candleBodySignal = (last.close - last.open) / lastRange;
  const emaSpreadAtr = (fastEma - slowEma) / safeAtr;
  const trendTStatistic = linearTrendT(logReturns);
  const lagCorrelations = Array.from({ length: 5 }, (_, index) => autocorrelation(logReturns, index + 1));
  const effectiveSampleSize = clamp(
    logReturns.length / (1 + 2 * lagCorrelations.reduce((sum, correlation) => sum + Math.max(0, correlation), 0)),
    1,
    logReturns.length,
  );

  const emaSignal = Math.tanh(emaSpreadAtr / 2);
  const rsiSignal = clamp((rsiValue - 50) / 30, -1, 1);
  const directionalIndexSignal = clamp((plusDi - minusDi) / 35, -1, 1) * clamp(adx / 35, 0, 1);
  const meanReversionSignal = clamp((0.5 - bollingerPosition) * 2, -1, 1);
  const openingGapSignal = Math.tanh(openingGapAtr / 1.5);
  const regressionSignal = Math.tanh(trendTStatistic / 3);
  const efficiencyTrendSignal = Math.sign(closes[closes.length - 1] - closes[0]) * efficiencyRatio;
  const momentumSignal = clamp(
    0.45 * emaSignal + 0.25 * rsiSignal + 0.2 * directionalIndexSignal + 0.1 * returnAutocorrelation,
    -1,
    1,
  );
  const trendSignal = clamp(
    0.42 * momentumSignal
      + 0.2 * regressionSignal
      + 0.18 * efficiencyTrendSignal
      + 0.2 * directionalIndexSignal,
    -1,
    1,
  );
  const candleSignal = clamp(
    0.5 * candleBodySignal + 0.5 * Math.sign(last.close - last.open),
    -1,
    1,
  );
  const volatilityReliability = 1 - 0.35 * Math.max(0, volatilityClustering);
  const support = Math.sqrt(effectiveSampleSize / (effectiveSampleSize + 60));
  const signedProbability = clamp(
    0.5 + 0.31 * support * volatilityReliability * (
      0.56 * trendSignal
      + 0.18 * meanReversionSignal
      + 0.14 * openingGapSignal
      + 0.12 * candleSignal
    ),
    0.05,
    0.95,
  );
  const label = signedProbability >= 0.5 ? "RISE" : "FALL";
  const probability = Math.max(signedProbability, 1 - signedProbability);
  const engines: AnalysisEngineSummary[] = [
    engine("EMA Trend Engine", "Fast/slow exponential moving-average spread scaled by true range.", emaSignal, emaSignal > 0.1 ? "Upward trend" : emaSignal < -0.1 ? "Downward trend" : "Neutral", `Fast/slow EMA spread is ${emaSpreadAtr.toFixed(3)} ATR.`),
    engine("RSI Momentum Engine", "Fourteen-period RSI from completed candle log returns.", rsiSignal, rsiValue >= 55 ? "Positive momentum" : rsiValue <= 45 ? "Negative momentum" : "Neutral momentum", `RSI is ${rsiValue.toFixed(1)}.`),
    engine("Directional Movement Engine", "Smoothed directional movement and ADX trend strength.", directionalIndexSignal, plusDi >= minusDi ? "Positive DI pressure" : "Negative DI pressure", `ADX ${adx.toFixed(1)}; +DI ${plusDi.toFixed(1)}; −DI ${minusDi.toFixed(1)}.`),
    engine("Bollinger Mean-Reversion Engine", "Twenty-candle close position within a two-standard-deviation band.", meanReversionSignal, meanReversionSignal > 0.15 ? "Lower-band reversion pressure" : meanReversionSignal < -0.15 ? "Upper-band reversion pressure" : "Mid-band", `Normalized band position is ${bollingerPosition.toFixed(3)}.`),
    engine("Candle Structure Engine", "Most recent completed candle body direction and body-to-range ratio.", candleSignal, candleSignal > 0.1 ? "Bullish candle structure" : candleSignal < -0.1 ? "Bearish candle structure" : "Small-body candle", `Latest completed candle body is ${(candleBodySignal * 100).toFixed(1)}% of its range.`),
    engine("Opening Gap Engine", "Current open relative to the previous completed close, scaled by ATR.", openingGapSignal, openingGapSignal > 0.1 ? "Positive opening gap" : openingGapSignal < -0.1 ? "Negative opening gap" : "No material gap", `Opening gap is ${openingGapAtr.toFixed(3)} ATR.`),
    engine("Return Dependence Engine", "Lag-one autocorrelation of completed candle log returns.", returnAutocorrelation, returnAutocorrelation > 0.1 ? "Positive persistence" : returnAutocorrelation < -0.1 ? "Negative dependence" : "Weak dependence", `Lag-one return autocorrelation is ${returnAutocorrelation.toFixed(3)}.`),
    engine("Volatility Clustering Engine", "Lag-one autocorrelation of squared candle log returns.", volatilityClustering, volatilityClustering > 0.2 ? "Volatility clustering" : "Weak clustering", `Squared-return autocorrelation is ${volatilityClustering.toFixed(3)}; it reduces forecast strength when positive.`),
    engine("Trend Significance Engine", "Linear trend t-statistic for completed candle log returns.", regressionSignal, Math.abs(trendTStatistic) >= 2 ? "Trend evidence" : "Weak trend evidence", `Return trend t-statistic is ${trendTStatistic.toFixed(2)}.`),
    engine("Efficiency Ratio Engine", "Net movement divided by total absolute close-to-close movement.", efficiencyTrendSignal, efficiencyRatio > 0.5 ? "Directional path" : "Choppy path", `Twenty-candle efficiency ratio is ${efficiencyRatio.toFixed(3)}.`),
  ];
  const directionalOpinions = [emaSignal, rsiSignal, directionalIndexSignal, meanReversionSignal, openingGapSignal, candleSignal]
    .filter((value) => Math.abs(value) > 0.08);
  const upVotes = directionalOpinions.filter((value) => value > 0).length;
  const downVotes = directionalOpinions.length - upVotes;
  const agreement = directionalOpinions.length
    ? Math.max(upVotes, downVotes) / directionalOpinions.length
    : 0.5;
  engines.push(engine(
    "Candle Signal Agreement Engine",
    "Measures directional agreement across independent candle feature groups.",
    (agreement - 0.5) * 2,
    agreement > 0.7 ? "Strong directional agreement" : agreement > 0.55 ? "Mixed agreement" : "Conflicting signals",
    `${Math.max(upVotes, downVotes)} of ${directionalOpinions.length} non-neutral directional groups agree.`,
  ));

  return {
    symbol: input.symbol,
    intervalSeconds: input.intervalSeconds,
    candleEpoch: input.candleEpoch,
    openPrice: round(input.openPrice),
    label,
    probability: round(probability),
    confidence: Math.round(clamp(50 + (probability - 0.5) * 85 * support, 50, 94)),
    sampleSize: candles.length,
    effectiveSampleSize: round(effectiveSampleSize, 2),
    detail: `${label} bias is based only on ${candles.length} completed one-minute candles. Current-candle open gap is included; current-candle high, low, and close are excluded to prevent lookahead.`,
    engines,
    features: {
      emaSpreadAtr: round(emaSpreadAtr),
      rsi: round(rsiValue, 2),
      adx: round(adx, 2),
      plusDi: round(plusDi, 2),
      minusDi: round(minusDi, 2),
      atr: round(atr),
      bollingerPosition: round(bollingerPosition, 4),
      returnAutocorrelation: round(returnAutocorrelation, 4),
      volatilityClustering: round(volatilityClustering, 4),
      efficiencyRatio: round(efficiencyRatio, 4),
      openingGapAtr: round(openingGapAtr, 4),
      upCandleRate: round(upCandleRate, 4),
      trendTStatistic: round(trendTStatistic, 3),
    },
    methodNote: "This is a rule-based, sample-size-shrunk directional estimate for the current one-minute candle. Indicator agreement and historical assumptions do not establish a calibrated win probability. The model must be walk-forward tested on candle-open snapshots before real-world reliance.",
  };
}