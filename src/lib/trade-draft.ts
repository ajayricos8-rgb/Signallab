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

/**
 * A finished analysis may populate a ticket, never submit one. `barrier` is the
 * Over/Under barrier or the Matches target digit; Rise/Fall may use minutes.
 */
export type TradeRecommendation = {
  symbol: string;
  contractType: TradeContractType;
  barrier?: number;
  duration: number;
  durationUnit: 't' | 's' | 'm';
  label?: string;
};

export function canApplySignal(
  recommendation: TradeRecommendation | null | undefined,
  family: TradeFamily,
  supportedTickExpiries: readonly number[],
): recommendation is TradeRecommendation {
  if (!recommendation || !recommendation.symbol) return false;
  if (!TRADE_FAMILIES[family].contracts.some(({ value }) => value === recommendation.contractType)) return false;
  const barrier = recommendation.barrier;
  if (family === 'over-under' && !(barrier !== undefined && Number.isInteger(barrier) && draftBarriers(recommendation.contractType).includes(barrier))) return false;
  if (family === 'matches' && !(barrier !== undefined && Number.isInteger(barrier) && DIGIT_TARGETS.includes(barrier))) return false;
  if (!Number.isInteger(recommendation.duration) || recommendation.duration < 1) return false;
  if (recommendation.durationUnit === 't') return supportedTickExpiries.includes(recommendation.duration);
  // Time-based expiries are only offered for Rise/Fall signals.
  return family === 'rise-fall';
}

/** Legacy Over/Under-only handoff, kept for existing callers and tests. */
export type OverUnderRecommendation = {
  symbol: string;
  contractType: 'DIGITOVER' | 'DIGITUNDER';
  barrier: number;
  horizon: number;
};

export function canApplyRecommendation(
  recommendation: OverUnderRecommendation | null | undefined,
  family: TradeFamily,
  symbol: string | null,
  supportedExpiries: readonly number[],
): recommendation is OverUnderRecommendation {
  return Boolean(recommendation && family === 'over-under' && symbol && recommendation.symbol === symbol
    && ['DIGITOVER', 'DIGITUNDER'].includes(recommendation.contractType)
    && Number.isInteger(recommendation.barrier) && recommendation.barrier >= 1 && recommendation.barrier <= 8
    && Number.isInteger(recommendation.horizon) && recommendation.horizon >= 1 && recommendation.horizon <= 100
    && supportedExpiries.includes(recommendation.horizon));
}
