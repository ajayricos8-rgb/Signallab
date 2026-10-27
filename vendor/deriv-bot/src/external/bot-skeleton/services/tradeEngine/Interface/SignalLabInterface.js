import {
    getSignalLabBalance,
    getSignalLabLastDigit,
    getSignalLabLastTick,
    getSignalLabTickChange,
    getSignalLabTicks,
    isSignalLabConnected,
    waitForSignalLabAccount,
    waitForSignalLabTicks,
} from '@/services/signallab-feed';

/**
 * Bot.* functions for the Signal Lab blocks. Every function is async because
 * the interpreter wraps them with createAsync; the script still sees a plain
 * value. Ticks and account data are read from the cache Signal Lab posts into
 * this frame — nothing here opens a socket, holds a token, or places an order.
 */
const getSignalLabInterface = () => ({
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
    getSignalLabBalance: async () => {
        const account = await waitForSignalLabAccount();
        return getSignalLabBalance() ?? account.balance ?? 0;
    },
    getSignalLabOpenPositions: async () => {
        const account = await waitForSignalLabAccount();
        return account.openPositions.length;
    },
    getSignalLabRealisedProfit: async () => {
        const account = await waitForSignalLabAccount();
        return account.realizedProfit;
    },
    getSignalLabAccountId: async () => {
        const account = await waitForSignalLabAccount();
        return account.accountId;
    },
    isSignalLabConnected: async () => isSignalLabConnected(),
});

export default getSignalLabInterface;
