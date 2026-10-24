// The gate: one pure function from "what the market and the account look like"
// to "buy / wait / blocked". No clock, no network, no randomness inside, so a
// decision can be replayed from its inputs in a test or an audit.
//
// Order is deliberate. Market evidence is checked before money, and money before
// risk limits, so a WAIT always names the earliest thing that was wrong rather
// than the last.
import type {
  MafiaBotConfig,
  MafiaDecision,
  MafiaDirection,
  MafiaMode,
  MafiaAccountState,
} from './types.ts';
import type { MafiaPairQuotes } from './economics.ts';
import { MAFIA_DURATION_TICKS, oppositeDirection } from './types.ts';
import type { MafiaAnalysis, MafiaGatedReplay } from './analysis.ts';
import { verdictOnUniformity } from './analysis.ts';
import type { MafiaPairEconomics, MafiaSizing } from './economics.ts';
import { evaluatePairEconomics, evidenceProbability, sizeMafiaPair } from './economics.ts';

export type MafiaRiskSnapshot = {
  balance: number | null;
  dailyNet: number;
  sessionNet: number;
  openPairs: number;
  pairsThisSession: number;
  consecutiveLosingPairs: number;
  sessionStartedAt: number | null;
  lastPairAt: number | null;
};

export type MafiaDecisionInput = {
  now: number;
  symbol: string;
  mode: MafiaMode;
  config: MafiaBotConfig;
  running: boolean;
  paused: boolean;
  analysis: MafiaAnalysis;
  gated: MafiaGatedReplay;
  risk: MafiaRiskSnapshot;
  /** Both legs' quotes, when a preview has been priced. */
  quotes: MafiaPairQuotes | null;
  /** A stop the account rules already triggered; the bot must not buy. */
  stopReason: string | null;
};

export type MafiaEvaluation = {
  decision: MafiaDecision;
  sizing: MafiaSizing | null;
  economics: MafiaPairEconomics | null;
  /** Probability the gate compared with the break-even, after the evidence haircut. */
  evidence: number | null;
  /** Raw replayed probability, before the haircut. */
  measured: number | null;
  breakEven: number | null;
  /** Free-form counters the UI shows next to the verdict. */
  details: string[];
};

let decisionSeq = 0;

function decisionId(now: number): string {
  decisionSeq = (decisionSeq + 1) % 1_000_000;
  return `mafia-${now}-${decisionSeq}`;
}

/**
 * Evaluates one entry opportunity.
 *
 * Evidence path: uniformity → gated replay → evidence haircut → pair economics.
 * A pair is bought only when the haircut probability clears the break-even the
 * live quotes imply AND the resulting expected value clears `minExpectedValue`.
 */
export function evaluateMafiaEntry(input: MafiaDecisionInput): MafiaEvaluation {
  const { config, analysis, gated, risk, quotes, now } = input;
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const details: string[] = [];
  const wait = (code: string, reason: string): MafiaEvaluation => {
    reasonCodes.push(code);
    reasons.push(reason);
    return {
      decision: {
        id: decisionId(now),
        at: now,
        symbol: input.symbol,
        mode: input.mode,
        action: 'WAIT',
        actionLabel: 'Waiting',
        reasons,
        reasonCodes,
        direction: analysis.uniformity.direction,
        uniformity: analysis.uniformity.available ? analysis.uniformity.score : null,
        probability: null,
        primaryStake: null,
        coverStake: null,
        executed: false,
        pairId: null,
        error: null,
      },
      sizing: null,
      economics: null,
      evidence: null,
      measured: null,
      breakEven: null,
      details,
    };
  };

  if (!input.running) return wait('BOT_STOPPED', 'The bot is stopped.');
  if (input.paused) {
    return wait('BOT_PAUSED', input.stopReason
      ? `The bot is auto-paused: ${input.stopReason}`
      : 'The bot is paused.');
  }
  if (input.stopReason) return wait('SESSION_STOP', input.stopReason);

  // ── Market ────────────────────────────────────────────────────────────────
  if (analysis.lastTick === null) return wait('NO_TICKS', 'No ticks from the feed yet.');
  if (analysis.lastTickAgeMs !== null && analysis.lastTickAgeMs > config.maxTickAgeMs) {
    return wait('STALE_TICKS', `The newest tick is ${(analysis.lastTickAgeMs / 1_000).toFixed(1)}s old — the feed is not fresh enough to enter.`);
  }
  if (analysis.tickCount < config.minTicksBeforeTrade) {
    return wait(
      'WARMING_UP',
      `Collecting ticks: ${analysis.tickCount} of the ${config.minTicksBeforeTrade} required before the first pair.`,
    );
  }

  const uniformityVerdict = verdictOnUniformity(analysis.uniformity, config);
  if (!uniformityVerdict.passes) {
    return wait(uniformityVerdict.reasonCodes[0] ?? 'NO_UNIFORMITY', uniformityVerdict.headline);
  }
  const direction: MafiaDirection = analysis.uniformity.direction!;
  reasons.push(`Uniform direction: ${direction === 'CALL' ? 'Rise' : 'Fall'} (score ${analysis.uniformity.score.toFixed(2)}, directional z ${analysis.uniformity.directionalZ.toFixed(2)}, persistence z ${analysis.uniformity.persistenceZ.toFixed(2)}).`);

  // ── Evidence ──────────────────────────────────────────────────────────────
  const conditional = gated.available && gated.samples >= config.minDirectionSamples;
  const measured = conditional
    ? gated.winRate
    : analysis.replay.directionProbability;
  if (measured === null) {
    return wait('NO_MEASUREMENT', 'Neither the gated replay nor the replay has enough printed windows to measure a 4-tick hit rate.');
  }
  const samples = conditional ? gated.samples : analysis.replay.samples;
  const evidence = evidenceProbability(measured, samples, config.evidenceZ);
  if (evidence === null) return wait('NO_MEASUREMENT', 'The measured hit rate has no usable sample.');
  if (conditional) {
    reasons.push(`Gate-conditioned replay: ${(measured * 100).toFixed(1)}% of ${samples} gated four-tick windows went the gated way.`);
  } else {
    reasons.push(`Unconditional replay: ${(measured * 100).toFixed(1)}% of ${samples} four-tick windows went ${direction === 'CALL' ? 'up' : 'down'} (gate-conditioned sample still too small).`);
    reasonCodes.push('UNCONDITIONAL_EVIDENCE');
  }
  reasons.push(`Evidence value after a ${config.evidenceZ.toFixed(2)}σ sample haircut: ${(evidence * 100).toFixed(1)}%.`);

  // ── Money ─────────────────────────────────────────────────────────────────
  const sizing = sizeMafiaPair(config, {
    balance: risk.balance,
    consecutiveLosingPairs: risk.consecutiveLosingPairs,
  });
  details.push(...sizing.reasons);
  if (sizing.blocked) {
    reasonCodes.push(...sizing.reasonCodes);
    return {
      decision: {
        id: decisionId(now),
        at: now,
        symbol: input.symbol,
        mode: input.mode,
        action: 'BLOCKED',
        actionLabel: 'Blocked by sizing',
        reasons: [...reasons, ...sizing.reasons],
        reasonCodes: [...reasonCodes, ...sizing.reasonCodes],
        direction,
        uniformity: analysis.uniformity.score,
        probability: measured,
        primaryStake: null,
        coverStake: null,
        executed: false,
        pairId: null,
        error: null,
      },
      sizing,
      economics: null,
      evidence,
      measured,
      breakEven: null,
      details,
    };
  }

  if (quotes === null) return wait('NO_QUOTES', 'The two legs have not been priced yet — waiting for Deriv to quote both directions.');
  if (quotes.primaryPayout === null || quotes.coverPayout === null) {
    return wait('QUOTE_INCOMPLETE', 'Deriv returned a quote without a payout, so the pair cannot be priced honestly.');
  }

  const economics = evaluatePairEconomics({
    primaryStake: sizing.primaryStake,
    coverStake: sizing.coverStake,
    primaryAsk: quotes.primaryAsk,
    coverAsk: quotes.coverAsk,
    primaryPayout: quotes.primaryPayout,
    coverPayout: quotes.coverPayout,
    probability: measured,
    flatProbability: analysis.replay.flatProbability,
  });
  details.push(...economics.reasons);
  reasons.push(...economics.reasons);

  if (economics.paysLessThanCost) {
    reasonCodes.push('PAIR_ALWAYS_LOSES');
    return {
      decision: {
        id: decisionId(now),
        at: now,
        symbol: input.symbol,
        mode: input.mode,
        action: 'BLOCKED',
        actionLabel: 'Blocked by payout',
        reasons,
        reasonCodes,
        direction,
        uniformity: analysis.uniformity.score,
        probability: measured,
        primaryStake: sizing.primaryStake,
        coverStake: sizing.coverStake,
        executed: false,
        pairId: null,
        error: null,
      },
      sizing,
      economics,
      evidence,
      measured,
      breakEven: economics.breakEvenProbability,
      details,
    };
  }

  if (config.requirePositiveExpectedValue) {
    if (economics.breakEvenProbability === null) {
      reasonCodes.push('BREAK_EVEN_UNDEFINED');
      return wait('BREAK_EVEN_UNDEFINED', 'The pair has no break-even probability at these payouts, so it cannot be shown to be worth buying.');
    }
    if (evidence < economics.breakEvenProbability) {
      reasonCodes.push('EVIDENCE_BELOW_BREAK_EVEN');
      return wait(
        'EVIDENCE_BELOW_BREAK_EVEN',
        `Evidence ${(evidence * 100).toFixed(1)}% does not clear the ${(economics.breakEvenProbability * 100).toFixed(1)}% break-even this hedge size needs.`,
      );
    }
    if (economics.expectedValuePerStake !== null && economics.expectedValuePerStake < config.minExpectedValue) {
      reasonCodes.push('EV_BELOW_MIN');
      return wait('EV_BELOW_MIN', `Expected value ${economics.expectedValuePerStake.toFixed(3)} per unit staked is below the ${config.minExpectedValue.toFixed(3)} floor.`);
    }
    reasons.push(`Evidence ${(evidence * 100).toFixed(1)}% clears the ${(economics.breakEvenProbability * 100).toFixed(1)}% break-even for a ${sizing.primaryStake.toFixed(2)} / ${sizing.coverStake.toFixed(2)} pair.`);
  }

  // ── Risk ──────────────────────────────────────────────────────────────────
  if (risk.openPairs >= config.maxOpenPairs) {
    return wait('MAX_OPEN_PAIRS', `${risk.openPairs} pair${risk.openPairs === 1 ? '' : 's'} already open — the limit is ${config.maxOpenPairs}.`);
  }
  if (config.maxPairsPerSession > 0 && risk.pairsThisSession >= config.maxPairsPerSession) {
    return wait('SESSION_PAIR_CAP', `The session has already bought ${risk.pairsThisSession} of its ${config.maxPairsPerSession} allowed pairs.`);
  }
  if (config.maxDailyLoss > 0 && risk.dailyNet <= -config.maxDailyLoss) {
    return wait('DAILY_LOSS_CAP', `Daily loss cap reached (${risk.dailyNet.toFixed(2)} against −${config.maxDailyLoss.toFixed(2)}).`);
  }
  if (config.dailyTakeProfit > 0 && risk.dailyNet >= config.dailyTakeProfit) {
    return wait('DAILY_TAKE_PROFIT', `Daily take-profit reached (+${risk.dailyNet.toFixed(2)} against +${config.dailyTakeProfit.toFixed(2)}).`);
  }
  if (risk.consecutiveLosingPairs >= config.maxConsecutiveLosingPairs) {
    return wait('CONSECUTIVE_LOSS_STOP', `${risk.consecutiveLosingPairs} losing pairs in a row — the stop is set at ${config.maxConsecutiveLosingPairs}.`);
  }
  if (config.maxSessionMinutes > 0 && risk.sessionStartedAt !== null && now - risk.sessionStartedAt >= config.maxSessionMinutes * 60_000) {
    return wait('SESSION_TIME_LIMIT', `The ${config.maxSessionMinutes}-minute session limit has elapsed.`);
  }
  if (risk.lastPairAt !== null && now - risk.lastPairAt < config.cooldownMs) {
    const remaining = Math.ceil((config.cooldownMs - (now - risk.lastPairAt)) / 1_000);
    return wait('COOLDOWN', `Cooldown: ${remaining}s until the next pair may be bought.`);
  }

  reasonCodes.push('READY');
  return {
    decision: {
      id: decisionId(now),
      at: now,
      symbol: input.symbol,
      mode: input.mode,
      action: 'TRADE',
      actionLabel: `Buy ${direction === 'CALL' ? 'Rise' : 'Fall'} + ${direction === 'CALL' ? 'Fall' : 'Rise'}`,
      reasons,
      reasonCodes,
      direction,
      uniformity: analysis.uniformity.score,
      probability: measured,
      primaryStake: sizing.primaryStake,
      coverStake: sizing.coverStake,
      executed: false,
      pairId: null,
      error: null,
    },
    sizing,
    economics,
    evidence,
    measured,
    breakEven: economics.breakEvenProbability,
    details,
  };
}

/** The two legs a decision would buy, in the order they are sent. */
export function legsForDecision(direction: MafiaDirection, sizing: MafiaSizing): Array<{
  side: 'primary' | 'cover';
  direction: MafiaDirection;
  stake: number;
}> {
  return [
    { side: 'primary', direction, stake: sizing.primaryStake },
    { side: 'cover', direction: oppositeDirection(direction), stake: sizing.coverStake },
  ];
}

/**
 * Session stop checks that apply between decisions (a loss cap already breached,
 * a take-profit already banked). Kept separate from `evaluateMafiaEntry` so the
 * hook can raise the stop even when the market would not trade.
 */
export function mafiaSessionStop(input: {
  config: MafiaBotConfig;
  risk: MafiaRiskSnapshot;
  now: number;
}): string | null {
  const { config, risk, now } = input;
  if (config.maxDailyLoss > 0 && risk.dailyNet <= -config.maxDailyLoss) {
    return `Daily loss cap reached (${risk.dailyNet.toFixed(2)} against −${config.maxDailyLoss.toFixed(2)}).`;
  }
  if (config.dailyTakeProfit > 0 && risk.dailyNet >= config.dailyTakeProfit) {
    return `Daily take-profit reached (+${risk.dailyNet.toFixed(2)} against +${config.dailyTakeProfit.toFixed(2)}).`;
  }
  if (risk.consecutiveLosingPairs >= config.maxConsecutiveLosingPairs) {
    return `${risk.consecutiveLosingPairs} losing pairs in a row — the stop is set at ${config.maxConsecutiveLosingPairs}.`;
  }
  if (config.maxSessionMinutes > 0 && risk.sessionStartedAt !== null && now - risk.sessionStartedAt >= config.maxSessionMinutes * 60_000) {
    return `The ${config.maxSessionMinutes}-minute session limit has elapsed.`;
  }
  return null;
}

/** The contract length every Mafia leg uses. Exposed so UI copy and tests agree. */
export const MAFIA_LEG_DURATION = MAFIA_DURATION_TICKS;

/** Convenience for the UI: how a pair's three outcomes read. */
export function describeMafiaPairOutcomes(direction: MafiaDirection): string[] {
  const opposite = oppositeDirection(direction);
  return [
    `${direction === 'CALL' ? 'Rise' : 'Fall'} leg wins → its payout covers both legs (net positive).`,
    `${opposite === 'CALL' ? 'Rise' : 'Fall'} leg wins → only the cover payout is returned, so the pair loses the difference.`,
    'Price ends the window level → both legs lose their full stakes.',
  ];
}

export type { MafiaAccountState };
