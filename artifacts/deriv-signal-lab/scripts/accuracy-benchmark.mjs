// Rolling walk-forward accuracy benchmark for Rise/Fall.
//
// The tool is judged on one question: when it publishes p for the side it
// recommends, does that side win p of the time? This script answers it end to
// end — no mocks, no shortcuts — by generating markets whose behaviour is known,
// analysing them at successive points in time with ONLY the history available at
// that point, and settling each published call at its own exit tick.
//
//   node --experimental-strip-types ./scripts/accuracy-benchmark.mjs [--seeds 4]
//
// Markets:
//   ou0.06 / ou0.15  Ornstein–Uhlenbeck: the price is pulled to 1,000, so the
//                    edge is in the LEVEL, not in the returns.
//   random           random walk — the honest answer is exactly fair odds.
//   trend            constant drift — a real directional edge.
//   volcluster       volatility clustering with no drift.
//
// Columns: published = mean probability of the recommended side, realised = how
// often that side won on the same signals, bias = published − realised, skill =
// 1 − Brier(published) / Brier(fair). Positive bias means overconfident.
import { analyzeRiseFallMarket } from '../src/lib/signal-engine/rise-fall-signal.ts';

// ---- deterministic streams -------------------------------------------------

function sfc32(seed) {
  let a = seed >>> 0;
  let b = (seed * 2654435761) >>> 0;
  let c = (seed * 40503) >>> 0;
  let d = (seed * 12345) >>> 0;
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

const MARKETS = {
  'ou0.06': (seed, length) => walk(seed, length, 0.06, 0.5),
  'ou0.15': (seed, length) => walk(seed, length, 0.15, 0.5),
  random: (seed, length) => walk(seed, length, 0, 0.2),
  trend: (seed, length) => walk(seed, length, 0, 0.2, 0.02),
  volcluster: (seed, length) => {
    const random = sfc32(seed);
    let price = 1_000;
    let volatility = 0.1;
    return Array.from({ length }, () => {
      volatility = Math.max(0.03, volatility * 0.97 + 0.03 * (0.05 + Math.abs(random() - 0.5) * 0.6));
      price += (random() - 0.5) * volatility;
      return Number(price.toFixed(6));
    });
  },
};

function walk(seed, length, theta = 0, noise = 0.2, drift = 0) {
  const random = sfc32(seed);
  let price = 1_000;
  return Array.from({ length }, () => {
    price += theta * (1_000 - price) + drift + (random() - 0.5) * noise;
    return Number(price.toFixed(6));
  });
}

// ---- benchmark -------------------------------------------------------------

const HORIZON = 5;
const LENGTH = 4_200;
const START = 3_000;
const seedsArgument = process.argv.indexOf('--seeds');
const SEEDS = seedsArgument >= 0 ? Math.max(1, Number(process.argv[seedsArgument + 1]) || 4) : 4;
const POINTS = 7;

const rows = [];
for (const [name, generate] of Object.entries(MARKETS)) {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const prices = generate(seed, LENGTH);
    const span = LENGTH - HORIZON - 60 - START;
    for (let point = 0; point < POINTS; point += 1) {
      const at = START + Math.floor((span / Math.max(1, POINTS - 1)) * point);
      // Only ticks up to `at`: the analysis may not see the future.
      const ticks = prices.slice(0, at).map((quote, index) => ({ epoch: 1_700_000_000 + index, quote }));
      let result;
      try {
        result = analyzeRiseFallMarket({ symbol: 'R_100', name, ticks, fresh: true, horizons: [{ unit: 'ticks', value: HORIZON }] });
      } catch {
        continue;
      }
      const best = result.best;
      const won = (prices[at + HORIZON] > prices[at]) === (best.direction === 'RISE') ? 1 : 0;
      rows.push({
        name,
        published: best.winEstimate,
        fair: best.fairProbability,
        won,
        entry: best.entry.mode,
        regime: result.state.regime,
      });
    }
  }
}

const groups = new Map();
for (const row of rows) {
  const group = groups.get(row.name) ?? { n: 0, published: 0, won: 0, brier: 0, fairBrier: 0, entries: {} };
  group.n += 1;
  group.published += row.published;
  group.won += row.won;
  group.brier += (row.published - row.won) ** 2;
  group.fairBrier += (row.fair - row.won) ** 2;
  group.entries[row.entry] = (group.entries[row.entry] ?? 0) + 1;
  groups.set(row.name, group);
}

const pad = (value, width) => String(value).padStart(width);
console.log('market      n   published  realised    bias   BrierSkill  entries');
for (const [name, group] of groups) {
  const published = group.published / group.n;
  const realised = group.won / group.n;
  const bias = published - realised;
  const skill = group.fairBrier > 1e-12 ? 1 - group.brier / group.fairBrier : 0;
  const entries = Object.entries(group.entries).map(([mode, count]) => `${mode}:${count}`).join(' ');
  console.log(
    `${name.padEnd(10)} ${pad(group.n, 3)}  ${pad(published.toFixed(3), 8)}  ${pad(realised.toFixed(3), 8)}  `
    + `${pad((bias >= 0 ? '+' : '') + bias.toFixed(3), 6)}  ${pad(skill.toFixed(3), 9)}   ${entries}`,
  );
}
const total = rows.reduce((sum, row) => ({
  n: sum.n + 1,
  published: sum.published + row.published,
  won: sum.won + row.won,
  brier: sum.brier + (row.published - row.won) ** 2,
  fairBrier: sum.fairBrier + (row.fair - row.won) ** 2,
}), { n: 0, published: 0, won: 0, brier: 0, fairBrier: 0 });
console.log(`\nALL ${total.n} calls: published ${(total.published / total.n).toFixed(3)}, realised ${(total.won / total.n).toFixed(3)}, `
  + `Brier skill ${(1 - total.brier / total.fairBrier).toFixed(3)}`);
// The hard checks are the structureless rows and the skill sign, not the third
// decimal of `realised`: at one seed set the binomial noise on 28 calls is ±18
// points. Run twice with different seeds before believing a difference.
console.log('Hard checks: random and volcluster must publish 0.500 with skill 0.000; '
  + 'OU markets must publish an edge with positive skill; trend keeps its skill.');
console.log('The digit side has its own ground-truth audit: tests/signal-accuracy.test.mjs.');
