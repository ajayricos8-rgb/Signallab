// Runtime checks on the Parity Lab engine behind the AI Even Switcher v2.
//
// The engine answers one question — P(even) at the settling tick — and prices
// both sides against the live DIGITEVEN/DIGITODD quotes. These tests pin the
// answers on tapes whose truth is known: a fair coin, a biased coin, a stuck
// feed, and a mispriced quote board. Deterministic throughout (splitmix32);
// no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARITY_FALLBACK_PAYOUT,
  PARITY_MODEL_NAMES,
  PARITY_MODEL_VERSION,
  parityAuditReport,
  parityBrainReport,
  parityDecision,
  parityDna,
  parityForecastReport,
  parityLeagueReport,
  parityReverseReport,
  scoreParityMarket,
} from '../../../vendor/deriv-bot/src/external/bot-skeleton/services/tradeEngine/utils/parity-strategies.mjs';

/** splitmix32: a plain LCG's low bits are too correlated to judge an edge. */
function stream(seed, length, digit) {
  let state = seed >>> 0;
  const next = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Prices that encode their last digit exactly: pip inference reads 2 and
  // the digit reader recovers the digit stream bit-for-bit.
  return Array.from({ length }, (_, i) => i + digit(next, i) / 100);
}

const fair = () => stream(7, 600, (next) => Math.floor(next() * 10));
const biasedEven = () =>
  stream(11, 600, (next) => Math.floor(next() * 5) * 2 + (next() < 0.55 ? 0 : 1));
const sticky = () =>
  stream(3, 600, (next, i) => {
    const even = (i >> 3) % 2 === 0;
    return Math.floor(next() * 5) * 2 + (even ? 0 : 1);
  });
const frozen = () => Array.from({ length: 600 }, () => 100.05);

const CADENCE = { requireEdge: false, payout: 1.95 };

test('the league is sixteen experts under a versioned brain', () => {
  assert.equal(PARITY_MODEL_NAMES.length, 16);
  assert.equal(new Set(PARITY_MODEL_NAMES).size, 16);
  for (const name of ['uniform', 'transition', 'neural', 'share', 'markov-1', 'markov-2',
      'digit-row', 'streak', 'alternation', 'parity-net']) {
    assert.ok(PARITY_MODEL_NAMES.includes(name), `missing expert ${name}`);
  }
  assert.equal(PARITY_MODEL_VERSION, 1, 'bump deliberately: the journal prints it');
  assert.match(parityBrainReport(parityDecision(fair(), 5, 0, CADENCE)), /AI core v1/);
  assert.equal(PARITY_FALLBACK_PAYOUT, 1.95);
});

test('a short tape warms up instead of guessing', () => {
  const decision = parityDecision(fair().slice(0, 40), 5, 0, CADENCE);
  assert.equal(decision.ready, false);
  assert.equal(decision.modelReady, false);
  assert.match(decision.reason, /warming up/);
});

test('a frozen quote feed is refused before a single expert speaks', () => {
  const decision = parityDecision(frozen(), 5, 0, CADENCE);
  assert.equal(decision.ready, false);
  assert.equal(decision.modelReady, false, 'the refusal is never filed for grading');
  assert.equal(decision.league.length, 0);
  assert.match(decision.reason, /frozen/);
  assert.equal(decision.dna.phase, 'frozen');
  assert.equal(scoreParityMarket(decision, decision.dna), 0, 'the scout walks away, not toward');
});

test('a fair coin reads ~50/50 and keeps the cadence at a visible cost', () => {
  const decision = parityDecision(fair(), 5, 0, CADENCE);
  assert.equal(decision.modelReady, true);
  assert.equal(decision.ready, true);
  assert.ok(Math.abs(decision.evenProbability - 0.5) < 0.04, `pEven ${decision.evenProbability}`);
  assert.ok([-1, 1].includes(decision.side));
  // The margin Deriv keeps: negative EV, printed on the journal line.
  assert.ok(decision.ev < 0 && decision.ev > -0.06, `EV ${decision.ev}`);
  assert.ok(Math.abs(decision.tStat) < 2, `t ${decision.tStat}`);
  assert.match(decision.reason, /EV -/);
  // Both sides priced, even the side not bought.
  assert.equal(decision.evTable.length, 2);
  assert.deepEqual(decision.evTable.map((row) => row.label), ['EVEN', 'ODD']);
  // Honest skills: nobody beats the fair coin on a fair coin.
  assert.equal(decision.league.length, 16);
  for (const expert of decision.league) {
    assert.ok(Math.abs(expert.skill) < 0.06, `${expert.name} skill ${expert.skill}`);
  }
});

test('a 55%-even tape reads Even — but shrinkage eats the edge', () => {
  const decision = parityDecision(biasedEven(), 5, 0, CADENCE);
  assert.equal(decision.side, 1);
  assert.ok(decision.evenProbability > 0.5, `pEven ${decision.evenProbability}`);
  assert.ok(decision.ev > parityDecision(fair(), 5, 0, CADENCE).ev, 'a real lean out-earns noise');
  // At 1.95× the break-even is 51.28%: the shrunk 51%-ish read has no
  // payable edge, so selective mode refuses it. A payable lean must be
  // measured, not hoped.
  const selective = parityDecision(biasedEven(), 5, 0, { requireEdge: true, payout: 1.95 });
  assert.equal(selective.ready, false);
  assert.match(selective.reason, /edge/);
});

test('selective mode buys a fairly-priced underdog', () => {
  // The 55% tape shrinks to ~51% Even — but at 2.50× the Odd side the 49%
  // underdog is worth +20%. Both sides are priced; the better EV wins.
  const decision = parityDecision(biasedEven(), 5, 0,
    { requireEdge: true, payout: 1.95, payoutEven: 1.5, payoutOdd: 2.5, minEv: 0.01 });
  assert.equal(decision.side, -1);
  assert.equal(decision.ready, true);
  assert.ok(decision.ev > 0.15, `EV ${decision.ev}`);
  assert.equal(decision.payoutAt, 2.5, 'the stake sizes off the winning side\u2019s own quote');
  assert.ok(decision.evTable[1].ev > decision.evTable[0].ev);
});

test('selective decisions can switch in both directions', () => {
  // Deliberately artificial quotes make both selections pass the EV gate;
  // this tests the switch, not the existence of a real-world edge.
  const options = { requireEdge: true, minEv: 0.005, entrySlip: 1 };
  const even = parityDecision(fair(), 5, 0, { ...options, payoutEven: 2.5, payoutOdd: 1.5 });
  const odd = parityDecision(fair(), 5, 0, { ...options, payoutEven: 1.5, payoutOdd: 2.5 });
  assert.equal(even.ready, true);
  assert.equal(even.side, 1);
  assert.equal(odd.ready, true);
  assert.equal(odd.side, -1);
});

test('the probability floor is unconditional; edge and EV gates need selective mode', () => {
  assert.equal(parityDecision(fair(), 5, 0.6, CADENCE).ready, false, 'floor binds in cadence');
  assert.equal(parityDecision(fair(), 5, 0.5, CADENCE).ready, true, 'floor passes under the read');
  const fairSelective = { requireEdge: true, payout: 1.95 };
  assert.equal(parityDecision(fair(), 5, 0, { ...fairSelective, minEdge: 0.02 }).ready, false);
  assert.equal(parityDecision(fair(), 5, 0, { ...fairSelective, minEv: 0.005 }).ready, false);
  assert.match(parityDecision(fair(), 5, 0, { ...fairSelective, minEv: 0.005 }).reason, /edge|value/);
});

test('a losing graded record shrinks the estimate and raises stand-down', () => {
  const lane = (hits, samples, predicted) => ({ hits, samples, predicted });
  const evidence = {
    hits: 5,
    samples: 48,
    rate: 5 / 48,
    mean: 0.52,
    byOutcome: { even: lane(3, 24, 12.5), odd: lane(2, 24, 12.4) },
  };
  const raw = parityDecision(fair(), 5, 0, CADENCE);
  const adjusted = parityDecision(fair(), 5, 0, { ...CADENCE, evidence });
  assert.ok(adjusted.calibration < 1, `calibration ${adjusted.calibration}`);
  assert.ok(
    Math.abs(adjusted.evenProbability - 0.5) < Math.abs(raw.evenProbability - 0.5),
    'a losing record pulls the estimate toward 50/50');
  assert.equal(adjusted.standDown, 1, 'the whole interval sits under break-even');
  // The engine reports the flag; the bot's entry gate enforces it — a
  // stand-down inside the engine would be indistinguishable from a broken bot.
  assert.equal(adjusted.ready, true);
  assert.match(adjusted.reason, /record/);
});

test('durations clamp and slip extends the forecast, never the contract', () => {
  assert.equal(parityDecision(fair(), 20, 0, CADENCE).horizon, 10);
  assert.equal(parityDecision(fair(), 5, 0, { ...CADENCE, entrySlip: 2 }).forecastHorizon, 7);
  assert.equal(parityDecision(fair(), 5, 0, CADENCE).forecastHorizon, 6);
});

test('the DNA fingerprints structure: sticky tapes read sticky', () => {
  const dna = parityDna(sticky());
  assert.equal(dna.phase, 'sticky');
  assert.ok(dna.readability > 0);
  assert.ok(dna.ticks >= 600 - 1);
  const fairDna = parityDna(fair());
  assert.notEqual(fairDna.phase, 'frozen');
  const dnaPart = parityDecision(sticky(), 5, 0, CADENCE).dnaScore;
  assert.ok(dnaPart > 0 && dnaPart <= 100);
});

test('every report prints one honest journal line', () => {
  const decision = parityDecision(fair(), 5, 0, CADENCE);
  assert.match(parityLeagueReport(decision), /^league · /);
  assert.match(parityAuditReport(decision), /^self-audit · /);
  assert.match(parityBrainReport(decision), /^AI core v/);
  assert.match(parityReverseReport(decision.dna), /^reverse engineering · /);
  assert.match(parityForecastReport(decision), /^forecast · EVEN .* · ODD /);
  assert.match(parityLeagueReport(null), /warming up/);
});

test('the market score ranks a dead tape below a live one', () => {
  const live = parityDecision(fair(), 5, 0, CADENCE);
  const liveScore = scoreParityMarket(live, live.dna);
  assert.ok(liveScore > 0 && liveScore <= 100, `score ${liveScore}`);
  assert.equal(scoreParityMarket(null, null), 0);
});

test('decisions are deterministic and finite', () => {
  const tape = fair();
  const first = parityDecision(tape, 5, 0, CADENCE);
  const second = parityDecision(tape, 5, 0, CADENCE);
  assert.equal(second.evenProbability, first.evenProbability);
  assert.equal(second.side, first.side);
  for (const key of ['probability', 'evenProbability', 'edge', 'ev', 'evLower',
      'confidence', 'agreement', 'tStat', 'breakEven', 'dnaScore', 'skill']) {
    assert.ok(Number.isFinite(first[key]), `${key} is ${first[key]}`);
  }
});

test('a 600-tick decision settles in well under a tick budget', () => {
  const tape = fair();
  const started = Date.now();
  parityDecision(tape, 5, 0, CADENCE);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `${elapsed}ms for one decision`);
});
