// Load and Run execution guard — the forged model (Layer 8) brought into the
// bot itself.
//
// The forge is fitted at analysis time on a signal's replayed rows and its
// verdict travels with the plan. The bot enforces that verdict at execution:
//   * a run never starts when the forged model has validated a veto;
//   * a run does not buy when the forged model now reads the market against
//     the call.
// That keeps Load and Run from entering randomly or at the wrong moment, and
// lets it time sharp, forge-confirmed entries instead.
//
// Pure function: no I/O, no clock, no React. Safe to unit test in isolation.
import type { EntryForgeEvidence } from '../signal-engine/entry.ts';

export type ForgeExecutionDecision = 'proceed' | 'skip' | 'block';

export type ForgeExecutionInput = {
  /** The forged model's fused view for the loaded signal, from the analysis. */
  forge: EntryForgeEvidence | null;
  /** True when the master decision hard-vetoed this entry (NO_EDGE). */
  masterVetoed: boolean;
  /** True when the entry's timing was measured out of sample (a real wait). */
  entryTimingMeasured: boolean;
  /** True when this run's entry trigger is ready to fire (or immediate). */
  entryReadyNow: boolean;
  /** Milliseconds since the analysis finished. */
  analysisAgeMs: number | null;
  /** The measured validity window of this edge in ms. */
  validityMs: number;
  /** No-edge probability of the traded outcome, to judge the forge's stance. */
  fair: number;
};

export type ForgeExecutionResult = {
  /** proceed: buy this run. skip: do not buy this run. block: do not start. */
  decision: ForgeExecutionDecision;
  /** One line for the run note or the start error. */
  reason: string;
  /** The forge decision that drove the outcome, when there is one. */
  forgeDecision: EntryForgeEvidence['decision'] | null;
};

const ABSOLUTE_EDGE_FLOOR = 0.005;

/** How far the forged probability must sit below fair to count as contradicting. */
function contradictingThreshold(fair: number): number {
  return Math.max(ABSOLUTE_EDGE_FLOOR, 0.01 * fair);
}

/**
 * Decide whether Load and Run may buy this run.
 *
 * Rules, in order:
 *   1. A master veto (NO_EDGE, which folds in a validated forge contradiction)
 *      refuses to start the bot at all.
 *   2. No forged model was fitted: the analysis entry is traded unguided.
 *   3. A validated forge that measured the call against itself is a hard
 *      execution veto: the entry is not sharp, never buy it.
 *   4. When it is time to buy and the forged model now reads the market
 *      against the call, skip this run instead of entering at a bad moment.
 *   5. Otherwise the forge confirms, trims or stays neutral, so the analysis
 *      entry is traded as planned.
 */
export function forgeExecutionGate(input: ForgeExecutionInput): ForgeExecutionResult {
  const { forge, masterVetoed, entryReadyNow, fair } = input;
  const threshold = contradictingThreshold(fair);

  if (masterVetoed) {
    return {
      decision: 'block',
      reason: 'The master decision vetoed this entry (NO_EDGE): the forged or confirmed analysis measured no edge here. Run Analysis again.',
      forgeDecision: forge?.decision ?? null,
    };
  }

  if (!forge) {
    return {
      decision: 'proceed',
      reason: 'No forged model was fitted for this signal; the analysis entry is traded without a forge opinion.',
      forgeDecision: null,
    };
  }

  const modelProbability = Number.isFinite(forge.modelProbability) ? forge.modelProbability : 0.5;
  const forgedEdge = modelProbability - fair;
  const isContradicting =
    forge.validated && modelProbability < fair - threshold && forgedEdge < -threshold;

  // A validated forge that measured the call against itself stops the entry
  // before any contract is bought.
  if (forge.validated && forge.decision === 'veto') {
    return {
      decision: 'block',
      reason: `The forged model validated a contrary estimate on this market (${(100 * modelProbability).toFixed(1)}% vs ${(100 * fair).toFixed(1)}% fair); the entry is refused.`,
      forgeDecision: 'veto',
    };
  }

  // The moment a contract would be bought, a forged model that reads the
  // market against the call means this is not the sharp entry the analysis
  // measured — skip the run rather than entering blindly.
  if (entryReadyNow && isContradicting) {
    return {
      decision: 'skip',
      reason: `The forged model reads this market against the call (${(100 * modelProbability).toFixed(1)}% vs ${(100 * fair).toFixed(1)}% fair); skipping this run for a sharper entry.`,
      forgeDecision: forge.decision,
    };
  }

  // Everything else: the forge confirms, trims or stays neutral, so the
  // analysis entry is traded as planned.
  const stance = forge.validated
    ? forgedEdge > threshold
      ? 'supports the call'
      : forgedEdge < -threshold
        ? 'reads against the call'
        : 'is neutral'
    : 'is not yet validated';
  return {
    decision: 'proceed',
    reason: `The forged model ${stance} (${(100 * modelProbability).toFixed(1)}% vs ${(100 * fair).toFixed(1)}% fair); entering on the analysis entry.`,
    forgeDecision: forge.decision,
  };
}
