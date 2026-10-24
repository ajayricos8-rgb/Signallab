// Always-on digit signal layer for Over/Under, Even/Odd and Matches.
//
// Every analysis fits the full 17-engine digit ensemble (Markov, n-gram, HMM,
// frequency, entropy, streaks, trend, patterns, ARIMA, GARCH, LSTM, gradient
// boosting, PPM, Dirichlet predictive, gap hazard, horizon autocorrelation and
// a local-level filter) on the market's own ticks, then:
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
import { analyzeDigitEntry, medianTickSpacingMs, type EntryPlan } from './entry.ts';
import { buildMasterDecision, type MasterDecision, type MasterSourceInput } from './master-decision.ts';
import {
  confidenceScore, edgeShrinkage, strengthOf, strengthWithConfirmation, summarizeBacktest, tallyVotes,
  type BacktestSummary, type ConfidenceBreakdown, type EngineVote, type SignalStrength, type VoteTally,
} from './confidence.ts';
import {
  analyzeDigitState, digitPriorWithWeights,
  type DigitMarketState, type DigitPriorComponent, type DigitPriorComponentId,
} from './market-state.ts';
import { synthesizeDigitAi, type AiSynthesis } from './ai-synthesis.ts';
import { confirmDigitContract, type ConfirmationReport } from './confirmation.ts';
import { pairedImprovementZ, type CalibrationPoint } from './stats.ts';
import { forecastStandardError, probabilityInterval, reliabilityReport, type ProbabilityInterval, type ReliabilityReport } from './recalibration.ts';
import { shrinkEdges, type Heterogeneity } from './precision.ts';
import { blendWeight, fitStackWeights, mixWeights, type StackingRow } from './stacking.ts';

import { buildForecastBank, auditForecastBank, decideResearch } from '../engine-lab/forecast.ts';
import { buildEngineLabReport } from '../engine-lab/report.ts';
import { fuseResearch, researchEvidence, type ResearchFusion } from '../engine-lab/fusion.ts';
import {
  fuseNeural, neuralEvidence, trainDigitNeuralModel,
  type NeuralDigitForecast, type NeuralFusion,
} from '../neural/models.ts';
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
  /** Execution advice from the 300-entry research library; a candidate is still always returned. */
  researchDecision: ResearchDecision;
  /** What the research library's own forecast contributed to the probability above. */
  research: ResearchFusion;
  /** Layer 7: the embedded neural model's view of this contract and what it did. */
  neural: NeuralFusion;
  /** Historical outcomes after the current digit (or parity) context. */
  history: { sample: number; hits: number; rate: number | null; context: string } | null;
  /**
   * How precisely this probability is known, and how far it was moved by the
   * winner's-curse correction. `interval` is a 95% band for the true win rate
   * behind `probability`, measured out of sample.
   */
  precision: {
    standardError: number | null;
    interval: ProbabilityInterval | null;
    /** Reliability of the published probability on held-out rows. */
    reliability: ReliabilityReport;
    /** Fraction of the confirmed edge the precision layer kept (1 = untouched). */
    shrinkFactor: number;
    /** The confirmed probability before the precision layer moved it. */
    beforePrecision: number;
    /** Probability points removed as the winner's curse of ranking this pool. */
    selectionDebitPts: number;
    /** z-score of the edge against its own standard error. */
    edgeZ: number | null;
  };
  /** When to enter this contract: which tick context, and how long it may take. */
  entry: EntryPlan;
  /**
   * Layer 6: the engines, AI, calculations and entry fused into one decision
   * with one measured validity window. This is what the UI leads with and what
   * the bot's entry window is capped by.
   */
  master: MasterDecision;
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
  /** Layer 5: quant measurement engines synthesised into one AI verdict. */
  aiSynthesis: AiSynthesis;
  /**
   * Layer 7: the embedded, free neural model trained on this market's own tick
   * stream. Null when the stream is too short to fit it. Its forecast is folded
   * into every contract's probability only when it beat chance out of sample.
   */
  neural: NeuralDigitForecast | null;
  /** Number of analysis engines that ran (separate from the 17 prediction engines). */
  analysisEngineCount: number;
  /** Full audit stored once for the winning contract, not duplicated across candidates. */
  engineLab: EngineLabReport;
  /** Cross-candidate precision fit for this scan (heterogeneity of the pool). */
  precisionFit: { candidates: number; tau: number; standoutThreshold: number; standouts: number; heterogeneous: boolean } & Heterogeneity;
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

/**
 * One line naming every analysis angle that earned weight and the measured
 * skill behind it. Angles that did not beat uniform are listed as carrying no
 * weight, so the panel never implies evidence it does not have.
 */
function priorSummary(components: readonly DigitPriorComponent[]): string {
  if (!components.length) return 'none measured';
  return components
    .map((component) => `${component.label} ${component.weight > 0 ? `${(100 * component.weight).toFixed(0)}%` : 'no weight'}${component.skill === null ? '' : ` (skill ${(100 * component.skill).toFixed(1)}%)`}`)
    .join('; ');
}

/**
 * The features a weighted average cannot say, for the AI meta-model:
 *
 *  - dispersion: how far the engines are from their own consensus. A tight
 *    committee is usually more reliable than a split one even at the same
 *    probability.
 *  - support: the weight that actually backs the signalled side, signed so a
 *    committee leaning the other way is negative, not merely small.
 *  - baselineEdge: what the rolling-frequency model says about this contract
 *    relative to fair. It is the only feature that does not come from the
 *    engine pool, so it can break a tie the engines agree on for structural
 *    reasons.
 *  - priorEdge: what the validated analysis prior says about this contract
 *    over and above the rolling-frequency baseline, rebuilt from the history
 *    that was available at that row's own origin. This is how the analysis
 *    engines' evidence reaches the meta-model instead of only the final pool.
 */
function metaFeatures(
  values: readonly (number | null)[],
  weights: readonly number[],
  estimate: number,
  baselineProbability: number,
  fair: number,
  priorEdge = 0,
): number[] {
  const direction = estimate >= fair ? 1 : -1;
  let totalWeight = 0;
  let squared = 0;
  let support = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const weight = weights[index] ?? 0;
    if (value === null || weight <= 0) continue;
    totalWeight += weight;
    squared += weight * (value - estimate) ** 2;
    const side = Math.sign(value - fair);
    if (side !== 0) support += side === direction ? weight : -weight;
  }
  const dispersion = totalWeight > 1e-9 ? Math.sqrt(squared / totalWeight) : 0;
  return [
    dispersion,
    totalWeight > 1e-9 ? support / totalWeight : 0,
    baselineProbability - fair,
    priorEdge,
  ];
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
  // Layer 1 runs on the same validated tick stream the 17 prediction engines
  // saw. It measures structure; it never votes on a contract by itself.
  // The analysis is told the contract length: every conditioned angle it
  // measures (transitions, patterns, repeats) is a question about the digit at
  // the EXIT tick, not the next one.
  const state = analyzeDigitState(fit.sequence.digits, { horizon: input.horizon });
  onProgress?.(0.945, 'Ensembling quant measurement engines with AI synthesis');
  const aiSynthesis = synthesizeDigitAi(input.family, fit.sequence.digits);
  onProgress?.(0.947, 'Training the embedded neural model on this tick stream');
  // Layer 7: a real network fitted inside the app on this market's own digits.
  // It is additive — if it cannot be fitted, every layer below behaves exactly
  // as before.
  const neural = trainDigitNeuralModel(fit.sequence.digits);
  // The analysis prior is rebuilt at a past origin with exactly the weights it
  // ships with, so the meta-model can be told what the analysis engines knew at
  // that moment without any look-ahead in the evidence itself. One rebuild per
  // origin is shared by every contract on the market.
  const priorWeights = new Map<DigitPriorComponentId, number>(state.priorComponents.map((component) => [component.id, component.weight]));
  const priorHistory = new Map<number, number[] | null>();
  const priorAt = (origin: number): number[] | null => {
    const cached = priorHistory.get(origin);
    if (cached !== undefined) return cached;
    const built = origin >= 300 && origin < fit.sequence.digits.length
      ? digitPriorWithWeights(fit.sequence.digits.slice(0, origin + 1), input.horizon, priorWeights, state.priorLimits).prior
      : null;
    priorHistory.set(origin, built);
    return built;
  };
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
  // Layer 6 needs the market's own tick cadence to turn a measured tick window
  // into wall-clock seconds for the bot and the UI.
  const tickSpacingMs = medianTickSpacingMs(fit.sequence.epochs.map((epoch) => ({ epoch })));
  onProgress?.(0.965, 'Replaying research engines with purged chronological validation');
  const researchBank = buildForecastBank(ticks, 'digit', { unit: 'ticks', value: input.horizon });
  const researchAudits = new Map<string, ResearchAudit>();
  // ---------------------------------------------------------------------------
  // PHASE 1 — measure every contract.
  //
  // Everything up to (and including) the confirmation layer is computed first,
  // because the precision layer needs the whole pool: you cannot know whether
  // one contract's edge is real without the spread of the others.
  // ---------------------------------------------------------------------------
  const drafts = contracts.map((contract) => {
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
    // Extra AI features aligned one-for-one with `holdout`. They are computed
    // from the same replay rows, so the meta-model is fitted and scored under
    // exactly the chronology the rest of the layer uses.
    const metaHoldout: number[][] = [];
    // Every historical occasion the same consensus rule favoured this contract,
    // with the tick its contract expired on. Layer 6 reuses exactly these rows
    // to measure how the edge decays when an entry is delayed.
    const firedRows: { origin: number; exit: number }[] = [];
    for (const row of fit.checked) {
      const replay = weighted(row.forecasts);
      const estimate = replay.estimate;
      const won = contractWins(contract, row.target) ? 1 : 0;
      holdout.push({ probability: estimate, won: won as 0 | 1 });
      const rowPrior = priorAt(row.origin);
      metaHoldout.push(metaFeatures(
        replay.values, replay.weights, estimate,
        digitContractProbability(row.baseline, contract), fair,
        rowPrior ? digitContractProbability(rowPrior, contract) - digitContractProbability(row.baseline, contract) : 0,
      ));
      modelLoss += (estimate - won) ** 2;
      fairLoss += (fair - won) ** 2;
      modelErrors.push((estimate - won) ** 2);
      fairErrors.push((fair - won) ** 2);
      if (estimate - fair > margin) { fired += 1; wins += won; firedRows.push({ origin: row.origin, exit: row.targetIndex }); }
    }
    const validationSkill = fit.checked.length >= 30 && fairLoss > 1e-9 ? 1 - modelLoss / fairLoss : null;
    // A positive Brier skill on overlapping or thin rows can be luck. The
    // paired z tests the model's per-row loss against the fair-rate baseline,
    // and only a skill that clears it is allowed to move the probability.
    const validationZ = fit.checked.length >= 30 ? pairedImprovementZ(fairErrors, modelErrors) : null;
    const backtest = summarizeBacktest(wins, fired, fair);
    const strictScore = strictByKey.get(digitContractKey(contract));
    const verified = Boolean(strictScore?.eligible);
    // The consensus goes to the confirmation layer at full size.
    //
    // It used to be pre-shrunk here by `edgeShrinkage`, confirmation then
    // shrank it again when it could not confirm, and the precision layer shrinks
    // it a third time. Each of those asks the same question ("how much of this
    // edge is real?") and each multiplied its own answer in, so a genuine
    // five-point edge reached the user as half a point. Now each layer asks a
    // different question: calibration fixes the MAPPING, the precision layer
    // decides how much of the edge survives its own measurement error and the
    // selection, and the confidence score reports the evidence behind it.
    //
    // The demonstrable-skill test is not dropped, it is repriced: a model that
    // has not beaten the no-edge rate out of sample has its standard error
    // inflated below, which makes the precision layer stricter instead of
    // silently rescaling the number.
    const beforeConfirmation = clamp(rawProbability, 0.0005, 0.9995);
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
      engineFeatures: metaHoldout,
      liveFeatures: metaFeatures(
        live.values,
        live.weights,
        live.estimate,
        digitContractProbability(fit.baseline, contract),
        fair,
        state.prior ? digitContractProbability(state.prior, contract) - digitContractProbability(fit.baseline, contract) : 0,
      ),
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
    // Layer 4: the research library stops being a side report. Its validated
    // ensemble is folded into the probability every tool ranks, confirms, plans
    // an entry for and trades — it can raise the estimate when it passed its own
    // holdout, and otherwise only pull it down.
    const fused = fuseResearch({ audit, probability: confirmation.probability, fair });
    const research = fused.fusion;
    if (research.weight > 0) {
      confirmation.probability = fused.probability;
      confirmation.edgePts = 100 * (fused.probability - fair);
      confirmation.reasons.push(`Analysis, prediction and entry: ${research.note}`);
    }
    const probability = clamp(confirmation.probability, 0.0005, 0.9995);
    const edge = probability - fair;
    const edgeRatio = edge / deviation;
    // How precisely this probability is known. `forecastStandardError` measures
    // the out-of-sample error of the published number itself, with a binomial
    // floor so a near-constant forecast cannot report a tighter band than the
    // outcome noise allows.
    const measuredError = forecastStandardError(holdout);
    // The error bar has two parts, because a forecast's error has two parts.
    // `measuredError` is the sampling VARIANCE of the estimate; the second term
    // is the model's measured MISCALIBRATION out of fold — how far its numbers
    // have actually been from the frequencies they claimed, after any accepted
    // calibration. A model can have tiny variance and still be badly wrong, and
    // pricing only the variance is how an overconfident model earns an edge it
    // has not measured.
    //
    // `edgeShrinkage` measures how much of this model's claimed edge historically
    // survived out of sample; dividing by it inflates the variance term by up to
    // 3.3x for a model with no track record at all, which keeps a real link to
    // demonstrated skill — a model that has never beaten the no-edge rate does
    // not get to publish a precise-looking number — without the old behaviour of
    // three layers each rescaling the same number.
    // The miscalibration term is only charged to a model that has NOT proven
    // itself out of sample. A model that beat the no-edge rate on held-out rows
    // with a paired z above 2 has already demonstrated that its numbers track
    // the frequencies, so charging it a miscalibration penalty measured on the
    // same rows would double-count — and, with a thin holdout, penalise the
    // honest model for the noise in its own reliability bins.
    const skillProven = (validationZ ?? 0) >= 2 && (validationSkill ?? 0) > 0;
    const miscalibration = skillProven ? null : confirmation.calibration.residualMiscalibration;
    const ensembleError = measuredError === null && miscalibration === null
      ? null
      : Math.hypot(
        (measuredError ?? 0) / clamp(edgeShrinkage(validationSkill, validationZ), 0.3, 1),
        miscalibration ?? 0,
      );
    // The published number is a MIXTURE of the consensus and the analysis
    // prior, so its error bar is the mixture's: each source contributes its own
    // measured uncertainty weighted by its own share. Charging the consensus's
    // miscalibration at full size to a number the prior dominates was the last
    // reason a validated prior arrived with an error bar that swallowed it.
    const priorShare = confirmation.state.weight;
    const priorRowCount = Math.max(60, state.priorBacktest.sample);
    const priorError = statePriorProbability === null
      ? null
      : Math.sqrt(Math.max(1e-6, statePriorProbability * (1 - statePriorProbability)) / priorRowCount);
    const standardError = priorShare > 0 && priorError !== null
      ? Math.hypot((1 - priorShare) * (ensembleError ?? 0.05), priorShare * priorError)
      : ensembleError;
    const reliability = reliabilityReport(holdout);
    // The neural model's own probability for THIS contract: the share of its
    // next-digit distribution that the contract wins on.
    const neuralProbability = neural ? digitContractProbability(neural.distribution, contract) : null;
    // The evidence sources Layer 6 pools. Each one carries its own measured
    // out-of-sample skill and the independent sample behind it, so a source
    // that has never beaten the no-edge rate is reported but carries no weight.
    const sources: MasterSourceInput[] = [
      {
        id: 'engines',
        label: `${fit.engines.length}-engine ensemble`,
        probability: rawProbability,
        skill: validationSkill,
        sample: fit.checked.length,
        detail: `Bias-corrected consensus over ${fit.engines.length} predictors, validated on ${fit.checked.length} held-out ticks.`,
      },
      {
        id: 'ai',
        label: 'AI meta-model',
        // Only the stack is AI. Calibration is the calculation layer and is
        // already represented by the published probability; re-reporting it
        // here would let the same adjustment vote twice.
        probability: confirmation.ai.stackedProbability,
        // Weighted against FAIR, the same reference every other source uses.
        skill: confirmation.ai.stackSkillVsFair,
        sample: confirmation.ai.stackSample,
        familyCredit: 0.6,
        detail: confirmation.ai.stackedProbability !== null
          ? `Logistic meta-model on engine disagreement, weighted support and rolling frequency (${confirmation.ai.stackSample} rows), accepted out of sample.`
          : confirmation.calibration.improved
            ? 'The AI meta-model did not beat the calibrated chain out of sample, so it carries no vote.'
            : 'The AI meta-model did not beat the raw chain out of sample, so it carries no vote.',
      },
      {
        id: 'analysis',
        label: 'Analysis engines',
        probability: statePriorProbability,
        skill: state.priorBacktest.skill,
        sample: state.priorBacktest.sample,
        detail: state.prior
          ? `Analysis prior (${state.regime}, predictability ${(100 * state.predictability).toFixed(0)}%), pooled at ${(100 * confirmation.state.weight).toFixed(0)}% of the published number. Angles that beat uniform: ${priorSummary(state.priorComponents)}.`
          : `No angle beat uniform on this market, so the prior is exactly uniform. Angles measured: ${priorSummary(state.priorComponents)}.`,
      },
      {
        id: 'research',
        label: 'Analysis, prediction and entry',
        probability: research.probability,
        skill: research.skill,
        sample: research.sample,
        familyCredit: 0.8,
        detail: research.note,
      },
      {
        id: 'neural',
        label: neural ? `Neural model · ${neural.model.parameters} params` : 'Neural model',
        probability: neuralProbability,
        // An unvalidated model is reported but carries no weight: the pool only
        // counts a source whose skill cleared its own out-of-sample bar.
        skill: neural?.metrics.validated ? neural.metrics.brierSkill : null,
        sample: neural?.metrics.holdoutRows ?? 0,
        familyCredit: 0.6,
        detail: neural
          ? `${neural.model.id} ${neural.model.version}, trained locally on this market: ${neural.note}`
          : 'The embedded neural model could not be fitted on this market.',
      },
    ];
    return {
      contract, fair, deviation, margin, bias, corrected, skills, weighted, live, liveValues,
      rawProbability, votes, tally, backtest, validationSkill, validationZ, verified,
      confirmation, research, researchDecision, probability, edge, edgeRatio, quality,
      context, standardError, reliability, holdout, firedRows, sources, neuralProbability,
    };
  });

  // ---------------------------------------------------------------------------
  // PHASE 2 — precision: winner's-curse correction across the whole pool.
  //
  // Ranking up to 16 contracts and reporting the winner is a selection, not a
  // measurement. `shrinkEdges` estimates how much of the spread between the
  // candidates is real (τ) and shrinks each edge by its own measurement error,
  // so a noise pool collapses to "no edge" while a precisely-measured edge
  // keeps its size.
  // ---------------------------------------------------------------------------
  const estimates = drafts.map((draft) => ({ edge: draft.edge, standardError: draft.standardError ?? 0.05 }));
  // Same rule as Rise/Fall: a small pool may use the specified prior only when
  // the analysis layer independently validated structure on this market.
  // Every contract in a digit family is the same next-digit distribution read
  // through a different barrier, so the pool is correlated by construction and
  // the specified prior may only be used when the analysis layer PROVED an edge
  // on this market out of sample.
  const precisionFit = shrinkEdges(estimates, { independentEdge: state.priorBacktest.improved, correlated: true });

  /** Turn a measured draft into a publishable signal at a given (shrunken) probability. */
  const finalize = (draft: (typeof drafts)[number], shrinkFactor: number, selectionDebit: number): DigitContractSignal => {
    const { contract, fair, deviation, rawProbability, votes, tally, backtest, validationSkill, validationZ,
      verified, confirmation, research, researchDecision, context, standardError, reliability, holdout,
      firedRows, sources } = draft;
    const shrunk = clamp(fair + shrinkFactor * (draft.probability - fair) - selectionDebit, 0.0005, 0.9995);
    // Layer 7: fold the neural forecast into the number that gets published.
    // Identical rule to the research fusion — a weighted second opinion over
    // the same fair baseline, and zero weight unless it validated.
    const neuralFused = fuseNeural({
      probability: shrunk,
      fair,
      neuralProbability: draft.neuralProbability,
      weight: neural?.weight ?? 0,
      metrics: neural?.metrics ?? null,
    });
    const neuralFusion = neuralFused.fusion;
    const probability = clamp(neuralFused.probability, 0.0005, 0.9995);
    if (neuralFusion.weight > 0 && !confirmation.reasons.some((reason) => reason.startsWith('Neural model:'))) {
      confirmation.reasons.push(`Neural model: ${neuralFusion.note}`);
    }
    const edge = probability - fair;
    const edgeRatio = edge / deviation;
    // Keep the confirmation report in step with what is actually published.
    // Layer 3 decides the mapping; the precision layer then decides how much of
    // the resulting edge survives. Both numbers must agree on the card, and a
    // call whose edge the precision layer removed cannot stay "confirmed".
    if (Math.abs(probability - confirmation.probability) > 1e-9) {
      confirmation.probability = probability;
      confirmation.edgePts = 100 * edge;
      if (Math.abs(edge) < Math.max(0.005, 0.01 * fair)) {
        confirmation.decisive = false;
        if (confirmation.status === 'confirmed') confirmation.status = 'cautious';
      }
      // Report the precision layer's own movement separately from the neural
      // layer's, so neither is blamed for the other's adjustment.
      const precisionEdge = shrunk - fair;
      if (Math.abs(precisionEdge - (draft.probability - fair)) >= 0.005) {
        confirmation.reasons.push(
          `Precision layer: the measured edge did not clear its own standard error, so it was shrunk from ${(100 * (draft.probability - fair)).toFixed(2)} to ${(100 * precisionEdge).toFixed(2)} points.`,
        );
      }
    }
    const interval = probabilityInterval(holdout, probability);
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
      research: researchEvidence(research),
      neural: neuralEvidence(neuralFusion),
      // A probability the market data cannot actually pin down is weaker
      // evidence than the same number measured off 2,000 ticks.
      precision: { edge, standardError, intervalHalfWidth: interval ? (interval.upper - interval.lower) / 2 : null },
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
    // -----------------------------------------------------------------------
    // Layer 6 — the single decision.
    //
    // Everything above has now been measured: the sources' out-of-sample
    // skills, the calibrated chain probability, its error bar, the quality of
    // the sample and the entry the replay planned. Layer 6 pools the sources,
    // reconciles them with the chain, decides whether the edge is real and how
    // long it survives, and caps the entry window at that measured validity.
    // -----------------------------------------------------------------------
    const master = buildMasterDecision({
      family: 'digit',
      label: candidateLabel(contract),
      fair,
      publishedProbability: probability,
      publishedStandardError: standardError,
      publishedConfidence: confidence,
      strength,
      sources,
      validity: {
        rows: firedRows,
        // Hold the prediction fixed and settle it later: what a user who waits
        // `lag` ticks before entering actually gets.
        outcome: (row, lag) => {
          const digit = fit.sequence.digits[row.exit + lag];
          return digit === undefined ? null : contractWins(contract, digit) ? 1 : 0;
        },
        fair,
        maxLag: clamp(input.horizon + 4, 4, 12),
      },
      tickSpacingMs,
      entry,
      dataQuality: quality,
      marketMeasured: fit.structure.status !== 'insufficient',
      marketRandom: state.regime === 'random',
      structureStable: fit.structure.status === 'stable',
      confirmed: confirmation.decisive,
      contradicted: confirmation.status === 'contradicted',
    });
    // The bot may not wait for a trigger longer than the edge was measured to
    // last. This is the only place the validity cap is applied to the plan.
    const tradeableEntry: EntryPlan = { ...entry, validForTicks: master.validity.ticks };
    return {
      contract, label: candidateLabel(contract), probability, fairProbability: fair, edge, edgeRatio,
      votes, tally, backtest, validationSkill, validationZ, verified, confidence, breakdown,
      strength, entry: tradeableEntry, master, researchDecision, research, neural: neuralFusion,
      history: historical ? {
        sample: historical.sample, hits: historical.hits, rate: historical.empiricalHitRate,
        context: context?.parity !== undefined ? `after an ${context.parity === 0 ? 'even' : 'odd'} digit` : `after digit ${context?.digit}`,
      } : null,
      precision: {
        standardError,
        interval,
        reliability,
        beforePrecision: draft.probability,
        shrinkFactor,
        selectionDebitPts: selectionDebit * 100,
        edgeZ: standardError !== null && standardError > 1e-9 ? edge / standardError : null,
      },
      deep: { confirmation },
    };
  };

  // ---------------------------------------------------------------------------
  // PHASE 3 — publish, then charge the winner its selection bias.
  //
  // Ranking first and debiting afterwards is deliberate: the winner's curse is
  // a property of having been SELECTED, so only the contract that is actually
  // published pays it. The debit is then re-ranked, so a candidate whose whole
  // lead was selection luck loses the top slot to one with a measured edge.
  // ---------------------------------------------------------------------------
  // Layer 6 ranks first: a decisive, currently-tradeable edge outranks a
  // higher confidence score whose edge the master could not certify, and a
  // signal that survives longer breaks ties before the old evidence score.
  // A certified edge always outranks an uncertified one. Among candidates the
  // master refused to certify, the verdict itself is the same for all of them,
  // so their priority difference is a fraction of an edge z and the honest
  // tie-break is the evidence score: the candidate with the better measured
  // evidence is the one worth showing (and, for the bot, trading) rather than
  // whichever happened to sort first by digit.
  const stageRank = (signal: DigitContractSignal) =>
    signal.master.verdict === 'TRADE_NOW' || signal.master.verdict === 'TRADE_ON_ENTRY' ? 2
      : signal.master.verdict === 'SPECULATIVE' ? 1 : 0;
  const rank = (list: DigitContractSignal[]) =>
    [...list].sort((a, b) =>
      stageRank(b) - stageRank(a)
      || (stageRank(a) === 0 ? b.confidence - a.confidence : b.master.priority - a.master.priority)
      || b.confidence - a.confidence
      || b.master.validity.ticks - a.master.validity.ticks
      || b.edgeRatio - a.edgeRatio
      // Nothing measurable separates these two: publish the contract the model
      // thinks is MORE likely rather than whichever happens to sort first by
      // digit. On a pool that shrank to exactly fair this is the only real
      // information left, and it is the difference between picking the hot
      // digit and picking an arbitrary one.
      || b.probability - a.probability
      || contractOrder(a.contract) - contractOrder(b.contract));
  const provisional = rank(drafts.map((draft, index) => finalize(draft, precisionFit.factors[index], 0)));
  const leader = provisional[0];
  const leaderIndex = drafts.findIndex((draft) => draft.contract === leader.contract);
  const leaderStandardError = leaderIndex >= 0 ? drafts[leaderIndex].standardError : null;
  // The debit is charged to a winner whose lead is NOT individually
  // significant. A winner that cleared the Šidák-corrected standout bar has
  // already paid for the fact that it was chosen from a pool — subtracting the
  // expected maximum of m draws a second time would double-count the same
  // correction and systematically under-report every real edge.
  const leaderIsStandout = precisionFit.standouts.some((standout) => standout.index === leaderIndex);
  const selectionDebit = !leaderIsStandout && leaderStandardError !== null
    ? Math.max(0, Math.min(Math.abs(leader.edge) * 0.35, precisionFit.selectionBiasUnits * leaderStandardError))
    : 0;
  const signals = selectionDebit > 1e-9
    ? rank([finalize(drafts[leaderIndex], precisionFit.factors[leaderIndex], selectionDebit), ...provisional.filter((signal) => signal.contract !== leader.contract)])
    : provisional;
  const precisionSummary = {
    ...precisionFit.heterogeneity,
    candidates: contracts.length,
    tau: precisionFit.tau,
    standoutThreshold: precisionFit.standoutThreshold,
    standouts: precisionFit.standouts.length,
    heterogeneous: precisionFit.trimmedHeterogeneity.heterogeneous,
  };

  const notes: string[] = [];
  if (!input.fresh) notes.push('Live tick freshness was not confirmed; confidence is reduced.');
  if (fit.structure.status === 'shifted') notes.push('Recent digit behaviour has shifted from the training window; confidence is reduced.');
  if (fit.structure.status === 'insufficient') notes.push('Too few recent ticks to check market structure.');
  if (state.regime === 'random') notes.push('Analysis engines: the digit stream is statistically indistinguishable from random; confirmed edges are kept small and the entry is usually immediate.');
  else notes.push(`Analysis engines: ${state.regime} — ${state.summary}`);
  notes.push(`AI synthesis: ${aiSynthesis.verdict}. ${aiSynthesis.consensus.detail}`);
  notes.push(neural
    ? `Neural model: ${neural.note}`
    : 'Neural model: the tick stream is too short to fit the embedded network; every other layer ran unchanged.');
  if (signals[0]?.neural.weight > 0) notes.push(`Neural fusion: ${signals[0].neural.note}`);
  if (signals[0]?.deep.confirmation.status === 'contradicted') notes.push('Confirmation layer: the analysis engines oppose the best contract; treat it as a contradicted call, not a verified edge.');
  onProgress?.(0.99, 'Explaining all 300 registered engines for the selected contract');
  const best = signals[0];
  const quotes = new Map((input.quoteTicks ?? []).map((tick) => [tick.epoch, tick.quote]));
  const labTicks = ticks.map((tick) => ({ ...tick, quote: quotes.get(tick.epoch) }));
  const engineLab = buildEngineLabReport({
    symbol: input.symbol, family: input.family, ticks: labTicks, contract: best.contract, horizon: { unit: 'ticks', value: input.horizon }, fresh: input.fresh,
    audit: researchAudits.get(digitContractKey(best.contract))!, decision: best.researchDecision, fusion: best.research,
    legacy: { probability: best.probability, fair: best.fairProbability, confidence: best.confidence, votes: best.votes,
      confirmationStatus: best.deep.confirmation.status, confirmed: best.deep.confirmation.decisive, entry: best.entry },
    candidates: signals.map((signal) => ({ label: signal.label, probability: signal.probability, fair: signal.fairProbability, confidence: signal.confidence })),
    settlements: input.settlements, settlementCurrency: input.settlementCurrency,
  });
  if (best.research.weight > 0) notes.push(`Analysis, prediction and entry: ${best.research.note}`);
  notes.push(`Master decision: ${best.master.headline}. ${best.master.entry.instruction}`);
  if (!best.researchDecision.eligible) notes.push(`Analysis, prediction and entry advisory (the bot still trades this signal): ${best.researchDecision.reasons.join(' ')}`);
  onProgress?.(1, 'Signal and 300-engine audit ready');
  return {
    kind: 'digit', family: input.family, symbol: input.symbol, name: input.name, horizon: input.horizon,
    sample: fit.sequence.digits.length, lastDigit, asOfEpoch: fit.sequence.epochs.at(-1)!, fresh: input.fresh,
    dataQuality: quality, structure: fit.structure.status, engineCount: fit.engines.length,
    best, contracts: signals, report, state, aiSynthesis, neural, analysisEngineCount: state.engines.length, engineLab,
    precisionFit: precisionSummary, notes, durationMs: Date.now() - started,
  };
}
