// RECONCILIATION — what a pair becomes when a purchase reply never arrived.
//
// A `buy` can time out after Deriv has already accepted it. Until the account
// shows what happened, the bot must not send another pair. Once it has been
// told, every pair ends in exactly one of three states:
//
//   * both legs bought → `open`, a true hedge;
//   * one leg bought   → `partial`, and the bought leg is sold back so the
//                        account is not left with an unhedged position;
//   * nothing bought   → `rejected`.
//
// The functions here are pure. The hook passes in the current pairs and the
// account's open positions and applies the returned changes.
import type { DerivOpenPosition } from '../deriv-trading.ts';
import { HEDGE_CONTRACT_TYPES, type HedgeLeg, type HedgePair, type HedgeSide } from './types.ts';
import { boughtLegs, legOf } from './ledger.ts';

/** How long an unconfirmed purchase is matched against the account before it is given up. */
export const RECONCILE_TIMEOUT_MS = 20_000;
/** How close to the purchase time a portfolio contract must have started to be counted as ours. */
export const RECONCILE_WINDOW_MS = 180_000;

export type UnreconciledPurchase = {
  pairId: string;
  at: number;
  symbol: string;
  /** Legs whose purchase is unknown. */
  missing: HedgeSide[];
};

export type ReconcileResult = {
  pairs: HedgePair[];
  /** Legs still unknown; empty once the purchase is resolved. */
  missing: HedgeSide[];
  resolved: boolean;
  /** Contract ids the bot must sell back because their partner never existed. */
  unwind: number[];
};

/** Finds the open contracts that match the unknown legs by type, symbol and start time. */
export function matchUnreconciledLegs(
  purchase: UnreconciledPurchase,
  positions: readonly DerivOpenPosition[],
  trackedIds: ReadonlySet<number>,
): Array<{ side: HedgeSide; position: DerivOpenPosition }> {
  const used = new Set(trackedIds);
  const matches: Array<{ side: HedgeSide; position: DerivOpenPosition }> = [];
  for (const side of purchase.missing) {
    const found = positions.find((position) => !position.isSold
      && !used.has(position.contractId)
      && position.symbol === purchase.symbol
      && position.contractType === HEDGE_CONTRACT_TYPES[side]
      && position.buyTime !== null
      && Math.abs(position.buyTime * 1_000 - purchase.at) <= RECONCILE_WINDOW_MS);
    if (found) {
      matches.push({ side, position: found });
      used.add(found.contractId);
    }
  }
  return matches;
}

function attachLeg(leg: HedgeLeg, position: DerivOpenPosition): HedgeLeg {
  return {
    ...leg,
    contractId: position.contractId,
    stake: position.buyPrice ?? leg.stake,
    payout: position.payout,
    status: 'open',
    longcode: position.longcode,
  };
}

function withLeg(pair: HedgePair, side: HedgeSide, leg: HedgeLeg): HedgePair {
  return side === 'HIGH' ? { ...pair, high: leg } : { ...pair, low: leg };
}

/** Turns a pair whose legs are all known into its final state. */
export function concludeReconciliation(pair: HedgePair, now: number): { pair: HedgePair; unwind: number[] } {
  const bought = boughtLegs(pair);
  if (bought.length === 2) {
    return {
      pair: { ...pair, status: 'open', note: `${pair.note} Both legs confirmed on the account.`.trim() },
      unwind: [],
    };
  }
  if (bought.length === 1 && bought[0].contractId !== null) {
    return {
      pair: {
        ...pair,
        status: 'partial',
        note: `${pair.note} Its partner was not confirmed, so the bought leg is being sold back.`.trim(),
        settledAt: pair.settledAt ?? now,
      },
      unwind: [bought[0].contractId],
    };
  }
  return {
    pair: { ...pair, status: 'rejected', note: 'The account shows no contract for this order; nothing was bought.', settledAt: pair.settledAt ?? now },
    unwind: [],
  };
}

/**
 * Advances one unreconciled purchase against the current account positions.
 *
 * Matched legs are attached. Unknown legs are kept until the purchase times out,
 * and then they are recorded as never bought. Once no leg is unknown the pair is
 * concluded and any orphaned leg is returned for selling.
 */
export function reconcilePurchase(input: {
  pairs: readonly HedgePair[];
  purchase: UnreconciledPurchase;
  positions: readonly DerivOpenPosition[];
  now: number;
}): ReconcileResult {
  const { pairs, purchase, positions, now } = input;
  const index = pairs.findIndex((pair) => pair.id === purchase.pairId);
  if (index === -1) return { pairs: [...pairs], missing: [], resolved: true, unwind: [] };

  const trackedIds = new Set<number>();
  for (const pair of pairs) {
    for (const leg of boughtLegs(pair)) {
      if (leg.contractId !== null) trackedIds.add(leg.contractId);
    }
  }

  let pair = pairs[index];
  const matches = matchUnreconciledLegs(purchase, positions, trackedIds);
  for (const { side, position } of matches) {
    pair = withLeg(pair, side, attachLeg(legOf(pair, side), position));
  }
  let missing = purchase.missing.filter((side) => !matches.some((match) => match.side === side));

  if (missing.length > 0 && now - purchase.at > RECONCILE_TIMEOUT_MS) {
    // The account has had time to report the contracts and none of them exist.
    for (const side of missing) {
      const leg = legOf(pair, side);
      if (leg.contractId === null) pair = withLeg(pair, side, { ...leg, status: 'rejected' });
    }
    missing = [];
  }

  if (missing.length > 0) {
    return {
      pairs: pairs.map((row, at) => (at === index ? { ...pair, status: 'unreconciled' as const } : row)),
      missing,
      resolved: false,
      unwind: [],
    };
  }

  const concluded = concludeReconciliation(pair, now);
  return {
    pairs: pairs.map((row, at) => (at === index ? concluded.pair : row)),
    missing: [],
    resolved: true,
    unwind: concluded.unwind,
  };
}
