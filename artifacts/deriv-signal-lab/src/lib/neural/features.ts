// Causal feature builders for the embedded neural model.
//
// Every vector here is computed from ticks at or before `index` only, so a row
// can be replayed, split chronologically and validated without look-ahead. The
// features are the same quantities the analysis engines measure — recent
// digits, hot/cold counts, parity, streaks, entropy, momentum, volatility,
// RSI and price position — handed to the network as one flat vector so it can
// learn interactions a linear blend cannot express.

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Digits of recent history the digit vector looks at. */
export const DIGIT_FEATURE_WINDOW = 300;
/** Recent digits one-hot encoded in the vector. */
const DIGIT_CONTEXT = 8;
/** Ticks of price history the rise/fall vector looks at. */
export const QUOTE_FEATURE_WINDOW = 60;

export const DIGIT_FEATURE_COUNT = DIGIT_CONTEXT * 10 + 10 + 10 + 10 + 3;
export const QUOTE_FEATURE_COUNT = 5 + 5 + 3 + 1 + 1 + 1 + 1 + 1 + 1 + 1;

function entropy(counts: readonly number[], total: number): number {
  if (total <= 0) return 0;
  let value = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const share = count / total;
    value -= share * Math.log(share);
  }
  return value === 0 ? 0 : value / Math.log(counts.length);
}

function countsOf(digits: readonly number[]): number[] {
  const counts = Array<number>(10).fill(0);
  for (const digit of digits) if (digit >= 0 && digit <= 9) counts[digit] += 1;
  return counts;
}

/**
 * Features for predicting the digit that follows `index`.
 * Returns null when there is not enough history yet.
 */
export function digitFeatures(digits: readonly number[], index: number): Float64Array | null {
  if (!Number.isInteger(index) || index < DIGIT_FEATURE_WINDOW - 1 || index >= digits.length) return null;
  const features = new Float64Array(DIGIT_FEATURE_COUNT);
  let cursor = 0;
  // 1. One-hot of the last DIGIT_CONTEXT digits (most recent first).
  for (let lag = 1; lag <= DIGIT_CONTEXT; lag += 1) {
    const digit = digits[index - lag + 1];
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) return null;
    features[cursor + digit] = 1;
    cursor += 10;
  }
  // 2. Gap since each digit last appeared, capped at 50 ticks.
  const lastSeen = Array<number>(10).fill(index + 1);
  for (let position = index; position >= 0 && index - position < 50; position -= 1) {
    const digit = digits[position];
    if (digit >= 0 && digit <= 9 && lastSeen[digit] === index + 1) lastSeen[digit] = position;
  }
  for (let digit = 0; digit < 10; digit += 1) {
    features[cursor + digit] = clamp((index - lastSeen[digit]) / 50, 0, 1);
  }
  cursor += 10;
  // 3. Hot/cold z-scores over the last 100 and 300 digits.
  for (const window of [100, DIGIT_FEATURE_WINDOW]) {
    const slice = digits.slice(Math.max(0, index - window + 1), index + 1);
    const counts = countsOf(slice);
    const expected = slice.length / 10;
    const deviation = Math.sqrt(slice.length * 0.09) || 1;
    for (let digit = 0; digit < 10; digit += 1) {
      features[cursor + digit] = clamp((counts[digit] - expected) / deviation / 3, -1, 1);
    }
    cursor += 10;
  }
  // 4. Parity share over the last 50, signed around a fair half.
  const paritySlice = digits.slice(Math.max(0, index - 49), index + 1);
  let even = 0;
  for (const digit of paritySlice) if (digit % 2 === 0) even += 1;
  features[cursor] = clamp(((even / Math.max(1, paritySlice.length)) - 0.5) * 4, -1, 1);
  cursor += 1;
  // 5. Signed run length of the current parity streak (positive = even).
  const parity = digits[index] % 2;
  let streak = 0;
  for (let position = index; position >= 0 && digits[position] % 2 === parity; position -= 1) streak += 1;
  features[cursor] = clamp(streak / 10, 0, 1) * (parity === 0 ? 1 : -1);
  cursor += 1;
  // 6. Normalised entropy of the last 100 digits.
  const entropySlice = digits.slice(Math.max(0, index - 99), index + 1);
  features[cursor] = entropy(countsOf(entropySlice), entropySlice.length);
  return features;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function stdev(values: readonly number[], average = mean(values)): number {
  if (values.length < 2) return 0;
  let total = 0;
  for (const value of values) total += (value - average) ** 2;
  return Math.sqrt(total / values.length);
}

/**
 * Features for the direction of the move that starts at `index` (resolved
 * later by the horizon's exit tick). Uses only ticks up to and including
 * `index`.
 */
export function quoteFeatures(prices: readonly number[], index: number): Float64Array | null {
  if (!Number.isInteger(index) || index < QUOTE_FEATURE_WINDOW || index >= prices.length) return null;
  const price = prices[index];
  if (!Number.isFinite(price) || price <= 0) return null;
  const returns: number[] = [];
  for (let position = index - QUOTE_FEATURE_WINDOW + 1; position <= index; position += 1) {
    const previous = prices[position - 1];
    const current = prices[position];
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) return null;
    returns.push(current / previous - 1);
  }
  const latest = returns.slice(-10);
  const scale = Math.max(1e-9, stdev(returns.slice(-50)));
  const features = new Float64Array(QUOTE_FEATURE_COUNT);
  let cursor = 0;
  // 1. The last five returns, noise-scaled.
  for (let lag = 1; lag <= 5; lag += 1) {
    features[cursor] = clamp(returns[returns.length - lag] / scale, -3, 3) / 3;
    cursor += 1;
  }
  // 2. Signs of those returns.
  for (let lag = 1; lag <= 5; lag += 1) {
    const value = returns[returns.length - lag];
    features[cursor] = Math.abs(value) < 1e-12 ? 0 : Math.sign(value);
    cursor += 1;
  }
  // 3. Price position against its moving average, in local deviations.
  for (const window of [10, 25, 60]) {
    const slice = prices.slice(Math.max(0, index - window + 1), index + 1);
    const average = mean(slice);
    const deviation = stdev(slice, average) || 1;
    features[cursor] = clamp((price - average) / deviation, -3, 3) / 3;
    cursor += 1;
  }
  // 4. Volatility expansion/contraction.
  const shortVol = stdev(returns.slice(-10));
  const longVol = stdev(returns.slice(-50));
  features[cursor] = clamp(longVol > 1e-12 ? shortVol / longVol - 1 : 0, -1, 1);
  cursor += 1;
  // 5. Share of up moves in the last 20.
  const recent = returns.slice(-20);
  features[cursor] = clamp((recent.filter((value) => value > 0).length / Math.max(1, recent.length) - 0.5) * 4, -1, 1);
  cursor += 1;
  // 6. Signed run of consecutive up/down moves.
  let streak = 0;
  const lastSign = Math.sign(returns[returns.length - 1]);
  for (let position = returns.length - 1; position >= 0 && Math.sign(returns[position]) === lastSign && lastSign !== 0; position -= 1) streak += 1;
  features[cursor] = clamp(streak / 8, 0, 1) * lastSign;
  cursor += 1;
  // 7. RSI(14) centred on 50.
  const rsiSlice = returns.slice(-14);
  let gains = 0;
  let losses = 0;
  for (const value of rsiSlice) {
    if (value > 0) gains += value; else losses -= value;
  }
  const total = gains + losses;
  const rsi = total > 0 ? gains / total : 0.5;
  features[cursor] = clamp((rsi - 0.5) * 2, -1, 1);
  cursor += 1;
  // 8. Mean recent return in standard errors.
  const average = mean(latest);
  const standard = stdev(latest) || 1;
  features[cursor] = clamp((average / standard) * Math.sqrt(latest.length), -3, 3) / 3;
  cursor += 1;
  // 9. Bollinger position of the latest price.
  const bollinger = prices.slice(Math.max(0, index - 19), index + 1);
  const bollingerMean = mean(bollinger);
  const bollingerDeviation = stdev(bollinger, bollingerMean) || 1;
  features[cursor] = clamp((price - bollingerMean) / (2 * bollingerDeviation), -1, 1);
  return features;
}

/** Convenience: the digit vector for the next (unseen) tick. */
export function liveDigitFeatures(digits: readonly number[]): Float64Array | null {
  return digitFeatures(digits, digits.length - 1);
}

/** Convenience: the quote vector for the next (unseen) move. */
export function liveQuoteFeatures(prices: readonly number[]): Float64Array | null {
  return quoteFeatures(prices, prices.length - 1);
}
