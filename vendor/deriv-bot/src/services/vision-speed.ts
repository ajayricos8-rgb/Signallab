/**
 * Vision Lab — bot speed.
 *
 * One shared setting drives every timing in the workspace: how long the
 * "pause" blocks wait, how many ticks the entry filters insist on, and how much
 * the AI will slow down to double-check a signal. It lives outside the store so
 * both the React UI (the Fast/Slow control beside Run) and the Blockly runtime
 * (the interpreter's sleep, the AI blocks) read the same value without a store
 * round-trip, and it survives reloads.
 *
 * The value is also mirrored to the parent Signal Lab frame over postMessage so
 * the host toolbar and the in-frame control never disagree.
 */

export type VisionSpeed = 'slow' | 'normal' | 'fast';

export type SpeedProfile = {
    id: VisionSpeed;
    label: string;
    hint: string;
    /** Multiplier applied to every pause/delay block. */
    sleepFactor: number;
    /** Multiplier applied to "wait N ticks" style confirmations. */
    tickFactor: number;
    /** Extra confirmation demanded from the AI before it fires (0-1). */
    scrutiny: number;
};

export const SPEED_PROFILES: Record<VisionSpeed, SpeedProfile> = {
    slow: {
        id: 'slow',
        label: 'Slow',
        hint: 'Deliberate: longer pauses, more confirming ticks, the AI demands more agreement.',
        sleepFactor: 1.9,
        tickFactor: 1.8,
        scrutiny: 0.16,
    },
    normal: {
        id: 'normal',
        label: 'Normal',
        hint: 'Balanced: the timings in your blocks, the AI at its default thresholds.',
        sleepFactor: 1,
        tickFactor: 1,
        scrutiny: 0,
    },
    fast: {
        id: 'fast',
        label: 'Fast',
        hint: 'Aggressive: pauses shrink, fewer confirming ticks, entries fire on the next tick.',
        sleepFactor: 0.42,
        tickFactor: 0.55,
        scrutiny: -0.06,
    },
};

const STORAGE_KEY = 'signal-lab.vision-speed.v1';
const listeners = new Set<(speed: VisionSpeed) => void>();

let current: VisionSpeed = readStored();

function readStored(): VisionSpeed {
    try {
        const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
        return value === 'slow' || value === 'fast' || value === 'normal' ? value : 'normal';
    } catch {
        return 'normal';
    }
}

export const getSpeed = (): VisionSpeed => current;

export const getProfile = (speed: VisionSpeed = current): SpeedProfile =>
    SPEED_PROFILES[speed] || SPEED_PROFILES.normal;

export const getSpeedIndex = (): number => (current === 'slow' ? 0 : current === 'fast' ? 2 : 1);

export function setSpeed(speed: VisionSpeed, options: { silent?: boolean } = {}): VisionSpeed {
    const next = SPEED_PROFILES[speed] ? speed : 'normal';
    const changed = next !== current;
    current = next;
    try {
        if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // Private mode: the setting simply won't persist.
    }
    if (changed) listeners.forEach(listener => listener(next));
    if (!options.silent && typeof window !== 'undefined' && window.parent !== window) {
        window.parent.postMessage({ source: 'signal-lab-dbot', type: 'speed', speed: next }, window.location.origin);
    }
    return current;
}

export const subscribeSpeed = (listener: (speed: VisionSpeed) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** Scale a pause (in seconds) by the active speed profile. */
export const scaleSleep = (seconds: number): number => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, value * getProfile().sleepFactor);
};

/** Scale a "wait N ticks" count by the active speed profile. */
export const scaleTicks = (ticks: number): number => {
    const value = Number(ticks);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(1, Math.round(value * getProfile().tickFactor));
};

/** How much extra agreement the AI should insist on at this speed. */
export const scrutinyAdjustment = (): number => getProfile().scrutiny;

export default { getSpeed, getSpeedIndex, getProfile, setSpeed, subscribeSpeed, scaleSleep, scaleTicks, SPEED_PROFILES };
