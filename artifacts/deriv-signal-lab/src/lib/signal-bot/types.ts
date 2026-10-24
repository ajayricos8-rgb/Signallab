// Types for the signal bot that runs on the mini bottom trade menu.
//
// The bot is deliberately small: it takes one finished analysis (market,
// contract, tick duration, the entry the analysis planned and how many runs
// that signal is worth), waits for that entry, then buys the contract over and
// over until the runs run out, the stop loss trips, a take profit target is
// reached, or the user presses Stop.
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
export type SignalBotStopReason =
  | 'manual'
  | 'runs'
  | 'stop-loss'
  /** A configured take profit target was reached. */
  | 'take-profit'
  /**
   * The bot's own settled results stopped matching the published probability:
   * the run is halted before the edge is proven absent by a long losing streak.
   */
  | 'calibration'
  | 'error'
  | null;

/**
 * What the bot does when the entry the analysis planned never arrives.
 *
 * The entry itself is never a setting: it always comes from the engine analysis
 * (`EntryPlan.evidence` is what proves it), and the bot waits for it on every
 * run. These two modes only decide the miss:
 * - `analysis`: follow the policy the replay scored — enter at the signal price
 *   when the window closes without a trigger.
 * - `skip`: only buy when the trigger fires; a run whose entry never arrives is
 *   skipped without staking anything.
 */
export type SignalBotEntryMode = 'analysis' | 'skip';

export type SignalBotConfig = {
  /** Stake typed into the trade dock. */
  baseStake: number;
  /** Stake multiplier applied after each loss. 1 disables the ladder. */
  martingaleMultiplier: number;
  /** Highest ladder step; past it the stake resets to the base stake. */
  maxMartingaleSteps: number;
  /** Consecutive losses that stop the bot. 0 disables the stop loss. */
  stopLossStreak: number;
  /**
   * Take profit by runs: the bot stops once this many runs have won.
   * 0 disables this target.
   */
  takeProfitWins: number;
  /**
   * Take profit by profit: the bot stops once the realised profit of settled
   * runs reaches this amount in the account currency. 0 disables this target.
   */
  takeProfitAmount: number;
  /** User override for the run count. 0 uses the analysis recommendation. */
  maxRuns: number;
  /** How the entry the analysis planned is used. */
  entryMode: SignalBotEntryMode;
  /**
   * What the bot optimises inside the analysis it was given.
   *
   * - `edge`     trade the signal the analysis publishes (highest certified edge).
   * - `hit-rate` trade the highest-probability contract whose published
   *              probability is not below its fair rate, so the run wins more
   *              often while still never taking a negative-expectation bet.
   */
  objective: SignalBotObjective;
};

export type SignalBotObjective = 'edge' | 'hit-rate';

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
  status: 'waiting' | 'ready' | 'expired' | 'missed';
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
