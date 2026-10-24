// LEDGER — pair settlement, summaries and the exportable trade log.
//
// A leg is settled only by a Deriv report (a sell or an expiry with a profit
// figure). A running payout is never counted as money earned, and a pair is
// finished only when every leg that was bought has reported.
import { normalizeMoney } from '../rise-fall-bot/evidence.ts';
import { HEDGE_SIDE_LABELS, type HedgeLeg, type HedgePair, type HedgePrediction, type HedgeSide } from './types.ts';

export function legOf(pair: HedgePair, side: HedgeSide): HedgeLeg {
  return side === 'HIGH' ? pair.high : pair.low;
}

/** Legs that Deriv has accepted, whether or not they have settled yet. */
export function boughtLegs(pair: HedgePair): HedgeLeg[] {
  return [pair.high, pair.low].filter((leg) => leg.contractId !== null);
}

/** A pair still needs attention while a bought leg is unsettled, or while its purchase is unconfirmed. */
export function isPairOpen(pair: HedgePair): boolean {
  if (pair.status === 'unreconciled') return true;
  if (pair.status === 'rejected') return false;
  return boughtLegs(pair).some((leg) => !legIsSettled(leg));
}

/**
 * Keeps the newest `limit` rows. Rejected rows are a log of refusals and are
 * capped separately, so a long refusal streak cannot push real pairs out.
 */
export function trimPairs(rows: readonly HedgePair[], limit: number, rejectedLimit: number): HedgePair[] {
  const rejected = rows.filter((pair) => pair.status === 'rejected').slice(-rejectedLimit);
  const kept = new Set<HedgePair>([...rows.filter((pair) => pair.status !== 'rejected'), ...rejected]);
  const ordered = rows.filter((pair) => kept.has(pair));
  return ordered.length > limit ? ordered.slice(ordered.length - limit) : ordered;
}

/** A leg that Deriv has reported on, with its realised profit. */
export function legIsSettled(leg: HedgeLeg): boolean {
  return leg.profit !== null;
}

/**
 * Records one leg's settlement. Profit above zero is a win, below zero a loss,
 * and exactly zero a push (the stake returned).
 */
export function settleLeg(
  pair: HedgePair,
  side: HedgeSide,
  update: { profit: number; exitSpot: number | null; settledAt: number },
): HedgePair {
  const leg = legOf(pair, side);
  if (leg.contractId === null || legIsSettled(leg)) return pair;
  const status = update.profit > 0 ? 'won' : update.profit < 0 ? 'lost' : 'push';
  const settledLeg: HedgeLeg = {
    ...leg,
    status,
    profit: normalizeMoney(update.profit),
    exitSpot: update.exitSpot ?? leg.exitSpot,
    settledAt: update.settledAt,
  };
  return finalizePair(side === 'HIGH' ? { ...pair, high: settledLeg } : { ...pair, low: settledLeg }, update.settledAt);
}

/**
 * Closes the pair once every bought leg has settled. Its net is the sum of the
 * leg profits; a pair with a refused leg is `partial` once the bought one ends.
 */
export function finalizePair(pair: HedgePair, now: number): HedgePair {
  const bought = boughtLegs(pair);
  if (bought.length === 0 || bought.some((leg) => !legIsSettled(leg))) return pair;
  const netProfit = normalizeMoney(bought.reduce((total, leg) => total + (leg.profit ?? 0), 0));
  const complete = pair.high.contractId !== null && pair.low.contractId !== null;
  return {
    ...pair,
    status: complete ? 'settled' : 'partial',
    netProfit,
    settledAt: pair.settledAt ?? now,
  };
}

export type PairSummary = {
  pairs: number;
  settled: number;
  open: number;
  partial: number;
  wins: number;
  losses: number;
  pushes: number;
  netProfit: number;
  grossStake: number;
  returnOnStake: number | null;
  highWinRate: number | null;
  lowWinRate: number | null;
};

/** Totals over every pair the browser has recorded. Only settled legs contribute to the P/L. */
export function summarizePairs(pairs: readonly HedgePair[]): PairSummary {
  let settled = 0;
  let open = 0;
  let partial = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let netProfit = 0;
  let grossStake = 0;
  let highSettled = 0;
  let highWins = 0;
  let lowSettled = 0;
  let lowWins = 0;
  let stakeSettled = 0;
  for (const pair of pairs) {
    if (isPairOpen(pair)) open += 1;
    if (pair.status === 'partial') partial += 1;
    if (pair.status === 'rejected') continue;
    grossStake += boughtLegs(pair).reduce((total, leg) => total + leg.stake, 0);
    for (const leg of [pair.high, pair.low]) {
      if (leg.contractId === null || !legIsSettled(leg)) continue;
      stakeSettled += leg.stake;
      if (leg.side === 'HIGH') {
        highSettled += 1;
        if (leg.status === 'won') highWins += 1;
      } else {
        lowSettled += 1;
        if (leg.status === 'won') lowWins += 1;
      }
    }
    if ((pair.status === 'settled' || pair.status === 'partial') && pair.netProfit !== null) {
      if (pair.status === 'settled') settled += 1;
      const net = pair.netProfit;
      netProfit += net;
      if (net > 0) wins += 1;
      else if (net < 0) losses += 1;
      else pushes += 1;
    }
  }
  return {
    pairs: pairs.length,
    settled,
    open,
    partial,
    wins,
    losses,
    pushes,
    netProfit: normalizeMoney(netProfit),
    grossStake: normalizeMoney(grossStake),
    returnOnStake: stakeSettled > 0 ? normalizeMoney(netProfit / stakeSettled) : null,
    highWinRate: highSettled > 0 ? highWins / highSettled : null,
    lowWinRate: lowSettled > 0 ? lowWins / lowSettled : null,
  };
}

export type PredictionSummary = {
  total: number;
  resolved: number;
  pending: number;
  expired: number;
  highHitRate: number | null;
  lowHitRate: number | null;
  bothHitRate: number | null;
};

/** Hit rates of analysis-mode predictions, each leg scored on its own. */
export function summarizePredictions(rows: readonly HedgePrediction[]): PredictionSummary {
  const resolved = rows.filter((row) => row.resolved);
  const highHits = resolved.filter((row) => row.highWon).length;
  const lowHits = resolved.filter((row) => row.lowWon).length;
  const bothHits = resolved.filter((row) => row.highWon && row.lowWon).length;
  const count = resolved.length;
  return {
    total: rows.length,
    resolved: count,
    pending: rows.filter((row) => !row.resolved && !row.expired).length,
    expired: rows.filter((row) => row.expired).length,
    highHitRate: count > 0 ? highHits / count : null,
    lowHitRate: count > 0 ? lowHits / count : null,
    bothHitRate: count > 0 ? bothHits / count : null,
  };
}

export const HEDGE_LOG_FILENAME = 'high-low-hedge-trades.csv';

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per pair, with the same leg detail the trade log shows on screen. */
export function pairsToCsv(pairs: readonly HedgePair[]): string {
  const header = [
    'pair_id', 'time', 'symbol', 'mode', 'status',
    'high_tick', 'high_contract_id', 'high_stake', 'high_payout', 'high_status', 'high_profit',
    'low_tick', 'low_contract_id', 'low_stake', 'low_payout', 'low_status', 'low_profit',
    'net_profit', 'expected_value', 'note',
  ];
  const rows = pairs.map((pair) => [
    pair.id,
    new Date(pair.at).toISOString(),
    pair.symbol,
    pair.mode,
    pair.status,
    pair.high.tickPosition,
    pair.high.contractId,
    pair.high.stake,
    pair.high.payout,
    pair.high.status,
    pair.high.profit,
    pair.low.tickPosition,
    pair.low.contractId,
    pair.low.stake,
    pair.low.payout,
    pair.low.status,
    pair.low.profit,
    pair.netProfit,
    pair.expectedValue,
    pair.note,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export function sideLabel(side: HedgeSide): string {
  return HEDGE_SIDE_LABELS[side];
}
