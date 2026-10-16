// Types for the signal bot that runs on the mini bottom trade menu.
//
// The bot is deliberately small: it takes one finished analysis (market,
// contract, tick duration, the entry the analysis planned and how many runs
// that signal is worth), waits for that entry, then buys the contract over and
// over until the runs run out, the stop loss trips, or the user presses Stop.
// Stake and martingale settings come from the trade dock; the tick duration,
// the run count and the entry come from the analysis.
// Nothing here performs I/O, so every rule is unit tested.
export type SignalBotStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error';

export type SignalBotRunStatus =
  /** Armed and waiting for the entry the analysis planned. */
  | 'waiting'
  | 'open'
  | 'won'
  | 'lost'
  | 'unknown'
  /** Deriv refused the order. */
  | 'failed'
  /** The entry window closed and the dock is set to skip a missed entry. */
  | 'skipped';

/** Why the bot is no longer buying. `null` while it is running. */
export type SignalBotStopReason = 'manual' | 'runs' | 'stop-loss' | 'error' | null;

/**
 * What the bot does with the entry the analysis planned.
 * - `analysis`: wait for it when the replay measured a gain, and enter at
 *   market if the window closes.
 * - `level`: wait for the level/context the analysis found even when the replay
 *   measured no win-rate gain for it.
 * - `market`: ignore it and buy at the signal price straight away.
 * - `skip`: like `analysis`, but a run whose entry never arrives is skipped
 *   instead of entered at market.
 */
export type SignalBotEntryMode = 'analysis' | 'level' | 'market' | 'skip';

export type SignalBotConfig = {
  /** Stake typed into the trade dock. */
  baseStake: number;
  /** Stake multiplier applied after each loss. 1 disables the ladder. */
  martingaleMultiplier: number;
  /** Highest ladder step; past it the stake resets to the base stake. */
  maxMartingaleSteps: number;
  /** Consecutive losses that stop the bot. 0 disables the stop loss. */
  stopLossStreak: number;
  /** User override for the run count. 0 uses the analysis recommendation. */
  maxRuns: number;
  /** How the entry the analysis planned is used. */
  entryMode: SignalBotEntryMode;
};

export type SignalBotRun = {
  /** 1-based run number shown to the user. */
  index: number;
  contractId: number | null;
  contractLabel: string;
  marketCode: string;
  stake: number;
  payout: number | null;
  /** Martingale step this run was bought at (0 = base stake). */
  martingaleStep: number;
  status: SignalBotRunStatus;
  profit: number | null;
  openedAt: number | null;
  settledAt: number | null;
  /** Ticks waited for the entry; null when the run never reached the entry. */
  entryTicks: number | null;
  note: string;
};

/** Live state of the entry the bot is waiting for on the run in progress. */
export type SignalBotEntryWatch = {
  runIndex: number;
  status: 'waiting' | 'ready' | 'expired';
  /** One-line reason straight from the entry check. */
  reason: string;
  /** Entry plan label, e.g. "Pullback entry". */
  label: string;
  mode: 'immediate' | 'pullback' | 'breakout' | 'context';
  priceLevel: number | null;
  priceCondition: 'above' | 'below' | null;
  contextLabel: string | null;
  /** Latest quote of the market the entry watches. */
  quote: number | null;
  /** How far the quote still is from the level. */
  distance: number | null;
  elapsedTicks: number;
  remainingTicks: number;
  remainingMs: number;
  windowTicks: number;
};

export type SignalBotSummary = {
  /** Runs the bot has started, including the one still waiting or open. */
  started: number;
  settled: number;
  wins: number;
  losses: number;
  failed: number;
  /** Runs whose entry window closed in skip mode (no contract was bought). */
  skipped: number;
  open: number;
  /** Total amount Deriv charged across every run. */
  staked: number;
  /** Realised profit of settled runs only. */
  profit: number;
  winRate: number | null;
  /** Current consecutive losing streak; drives the martingale ladder. */
  lossStreak: number;
  /** Ladder step the next run would use. */
  nextMartingaleStep: number;
};

export type SignalBotSettlement = {
  status: 'won' | 'lost' | 'unknown' | 'cancelled';
  profit: number | null;
  note: string;
};
