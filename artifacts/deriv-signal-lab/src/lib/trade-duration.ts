export type TradeDurationUnit = 't' | 's' | 'm';
export type ReportedDuration = { value: number; unit: 't' | 's' | 'm' | 'h' | 'd' };
export type DurationBounds = { min: ReportedDuration | null; max: ReportedDuration | null };
export type DurationSupport = {
  contractType: string;
  expiryType: string;
  minDuration: number | null;
  maxDuration: number | null;
  durationBounds?: DurationBounds;
};

export const TRADE_DURATION_UNITS: { value: TradeDurationUnit; label: string }[] = [
  { value: 't', label: 'Ticks' },
  { value: 's', label: 'Seconds' },
  { value: 'm', label: 'Minutes' },
];

export function parseContractDuration(value: unknown): ReportedDuration | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? { value, unit: 't' } : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d+)([tsmhd])$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isSafeInteger(amount) && amount > 0 ? { value: amount, unit: match[2] as ReportedDuration['unit'] } : null;
}

export function durationSeconds(duration: ReportedDuration): number | null {
  const factors = { s: 1, m: 60, h: 3_600, d: 86_400 };
  if (duration.unit === 't') return null; // ticks are never converted into wall time
  const value = duration.value * factors[duration.unit];
  return Number.isSafeInteger(value) ? value : null;
}

export function formatTradeDuration(value: number, unit: ReportedDuration['unit']): string {
  const labels = { t: 'tick', s: 'second', m: 'minute', h: 'hour', d: 'day' };
  return `${value} ${labels[unit]}${value === 1 ? '' : 's'}`;
}

/** Local input validation first; only reported compatible ranges are accepted. */
export function draftDurationIssue(
  value: number | null,
  unit: TradeDurationUnit,
  contractType: string,
  contracts: readonly DurationSupport[] | undefined,
  verified: boolean,
): string {
  if (value === null || !Number.isSafeInteger(value) || value < 1) return 'Enter a positive whole-number duration.';
  if (!TRADE_DURATION_UNITS.some((choice) => choice.value === unit)) return 'Choose ticks, seconds or minutes.';
  // Rise/Fall's manual draft has no public contracts_for response. The live
  // proposal remains authoritative; unverified terms are never called supported.
  if (!verified || !contracts) return '';
  const rows = contracts.filter((contract) => contract.contractType === contractType);
  if (!rows.length) return 'Deriv did not report this contract type for the selected market.';
  const requested = unit === 't' ? value : durationSeconds({ value, unit });
  if (requested === null) return 'The duration is too large.';
  let compatible = false;
  for (const row of rows) {
    if (unit === 't') {
      if (row.expiryType.toLowerCase() !== 'tick') continue;
      compatible = true;
      if (row.minDuration !== null && row.maxDuration !== null && value >= row.minDuration && value <= row.maxDuration) return '';
    } else {
      if (row.expiryType.toLowerCase() === 'tick') continue;
      const { min, max } = row.durationBounds ?? { min: null, max: null };
      const minimum = min ? durationSeconds(min) : null;
      const maximum = max ? durationSeconds(max) : null;
      if (minimum === null || maximum === null || minimum > maximum) continue;
      compatible = true;
      if (requested >= minimum && requested <= maximum) return '';
    }
  }
  if (!compatible) return unit === 't'
    ? 'Deriv has not reported tick durations for this contract.'
    : 'Deriv has not reported time-based durations for this contract. Choose Ticks if available.';
  return 'This duration is outside the ranges Deriv reported for this contract and market.';
}

export function supportedTradeTicks(contracts: readonly DurationSupport[], contractType: string): number[] {
  return [...new Set(contracts.filter((contract) => contract.contractType === contractType && contract.expiryType.toLowerCase() === 'tick').flatMap((contract) => {
    const min = contract.minDuration;
    const max = contract.maxDuration;
    if (min === null || max === null || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max - min > 99) return [];
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }))].sort((a, b) => a - b);
}
