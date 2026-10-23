import type { DigitContractCandidate, DigitObservation } from '../digit-analysis.ts';
import { brier, clamp, countsOf, distributionStats, improvementSummary, mean, mix, normalize, smooth, sum, UNIFORM } from './math.ts';
import { ENGINE_FAMILIES, prefix, streakDiagnostics, trendMetrics, type EngineFamily, type FittedEngine, type Forecast, type Sequence } from './features.ts';
import { fitStatisticalEngines } from './statistical-models.ts';
import { fitBoosting, fitLstm } from './ml-models.ts';
import { fitExtraEngines } from './extra-models.ts';
import { marketStructure } from './structure.ts';

export const RESEARCH_BARRIERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type OverUnderContract = { family: 'over-under'; contractType: 'DIGITOVER' | 'DIGITUNDER'; barrier: number };
/** Any digit contract the shared 17-engine ensemble can score. */
export type DigitEnsembleContract = OverUnderContract | DigitContractCandidate;
export type EngineEvidence = {
  id: string; family: EngineFamily; label: string;
  probabilities: number[] | null; support: number; note: string;
  tuningSample: number; tuningBrier: number | null; tuningSkill: number | null;
  weight: number; status: 'contributing' | 'no-skill' | 'sparse';
};
export type DigitCandidateScore<C extends DigitEnsembleContract = DigitEnsembleContract> = {
  contract: C;
  probability: number;
  baselineProbability: number;
  uniformProbability: number;
  equalityProbability: number;
  lift: number;
  agreement: number;
  dispersion: number;
  supportingFamilies: number;
  validationSample: number;
  validationBrier: number | null;
  validationBaselineBrier: number | null;
  validationSkill: number | null;
  validationImprovementLower: number | null;
  score: number;
  eligible: boolean;
  reasons: string[];
};
export type OverUnderCandidateScore = DigitCandidateScore<OverUnderContract>;

export type OverUnderReport = ReturnType<typeof runOverUnderEnsemble>;
export type DigitEnsembleReport<C extends DigitEnsembleContract = DigitEnsembleContract> = ReturnType<typeof buildEnsembleReport<C>>;
/** Progress callback: fraction in [0, 1] plus a human-readable stage. */
export type EnsembleProgress = (fraction: number, stage: string) => void;
type StreamObservation = Pick<DigitObservation, 'symbol' | 'epoch' | 'digit'>;

/** Evaluation row. `contextEnd` replaces a stored prefix copy to bound memory. */
export type EnsembleEvaluation = { origin: number; targetIndex: number; target: number; baseline: number[]; forecasts: Forecast[]; contextEnd: number };

/** Settlement rule for every supported digit contract (strict over / under). */
export function contractWins(contract: DigitEnsembleContract, digit: number): boolean {
  if (contract.family === 'over-under') return contract.contractType === 'DIGITOVER' ? digit > contract.barrier : digit < contract.barrier;
  if (contract.family === 'even-odd') return contract.contractType === 'DIGITEVEN' ? digit % 2 === 0 : digit % 2 === 1;
  return digit === contract.targetDigit;
}

export function contractProbability(probabilities: readonly number[], contract: DigitEnsembleContract): number {
  return sum(probabilities.filter((_, digit) => contractWins(contract, digit)));
}

function equalityProbability(probabilities: readonly number[], contract: DigitEnsembleContract): number {
  return contract.family === 'over-under' ? probabilities[contract.barrier] : 0;
}

function contractOrder(contract: DigitEnsembleContract): number {
  return contract.family === 'over-under' ? contract.barrier : contract.family === 'matches' ? contract.targetDigit : 0;
}

function baselineForecast(context: Sequence): number[] {
  return smooth(countsOf(context.digits.slice(-1_000)));
}

function cappedFamilyWeights(scores: { id: EngineFamily; score: number }[]): Map<EngineFamily, number> {
  const positive = scores.filter((row) => row.score > 0);
  const cap = Math.max(0.4, 1 / Math.max(1, positive.length));
  const weights = new Map<EngineFamily, number>();
  let remaining = positive;
  let budget = 1;
  while (remaining.length && budget > 1e-9) {
    const total = sum(remaining.map((row) => row.score));
    const capped = remaining.filter((row) => budget * row.score / total > cap);
    if (!capped.length) { for (const row of remaining) weights.set(row.id, budget * row.score / total); break; }
    for (const row of capped) { weights.set(row.id, cap); budget -= cap; }
    remaining = remaining.filter((row) => !weights.has(row.id));
  }
  return weights;
}

/**
 * Two ways to pool the same engines, both weighted the same way:
 *
 *   linear       p = Σ wᵢ pᵢ            — an average of opinions.
 *   logarithmic  p ∝ Π pᵢ^wᵢ            — a geometric pool, which sharpens when
 *               independent engines agree and refuses to let one confident
 *               engine alone set the number.
 *
 * Which one ships is decided on the tuning partition, per market, and only when
 * the winner is better by a margin that is not rounding. A fair stream usually
 * keeps the linear pool because neither can beat the other there.
 */
export type BlendMode = 'linear' | 'logarithmic';

function pooledModel(forecasts: Forecast[], effectiveWeights: readonly number[], mode: BlendMode): number[] {
  if (mode === 'logarithmic') {
    // Floor the logs so a single zero-probability engine cannot annihilate the
    // pool; the floor is far below any probability worth publishing.
    const logs = UNIFORM.map((_, digit) => sum(forecasts.map((forecast, index) => {
      const probability = forecast.probabilities?.[digit];
      return probability === undefined ? 0 : effectiveWeights[index] * Math.log(Math.max(1e-4, probability));
    })));
    const maximum = Math.max(...logs);
    return normalize(logs.map((value) => Math.exp(value - maximum)));
  }
  return normalize(UNIFORM.map((_, digit) => sum(forecasts.map((forecast, index) => (forecast.probabilities?.[digit] ?? 0) * effectiveWeights[index]))));
}

function combine(
  forecasts: Forecast[], weights: number[], baseline: number[], recentDigits: readonly number[],
  mode: BlendMode = 'linear',
) {
  const usable = weights.map((weight, index) => forecasts[index].probabilities ? weight : 0);
  const total = sum(usable);
  if (total <= 0) return { probabilities: baseline, effectiveWeights: usable, baselineWeight: 1 };
  const effectiveWeights = usable.map((weight) => weight / total);
  const model = pooledModel(forecasts, effectiveWeights, mode);
  const information = distributionStats(recentDigits);
  // High entropy with little compressible structure increases shrinkage, not a
  // directional vote. A uniform histogram can still have a repeating sequence.
  const baselineWeight = 0.12 + 0.18 * (information.normalizedEntropy ?? 1) * clamp(information.compression.ratio, 0, 1);
  return { probabilities: mix(model, baseline, 1 - baselineWeight), effectiveWeights, baselineWeight };
}

/** Mean Brier loss of each pool on the tuning rows, and the winner. */
function chooseBlend(tuning: readonly EnsembleEvaluation[], weights: readonly number[], recent: (end: number) => number[]) {
  const lossOf = (mode: BlendMode) => {
    const rows = tuning.filter((row) => row.target !== undefined);
    if (!rows.length) return null;
    return mean(rows.map((row) => brier(combine(row.forecasts, weights as number[], row.baseline, recent(row.contextEnd), mode).probabilities, row.target)));
  };
  const linear = lossOf('linear');
  const logarithmic = lossOf('logarithmic');
  // A margin of 0.75% of the linear loss keeps a coin-flip difference out of
  // the shipped recipe; the geometric pool must actually pay for itself.
  const switchOver = linear !== null && logarithmic !== null && logarithmic < linear * 0.9925;
  return {
    mode: (switchOver ? 'logarithmic' : 'linear') as BlendMode,
    linearBrier: linear,
    logarithmicBrier: logarithmic,
  };
}

function validateStream(observations: readonly StreamObservation[], horizon: number) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 100) throw new Error('Digit research requires a tick horizon from 1 to 100.');
  if (observations.length < 500) throw new Error('At least 500 validated observations are required.');
}

/**
 * One bounded, CPU-only research fit shared by every digit contract family.
 * Train / tune / held-out chronology is purged at each label boundary; no fit
 * or weight ever sees a holdout target. Evaluation origins are spaced by the
 * selected tick horizon. This reduces overlapping outcomes but does NOT
 * establish independence or profitability.
 */
export function fitDigitEnsemble(observations: readonly StreamObservation[], horizon: number, onProgress?: EnsembleProgress) {
  validateStream(observations, horizon);
  const report = (fraction: number, stage: string) => onProgress?.(fraction, stage);
  report(0, 'Validating the digit stream');
  const window = observations.slice(-2_000);
  const symbol = window[0].symbol;
  if (window.some((tick, index) => !Number.isInteger(tick.digit) || tick.digit < 0 || tick.digit > 9 || tick.symbol !== symbol || !Number.isFinite(tick.epoch) || (index > 0 && tick.epoch < window[index - 1].epoch))) throw new Error('Research requires one chronological, validated digit stream.');
  const sequence: Sequence = { digits: window.map((tick) => tick.digit), epochs: window.map((tick) => tick.epoch) };
  const trainEnd = Math.floor(window.length * 0.6);
  const tuningEnd = Math.floor(window.length * 0.8);
  const train = prefix(sequence, trainEnd);
  const structure = marketStructure(train.digits, sequence.digits.slice(tuningEnd));
  report(0.02, 'Fitting Markov, HMM, n-gram, pattern, trend, ARIMA and GARCH engines');
  const statistical = fitStatisticalEngines(train, horizon);
  report(0.12, 'Training the LSTM neural network');
  const lstm = fitLstm(train, horizon);
  report(0.5, 'Training gradient-boosted trees');
  const boosting = fitBoosting(train, horizon);
  report(0.66, 'Fitting PPM, Dirichlet, hazard, spectral and state-space engines');
  const extra = fitExtraEngines(train, horizon);
  report(0.78, 'Walk-forward tuning of engine weights');
  const engines: FittedEngine[] = [...statistical.engines, lstm.engine, boosting.engine, ...extra.engines];
  const evaluate = (start: number, end: number): EnsembleEvaluation[] => {
    const rows: EnsembleEvaluation[] = [];
    for (let origin = start; origin + horizon < end; origin += horizon) {
      const context = prefix(sequence, origin + 1);
      rows.push({ origin, targetIndex: origin + horizon, target: sequence.digits[origin + horizon], baseline: baselineForecast(context), forecasts: engines.map((engine) => engine.predict(context, horizon)), contextEnd: origin + 1 });
    }
    return rows;
  };
  const tuning = evaluate(trainEnd, tuningEnd);
  report(0.88, 'Held-out validation');
  const holdout = evaluate(tuningEnd, sequence.digits.length);
  const tuningScores = engines.map((_, index) => {
    const available = tuning.filter((row) => row.forecasts[index].probabilities);
    const loss = available.length ? mean(available.map((row) => brier(row.forecasts[index].probabilities!, row.target))) : null;
    const baselineLoss = available.length ? mean(available.map((row) => brier(row.baseline, row.target))) : null;
    const skill = loss !== null && baselineLoss !== null && baselineLoss > 1e-9 ? 1 - loss / baselineLoss : null;
    // Sparse or harmful engines stay visible but have no ensemble weight.
    const strength = available.length >= 30 && skill !== null ? Math.max(0, skill) * available.length / Math.max(1, tuning.length) : 0;
    return { sample: available.length, loss, skill, strength };
  });
  // A family is worth its BEST member, not its average one: adding a weak
  // engine to a family must not dilute the evidence the strong member measured.
  // The within-family split below still gives the weak member ~no weight.
  const families = ENGINE_FAMILIES.map((family) => ({
    id: family.id,
    score: Math.max(0, ...engines.map((engine, index) => engine.family === family.id ? tuningScores[index].strength : -1).filter((value) => value >= 0)),
  }));
  const familyWeights = cappedFamilyWeights(families);
  const weights = engines.map((engine, index) => {
    const total = sum(engines.map((member, memberIndex) => member.family === engine.family ? tuningScores[memberIndex].strength : 0));
    return total ? (familyWeights.get(engine.family) ?? 0) * tuningScores[index].strength / total : 0;
  });
  const recent = (end: number) => sequence.digits.slice(Math.max(0, end - 1_000), end);
  // Which pool ships is measured on the tuning rows, before any holdout row is
  // touched, so the choice cannot be fitted to the validation tail.
  const blend = chooseBlend(tuning, weights, recent);
  const checked = holdout.map((row) => ({ ...row, ensemble: combine(row.forecasts, weights, row.baseline, recent(row.contextEnd), blend.mode).probabilities }));
  const improvements = checked.map((row) => brier(row.baseline, row.target) - brier(row.ensemble, row.target));
  const improvement = improvementSummary(improvements);
  const baselineBrier = checked.length ? mean(checked.map((row) => brier(row.baseline, row.target))) : null;
  const ensembleBrier = checked.length ? mean(checked.map((row) => brier(row.ensemble, row.target))) : null;
  const validationPassed = checked.length >= 30 && improvement.lower > 0;
  report(0.97, 'Live forecasts from every engine');
  const liveForecasts = engines.map((engine) => engine.predict(sequence, horizon));
  const baseline = baselineForecast(sequence);
  const current = combine(liveForecasts, weights, baseline, recent(sequence.digits.length), blend.mode);
  const engineEvidence: EngineEvidence[] = engines.map((engine, index) => ({
    id: engine.id, family: engine.family, label: engine.label,
    probabilities: liveForecasts[index].probabilities, support: liveForecasts[index].support,
    note: liveForecasts[index].note ?? '',
    tuningSample: tuningScores[index].sample, tuningBrier: tuningScores[index].loss, tuningSkill: tuningScores[index].skill,
    weight: current.effectiveWeights[index] * (1 - current.baselineWeight),
    status: !liveForecasts[index].probabilities || tuningScores[index].sample < 30 ? 'sparse' : weights[index] > 0 ? 'contributing' : 'no-skill',
  }));
  report(1, 'Engines fitted');
  return {
    symbol, sequence, horizon, trainEnd, tuningEnd, structure, statistical, lstm, boosting, extra, engines,
    tuning, tuningScores, weights, blend, checked, improvements, improvement, baselineBrier, ensembleBrier, validationPassed,
    liveForecasts, baseline, current, engineEvidence,
  };
}
export type DigitEnsembleFit = ReturnType<typeof fitDigitEnsemble>;

/**
 * Strict research scoring for any digit contracts. A candidate is `eligible`
 * only when every conservative held-out gate passes; most live RNG streams
 * correctly produce no eligible candidate.
 */
export function scoreDigitCandidates<C extends DigitEnsembleContract>(fit: DigitEnsembleFit, contracts: readonly C[]): DigitCandidateScore<C>[] {
  const { current, baseline, engineEvidence, checked, tuning, structure, validationPassed } = fit;
  return contracts.map((contract) => {
    const noun = contract.family === 'over-under' ? 'barrier' : 'contract';
    const probability = contractProbability(current.probabilities, contract);
    const baselineProbability = contractProbability(baseline, contract);
    const lift = probability - baselineProbability;
    const active = engineEvidence.filter((engine) => engine.weight > 0 && engine.probabilities);
    const activeWeight = sum(active.map((engine) => engine.weight));
    const supporting = active.filter((engine) => contractProbability(engine.probabilities!, contract) > baselineProbability + 0.005);
    const agreement = activeWeight ? sum(supporting.map((engine) => engine.weight)) / activeWeight : 0;
    const supportingFamilies = new Set(supporting.filter((engine) => engine.weight >= 0.01).map((engine) => engine.family)).size;
    const dispersion = activeWeight ? Math.sqrt(sum(active.map((engine) => engine.weight * (contractProbability(engine.probabilities!, contract) - probability) ** 2)) / activeWeight) : 0;
    const binaryLoss = checked.map((row) => {
      const won = Number(contractWins(contract, row.target));
      return { model: (contractProbability(row.ensemble, contract) - won) ** 2, baseline: (contractProbability(row.baseline, contract) - won) ** 2 };
    });
    // Approximate family-wise guard for up to 16 inspected contracts. Serial
    // dependence and repeated scans still limit inference; never call this EV.
    const binaryImprovement = improvementSummary(binaryLoss.map((row) => row.baseline - row.model), 3.0);
    const validationBrier = binaryLoss.length ? mean(binaryLoss.map((row) => row.model)) : null;
    const validationBaselineBrier = binaryLoss.length ? mean(binaryLoss.map((row) => row.baseline)) : null;
    const validationSkill = validationBrier !== null && validationBaselineBrier !== null && validationBaselineBrier > 1e-9 ? 1 - validationBrier / validationBaselineBrier : null;
    const reasons: string[] = [];
    if (structure.status !== 'stable') reasons.push(structure.status === 'shifted'
      ? `Recent digit frequencies or transitions have shifted away from the fitted market structure. Refit on a newer window before using a ${noun}.`
      : 'Insufficient recent observations to check market structure.');
    if (tuning.length < 30 || checked.length < 30) reasons.push(`Need 30 non-overlapping tuning and holdout outcomes; have ${tuning.length} / ${checked.length}.`);
    if (!validationPassed) reasons.push('The combined model did not establish held-out improvement over rolling frequency.');
    if (binaryImprovement.lower <= 0) reasons.push(`This ${noun} failed the conservative held-out Brier improvement check.`);
    if (lift < 0.02) reasons.push('Estimated lift over the current frequency baseline is below 2 percentage points.');
    if (supportingFamilies < 3 || agreement < 0.65) reasons.push('Fewer than three engine families agree, or weighted agreement is below 65%.');
    if (dispersion > 0.18) reasons.push('Engine probability estimates disagree too widely.');
    const score = lift / Math.sqrt(Math.max(0.01, baselineProbability * (1 - baselineProbability))) * (0.25 + 0.75 * Math.max(0, validationSkill ?? 0)) - 0.25 * dispersion;
    return {
      contract, probability, baselineProbability, uniformProbability: contractProbability(UNIFORM, contract), equalityProbability: equalityProbability(current.probabilities, contract),
      lift, agreement, dispersion, supportingFamilies,
      validationSample: checked.length, validationBrier, validationBaselineBrier, validationSkill,
      validationImprovementLower: binaryLoss.length > 1 ? binaryImprovement.lower : null,
      score, eligible: reasons.length === 0, reasons,
    };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || contractOrder(a.contract) - contractOrder(b.contract) || a.contract.contractType.localeCompare(b.contract.contractType));
}

/** Panel-ready research report (validation, diagnostics and strict candidates). */
export function buildEnsembleReport<C extends DigitEnsembleContract>(fit: DigitEnsembleFit, candidates: DigitCandidateScore<C>[]) {
  const { sequence, horizon, statistical, lstm, boosting, current, baseline, tuning, checked, trainEnd, tuningEnd, improvements, improvement, baselineBrier, ensembleBrier, validationPassed } = fit;
  const selected = candidates.find((candidate) => candidate.eligible) ?? null;
  const stats100 = distributionStats(sequence.digits.slice(-100));
  const stats1000 = distributionStats(sequence.digits.slice(-1_000));
  const hmmPosterior = statistical.hmm.posterior(sequence.digits);
  const timeForecast = statistical.timeSeries.forecast(sequence, horizon, true);
  return {
    symbol: fit.symbol, sample: sequence.digits.length, asOfEpoch: sequence.epochs.at(-1)!, horizon,
    probabilities: current.probabilities, baselineProbabilities: baseline,
    baselineWeight: current.baselineWeight,
    engines: fit.engineEvidence, candidates, selected,
    reason: selected ? '' : candidates[0]?.reasons.join(' ') || 'No supported barriers in the 1–8 research range.',
    validation: {
      trainSample: trainEnd, trainingLastIndex: trainEnd - 1, tuningEndIndex: tuningEnd - 1,
      tuningSample: tuning.length, holdoutSample: checked.length, stride: horizon,
      firstTuningOrigin: tuning[0]?.origin ?? null, lastTuningTarget: tuning.at(-1)?.targetIndex ?? null,
      firstHoldoutOrigin: checked[0]?.origin ?? null, lastHoldoutTarget: checked.at(-1)?.targetIndex ?? null,
      ensembleBrier, baselineBrier,
      skill: baselineBrier !== null && ensembleBrier !== null && baselineBrier > 1e-9 ? 1 - ensembleBrier / baselineBrier : null,
      improvementLower: improvements.length > 1 ? improvement.lower : null, passed: validationPassed,
    },
    diagnostics: {
      structure: fit.structure,
      // Which pool shipped and what it measured on the tuning rows, plus the
      // fitted hyper-parameters of the five extra engines.
      blend: fit.blend,
      extra: fit.extra.diagnostics,
      windows: [{ window: 100, ...stats100 }, { window: 1_000, ...stats1000 }],
      transitionCounts: statistical.markov.counts, transitionMatrix: statistical.markov.matrix,
      ngrams: statistical.ngram.contexts(sequence.digits).map(({ order, context, support }) => ({ order, context, support })),
      regimes: statistical.hmm.emissions.map((emission, state) => {
        const center = sum(emission.map((p, digit) => p * digit));
        return { state, probability: hmmPosterior[state], mean: center, variance: sum(emission.map((p, digit) => p * (digit - center) ** 2)), persistence: statistical.hmm.transition[state][state] };
      }),
      hmmIterations: statistical.hmm.iterations,
      streaks: RESEARCH_BARRIERS.map((barrier) => streakDiagnostics(sequence.digits.slice(-1_000), barrier)),
      trend: trendMetrics(sequence.digits),
      patterns: statistical.patterns.matches(sequence.digits).map(({ template, support, probabilities }) => ({ template, support, probabilities })),
      arima: { p: statistical.timeSeries.arima.p, d: statistical.timeSeries.arima.d, q: 1, innovationVariance: statistical.timeSeries.arima.innovationVariance, aic: statistical.timeSeries.arima.aic },
      garch: { omega: statistical.timeSeries.garch.omega, alpha: statistical.timeSeries.garch.alpha, beta: statistical.timeSeries.garch.beta, forecastVariance: timeForecast.variance, forecastMean: timeForecast.center },
      ml: {
        lstm: { samples: lstm.samples, epochs: lstm.epochs, sequenceLength: lstm.sequenceLength, hiddenUnits: lstm.hiddenUnits, parameters: lstm.parameters, initialLoss: lstm.initialLoss, finalLoss: lstm.finalLoss },
        boosting: { samples: boosting.samples, rounds: boosting.rounds, depth: boosting.depth, features: boosting.features, initialLoss: boosting.initialLoss, finalLoss: boosting.finalLoss },
      },
    },
  };
}

/** Strict Over/Under research report (barriers 1–8), unchanged public contract. */
export function runOverUnderEnsemble(observations: DigitObservation[], horizon: number, contracts: OverUnderContract[], onProgress?: EnsembleProgress) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 100) throw new Error('Over/Under research requires a tick horizon from 1 to 100.');
  if (observations.length < 500) throw new Error('At least 500 validated observations are required.');
  if (contracts.some((contract) => !RESEARCH_BARRIERS.includes(contract.barrier as typeof RESEARCH_BARRIERS[number]) || !['DIGITOVER', 'DIGITUNDER'].includes(contract.contractType))) throw new Error('Research barriers must be integers from 1 to 8.');
  const fit = fitDigitEnsemble(observations, horizon, onProgress);
  return buildEnsembleReport(fit, scoreDigitCandidates(fit, contracts));
}
