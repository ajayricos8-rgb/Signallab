// Digit engine councils: every fitted research engine plus the rule-based AI
// synthesis layer casts one vote per analysis, so each completed scan can show
// how many engines agree with the emitted signal and how confident it is.
import { evaluateHistoricalContract, type DigitAnalysis, type DigitObservation } from './digit-analysis.ts';
import type { EngineVote } from './engine-consensus.ts';
import { analyzeEvenOdd } from './quant/even-odd.ts';
import { analyzeMatches } from './quant/matches.ts';
import { analyzeOverUnder } from './quant/over-under.ts';
import { evenOddInsight, matchesInsight, overUnderInsight } from './quant/ai-insights.ts';
import { contractProbability, type OverUnderContract, type OverUnderReport } from './over-under/ensemble.ts';

const EVEN = 'EVEN';
const ODD = 'ODD';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function paritySide(evenShare: number): string {
  return evenShare >= 0.5 ? EVEN : ODD;
}

function windowParityVote(id: string, label: string, evenRate: number | null, sample: number): EngineVote | null {
  if (evenRate === null || sample < 10) return null;
  return {
    id, label,
    side: paritySide(evenRate),
    strength: clamp01(Math.abs(evenRate - 0.5) * 4 + 0.15),
    note: `${(evenRate * 100).toFixed(1)}% even over the last ${sample} digits`,
  };
}

/**
 * Twelve independent even/odd engines: rolling parity balance, smoothed
 * frequencies, Markov parity and digit transitions, higher-order parity
 * contexts, run statistics, chi-square tilt, conditioned historical outcomes
 * and the AI synthesis verdict.
 */
export function evenOddCouncil(
  analysis: DigitAnalysis,
  observations: DigitObservation[],
  durationTicks: number,
): EngineVote[] {
  const digits = observations.map((tick) => tick.digit);
  const last = digits.at(-1) ?? null;
  const currentParity = last === null ? null : (last % 2) as 0 | 1;
  const votes: EngineVote[] = [];
  const push = (vote: EngineVote | null) => { if (vote) votes.push(vote); };

  for (const window of analysis.windows) {
    if (window.window === 50 || window.window === 100 || window.window === 500) {
      push(windowParityVote(`parity-${window.window}`, `Parity balance · ${window.window} ticks`, window.evenRate, window.sample));
    }
  }

  const weightedEven = analysis.weightedFrequencies.reduce<number>((sum, frequency, digit) => sum + (digit % 2 === 0 ? (frequency ?? 0) : 0), 0);
  push({
    id: 'weighted-frequency', label: 'Exponentially weighted digits',
    side: paritySide(weightedEven), strength: clamp01(Math.abs(weightedEven - 0.5) * 4 + 0.15),
    note: `${(weightedEven * 100).toFixed(1)}% even after recency weighting`,
  });

  if (currentParity !== null) {
    const row = analysis.parityTransitions[currentParity];
    const total = row[0] + row[1];
    if (total >= 10) {
      const stayRate = row[currentParity] / total;
      push({
        id: 'markov-parity', label: 'Parity Markov chain',
        side: stayRate >= 0.5 ? (currentParity === 0 ? EVEN : ODD) : (currentParity === 0 ? ODD : EVEN),
        strength: clamp01(Math.abs(stayRate - 0.5) * 3 + 0.15),
        note: `P(parity stays | ${currentParity === 0 ? 'even' : 'odd'}) = ${(stayRate * 100).toFixed(1)}%`,
      });
    }
    if (last !== null) {
      const digitRow = analysis.transitionProbabilities[last];
      const sample = analysis.transitionCounts[last].reduce((sum, count) => sum + count, 0);
      const known = digitRow.filter((value): value is number => value !== null);
      if (sample >= 10 && known.length === 10) {
        const evenShare = known.reduce((sum, probability, digit) => sum + (digit % 2 === 0 ? probability : 0), 0);
        push({
          id: 'transition-row', label: 'Digit transition row',
          side: paritySide(evenShare), strength: clamp01(Math.abs(evenShare - 0.5) * 4 + 0.15),
          note: `Next-digit transitions from ${last} put ${(evenShare * 100).toFixed(1)}% mass on even`,
        });
      }
    }
  }

  const quantParity = analyzeEvenOdd(digits);
  for (const order of [3, 2]) {
    const context = digits.slice(-order).map((digit) => (digit % 2 === 0 ? 'E' : 'O')).join('');
    const row = quantParity.higherOrder[`${order}:${context}`];
    if (row && row.total >= 12) {
      const evenShare = row.even / row.total;
      push({
        id: `higher-order-${order}`, label: `Higher-order parity · order ${order}`,
        side: paritySide(evenShare), strength: clamp01(Math.abs(evenShare - 0.5) * 3 + 0.15),
        note: `After ${context}: ${(evenShare * 100).toFixed(1)}% even across ${row.total} matches`,
      });
      break;
    }
  }

  const { z } = quantParity.waldWolfowitz;
  if (Math.abs(z) >= 0.5 && currentParity !== null) {
    push({
      id: 'runs-test', label: 'Wald–Wolfowitz runs test',
      side: z < 0 ? (currentParity === 0 ? EVEN : ODD) : (currentParity === 0 ? ODD : EVEN),
      strength: clamp01(Math.abs(z) / 2.5 * 0.8 + 0.1),
      note: `Runs z ${z.toFixed(2)} · ${z < 0 ? 'clustering favors parity continuation' : 'extra alternation favors a parity flip'}`,
    });
  }

  const alternationShift = (quantParity.alternationRatio - 0.5) * 2;
  if (Math.abs(alternationShift) >= 0.08 && currentParity !== null) {
    push({
      id: 'streak-alternation', label: 'Run length & alternation',
      side: alternationShift < 0 ? (currentParity === 0 ? EVEN : ODD) : (currentParity === 0 ? ODD : EVEN),
      strength: clamp01(Math.abs(alternationShift) * 1.6 + 0.1),
      note: `Alternation ratio ${(quantParity.alternationRatio * 100).toFixed(1)}% · current ${quantParity.currentStreak.parity} run × ${quantParity.currentStreak.length}`,
    });
  }

  const n = analysis.sampleSize;
  if (n >= 50) {
    const tilt = (analysis.parityCounts[0] - analysis.parityCounts[1]) / Math.sqrt(n);
    push({
      id: 'chi-tilt', label: 'Parity chi-square tilt',
      side: tilt >= 0 ? EVEN : ODD, strength: clamp01(Math.abs(tilt) / 2.5 * 0.8 + 0.1),
      note: `Parity imbalance z ${tilt.toFixed(2)} over ${n} digits`,
    });
  }

  if (durationTicks >= 1 && last !== null && n >= 200) {
    const evenOutcomes = evaluateHistoricalContract(observations, { family: 'even-odd', contractType: 'DIGITEVEN' }, durationTicks, { parity: currentParity ?? undefined });
    const oddOutcomes = evaluateHistoricalContract(observations, { family: 'even-odd', contractType: 'DIGITODD' }, durationTicks, { parity: currentParity ?? undefined });
    const evenRate = evenOutcomes.smoothedHistoricalHitRate;
    const oddRate = oddOutcomes.smoothedHistoricalHitRate;
    if (evenRate !== null && oddRate !== null && evenOutcomes.sample >= 30) {
      push({
        id: 'conditional-history', label: 'Conditioned historical outcomes',
        side: evenRate >= oddRate ? EVEN : ODD,
        strength: clamp01(Math.abs(evenRate - oddRate) * 4 + 0.15),
        note: `${(evenRate * 100).toFixed(1)}% even vs ${(oddRate * 100).toFixed(1)}% odd over ${evenOutcomes.sample} conditioned outcomes`,
      });
    }
  }

  const insight = evenOddInsight(quantParity);
  const insightSide = insight.verdict.startsWith('Even bias') ? EVEN : insight.verdict.startsWith('Odd bias') ? ODD : paritySide(quantParity.parityProportion100.even);
  push({
    id: 'ai-synthesis', label: 'AI synthesis layer',
    side: insightSide,
    strength: insight.verdict.startsWith('No significant') ? 0.2 : 0.55,
    note: insight.verdict,
  });

  return votes;
}

function argmax10(probabilities: readonly number[]): { digit: number; margin: number } {
  let best = 0;
  for (let digit = 1; digit < 10; digit += 1) if (probabilities[digit] > probabilities[best]) best = digit;
  const sorted = [...probabilities].sort((left, right) => right - left);
  return { digit: best, margin: clamp01((sorted[0] - sorted[1]) * 6) };
}

function digitVote(id: string, label: string, probabilities: readonly number[], note: string): EngineVote | null {
  const usable = probabilities.every((value) => Number.isFinite(value) && value >= 0);
  if (!usable) return null;
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const normalized = probabilities.map((value) => value / total);
  const { digit, margin } = argmax10(normalized);
  return { id, label, side: `MATCH ${digit}`, strength: clamp01(0.15 + margin + (normalized[digit] - 0.1) * 1.5), note };
}

/**
 * Twelve matches engines each pick their most likely next final digit (0–9),
 * from smoothed frequencies, transition rows, n-gram contexts, KDE density,
 * pattern follow-through, run continuation, two-step Markov, conditioned
 * historical outcomes, frequency momentum and the AI synthesis layer.
 */
export function matchesCouncil(
  analysis: DigitAnalysis,
  observations: DigitObservation[],
  durationTicks: number,
): EngineVote[] {
  const digits = observations.map((tick) => tick.digit);
  const votes: EngineVote[] = [];
  const push = (vote: EngineVote | null) => { if (vote) votes.push(vote); };

  const smoothed = analysis.digitCounts.map((count) => (count + 0.5) / (analysis.sampleSize + 5));
  push(digitVote('smoothed-frequency', 'Smoothed full-history frequency', smoothed, 'Dirichlet-smoothed digit base rates'));

  for (const window of analysis.windows) {
    if (window.window === 500 || window.window === 100) {
      push(digitVote(`frequency-${window.window}`, `Frequency · ${window.window} ticks`, window.counts.map((count) => count / Math.max(1, window.sample)), `Rolling ${window.window}-tick digit distribution`));
    }
  }

  push(digitVote('weighted-frequency', 'Exponentially weighted digits', analysis.weightedFrequencies.map((frequency) => frequency ?? 0), 'Recency-weighted digit distribution'));

  const last = digits.at(-1) ?? null;
  if (last !== null) {
    const rowCounts = analysis.transitionCounts[last];
    const rowTotal = rowCounts.reduce((sum, count) => sum + count, 0);
    if (rowTotal >= 10) {
      push(digitVote('markov-row', 'Markov transition row', rowCounts.map((count) => (count + 0.5) / (rowTotal + 5)), `Next-digit distribution after ${last}`));
    }
    const secondLast = digits.at(-2) ?? null;
    if (secondLast !== null) {
      const firstStep = analysis.transitionCounts[secondLast];
      const firstTotal = firstStep.reduce((sum, count) => sum + count, 0);
      if (firstTotal >= 10) {
        const twoStep = Array.from({ length: 10 }, (_, target) => {
          let mass = 0;
          for (let middle = 0; middle < 10; middle += 1) {
            const middleTotal = analysis.transitionCounts[middle].reduce((sum, count) => sum + count, 0);
            mass += (firstStep[middle] / firstTotal) * ((analysis.transitionCounts[middle][target] + 0.5) / (middleTotal + 5));
          }
          return mass;
        });
        push(digitVote('markov-two-step', 'Two-step Markov', twoStep, `Propagated transitions through ${secondLast} → ${last}`));
      }
    }
  }

  // Longest trailing context with enough observed support.
  for (const order of [3, 2, 1]) {
    const context = digits.slice(-order);
    const successors = Array.from({ length: 10 }, () => 0);
    let matches = 0;
    for (let index = order; index < digits.length; index += 1) {
      let hit = true;
      for (let offset = 0; offset < order; offset += 1) {
        if (digits[index - order + offset] !== context[offset]) { hit = false; break; }
      }
      if (hit) { successors[digits[index]] += 1; matches += 1; }
    }
    if (matches >= 8) {
      push(digitVote('ngram-context', `N-gram context · order ${order}`, successors.map((count) => (count + 0.5) / (matches + 5)), `${matches} historical matches for the trailing ${order}-digit context`));
      break;
    }
  }

  const quantOver = analyzeOverUnder(digits);
  push(digitVote('kde-density', 'Kernel density estimate', quantOver.kde, 'Gaussian KDE over recent digit positions'));

  const quantMatches = analyzeMatches(digits);
  const followThrough = Array.from({ length: 10 }, () => 0);
  let followTotal = 0;
  for (const { pattern, count } of quantMatches.higherOrderPatterns) {
    if (pattern.length === 3 && pattern[0] === String(digits.at(-2)) && pattern[1] === String(digits.at(-1))) {
      followThrough[Number(pattern[2])] += count;
      followTotal += count;
    }
  }
  if (followTotal >= 6) {
    push(digitVote('pattern-followthrough', 'Pattern follow-through', followThrough.map((count) => (count + 0.5) / (followTotal + 5)), `${followTotal} matching 3-digit patterns in history`));
  }

  if (last !== null) {
    const continuation = Array.from({ length: 10 }, () => 0.05);
    let run = 0;
    for (let index = digits.length - 1; index >= 0 && digits[index] === last; index -= 1) run += 1;
    const repeatRate = analysis.transitionCounts[last][last] / Math.max(1, analysis.transitionCounts[last].reduce((sum, count) => sum + count, 0));
    continuation[last] += repeatRate * 4;
    for (let digit = 0; digit < 10; digit += 1) if (digit !== last) continuation[digit] += (1 - repeatRate) / 9 * 4;
    push(digitVote('run-continuation', 'Run continuation statistics', continuation, `Digit ${last} repeats at ${(repeatRate * 100).toFixed(1)}% after itself · current run × ${run}`));
  }

  if (durationTicks >= 1 && last !== null && analysis.sampleSize >= 200) {
    const rates: number[] = [];
    let sample = 0;
    for (let targetDigit = 0; targetDigit < 10; targetDigit += 1) {
      const outcomes = evaluateHistoricalContract(observations, { family: 'matches', contractType: 'DIGITMATCH', targetDigit }, durationTicks, { digit: last });
      rates.push(outcomes.smoothedHistoricalHitRate ?? 0);
      sample = outcomes.sample;
    }
    if (sample >= 30) {
      push(digitVote('conditional-history', 'Conditioned historical outcomes', rates, `${sample} outcomes conditioned on starting digit ${last}`));
    }
  }

  const momentum = analysis.windows
    .filter((window) => window.window === 100 || window.window === 500)
    .map((window) => window.frequencies.map((frequency) => frequency ?? 0));
  if (momentum.length === 2) {
    const rising = momentum[0].map((frequency, digit) => frequency - momentum[1][digit]);
    const base = smoothed.map((value) => value * 5);
    push(digitVote('frequency-momentum', 'Frequency momentum', base.map((value, digit) => Math.max(0.001, value + rising[digit] * 8)), 'Digit share rising fastest versus the longer window'));
  }

  const insight = matchesInsight(quantMatches);
  push({
    id: 'ai-synthesis', label: 'AI synthesis layer',
    side: `MATCH ${argmax10(smoothed).digit}`,
    strength: insight.verdict.startsWith('Deterministic') ? 0.6 : 0.3,
    note: insight.verdict,
  });

  return votes;
}

/**
 * Votes from the twelve fitted over/under models for one contract: a model
 * supports the contract when its own forecast beats its own rolling baseline.
 */
export function overUnderCouncil(report: OverUnderReport, contract: OverUnderContract): EngineVote[] {
  const baselineProbability = contractProbability(report.baselineProbabilities, contract);
  return report.engines.map((engine) => {
    const label = `${contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${contract.barrier}`;
    if (!engine.probabilities) {
      return {
        id: engine.id, label: engine.label, side: `ABSTAIN ${label}`,
        strength: 0, note: 'This engine abstained on the current context.',
      };
    }
    const probability = contractProbability(engine.probabilities, contract);
    const delta = probability - baselineProbability;
    return {
      id: engine.id,
      label: engine.label,
      side: delta >= 0 ? label : `OPPOSE ${label}`,
      strength: clamp01(Math.abs(delta) * 8 + 0.1),
      note: `Estimate ${(probability * 100).toFixed(1)}% vs ${(baselineProbability * 100).toFixed(1)}% rolling baseline`,
    };
  }).filter((vote) => !vote.side.startsWith('ABSTAIN'));
}

/** The AI synthesis layer's read of the current over/under distribution. */
export function overUnderAiVote(report: OverUnderReport, contract: OverUnderContract): EngineVote {
  const insight = overUnderInsight({
    zScores: report.diagnostics.windows[1].zScores,
    shannonEntropy: report.diagnostics.windows[1].entropyBits,
    normalizedEntropy: report.diagnostics.windows[1].normalizedEntropy,
    chiSquare: report.diagnostics.windows[1].chiSquare,
    chiSquareP: report.diagnostics.windows[1].chiSquareP,
  });
  const probability = contractProbability(report.probabilities, contract);
  const baselineProbability = contractProbability(report.baselineProbabilities, contract);
  return {
    id: 'ai-synthesis', label: 'AI synthesis layer',
    side: probability >= baselineProbability ? `${contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${contract.barrier}` : `OPPOSE ${contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${contract.barrier}`,
    strength: insight.verdict.startsWith('No significant') ? 0.3 : 0.6,
    note: insight.verdict,
  };
}
