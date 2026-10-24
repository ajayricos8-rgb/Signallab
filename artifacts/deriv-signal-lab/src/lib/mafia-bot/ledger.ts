// LEDGER — pair construction, settlement, totals and the exportable log.
//
// Only a Deriv report settles a leg. A pair's net is the sum of the leg profits
// it actually received, so a pair that lost both legs (a level window) shows the
// full −stake, and a pair that returned its stake shows a loss of the other leg
// rather than a fabricated win.
import { normalizeMoney } from '../rise-fall-bot/evidence.ts';
import type {
  MafiaDirection,
  MafiaLeg,
  MafiaLegSide,
  MafiaPair,
  MafiaPrediction,
} from './types.ts';
import { roundMoney } from './types.ts';

export function legOf(pair: MafiaPair, side: MafiaLegSide): MafiaLeg {
  return side === 'primary' ? pair.primary : pair.cover;
}

/** Legs Deriv accepted, settled or not. */
export function boughtLegs(pair: MafiaPair): MafiaLeg[] {
  return [pair.primary, pair.cover].filter((leg) => leg.contractId !== null);
}

export function legIsSettled(leg: MafiaLeg): boolean {
  return leg.profit !== null;
}

/** A pair still needs attention while a bought leg is unsettled. */
export function isPairOpen(pair: MafiaPair): boolean {
  if (pair.status === 'unreconciled') return true;
  if (pair.status === 'rejected') return false;
  return boughtLegs(pair).some((leg) => !legIsSettled(leg));
}

export function makeMafiaLeg(input: {
  side: MafiaLegSide;
  direction: MafiaDirection;
  stake: number;
}): MafiaLeg {
  return {
    side: input.side,
    direction: input.direction,
    contractType: input.direction,
    contractId: null,
    stake: roundMoney(input.stake),
    askPrice: null,
    payout: null,
    status: 'pending',
    profit: null,
    exitSpot: null,
    settledAt: null,
    longcode: null,
  };
}

/** A pair before any leg is bought. */
export function makeMafiaPair(input: {
  id: string;
  at: number;
  symbol: string;
  mode: MafiaPair['mode'];
  direction: MafiaDirection | null;
  primaryStake: number;
  coverStake: number;
  uniformity: number | null;
  probability: number | null;
  breakEven: number | null;
  expectedValue: number | null;
  note?: string;
}): MafiaPair {
  return {
    id: input.id,
    at: input.at,
    symbol: input.symbol,
    mode: input.mode,
    status: 'open',
    direction: input.direction,
    primary: input.direction
      ? makeMafiaLeg({ side: 'primary', direction: input.direction, stake: input.primaryStake })
      : { ...makeMafiaLeg({ side: 'primary', direction: 'CALL', stake: input.primaryStake }), status: 'rejected' },
    cover: input.direction
      ? makeMafiaLeg({ side: 'cover', direction: input.direction === 'CALL' ? 'PUT' : 'CALL', stake: input.coverStake })
      : { ...makeMafiaLeg({ side: 'cover', direction: 'PUT', stake: input.coverStake }), status: 'rejected' },
    entrySpot: null,
    exitSpot: null,
    uniformity: input.uniformity,
    probability: input.probability,
    breakEven: input.breakEven,
    expectedValue: input.expectedValue,
    netProfit: null,
    balanceAfter: null,
    settledAt: null,
    note: input.note ?? '',
  };
}

/** Records the quote that was actually bought on one leg. */
export function applyLegQuote(
  pair: MafiaPair,
  side: MafiaLegSide,
  quote: { askPrice: number | null; payout: number | null; id?: string | null },
): MafiaPair {
  const leg = legOf(pair, side);
  const updated: MafiaLeg = {
    ...leg,
    askPrice: quote.askPrice === null ? leg.askPrice : normalizeMoney(quote.askPrice),
    payout: quote.payout === null ? leg.payout : normalizeMoney(quote.payout),
  };
  return side === 'primary' ? { ...pair, primary: updated } : { ...pair, cover: updated };
}

/** Records the buy receipt: the contract now exists on the account. */
export function applyLegPurchase(
  pair: MafiaPair,
  side: MafiaLegSide,
  receipt: {
    contractId: number;
    buyPrice: number;
    payout: number | null;
    balanceAfter: number | null;
    startTime: number | null;
    longcode: string | null;
  },
): MafiaPair {
  const leg = legOf(pair, side);
  const updated: MafiaLeg = {
    ...leg,
    contractId: receipt.contractId,
    stake: normalizeMoney(receipt.buyPrice > 0 ? receipt.buyPrice : leg.stake),
    payout: receipt.payout === null ? leg.payout : normalizeMoney(receipt.payout),
    status: 'open',
    longcode: receipt.longcode ?? leg.longcode,
  };
  const next = side === 'primary' ? { ...pair, primary: updated } : { ...pair, cover: updated };
  return {
    ...next,
    entrySpot: side === 'primary' ? (next.entrySpot ?? null) : next.entrySpot,
    balanceAfter: receipt.balanceAfter === null ? next.balanceAfter : normalizeMoney(receipt.balanceAfter),
  };
}

/**
 * Records one leg's settlement.
 *
 * `profit > 0` is a win, `< 0` a loss, and exactly `0` a push (stake returned).
 * A settled leg is never overwritten, so a duplicate contract report cannot
 * double-count money.
 */
export function settleMafiaLeg(
  pair: MafiaPair,
  side: MafiaLegSide,
  update: { profit: number; exitSpot: number | null; settledAt: number },
): MafiaPair {
  const leg = legOf(pair, side);
  if (leg.contractId === null || legIsSettled(leg)) return pair;
  const status = update.profit > 0 ? 'won' : update.profit < 0 ? 'lost' : 'push';
  const settled: MafiaLeg = {
    ...leg,
    status,
    profit: normalizeMoney(update.profit),
    exitSpot: update.exitSpot ?? leg.exitSpot,
    settledAt: update.settledAt,
  };
  const next = side === 'primary' ? { ...pair, primary: settled } : { ...pair, cover: settled };
  return finalizeMafiaPair(next, update.settledAt);
}

/**
 * Closes the pair once every bought leg has reported. The pair's net is the sum
 * of the realised leg profits — for a Mafia pair this is the one win minus both
 * stakes, or minus both stakes when the window was level.
 */
export function finalizeMafiaPair(pair: MafiaPair, now: number): MafiaPair {
  const bought = boughtLegs(pair);
  if (bought.length === 0 || bought.some((leg) => !legIsSettled(leg))) return pair;
  const netProfit = normalizeMoney(bought.reduce((total, leg) => total + (leg.profit ?? 0), 0));
  const complete = pair.primary.contractId !== null && pair.cover.contractId !== null;
  const exitSpot = pair.primary.exitSpot ?? pair.cover.exitSpot;
  return {
    ...pair,
    status: complete ? 'settled' : 'partial',
    netProfit,
    exitSpot,
    settledAt: pair.settledAt ?? now,
  };
}

/** Marks a pair whose legs never both arrived, so its money is not silently lost. */
export function rejectMafiaPair(pair: MafiaPair, note: string): MafiaPair {
  return {
    ...pair,
    status: boughtLegs(pair).length ? 'unreconciled' : 'rejected',
    note: pair.note ? `${pair.note} ${note}` : note,
    primary: pair.primary.status === 'pending' ? { ...pair.primary, status: 'rejected' } : pair.primary,
    cover: pair.cover.status === 'pending' ? { ...pair.cover, status: 'rejected' } : pair.cover,
  };
}

/** Keeps the newest rows, capping rejected entries separately. */
export function trimMafiaPairs(rows: readonly MafiaPair[], limit: number, rejectedLimit: number): MafiaPair[] {
  // `slice(-0)` would keep everything, so a zero cap is handled explicitly.
  const rejected = rejectedLimit > 0 ? rows.filter((pair) => pair.status === 'rejected').slice(-rejectedLimit) : [];
  const keep = new Set<MafiaPair>([...rows.filter((pair) => pair.status !== 'rejected'), ...rejected]);
  const ordered = rows.filter((pair) => keep.has(pair));
  return ordered.length > limit ? ordered.slice(ordered.length - limit) : ordered;
}

export type MafiaPairSummary = {
  pairs: number;
  /** Pairs whose legs both reported. */
  settled: number;
  open: number;
  partial: number;
  rejected: number;
  /** Pairs that made money. */
  wins: number;
  /** Pairs that lost money. */
  losses: number;
  pushes: number;
  /** Realised net across settled pairs. */
  realisedProfit: number;
  /** Stake still riding on open pairs. */
  openStake: number;
  /** Total P/L = realised only; open legs cannot be valued before they settle. */
  totalProfit: number;
  grossStakeSettled: number;
  returnOnStake: number | null;
  /** Outcome split: which leg carried the pair. */
  primaryWins: number;
  coverWins: number;
  /** Windows that ended level — both legs lost. */
  flatWindows: number;
  primaryLegProfit: number;
  coverLegProfit: number;
  averagePairNet: number | null;
  bestPair: number | null;
  worstPair: number | null;
  winRate: number | null;
  currentLosingStreak: number;
  longestLosingStreak: number;
};

/**
 * Totals for the P/L card. `realisedProfit` is money Deriv has already reported;
 * open pairs contribute only their stake at risk, never an assumed profit.
 */
export function summarizeMafiaPairs(pairs: readonly MafiaPair[]): MafiaPairSummary {
  let settled = 0;
  let open = 0;
  let partial = 0;
  let rejected = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let realisedProfit = 0;
  let openStake = 0;
  let grossStakeSettled = 0;
  let primaryWins = 0;
  let coverWins = 0;
  let flatWindows = 0;
  let primaryLegProfit = 0;
  let coverLegProfit = 0;
  let best: number | null = null;
  let worst: number | null = null;
  let streak = 0;
  let longestStreak = 0;

  for (const pair of pairs) {
    if (pair.status === 'rejected') {
      rejected += 1;
      continue;
    }
    if (isPairOpen(pair)) {
      open += 1;
      openStake += boughtLegs(pair).reduce((total, leg) => total + (legIsSettled(leg) ? 0 : leg.stake), 0);
    }
    if (pair.status === 'partial') partial += 1;
    grossStakeSettled += boughtLegs(pair)
      .filter((leg) => legIsSettled(leg))
      .reduce((total, leg) => total + leg.stake, 0);
    if (pair.primary.profit !== null) primaryLegProfit += pair.primary.profit;
    if (pair.cover.profit !== null) coverLegProfit += pair.cover.profit;

    if (pair.status !== 'settled' || pair.netProfit === null) continue;
    settled += 1;
    realisedProfit += pair.netProfit;
    best = best === null ? pair.netProfit : Math.max(best, pair.netProfit);
    worst = worst === null ? pair.netProfit : Math.min(worst, pair.netProfit);
    if (pair.netProfit > 0) {
      wins += 1;
      streak = 0;
    } else if (pair.netProfit < 0) {
      losses += 1;
      streak += 1;
      longestStreak = Math.max(longestStreak, streak);
    } else {
      pushes += 1;
      streak = 0;
    }
    const primaryWon = (pair.primary.profit ?? 0) > 0;
    const coverWon = (pair.cover.profit ?? 0) > 0;
    if (primaryWon) primaryWins += 1;
    else if (coverWon) coverWins += 1;
    else flatWindows += 1;
  }

  return {
    pairs: pairs.length,
    settled,
    open,
    partial,
    rejected,
    wins,
    losses,
    pushes,
    realisedProfit: normalizeMoney(realisedProfit),
    openStake: normalizeMoney(openStake),
    totalProfit: normalizeMoney(realisedProfit),
    grossStakeSettled: normalizeMoney(grossStakeSettled),
    returnOnStake: grossStakeSettled > 0 ? normalizeMoney(realisedProfit / grossStakeSettled) : null,
    primaryWins,
    coverWins,
    flatWindows,
    primaryLegProfit: normalizeMoney(primaryLegProfit),
    coverLegProfit: normalizeMoney(coverLegProfit),
    averagePairNet: settled > 0 ? normalizeMoney(realisedProfit / settled) : null,
    bestPair: best === null ? null : normalizeMoney(best),
    worstPair: worst === null ? null : normalizeMoney(worst),
    winRate: settled > 0 ? wins / settled : null,
    currentLosingStreak: streak,
    longestLosingStreak: longestStreak,
  };
}

export type MafiaPredictionSummary = {
  total: number;
  resolved: number;
  pending: number;
  wins: number;
  flats: number;
  /** Share of resolved predictions the gated direction won. */
  hitRate: number | null;
  flatRate: number | null;
};

/** How the rule itself did, independent of whether a pair was bought. */
export function summarizeMafiaPredictions(rows: readonly MafiaPrediction[]): MafiaPredictionSummary {
  const resolved = rows.filter((row) => row.outcome !== null);
  const wins = resolved.filter((row) => row.outcome === 'primary').length;
  const flats = resolved.filter((row) => row.outcome === 'flat').length;
  return {
    total: rows.length,
    resolved: resolved.length,
    pending: rows.length - resolved.length,
    wins,
    flats,
    hitRate: resolved.length ? wins / resolved.length : null,
    flatRate: resolved.length ? flats / resolved.length : null,
  };
}

export const MAFIA_LOG_FILENAME = 'mafia-hedge-pairs.csv';

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per pair, with both legs and the pair's economics. */
export function mafiaPairsToCsv(pairs: readonly MafiaPair[]): string {
  const header = [
    'pair_id', 'time', 'symbol', 'mode', 'status', 'direction',
    'primary_contract_id', 'primary_stake', 'primary_payout', 'primary_status', 'primary_profit',
    'cover_contract_id', 'cover_stake', 'cover_payout', 'cover_status', 'cover_profit',
    'uniformity', 'probability', 'break_even', 'expected_value',
    'net_profit', 'balance_after', 'note',
  ];
  const rows = pairs.map((pair) => [
    pair.id,
    new Date(pair.at).toISOString(),
    pair.symbol,
    pair.mode,
    pair.status,
    pair.direction,
    pair.primary.contractId,
    pair.primary.stake,
    pair.primary.payout,
    pair.primary.status,
    pair.primary.profit,
    pair.cover.contractId,
    pair.cover.stake,
    pair.cover.payout,
    pair.cover.status,
    pair.cover.profit,
    pair.uniformity,
    pair.probability,
    pair.breakEven,
    pair.expectedValue,
    pair.netProfit,
    pair.balanceAfter,
    pair.note,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}
