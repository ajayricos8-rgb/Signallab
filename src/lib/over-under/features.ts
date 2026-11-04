import { clamp, countsOf, entropy, lzComplexity, mean, normalize, variance } from './math.ts';

export type Sequence = { digits: number[]; epochs: number[] };
export type Forecast = { probabilities: number[] | null; support: number; note?: string };
export type EngineFamily = 'markov' | 'frequency' | 'information' | 'streaks' | 'trend' | 'patterns' | 'time-series' | 'ml';
export type FittedEngine = {
  id: string;
  family: EngineFamily;
  label: string;
  predict: (context: Sequence, horizon: number) => Forecast;
};

export const ENGINE_FAMILIES: { id: EngineFamily; title: string; description: string }[] = [
  { id: 'markov', title: 'Markov & hidden regimes', description: '10 × 10 transitions, 2–5 digit n-grams and a fitted two-state categorical HMM.' },
  { id: 'frequency', title: 'Frequency & distribution', description: '100 / 1,000-tick counts, chi-square uniformity and per-digit Z-scores.' },
  { id: 'information', title: 'Entropy & complexity', description: 'Shannon entropy and an LZ78 compressibility estimate condition the forecast and temper the ensemble.' },
  { id: 'streaks', title: 'Run length & streaks', description: 'Observed run-conditioned outcomes, geometric tails and reversal-anomaly flags. No overdue-digit assumption.' },
  { id: 'trend', title: 'Moving averages & momentum', description: 'Digit SMA, EMA and MACD feed a fitted horizon-specific regression, not price-direction guesses.' },
  { id: 'patterns', title: 'Patterns & template filters', description: 'Exact historical subsequences and bounded, built-in digit templates with observed follow-through.' },
  { id: 'time-series', title: 'ARIMA & GARCH', description: 'Training-only ARIMA model selection plus fitted GARCH(1,1) residual variance forecasts.' },
  { id: 'ml', title: 'Local machine learning', description: 'A small LSTM trained with backpropagation and gradient-boosted depth-two classification trees.' },
];

export function emaPath(values: readonly number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  let value = values[0];
  return values.map((next) => (value += alpha * (next - value)));
}

export function trendMetrics(digits: readonly number[]) {
  const recent = digits.slice(-200);
  const fast = emaPath(recent, 12);
  const slow = emaPath(recent, 26);
  const macd = fast.map((value, index) => value - slow[index]);
  const signal = emaPath(macd, 9).at(-1) ?? 0;
  return {
    sma10: mean(recent.slice(-10)), sma50: mean(recent.slice(-50)),
    ema12: fast.at(-1) ?? 0, ema26: slow.at(-1) ?? 0,
    macd: macd.at(-1) ?? 0, signal, histogram: (macd.at(-1) ?? 0) - signal,
    variance50: variance(recent.slice(-50)),
  };
}

export function trendFeatures(digits: readonly number[]): number[] {
  const trend = trendMetrics(digits);
  return [1, trend.sma10 / 9, trend.sma50 / 9, trend.ema12 / 9, trend.ema26 / 9, trend.macd / 9, trend.histogram / 9, (digits.at(-1) ?? 4.5) / 9];
}

export function streakState(digits: readonly number[], barrier: number) {
  const classify = (digit: number) => digit > barrier ? 'over' : digit < barrier ? 'under' : 'equal';
  const side = digits.length ? classify(digits.at(-1)!) : 'equal';
  let length = 0;
  for (let index = digits.length - 1; index >= 0 && classify(digits[index]) === side; index -= 1) length += 1;
  return { side, length };
}

export function streakDiagnostics(digits: readonly number[], barrier: number) {
  const current = streakState(digits, barrier);
  const probability = current.side === 'over' ? (9 - barrier) / 10 : current.side === 'under' ? barrier / 10 : 0.1;
  const expectedLength = 1 / (1 - probability);
  const deviation = Math.sqrt(probability) / (1 - probability);
  const runs: Record<string, number[]> = { over: [], under: [], equal: [] };
  let side = '';
  let length = 0;
  for (const digit of digits) {
    const next = digit > barrier ? 'over' : digit < barrier ? 'under' : 'equal';
    if (next !== side && length) { runs[side].push(length); length = 0; }
    side = next;
    length += 1;
  }
  if (length) runs[side].push(length);
  const tail = probability ** Math.max(0, current.length - 1);
  return {
    barrier, ...current, expectedLength,
    zScore: (current.length - expectedLength) / deviation,
    blockProbability: probability ** current.length,
    tailProbability: tail,
    independentContinuation: probability,
    reversalAnomaly: current.length > 1 && tail < 0.01,
    maxOver: Math.max(0, ...runs.over), maxUnder: Math.max(0, ...runs.under),
    overRuns: runs.over, underRuns: runs.under,
  };
}

export function informationState(digits: readonly number[]): string {
  const recent = digits.slice(-100);
  const h = entropy(normalize(countsOf(recent))) / Math.log2(10);
  const complexity = lzComplexity(recent).ratio;
  return `${h < 0.7 ? 0 : h < 0.93 ? 1 : 2}:${complexity < 0.8 ? 0 : 1}`;
}

export function timeDeltaFeature(epochs: readonly number[], index: number): number {
  if (index < 1) return 0;
  return Math.log1p(clamp(epochs[index] - epochs[index - 1], 0, 60)) / Math.log(61);
}

export function classifierFeatures(context: Sequence): number[] {
  const { digits, epochs } = context;
  const recent = digits.slice(-50);
  const counts = countsOf(recent);
  const streak = streakState(digits, 4);
  const last = digits.at(-1) ?? 0;
  return [
    ...digits.slice(-5).map((digit) => digit / 9),
    ...Array.from({ length: 10 }, (_, digit) => Number(last === digit)),
    ...trendFeatures(digits).slice(1),
    entropy(normalize(counts)) / Math.log2(10),
    lzComplexity(recent).ratio,
    Math.min(streak.length, 20) / 20,
    Number(streak.side === 'over'),
    Math.sqrt(variance(recent)) / 4.5,
    timeDeltaFeature(epochs, epochs.length - 1),
    ...counts.map((count) => count / Math.max(1, recent.length)),
  ];
}

export function prefix(sequence: Sequence, endExclusive: number): Sequence {
  return { digits: sequence.digits.slice(0, endExclusive), epochs: sequence.epochs.slice(0, endExclusive) };
}
