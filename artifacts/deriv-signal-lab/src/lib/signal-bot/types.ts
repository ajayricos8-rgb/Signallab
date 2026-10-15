// Types for the signal bot that runs on the mini bottom trade menu.
//
// The bot is deliberately small: it takes one finished analysis (market,
// contract, tick duration and how many runs that signal is worth), then buys
// that contract over and over until the runs run out, the stop loss trips, or
// the user presses Stop. Stake and martingale settings come from the trade
// dock; the tick duration and the run count come from the analysis.
// Nothing here performs I/O, so every rule is unit tested.

export type SignalBotStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error';

export type SignalBotRunStatus = 'open' | 'won' | 'lost' | 'unknown' | 'failed';

/** Why the bot is no longer buying. `null` while it is running. */
export type SignalBotStopReason = 'manual' | 'runs' | 'stop-loss' | 'error' | null;

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
  note: string;
};

export type SignalBotSummary = {
  /** Runs the bot has started, including the one still open. */
  started: number;
  settled: number;
  wins: number;
  losses: number;
  failed: number;
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
