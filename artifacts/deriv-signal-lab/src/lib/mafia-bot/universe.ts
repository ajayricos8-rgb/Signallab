// The Mafia bot's trading universe: Deriv STEP indices, and nothing else.
//
// Step indices move the quote by a fixed step on every tick, which is why a
// four-tick Rise/Fall window on them has a clean up / down / flat structure.
// The bot refuses every other market — volatility indices, 1-second indices,
// forex and commodities are all out of scope, whether or not Deriv would quote
// a Rise/Fall contract on them.
//
// The allowlist is by symbol AND by name. Deriv's Step indices are `stpRNG`,
// `stpRNG2` … `stpRNG5`; matching the display name as well keeps the bot
// working if Deriv adds another step variant, while the `volatility`/`1s`
// exclusions stop a name match from pulling in a different market family.
import type { DigitMarketSymbol } from '../deriv-digit-metadata.ts';

/** Deriv's Step index symbols, in the order the bot prefers them. */
export const STEP_INDEX_SYMBOLS: readonly string[] = ['stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5'];

export const STEP_INDEX_LABEL = 'Step indices only';

/** True for a Deriv Step index symbol (`stpRNG`, `stpRNG2` …). */
export function isStepIndexSymbol(symbol: string | null | undefined): boolean {
  return typeof symbol === 'string' && /^stpRNG\d*$/i.test(symbol.trim());
}

/**
 * True when the symbol or its display name describes a Step index.
 *
 * The name path requires "step index" and refuses anything that also looks like
 * a volatility or one-second index, so a renamed market cannot silently widen
 * the universe.
 */
export function isStepIndexMarket(symbol: string | null | undefined, name?: string | null): boolean {
  if (isStepIndexSymbol(symbol)) return true;
  if (typeof name !== 'string' || !name.trim()) return false;
  if (/volatility|1s\b|1 second/i.test(name)) return false;
  return /step\s*index/i.test(name);
}

export type StepIndexMarket = {
  symbol: string;
  name: string;
  pipSize: number | null;
};

/**
 * The Step indices a scan may trade, most liquid first (Deriv's own order), with
 * markets that are closed, suspended or missing a verified pip size removed.
 */
export function stepIndexMarkets(symbols: readonly DigitMarketSymbol[]): StepIndexMarket[] {
  const eligible = symbols.filter((market) =>
    isStepIndexMarket(market.symbol, market.name)
    && market.precision !== null
    && market.exchangeOpen !== false
    && market.tradingSuspended !== true);
  const rank = (market: DigitMarketSymbol) => {
    const index = STEP_INDEX_SYMBOLS.indexOf(market.symbol);
    return index === -1 ? STEP_INDEX_SYMBOLS.length : index;
  };
  return [...eligible]
    .sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))
    .map((market) => ({ symbol: market.symbol, name: market.name, pipSize: market.pipSize }));
}

/**
 * The market the bot should be on: the operator's choice when it is a Step
 * index, otherwise the first eligible Step index. Null when Deriv reports none,
 * in which case the bot waits instead of trading a market outside its scope.
 */
export function resolveMafiaSymbol(
  symbols: readonly DigitMarketSymbol[],
  requested: string | null | undefined,
): StepIndexMarket | null {
  const markets = stepIndexMarkets(symbols);
  if (!markets.length) return null;
  if (requested) {
    const chosen = markets.find((market) => market.symbol === requested);
    if (chosen) return chosen;
  }
  return markets[0];
}
