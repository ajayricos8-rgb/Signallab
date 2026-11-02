import { ENGINE_CATALOG } from './catalog.ts';
import { measureEngines } from './measurements.ts';
import { finite, mean, ratio, runs, standardDeviation, sum } from './math.ts';
import { wilsonInterval } from '../signal-engine/stats.ts';
import type { EngineVote } from '../signal-engine/confidence.ts';
import type { EntryPlan } from '../signal-engine/entry.ts';
import type { EngineLabReport, EngineStatus, LabContract, LabHorizon, LabTick, ResearchAudit, ResearchDecision, SettledReturn, ToolFamily } from './types.ts';
import type { ResearchFusion } from './fusion.ts';

export type EngineLabInput = {
  symbol: string;
  family: ToolFamily;
  ticks: readonly LabTick[];
  contract: LabContract;
  horizon: LabHorizon;
  fresh: boolean;
  audit: ResearchAudit;
  decision: ResearchDecision;
  legacy: {
    probability: number;
    fair: number;
    confidence: number;
    votes: readonly EngineVote[];
    confirmationStatus: string;
    confirmed: boolean;
    entry: EntryPlan;
  };
  candidates: Array<{ label: string; probability: number; fair: number; confidence: number }>;
  /** Actual settled returns, prefiltered to this market/family/account. Never simulated 1:1 payouts. */
  settlements?: readonly SettledReturn[];
  settlementCurrency?: string;
  /** What the research ensemble contributed to the traded signal, when it ran. */
  fusion?: ResearchFusion | null;
};

/** Accounting-only metrics; undefined denominators stay null, never fake perfect scores. */
export function settledPerformance(input: readonly SettledReturn[]) {
  const trades = input.filter((trade) => Number.isFinite(trade.epoch) && Number.isFinite(trade.stake) && trade.stake > 0 && Number.isFinite(trade.profit)).slice().sort((a, b) => a.epoch - b.epoch);
  const returns = trades.map((trade) => trade.profit / trade.stake);
  const profits = trades.map((trade) => trade.profit);
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const profit of profits) { equity += profit; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  const grossProfit = sum(profits.filter((value) => value > 0));
  const grossLoss = -sum(profits.filter((value) => value < 0));
  const downside = returns.length ? Math.sqrt(mean(returns.map((value) => Math.min(0, value) ** 2))) : 0;
  return {
    sample: trades.length,
    expectancy: trades.length ? mean(returns) : null,
    profitFactor: trades.length ? ratio(grossProfit, grossLoss) : null,
    maxDrawdown: trades.length ? drawdown : null,
    recoveryFactor: trades.length ? ratio(sum(profits), drawdown) : null,
    sharpe: trades.length >= 2 ? ratio(mean(returns), standardDeviation(returns)) : null,
    sortino: trades.length >= 2 ? ratio(mean(returns), downside) : null,
  };
}

export function buildEngineLabReport(input: EngineLabInput): EngineLabReport {
  const { audit, decision, legacy } = input;
  // Causal replay probabilities are internal teacher features for Forge, not
  // audit telemetry. Keep the public report to its evaluated holdout rows.
  const { replay: _forgeReplay, ...publicResearch } = audit;
  const { readings, put, missing, ticks, sample } = measureEngines(input);
  const n = audit.sample;
  const rows = audit.rows;
  const called = rows.filter((row) => row.called);
  const wins = sum(called.map((row) => row.won));
  const hitRate = called.length ? wins / called.length : null;
  const hitInterval = called.length ? wilsonInterval(wins, called.length) : null;
  const legacyWeight = sum(legacy.votes.filter((vote) => vote.vote !== 'abstain').map((vote) => vote.weight));
  const legacyAgreement = legacyWeight ? sum(legacy.votes.filter((vote) => vote.vote === 'agree').map((vote) => vote.weight)) / legacyWeight : 0;
  const above = audit.models.filter((model) => model.probability > audit.fair + 0.005);
  const agreement = sum(above.map((model) => model.weight));
  const confluence = new Set(above.map((model) => model.family)).size;
  const probabilities = audit.models.map((model) => model.probability);
  const contradicted = decision.edgeMultiplier < 1;
  const thirds = [0, 1, 2].map((part) => {
    const chunk = rows.slice(Math.floor(part * n / 3), Math.floor((part + 1) * n / 3));
    const loss = chunk.length ? mean(chunk.map((row) => (row.probability - row.won) ** 2)) : null;
    const fairLoss = chunk.length ? mean(chunk.map((row) => (audit.fair - row.won) ** 2)) : null;
    return loss !== null && fairLoss !== null && fairLoss > 0 ? 1 - loss / fairLoss : null;
  });
  const material = Math.max(0.005, 0.01 * legacy.fair);
  const validatedNote = audit.validated ? 'Independent research validation passed.' : 'Research forecast is descriptive only: independent validation has not passed; it cannot boost this signal.';
  put(219, legacyAgreement, legacy.votes.length, `Legacy agreement ${(legacyAgreement * 100).toFixed(1)}%; research agreement ${(agreement * 100).toFixed(1)}%. Kept separate; 300 catalog entries are not 300 votes.`);
  put(220, audit.rawProbability, audit.tuningSample, 'Raw research probability, using normalized per-family budgets.', { weights: audit.weights });
  put(221, audit.models.map((model) => `${model.id} ${(100 * model.weight).toFixed(1)}%`).join(' · '), audit.tuningSample, 'Contract-specific weights fit only on tuning outcomes; calibration/test rows cannot change them.');
  put(222, legacy.confidence, n, `Final evidence score, not win probability. Contradiction penalty policy: ${decision.confidencePenalty} points; the core confidence also uses the reduced edge.`);
  put(223, confluence, audit.models.length, 'Count of distinct research-model families supporting an edge, not a significance test.');
  put(224, ratio(legacy.probability - legacy.fair, Math.sqrt(legacy.fair * (1 - legacy.fair))), n, 'Normalized calibrated contract edge. A high raw hit rate for an easy barrier is not an advantage.');
  put(225, audit.skill, n, `${validatedNote} Skill = 1 − held-out Brier / baseline Brier.`);
  put(226, hitInterval?.lower ?? null, called.length, '95% Wilson interval of non-overlapping called research outcomes; selection uncertainty is additionally handled by #238.', { lower: hitInterval?.lower ?? null, upper: hitInterval?.upper ?? null });
  put(227, thirds.every((value) => value !== null) ? thirds.filter((value) => value! > 0).length / 3 : null, n, 'Share of chronological holdout thirds beating baseline Brier. Diagnostic, never used to choose test rows.', { skills: thirds });
  put(229, agreement, audit.models.length, 'Research-model weight above baseline; correlated frequency models share one family budget.');
  put(230, Number(contradicted), n, contradicted ? 'Validated research opposes the base call; execution is observation-only.' : 'No independently validated research contradiction; unvalidated disagreement is not treated as evidence.');
  put(231, decision.edgeMultiplier, n, 'Multiplier applied to the legacy edge only when independently validated research contradicts it; supportive forecasts cannot inflate it.');
  put(232, legacy.confirmationStatus, n, `Base confirmation: ${legacy.confirmationStatus}. ${validatedNote}`);
  put(233, Number(decision.eligible), n, decision.reasons.join(' '));
  put(234, decision.action, n, decision.reasons.join(' '));
  put(235, Number(!decision.eligible), n, '1 = do not automatically load this signal into the bot. The ranked candidate remains visible for inspection.');
  put(236, Number(legacy.probability - legacy.fair < material), n, `1 = weak edge. Required edge ${(100 * material).toFixed(2)} percentage points above the appropriate baseline.`);
  put(237, Number(!audit.validated), n, validatedNote);
  put(238, audit.correctedP, n, 'One-sided paired Brier-loss test, corrected for candidate pool × research-model count. Descriptive estimates cannot bypass this gate.', { rawZ: audit.improvementZ, candidatePool: audit.selectionPool, modelCount: audit.models.length });
  put(239, legacy.entry.mode, legacy.entry.sample, legacy.entry.detail, { windowTicks: legacy.entry.windowTicks, expectedWaitTicks: legacy.entry.expectedWaitTicks });
  put(240, legacy.entry.measured ? legacy.entry.validation?.gainPts ?? null : 0, legacy.entry.validation?.sample ?? 0,
    legacy.entry.measured ? 'Entry timing measured on a later validation slice.' : 'No validated waiting benefit: immediate entry is the base timing policy, NOT permission to trade an observation-only signal.',
    { reachRate: legacy.entry.validation?.reachRate ?? null, phase: legacy.entry.validation?.phase ?? 'no measured trigger' });
  for (const [id, key] of [[241, 'short'], [242, 'medium'], [243, 'long']] as const) {
    const model = audit.models.find((entry) => entry.id === key)!;
    put(id, model.probability, audit.tuningSample, `${model.name}; direct selected-expiry outcome estimate, before calibration. ${validatedNote}`);
  }
  put(244, audit.nextTickProbability, sample.digits || Math.max(0, sample.quotes - 1), 'One-tick multi-window diagnostic. It is not calibrated using another duration’s outcomes.');
  put(245, input.horizon.unit === 'ticks' && input.horizon.value === 1 ? null : audit.rawProbability, n, `Direct terminal outcome at ${input.horizon.value} ${input.horizon.unit}; not probability of any hit along the path.`);
  put(246, mean(probabilities.slice(0, 3)), audit.tuningSample, 'Short/medium/long probability average, before separate calibration.');
  put(247, audit.probability, n, validatedNote);
  put(248, audit.rawProbability, audit.tuningSample, 'Tuning-weighted raw prediction; weights frozen through calibration and holdout.');
  const candidateRanking = input.candidates.map((candidate) => ({ ...candidate, normalizedEdge: (candidate.probability - candidate.fair) / Math.sqrt(Math.max(1e-12, candidate.fair * (1 - candidate.fair))) })).sort((a, b) => b.confidence - a.confidence || b.normalizedEdge - a.normalizedEdge);
  put(249, candidateRanking.map((candidate) => candidate.label).join(' > '), candidateRanking.length, 'Available candidates ranked by evidence score then normalized edge, not raw success frequency.');
  if (input.contract.family === 'rise-fall') {
    const other = Math.max(0, 2 * legacy.fair - legacy.probability);
    const rise = input.contract.direction === 'RISE' ? legacy.probability : other;
    const fall = input.contract.direction === 'FALL' ? legacy.probability : other;
    put(250, rise === fall ? 'RISE = FALL' : rise > fall ? 'RISE > FALL' : 'FALL > RISE', n,
      'Strict direction probabilities from the selected confirmed estimate and its same-sample flat mass. Flat expiry loses both sides.',
      { rise, fall, flat: Math.max(0, 1 - 2 * legacy.fair) });
  } else put(250, 'not applicable', 0, 'Rise/Fall direction ranking does not predict this terminal-digit contract.', undefined, true);
  // Ranking contract candidates is not a hidden full probability vector. For matches
  // this is all ten targets; for other families it is the actual supported outcomes.
  put(251, input.candidates.slice().sort((a, b) => b.probability - a.probability).map((candidate) => candidate.label).join(' > '), input.candidates.length, 'Raw estimated probability ordering of the actual candidates; this is not the evidence ranking used to choose trades.');
  put(252, agreement, audit.models.length, 'Research agreement; a group of correlated measurements does not get extra voting weight.');
  put(253, standardDeviation(probabilities), audit.models.length, 'SD of current research-model probabilities.', { holdoutProbabilitySD: n ? standardDeviation(rows.map((row) => row.probability)) : null });
  put(254, Number((probabilities[0] - audit.fair) * (probabilities[2] - audit.fair) < 0), audit.tuningSample, 'One if short-window and long-window event edges oppose each other; not an instruction to reverse.');
  put(255, probabilities[0] - probabilities[1], audit.tuningSample, 'Short-minus-medium selected-event probability.');
  put(256, n, n, 'Every research forecast is generated only from outcomes settled at its origin. No prices after that origin are visible to its predictor.');
  const recent = rows.slice(-30);
  put(257, recent.length ? mean(recent.map((row) => (row.probability - row.won) ** 2)) : null, recent.length, 'Latest independent holdout Brier score, without tuning on these rows.');
  put(258, `${audit.tuningSample} tune / ${audit.calibrationSample} calibrate / ${n} test`, n, 'Expanding training prefixes; non-overlapping outcome intervals; labels crossing phase boundaries are purged.', audit.boundaries);
  put(259, n, n, `Final holdout begins at origin ${audit.boundaries.holdoutStart}; no model or calibration selection from this slice.`);
  put(260, hitRate, called.length, 'Called research outcomes only, not all ticks and not realized account returns.');
  put(261, hitRate === null ? null : 1 - hitRate, called.length, 'Losses among called research outcomes. Flat Rise/Fall expiries lose both strict directions.');
  const classifications = rows.map((row) => ({ predicted: row.probability >= 0.5, actual: row.won === 1 }));
  const tp = classifications.filter((row) => row.predicted && row.actual).length;
  const fp = classifications.filter((row) => row.predicted && !row.actual).length;
  const fn = classifications.filter((row) => !row.predicted && row.actual).length;
  put(262, n ? classifications.filter((row) => row.predicted === row.actual).length / n : null, n, 'Binary event accuracy at 0.5. On rare matches, always predicting non-match can look accurate without a trading edge.');
  put(263, ratio(tp, tp + fp), n, 'Binary classification precision at 0.5; null if no predicted positives.');
  put(264, ratio(tp, tp + fn), n, 'Binary classification recall at 0.5; null if no actual positives.');
  const accounting = settledPerformance(input.settlements ?? []);
  if (accounting.sample) {
    const details = `Loaded actual settled trades for this market/family and the account active at scan time. Currency: ${input.settlementCurrency || 'not specified'}. External charges are not inferred. Not the research replay; not annualized. Rerun after changing accounts. A short session is not proof of profitability.`;
    put(265, accounting.expectancy, accounting.sample, `Mean net profit per stake. ${details}`);
    put(266, accounting.profitFactor, accounting.sample, `Gross profit / gross loss; undefined without losses. ${details}`);
    put(267, accounting.maxDrawdown, accounting.sample, `Additive P&L drawdown in account currency. ${details}`);
    put(268, accounting.recoveryFactor, accounting.sample, `Net P&L / absolute currency drawdown. ${details}`);
    put(269, accounting.sharpe, accounting.sample, `Mean per-trade net return / sample SD, zero benchmark. ${details}`);
    put(270, accounting.sortino, accounting.sample, `Mean per-trade net return / downside deviation about zero. ${details}`);
  } else missing([265, 266, 267, 268, 269, 270], 'No actual settled, scoped stake/P&L history supplied. Payouts, profitability and risk ratios cannot be inferred from tick hit rates.');
  const runList = runs(called.map((row) => row.won));
  put(271, called.length ? Math.max(0, ...runList.filter((run) => run.state === 1).map((run) => run.length)) : null, called.length, 'Maximum win run among called, non-overlapping research outcomes.');
  put(272, called.length ? Math.max(0, ...runList.filter((run) => run.state === 0).map((run) => run.length)) : null, called.length, 'Maximum loss run among called, non-overlapping research outcomes.');
  put(273, runList.length, called.length, 'Latest run is unfinished and excluded from completed distributions.', { wins: runList.slice(0, -1).filter((run) => run.state === 1).map((run) => run.length), losses: runList.slice(0, -1).filter((run) => run.state === 0).map((run) => run.length) });
  put(274, hitRate, called.length, 'Called-outcome hit rate; shares evidence with #260, not another vote.');
  put(275, hitRate === null ? null : 1 - hitRate, called.length, 'Called-outcome failure rate; shares evidence with #261.');
  put(276, audit.calibrationError, n, 'Weighted absolute reliability-bin error on final holdout. Brier loss measures calibration AND discrimination.', { brier: audit.brier, binSamples: audit.bins.map((bin) => bin.sample), predicted: audit.bins.map((bin) => bin.predicted), observed: audit.bins.map((bin) => bin.observed) });
  put(277, audit.brier, n, 'Per-model final-test losses are reported, never used to select weights.', { losses: audit.models.map((model) => model.holdoutBrier) });
  put(278, audit.models.slice().sort((a, b) => (a.tuningBrier ?? Infinity) - (b.tuningBrier ?? Infinity)).map((model) => model.id).join(' > '), audit.tuningSample, 'Ranking uses older tuning Brier, not final-test performance.');
  put(279, audit.rawProbability, audit.tuningSample, 'Learned family-balanced linear probability pool. This is not 300 neural networks.');
  put(280, audit.weights.reduce((total, weight) => total + Math.abs(weight - 1 / audit.weights.length), 0), audit.tuningSample, 'L1 distance from equal individual-model weights. Family budgets and tuning reliability both shape it.');
  put(281, sum(audit.models.map((model) => model.probability * model.bayesianWeight)), audit.tuningSample, 'Equal-prior Bayesian likelihood pool, in log space. Diagnostic alternative only; not added as a correlated extra vote.', { weights: audit.models.map((model) => model.bayesianWeight) });
  put(282, audit.tuningSample ? audit.selectedModel : null, audit.tuningSample, 'Lowest tuning loss; no holdout-based model selection.');
  put(283, audit.regimeModel, audit.regimeSample, 'Best tuning model among the current causal regime; requires ≥20 tuning rows in that regime. Diagnostic alternative only.');
  put(284, legacy.confidence, n, 'Evidence score, NOT a calibrated probability. Probability reliability is measured separately under #276 and #285.');
  put(285, audit.calibrationMethod, audit.calibrationSample, 'Calibrator sees only the middle phase. Isotonic output is mixed 50/50 with raw estimates; insufficient/missing-class calibration uses identity.');
  const ablations = audit.models.filter((model) => model.ablation !== null).slice().sort((a, b) => b.ablation! - a.ablation!);
  put(286, ablations[0]?.id ?? null, n, 'Largest fixed-model ablation loss increase. This is model-feature sensitivity, not causal importance; correlated features can mask each other.', { ablations: audit.models.map((model) => model.ablation) });
  put(287, audit.redundantPairs.length, audit.tuningSample, 'Correlations of tuning probability features, not target leakage. Undefined constant-series correlations remain null, not zero.', { matrix: audit.correlations });
  put(288, audit.redundantPairs.length, audit.tuningSample, 'Pairs with |correlation| ≥0.98. No duplicate catalog entry creates a predictor; models share predeclared family budgets.', { pairs: audit.redundantPairs.map((pair) => pair.join('/')).join(', ') || 'none' });
  put(289, audit.correlations.length, audit.tuningSample, 'Same tuning correlation evidence as #287, shown once in the model table; not another confidence vote.');
  put(290, sum(audit.models.map((model) => model.contribution)), audit.models.length, 'Raw ensemble edge in percentage points; each model contributes weight × edge.', { contributions: audit.models.map((model) => model.contribution) });
  const lead = audit.models.slice().sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))[0];
  put(291, lead?.id ?? null, audit.models.length, `Largest signed raw contribution: ${lead?.contribution.toFixed(3) ?? '—'} points; not causal attribution.`);
  put(292, 0.05 / (audit.selectionPool * audit.models.length), n, 'Required one-sided unadjusted paired-loss p before candidate/model Bonferroni correction.');
  put(293, n ? Math.sqrt(audit.fair * (1 - audit.fair) / n) : null, n, 'No-edge binomial sampling standard error. Non-overlapping holdout exits reduce dependence from shared intervals, but residual serial dependence can still invalidate binomial assumptions.');
  const regimeModel = audit.models.find((model) => model.id === 'regime')!;
  put(294, regimeModel.probability, audit.tuningSample, `Causal regime-conditioned research probability. ${validatedNote}`);
  put(295, audit.tuningSample ? 'tuning-only reweighting' : null, audit.tuningSample, 'Bounded tuning-reliability reweighting, frozen for calibration and holdout. No continuous learning from unsettled trades.');
  put(296, Number(audit.validated), n, 'Needs ≥40 non-overlapping test rows, ≥30 tuning rows, Brier skill >0.005 and corrected one-sided loss p<0.05.');
  put(297, input.fresh ? 'fresh; validation still required' : 'stale; flagged as advice on the run, execution is not blocked', n, 'Anomalies are descriptive and never increase confidence without validated forecasts. The fresh-data gate controls automatic entry.', { anomalyScore: readings.get(19)?.value ?? null, outlierFraction: readings.get(20)?.value ?? null });
  put(298, regimeModel.probability, n, `Regime model holdout skill ${regimeModel.skill === null ? 'unavailable' : (regimeModel.skill * 100).toFixed(2) + '%'}. Same model as #294, not another vote.`);
  put(299, audit.validated ? contradicted ? 'validated conflict' : 'no validated conflict' : 'research unvalidated', n, 'Unvalidated research support does not strengthen the legacy prediction.');
  put(300, decision.action, n, `${decision.reasons.join(' ')} Estimated probability is not profitability; actual proposal economics and account risk limits remain separate.`);

  for (const def of ENGINE_CATALOG.filter((entry) => entry.aliasOf !== undefined)) {
    const original = readings.get(def.aliasOf!);
    if (!original) throw new Error(`Missing alias source ${def.aliasOf}`);
    readings.set(def.id, { ...original, id: def.id, status: 'alias', contribution: null, detail: `Alias of #${def.aliasOf} (${ENGINE_CATALOG[def.aliasOf! - 1].name}). ${original.detail} Not independently counted.` });
  }
  const ordered = ENGINE_CATALOG.map((def) => {
    const reading = readings.get(def.id);
    if (!reading) throw new Error(`Engine #${def.id} has no evaluator; refusing to silently label it implemented.`);
    const usedBy = audit.models.filter((model) => model.engines.includes(def.id)).map((model) => model.name);
    if (usedBy.length) reading.data = { ...reading.data, relatedModels: usedBy.join('; '), relationship: 'Related method/feature family; models learn direct terminal outcomes. This displayed scalar is not necessarily itself a model input.', predictiveUse: audit.validated ? 'Combined research forecast passed holdout validation. This does not individually validate every model or measurement.' : 'Combined research forecast is unvalidated; this reading cannot independently increase the base signal.' };
    // A field can be missing, but non-finite values must never reach a worker message / JSON export.
    return { ...reading, value: typeof reading.value === 'number' ? finite(reading.value) : reading.value };
  });
  const counts: Record<EngineStatus, number> = { active: 0, context: 0, insufficient: 0, unavailable: 0, alias: 0 };
  for (const reading of ordered) counts[reading.status] += 1;
  const warnings = [
    '300 registered measurements, models and policies are not 300 independent predictors. Related entries and aliases do not multiply votes.',
    'Random or synthetic-market patterns can disappear. No engine count, confidence score or backtest guarantees a win.',
    'Hot/cold/overdue digits describe history; a digit is not more likely simply because it has not appeared recently.',
    'Research holdout is chronological and non-overlapping; small samples and residual serial dependence still limit inference.',
  ];
  if (!audit.validated) warnings.push('Research forecasts have not passed independent validation and cannot increase the signal probability or confidence.');
  if (!accounting.sample) warnings.push('No scoped settled P&L supplied: expectancy, profit factor, drawdown, recovery, Sharpe and Sortino are unavailable.');
  if (!sample.quotes) warnings.push('Quote/candle engines abstain because this input contains only verified digits.');
  if (!sample.digits) warnings.push('Digit engines abstain because verified digit precision is unavailable.');
  return { version: '1.0.0', family: input.family, symbol: input.symbol, asOfEpoch: ticks.at(-1)?.epoch ?? null,
    horizon: input.horizon, contract: input.contract, registered: ENGINE_CATALOG.length, counts, readings: ordered,
    research: publicResearch, decision, fusion: input.fusion ?? null, warnings, sample, accounting: { sample: accounting.sample, currency: accounting.sample ? input.settlementCurrency || null : null } };
}
