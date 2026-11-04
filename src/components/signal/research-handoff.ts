import type { ScanRun } from '@/hooks/use-signal-scan';
import type { ScanJobResult } from '@/lib/signal-engine/scan-protocol';
import type { DbotAiFamily } from '@/lib/dbot-ai';

/** The original scan and selected market travel together, without re-scanning. */
export type ResearchHandoff = {
  run: ScanRun<ScanJobResult, { scope: string }>;
  family: DbotAiFamily;
  duration: number;
  symbol: string;
};

/** A research scan may have used fallback contracts before metadata arrived.
 * Only hand off a digit candidate that Deriv now reports for this duration. */
export function supportsResearchContract(
  candidate: { contractType: string; barrier?: number; targetDigit?: number },
  supported: readonly { contractType: string; barrier?: number; targetDigit?: number }[] | undefined,
): boolean {
  return Boolean(supported?.some((contract) => contract.contractType === candidate.contractType
    && contract.barrier === candidate.barrier && contract.targetDigit === candidate.targetDigit));
}
