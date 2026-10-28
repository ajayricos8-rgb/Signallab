import {
    getSignalLabAnalysisGate,
    getSignalLabAnalysisGateReason,
    getSignalLabBalance,
    getSignalLabLastDigit,
    getSignalLabLastTick,
    getSignalLabTickChange,
    getSignalLabTicks,
    isSignalLabConnected,
    signalLabHedgeBalanced,
    signalLabHedgeCount,
    signalLabHedgeLegs,
    signalLabHedgePairs,
    signalLabHedgeProfit,
    signalLabScanBest,
    signalLabScanCount,
    signalLabScanMarkets,
    signalLabScanRank,
    signalLabScanScore,
    signalLabScanTradeable,
    signalLabVirtualBalance,
    signalLabVirtualBuy,
    signalLabVirtualOpen,
    signalLabVirtualProfit,
    signalLabVirtualReset,
    signalLabVirtualRuns,
    signalLabVirtualSettle,
    signalLabVirtualWins,
    waitForSignalLabAccount,
    waitForSignalLabTicks,
} from '@/services/signallab-feed';

/**
 * Bot.* functions for the Signal Lab blocks. Every function is async because
 * the interpreter wraps them with createAsync; the script still sees a plain
 * value. Ticks and account data are read from the cache Signal Lab posts into
 * this frame — nothing here opens a socket, holds a token, or places an order.
 */
const getSignalLabInterface = (tradeEngine = null) => ({
    getSignalLabAnalysisGate: async (family, symbol, analysisId, contractType, barrier, targetDigit) =>
        getSignalLabAnalysisGate(
            String(family), String(symbol), String(analysisId), String(contractType), Number(barrier), Number(targetDigit)
        ),
    getSignalLabAnalysisGateReason: async (family, symbol, analysisId, contractType, barrier, targetDigit) =>
        getSignalLabAnalysisGateReason(
            String(family), String(symbol), String(analysisId), String(contractType), Number(barrier), Number(targetDigit)
        ),
    getSignalLabLastTick: async symbol => {
        await waitForSignalLabTicks(String(symbol));
        return getSignalLabLastTick(String(symbol));
    },
    getSignalLabTicks: async symbol => {
        await waitForSignalLabTicks(String(symbol));
        return getSignalLabTicks(String(symbol));
    },
    getSignalLabLastDigit: async symbol => {
        await waitForSignalLabTicks(String(symbol));
        return getSignalLabLastDigit(String(symbol));
    },
    getSignalLabTickChange: async (symbol, count) => {
        await waitForSignalLabTicks(String(symbol));
        return getSignalLabTickChange(String(symbol), Number(count));
    },
    // The account waits resolve `null` when Signal Lab has not shared an
    // account within the grace window. Neutral read values (0 / '') keep a
    // strategy's conditions evaluable — and its Purchase blocks reachable —
    // instead of an exception restarting the whole run.
    getSignalLabBalance: async () => {
        const account = await waitForSignalLabAccount();
        return getSignalLabBalance() ?? account?.balance ?? 0;
    },
    getSignalLabOpenPositions: async () => {
        const account = await waitForSignalLabAccount();
        return account?.openPositions.length ?? 0;
    },
    getSignalLabRealisedProfit: async () => {
        const account = await waitForSignalLabAccount();
        return account?.realizedProfit ?? 0;
    },
    getSignalLabAccountId: async () => {
        const account = await waitForSignalLabAccount();
        return account?.accountId ?? '';
    },
    isSignalLabConnected: async () => isSignalLabConnected(),
    // Cross-market scan (all markets).
    signalLabScanMarkets: async (family, duration, minScore) =>
        signalLabScanMarkets(family, duration, minScore),
    signalLabScanBest: async () => signalLabScanBest(),
    signalLabScanScore: async symbol => signalLabScanScore(String(symbol)),
    signalLabScanRank: async symbol => signalLabScanRank(String(symbol)),
    signalLabScanCount: async () => signalLabScanCount(),
    signalLabScanTradeable: async () => signalLabScanTradeable(),
    // Move the running bot to another market, so an all-markets scan can act on
    // the market it picked. Swaps the symbol the engine trades and proposes on,
    // then resubscribes that market's tick stream.
    signalLabSwitchMarket: async symbol => {
        const wanted = String(symbol || '').trim();
        if (!wanted || !tradeEngine) return '';
        const previous = tradeEngine.options?.symbol ?? tradeEngine.tradeOptions?.symbol ?? '';
        if (wanted === previous) return wanted;
        try {
            await tradeEngine.switchSymbol(wanted);
        } catch {
            // A market we could not stream is not worth crashing a session for.
            return previous || '';
        }
        if (tradeEngine.options) tradeEngine.options.symbol = wanted;
        if (tradeEngine.tradeOptions) tradeEngine.tradeOptions.symbol = wanted;
        return wanted;
    },
    // Switch to whatever the last all-markets scan picked. The fixed-market
    // switch block takes a dropdown value, so a scan-driven strategy needs
    // this dynamic form to actually trade the market it found.
    signalLabSwitchToBest: async () => {
        const best = signalLabScanBest();
        if (!best || !tradeEngine) return '';
        const previous = tradeEngine.options?.symbol ?? tradeEngine.tradeOptions?.symbol ?? '';
        if (best === previous) return best;
        try {
            await tradeEngine.switchSymbol(best);
        } catch {
            return previous || '';
        }
        if (tradeEngine.options) tradeEngine.options.symbol = best;
        if (tradeEngine.tradeOptions) tradeEngine.tradeOptions.symbol = best;
        return best;
    },
    // Hedging.
    signalLabHedgeLegs: async symbol => signalLabHedgeLegs(String(symbol)),
    signalLabHedgePairs: async symbol => signalLabHedgePairs(String(symbol)),
    signalLabHedgeBalanced: async symbol => signalLabHedgeBalanced(String(symbol)),
    signalLabHedgeCount: async () => signalLabHedgeCount(),
    signalLabHedgeProfit: async () => signalLabHedgeProfit(),
    // Virtual trading.
    signalLabVirtualBuy: async (symbol, direction, stake, payout, barrier) =>
        signalLabVirtualBuy(symbol, direction, stake, payout, barrier),
    signalLabVirtualSettle: async () => signalLabVirtualSettle(),
    signalLabVirtualReset: async () => signalLabVirtualReset(),
    signalLabVirtualProfit: async () => signalLabVirtualProfit(),
    signalLabVirtualRuns: async () => signalLabVirtualRuns(),
    signalLabVirtualWins: async () => signalLabVirtualWins(),
    signalLabVirtualOpen: async () => signalLabVirtualOpen(),
    signalLabVirtualBalance: async () => signalLabVirtualBalance(),
});

export default getSignalLabInterface;
