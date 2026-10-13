// Draft ticket options only. This module does not quote, authorize, or place orders.
export type TradeFamily = 'rise-fall' | 'over-under' | 'even-odd' | 'matches';
export type TradeContractType =
  | 'CALL'
  | 'PUT'
  | 'DIGITOVER'
  | 'DIGITUNDER'
  | 'DIGITEVEN'
  | 'DIGITODD'
  | 'DIGITMATCH';

export const TRADE_FAMILIES: Record<
  TradeFamily,
  { label: string; contracts: { value: TradeContractType; label: string }[] }
> = {
  'rise-fall': {
    label: 'Rise/Fall',
    contracts: [
      { value: 'CALL', label: 'Rise' },
      { value: 'PUT', label: 'Fall' },
    ],
  },
  'over-under': {
    label: 'Over/Under',
    contracts: [
      { value: 'DIGITOVER', label: 'Over' },
      { value: 'DIGITUNDER', label: 'Under' },
    ],
  },
  'even-odd': {
    label: 'Even/Odd',
    contracts: [
      { value: 'DIGITEVEN', label: 'Even' },
      { value: 'DIGITODD', label: 'Odd' },
    ],
  },
  matches: {
    label: 'Matches',
    contracts: [{ value: 'DIGITMATCH', label: 'Matches' }],
  },
};

export const DIGIT_TARGETS = Array.from({ length: 10 }, (_, digit) => digit);

export function draftBarriers(contractType: TradeContractType): number[] {
  if (contractType === 'DIGITOVER') return DIGIT_TARGETS.slice(0, 9); // > 9 can never win
  if (contractType === 'DIGITUNDER') return DIGIT_TARGETS.slice(1); // < 0 can never win
  return [];
}

// An amount is a draft without a currency until an account is connected.
export function isValidDraftStake(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(trimmed) &&
    Number.isFinite(Number(trimmed)) &&
    Number(trimmed) > 0
  );
}
