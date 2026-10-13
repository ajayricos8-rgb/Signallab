import { precisionFromPipSize } from './digit-analysis.ts';

export type DigitMarketSymbol = {
  symbol: string;
  name: string;
  market: string;
  symbolType: string;
  pipSize: number | null;
  precision: number | null;
  exchangeOpen: boolean | null;
  tradingSuspended: boolean | null;
};

export type DigitContractSupport = {
  contractType: string;
  expiryType: string;
  minDuration: number | null;
  maxDuration: number | null;
  barriers: number[];
  targets: number[];
  digitRangeKnown: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseFiniteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function parseInteger(value: unknown): number | null {
  const number = parseFiniteNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function parseDigitList(value: unknown, expandRange = false): number[] {
  if (!Array.isArray(value)) return [];
  const values = value.map(parseInteger).filter((item): item is number => item !== null && item >= 0 && item <= 9);
  if (expandRange && values.length === 2 && values[0] <= values[1]) {
    return Array.from({ length: values[1] - values[0] + 1 }, (_, index) => values[0] + index);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

export function normalizeActiveSymbols(rawSymbols: unknown[]): DigitMarketSymbol[] {
  const symbols: DigitMarketSymbol[] = [];
  for (const raw of rawSymbols) {
    const item = asRecord(raw);
    if (!item) continue;
    const symbol = typeof item.symbol === 'string' ? item.symbol : typeof item.underlying_symbol === 'string' ? item.underlying_symbol : '';
    if (!symbol) continue;
    const pipSizeValue = parseFiniteNumber(item.pip ?? item.pip_size);
    const precision = pipSizeValue === null ? null : precisionFromPipSize(pipSizeValue);
    symbols.push({
      symbol,
      name: typeof item.display_name === 'string' ? item.display_name : typeof item.underlying_symbol_name === 'string' && item.underlying_symbol_name ? item.underlying_symbol_name : symbol,
      market: typeof item.market === 'string' ? item.market : 'Unknown market',
      symbolType: typeof item.symbol_type === 'string' ? item.symbol_type : typeof item.underlying_symbol_type === 'string' ? item.underlying_symbol_type : 'Unknown type',
      pipSize: precision === null ? null : pipSizeValue,
      precision,
      exchangeOpen: item.exchange_is_open === 0 || item.exchange_is_open === 1 ? item.exchange_is_open === 1 : null,
      tradingSuspended: item.is_trading_suspended === 0 || item.is_trading_suspended === 1 ? item.is_trading_suspended === 1 : null,
    });
  }
  return symbols.sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeContractSupport(rawContracts: unknown[]): DigitContractSupport[] {
  const output: DigitContractSupport[] = [];
  for (const raw of rawContracts) {
    const item = asRecord(raw);
    if (!item || typeof item.contract_type !== 'string') continue;
    const availableBarriers = parseDigitList(item.available_barriers);
    const lastDigitRange = parseDigitList(item.last_digit_range, true);
    const barriers = availableBarriers.length ? availableBarriers : lastDigitRange.length ? lastDigitRange
      : item.contract_type === 'DIGITOVER' ? Array.from({ length: 9 }, (_, digit) => digit)
        : item.contract_type === 'DIGITUNDER' ? Array.from({ length: 9 }, (_, digit) => digit + 1) : [];
    const targets = item.contract_type === 'DIGITMATCH'
      ? Array.from({ length: 10 }, (_, digit) => digit)
      : lastDigitRange.length ? lastDigitRange : barriers;
    output.push({
      contractType: item.contract_type,
      expiryType: typeof item.expiry_type === 'string' ? item.expiry_type : '',
      minDuration: parseTickDuration(item.min_contract_duration),
      maxDuration: parseTickDuration(item.max_contract_duration),
      barriers,
      targets,
      digitRangeKnown: item.contract_type === 'DIGITMATCH' || barriers.length > 0 || lastDigitRange.length > 0,
    });
  }
  return output;
}


export function parseTickDuration(value: unknown): number | null {
  if (typeof value === 'string' && /^\d+t$/.test(value)) return parseInteger(value.slice(0, -1));
  return parseInteger(value);
}

export function normalizeResponsePipSize(value: unknown, expectedPipSize: number | null): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed === null || expectedPipSize === null) return null;
  if (Math.abs(parsed - expectedPipSize) <= expectedPipSize * 1e-12) return expectedPipSize;
  const pipSize = Number.isInteger(parsed) && parsed >= 0 && parsed <= 12 ? 10 ** -parsed : parsed;
  return Math.abs(pipSize - expectedPipSize) <= expectedPipSize * 1e-12 ? expectedPipSize : null;
}
