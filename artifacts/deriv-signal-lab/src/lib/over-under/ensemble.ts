import type { DigitObservation } from '../digit-analysis.ts';
import { brier, clamp, countsOf, distributionStats, improvementSummary, mean, mix, normalize, smooth, sum, UNIFORM, variance } from './math.ts';
import { ENGINE_FAMILIES, prefix, streakDiagnostics, trendMetrics, type EngineFamily, type FittedEngine, type Forecast, type Sequence } from './features.ts';
import { fitStatisticalEngines } from './statistical-models.ts';
import { fitBoosting, fitLstm } from './ml-models.ts';
import { marketStructure } from './structure.ts';
import { confidenceFactor, engineVote, scale, type ConfidenceFactor, type EngineVote } from '../signal-confidence.ts';

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
  /** How the twelve fitted models voted on this exact contract. */
  votes: EngineVote[];
  /** Held-out evidence factors that feed the published confidence score. */
  factors: ConfidenceFactor[];
};

/**
 * The signal every scan publishes. `qualified` keeps the strict held-out gates
 * intact; the candidate itself is always present so the UI can show a signal,
 * its engine agreement and its confidence instead of a bare WAIT.
 */
export type OverUnderSignal = {
  contract: OverUnderContract;
  label: string;
  candidate: OverUnderCandidateScore;
  qualified: boolean;
  enginesAgreed: number;
  enginesTotal: number;
  familiesAgreed: number;
  familiesTotal: number;
  probability: number;
  baselineProbability: number;
  lift: number;
  agreement: number;
  reasons: string[];
};

export type OverUnderReport = ReturnType<typeof runOverUnderEnsemble>;

/** Progress reporter so the UI can show a real percentage while models fit. */
export type EnsembleProgress = (percent: number, phase: string) => void;

type Evaluation = { origin: number; targetIndex: number; target: number; baseline: number[]; forecasts: Forecast[]; context: Sequence };

export function contractProbability(probabilities: readonly number[], contract: OverUnderContract): number {
  return sum(probabilities.filter((_, digit) => contract.contractType === 'DIGITOVER' ? digit > contract.barrier : digit < contract.barrier));
}

function baselineForecast(context: Sequence): number[] {
  return smooth(countsOf(context.digits.slice(-1_000)));
}

/** Engine families whose supporting weight is at least their opposing weight. */
function supportingFamilyCount(votes: readonly EngineVote[]): number {
  const families = new Map<string, { support: number; oppose: number }>();
  for (const vote of votes) {
    const row = families.get(vote.family) ?? { support: 0, oppose: 0 };
    if (vote.stance === 'support') row.support += vote.weight;
    if (vote.stance === 'oppose') row.oppose += vote.weight;
    families.set(vote.family, row);
  }
  return [...families.values()].filter((row) => row.support > 0 && row.support >= row.oppose).length;
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
export function runOverUnderEnsemble(observations: DigitObservation[], horizon: number, contracts: OverUnderContract[], onProgress?: EnsembleProgress) {
  const report: EnsembleProgress = typeof onProgress === 'function' ? onProgress : () => {};
  report(2, 'Validating the digit stream');
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
  report(6, 'Comparing fitted and live market structure');
  const structure = marketStructure(train.digits, sequence.digits.slice(tuningEnd));
  report(10, 'Fitting Markov, frequency, information, streak, trend, pattern and ARIMA/GARCH engines');
  const statistical = fitStatisticalEngines(train, horizon);
  report(22, 'Training the local LSTM on chronological sequences');
  const lstm = fitLstm(train, horizon);
  report(30, 'Training gradient-boosted classification trees');
  const boosting = fitBoosting(train, horizon);
  const engines: FittedEngine[] = [...statistical.engines, lstm.engine, boosting.engine];
  report(36, `Scoring ${engines.length} engines on the tuning segment`);
  const evaluate = (start: number, end: number, fromPercent: number, toPercent: number, phase: string): Evaluation[] => {
    const rows: Evaluation[] = [];
    const total = Math.max(1, Math.ceil((end - start) / horizon));
    for (let origin = start; origin + horizon < end; origin += horizon) {
      const context = prefix(sequence, origin + 1);
      rows.push({ origin, targetIndex: origin + horizon, target: sequence.digits[origin + horizon], baseline: baselineForecast(context), forecasts: engines.map((engine) => engine.predict(context, horizon)), context });
      if (rows.length % 8 === 0) report(fromPercent + (toPercent - fromPercent) * Math.min(1, rows.length / total), `${phase} · ${rows.length} outcomes`);
    }
    return rows;
  };
  const tuning = evaluate(trainEnd, tuningEnd, 36, 52, 'Chronological tuning evaluation');
  report(52, 'Evaluating the held-out segment');
  const holdout = evaluate(tuningEnd, sequence.digits.length, 52, 68, 'Held-out evaluation');
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
  report(70, `Scoring ${contracts.length} Deriv-supported barriers`);
  const candidates: OverUnderCandidateScore[] = contracts.map((contract, contractIndex) => {
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
    const label = `${contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${contract.barrier}`;
    // Every fitted model votes on this exact contract. Models that abstained on
    // the tuning segment keep weight 0 so they can never inflate agreement.
    const votes: EngineVote[] = engineEvidence.map((engine) => {
      const engineProbability = engine.probabilities ? contractProbability(engine.probabilities, contract) : null;
      if (engineProbability === null) {
        return engineVote({
          id: engine.id, label: engine.label, family: engine.family, stance: 'neutral', strength: 0, weight: 0,
          detail: `${engine.note || 'This model had too little context to forecast.'} It abstains from voting.`,
        });
      }
      const difference = engineProbability - baselineProbability;
      const stance = difference > 0.005 ? 'support' as const : difference < -0.005 ? 'oppose' as const : 'neutral' as const;
      return engineVote({
        id: engine.id, label: engine.label, family: engine.family, stance, strength: scale(Math.abs(difference), 0.05),
        weight: engine.weight,
        detail: `Forecasts ${label} at ${(engineProbability * 100).toFixed(1)}% versus the ${(baselineProbability * 100).toFixed(1)}% rolling baseline${engine.weight > 0 ? ` · ${(engine.weight * 100).toFixed(1)}% ensemble weight from held-out tuning skill` : ' · no ensemble weight (no tuning skill)'}.`,
      });
    });
    const factors: ConfidenceFactor[] = [
      confidenceFactor({
        id: 'model-edge', label: 'Model edge over the rolling baseline', score: scale(lift, 0.05), weight: 0.22,
        detail: `Ensemble estimate ${(probability * 100).toFixed(1)}% versus a ${(baselineProbability * 100).toFixed(1)}% rolling-frequency baseline (${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)} pp).`,
      }),
      confidenceFactor({
        id: 'holdout-skill', label: 'Held-out Brier skill', score: scale(validationSkill ?? 0, 0.08), weight: 0.22,
        detail: validationSkill === null
          ? 'No held-out outcomes were available to measure skill.'
          : `${(validationSkill * 100).toFixed(1)}% Brier skill against the baseline on ${checked.length} held-out outcomes.`,
      }),
      confidenceFactor({
        id: 'holdout-improvement', label: 'Held-out improvement lower bound', score: binaryLoss.length > 1 && binaryImprovement.lower > 0 ? scale(binaryImprovement.lower, 0.02) : 0, weight: 0.16,
        detail: binaryLoss.length > 1
          ? `Conservative lower bound ${binaryImprovement.lower >= 0 ? '+' : ''}${(binaryImprovement.lower * 100).toFixed(2)} pp of Brier improvement per outcome.`
          : 'Too few held-out outcomes to bound the improvement.',
      }),
      confidenceFactor({
        id: 'engine-coherence', label: 'Engine coherence (low dispersion)', score: 1 - scale(dispersion, 0.18), weight: 0.12,
        detail: `Weighted standard deviation of engine estimates is ${(dispersion * 100).toFixed(1)} pp (limit 18 pp).`,
      }),
      confidenceFactor({
        id: 'market-structure', label: 'Market-structure stability', score: structure.status === 'stable' ? 1 : structure.status === 'insufficient' ? 0.4 : 0, weight: 0.14,
        detail: structure.status === 'stable'
          ? 'Fitted and live digit structure agree within the divergence limits.'
          : structure.status === 'insufficient'
            ? 'Not enough recent observations to confirm the structure is unchanged.'
            : 'Digit frequencies or transitions shifted away from the fitted structure.',
      }),
      confidenceFactor({
        id: 'validation-sample', label: 'Non-overlapping validation sample', score: scale(Math.min(tuning.length, checked.length), 60), weight: 0.14,
        detail: `${tuning.length} tuning and ${checked.length} held-out outcomes spaced ${horizon} ticks apart.`,
      }),
    ];
    if ((contractIndex + 1) % 4 === 0) report(70 + 20 * Math.min(1, (contractIndex + 1) / contracts.length), `Scoring barriers · ${contractIndex + 1}/${contracts.length}`);
    return {
      contract, probability, baselineProbability, uniformProbability: contractProbability(UNIFORM, contract), equalityProbability: current.probabilities[contract.barrier],
      lift, agreement, dispersion, supportingFamilies,
      validationSample: checked.length, validationBrier, validationBaselineBrier, validationSkill,
      validationImprovementLower: binaryLoss.length > 1 ? binaryImprovement.lower : null,
      score, eligible: reasons.length === 0, reasons, votes, factors,
    };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.contract.barrier - b.contract.barrier || a.contract.contractType.localeCompare(b.contract.contractType));
  const selected = candidates.find((candidate) => candidate.eligible) ?? null;
  // A completed scan always publishes its best-ranked barrier. Gates still
  // decide whether it is `qualified`; the UI shows both, never a bare WAIT.
  const signal: OverUnderSignal | null = candidates[0] ? {
    contract: candidates[0].contract,
    label: `${candidates[0].contract.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${candidates[0].contract.barrier}`,
    candidate: candidates[0],
    qualified: candidates[0].eligible,
    enginesAgreed: candidates[0].votes.filter((vote) => vote.stance === 'support').length,
    enginesTotal: candidates[0].votes.length,
    familiesAgreed: supportingFamilyCount(candidates[0].votes),
    familiesTotal: ENGINE_FAMILIES.length,
    probability: candidates[0].probability,
    baselineProbability: candidates[0].baselineProbability,
    lift: candidates[0].lift,
    agreement: candidates[0].agreement,
    reasons: candidates[0].reasons,
  } : null;
  report(92, 'Building engine consensus and confidence');
  const stats100 = distributionStats(sequence.digits.slice(-100));
  const stats1000 = distributionStats(sequence.digits.slice(-1_000));
  const hmmPosterior = statistical.hmm.posterior(sequence.digits);
  const timeForecast = statistical.timeSeries.forecast(sequence, horizon, true);
  report(99, 'Finalising diagnostics and the published signal');
  return {
    symbol, sample: sequence.digits.length, asOfEpoch: sequence.epochs.at(-1)!, horizon,
    probabilities: current.probabilities, baselineProbabilities: baseline,
    baselineWeight: current.baselineWeight,
    engines: engineEvidence, candidates, selected, signal,
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
