// AI-assisted analysis: synthesizes deterministic engine outputs into a
// human-readable verdict. (No external LLM; rule-based synthesis.)

export type Insight = { verdict: string; bullets: string[]; risk: string };

export function riseFallInsight(m: any): Insight {
  const bullets: string[] = [];
  if (m.hurst > 0.55) bullets.push(`Hurst ${m.hurst.toFixed(2)} suggests trending regime.`);
  else if (m.hurst < 0.45) bullets.push(`Hurst ${m.hurst.toFixed(2)} suggests mean-reverting regime.`);
  else bullets.push(`Hurst ${m.hurst.toFixed(2)} near random walk.`);
  if (m.fractalDimension < 1.3) bullets.push('Smooth price path (low fractal dimension).');
  else if (m.fractalDimension > 1.7) bullets.push('Jagged/choppy price path (high fractal dimension).');
  bullets.push(`RSI ${m.rsi.toFixed(1)}, imbalance ${(m.imbalance * 100).toFixed(1)}%.`);
  bullets.push(`Markov P(rise|1 up) ${(m.markovTrend.pRiseGiven1 * 100).toFixed(1)}%.`);
  const verdict = m.trendBias > 0.3 ? 'Bullish bias' : m.trendBias < -0.3 ? 'Bearish bias' : 'Neutral';
  return { verdict, bullets, risk: 'Synthetic indices can shift regime abruptly; treat as research only.' };
}

export function evenOddInsight(m: any): Insight {
  const bullets: string[] = [];
  bullets.push(`Even ${(m.parityProportion100.even * 100).toFixed(1)}% vs Odd ${(m.parityProportion100.odd * 100).toFixed(1)}% (N=100).`);
  bullets.push(`Chi-square ${m.chiSquare.toFixed(2)} (p ${m.chiSquareP === null ? 'n/a' : m.chiSquareP.toFixed(3)}).`);
  bullets.push(`Current streak: ${m.currentStreak.parity} x${m.currentStreak.length}.`);
  bullets.push(`Alternation ratio ${(m.alternationRatio * 100).toFixed(1)}%.`);
  bullets.push(`Wald-Wolfowitz z ${m.waldWolfowitz.z.toFixed(2)} (p ${m.waldWolfowitz.p.toFixed(3)}).`);
  const verdict = Math.abs(m.parityProportion100.even - 0.5) > 0.05 ? (m.parityProportion100.even > 0.5 ? 'Even bias detected' : 'Odd bias detected') : 'No significant parity bias';
  return { verdict, bullets, risk: 'Short-term clustering is not a guarantee; independence assumptions may fail.' };
}

export function overUnderInsight(m: any): Insight {
  const bullets: string[] = [];
  const maxDev = Math.max(...m.zScores.map((z: number) => Math.abs(z)));
  const maxDigit = m.zScores.reduce((best: number, z: number, i: number) => Math.abs(z) > Math.abs(m.zScores[best]) ? i : best, 0);
  bullets.push(`Shannon entropy ${m.shannonEntropy.toFixed(3)} bits (norm ${m.normalizedEntropy.toFixed(3)}).`);
  bullets.push(`Max digit z-score: digit ${maxDigit} = ${m.zScores[maxDigit].toFixed(2)}.`);
  bullets.push(`Chi-square ${m.chiSquare.toFixed(2)} (p ${m.chiSquareP === null ? 'n/a' : m.chiSquareP.toFixed(3)}).`);
  const verdict = maxDev > 2 ? `Digit ${maxDigit} significantly deviated` : 'No significant digit deviation';
  return { verdict, bullets, risk: 'Multiple testing; deviations may be noise.' };
}

export function matchesInsight(m: any): Insight {
  const bullets: string[] = [];
  const maxDroughtDigit = m.drought.reduce((best: number, v: number, i: number) => v > m.drought[best] ? i : best, 0);
  bullets.push(`Longest current drought: digit ${maxDroughtDigit} = ${m.drought[maxDroughtDigit]} ticks.`);
  bullets.push(`Permutation entropy ${m.permutationEntropy.toFixed(3)} (0 deterministic, 1 random).`);
  bullets.push(`Top FFT peaks: ${m.fftPeaks.map((p: any) => `${p.freq.toFixed(3)}(${p.magnitude.toFixed(2)})`).join(', ')}.`);
  bullets.push(`Max autocorrelation lag1 ${m.autocorrelation[0]?.toFixed(3) ?? 'n/a'}.`);
  const verdict = m.permutationEntropy < 0.5 ? 'Deterministic-ish pattern detected' : 'Noisy/random-like';
  return { verdict, bullets, risk: 'Drought does not imply due; generator may be memoryless.' };
}
