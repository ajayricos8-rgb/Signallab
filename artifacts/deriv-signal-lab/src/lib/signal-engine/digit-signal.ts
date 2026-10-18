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
import { familyBalancedWeights } from './consensus.ts';
import { analyzeDigitEntry, type EntryPlan } from './entry.ts';
import {
  confidenceScore, edgeShrinkage, strengthOf, strengthWithConfirmation, summarizeBacktest, tallyVotes,
  type BacktestSummary, type ConfidenceBreakdown, type EngineVote, type SignalStrength, type VoteTally,
} from './confidence.ts';
import { analyzeDigitState, type DigitMarketState } from './market-state.ts';
import { confirmDigitContract, type ConfirmationReport } from './confirmation.ts';
import { pairedImprovementZ, type CalibrationPoint } from './stats.ts';

import { buildForecastBank, auditForecastBank, decideResearch } from '../engine-lab/forecast.ts';
import { buildEngineLabReport } from '../engine-lab/report.ts';
import { normalizeTicks } from '../engine-lab/math.ts';
import type { EngineLabReport, ResearchAudit, ResearchDecision, SettledReturn } from '../engine-lab/types.ts';

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
  /** Paired z-score of that skill against the fair-rate baseline. */
  validationZ: number | null;
  /** All strict research gates passed for this contract. */
  verified: boolean;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  strength: SignalStrength;
  /** Execution gate from the 300-entry research library; a candidate is still always returned. */
  researchDecision: ResearchDecision;
  /** Historical outcomes after the current digit (or parity) context. */
  history: { sample: number; hits: number; rate: number | null; context: string } | null;
  /** When to enter this contract: which tick context, and how long it may take. */
  entry: EntryPlan;
  /**
   * The two layers behind the probability: the analysis engines that measured
   * the market and the out-of-sample confirmation that adjusted it. Exposed so
   * the tools can show every engine by its own work instead of one opaque score.
   */
  deep: {
    /** The market-level analysis state lives once on the result; each contract
     * carries only its own confirmation report. */
    confirmation: ConfirmationReport;
  };
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
  /** Layer 1: the full analysis-engine panel for this market. */
  state: DigitMarketState;
  /** Number of analysis engines that ran (separate from the 12 prediction engines). */
  analysisEngineCount: number;
  /** Full audit stored once for the winning contract, not duplicated across candidates. */
  engineLab: EngineLabReport;
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
  /** Real quotes allow contextual candle/price engines; never reconstruct quotes from digits. */
  quoteTicks?: readonly { epoch: number; quote: number }[];
  settlements?: readonly SettledReturn[];
  settlementCurrency?: string;
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
  const ticks = normalizeTicks(input.ticks).filter((tick): tick is DigitTick => tick.digit != null);
  if (ticks.length < DIGIT_SIGNAL_MIN_TICKS) throw new Error(`${input.name} has ${ticks.length} valid ticks; ${DIGIT_SIGNAL_MIN_TICKS} are needed.`);
  const observations = ticks.map((tick) => ({ symbol: input.symbol, epoch: tick.epoch, digit: tick.digit }));
  const fit = fitDigitEnsemble(observations, input.horizon, (fraction, stage) => onProgress?.(fraction * 0.93, stage));
  onProgress?.(0.94, 'Measuring the market with the analysis engines');
  // Layer 1 runs on the same validated tick stream the 12 prediction engines
  // saw. It measures structure; it never votes on a contract by itself.
  const state = analyzeDigitState(fit.sequence.digits);
  onProgress?.(0.96, 'Confirming every contract out of sample');

  const requested = input.contracts?.length ? input.contracts : DIGIT_SIGNAL_CONTRACTS[input.family];
  const contracts = [...new Map(requested.filter((contract) => contract.family === input.family).map((contract) => [digitContractKey(contract), contract])).values()];
  if (!contracts.length) throw new Error('No supported contracts are available for this family.');

  const strict = scoreDigitCandidates(fit, contracts);
  const report = buildEnsembleReport(fit, strict);
  const strictByKey = new Map(strict.map((candidate) => [digitContractKey(candidate.contract), candidate]));
  const lastDigit = fit.sequence.digits.at(-1) ?? null;
  const quality = dataQuality(fit.sequence.digits.length, input.fresh, fit.structure.status);
  const context = historyContext(input.family, lastDigit);
  onProgress?.(0.965, 'Replaying research engines with purged chronological validation');
  const researchBank = buildForecastBank(ticks, 'digit', { unit: 'ticks', value: input.horizon });
  const researchAudits = new Map<string, ResearchAudit>();
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
    const corrected = (forecast: Forecast, index: number) => {
      if (!forecast.probabilities) return null;
      const probability = digitContractProbability(forecast.probabilities, contract) - bias[index];
      return Number.isFinite(probability) ? clamp(probability, 0.0005, 0.9995) : null;
    };
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
      const values = forecasts.map((forecast, index) => corrected(forecast, index));
      // The same family-aware weighting is used for the live estimate, engine
      // votes and every held-out replay. Correlated models share one family
      // budget instead of gaining influence just by being more numerous.
      const weights = familyBalancedWeights(fit.engines.map((engine, index) => ({
        family: engine.family,
        reliability: factors[index],
        available: values[index] !== null,
      })));
      const estimate = values.reduce<number>((total, value, index) => total + (value === null ? 0 : weights[index] * value), 0);
      return { values, weights, estimate: weights.some((weight) => weight > 0) ? estimate : fair };
    };

    const live = weighted(fit.liveForecasts);
    const liveValues = live.values;
    const rawProbability = live.estimate;
    const votes: EngineVote[] = fit.engines.map((engine, index) => {
      const value = liveValues[index];
      const vote = value === null ? 'abstain' : value - fair > margin ? 'agree' : value - fair < -margin ? 'against' : 'neutral';
      return {
        id: engine.id, label: engine.label, family: engine.family, vote, value,
        weight: value === null ? 0 : live.weights[index],
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
    const modelErrors: number[] = [];
    const fairErrors: number[] = [];
    const holdout: CalibrationPoint[] = [];
    for (const row of fit.checked) {
      const estimate = weighted(row.forecasts).estimate;
      const won = contractWins(contract, row.target) ? 1 : 0;
      holdout.push({ probability: estimate, won: won as 0 | 1 });
      modelLoss += (estimate - won) ** 2;
      fairLoss += (fair - won) ** 2;
      modelErrors.push((estimate - won) ** 2);
      fairErrors.push((fair - won) ** 2);
      if (estimate - fair > margin) { fired += 1; wins += won; }
    }
    const validationSkill = fit.checked.length >= 30 && fairLoss > 1e-9 ? 1 - modelLoss / fairLoss : null;
    // A positive Brier skill on overlapping or thin rows can be luck. The
    // paired z tests the model's per-row loss against the fair-rate baseline,
    // and only a skill that clears it is allowed to move the probability.
    const validationZ = fit.checked.length >= 30 ? pairedImprovementZ(fairErrors, modelErrors) : null;
    const backtest = summarizeBacktest(wins, fired, fair);
    const strictScore = strictByKey.get(digitContractKey(contract));
    const verified = Boolean(strictScore?.eligible);
    // Trust the raw consensus edge only as far as it validated out of sample.
    const shrunk = fair + edgeShrinkage(validationSkill, validationZ) * (rawProbability - fair);
    const beforeConfirmation = clamp(shrunk, 0.0005, 0.9995);
    // Layer 3: calibrate that estimate on held-out ticks, let a small logistic
    // stack try to beat it, and fold in the validated analysis prior. Nothing
    // can move the probability more than six points.
    const statePriorProbability = state.prior ? digitContractProbability(state.prior, contract) : null;
    const confirmation = confirmDigitContract({
      contractLabel: candidateLabel(contract),
      probability: beforeConfirmation,
      fairRate: fair,
      holdout,
      state,
      tally,
      backtest,
      validationSkill,
      statePriorProbability,
      selectionPool: contracts.length * Math.max(1, input.marketsInScan ?? 1),
    });
    const audit = auditForecastBank(researchBank, contract, fair, contracts.length * Math.max(1, input.marketsInScan ?? 1));
    researchAudits.set(digitContractKey(contract), audit);
    const researchDecision = decideResearch({ audit, fresh: input.fresh, probability: confirmation.probability, fair,
      confirmed: confirmation.decisive, independentSample: backtest.effectiveSample });
    if (researchDecision.edgeMultiplier < 1) {
      confirmation.probability = fair + researchDecision.edgeMultiplier * (confirmation.probability - fair);
      confirmation.edgePts = 100 * (confirmation.probability - fair);
      confirmation.status = 'contradicted';
      confirmation.decisive = false;
      confirmation.reasons.push('The independent research ensemble validated a contrary estimate; the master guard reduced the remaining edge by 75%.');
    }
    const probability = clamp(confirmation.probability, 0.0005, 0.9995);
    const edge = probability - fair;
    const edgeRatio = edge / deviation;
    const { confidence: baseConfidence, breakdown } = confidenceScore({
      weightedAgreement: tally.weightedAgreement, edgeRatio, backtest, validationSkill, dataQuality: quality, verified,
      selectionPool: contracts.length * Math.max(1, input.marketsInScan ?? 1),
      confirmation: {
        status: confirmation.status,
        calibrationSkill: confirmation.calibration.skill,
        stateAgreement: confirmation.state.agreement,
        statePredictability: state.predictability,
        adjustmentPts: confirmation.edgePts - confirmation.edgePtsBefore,
      },
    });
    const confidence = Math.max(1, baseConfidence - researchDecision.confidencePenalty);
    const historical = context ? evaluateHistoricalContract(observations as unknown as DigitObservation[], contract, input.horizon, context) : null;
    // Entry timing: which tick context this contract should be entered on. The
    // quote never decides a digit contract, so the context (not a price level)
    // is the entry point.
    const entry = analyzeDigitEntry({
      digits: fit.sequence.digits,
      epochs: fit.sequence.epochs,
      horizon: input.horizon,
      wins: (digit) => contractWins(contract, digit),
      context: input.family === 'even-odd' ? 'parity' : 'digit',
      fairRate: fair,
      signal: {
        source: 'digit',
        agreeing: tally.agreeing,
        total: tally.total,
        probability,
        aiProbability: rawProbability,
        confirmation: { status: confirmation.status, edgePts: confirmation.edgePts, decisive: confirmation.decisive },
      },
    });
    // A label is a claim: without a material edge the call is WEAK, however
    // much confidence the evidence score accumulated.
    const labelled = strengthWithConfirmation(strengthOf(confidence, tally, backtest), confirmation);
    const strength = edge < Math.max(0.005, 0.01 * fair) ? 'WEAK' : labelled;
    return {
      contract, label: candidateLabel(contract), probability, fairProbability: fair, edge, edgeRatio,
      votes, tally, backtest, validationSkill, validationZ, verified, confidence, breakdown,
      strength, entry, researchDecision,
      history: historical ? {
        sample: historical.sample, hits: historical.hits, rate: historical.empiricalHitRate,
        context: context?.parity !== undefined ? `after an ${context.parity === 0 ? 'even' : 'odd'} digit` : `after digit ${context?.digit}`,
      } : null,
      deep: { confirmation },
    };
  }).sort((a, b) => b.confidence - a.confidence || b.edgeRatio - a.edgeRatio || contractOrder(a.contract) - contractOrder(b.contract));

  const notes: string[] = [];
  if (!input.fresh) notes.push('Live tick freshness was not confirmed; confidence is reduced.');
  if (fit.structure.status === 'shifted') notes.push('Recent digit behaviour has shifted from the training window; confidence is reduced.');
  if (fit.structure.status === 'insufficient') notes.push('Too few recent ticks to check market structure.');
  if (state.regime === 'random') notes.push('Analysis engines: the digit stream is statistically indistinguishable from random; confirmed edges are kept small and the entry is usually immediate.');
  else notes.push(`Analysis engines: ${state.regime} — ${state.summary}`);
  if (signals[0]?.deep.confirmation.status === 'contradicted') notes.push('Confirmation layer: the analysis engines oppose the best contract; treat it as a contradicted call, not a verified edge.');
  onProgress?.(0.99, 'Explaining all 300 registered engines for the selected contract');
  const best = signals[0];
  const quotes = new Map((input.quoteTicks ?? []).map((tick) => [tick.epoch, tick.quote]));
  const labTicks = ticks.map((tick) => ({ ...tick, quote: quotes.get(tick.epoch) }));
  const engineLab = buildEngineLabReport({
    symbol: input.symbol, family: input.family, ticks: labTicks, contract: best.contract, horizon: { unit: 'ticks', value: input.horizon }, fresh: input.fresh,
    audit: researchAudits.get(digitContractKey(best.contract))!, decision: best.researchDecision,
    legacy: { probability: best.probability, fair: best.fairProbability, confidence: best.confidence, votes: best.votes,
      confirmationStatus: best.deep.confirmation.status, confirmed: best.deep.confirmation.decisive, entry: best.entry },
    candidates: signals.map((signal) => ({ label: signal.label, probability: signal.probability, fair: signal.fairProbability, confidence: signal.confidence })),
    settlements: input.settlements, settlementCurrency: input.settlementCurrency,
  });
  if (!best.researchDecision.eligible) notes.push(`Research execution guard: ${best.researchDecision.reasons.join(' ')}`);
  onProgress?.(1, 'Signal and 300-engine audit ready');
  return {
    kind: 'digit', family: input.family, symbol: input.symbol, name: input.name, horizon: input.horizon,
    sample: fit.sequence.digits.length, lastDigit, asOfEpoch: fit.sequence.epochs.at(-1)!, fresh: input.fresh,
    dataQuality: quality, structure: fit.structure.status, engineCount: fit.engines.length,
    best, contracts: signals, report, state, analysisEngineCount: state.engines.length, engineLab,
    notes, durationMs: Date.now() - started,
  };
}
