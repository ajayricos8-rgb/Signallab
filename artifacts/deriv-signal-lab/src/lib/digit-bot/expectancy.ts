// ENGINE H — Payout and expectancy engine.
//
// Converts a live Deriv proposal plus a probability estimate into the numbers a
// decision actually needs. Deriv's payout and stake are normalised before any
// arithmetic, and every value that cannot be derived from a real proposal is
// reported as null instead of being guessed.
import { clamp } from '../over-under/math.ts';
import type { BotContractType, ReasonCode } from './types.ts';

/** Removes binary floating-point noise from money this module derives. */
export function normalizeMoney(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e8) / 1e8 : value;
}

export type ContractTerms = {
  stake: number;
  payout: number | null;
};

export type ContractEconomics = {
  stake: number;
  payout: number;
  netProfitIfWon: number;
  netLossIfLost: number;
  breakEvenProbability: number;
  /** EV = q·P − S under a stake basis. */
  expectedValue: number;
  /** EV using the lower bound of the probability estimate. */
  conservativeExpectedValue: number;
  /** EV − stake (return on the amount risked). */
  returnOnStake: number;
  conservativeReturnOnStake: number;
  winProbability: number;
  conservativeProbability: number;
  /** Smallest probability edge required above break-even by the config. */
  requiredProbability: number;
  /** How far the conservative probability sits above break-even. */
  probabilityMargin: number;
  notes: string[];
};

/**
 * Binary-contract economics.
 *
 *   net profit if won  = P − S
 *   net loss if lost   = −S
 *   EV(q)              = q(P − S) + (1 − q)(−S) = qP − S
 *   break-even         = S / P
 *
 * A contract whose payout does not exceed the stake can never be profitable
 * and is rejected here rather than downstream.
 */
export function contractEconomics(
  terms: ContractTerms,
  probability: number,
  conservativeProbability: number,
  minimumEdge = 0,
): ContractEconomics | null {
  const stake = terms.stake;
  if (!Number.isFinite(stake) || stake <= 0) return null;
  if (terms.payout === null || !Number.isFinite(terms.payout) || terms.payout <= 0) return null;
  // A payout that does not exceed the stake can never yield a positive net
  // profit, so it is rejected here rather than ranked downstream.
  if (terms.payout <= stake) return null;
  const payout = terms.payout;
  const q = clamp(probability, 0, 1);
  const qLower = clamp(Math.min(conservativeProbability, probability), 0, 1);
  const netProfitIfWon = normalizeMoney(payout - stake);
  const netLossIfLost = normalizeMoney(-stake);
  const breakEvenProbability = clamp(stake / payout, 0, 1);
  const expectedValue = normalizeMoney(q * netProfitIfWon + (1 - q) * netLossIfLost);
  const conservativeExpectedValue = normalizeMoney(qLower * netProfitIfWon + (1 - qLower) * netLossIfLost);
  return {
    stake,
    payout,
    netProfitIfWon,
    netLossIfLost,
    breakEvenProbability,
    expectedValue,
    conservativeExpectedValue,
    returnOnStake: normalizeMoney(expectedValue / stake),
    conservativeReturnOnStake: normalizeMoney(conservativeExpectedValue / stake),
    winProbability: q,
    conservativeProbability: qLower,
    requiredProbability: clamp(breakEvenProbability + minimumEdge, 0, 1),
    probabilityMargin: qLower - breakEvenProbability,
    notes: [
      'Expected value is an estimate built from the current proposal and the model probability; it is not a promise of profit.',
      'A positive expected value only counts when the underlying model also passed out-of-sample validation.',
    ],
  };
}

/** Fields this app relies on from a live Deriv proposal. */
export type ProposalSnapshot = {
  quoteId: string;
  askPrice: number;
  payout: number | null;
  spot: number | null;
  spotTime: number | null;
  dateStart: number | null;
  dateExpiry: number | null;
  longcode: string | null;
  /** Local receive time, used together with the requested age limit. */
  receivedAt: number;
};

export type ProposalExpectation = {
  contractType: BotContractType;
  barrierDigit: number | null;
  symbol: string;
  stake: number;
  /** Currency the proposal must be priced in; null skips the check. */
  currency: string | null;
  /** Duration in ticks the candidate was built for. */
  durationTicks: number;
};

export type ProposalCheck = {
  ok: boolean;
  termsVerified: boolean;
  issues: string[];
  warnings: string[];
  reasonCodes: ReasonCode[];
};

const CURRENCY_WORDS: Record<string, string> = { USD: 'USD', EUR: 'EUR', GBP: 'GBP', AUD: 'AUD', USDT: 'USDT' };

/**
 * Verifies that a returned proposal really is the trade that was intended.
 * Anything that cannot be verified is surfaced rather than assumed.
 */
export function validateProposal(
  proposal: ProposalSnapshot,
  expectation: ProposalExpectation,
  options: { now: number; maxAgeMs: number; stakeTolerance?: number } = { now: Date.now(), maxAgeMs: 20_000 },
): ProposalCheck {
  const issues: string[] = [];
  const warnings: string[] = [];
  const reasonCodes: ReasonCode[] = [];

  if (!proposal.quoteId) {
    issues.push('Deriv returned a proposal without an identifier, so it cannot be purchased.');
    reasonCodes.push('PROPOSAL_INVALID');
  }
  if (!Number.isFinite(proposal.askPrice) || proposal.askPrice <= 0) {
    issues.push('The proposal has no valid ask price.');
    reasonCodes.push('PROPOSAL_INVALID');
  }
  const tolerance = options.stakeTolerance ?? Math.max(0.005, expectation.stake * 1e-4);
  if (Number.isFinite(proposal.askPrice) && Math.abs(proposal.askPrice - expectation.stake) > tolerance) {
    // Deriv may reprice between quoting and buying; the stake actually charged
    // must be the stake that passed the risk checks.
    issues.push(`Deriv quoted ${proposal.askPrice} against a requested stake of ${expectation.stake}.`);
    reasonCodes.push('PROPOSAL_MISMATCH');
  }
  if (proposal.payout === null || !Number.isFinite(proposal.payout) || proposal.payout <= expectation.stake) {
    issues.push('The proposal payout is missing or does not exceed the stake, so the contract cannot pay a profit.');
    reasonCodes.push('PAYOUT_UNFAVOURABLE');
  }
  const age = options.now - proposal.receivedAt;
  if (!Number.isFinite(age) || age < 0 || age > options.maxAgeMs) {
    issues.push('The proposal is older than the accepted quoting window and may already be priced out.');
    reasonCodes.push('PROPOSAL_EXPIRED');
  }
  if (proposal.spot === null || !Number.isFinite(proposal.spot) || proposal.spot <= 0) {
    issues.push('The proposal did not include a valid entry spot.');
    reasonCodes.push('PROPOSAL_INVALID');
  }
  if (proposal.dateExpiry !== null && proposal.dateStart !== null && proposal.dateExpiry <= proposal.dateStart) {
    issues.push('The proposal expiry precedes its start time.');
    reasonCodes.push('PROPOSAL_INVALID');
  }
  const expectedBarrier = barrierDigitsFor(expectation.contractType, expectation.barrierDigit);
  if (expectedBarrier !== null) {
    if (proposal.longcode === null || !proposal.longcode.trim()) {
      warnings.push('Deriv did not include the contract description, so the barrier could not be re-read from the proposal text.');
    } else if (!longcodeMatches(proposal.longcode, expectation.contractType, expectation.barrierDigit)) {
      issues.push('The returned contract description does not match the candidate contract type or barrier.');
      reasonCodes.push('PROPOSAL_MISMATCH');
    } else if (expectation.currency && CURRENCY_WORDS[expectation.currency] && !proposal.longcode.includes(expectation.currency)) {
      warnings.push('The contract description does not name the account currency.');
    }
  }
  const termsVerified = issues.length === 0 && warnings.length === 0;
  if (!issues.length) reasonCodes.push('DATA_VALID');
  return { ok: issues.length === 0, termsVerified, issues, warnings, reasonCodes };
}

/**
 * Barrier domain check: DIGITOVER needs 0–8 and DIGITUNDER needs 1–9, because
 * a barrier that no digit can beat cannot win. DIGITMATCH accepts 0–9.
 */
export function barrierDigitsFor(contractType: BotContractType, barrier: number | null): number[] | null {
  if (contractType === 'DIGITEVEN' || contractType === 'DIGITODD') return [];
  if (barrier === null || !Number.isInteger(barrier)) return null;
  if (contractType === 'DIGITOVER') return barrier >= 0 && barrier <= 8 ? [barrier] : null;
  if (contractType === 'DIGITUNDER') return barrier >= 1 && barrier <= 9 ? [barrier] : null;
  return barrier >= 0 && barrier <= 9 ? [barrier] : null;
}

/** Confirms the proposal text describes the intended digit contract. */
export function longcodeMatches(longcode: string, contractType: BotContractType, barrierDigit: number | null): boolean {
  const text = longcode.toLowerCase();
  const hasBarrier = barrierDigit === null ? true : new RegExp(`(^|[^0-9])${barrierDigit}($|[^0-9])`).test(text);
  switch (contractType) {
    case 'DIGITOVER':
      return /digit/.test(text) && /\bover\b|greater than|higher than|above/.test(text) && hasBarrier;
    case 'DIGITUNDER':
      return /digit/.test(text) && /\bunder\b|less than|lower than|below/.test(text) && hasBarrier;
    case 'DIGITEVEN':
      return /digit/.test(text) && /\beven\b/.test(text);
    case 'DIGITODD':
      return /digit/.test(text) && /\bodd\b/.test(text);
    default:
      return /digit/.test(text) && /match|equal to|exactly/.test(text) && hasBarrier;
  }
}

/** Maximum money at risk for one purchase, including any fee basis. */
export function maximumPossibleLoss(stake: number, fees = 0): number {
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  return normalizeMoney(stake + Math.max(0, fees));
}
