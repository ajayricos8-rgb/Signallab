// PERFORMANCE LEDGER — summaries of what really happened, plus the CSV export
// that replaces the reference script's `trades_log.csv`.
//
// Settled trades and unscored signals are kept apart on purpose: a prediction
// that was never purchased is scored against the ticks that followed and only
// ever contributes to the calibration figures, never to profit and loss.
import type {
  RiseFallPrediction,
  RiseFallPredictionSummary,
  RiseFallTradeRecord,
  RiseFallTradeSummary,
} from './types.ts';

/** One verified tick: Deriv's own epoch and quote, as delivered by the feed. */
export type TickPoint = { epoch: number; quote: number };

/**
 * Scores signals that were never traded once enough newer ticks exist.
 *
 * Rows are located by Deriv epoch rather than by array index, because the feed
 * prunes its buffer to the newest 2,000 ticks and every index shifts when it
 * does. A row whose entry tick has already been pruned is marked expired and
 * never counted as a hit or a miss.
 */
export function resolvePredictions(
  rows: readonly RiseFallPrediction[],
  observations: readonly TickPoint[],
  symbol: string,
  now: number,
): { rows: RiseFallPrediction[]; resolved: number } {
  if (!rows.length) return { rows: [], resolved: 0 };
  if (!observations.length) return { rows: [...rows], resolved: 0 };
  const indexByEpoch = new Map<number, number>();
  observations.forEach((observation, index) => indexByEpoch.set(observation.epoch, index));
  const firstEpoch = observations[0].epoch;
  let resolved = 0;
  const next = rows.map((row) => {
    if (row.symbol !== symbol || row.resolved) return row;
    const index = indexByEpoch.get(row.entryEpoch);
    if (index === undefined) return row.entryEpoch < firstEpoch ? { ...row, expired: true } : row;
    const exitIndex = index + row.horizonTicks;
    if (exitIndex >= observations.length) return row;
    const entry = observations[index].quote;
    const exit = observations[exitIndex].quote;
    if (!Number.isFinite(entry) || !Number.isFinite(exit)) return row;
    resolved += 1;
    return {
      ...row,
      resolved: true,
      exitQuote: exit,
      outcome: exit > entry ? (row.direction === 'CALL' ? 'win' : 'loss') : exit < entry ? (row.direction === 'PUT' ? 'win' : 'loss') : 'push',
      resolvedAt: now,
    } satisfies RiseFallPrediction;
  });
  return { rows: next, resolved };
}

export function summarizePredictions(rows: readonly RiseFallPrediction[]): RiseFallPredictionSummary {
  const scored = rows.filter((row) => row.resolved);
  const wins = scored.filter((row) => row.outcome === 'win').length;
  const losses = scored.filter((row) => row.outcome === 'loss').length;
  const pushes = scored.filter((row) => row.outcome === 'push').length;
  const expired = rows.filter((row) => row.expired && !row.resolved).length;
  const decisive = wins + losses;
  return {
    scored: scored.length,
    wins,
    losses,
    pushes,
    pending: rows.filter((row) => !row.resolved && !row.expired).length,
    expired,
    hitRate: decisive > 0 ? wins / decisive : null,
  };
}

export function summarizeTrades(records: readonly RiseFallTradeRecord[]): RiseFallTradeSummary {
  const purchased = records.filter((record) => record.contractId !== null);
  const settled = purchased.filter((record) => record.status === 'won' || record.status === 'lost' || record.status === 'push');
  const wins = settled.filter((record) => record.status === 'won').length;
  const losses = settled.filter((record) => record.status === 'lost').length;
  const pushes = settled.filter((record) => record.status === 'push').length;
  const profits = settled.map((record) => record.profit ?? 0);
  const netProfit = profits.reduce((total, value) => total + value, 0);
  const grossStake = purchased.reduce((total, record) => total + record.stake, 0);
  return {
    purchased: purchased.length,
    settled: settled.length,
    wins,
    losses,
    pushes,
    open: purchased.filter((record) => record.status === 'open').length,
    rejected: records.filter((record) => record.status === 'rejected' || record.status === 'unreconciled').length,
    netProfit: Math.round(netProfit * 1e8) / 1e8,
    grossStake: Math.round(grossStake * 1e8) / 1e8,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    returnOnStake: grossStake > 0 ? netProfit / grossStake : null,
    bestTrade: profits.length ? Math.max(...profits) : null,
    worstTrade: profits.length ? Math.min(...profits) : null,
  };
}

const CSV_COLUMNS = [
  'time',
  'settled_time',
  'mode',
  'symbol',
  'direction',
  'rule',
  'stake',
  'martingale_step',
  'payout',
  'profit',
  'status',
  'contract_id',
  'entry_spot',
  'exit_spot',
  'momentum_pips',
  'volatility_pips',
  'win_rate_estimate',
  'expected_value',
  'balance',
  'session_pnl',
  'daily_pnl',
  'note',
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialises the trade log to the same shape the reference script wrote to
 * `trades_log.csv`, so an exported file can be opened in a spreadsheet or fed
 * to the operator's own analysis.
 */
export function tradesToCsv(records: readonly RiseFallTradeRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const record of records) {
    lines.push([
      new Date(record.at).toISOString(),
      record.settledAt === null ? '' : new Date(record.settledAt).toISOString(),
      record.mode,
      record.symbol,
      record.direction,
      record.rule,
      record.stake.toFixed(2),
      record.step,
      record.payout === null ? '' : record.payout.toFixed(2),
      record.profit === null ? '' : record.profit.toFixed(2),
      record.status,
      record.contractId === null ? '' : record.contractId,
      record.entrySpot === null ? '' : record.entrySpot,
      record.exitSpot === null ? '' : record.exitSpot,
      record.momentumPips === null ? '' : record.momentumPips.toFixed(2),
      record.volatilityPips === null ? '' : record.volatilityPips.toFixed(2),
      record.winRateEstimate === null ? '' : record.winRateEstimate.toFixed(4),
      record.expectedValue === null ? '' : record.expectedValue.toFixed(4),
      record.balanceAfter === null ? '' : record.balanceAfter.toFixed(2),
      record.sessionPnl.toFixed(2),
      record.dailyPnl.toFixed(2),
      record.note,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export const TRADE_LOG_FILENAME = 'rise-fall-bot-trades.csv';
