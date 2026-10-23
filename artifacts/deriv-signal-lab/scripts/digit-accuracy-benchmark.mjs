// Ground-truth accuracy audit for the digit options (Over/Under, Even/Odd,
// Matches).
//
// The digit side is judged the same way as Rise/Fall: when the tool publishes p
// for a contract, does that contract win p of the time? Two questions, both
// answered end to end on markets whose structure is known by construction:
//
//   1. Per-angle skill — every analysis angle (frequency, recent appearance,
//      transition, pattern, momentum, drift, reversal, repeat, spike, gap) is
//      rebuilt at past origins with only the history available then, and scored
//      on the digit the CONTRACT settles on (the exit tick). An angle that
//      cannot beat uniform here can never carry weight in the shipped prior.
//
//   2. Shipped-recipe accuracy — the actual prior the app ships is rebuilt at
//      every out-of-sample origin (weights measured on earlier data only), the
//      contract with the largest positive edge is published, and the settle is
//      recorded. A fair stream must stay at fair: that is the honesty check.
//
//   node --experimental-strip-types ./scripts/digit-accuracy-benchmark.mjs
//   H=1 node ...      # one-tick contracts
//   SEEDS=3 node ...  # more seeds (slower, tighter error bars)
//
// Columns: published = mean probability of the published contract, realised =
// how often it won, bias = published − realised, skill = 1 − Brier(published) /
// Brier(fair). Positive bias means overconfident.
import {
  buildDigitPrior, digitPriorComponents, digitPriorWithWeights,
} from '../src/lib/signal-engine/market-state.ts';
import { contractWins } from '../src/lib/over-under/ensemble.ts';
import { DIGIT_SIGNAL_CONTRACTS, fairProbability } from '../src/lib/signal-engine/digit-signal.ts';

const HORIZON = Math.max(1, Math.min(10, Number(process.env.H ?? 5)));
const SEEDS = Math.max(1, Math.min(6, Number(process.env.SEEDS ?? 2)));
const LENGTH = 6000;
const TRAIN_END = 4200;
const STRIDE = 12;

// ---- deterministic streams with planted structure --------------------------

function sfc32(seed) {
  let a = 0x9e3779b9, b = 0x243f6a88 + seed, c = 0xb7e15162, d = 0x12345678 ^ (seed * 7919);
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11); c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 40; i += 1) next();
  return next;
}

const UNIFORM_WEIGHTS = new Array(10).fill(1);
const weighted = (random, weights) => {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let x = random() * total;
  for (let digit = 0; digit < weights.length; digit += 1) {
    x -= weights[digit];
    if (x <= 0) return digit;
  }
  return weights.length - 1;
};

const fair = (seed, n = LENGTH) => {
  const random = sfc32(seed);
  return Array.from({ length: n }, () => weighted(random, UNIFORM_WEIGHTS));
};
const bias = (seed, n = LENGTH, hot = 7, mass = 2.5) => {
  const random = sfc32(seed);
  const weights = UNIFORM_WEIGHTS.slice();
  weights[hot] = mass;
  return Array.from({ length: n }, () => weighted(random, weights));
};
const parity = (seed, n = LENGTH, evenP = 0.62) => {
  const random = sfc32(seed);
  return Array.from({ length: n }, () => Math.floor(random() * 5) * 2 + (random() < evenP ? 0 : 1));
};
const repeat = (seed, n = LENGTH, repeatP = 0.3) => {
  const random = sfc32(seed);
  let last = Math.floor(random() * 10);
  const out = [last];
  while (out.length < n) {
    const digit = random() < repeatP ? last : Math.floor(random() * 10);
    out.push(digit);
    last = digit;
  }
  return out;
};
const markov = (seed, n = LENGTH, from = 3, to = 8, p = 0.4) => {
  const random = sfc32(seed);
  const out = [Math.floor(random() * 10)];
  while (out.length < n) {
    const previous = out[out.length - 1];
    out.push(previous === from && random() < p ? to : Math.floor(random() * 10));
  }
  return out;
};
// Blocky drift: the hot digit changes every `block` ticks, so recent frequency
// genuinely predicts the next tick.
const momentum = (seed, n = LENGTH, block = 120) => {
  const random = sfc32(seed);
  const out = [];
  let hot = Math.floor(random() * 10);
  for (let i = 0; i < n; i += 1) {
    if (i % block === 0) hot = (hot + 3 + Math.floor(random() * 5)) % 10;
    out.push(weighted(random, UNIFORM_WEIGHTS.map((_, digit) => (digit === hot ? 3.2 : digit === (hot + 1) % 10 ? 1.5 : 1))));
  }
  return out;
};
// Bursts of 8/9 lasting 6–14 ticks.
const spikes = (seed, n = LENGTH) => {
  const random = sfc32(seed);
  const out = [];
  let burst = 0;
  for (let i = 0; i < n; i += 1) {
    if (burst > 0) { burst -= 1; out.push(random() < 0.7 ? 9 : 8); continue; }
    if (random() < 0.02) { burst = 6 + Math.floor(random() * 9); out.push(9); continue; }
    out.push(weighted(random, UNIFORM_WEIGHTS));
  }
  return out;
};
// Signed mean reversion around 4.5: high digits are followed by low ones.
const reversal = (seed, n = LENGTH, phi = -0.45) => {
  const random = sfc32(seed);
  let level = 4.5;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    level = 4.5 + phi * (level - 4.5) + (random() + random() + random() - 1.5) * 1.6;
    out.push(Math.max(0, Math.min(9, Math.round(level))));
  }
  return out;
};
const lowBias = (seed, n = LENGTH, mass = 1.8) => {
  const random = sfc32(seed);
  const weights = UNIFORM_WEIGHTS.map((_, digit) => (digit <= 2 ? mass : 1));
  return Array.from({ length: n }, () => weighted(random, weights));
};

const MARKETS = { fair, bias, parity, repeat, markov, momentum, spikes, reversal, lowBias };

// ---- contracts -------------------------------------------------------------

// Exactly the contracts the app offers, with the same fair rates, so the
// benchmark cannot drift away from what is shipped.
const CONTRACTS = ['over-under', 'even-odd', 'matches']
  .flatMap((family) => DIGIT_SIGNAL_CONTRACTS[family])
  .map((contract) => ({ contract, fair: fairProbability(contract) }));

const contractProbability = (prior, contract) =>
  prior.reduce((total, mass, digit) => total + (contractWins(contract, digit) ? mass : 0), 0);

const brier = (probability, won) => (probability - won) ** 2;

// ---- 1. per-angle out-of-sample skill --------------------------------------

function angleAudit(digits, origins) {
  const totals = new Map();
  for (const origin of origins) {
    if (origin < 300 || !Number.isInteger(digits[origin + HORIZON])) continue;
    const history = digits.slice(0, origin + 1);
    const target = digits[origin + HORIZON];
    const uniformLoss = (0.1 - 1) ** 2 + 9 * 0.1 ** 2;
    for (const component of digitPriorComponents(history, HORIZON)) {
      if (!component.probabilities) continue;
      let loss = 0;
      for (let digit = 0; digit < 10; digit += 1) loss += (component.probabilities[digit] - (digit === target ? 1 : 0)) ** 2;
      const entry = totals.get(component.id) ?? { loss: 0, base: 0, sample: 0 };
      entry.loss += loss;
      entry.base += uniformLoss;
      entry.sample += 1;
      totals.set(component.id, entry);
    }
  }
  return [...totals].map(([id, entry]) => ({ id, fired: entry.sample, skill: 1 - entry.loss / entry.base }));
}

console.log(`Digit options accuracy audit — horizon ${HORIZON} tick${HORIZON === 1 ? '' : 's'}, ${SEEDS} seed${SEEDS === 1 ? '' : 's'}\n`);

console.log('1. Every analysis angle, measured out of sample on the exit tick');
console.log('market      angle        fired   skill');
for (const [name, generate] of Object.entries({ fair, bias, markov, reversal, spikes })) {
  const digits = generate(1, LENGTH);
  const origins = [];
  for (let origin = TRAIN_END; origin + HORIZON < LENGTH; origin += 9) origins.push(origin);
  for (const row of angleAudit(digits, origins).sort((a, b) => b.skill - a.skill)) {
    console.log(`${name.padEnd(11)} ${row.id.padEnd(11)} ${String(row.fired).padStart(4)}  ${row.skill >= 0 ? '+' : ''}${row.skill.toFixed(3)}`);
  }
}

// ---- 2. the shipped recipe, at every out-of-sample origin -------------------

const rows = [];
for (const [name, generate] of Object.entries(MARKETS)) {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const digits = generate(seed, LENGTH);
    const { weights } = buildDigitPrior(digits.slice(0, TRAIN_END), HORIZON);
    for (let origin = TRAIN_END; origin + HORIZON < LENGTH; origin += STRIDE) {
      const { prior } = digitPriorWithWeights(digits.slice(0, origin + 1), HORIZON, weights);
      const target = digits[origin + HORIZON];
      let best = null;
      for (const entry of CONTRACTS) {
        const probability = contractProbability(prior, entry.contract);
        const edge = probability - entry.fair;
        if (edge <= 0) continue;
        if (!best || edge > best.edge) best = { contract: entry.contract, probability, edge, fair: entry.fair };
      }
      // A contract priced at or below fair is never published, so a stream with
      // no structure publishes nothing at all rather than a fake edge.
      if (!best) { rows.push({ name, skipped: true }); continue; }
      const won = contractWins(best.contract, target) ? 1 : 0;
      rows.push({
        name, published: best.probability, fair: best.fair, realised: won, edge: best.edge,
        brier: brier(best.probability, won), fairBrier: brier(best.fair, won),
      });
    }
  }
}

console.log('\n2. The contract the shipped prior publishes, at every out-of-sample origin');
console.log('market       n      fair  published  realised    bias   skill  noEdge');
let fairBias = null;
for (const [name, list] of Object.entries(MARKETS).map(([name]) => [name, rows.filter((row) => row.name === name)])) {
  const usable = list.filter((row) => !row.skipped);
  if (!usable.length) {
    console.log(`${name.padEnd(11)} ${String(list.length).padStart(4)}   no contract priced above fair`);
    continue;
  }
  const count = usable.length;
  const fairRate = usable.reduce((total, row) => total + row.fair, 0) / count;
  const published = usable.reduce((total, row) => total + row.published, 0) / count;
  const realised = usable.reduce((total, row) => total + row.realised, 0) / count;
  const skill = 1 - usable.reduce((total, row) => total + row.brier, 0) / usable.reduce((total, row) => total + row.fairBrier, 0);
  if (name === 'fair') fairBias = realised - fairRate;
  console.log(
    `${name.padEnd(11)} ${String(list.length).padStart(4)}  ${fairRate.toFixed(3).padStart(7)}  ${published.toFixed(3).padStart(8)}  ${realised.toFixed(3).padStart(8)}  `
    + `${`${published - realised >= 0 ? '+' : ''}${(published - realised).toFixed(3)}`.padStart(6)}  ${skill.toFixed(3).padStart(5)}  ${String(list.length - count).padStart(6)}`,
  );
}

// ---- 3. the honesty checks -------------------------------------------------

console.log('\n3. Honesty checks');
const fairRows = rows.filter((row) => row.name === 'fair');
const fairUsable = fairRows.filter((row) => !row.skipped);
const fairPublished = fairUsable.length ? fairUsable.reduce((total, row) => total + row.published - row.fair, 0) / fairUsable.length : 0;
const fairRate = fairUsable.length ? fairUsable.reduce((total, row) => total + row.fair, 0) / fairUsable.length : 0;
// Realised outcomes on a structureless stream are still a coin toss around the
// fair rate, so the check is a z-test against that noise, not a hard equality.
const fairStandardError = fairUsable.length ? Math.sqrt(fairRate * (1 - fairRate) / fairUsable.length) : 0;
const fairZ = fairBias !== null && fairStandardError > 0 ? fairBias / fairStandardError : null;
console.log(`fair stream, contracts published       ${fairUsable.length}/${fairRows.length} origins`);
console.log(`fair stream, published minus fair      ${fairPublished >= 0 ? '+' : ''}${fairPublished.toFixed(4)}  ${Math.abs(fairPublished) <= 0.02 ? 'PASS' : 'FAIL'}`);
console.log(`fair stream, realised minus fair       ${fairBias === null ? 'no contract priced above fair' : `${fairBias >= 0 ? '+' : ''}${fairBias.toFixed(4)}`} (z ${fairZ === null ? 'n/a' : fairZ.toFixed(1)})  ${fairZ === null || Math.abs(fairZ) <= 3 ? 'PASS' : 'FAIL'}`);
console.log('A fair stream must publish fair odds and realise them; planted structure must publish the edge it has, and no more.');
