/**
 * Entry checks are not guaranteed stop orders: open positions can settle
 * beyond the configured limit and a pair can open at different times.
 */

/** Markets the step hedge is allowed to trade: Deriv's Step index family. */
const STEP_MARKET = /^stpRNG\d*$/i;

/** The smallest stake Deriv accepts; also the floor of the balance budget. */
const MIN_STAKE = 0.35;

/** Horizons the price models can replay (one to ten ticks). */
const MIN_HORIZON = 1;
const MAX_HORIZON = 10;
/** High/Low Tick is only ever sold as a five-tick contract. */
const TICK_HORIZON = 5;

const tick = value => Number.isInteger(Number(value)) ? Number(value) : null;

/**
 * Is this trade-options shape one the price models can actually price?
 *
 * The important rule — and the one that silently stopped the Rise/Fall and the
 * hedge presets from trading — is that the horizon is the **contract's
 * duration**, not a number typed into another block. A strategy whose duration
 * and model horizon disagree used to be refused outright, which meant editing
 * Trade options parked the bot forever with no purchase and no error. Now the
 * contract wins: the models replay the horizon that will actually settle, and a
 * mismatch is reported rather than obeyed.
 *
 * @returns {{ ok: boolean, horizon: number, reason: string }}
 */
export function resolvePriceContext(mode, horizon, options = {}, engineOptions = {}) {
    const unsupported = reason => ({ ok: false, horizon: 0, reason });

    if (!['tick', 'rise', 'step-hedge'].includes(mode)) return unsupported(`unsupported strategy mode ${mode}`);

    const symbol = String(options?.symbol || '');
    if (!symbol) return unsupported('no market selected');

    // Tick-based contracts only: a second- or minute-duration "rise" is not the
    // contract the history was replayed against.
    const unit = String(options?.duration_unit || '').toLowerCase();
    if (unit !== 't') return unsupported(`tick duration required (got "${unit || 'none'}")`);

    const duration = tick(options?.duration);
    if (duration === null || duration < MIN_HORIZON) {
        return unsupported(`whole-tick duration required (got ${options?.duration})`);
    }

    const types = Array.isArray(engineOptions?.contractTypes) ? engineOptions.contractTypes : [];
    const directional = ['CALL', 'PUT'].every(type => types.includes(type));

    if (mode === 'tick') {
        if (!['TICKHIGH', 'TICKLOW'].every(type => types.includes(type))) {
            return unsupported('High/Low Tick needs both TICKHIGH and TICKLOW enabled');
        }
        if (duration !== TICK_HORIZON) {
            return unsupported(`High/Low Tick is sold in ${TICK_HORIZON}-tick contracts (duration is ${duration})`);
        }
        return { ok: true, horizon: TICK_HORIZON, reason: 'ready' };
    }

    if (!directional) return unsupported('Rise/Fall needs both CALL and PUT enabled');
    if (duration > MAX_HORIZON) {
        return unsupported(`the price models replay ${MIN_HORIZON}–${MAX_HORIZON} ticks (duration is ${duration})`);
    }
    if (mode === 'step-hedge' && !STEP_MARKET.test(symbol)) {
        return unsupported(`the step hedge trades the Step index family (market is ${symbol})`);
    }

    // Even horizons on a fixed-step market tie too often to be tradeable; the
    // models report the measured tie rate and the strategy gates on it. This is
    // a warning, not a refusal — a market with finer steps may be fine at 4.
    return { ok: true, horizon: duration, reason: 'ready' };
}

/** Backwards-compatible boolean wrapper around {@link resolvePriceContext}. */
export function priceContextAllowed(mode, horizon, options, engineOptions) {
    return resolvePriceContext(mode, horizon, options, engineOptions).ok;
}

export function priceRiskAllowed({
    stake,
    legs,
    baseline,
    loss,
    target,
    percent,
    balance,
    sessionProfit,
    hedgeIncomplete,
}) {
    const amount = Number(stake);
    const count = Number(legs);
    const start = Number(baseline);
    const maxLoss = Number(loss);
    const profitTarget = Number(target);
    const maxPercent = Number(percent);
    const bank = Number(balance);
    const pnl = Number(sessionProfit) - start;
    if (
        hedgeIncomplete ||
        ![amount, count, start, maxLoss, profitTarget, maxPercent, bank, pnl].every(Number.isFinite) ||
        amount <= 0 ||
        // Legs is the exposure multiplier: 1 for a single contract, 2 for a
        // pair of equal stakes, and a fraction in between for the partial
        // hedge the Step Index preset buys.
        !(count > 0 && count <= 2) ||
        maxLoss <= 0 ||
        profitTarget <= 0 ||
        maxPercent <= 0 ||
        maxPercent > 100 ||
        bank <= 0
    ) {
        return false;
    }
    const exposure = amount * count;
    // The balance policy is `maxPercent` of the bank — but a 5 % policy on a
    // 5 USD balance is 0.25, below the smallest stake Deriv will accept, so
    // that gate would reject every entry on a small account forever and look
    // exactly like a broken bot. When the percentage is below the exchange
    // minimum, one minimum-stake position per leg is allowed; above it, the
    // percentage is the limit.
    const budget = Math.max((bank * maxPercent) / 100, MIN_STAKE * count);
    return pnl < profitTarget && pnl > -maxLoss && exposure <= bank && exposure <= budget && exposure <= maxLoss + pnl;
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const safe = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * Stake sizing that follows the measured edge instead of a fixed ladder.
 *
 * The fraction of the bank at risk is the Kelly fraction for a binary contract
 * — `f* = (p·(1 + payout) − 1) / payout` — scaled down by `fraction` (a quarter
 * Kelly by default), capped by the operator's balance percentage, and clamped
 * to the exchange floor (Deriv rejects anything below 0.35) and to `maxStake`.
 *
 * Two deliberate brakes:
 *   - a negative or zero edge sizes to the floor, never to zero, so the
 *     strategy's own risk gate stays the thing that decides whether to trade;
 *   - `drawdown` (a positive number of losing units) scales the stake down, so
 *     a losing session de-risks instead of martingaling.
 */
export function adaptiveStake({
    probability,
    payout = 0.95,
    base = 0.35,
    fraction = 0.1,
    balance = 0,
    maxPercent = 5,
    maxStake = 0,
    drawdown = 0,
    minStake = 0.35,
}) {
    const floor = Math.max(0.35, safe(minStake, 0.35));
    const unit = Math.max(floor, safe(base, floor));
    const bank = Math.max(0, safe(balance, 0));
    const p = clamp(safe(probability, 0), 0, 1);
    const b = Math.max(0.01, safe(payout, 0.95));

    // Kelly for a binary contract: f* = (p·(1 + payout) − 1) / payout.
    const kelly = (p * (1 + b) - 1) / b;
    const percent = clamp(safe(maxPercent, 5), 0, 100) / 100;
    const cap = bank > 0 ? Math.min(bank, bank * percent, safe(maxStake, 0) > 0 ? Math.max(floor, safe(maxStake, 0)) : Infinity) : unit;

    // No measured edge: stake the operator's flat unit, never a speculation
    // about how much better the next tick might be.
    if (!(kelly > 0) || bank <= 0) return Math.round(clamp(unit, floor, Math.max(floor, cap)) * 100) / 100;

    const risk = clamp(kelly * clamp(safe(fraction, 0.1), 0, 1), 0, percent);
    // A losing session de-risks: each unit of drawdown scales the stake down,
    // which is the opposite of chasing the loss with a bigger stake.
    const braked = risk / (1 + Math.max(0, safe(drawdown, 0)));
    const sized = bank * braked;
    return Math.round(clamp(sized, floor, Math.max(floor, cap)) * 100) / 100;
}
