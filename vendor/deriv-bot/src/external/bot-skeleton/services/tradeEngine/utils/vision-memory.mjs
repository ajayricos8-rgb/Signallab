/**
 * Vision Lab — persistent memory.
 *
 * The AI brain (expert weights + the online softmax net) is per market and is
 * kept in localStorage so a bot that has been running for an hour keeps what it
 * learned the next time it starts. Everything degrades to an in-memory map when
 * storage is unavailable, so the engine behaves identically under test.
 */

import { defaultBrain } from './vision-ai.mjs';

const STORAGE_KEY = 'signal-lab.vision-brain.v1';
const STATS_KEY = 'signal-lab.vision-stats.v1';

const memoryStore = new Map();

function storage() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage) return null;
        return localStorage;
    } catch {
        // Private mode / blocked storage: fall back to memory only.
        return null;
    }
}

function readJson(key, fallback) {
    const store = storage();
    try {
        const raw = store ? store.getItem(key) : memoryStore.get(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeJson(key, value) {
    const raw = JSON.stringify(value);
    const store = storage();
    try {
        if (store) store.setItem(key, raw);
        else memoryStore.set(key, raw);
    } catch {
        memoryStore.set(key, raw);
    }
}

/** All brains, keyed by market symbol (or 'default'). */
export function loadBrains() {
    const data = readJson(STORAGE_KEY, null);
    return data && typeof data === 'object' ? data : {};
}

export function loadBrain(symbol) {
    const brains = loadBrains();
    const key = String(symbol || 'default');
    return brains[key] || defaultBrain();
}

export function saveBrain(symbol, brain) {
    const brains = loadBrains();
    brains[String(symbol || 'default')] = brain;
    try {
        writeJson(STORAGE_KEY, brains);
    } catch {
        // A full quota must never stop the bot from trading.
    }
    return brain;
}

export function resetBrain(symbol) {
    const brains = loadBrains();
    const key = String(symbol || 'default');
    if (symbol) delete brains[key];
    else Object.keys(brains).forEach(name => delete brains[name]);
    writeJson(STORAGE_KEY, brains);
    return defaultBrain();
}

export function brainSize(symbol) {
    const brain = loadBrain(symbol);
    return {
        trained: brain.trained || 0,
        wins: brain.wins || 0,
        losses: brain.losses || 0,
        neuralUpdates: brain?.neural?.updates || 0,
        experts: Object.keys(brain.experts || {}).map(name => ({
            name,
            weight: brain.experts[name].weight,
            brier: brain.experts[name].brier,
        })),
    };
}

/* ------------------------------------------------------------------ *
 * Session statistics (streaks, win rate, cooldowns)
 * ------------------------------------------------------------------ */

const emptyStats = () => ({
    startedAt: Date.now(),
    trades: 0,
    wins: 0,
    losses: 0,
    streak: 0, // positive = wins in a row, negative = losses in a row
    lastTradeAt: 0,
    lastResult: '',
    peakProfit: 0,
    maxDrawdown: 0,
});

let sessionStats = emptyStats();

export const getStats = () => ({ ...sessionStats });

export function resetStats() {
    sessionStats = emptyStats();
    persistStats();
    return getStats();
}

function persistStats() {
    writeJson(STATS_KEY, sessionStats);
}

export function loadStats() {
    const stored = readJson(STATS_KEY, null);
    if (stored && typeof stored === 'object') sessionStats = { ...emptyStats(), ...stored };
    return getStats();
}

/** Record a settled contract: keeps streaks, win rate and drawdown current. */
export function recordTrade({ won, profit }) {
    const stats = sessionStats;
    stats.trades += 1;
    stats.lastTradeAt = Date.now();
    stats.lastResult = won ? 'win' : 'loss';
    if (won) {
        stats.wins += 1;
        stats.streak = stats.streak > 0 ? stats.streak + 1 : 1;
    } else {
        stats.losses += 1;
        stats.streak = stats.streak < 0 ? stats.streak - 1 : -1;
    }
    const pnl = Number(profit) || 0;
    stats.runningProfit = (stats.runningProfit || 0) + pnl;
    if (stats.runningProfit > stats.peakProfit) stats.peakProfit = stats.runningProfit;
    stats.maxDrawdown = Math.max(stats.maxDrawdown, stats.peakProfit - stats.runningProfit);
    persistStats();
    return getStats();
}

export const winRate = () => {
    const { wins, trades } = sessionStats;
    return trades ? (wins / trades) * 100 : 0;
};

export const secondsSinceLastTrade = () => {
    if (!sessionStats.lastTradeAt) return 1e6;
    return (Date.now() - sessionStats.lastTradeAt) / 1000;
};

export const secondsRunning = () => (Date.now() - sessionStats.startedAt) / 1000;

export default {
    brainSize,
    getStats,
    loadBrain,
    loadBrains,
    loadStats,
    recordTrade,
    resetBrain,
    resetStats,
    saveBrain,
    secondsRunning,
    secondsSinceLastTrade,
    winRate,
};
