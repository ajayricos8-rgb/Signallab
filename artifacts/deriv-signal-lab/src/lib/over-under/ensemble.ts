import type { DigitObservation } from '../digit-analysis.ts';
import { assessExpectedValue, discountedEdgeProbability, evidenceReliability, type EvAssessment, type EvBand } from '../ev-confidence.ts';
import { brier, clamp, countsOf, distributionStats, improvementSummary, mean, mix, normalize, smooth, sum, UNIFORM, variance } from './math.ts';
import { ENGINE_FAMILIES, prefix, streakDiagnostics, trendMetrics, type EngineFamily, type FittedEngine, type Forecast, type Sequence } from './features.ts';
import { fitStatisticalEngines } from './statistical-models.ts';
import { fitBoosting, fitLstm } from './ml-models.ts';
import { marketStructure } from './structure.ts';

export const RESEARCH_BARRIERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type OverUnderContract = { family: 'over-under'; contractType: 'DIGITOVER' | 'DIGITUNDER'; barrier: number };
export type EngineEvidence = {
  id: string; family: EngineFamily; label: string;
  probabilities: number[] | null; support: number; note: string;
  tuningSample: number; tuningBrier: number | null; tuningSkill: number | null;
  weight: number; status: 'contributing' | 'no-skill' | 'sparse';
};
export type OverUnderCandidateScore = {
  contract: OverUnderContract;
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
  /** EV-derived assessment of this barrier at the ensemble probability. */
  ev: EvAssessment | null;
};

/**
 * The barrier and direction the combined engines predict, with the EV-derived
 * confidence behind it. A prediction is produced for every scan that has at
 * least one supported contract; the strict eligibility gates stay visible as
 * `caveats` instead of suppressing the prediction entirely.
 */
export type OverUnderPrediction = {
  contract: OverUnderContract;
  direction: 'OVER' | 'UNDER';
  barrier: number;
  probability: number;
  baselineProbability: number;
  uniformProbability: number;
  equalityProbability: number;
  lift: number;
  agreement: number;
  dispersion: number;
  supportingFamilies: number;
  contributingEngines: number;
  totalEngines: number;
  /** LSTM and boosted-classifier contributions inside the ensemble. */
  deepEngines: number;
  validationSample: number;
  validationSkill: number | null;
  conservativeProbability: number | null;
  /** EV confidence at the conservative probability (headline figure). */
  confidence: number;
  /** EV confidence at the point probability, for comparison. */
  pointConfidence: number;
  band: EvBand;
  expectedValuePerStake: number;
  breakEvenProbability: number;
  payoutMultiple: number;
  ev: EvAssessment | null;
  grade: 'gated' | 'research';
  caveats: string[];
  /** Highest-weighted engines that support this exact contract. */
  supportingEngines: { id: string; label: string; family: EngineFamily; weight: number; probability: number }[];
};

export type OverUnderReport = ReturnType<typeof runOverUnderEnsemble>;

type Evaluation = { origin: number; targetIndex: number; target: number; baseline: number[]; forecasts: Forecast[]; context: Sequence };

export function contractProbability(probabilities: readonly number[], contract: OverUnderContract): number {
  return sum(probabilities.filter((_, digit) => contract.contractType === 'DIGITOVER' ? digit > contract.barrier : digit < contract.barrier));
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

function combine(forecasts: Forecast[], weights: number[], baseline: number[], context: Sequence) {
  const usable = weights.map((weight, index) => forecasts[index].probabilities ? weight : 0);
  const total = sum(usable);
  if (total <= 0) return { probabilities: baseline, effectiveWeights: usable, baselineWeight: 1 };
  const effectiveWeights = usable.map((weight) => weight / total);
  const model = normalize(UNIFORM.map((_, digit) => sum(forecasts.map((forecast, index) => (forecast.probabilities?.[digit] ?? 0) * effectiveWeights[index]))));
  const information = distributionStats(context.digits.slice(-1_000));
  // High entropy with little compressible structure increases shrinkage, not a
  // directional vote. A uniform histogram can still have a repeating sequence.
  const baselineWeight = 0.12 + 0.18 * (information.normalizedEntropy ?? 1) * clamp(information.compression.ratio, 0, 1);
  return { probabilities: mix(model, baseline, 1 - baselineWeight), effectiveWeights, baselineWeight };
}

/**
 * One bounded, CPU-only research scan. Train / tune / held-out chronology is
 * purged at each label boundary; no fit or weight ever sees a holdout target.
 * Evaluation origins are spaced by the selected tick horizon. This reduces
 * overlapping outcomes but does NOT establish independence or profitability.
 */
export function runOverUnderEnsemble(observations: DigitObservation[], horizon: number, contracts: OverUnderContract[]) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 100) throw new Error('Over/Under research requires a tick horizon from 1 to 100.');
  if (observations.length < 500) throw new Error('At least 500 validated observations are required.');
  if (contracts.some((contract) => !RESEARCH_BARRIERS.includes(contract.barrier as typeof RESEARCH_BARRIERS[number]) || !['DIGITOVER', 'DIGITUNDER'].includes(contract.contractType))) throw new Error('Research barriers must be integers from 1 to 8.');
  const window = observations.slice(-2_000);
  const symbol = window[0].symbol;
  if (window.some((tick, index) => !Number.isInteger(tick.digit) || tick.digit < 0 || tick.digit > 9 || tick.symbol !== symbol || !Number.isFinite(tick.epoch) || (index > 0 && tick.epoch < window[index - 1].epoch))) throw new Error('Research requires one chronological, validated digit stream.');
  const sequence: Sequence = { digits: window.map((tick) => tick.digit), epochs: window.map((tick) => tick.epoch) };
  const trainEnd = Math.floor(window.length * 0.6);
  const tuningEnd = Math.floor(window.length * 0.8);
  const train = prefix(sequence, trainEnd);
  const structure = marketStructure(train.digits, sequence.digits.slice(tuningEnd));
  const statistical = fitStatisticalEngines(train, horizon);
  const lstm = fitLstm(train, horizon);
  const boosting = fitBoosting(train, horizon);
  const engines: FittedEngine[] = [...statistical.engines, lstm.engine, boosting.engine];
  const evaluate = (start: number, end: number): Evaluation[] => {
    const rows: Evaluation[] = [];
    for (let origin = start; origin + horizon < end; origin += horizon) {
      const context = prefix(sequence, origin + 1);
      rows.push({ origin, targetIndex: origin + horizon, target: sequence.digits[origin + horizon], baseline: baselineForecast(context), forecasts: engines.map((engine) => engine.predict(context, horizon)), context });
    }
    return rows;
  };
  const tuning = evaluate(trainEnd, tuningEnd);
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
  const families = ENGINE_FAMILIES.map((family) => ({ id: family.id, score: mean(engines.map((engine, index) => engine.family === family.id ? tuningScores[index].strength : -1).filter((value) => value >= 0)) }));
  const familyWeights = cappedFamilyWeights(families);
  const weights = engines.map((engine, index) => {
    const total = sum(engines.map((member, memberIndex) => member.family === engine.family ? tuningScores[memberIndex].strength : 0));
    return total ? (familyWeights.get(engine.family) ?? 0) * tuningScores[index].strength / total : 0;
  });
  const checked = holdout.map((row) => ({ ...row, ensemble: combine(row.forecasts, weights, row.baseline, row.context).probabilities }));
  const improvements = checked.map((row) => brier(row.baseline, row.target) - brier(row.ensemble, row.target));
  const improvement = improvementSummary(improvements);
  const baselineBrier = checked.length ? mean(checked.map((row) => brier(row.baseline, row.target))) : null;
  const ensembleBrier = checked.length ? mean(checked.map((row) => brier(row.ensemble, row.target))) : null;
  const validationPassed = checked.length >= 30 && improvement.lower > 0;
  const liveForecasts = engines.map((engine) => engine.predict(sequence, horizon));
  const baseline = baselineForecast(sequence);
  const current = combine(liveForecasts, weights, baseline, sequence);
  const engineEvidence: EngineEvidence[] = engines.map((engine, index) => ({
    id: engine.id, family: engine.family, label: engine.label,
    probabilities: liveForecasts[index].probabilities, support: liveForecasts[index].support,
    note: liveForecasts[index].note ?? '',
    tuningSample: tuningScores[index].sample, tuningBrier: tuningScores[index].loss, tuningSkill: tuningScores[index].skill,
    weight: current.effectiveWeights[index] * (1 - current.baselineWeight),
    status: !liveForecasts[index].probabilities || tuningScores[index].sample < 30 ? 'sparse' : weights[index] > 0 ? 'contributing' : 'no-skill',
  }));
  const candidates: OverUnderCandidateScore[] = contracts.map((contract) => {
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
      const won = Number(contract.contractType === 'DIGITOVER' ? row.target > contract.barrier : row.target < contract.barrier);
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
      ? 'Recent digit frequencies or transitions have shifted away from the fitted market structure. Refit on a newer window before using a barrier.'
      : 'Insufficient recent observations to check market structure.');
    if (tuning.length < 30 || checked.length < 30) reasons.push(`Need 30 non-overlapping tuning and holdout outcomes; have ${tuning.length} / ${checked.length}.`);
    if (!validationPassed) reasons.push('The combined model did not establish held-out improvement over rolling frequency.');
    if (binaryImprovement.lower <= 0) reasons.push('This barrier failed the conservative held-out Brier improvement check.');
    if (lift < 0.02) reasons.push('Estimated lift over the current frequency baseline is below 2 percentage points.');
    if (supportingFamilies < 3 || agreement < 0.65) reasons.push('Fewer than three engine families agree, or weighted agreement is below 65%.');
    if (dispersion > 0.18) reasons.push('Engine probability estimates disagree too widely.');
    const score = lift / Math.sqrt(Math.max(0.01, baselineProbability * (1 - baselineProbability))) * (0.25 + 0.75 * Math.max(0, validationSkill ?? 0)) - 0.25 * dispersion;
    // The strict eligibility reasons stay in `reasons`; the EV assessment below
    // never hides them, it only supplies a confidence for the prediction.
    const reliability = evidenceReliability({
      validationSkill, agreement, supportingFamilies, dispersion,
      sample: checked.length,
      sampleTarget: 60,
      structureStable: structure.status !== 'shifted',
    });
    // Zero-margin fair price for this contract: the rolling-frequency baseline
    // when it is usable, otherwise the uniform 10-digit baseline.
    const referenceProbability = baselineProbability > 0.001 && baselineProbability < 0.999
      ? baselineProbability
      : contractProbability(UNIFORM, contract);
    // The conservative win probability discounts the ensemble's edge over the
    // reference by its own sampling error (± one-sided 95 %), using the held-out
    // block as the sample, so noise cannot buy a strong EV confidence.
    const conservative = discountedEdgeProbability({
      probability,
      referenceProbability,
      sample: binaryLoss.length,
      referenceSample: Math.min(1_000, sequence.digits.length),
    }) ?? probability;
    const ev = assessExpectedValue({ probability, referenceProbability, conservativeProbability: conservative, reliability });
    return {
      contract, probability, baselineProbability, uniformProbability: contractProbability(UNIFORM, contract), equalityProbability: current.probabilities[contract.barrier],
      lift, agreement, dispersion, supportingFamilies,
      validationSample: checked.length, validationBrier, validationBaselineBrier, validationSkill,
      validationImprovementLower: binaryLoss.length > 1 ? binaryImprovement.lower : null,
      score, eligible: reasons.length === 0, reasons, ev,
    };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.contract.barrier - b.contract.barrier || a.contract.contractType.localeCompare(b.contract.contractType));
  const selected = candidates.find((candidate) => candidate.eligible) ?? null;
  // The prediction is the barrier/direction with the highest value per unit
  // staked — the conservative expected value first, then the point estimate —
  // ranked independently of the strict gates so a scan always yields a usable
  // signal. The gates stay visible on the prediction as `caveats`.
  const predictionValue = (candidate: OverUnderCandidateScore) =>
    candidate.ev?.conservativeExpectedValuePerStake ?? candidate.ev?.expectedValuePerStake ?? candidate.score * 0.01;
  const rankedForPrediction = [...candidates].sort((a, b) =>
    predictionValue(b) - predictionValue(a)
    || (b.ev?.confidence ?? 0) - (a.ev?.confidence ?? 0)
    || b.score - a.score
    || a.contract.barrier - b.contract.barrier
    || a.contract.contractType.localeCompare(b.contract.contractType));
  const best = rankedForPrediction[0] ?? null;
  const contributing = engineEvidence.filter((engine) => engine.weight > 0 && engine.probabilities);
  const prediction: OverUnderPrediction | null = best ? {
    contract: best.contract,
    direction: best.contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER',
    barrier: best.contract.barrier,
    probability: best.probability,
    baselineProbability: best.baselineProbability,
    uniformProbability: best.uniformProbability,
    equalityProbability: best.equalityProbability,
    lift: best.lift,
    agreement: best.agreement,
    dispersion: best.dispersion,
    supportingFamilies: best.supportingFamilies,
    contributingEngines: contributing.length,
    totalEngines: engines.length,
    deepEngines: contributing.filter((engine) => engine.family === 'ml').length,
    validationSample: best.validationSample,
    validationSkill: best.validationSkill,
    conservativeProbability: best.ev?.conservativeProbability ?? null,
    confidence: best.ev?.confidence ?? 0.5,
    pointConfidence: best.ev?.pointConfidence ?? 0.5,
    band: best.ev?.band ?? 'low',
    expectedValuePerStake: best.ev?.expectedValuePerStake ?? 0,
    breakEvenProbability: best.ev?.breakEvenProbability ?? best.baselineProbability,
    payoutMultiple: best.ev?.payoutMultiple ?? (best.baselineProbability > 0 ? 1 / best.baselineProbability : 0),
    ev: best.ev,
    grade: best.eligible ? 'gated' : 'research',
    caveats: best.reasons,
    supportingEngines: contributing
      .filter((engine) => contractProbability(engine.probabilities!, best.contract) > best.baselineProbability)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
      .map((engine) => ({ id: engine.id, label: engine.label, family: engine.family, weight: engine.weight, probability: contractProbability(engine.probabilities!, best.contract) })),
  } : null;
  const stats100 = distributionStats(sequence.digits.slice(-100));
  const stats1000 = distributionStats(sequence.digits.slice(-1_000));
  const hmmPosterior = statistical.hmm.posterior(sequence.digits);
  const timeForecast = statistical.timeSeries.forecast(sequence, horizon, true);
  return {
    symbol, sample: sequence.digits.length, asOfEpoch: sequence.epochs.at(-1)!, horizon,
    probabilities: current.probabilities, baselineProbabilities: baseline,
    baselineWeight: current.baselineWeight,
    engines: engineEvidence, candidates, selected, prediction,
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
      structure,
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
