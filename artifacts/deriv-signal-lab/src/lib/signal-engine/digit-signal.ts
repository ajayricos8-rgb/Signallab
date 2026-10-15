// Always-on digit signal layer for Over/Under, Even/Odd and Matches.
//
// Every analysis fits the full 12-engine digit ensemble (Markov, n-gram, HMM,
// frequency, entropy, streaks, trend, patterns, ARIMA, GARCH, LSTM and
// gradient boosting) on the market's own ticks, then:
//   1. removes each engine's structural shape bias (measured on the tuning
//      window against the rolling-frequency baseline),
//   2. lets every engine vote for or against each contract versus its fair
//      probability,
//   3. replays the same consensus rule on held-out ticks (backtest), and
//   4. returns the contract with the highest confidence — always a signal,
//      never a blocked state. The strict research gates remain available as a
//      "verified edge" flag and in the research report.
import { evaluateHistoricalContract, type DigitContractCandidate, type DigitObservation } from '../digit-analysis.ts';
import { candidateLabel } from '../digit-signals.ts';
import {
  buildEnsembleReport, contractWins, fitDigitEnsemble, scoreDigitCandidates,
  type DigitEnsembleFit, type DigitEnsembleReport, type EnsembleProgress,
} from '../over-under/ensemble.ts';
import type { Forecast } from '../over-under/features.ts';
import {
  confidenceScore, edgeShrinkage, strengthOf, summarizeBacktest, tallyVotes,
  type BacktestSummary, type ConfidenceBreakdown, type EngineVote, type SignalStrength, type VoteTally,
} from './confidence.ts';

export type DigitSignalFamily = 'over-under' | 'even-odd' | 'matches';
export type DigitTick = { epoch: number; digit: number };

export const DIGIT_SIGNAL_MIN_TICKS = 500;

/** The contracts each digit tool scans. Over/Under stays in the 1–8 research domain. */
export const DIGIT_SIGNAL_CONTRACTS: Record<DigitSignalFamily, DigitContractCandidate[]> = {
  'over-under': (['DIGITOVER', 'DIGITUNDER'] as const).flatMap((contractType) =>
    [1, 2, 3, 4, 5, 6, 7, 8].map((barrier) => ({ family: 'over-under' as const, contractType, barrier }))),
  'even-odd': [
    { family: 'even-odd', contractType: 'DIGITEVEN' },
    { family: 'even-odd', contractType: 'DIGITODD' },
  ],
  matches: Array.from({ length: 10 }, (_, targetDigit) => ({ family: 'matches' as const, contractType: 'DIGITMATCH' as const, targetDigit })),
};

export type DigitContractSignal = {
  contract: DigitContractCandidate;
  label: string;
  /** Consensus estimate of the win probability (bias-corrected, 0–1). */
  probability: number;
  /** Win probability with no edge (uniform digits). */
  fairProbability: number;
  edge: number;
  edgeRatio: number;
  votes: EngineVote[];
  tally: VoteTally;
  backtest: BacktestSummary;
  /** Held-out Brier skill of the consensus versus the fair probability. */
  validationSkill: number | null;
  /** All strict research gates passed for this contract. */
  verified: boolean;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  strength: SignalStrength;
  /** Historical outcomes after the current digit (or parity) context. */
  history: { sample: number; hits: number; rate: number | null; context: string } | null;
};

export type DigitMarketAnalysis = {
  kind: 'digit';
  family: DigitSignalFamily;
  symbol: string;
  name: string;
  horizon: number;
  sample: number;
  lastDigit: number | null;
  asOfEpoch: number;
  fresh: boolean;
  dataQuality: number;
  structure: 'stable' | 'shifted' | 'insufficient';
  engineCount: number;
  best: DigitContractSignal;
  contracts: DigitContractSignal[];
  report: DigitEnsembleReport;
  notes: string[];
  durationMs: number;
};

export type DigitMarketInput = {
  family: DigitSignalFamily;
  symbol: string;
  name: string;
  horizon: number;
  ticks: readonly DigitTick[];
  fresh: boolean;
  /** Optional subset (for example, only barriers Deriv reported). */
  contracts?: readonly DigitContractCandidate[];
  /** Markets competing in the same scan (for the selection penalty). */
  marketsInScan?: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Win probability of a contract under a ten-digit distribution. */
export function digitContractProbability(distribution: readonly number[], contract: DigitContractCandidate): number {
  let total = 0;
  for (let digit = 0; digit < 10; digit += 1) if (contractWins(contract, digit)) total += distribution[digit] ?? 0;
  return total;
}

export function fairProbability(contract: DigitContractCandidate): number {
  if (contract.family === 'over-under') return contract.contractType === 'DIGITOVER' ? (9 - contract.barrier) / 10 : contract.barrier / 10;
  if (contract.family === 'even-odd') return 0.5;
  return 0.1;
}

/** Vote dead-band: a fraction of the outcome's standard deviation. */
export function voteMargin(fair: number): number {
  return 0.005 * Math.sqrt(fair * (1 - fair));
}

function contractOrder(contract: DigitContractCandidate): number {
  if (contract.family === 'over-under') return (contract.contractType === 'DIGITOVER' ? 0 : 10) + contract.barrier;
  if (contract.family === 'even-odd') return contract.contractType === 'DIGITEVEN' ? 0 : 1;
  return contract.targetDigit;
}

function digitContractKey(contract: DigitContractCandidate): string {
  if (contract.family === 'over-under') return `${contract.contractType}:${contract.barrier}`;
  if (contract.family === 'matches') return `${contract.contractType}:${contract.targetDigit}`;
  return contract.contractType;
}

/**
 * Contract-level engine weight: every engine starts with an equal vote, scaled
 * by exp(30 × skill) (bounded 0.25–4), where skill is the engine's binary Brier
 * skill for THIS contract on the tuning window versus the rolling-frequency
 * baseline. On noise all skills sit near zero and the vote stays democratic;
 * an engine with proven out-of-sample value for the contract leads it.
 */
export function skillFactor(skill: number | null): number {
  return skill === null ? 1 : clamp(Math.exp(30 * skill), 0.25, 4);
}

function dataQuality(sample: number, fresh: boolean, structure: string): number {
  const sampleFactor = 0.85 + 0.15 * clamp((sample - DIGIT_SIGNAL_MIN_TICKS) / 1_500, 0, 1);
  const freshFactor = fresh ? 1 : 0.85;
  const structureFactor = structure === 'stable' ? 1 : structure === 'shifted' ? 0.9 : 0.95;
  return sampleFactor * freshFactor * structureFactor;
}

function historyContext(family: DigitSignalFamily, lastDigit: number | null): { digit?: number; parity?: 0 | 1 } | null {
  if (lastDigit === null) return null;
  return family === 'even-odd' ? { parity: (lastDigit % 2) as 0 | 1 } : { digit: lastDigit };
}

/** Full single-market digit analysis. Throws only for unusable input. */
export function analyzeDigitMarket(input: DigitMarketInput, onProgress?: EnsembleProgress): DigitMarketAnalysis {
  const started = Date.now();
  if (!Number.isInteger(input.horizon) || input.horizon < 1 || input.horizon > 10) throw new Error('Digit signals use a tick duration from 1 to 10.');
  const ticks = input.ticks.filter((tick) => Number.isInteger(tick.digit) && tick.digit >= 0 && tick.digit <= 9 && Number.isFinite(tick.epoch));
  if (ticks.length < DIGIT_SIGNAL_MIN_TICKS) throw new Error(`${input.name} has ${ticks.length} valid ticks; ${DIGIT_SIGNAL_MIN_TICKS} are needed.`);
  const observations = ticks.map((tick) => ({ symbol: input.symbol, epoch: tick.epoch, digit: tick.digit }));
  const fit = fitDigitEnsemble(observations, input.horizon, (fraction, stage) => onProgress?.(fraction * 0.93, stage));
  onProgress?.(0.94, 'Counting engine votes and replaying held-out ticks');

  const requested = input.contracts?.length ? input.contracts : DIGIT_SIGNAL_CONTRACTS[input.family];
  const contracts = [...new Map(requested.filter((contract) => contract.family === input.family).map((contract) => [digitContractKey(contract), contract])).values()];
  if (!contracts.length) throw new Error('No supported contracts are available for this family.');

  const strict = scoreDigitCandidates(fit, contracts);
  const report = buildEnsembleReport(fit, strict);
  const strictByKey = new Map(strict.map((candidate) => [digitContractKey(candidate.contract), candidate]));
  const lastDigit = fit.sequence.digits.at(-1) ?? null;
  const quality = dataQuality(fit.sequence.digits.length, input.fresh, fit.structure.status);
  const context = historyContext(input.family, lastDigit);
  const signals = contracts.map((contract): DigitContractSignal => {
    const fair = fairProbability(contract);
    const deviation = Math.sqrt(fair * (1 - fair));
    const margin = voteMargin(fair);
    // Structural bias: an engine's average estimate for this contract minus the
    // rolling-frequency baseline's average over the same tuning rows. It
    // removes fixed shape effects (e.g. a discretized Gaussian always favouring
    // middle digits) without injecting realized-outcome noise.
    const bias = fit.engines.map((_, index) => {
      let engineTotal = 0;
      let baselineTotal = 0;
      let count = 0;
      for (const row of fit.tuning) {
        const probabilities = row.forecasts[index].probabilities;
        if (!probabilities) continue;
        engineTotal += digitContractProbability(probabilities, contract);
        baselineTotal += digitContractProbability(row.baseline, contract);
        count += 1;
      }
      return count >= 30 ? (engineTotal - baselineTotal) / count : 0;
    });
    const corrected = (forecast: Forecast, index: number) => forecast.probabilities
      ? clamp(digitContractProbability(forecast.probabilities, contract) - bias[index], 0.0005, 0.9995)
      : null;
    // Contract-level tuning skill of each engine versus rolling frequency.
    const skills = fit.engines.map((_, index) => {
      let engineLoss = 0;
      let baselineLoss = 0;
      let count = 0;
      for (const row of fit.tuning) {
        const value = corrected(row.forecasts[index], index);
        if (value === null) continue;
        const won = contractWins(contract, row.target) ? 1 : 0;
        engineLoss += (value - won) ** 2;
        baselineLoss += (digitContractProbability(row.baseline, contract) - won) ** 2;
        count += 1;
      }
      return count >= 30 && baselineLoss > 1e-9 ? 1 - engineLoss / baselineLoss : null;
    });
    const factors = skills.map(skillFactor);
    const weighted = (forecasts: readonly Forecast[]) => {
      let total = 0;
      let weight = 0;
      const values = forecasts.map((forecast, index) => {
        const value = corrected(forecast, index);
        if (value !== null) { total += factors[index] * value; weight += factors[index]; }
        return value;
      });
      return { values, weight, estimate: weight > 0 ? total / weight : fair };
    };

    const live = weighted(fit.liveForecasts);
    const liveValues = live.values;
    const rawProbability = live.estimate;
    const votes: EngineVote[] = fit.engines.map((engine, index) => {
      const value = liveValues[index];
      const vote = value === null ? 'abstain' : value - fair > margin ? 'agree' : value - fair < -margin ? 'against' : 'neutral';
      return {
        id: engine.id, label: engine.label, family: engine.family, vote, value,
        weight: value === null || live.weight <= 0 ? 0 : factors[index] / live.weight,
        skill: skills[index],
        note: fit.liveForecasts[index].note ?? '',
      };
    });
    const tally = tallyVotes(votes);

    // Held-out replay of the same rule: whenever the consensus favoured this
    // contract by more than the dead-band, did the contract actually win?
    let fired = 0;
    let wins = 0;
    let modelLoss = 0;
    let fairLoss = 0;
    for (const row of fit.checked) {
      const estimate = weighted(row.forecasts).estimate;
      const won = contractWins(contract, row.target) ? 1 : 0;
      modelLoss += (estimate - won) ** 2;
      fairLoss += (fair - won) ** 2;
      if (estimate - fair > margin) { fired += 1; wins += won; }
    }
    const validationSkill = fit.checked.length >= 30 && fairLoss > 1e-9 ? 1 - modelLoss / fairLoss : null;
    const backtest = summarizeBacktest(wins, fired, fair);
    const strictScore = strictByKey.get(digitContractKey(contract));
    const verified = Boolean(strictScore?.eligible);
    // Trust the raw consensus edge only as far as it validated out of sample.
    const shrunk = fair + edgeShrinkage(validationSkill) * (rawProbability - fair);
    const probability = clamp(shrunk, 0.0005, 0.9995);
    const edge = probability - fair;
    const edgeRatio = edge / deviation;
    const { confidence, breakdown } = confidenceScore({
      weightedAgreement: tally.weightedAgreement, edgeRatio, backtest, validationSkill, dataQuality: quality, verified,
      selectionPool: contracts.length * Math.max(1, input.marketsInScan ?? 1),
    });
    const historical = context ? evaluateHistoricalContract(observations as unknown as DigitObservation[], contract, input.horizon, context) : null;
    return {
      contract, label: candidateLabel(contract), probability, fairProbability: fair, edge, edgeRatio,
      votes, tally, backtest, validationSkill, verified, confidence, breakdown,
      strength: strengthOf(confidence, tally, backtest),
      history: historical ? {
        sample: historical.sample, hits: historical.hits, rate: historical.empiricalHitRate,
        context: context?.parity !== undefined ? `after an ${context.parity === 0 ? 'even' : 'odd'} digit` : `after digit ${context?.digit}`,
      } : null,
    };
  }).sort((a, b) => b.confidence - a.confidence || b.edgeRatio - a.edgeRatio || contractOrder(a.contract) - contractOrder(b.contract));

  const notes: string[] = [];
  if (!input.fresh) notes.push('Live tick freshness was not confirmed; confidence is reduced.');
  if (fit.structure.status === 'shifted') notes.push('Recent digit behaviour has shifted from the training window; confidence is reduced.');
  if (fit.structure.status === 'insufficient') notes.push('Too few recent ticks to check market structure.');
  onProgress?.(1, 'Signal ready');
  return {
    kind: 'digit', family: input.family, symbol: input.symbol, name: input.name, horizon: input.horizon,
    sample: fit.sequence.digits.length, lastDigit, asOfEpoch: fit.sequence.epochs.at(-1)!, fresh: input.fresh,
    dataQuality: quality, structure: fit.structure.status, engineCount: fit.engines.length,
    best: signals[0], contracts: signals, report, notes, durationMs: Date.now() - started,
  };
}
