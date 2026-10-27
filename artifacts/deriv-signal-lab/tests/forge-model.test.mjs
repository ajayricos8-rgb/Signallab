// Layer 8 — the forged model.
//
// The forge is only worth shipping if four properties hold:
//
//   1. KNOWLEDGE — the syllabus is well-formed, covers both contract families,
//      and the market atlas answers for listed and unlisted symbols;
//   2. CAUSALITY — a feature vector at an origin never changes when the future
//      is rewritten, for digits and for quotes;
//   3. HONESTY — it learns a real structure, stays at chance on noise, and its
//      gate is the same one the other layers use (positive Brier and log-loss
//      skill with a paired z above a selection-raised bar);
//   4. SAFETY — with no model, no validation or no weight it leaves the
//      published probability bit-identical; a validated model can only add at
//      most the capped share of the edge, and it can trim or veto but never
//      place a call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGE_KNOWLEDGE, FORGE_KNOWLEDGE_VERSION, FORGE_MARKET_ATLAS, knowledgeFor, marketProfile, summarizeKnowledge,
} from '../src/lib/forge/knowledge.ts';
import {
  FORGE_FEATURE_COUNT, digitContextAt, digitForgeVector, quoteContextAt, quoteForgeVector,
} from '../src/lib/forge/features.ts';
import { splitForgeRows, trainForge } from '../src/lib/forge/train.ts';
import { applyForge, forgeCandidate, forgeEvidence, forgeKnowledgeReport, forgeVetoed } from '../src/lib/forge/forge.ts';
import { FORGE_MAX_WEIGHT, FORGE_MIN_HOLDOUT } from '../src/lib/forge/types.ts';
import { confidenceScore, forgeTerm } from '../src/lib/signal-engine/confidence.ts';
import { analyzeDigitMarket } from '../src/lib/signal-engine/digit-signal.ts';
import { analyzeRiseFallMarket } from '../src/lib/signal-engine/rise-fall-signal.ts';

function sfc32(seed) {
  let a = 0x9e3779b9; let b = 0x243f6a88 + seed; let c = 0xb7e15162; let d = 0x12345678 ^ (seed * 7919);
  const next = () => { a |= 0; b |= 0; c |= 0; d |= 0; const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let index = 0; index < 40; index += 1) next();
  return next;
}

const fairDigits = (seed, length) => {
  const random = sfc32(seed);
  return Array.from({ length }, () => Math.floor(random() * 10));
};

/** A digit stream with real memory: the next digit usually repeats or steps. */
const stickyDigits = (seed, length) => {
  const random = sfc32(seed);
  let digit = 3;
  return Array.from({ length }, () => {
    const draw = random();
    if (draw < 0.45) return digit;
    if (draw < 0.75) { digit = (digit + 1) % 10; return digit; }
    digit = Math.floor(random() * 10);
    return digit;
  });
};

const randomWalk = (seed, length) => {
  const random = sfc32(seed);
  let price = 1_000;
  return Array.from({ length }, (_, index) => {
    price += (random() - 0.5) * 2;
    return { epoch: 1_700_000_000 + index, quote: Math.round(price * 100) / 100 };
  });
};

/** Momentum-persistent quotes: a returns process with positive autocorrelation. */
const trendingWalk = (seed, length) => {
  const random = sfc32(seed);
  let price = 1_000;
  let last = 0;
  return Array.from({ length }, (_, index) => {
    last = 0.75 * last + (random() - 0.5) * 2;
    price += last;
    return { epoch: 1_700_000_000 + index, quote: Math.round(price * 100) / 100 };
  });
};

/* -------------------------------------------------------------------------- */
/* 1. Knowledge                                                               */
/* -------------------------------------------------------------------------- */

test('the knowledge base is a complete, deduplicated syllabus for both families', () => {
  assert.ok(FORGE_KNOWLEDGE.length >= 60, `syllabus has ${FORGE_KNOWLEDGE.length} entries`);
  const ids = new Set();
  for (const entry of FORGE_KNOWLEDGE) {
    assert.ok(!ids.has(entry.id), `duplicate knowledge id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.statement.length > 20, `${entry.id} has a real statement`);
    assert.ok(['feature', 'prior', 'teacher', 'veto', 'gate'].includes(entry.use));
    assert.ok(entry.families.length > 0);
  }
  const digit = knowledgeFor('digit');
  const quote = knowledgeFor('rise-fall');
  const domains = new Set(FORGE_KNOWLEDGE.map((entry) => entry.domain));
  for (const domain of ['contract', 'payout', 'feed', 'statistics', 'structure', 'risk', 'execution', 'market']) {
    assert.ok(domains.has(domain), `syllabus covers ${domain}`);
  }
  // Both families must be taught the hard rules, not only one of them.
  for (const family of [digit, quote]) {
    assert.ok(family.some((entry) => entry.use === 'veto'));
    assert.ok(family.some((entry) => entry.use === 'prior'));
    assert.ok(family.some((entry) => entry.use === 'teacher'));
    assert.ok(family.some((entry) => entry.id.startsWith('contract.')));
  }
  const summary = summarizeKnowledge('digit');
  assert.equal(summary.version, FORGE_KNOWLEDGE_VERSION);
  assert.equal(summary.total, digit.length);
  assert.equal(summary.byDomain.reduce((total, row) => total + row.count, 0), digit.length);
  assert.equal(summary.byUse.reduce((total, row) => total + row.count, 0), digit.length);
  assert.ok(summary.vetoes.length >= 5);
  assert.ok(digit.some((entry) => entry.id === 'market.no-generator-state'));
  assert.ok(digit.some((entry) => entry.id === 'stats.repeated-inspection'));
  assert.ok(quote.some((entry) => entry.id === 'feed.public-research-socket'));
});

test('the market atlas answers for listed and unlisted symbols', () => {
  assert.ok(FORGE_MARKET_ATLAS.length >= 16);
  const volatility = marketProfile('R_100', 'Volatility 100 Index');
  assert.equal(volatility.kind, 'volatility');
  assert.equal(volatility.volatilityClass, 100);
  const oneSecond = marketProfile('1HZ25V', 'Volatility 25 (1s)');
  assert.equal(oneSecond.kind, 'volatility-1s');
  assert.equal(oneSecond.expectedTickMs, 1_000);
  const crash = marketProfile('CRASH1000', 'Crash 1000');
  assert.equal(crash.kind, 'crash-boom');
  assert.deepEqual(crash.suitedTo, ['rise-fall']);
  // An unknown symbol degrades to a parsed profile instead of throwing.
  const unknown = marketProfile('SOMETHING_ELSE', 'Some Market');
  assert.equal(unknown.kind, 'unknown');
  assert.ok(unknown.note.length > 20);
  const report = forgeKnowledgeReport('rise-fall');
  assert.equal(report.inputs, FORGE_FEATURE_COUNT);
  assert.ok(report.markets >= 16);
});

/* -------------------------------------------------------------------------- */
/* 2. Features                                                                */
/* -------------------------------------------------------------------------- */

const baseVectorInput = {
  teacherProbability: 0.62,
  engineValues: [0.6, 0.7, null, 0.55],
  engineWeights: [0.4, 0.3, 0, 0.3],
  baselineProbability: 0.55,
  priorProbability: 0.58,
  fair: 0.5,
  agreeing: 3,
  against: 0,
  voting: 4,
  sample: 220,
  horizonTicks: 3,
  priorSkill: 0.02,
  tickSpacingMs: 2_000,
  dataQuality: 0.9,
  symbol: 'R_100',
  name: 'Volatility 100 Index',
};

test('forge vectors have the declared width and never look at the future', () => {
  const digits = stickyDigits(4, 900);
  const origin = 600;
  const digitVector = digitForgeVector({ ...baseVectorInput, digits, origin });
  assert.equal(digitVector.length, FORGE_FEATURE_COUNT);
  assert.ok(Array.from(digitVector).every((value) => Number.isFinite(value)));
  const rewritten = [...digits.slice(0, origin + 1), ...Array.from({ length: 299 }, (_, index) => (index * 3) % 10)];
  const afterRewrite = digitForgeVector({ ...baseVectorInput, digits: rewritten, origin });
  assert.deepEqual(Array.from(digitVector), Array.from(afterRewrite));

  const ticks = trendingWalk(7, 600);
  const prices = ticks.map((tick) => tick.quote);
  const quoteVector = quoteForgeVector({ ...baseVectorInput, prices, origin: 400 });
  assert.equal(quoteVector.length, FORGE_FEATURE_COUNT);
  assert.ok(Array.from(quoteVector).every((value) => Number.isFinite(value)));
  const rewrittenPrices = [...prices.slice(0, 401), ...prices.slice(401).map((value) => value * 3 + 17)];
  const afterPrices = quoteForgeVector({ ...baseVectorInput, prices: rewrittenPrices, origin: 400 });
  assert.deepEqual(Array.from(quoteVector), Array.from(afterPrices));
  // Too little history is refused rather than padded with zeros.
  assert.equal(digitContextAt(digits, 5).hotZ, 0);
  assert.equal(quoteContextAt(prices, 3).trendZ, 0);
});

test('the market context reports what it measured, not a direction', () => {
  const digits = fairDigits(12, 800);
  const context = digitContextAt(digits, 700);
  assert.ok(context.entropy > 0.5 && context.entropy <= 1);
  assert.ok(Math.abs(context.parity) <= 1);
  const prices = randomWalk(9, 800).map((tick) => tick.quote);
  const quote = quoteContextAt(prices, 700);
  assert.ok(Number.isFinite(quote.varianceRatio));
  assert.ok(Math.abs(quote.position) <= 1);
});

/* -------------------------------------------------------------------------- */
/* 3. Training                                                                */
/* -------------------------------------------------------------------------- */

/** A dataset where the teacher's edge really does predict the outcome. */
function structuredRows(seed, strength = 4, count = 700) {
  const random = sfc32(seed);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const edge = (random() - 0.5) * 0.24;
    const features = new Float64Array(FORGE_FEATURE_COUNT);
    features[0] = 1;
    features[1] = Math.tanh(edge * 20);
    features[2] = edge / 0.1;
    const probability = Math.max(0.02, Math.min(0.98, 0.5 + edge * strength));
    rows.push({ features, label: random() < probability ? 1 : 0, teacher: 0.5 + edge });
  }
  return rows;
}

const SPEC = { inputDim: FORGE_FEATURE_COUNT, hidden: [24, 12], outputs: 2, seed: 0x5eed_f0f6, learningRate: 0.012, l2: 2e-4, epochs: 14, batchSize: 32, patience: 3 };

test('the split is chronological with a purge gap', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ features: new Float64Array(FORGE_FEATURE_COUNT), label: index % 2, teacher: 0.5, origin: index }));
  const split = splitForgeRows(rows, 12);
  assert.equal(split.train.length + split.validation.length + split.holdout.length, 100 - 12 * 2);
  const trainEnd = split.train.at(-1).origin;
  const validationStart = split.validation[0].origin;
  assert.ok(validationStart - trainEnd > 12, 'purge gap separates train from validation');
});

test('the forge learns a real structure and stays at chance on noise', () => {
  const structured = trainForge(structuredRows(5), 0.5, { spec: SPEC, purge: 12, distillation: 0.35 });
  assert.ok(structured, 'a structured stream supports a fit');
  assert.equal(structured.metrics.validated, true, `gate: ${structured.metrics.gate.join(' | ')}`);
  assert.ok(structured.metrics.brierSkill > 0.05, `brier skill ${structured.metrics.brierSkill}`);
  assert.ok(structured.metrics.z >= structured.metrics.zBar, 'z clears its own bar');
  assert.ok(structured.metrics.holdoutRows >= 30);
  assert.ok(structured.weight > 0 && structured.weight <= FORGE_MAX_WEIGHT);
  // A high teacher probability must produce a high forged probability.
  const hot = new Float64Array(FORGE_FEATURE_COUNT);
  hot[0] = 1; hot[1] = Math.tanh(0.08 * 20); hot[2] = 0.8;
  assert.ok(structured.predict(hot, 0.58) > 0.55, 'the model follows a real edge');

  // A single fair generator: the features carry no information about the label.
  const noiseRandom = sfc32(97);
  const noiseRows = [];
  for (let index = 0; index < 700; index += 1) {
    const features = new Float64Array(FORGE_FEATURE_COUNT);
    features[0] = 1;
    for (let position = 1; position < FORGE_FEATURE_COUNT; position += 1) features[position] = (noiseRandom() - 0.5) * 0.6;
    noiseRows.push({ features, label: noiseRandom() < 0.5 ? 1 : 0, teacher: 0.5 });
  }
  const noise = trainForge(noiseRows, 0.5, { spec: SPEC, purge: 12, distillation: 0.35 });
  assert.ok(noise, 'noise still produces a fit (it is reported, not hidden)');
  assert.equal(noise.metrics.validated, false, 'noise never validates');
  assert.equal(noise.weight, 0, 'an unvalidated forge carries no weight');
});

test('the forge is deterministic for a given dataset and seed', () => {
  const rows = structuredRows(21, 4, 420);
  const first = trainForge(rows, 0.5, { spec: SPEC, purge: 12, distillation: 0.35 });
  const second = trainForge(rows, 0.5, { spec: SPEC, purge: 12, distillation: 0.35 });
  assert.ok(first && second);
  const features = new Float64Array(FORGE_FEATURE_COUNT);
  features[0] = 1; features[2] = 0.4;
  assert.equal(first.predict(features, 0.55), second.predict(features, 0.55));
  assert.equal(first.metrics.brierSkill, second.metrics.brierSkill);
});

test('a thin stream is refused instead of fitted on noise', () => {
  assert.equal(trainForge(structuredRows(3, 4, 80), 0.5, { spec: SPEC, purge: 12, distillation: 0.35 }), null);
});

/* -------------------------------------------------------------------------- */
/* 4. Fusion and safety                                                       */
/* -------------------------------------------------------------------------- */

const fakeModel = (overrides = {}) => ({
  card: { id: 'test-forge', name: 'test', version: '1.0.0', task: 'test', family: 'digit', shape: [24, 24, 12, 2], parameters: 10, activation: 'relu', optimizer: 'adam', learningRate: 0.01, l2: 0, distillation: 0.35, epochsRun: 3, epochsPlanned: 3, bestEpoch: 2, temperature: 1, trainRows: 100, validationRows: 40, holdoutRows: 100, seed: 1, license: 'MIT', origin: 'test', runtime: 'test', cost: 'free', knowledgeVersion: 'test', features: [], teachers: [], stages: [] },
  metrics: { trainRows: 100, validationRows: 40, holdoutRows: 100, accuracy: 0.6, baselineAccuracy: 0.5, brier: 0.2, baselineBrier: 0.25, brierSkill: 0.2, z: 4, zBar: 2.9, logLoss: 0.6, baselineLogLoss: 0.69, logLossSkill: 0.13, calibrationGap: 0.02, validated: true, gate: [], temperature: 1, temperatureGain: 0, residualScale: 1, teacherErrorRate: 0.3 },
  probability: 0.58,
  fair: 0.5,
  edgePts: 8,
  drive: 70,
  analysis: 'test',
  weight: 0.2,
  validated: true,
  skill: 0.2,
  sample: 100,
  note: 'test note',
  ...overrides,
});

test('with no model the published probability is bit-identical', () => {
  const { probability, fusion } = applyForge({ published: 0.6137, fair: 0.5, model: null });
  assert.equal(probability, 0.6137);
  assert.equal(fusion.decision, 'inert');
  assert.equal(fusion.weight, 0);
  assert.equal(fusion.contributionPts, 0);
  assert.equal(forgeVetoed(fusion), false);
});

test('an unvalidated forge can never raise a published probability', () => {
  const model = fakeModel({ validated: false, weight: 0, metrics: { ...fakeModel().metrics, validated: false, z: 0.4, brierSkill: -0.01 } });
  const { probability, fusion } = applyForge({ published: 0.58, fair: 0.5, model });
  assert.ok(probability <= 0.58 + 1e-12, `published moved up on an unvalidated model: ${probability}`);
  assert.ok(['inert', 'trim'].includes(fusion.decision));
  assert.equal(fusion.weight, 0);
});

test('a validated forge can confirm, trim and veto within the weight cap', () => {
  const agree = fakeModel({ probability: 0.62 });
  const confirmed = applyForge({ published: 0.56, fair: 0.5, model: agree });
  assert.equal(confirmed.fusion.decision, 'confirm');
  assert.ok(confirmed.probability > 0.56, 'agreement on a real edge raises the estimate');
  assert.ok(confirmed.fusion.weight <= FORGE_MAX_WEIGHT, 'weight stays inside the cap');
  assert.ok(Math.abs(confirmed.probability - 0.56) <= 0.2 * 0.06 + 1e-9, 'the move is bounded by the weight');

  const lower = fakeModel({ probability: 0.52 });
  const trimmed = applyForge({ published: 0.62, fair: 0.5, model: lower });
  assert.equal(trimmed.fusion.decision, 'trim');
  assert.ok(trimmed.probability < 0.62, 'a materially lower validated view trims the edge');

  const against = fakeModel({ probability: 0.4, drive: 82 });
  const vetoed = applyForge({ published: 0.62, fair: 0.5, model: against });
  assert.equal(vetoed.fusion.decision, 'veto');
  assert.ok(forgeVetoed(vetoed.fusion));
  assert.ok(vetoed.probability < 0.62);
  // A veto cuts the edge, it does not invert the call.
  assert.ok(vetoed.probability >= 0.5, 'the direction is never inverted');
  const evidence = forgeEvidence(vetoed.fusion);
  assert.equal(evidence.contradicted, true);
  assert.equal(evidence.validated, true);
});

test('the confidence contribution is gated and bounded', () => {
  const base = { weightedAgreement: 0.6, edgeRatio: 0.1, backtest: null, validationSkill: null, dataQuality: 1 };
  const without = confidenceScore(base);
  assert.equal(without.breakdown.forge, 0);
  const validated = confidenceScore({ ...base, forge: { probability: 0.62, fair: 0.5, skill: 0.2, sample: 200, validated: true, contradicted: false } });
  assert.ok(validated.breakdown.forge > 0);
  const inert = confidenceScore({ ...base, forge: { probability: 0.62, fair: 0.5, skill: 0.2, sample: 200, validated: false, contradicted: false } });
  assert.equal(inert.breakdown.forge, 0);
  const contradicted = confidenceScore({ ...base, forge: { probability: 0.38, fair: 0.5, skill: 0.2, sample: 200, validated: true, contradicted: true } });
  assert.ok(contradicted.breakdown.forge < 0);
  assert.ok(Math.abs(validated.breakdown.forge) <= 0.07 + 1e-12, 'the term stays inside its budget');
  assert.ok(forgeTerm({ probability: 0.5, fair: 0.5, skill: 0.2, sample: 200, validated: true, contradicted: false }) === 0);
});

test('forgeCandidate refuses a call it cannot fit and reports one it can', () => {
  const refusals = [
    forgeCandidate({ family: 'digit', label: 'MATCH 4', fair: 0.1, rows: [], liveFeatures: new Float64Array(FORGE_FEATURE_COUNT), liveTeacherProbability: 0.1, dataQuality: 1, horizonTicks: 1, contextSummary: 'test', teachers: [] }),
    forgeCandidate({ family: 'digit', label: 'MATCH 4', fair: 0.1, rows: structuredRows(2, 4, 60), liveFeatures: new Float64Array(FORGE_FEATURE_COUNT), liveTeacherProbability: 0.1, dataQuality: 1, horizonTicks: 1, contextSummary: 'test', teachers: [] }),
  ];
  for (const refusal of refusals) assert.equal(refusal, null);

  const model = forgeCandidate({
    family: 'digit',
    label: 'MATCH 4',
    fair: 0.5,
    rows: structuredRows(13),
    liveFeatures: (() => { const v = new Float64Array(FORGE_FEATURE_COUNT); v[0] = 1; v[1] = Math.tanh(1.6); v[2] = 0.8; return v; })(),
    liveTeacherProbability: 0.58,
    dataQuality: 1,
    horizonTicks: 2,
    contextSummary: 'test context',
    teachers: ['engines'],
    symbol: 'R_100',
    name: 'Volatility 100 Index',
    selectionPool: 20,
  });
  assert.ok(model);
  assert.equal(model.card.knowledgeVersion, FORGE_KNOWLEDGE_VERSION);
  assert.equal(model.card.features.length, FORGE_FEATURE_COUNT);
  assert.ok(model.card.stages.length >= 5, 'the curriculum is reported');
  assert.ok(model.card.parameters > 0);
  assert.ok(model.probability > 0 && model.probability < 1);
  assert.ok(model.drive >= 0 && model.drive <= 100);
  assert.ok(model.note.includes('Unseen rows') || model.note.includes('unseen rows'));
  assert.ok(model.sample >= FORGE_MIN_HOLDOUT - 40);
});

/* -------------------------------------------------------------------------- */
/* 5. The analyzers publish it                                                */
/* -------------------------------------------------------------------------- */

test('the digit tools publish the forged model without breaking "always a signal"', () => {
  const digits = stickyDigits(31, 1_800);
  const ticks = digits.map((digit, index) => ({ epoch: 1_700_000_000 + index, digit }));
  const result = analyzeDigitMarket({ family: 'matches', symbol: 'R_100', name: 'Volatility 100 Index', horizon: 1, ticks, fresh: true, marketsInScan: 4 });
  assert.ok(result.forge, 'the winning contract carries a forged model');
  assert.equal(result.forge.card.family, 'digit');
  assert.equal(result.forge.card.features.length, FORGE_FEATURE_COUNT);
  assert.ok(result.forge.card.stages.length >= 5);
  assert.ok(typeof result.best.forge.weight === 'number');
  assert.ok(['inert', 'confirm', 'trim', 'veto'].includes(result.best.forge.decision));
  assert.ok(result.notes.some((note) => note.startsWith('Forged model:')), 'the note explains the fit');
  const source = result.best.master.sources.find((entry) => entry.id === 'forge');
  assert.ok(source, 'the master decision lists the forged source');
  // Every candidate still publishes a probability and a usable entry.
  for (const signal of result.contracts) {
    assert.ok(signal.probability > 0 && signal.probability < 1);
    assert.ok(signal.entry.validForTicks !== undefined);
    assert.ok(Number.isFinite(signal.confidence));
    assert.ok(typeof signal.forge.note === 'string' && signal.forge.note.length > 0);
  }
});

test('a fair digit stream leaves the forge inert', () => {
  const digits = fairDigits(41, 1_800);
  const ticks = digits.map((digit, index) => ({ epoch: 1_700_000_000 + index, digit }));
  const result = analyzeDigitMarket({ family: 'even-odd', symbol: 'R_50', name: 'Volatility 50 Index', horizon: 1, ticks, fresh: true, marketsInScan: 4 });
  assert.ok(result.forge, 'the model is still fitted and reported');
  assert.equal(result.forge.validated, false, 'a fair stream cannot validate a model');
  assert.equal(result.forge.weight, 0);
  assert.equal(result.best.forge.decision, 'inert');
  assert.equal(result.best.forge.contributionPts, 0);
  assert.ok(Math.abs(result.best.probability - result.best.fairProbability) < 0.02, 'no edge was invented');
});

test('the Rise/Fall tools publish the forged model for the winning duration', () => {
  const ticks = trendingWalk(17, 2_400);
  const result = analyzeRiseFallMarket({ symbol: 'R_100', name: 'Volatility 100 Index', ticks, fresh: true, horizons: [{ unit: 'ticks', value: 1 }, { unit: 'ticks', value: 5 }], marketsInScan: 3 });
  assert.ok(result.forge, 'the winning duration carries a forged model');
  assert.equal(result.forge.card.family, 'rise-fall');
  assert.ok(result.horizons.every((signal) => ['inert', 'confirm', 'trim', 'veto'].includes(signal.forge.decision)));
  assert.ok(result.notes.some((note) => note.startsWith('Forged model:')));
  const source = result.best.master.sources.find((entry) => entry.id === 'forge');
  assert.ok(source, 'the master decision lists the forged source');
  for (const signal of result.horizons) {
    assert.ok(signal.winEstimate > 0 && signal.winEstimate < 1);
    assert.ok(Number.isFinite(signal.confidence));
  }
});

test('a fair quote stream leaves the forge inert', () => {
  const ticks = randomWalk(23, 2_400);
  const result = analyzeRiseFallMarket({ symbol: 'R_25', name: 'Volatility 25 Index', ticks, fresh: true, horizons: [{ unit: 'ticks', value: 3 }], marketsInScan: 3 });
  assert.ok(result.forge, 'the model is fitted and reported');
  assert.equal(result.forge.validated, false);
  assert.equal(result.best.forge.decision, 'inert');
  assert.ok(Math.abs(result.best.winEstimate - result.best.fairProbability) < 0.02);
});
