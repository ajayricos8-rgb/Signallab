// Sensitivity bench for the price-path ensemble.
//
//   node artifacts/deriv-signal-lab/scripts/presets/bench.mjs
//
// Replays the shipped preset settings over synthetic step-like streams and
// reports, per configuration: how many decisions were published, how many
// became entries, what the model claimed, and what actually happened. The last
// figure is the only one that matters — realised hit rate against the payout
// break-even. A bot that never fires is a bug; a bot that fires and loses is a
// worse one.

import { priceDecision, PRICE_MODEL_VERSION } from '../../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/price-strategies.mjs';

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}

function stream(length, bias, seed) {
  const random = makeRandom(seed);
  let price = 1000;
  const out = [price];
  for (let i = 0; i < length; i++) {
    price += random() < bias ? 0.1 : -0.1;
    out.push(Number(price.toFixed(2)));
  }
  return out;
}

// Step Index clumps its steps: a share of the moves repeat the previous one.
function clumped(length, seed) {
  const random = makeRandom(seed);
  let price = 1000;
  let last = 1;
  const out = [price];
  for (let i = 0; i < length; i++) {
    last = random() < 0.58 ? last : -last;
    price += last * 0.1;
    out.push(Number(price.toFixed(2)));
  }
  return out;
}

// R_100 is a two-decimal random index: increments are continuous, so a shared
// extreme is rare and the arcsine structure is not eaten by ties.
function randomIndex(length, seed) {
  const random = makeRandom(seed);
  let price = 1000;
  const out = [price];
  for (let i = 0; i < length; i++) {
    price += Math.round((random() - 0.5) * 100) / 100;
    out.push(Number(price.toFixed(2)));
  }
  return out;
}

/** Did this filed decision win? */
function settled(prices, entry, mode, decision, horizon) {
  const start = entry + 1;
  const end = start + horizon;
  if (end >= prices.length) return null;
  if (mode === 'tick') {
    const window = prices.slice(start, end);
    const high = Math.max(...window);
    const low = Math.min(...window);
    const highStrict = window.filter(value => value === high).length === 1;
    const lowStrict = window.filter(value => value === low).length === 1;
    return decision.side === 1
      ? highStrict && window.indexOf(high) + 1 === decision.tick
      : lowStrict && window.indexOf(low) + 1 === decision.tick;
  }
  const change = prices[end] - prices[start];
  if (change === 0) return null;
  return decision.side === 1 ? change > 0 : change < 0;
}

function evaluate(prices, mode, options, horizon = options.horizon || 5) {
  let entries = 0;
  let published = 0;
  let wins = 0;
  let claimed = 0;
  let blockedByEvidence = 0;
  const reasons = new Map();
  const ledger = [];
  let hits = 0;
  let samples = 0;
  const note = key => reasons.set(key, (reasons.get(key) || 0) + 1);

  for (let i = 1000; i < prices.length - horizon - 2; i += 2) {
    // Grade everything whose expiry has printed.
    for (let index = ledger.length - 1; index >= 0; index--) {
      const filed = ledger[index];
      if (filed.entry + 1 + horizon > i) continue;
      const won = settled(prices, filed.entry, mode, filed, horizon);
      if (won !== null) {
        samples++;
        if (won) hits++;
      }
      ledger.splice(index, 1);
    }
    const evidence = { hits, samples };
    const decision = priceDecision(prices.slice(Math.max(0, i - 999), i + 1), mode, horizon, options.threshold ?? 0, {
      maxTie: options.maxTie ?? 0.2,
      minAgreement: options.minAgreement ?? 0,
      minEdge: options.minEdge ?? 0,
      payout: options.payout ?? 0.95,
      minConfidence: options.minConfidence ?? 0,
      requireEdge: options.requireEdge !== false,
      evidence,
    });
    if (decision.modelReady) {
      ledger.push({ entry: i, side: decision.side, tick: decision.tick });
      published++;
    }
    if (!decision.ready) {
      if (String(decision.reason).startsWith("the rule's own record")) blockedByEvidence++;
      note(String(decision.reason).replace(/[0-9.]+/g, '#').slice(0, 40));
      continue;
    }
    entries++;
    claimed += decision.probability;
    const won = settled(prices, i, mode, decision, horizon);
    if (won) wins++;
  }
  const breakEven = 1 / (1 + (options.payout ?? 0.95));
  return {
    published,
    entries,
    blockedByEvidence,
    claimed: entries ? +((claimed / entries) * 100).toFixed(1) : 0,
    hit: entries ? +((wins / entries) * 100).toFixed(1) : 0,
    breakEven: +(breakEven * 100).toFixed(1),
    edge: entries ? +((wins / entries - breakEven) * 100).toFixed(1) : 0,
    reasons,
  };
}

const presets = {
  // Shipped rise/fall: five ticks (odd, tie-free), best read available.
  'rise/fall preset': ['rise', { threshold: 0, maxTie: 0.2, minAgreement: 0, minEdge: 0, payout: 0.95, minConfidence: 0, requireEdge: false, horizon: 5 }],
  // The opportunistic variant the same preset had before: kept here so the
  // cost of the cadence is a number, not an opinion.
  'rise/fall strict': ['rise', { threshold: 0, maxTie: 0.2, minAgreement: 0.55, minEdge: 0.004, payout: 0.95, minConfidence: 55, horizon: 5 }],
  // Shipped hedge: four ticks, best read available, tie cost printed.
  // Shipped hedge: five ticks (odd, tie-free), best read available.
  'hedge preset': ['step-hedge', { threshold: 0, maxTie: 0.2, minAgreement: 0, minEdge: 0, payout: 0.95, minConfidence: 0, requireEdge: false, horizon: 5 }],
  // What the four-tick contract would have measured — the tie, priced.
  'hedge 4 ticks': ['step-hedge', { threshold: 0, maxTie: 0.5, minAgreement: 0, minEdge: 0, payout: 0.95, minConfidence: 0, requireEdge: false, horizon: 4 }],
  // Shipped sniper: five ticks, cadence mode — the best-ranked of ten on every
  // readable cycle, Kelly sizes the stake. (Live, the ten-quote ladder ranks
  // by EV; the bench has no ladder, so it ranks by probability.)
  'tick preset': ['tick', { threshold: 0, maxTie: 0.35, minAgreement: 0, minEdge: 0, payout: 3.5, minConfidence: 0, requireEdge: false }],
};

const markets = {
  'fair 50/50': stream(2600, 0.5, 7),
  'lean 53/47': stream(2600, 0.53, 11),
  clumped: clumped(2600, 13),
  'R_100-like': randomIndex(2600, 17),
};

console.log(`price model v${PRICE_MODEL_VERSION}`);
for (const [market, prices] of Object.entries(markets)) {
  console.log(`\n=== ${market}`);
  for (const [name, [mode, options]] of Object.entries(presets)) {
    const result = evaluate(prices, mode, options);
    console.log(
      `${name.padEnd(18)} published ${String(result.published).padStart(4)}  entries ${String(result.entries).padStart(3)}` +
        `  claimed ${String(result.claimed).padStart(5)}%  hit ${String(result.hit).padStart(5)}%` +
        `  break-even ${result.breakEven}%  edge ${result.edge}pt  evidence vetoes ${result.blockedByEvidence}`,
    );
    const reasons = [...result.reasons]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([key, count]) => `${key}:${count}`)
      .join('  ');
    console.log(`${' '.repeat(18)}${reasons}`);
  }
}
