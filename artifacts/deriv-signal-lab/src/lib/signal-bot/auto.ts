// Auto-run rule for Load and Run.
//
// Load and Run is started either by hand or, when the dock's Auto switch is on,
// by the analysis itself: the moment Run Analysis publishes a signal the bot
// starts on it without another click. Auto is a per-signal handoff, not a
// looping strategy — one new analysis means at most one automatic start, and
// turning Auto off returns the bot to the manual button.
//
// The decision is a pure function so the rules are testable without a DOM, a
// socket or an account:
//
//   * only a signal that arrived AFTER Auto was switched on can start the bot
//     (`handoffRunId`); the signal already on screen when the switch flips is
//     never traded behind the user's back;
//   * each signal id is handed over at most once, so a re-render, a settings
//     change or a tab switch can never start a second run;
//   * a running bot is never replaced — a signal that arrives mid-run is
//     skipped, not stacked on top of the contract already open;
//   * the same preconditions the manual button enforces (a tradeable plan, an
//     engine entry, a connected account and a valid stake) must hold, and a
//     snapshot too old for the bot to trust is refused here rather than being
//     turned into an error banner by the bot itself.
//
// Nothing here performs I/O: the dock wires the decision to the bot.
import type { EntryPlan } from '../signal-engine/entry.ts';

/** An analysis older than this is not auto-traded (the bot's own ceiling). */
export const AUTO_MAX_ANALYSIS_AGE_MS = 15 * 60_000;

export type AutoRunState =
  /** Auto is switched off: the user starts Load and Run by hand. */
  | 'manual'
  /** Auto is on but no signal has been generated since it was armed. */
  | 'armed'
  /** This exact signal has already been handed to the bot. */
  | 'idle'
  /** The signal was handed over and the bot was started on it. */
  | 'started'
  /** A new signal arrived while the bot was still trading another one. */
  | 'busy'
  /** The signal carries no engine entry, so the bot would refuse it. */
  | 'no-entry'
  /** The signal cannot be expressed as a ticket on this market/duration. */
  | 'not-tradeable'
  /** A validated Forge/confirmation veto forbids this entry. */
  | 'master-veto'
  /** The analysis is older than the bot is willing to trade. */
  | 'stale'
  /** Auto is on but there is no authenticated Deriv session. */
  | 'disconnected'
  /** Auto is on but the stake in the ticket is not usable. */
  | 'invalid-stake';

export type AutoRunDecision = {
  /** True only when the dock should start the bot on this signal right now. */
  start: boolean;
  /**
   * True when this signal id is finished with — started or deliberately
   * skipped — so the dock records it and never acts on it again.
   */
  handoff: boolean;
  state: AutoRunState;
  /** One line the dock shows under the bot settings. */
  note: string;
};

export type AutoRunInput = {
  /** The dock's Auto switch. */
  enabled: boolean;
  /** Analysis id (`runId`) of the signal currently loaded, 0 when none. */
  runId: number;
  /** Signal id already handed to the bot, 0 when none. */
  handoffRunId: number;
  /** A finished analysis produced a tradeable plan for the dock. */
  planReady: boolean;
  /** The master verdict or action is NO_EDGE; hard veto, never auto-run. */
  masterVetoed?: boolean;
  /** The plan carries an entry the engine analysis produced. */
  entryReady: boolean;
  /** The bot is currently trading (or waiting for its entry). */
  botRunning: boolean;
  /** An authenticated Deriv session is connected. */
  connected: boolean;
  /** The stake typed into the ticket is a usable amount. */
  stakeValid: boolean;
  /** Age of the analysis in milliseconds; null when the timestamp is unknown. */
  analysisAgeMs?: number | null;
  /** Overrides AUTO_MAX_ANALYSIS_AGE_MS (tests, future settings). */
  maxAnalysisAgeMs?: number;
  /**
   * How long the analysis measured this edge to last (`master.validity.ms`).
   * The bot refuses a snapshot older than three validity windows (with a
   * two-minute floor); Auto applies the same rule so a signal that looks fresh
   * enough by the clock but stale by its own measurement is never started.
   */
  validityMs?: number | null;
  /** Kept for callers that already validated the entry outside this rule. */
  entry?: EntryPlan | null;
};

/** The dock's one-line description of what Auto is currently doing. */
export function describeAutoRun(decision: AutoRunDecision): string {
  return decision.note;
}

/**
 * Decide whether a freshly generated signal should start Load and Run.
 * Deterministic and side-effect free: the same inputs always answer the same.
 */
export function decideAutoRun(input: AutoRunInput): AutoRunDecision {
  if (!input.enabled) {
    return {
      start: false,
      handoff: false,
      state: 'manual',
      note: 'Auto is off — press Load and Run to start the bot on a signal.',
    };
  }

  const runId = Number.isFinite(input.runId) ? Math.trunc(input.runId) : 0;
  const handled = Number.isFinite(input.handoffRunId) ? Math.trunc(input.handoffRunId) : 0;

  if (runId <= 0) {
    return {
      start: false,
      handoff: false,
      state: 'armed',
      note: 'Auto is on — Run Analysis starts the bot the moment a signal is generated.',
    };
  }

  if (runId === handled) {
    return {
      start: false,
      handoff: false,
      state: 'idle',
      note: 'Auto is on — this signal has already been handled; the next analysis starts the bot again.',
    };
  }

  const skip = (state: AutoRunState, note: string): AutoRunDecision => ({ start: false, handoff: true, state, note });

  // The bot trades the analysis, so a signal without the engine's entry is not
  // something Auto can act on. It is skipped once and reported, exactly like
  // pressing Load and Run on it would be refused.
  if (!input.entryReady) {
    return skip('no-entry', 'Auto skipped this signal: it carries no entry from the engine analysis. Run Analysis again.');
  }
  if (!input.planReady) {
    return skip('not-tradeable', 'Auto skipped this signal: it cannot be expressed as a ticket on this market and duration.');
  }
  if (input.masterVetoed) {
    return skip('master-veto', 'Auto skipped this signal: the master decision vetoed entry (NO_EDGE), and Auto never trades a vetoed candidate on its own. Press Load and Run to trade it by hand, or Run Analysis again.');
  }
  // Never replace a run in progress: the contract already open belongs to the
  // signal the bot was loaded with.
  if (input.botRunning) {
    return skip('busy', 'Auto skipped this signal: the bot was still running. Stop it first, then run the analysis again.');
  }

  const age = typeof input.analysisAgeMs === 'number' && Number.isFinite(input.analysisAgeMs) ? input.analysisAgeMs : null;
  const ceiling = typeof input.maxAnalysisAgeMs === 'number' && Number.isFinite(input.maxAnalysisAgeMs)
    ? Math.max(0, input.maxAnalysisAgeMs)
    : AUTO_MAX_ANALYSIS_AGE_MS;
  if (age !== null && age > ceiling) {
    return skip('stale', `Auto skipped this signal: the analysis is ${Math.round(age / 60_000)} minutes old. Run Analysis again.`);
  }
  // A signal the analysis measured valid for a handful of ticks must not be
  // armed minutes later. Same floor as the bot, so Auto cannot hand it a
  // snapshot the bot would immediately refuse.
  const validityMs = typeof input.validityMs === 'number' && Number.isFinite(input.validityMs) ? Math.max(0, input.validityMs) : 0;
  if (age !== null && validityMs > 0 && age > Math.max(120_000, validityMs * 3)) {
    return skip('stale', `Auto skipped this signal: it was measured valid for about ${Math.max(1, Math.round(validityMs / 1_000))}s and the analysis is ${Math.round(age / 1_000)}s old. Run Analysis again.`);
  }

  if (!input.connected) {
    return skip('disconnected', 'Auto is on, but no Deriv account is connected, so this signal was not traded. Connect, then press Load and Run.');
  }
  if (!input.stakeValid) {
    return skip('invalid-stake', 'Auto is on, but the stake in the ticket is not usable, so this signal was not traded.');
  }

  return {
    start: true,
    handoff: true,
    state: 'started',
    note: 'Auto started the bot on this signal.',
  };
}
