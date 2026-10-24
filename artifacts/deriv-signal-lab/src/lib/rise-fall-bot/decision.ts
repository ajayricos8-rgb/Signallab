// DECISION ENGINE — names a direction, or explains why it will not.
//
// The reference script's `decide()` had two rules (strong momentum, then
// continuation of the last move) and hard-coded price constants such as
// 0.0008, which only mean something on one symbol at one price level. The
// rules are kept, but their thresholds are expressed in verified pips and can
// additionally scale with the volatility actually measured in the window, so
// the same configuration behaves consistently across markets.
//
// Every branch records a human-readable reason and a machine-readable code;
// the panel shows both, including for the cycles that end in WAIT.
import { effectiveMomentumThresholdPips } from './features.ts';
import type { RiseFallConfig, RiseFallDirection, RiseFallFeatures, RiseFallRule } from './types.ts';

export type DirectionVerdict = {
  direction: RiseFallDirection | null;
  rule: RiseFallRule;
  reasons: string[];
  reasonCodes: string[];
};

const pipLabel = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)} pips`;

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Runs the two signal rules against the newest features.
 *
 * Order matters and matches the reference implementation: the volatility floor
 * is applied first (a dead market cannot produce a tradable edge), then strong
 * momentum, then continuation of the last move. Anything else is a WAIT.
 */
export function decideDirection(
  features: RiseFallFeatures | null,
  config: RiseFallConfig,
): DirectionVerdict {
  if (!features) {
    return {
      direction: null,
      rule: 'none',
      reasons: ['Not enough verified ticks in the feature window to describe the market.'],
      reasonCodes: ['INSUFFICIENT_TICKS'],
    };
  }

  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const volatilityPips = Math.abs(features.volatilityPips);
  const momentumPips = features.momentumPips;
  const threshold = effectiveMomentumThresholdPips(config, volatilityPips);

  reasons.push(
    `Window of ${features.sample} ticks: ${formatRatio(features.upRatio)} up, ${formatRatio(features.downRatio)} down, `
    + `mean tick move ${volatilityPips.toFixed(2)} pips, momentum over ${config.momentumTicks} ticks ${pipLabel(momentumPips)}.`,
  );
  reasonCodes.push('FEATURES_READ');

  if (config.minVolatilityPips > 0 && volatilityPips < config.minVolatilityPips) {
    reasons.push(
      `Volatility floor: ${volatilityPips.toFixed(2)} pips of mean tick move is below the required ${config.minVolatilityPips.toFixed(2)} pips, so the market is too quiet to price a direction.`,
    );
    reasonCodes.push('LOW_VOLATILITY');
    return { direction: null, rule: 'none', reasons, reasonCodes };
  }

  if (momentumPips > threshold && features.upRatio > config.strongRatio) {
    reasons.push(
      `Strong-momentum rule: net move ${pipLabel(momentumPips)} clears the ${threshold.toFixed(2)}-pip edge and ${formatRatio(features.upRatio)} of ticks rose (needs above ${formatRatio(config.strongRatio)}).`,
    );
    reasonCodes.push('MOMENTUM_UP');
    return { direction: 'CALL', rule: 'momentum', reasons, reasonCodes };
  }

  if (momentumPips < -threshold && features.downRatio > config.strongRatio) {
    reasons.push(
      `Strong-momentum rule: net move ${pipLabel(momentumPips)} clears the ${threshold.toFixed(2)}-pip edge downwards and ${formatRatio(features.downRatio)} of ticks fell (needs above ${formatRatio(config.strongRatio)}).`,
    );
    reasonCodes.push('MOMENTUM_DOWN');
    return { direction: 'PUT', rule: 'momentum', reasons, reasonCodes };
  }

  if (features.lastMove > 0 && features.upRatio > config.continuationRatio) {
    reasons.push(
      `Continuation rule: the newest tick rose ${pipLabel(features.lastMovePips)} and ${formatRatio(features.upRatio)} of the window rose (needs above ${formatRatio(config.continuationRatio)}).`,
    );
    reasonCodes.push('CONTINUATION_UP');
    return { direction: 'CALL', rule: 'continuation', reasons, reasonCodes };
  }

  if (features.lastMove < 0 && features.downRatio > config.continuationRatio) {
    reasons.push(
      `Continuation rule: the newest tick fell ${pipLabel(features.lastMovePips)} and ${formatRatio(features.downRatio)} of the window fell (needs above ${formatRatio(config.continuationRatio)}).`,
    );
    reasonCodes.push('CONTINUATION_DOWN');
    return { direction: 'PUT', rule: 'continuation', reasons, reasonCodes };
  }

  reasons.push(
    `No rule fired: momentum ${pipLabel(momentumPips)} against a ${threshold.toFixed(2)}-pip edge, up ratio ${formatRatio(features.upRatio)} (strong needs ${formatRatio(config.strongRatio)}, continuation needs ${formatRatio(config.continuationRatio)}).`,
  );
  reasonCodes.push('NO_EDGE');
  return { direction: null, rule: 'none', reasons, reasonCodes };
}

/** True when the same rule would fire on a window ending at `index`. */
export function ruleFiresAtIndex(
  quotes: readonly number[],
  index: number,
  config: RiseFallConfig,
  pipSize: number | null,
): RiseFallDirection | null {
  const windowStart = Math.max(0, index - config.tickWindow + 1);
  const window = quotes.slice(windowStart, index + 1);
  if (window.length < 5) return null;
  const prices = window;
  const diffs: number[] = [];
  for (let position = 1; position < prices.length; position += 1) diffs.push(prices[position] - prices[position - 1]);
  if (diffs.length < 4) return null;

  const toPips = (value: number): number => (pipSize === null || pipSize <= 0 ? value : value / pipSize);
  const up = diffs.filter((difference) => difference > 0).length;
  const down = diffs.filter((difference) => difference < 0).length;
  const upRatio = up / diffs.length;
  const downRatio = down / diffs.length;
  const momentumWindow = diffs.slice(-Math.max(1, Math.min(config.momentumTicks, diffs.length)));
  const volatilityWindow = diffs.slice(-Math.max(1, Math.min(config.volatilityTicks, diffs.length)));
  const momentumPips = toPips(momentumWindow.reduce((total, value) => total + value, 0));
  const volatilityPips = toPips(volatilityWindow.reduce((total, value) => total + Math.abs(value), 0) / volatilityWindow.length);
  const lastMove = diffs[diffs.length - 1];
  const threshold = effectiveMomentumThresholdPips(config, Math.abs(volatilityPips));

  if (config.minVolatilityPips > 0 && Math.abs(volatilityPips) < config.minVolatilityPips) return null;
  if (momentumPips > threshold && upRatio > config.strongRatio) return 'CALL';
  if (momentumPips < -threshold && downRatio > config.strongRatio) return 'PUT';
  if (lastMove > 0 && upRatio > config.continuationRatio) return 'CALL';
  if (lastMove < 0 && downRatio > config.continuationRatio) return 'PUT';
  return null;
}
