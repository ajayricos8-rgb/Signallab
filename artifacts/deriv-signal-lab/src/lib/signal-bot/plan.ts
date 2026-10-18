// Signal bot rules: how many runs a signal is worth, how the martingale ladder
// sizes each stake, which entry each run waits for, and when the bot must stop.
//
// Pure functions only — the React hook in `hooks/use-signal-bot.ts` owns the
// ordering, waiting, quoting and purchasing so these rules can be tested in
// isolation.
import type { SignalStrength } from '../signal-engine/confidence.ts';
import { entryWindowMs, rebaseEntryPlan, type EntryPlan } from '../signal-engine/entry.ts';
import type {
  SignalBotConfig,
  SignalBotEntryMode,
  SignalBotRun,
  SignalBotStopReason,
  SignalBotSummary,
} from './types.ts';

export const SIGNAL_BOT_LIMITS = {
  stake: { min: 0.01, max: 50_000 },
  martingaleMultiplier: { min: 1, max: 5 },
  maxMartingaleSteps: { min: 0, max: 10 },
  stopLossStreak: { min: 0, max: 20 },
  maxRuns: { min: 0, max: 100 },
} as const;

export const SIGNAL_BOT_ENTRY_MODES: SignalBotEntryMode[] = ['analysis', 'skip'];

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
    maxRuns: 0,
    entryMode: 'analysis',
  };
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

function roundStake(value: number): number {
  return Math.round(value * 100) / 100;
}

export function sanitizeSignalBotConfig(input: Partial<SignalBotConfig> | null | undefined): SignalBotConfig {
  const base = defaultSignalBotConfig();
  if (!input) return base;
  return {
    baseStake: roundStake(clampNumber(input.baseStake, SIGNAL_BOT_LIMITS.stake, base.baseStake)),
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
    maxRuns: Math.round(clampNumber(input.maxRuns, SIGNAL_BOT_LIMITS.maxRuns, base.maxRuns)),
    entryMode: sanitizeEntryMode(input.entryMode),
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
  const base = roundStake(clampNumber(config.baseStake, SIGNAL_BOT_LIMITS.stake, 1));
  const steps = Math.round(clampNumber(config.maxMartingaleSteps, SIGNAL_BOT_LIMITS.maxMartingaleSteps, 0));
  const multiplier = clampNumber(config.martingaleMultiplier, SIGNAL_BOT_LIMITS.martingaleMultiplier, 1);
  const streak = Number.isFinite(lossStreak) ? Math.max(0, Math.round(lossStreak)) : 0;
  if (steps <= 0 || multiplier <= 1) return { stake: base, step: 0, exhausted: false };
  if (streak === 0) return { stake: base, step: 0, exhausted: false };
  if (streak > steps) return { stake: base, step: 0, exhausted: true };
  return { stake: roundStake(base * multiplier ** streak), step: streak, exhausted: false };
}

/** Highest stake the configured ladder can reach, for the dock's warning line. */
export function maxLadderStake(config: SignalBotConfig): number {
  const plan = stakeForRun(config, Math.min(config.maxMartingaleSteps, SIGNAL_BOT_LIMITS.maxMartingaleSteps.max));
  return plan.stake;
}

/**
 * Decides whether the bot may buy another contract.
 *
 * `runsStarted` counts runs already attempted (open, settled or failed).
 */
export function nextRunDecision(input: {
  status: 'running' | 'stopped' | 'completed' | 'error' | 'idle';
  runsStarted: number;
  targetRuns: number;
  lossStreak: number;
  config: SignalBotConfig;
}): { buy: boolean; reason: SignalBotStopReason } {
  if (input.status !== 'running') return { buy: false, reason: input.status === 'idle' ? null : (input.status as SignalBotStopReason) };
  if (input.runsStarted >= input.targetRuns) return { buy: false, reason: 'runs' };
  if (input.config.stopLossStreak > 0 && input.lossStreak >= input.config.stopLossStreak)
    return { buy: false, reason: 'stop-loss' };
  return { buy: true, reason: null };
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
