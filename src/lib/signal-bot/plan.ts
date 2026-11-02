// Signal bot rules: how many runs a signal is worth, how the martingale ladder
// sizes each stake, which entry each run waits for, and when the bot must stop
// (run count, stop loss, or either take profit target — winning runs / profit).
//
// Pure functions only — the React hook in `hooks/use-signal-bot.ts` owns the
// ordering, waiting, quoting and purchasing so these rules can be tested in
// isolation.
import type { SignalStrength } from '../signal-engine/confidence.ts';
import { entryWindowMs, rebaseEntryPlan, type EntryPlan } from '../signal-engine/entry.ts';
import type {
  SignalBotConfig,
  SignalBotEntryMode,
  SignalBotObjective,
  SignalBotRun,
  SignalBotStopReason,
  SignalBotSummary,
} from './types.ts';

export const SIGNAL_BOT_LIMITS = {
  stake: { min: 0.01, max: 50_000 },
  martingaleMultiplier: { min: 1, max: 5 },
  maxMartingaleSteps: { min: 0, max: 10 },
  stopLossStreak: { min: 0, max: 20 },
  /** Take profit by runs: winning runs banked before the bot stops. */
  takeProfitWins: { min: 0, max: 100 },
  /** Take profit by profit: realised profit in the account currency. */
  takeProfitAmount: { min: 0, max: 100_000 },
  maxRuns: { min: 0, max: 100 },
} as const;

export const SIGNAL_BOT_ENTRY_MODES: SignalBotEntryMode[] = ['analysis', 'skip'];
export const SIGNAL_BOT_OBJECTIVES: SignalBotObjective[] = ['edge', 'hit-rate'];

export const SIGNAL_BOT_OBJECTIVE_LABELS: Record<SignalBotObjective, string> = {
  edge: 'Highest certified edge',
  'hit-rate': 'Highest win rate (no negative edge)',
};

export const SIGNAL_BOT_ENTRY_MODE_LABELS: Record<SignalBotEntryMode, string> = {
  analysis: 'Enter at the signal price',
  skip: 'Skip that run',
};

/** Baseline runs per signal strength, nudged by the confidence score. */
export const SIGNAL_BOT_RUNS_BY_STRENGTH: Record<SignalStrength, number> = {
  STRONG: 20,
  MODERATE: 12,
  WEAK: 6,
};

export const SIGNAL_BOT_RUNS_LIMIT = 100;

export function defaultSignalBotConfig(): SignalBotConfig {
  return {
    baseStake: 1,
    martingaleMultiplier: 2,
    maxMartingaleSteps: 3,
    stopLossStreak: 3,
    // Both take profit targets start off: the run count the analysis suggests
    // is the default exit, and a goal the user did not set never stops a run.
    takeProfitWins: 0,
    takeProfitAmount: 0,
    maxRuns: 0,
    entryMode: 'analysis',
    // The edge objective is the shipped default: it trades the signal the
    // analysis publishes. Hit-rate mode is an explicit choice.
    objective: 'edge',
  };
}

function sanitizeObjective(value: unknown): SignalBotObjective {
  return typeof value === 'string' && (SIGNAL_BOT_OBJECTIVES as string[]).includes(value)
    ? (value as SignalBotObjective)
    : 'edge';
}

function sanitizeEntryMode(value: unknown): SignalBotEntryMode {
  return typeof value === 'string' && (SIGNAL_BOT_ENTRY_MODES as string[]).includes(value)
    ? (value as SignalBotEntryMode)
    : 'analysis';
}

function clampNumber(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function sanitizeSignalBotConfig(input: Partial<SignalBotConfig> | null | undefined): SignalBotConfig {
  const base = defaultSignalBotConfig();
  if (!input) return base;
  return {
    baseStake: roundMoney(clampNumber(input.baseStake, SIGNAL_BOT_LIMITS.stake, base.baseStake)),
    martingaleMultiplier: clampNumber(
      input.martingaleMultiplier,
      SIGNAL_BOT_LIMITS.martingaleMultiplier,
      base.martingaleMultiplier,
    ),
    maxMartingaleSteps: Math.round(
      clampNumber(input.maxMartingaleSteps, SIGNAL_BOT_LIMITS.maxMartingaleSteps, base.maxMartingaleSteps),
    ),
    stopLossStreak: Math.round(
      clampNumber(input.stopLossStreak, SIGNAL_BOT_LIMITS.stopLossStreak, base.stopLossStreak),
    ),
    takeProfitWins: Math.round(
      clampNumber(input.takeProfitWins, SIGNAL_BOT_LIMITS.takeProfitWins, base.takeProfitWins),
    ),
    takeProfitAmount: roundMoney(
      clampNumber(input.takeProfitAmount, SIGNAL_BOT_LIMITS.takeProfitAmount, base.takeProfitAmount),
    ),
    maxRuns: Math.round(clampNumber(input.maxRuns, SIGNAL_BOT_LIMITS.maxRuns, base.maxRuns)),
    entryMode: sanitizeEntryMode(input.entryMode),
    objective: sanitizeObjective(input.objective),
  };
}

/**
 * How many runs a finished analysis is worth.
 *
 * Stronger evidence earns more runs: STRONG ≈ 20, MODERATE ≈ 12, WEAK ≈ 6,
 * plus or minus one run for every 10 confidence points away from 60. The dock
 * lets the user override the number with its own runs box.
 */
export function recommendedRuns(input: {
  confidence: number;
  strength: SignalStrength;
  backtestSample?: number | null;
}): number {
  const base = SIGNAL_BOT_RUNS_BY_STRENGTH[input.strength] ?? SIGNAL_BOT_RUNS_BY_STRENGTH.WEAK;
  const confidence = Number.isFinite(input.confidence) ? input.confidence : 50;
  const nudge = Math.round((Math.min(100, Math.max(0, confidence)) - 60) / 10);
  return Math.min(SIGNAL_BOT_RUNS_LIMIT, Math.max(1, base + nudge));
}

/** The dock's runs box wins when set; otherwise the analysis decides. */
export function resolveMaxRuns(config: SignalBotConfig, recommended: number): number {
  const overridden = config.maxRuns > 0 ? config.maxRuns : Math.round(recommended);
  if (!Number.isFinite(overridden) || overridden < 1) return 1;
  return Math.min(SIGNAL_BOT_RUNS_LIMIT, Math.round(overridden));
}

export type StakePlan = {
  stake: number;
  /** 0 is the base stake. */
  step: number;
  /** True once the streak ran past the ladder, so the stake reset to base. */
  exhausted: boolean;
};

/**
 * Martingale ladder: base × multiplier^step, where step is the current losing
 * streak. Past the last configured step the ladder is exhausted and the stake
 * resets to the base stake instead of growing without limit.
 */
export function stakeForRun(config: SignalBotConfig, lossStreak: number): StakePlan {
  const base = roundMoney(clampNumber(config.baseStake, SIGNAL_BOT_LIMITS.stake, 1));
  const steps = Math.round(clampNumber(config.maxMartingaleSteps, SIGNAL_BOT_LIMITS.maxMartingaleSteps, 0));
  const multiplier = clampNumber(config.martingaleMultiplier, SIGNAL_BOT_LIMITS.martingaleMultiplier, 1);
  const streak = Number.isFinite(lossStreak) ? Math.max(0, Math.round(lossStreak)) : 0;
  if (steps <= 0 || multiplier <= 1) return { stake: base, step: 0, exhausted: false };
  if (streak === 0) return { stake: base, step: 0, exhausted: false };
  if (streak > steps) return { stake: base, step: 0, exhausted: true };
  return { stake: roundMoney(base * multiplier ** streak), step: streak, exhausted: false };
}

/** Highest stake the configured ladder can reach, for the dock's warning line. */
export function maxLadderStake(config: SignalBotConfig): number {
  const plan = stakeForRun(config, Math.min(config.maxMartingaleSteps, SIGNAL_BOT_LIMITS.maxMartingaleSteps.max));
  return plan.stake;
}

export type TakeProfitTarget = 'profit' | 'wins';

/**
 * Live state of the two take profit targets the dock configures.
 *
 * A run can aim at either one, both, or neither: `takeProfitWins` banks a
 * number of winning runs, `takeProfitAmount` banks a realised profit amount in
 * the account currency. Both start at 0, which turns that target off.
 */
export type TakeProfitState = {
  /** True when at least one target is configured. */
  enabled: boolean;
  /** Which target the run has reached, if any. */
  reached: TakeProfitTarget | null;
  /** Configured money target (0 = off). */
  profitTarget: number;
  /** Configured winning-run target (0 = off). */
  winsTarget: number;
  /** Realised profit of settled runs. */
  profit: number;
  /** Winning runs settled so far. */
  wins: number;
  /** Money still needed for the profit target (0 once reached or off). */
  profitRemaining: number;
  /** Winning runs still needed for the runs target (0 once reached or off). */
  winsRemaining: number;
};

export function takeProfitState(
  config: SignalBotConfig,
  progress: { profit: number; wins: number },
): TakeProfitState {
  const profitTarget = roundMoney(
    clampNumber(config.takeProfitAmount, SIGNAL_BOT_LIMITS.takeProfitAmount, 0),
  );
  const winsTarget = Math.round(
    clampNumber(config.takeProfitWins, SIGNAL_BOT_LIMITS.takeProfitWins, 0),
  );
  const profit = Number.isFinite(progress.profit) ? roundMoney(progress.profit) : 0;
  const wins = Number.isFinite(progress.wins) ? Math.max(0, Math.round(progress.wins)) : 0;
  const profitReached = profitTarget > 0 && profit >= profitTarget;
  const winsReached = winsTarget > 0 && wins >= winsTarget;
  return {
    enabled: profitTarget > 0 || winsTarget > 0,
    // When both targets are met the money target is named, because it is the
    // one configured in cash; either way the run stops buying.
    reached: profitReached ? 'profit' : winsReached ? 'wins' : null,
    profitTarget,
    winsTarget,
    profit,
    wins,
    profitRemaining: profitTarget > 0 ? Math.max(0, roundMoney(profitTarget - profit)) : 0,
    winsRemaining: winsTarget > 0 ? Math.max(0, winsTarget - wins) : 0,
  };
}

/**
 * Decides whether the bot may buy another contract.
 *
 * `runsStarted` counts runs already attempted (open, settled or failed),
 * `profit` is the realised profit of settled runs and `wins` the winning runs
 * settled so far. The risk stops are evaluated before the targets: a losing
 * streak that trips the stop loss ends the run even if an earlier win streak
 * already banked the take profit.
 */
export function nextRunDecision(input: {
  status: 'running' | 'stopped' | 'completed' | 'error' | 'idle';
  runsStarted: number;
  targetRuns: number;
  lossStreak: number;
  config: SignalBotConfig;
  /** Realised profit of settled runs; defaults to 0 (profit target unfed). */
  profit?: number;
  /** Winning runs settled so far; defaults to 0 (runs target unfed). */
  wins?: number;
  /**
   * The probability the loaded signal was published at, plus the run's own
   * settled record. When supplied, a record that no longer matches the
   * measurement stops the bot before the stop loss would.
   */
  calibration?: { published: number; settled: number } | null;
}): { buy: boolean; reason: SignalBotStopReason } {
  if (input.status !== 'running') return { buy: false, reason: input.status === 'idle' ? null : (input.status as SignalBotStopReason) };
  if (input.config.stopLossStreak > 0 && input.lossStreak >= input.config.stopLossStreak)
    return { buy: false, reason: 'stop-loss' };
  if (input.calibration && calibrationGuard({
    published: input.calibration.published,
    settled: input.calibration.settled,
    wins: input.wins ?? 0,
  }).stop) return { buy: false, reason: 'calibration' };
  const takeProfit = takeProfitState(input.config, {
    profit: input.profit ?? 0,
    wins: input.wins ?? 0,
  });
  if (takeProfit.reached) return { buy: false, reason: 'take-profit' };
  if (input.runsStarted >= input.targetRuns) return { buy: false, reason: 'runs' };
  return { buy: true, reason: null };
}

/**
 * Has the run's own record stopped matching the probability it was sold on?
 *
 * Every run is a bet on a published probability p. After n settled runs the
 * wins are Binomial(n, p); if the observed count falls far enough below n·p the
 * simplest explanation is that the edge is not there, and continuing only
 * spends more stake to prove it. The test is one-sided (losses matter, wins do
 * not), needs at least eight settled runs, and demands three standard errors —
 * a guard against a bad streak being called a broken model.
 */
export function calibrationGuard(input: {
  published: number;
  settled: number;
  wins: number;
  minimumRuns?: number;
  zBar?: number;
}): { stop: boolean; z: number | null; expectedWins: number; detail: string } {
  const probability = Number.isFinite(input.published) ? Math.min(0.999, Math.max(0.001, input.published)) : 0.5;
  const settled = Math.max(0, Math.round(input.settled));
  const wins = Math.max(0, Math.min(settled, Math.round(input.wins)));
  const minimumRuns = Math.max(4, Math.round(input.minimumRuns ?? 8));
  const zBar = Number.isFinite(input.zBar) ? (input.zBar as number) : 3;
  const expectedWins = settled * probability;
  const standardError = Math.sqrt(settled * probability * (1 - probability));
  const z = settled > 0 && standardError > 1e-9 ? (wins - expectedWins) / standardError : null;
  const stop = settled >= minimumRuns && z !== null && z <= -zBar;
  return {
    stop,
    z,
    expectedWins,
    detail: stop
      ? `The bot won ${wins} of ${settled} settled runs against ${(100 * probability).toFixed(1)}% published (${expectedWins.toFixed(1)} expected, z ${z!.toFixed(1)}). The results no longer match the measurement, so the run stops instead of spending more stake on it.`
      : `Results track the measurement: ${wins}/${settled} settled wins against ${(100 * probability).toFixed(1)}% published${z === null ? '' : ` (z ${z.toFixed(1)})`}.`,
  };
}

/**
 * Which candidate inside a finished analysis the bot should trade.
 *
 * `edge` keeps the published signal. `hit-rate` looks for the contract with the
 * highest probability that is still priced at or above its own fair rate: it
 * wins more often without taking a negative-expectation bet, which is the only
 * honest way to raise the hit rate. When no candidate qualifies the published
 * signal is used, so the bot always has something to trade.
 */
export function chooseRunCandidate<T extends { probability: number; fairProbability: number }>(
  candidates: readonly T[],
  objective: SignalBotObjective,
): T | null {
  if (!candidates.length) return null;
  if (objective !== 'hit-rate') return candidates[0];
  const priced = candidates.filter((candidate) =>
    Number.isFinite(candidate.probability) && Number.isFinite(candidate.fairProbability)
    && candidate.probability >= candidate.fairProbability);
  if (!priced.length) return candidates[0];
  return [...priced].sort((left, right) =>
    right.probability - left.probability
    || (right.probability - right.fairProbability) - (left.probability - left.fairProbability))[0];
}

export type RunEntryDecision = {
  /** The entry this run waits for, already re-based on the live quote. */
  entry: EntryPlan;
  /** False when the bot buys straight away (market entries). */
  wait: boolean;
  /** What happens when the window closes without an entry. */
  fallback: 'market' | 'skip';
  /** Wall-clock moment the entry window closes. */
  deadline: number;
  /** Line for the ledger while the bot waits. */
  note: string;
};

/**
 * Turns the entry the analysis planned into the decision for one run.
 *
 * The entry is never invented here: it is the plan the engine produced, and the
 * level is re-based on the live quote so run 12 waits for the same measured
 * pullback run 1 did instead of an absolute price that has gone stale. The
 * dock's Entry setting only picks what happens when the trigger never arrives —
 * enter at market exactly as the replay scored it, or skip the run.
 */
export function planRunEntry(input: {
  config: SignalBotConfig;
  entry: EntryPlan;
  /** Latest quote of the plan's market, when the feed has one. */
  quote: number | null;
  /** Median milliseconds between ticks on that market. */
  tickSpacingMs: number;
  now: number;
}): RunEntryDecision {
  const mode = sanitizeEntryMode(input.config.entryMode);
  const entry = rebaseEntryPlan(input.entry, input.quote);
  const fallback: 'market' | 'skip' = mode === 'skip' ? 'skip' : 'market';
  // Immediate is the analysis's own conclusion (no timing edge to wait for),
  // so it is followed rather than overridden.
  const wait = entry.trigger !== 'immediate';
  const from = `${entry.evidence.agreeing}/${entry.evidence.total} engines${entry.evidence.signalProbability === null ? '' : `, the analysis rates the trade ${(entry.evidence.signalProbability * 100).toFixed(1)}% against a ${(entry.evidence.fairRate * 100).toFixed(1)}% no-edge rate`}`;
  return {
    entry,
    wait,
    fallback,
    deadline: wait ? input.now + entryWindowMs(entry, input.tickSpacingMs) : input.now,
    note:
      entry.trigger === 'immediate'
        ? `Entry next tick, from the analysis: it measured no timing edge to wait for (${from}).`
        : `${entry.label} from the analysis: ${entry.contextLabel ?? entryNoteTarget(entry)} (${from}).`,
  };
}

function entryNoteTarget(entry: EntryPlan): string {
  if (entry.priceLevel === null) return 'waiting for the planned entry';
  return `waiting for the quote ${entry.priceCondition === 'below' ? 'to fall to' : 'to rise to'} the entry level`;
}

/** How long to wait for one contract to settle before giving up on its result. */
export function settlementTimeoutMs(duration: number, unit: 't' | 's' | 'm'): number {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1;
  const estimated =
    unit === 't' ? safeDuration * 1_200 : unit === 's' ? safeDuration * 1_000 : safeDuration * 60_000;
  return Math.min(600_000, Math.max(45_000, estimated + 45_000));
}

export function summarizeBotRuns(runs: readonly SignalBotRun[], config: SignalBotConfig): SignalBotSummary {
  let wins = 0;
  let losses = 0;
  let failed = 0;
  let skipped = 0;
  let open = 0;
  let unknown = 0;
  let staked = 0;
  let profit = 0;

  for (const run of runs) {
    // Only a run that actually got a contract out of Deriv charged the account:
    // a refused order, a skipped entry and a run still waiting for its entry
    // have no contract id yet.
    if (run.contractId !== null) staked += run.stake;
    if (run.status === 'won') {
      wins += 1;
      profit += run.profit ?? 0;
    } else if (run.status === 'lost') {
      losses += 1;
      profit += run.profit ?? 0;
    } else if (run.status === 'failed') {
      failed += 1;
    } else if (run.status === 'skipped') {
      skipped += 1;
    } else if (run.status === 'open' || run.status === 'waiting') {
      open += 1;
    } else {
      unknown += 1;
    }
  }

  const settled = wins + losses;
  let streak = 0;
  for (const run of [...runs].reverse()) {
    if (run.status === 'lost') streak += 1;
    else if (run.status === 'won' || run.status === 'failed') break;
    // 'open' / 'waiting' / 'unknown' / 'skipped' runs do not break the streak:
    // no contract was decided by them, so the next stake is still decided by
    // the last known result.
  }

  return {
    started: runs.length,
    settled,
    wins,
    losses,
    failed,
    skipped,
    open: open + unknown,
    staked: Math.round(staked * 100) / 100,
    profit: Math.round(profit * 1e6) / 1e6,
    winRate: settled ? wins / settled : null,
    lossStreak: streak,
    nextMartingaleStep: stakeForRun(config, streak).step,
  };
}

/** Human-readable reason the bot is no longer trading. */
export function describeStopReason(reason: SignalBotStopReason): string {
  if (reason === 'runs') return 'Finished every run from the analysis.';
  if (reason === 'stop-loss') return 'Stopped by the stop loss: too many losses in a row.';
  if (reason === 'take-profit') return 'Stopped by take profit: the run reached the target you set.';
  if (reason === 'calibration') return 'Stopped by the calibration guard: the settled results stopped matching the published probability.';
  if (reason === 'manual') return 'Stopped by you. Contracts already bought keep running to expiry.';
  if (reason === 'error') return 'Stopped because Deriv refused an order.';
  return '';
}

/**
 * What the bot page prints about the entry it is waiting for: the trigger, how
 * long it has waited and what the plan says will happen.
 */
export function describeEntryWatch(watch: {
  label: string;
  status: 'waiting' | 'ready' | 'expired' | 'missed';
  reason: string;
  elapsedTicks: number;
  remainingTicks: number;
}): string {
  if (watch.status === 'ready') return `${watch.label} met — buying now.`;
  if (watch.status === 'expired' || watch.status === 'missed') return `${watch.label}: ${watch.reason}`;
  return `${watch.label}: ${watch.reason} Waited ${watch.elapsedTicks} tick${watch.elapsedTicks === 1 ? '' : 's'}, ${watch.remainingTicks} left.`;
}

/** Line describing how the run's entry finally resolved, for the run log. */
export function describeEntryOutcome(input: {
  status: 'ready' | 'expired' | 'missed';
  waitedTicks: number;
  fallback: 'market' | 'skip';
}): string {
  if (input.status === 'ready')
    return input.waitedTicks > 0
      ? `Entered on the analysis entry after ${input.waitedTicks} tick${input.waitedTicks === 1 ? '' : 's'}.`
      : 'Entered on the analysis entry.';
  const why = input.status === 'missed'
    ? 'The quote gapped past the entry level, so the exact entry the replay measured was missed'
    : 'Entry window closed';
  return input.fallback === 'skip'
    ? `${why} — run skipped because the Entry setting says not to chase it.`
    : `${why} — entered at the market price instead.`;
}
