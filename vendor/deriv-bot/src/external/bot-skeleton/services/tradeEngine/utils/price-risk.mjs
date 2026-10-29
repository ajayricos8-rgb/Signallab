/** Entry checks are not guaranteed stop orders: open positions can settle
 * beyond the configured limit and a pair can open at different times. */
export function priceRiskAllowed({ stake, legs, baseline, loss, target, percent, balance, sessionProfit, hedgeIncomplete }) {
    const amount = Number(stake), count = Number(legs), start = Number(baseline);
    const maxLoss = Number(loss), profitTarget = Number(target), maxPercent = Number(percent);
    const bank = Number(balance), pnl = Number(sessionProfit) - start;
    if (hedgeIncomplete || ![amount, count, start, maxLoss, profitTarget, maxPercent, bank, pnl].every(Number.isFinite) ||
        amount <= 0 || ![1, 2].includes(count) || maxLoss <= 0 || profitTarget <= 0 || maxPercent <= 0 || maxPercent > 100 || bank <= 0) return false;
    const exposure = amount * count;
    return pnl < profitTarget && pnl > -maxLoss && exposure <= bank && exposure <= bank * maxPercent / 100 && exposure <= maxLoss + pnl;
}

export function priceContextAllowed(mode, horizon, options, engineOptions) {
    if (!['tick', 'rise', 'step-hedge'].includes(mode)) return false;
    const expected = mode === 'tick' ? 5 : mode === 'step-hedge' ? 4 : Number(horizon);
    const symbol = String(options?.symbol || '');
    const types = engineOptions?.contractTypes || [];
    const expectedTypes = mode === 'tick' ? ['TICKHIGH', 'TICKLOW'] : ['CALL', 'PUT'];
    return options?.duration_unit === 't' && Number(options.duration) === expected &&
        expectedTypes.every(type => types.includes(type)) &&
        (mode !== 'step-hedge' || /^stpRNG(?:\d+)?$/i.test(symbol));
}
