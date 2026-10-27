/**
 * Vision Lab — the `Bot.*` runtime behind the Vision blocks.
 *
 * Everything the blocks compute happens here, in native JavaScript, and only
 * the result is handed back to the ES5 interpreter. That keeps strategies that
 * chew through a thousand ticks per decision fast enough to fire on the very
 * next tick instead of several ticks later.
 *
 * The interface is stateless apart from two caches:
 *
 *   - the *plan cache*, keyed by market, which holds one coherent AI decision
 *     per tick so every block in a strategy reads the same numbers (barrier,
 *     direction, probability, stake) rather than each recomputing its own;
 *   - the *brain*, per market, persisted by vision-memory.
 */

import { getProfile, getSpeed, scaleSleep, scaleTicks, scrutinyAdjustment } from '@/services/vision-speed';
import { localize } from '@deriv-com/translations';
import { observer as globalObserver } from '../../../utils/observer';
import * as ai from '../utils/vision-ai.mjs';
import * as math from '../utils/vision-math.mjs';
import * as memory from '../utils/vision-memory.mjs';
import { ensurePayouts, payoutSnapshot, refreshPayouts } from '../utils/vision-payouts.js';

const PLAN_TTL_MS = 4_000;
const DEFAULT_HORIZON = 5;
const DEFAULT_MIN_EDGE = -100; // the block default: significance decides, the value gate is off
const DEFAULT_MIN_CONFIDENCE = 0;
const DEFAULT_MIN_LEAN = 0; // the block default: trade the strongest measured lean
const DEFAULT_RISK = 0.6;
const DEFAULT_TARGET_EDGE = 0.04;

const planCache = new Map();
/** Last measured ticks-per-minute, per market. */
const measuredTickRate = new Map();

const num = (value, fallback = 0) => {
    const parsed = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const pct = value => num(value) * (Math.abs(num(value)) <= 1.5 ? 100 : 1);

const round = (value, digits = 4) => {
    const factor = 10 ** digits;
    return Math.round(num(value) * factor) / factor;
};

const clamp = (value, low, high) => Math.min(Math.max(num(value), low), high);

const getVisionInterface = tradeEngine => {
    const symbolOf = () => tradeEngine?.options?.symbol || tradeEngine?.symbol || 'default';

    const tradeOptions = () => tradeEngine?.tradeOptions || {};

    /** The contract horizon in ticks, derived from whatever the strategy set. */
    const horizonTicks = () => {
        const options = tradeOptions();
        const duration = num(options.duration, DEFAULT_HORIZON);
        const unit = String(options.duration_unit || 't').toLowerCase();
        if (unit === 't') return Math.max(1, Math.round(duration));
        if (unit === 's') return Math.max(1, Math.round(duration * (tradeEngine?.ticksPerSecond?.() || 1)));
        if (unit === 'm') return Math.max(1, Math.round(duration * 60));
        if (unit === 'h') return Math.max(1, Math.round(duration * 3600));
        if (unit === 'd') return Math.max(1, Math.round(duration * 86400));
        return Math.max(1, Math.round(duration));
    };

    const payoutOptions = () => {
        const options = tradeOptions();
        return {
            symbol: symbolOf(),
            duration: num(options.duration, DEFAULT_HORIZON),
            durationUnit: options.duration_unit || 't',
            currency: options.currency || 'USD',
            amount: num(options.amount, 1),
        };
    };

    const readTicks = async () => {
        try {
            const ticks = await tradeEngine.getTicks();
            return math.toNumbers(ticks);
        } catch {
            return [];
        }
    };

    const signatureOf = ticks => `${ticks.length}:${ticks.length ? ticks[ticks.length - 1] : 0}`;

    /**
     * One AI decision per tick per market. Later calls inside the same tick get
     * the cached plan so the barrier, direction, stake and probability a
     * strategy reads always belong to the same decision.
     */
    const getPlan = async (overrides = {}) => {
        const symbol = symbolOf();
        const ticks = await readTicks();
        if (ticks.length < 80) return null;

        const signature = signatureOf(ticks);
        const cached = planCache.get(symbol);
        if (cached && cached.signature === signature && Date.now() - cached.at < PLAN_TTL_MS) {
            return applyOverrides(cached.plan, overrides);
        }

        const payouts = await ensurePayouts(payoutOptions());
        const previous = cached?.plan || null;
        const brain = memory.loadBrain(symbol);
        const plan = ai.planTrade(ticks, {
            horizon: overrides.horizon ?? horizonTicks(),
            minEdge: overrides.minEdge ?? DEFAULT_MIN_EDGE,
            minLean: overrides.minLean ?? DEFAULT_MIN_LEAN,
            minConfidence: overrides.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
            minAgreement: clamp((overrides.minAgreement ?? 0.7) + scrutinyAdjustment(), 0, 1),
            risk: overrides.risk ?? DEFAULT_RISK,
            targetEdge: overrides.targetEdge ?? DEFAULT_TARGET_EDGE,
            window: overrides.window ?? 40,
            brain,
            previous,
            payouts,
        });

        planCache.set(symbol, {
            signature,
            at: Date.now(),
            plan,
            ticks,
            symbol,
        });
        return plan;
    };

    /**
     * Re-evaluate the go/no-go verdict when a block asks with new thresholds.
     * The candidate itself is chosen when the plan is built; only the gates are
     * re-applied, so every block in a tick still reads one coherent decision.
     */
    const applyOverrides = (plan, overrides) => {
        const keys = ['horizon', 'minEdge', 'minLean', 'minConfidence', 'minAgreement', 'risk'];
        const touched = keys.some(key => overrides[key] !== undefined && overrides[key] !== null);
        if (!touched || !plan?.best) return plan;
        const minEdge = num(overrides.minEdge ?? DEFAULT_MIN_EDGE);
        const minLean = num(overrides.minLean ?? DEFAULT_MIN_LEAN);
        const minConfidence = num(overrides.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
        const minAgreement = clamp((overrides.minAgreement ?? 0.7) + scrutinyAdjustment(), 0, 1);
        const strictValue = minEdge > -50;
        const relaxed = minLean <= 0;
        const go =
            plan.best.bias > 0 &&
            (relaxed ||
                (plan.best.rawBias > 0 &&
                    plan.best.tStat >= minLean &&
                    plan.confidence >= minConfidence &&
                    plan.agreementRatio >= minAgreement)) &&
            (!strictValue || plan.best.adjusted >= minEdge / 100);
        return { ...plan, go, reason: go ? 'entry confirmed' : plan.reason };
    };

    const lastDigitFromContract = () => {
        const contract = tradeEngine?.data?.contract || {};
        const raw =
            contract.exit_tick ??
            contract.exit_tick_display_value ??
            contract.entry_tick ??
            contract.entry_tick_display_value;
        const value = Number(raw);
        if (!Number.isFinite(value)) return -1;
        let pipSize = null;
        try {
            pipSize = tradeEngine?.getPipSize?.() ?? null;
        } catch {
            pipSize = null;
        }
        return math.lastDigitOf(value, pipSize);
    };

    /** Column label for a notify/journal entry. */
    const toneFor = plan => {
        if (!plan?.best) return 'warn';
        if (!plan.go) return 'info';
        return plan.best.edge >= 0.03 ? 'success' : 'info';
    };

    /* ------------------------------------------------------------------ *
     * All markets
     * ------------------------------------------------------------------ */

    /**
     * Every volatility index the bot is allowed to walk through. These are the
     * Deriv synthetic indices with digit contracts: five one-second markets and
     * five two-second ones.
     */
    const MARKETS = [
        '1HZ10V',
        '1HZ25V',
        '1HZ50V',
        '1HZ75V',
        '1HZ100V',
        'R_10',
        'R_25',
        'R_50',
        'R_75',
        'R_100',
    ];

    /** How well this market has looked each time we have read it. */
    const marketScores = new Map();
    let marketSwitchedAt = 0;

    const secondsOnMarket = () => (marketSwitchedAt ? (Date.now() - marketSwitchedAt) / 1000 : 0);

    /**
     * A 0-100 read on how worth trading this market is right now: how far past
     * the noise the strongest lean sits, how confident the ensemble is, how
     * many models agree, and how much data is behind the lot. It is a ranking
     * device for choosing where to stand, not a forecast of profit.
     */
    const scoreMarket = plan => {
        if (!plan?.best) return 0;
        const lean = clamp(Math.abs(plan.best.tStat) / 3, 0, 1);
        const confidence = clamp((plan.confidence ?? 0) / 100, 0, 1);
        const agreement = clamp(plan.agreementRatio ?? 0, 0, 1);
        const quality = clamp(plan.dataQuality ?? 0, 0, 1);
        return round(100 * (0.4 * lean + 0.25 * confidence + 0.2 * agreement + 0.15 * quality), 1);
    };

    /** Remember how this market looked, so "best" has something to compare. */
    const rememberMarket = (symbol, score) => {
        if (!symbol) return;
        const previous = marketScores.get(symbol);
        const smoothed = previous ? previous.score * 0.6 + score * 0.4 : score;
        marketScores.set(symbol, { score: round(smoothed, 1), at: Date.now() });
    };

    const otherMarkets = symbol => MARKETS.filter(market => market !== symbol);

    const pickRandom = symbol => {
        const options = otherMarkets(symbol);
        if (!options.length) return symbol;
        return options[Math.floor(Math.random() * options.length)];
    };

    const pickNext = symbol => {
        const index = MARKETS.indexOf(symbol);
        return index < 0 ? MARKETS[0] : MARKETS[(index + 1) % MARKETS.length];
    };

    /**
     * Turn a choice into a symbol. Anything that is not one of our markets and
     * not a mode name is passed through untouched, so a strategy can name a
     * market the list does not carry.
     */
    const resolveMarket = (wanted, current) => {
        const key = String(wanted || '').trim();
        if (!key) return current;
        if (MARKETS.includes(key)) return key;
        if (key === 'random') return pickRandom(current);
        if (key === 'next') return pickNext(current);
        if (key === 'best' || key === 'suitable') return pickBestKnown(current);
        return key;
    };

    /** The remembered best market we are not already standing on. */
    const pickBestKnown = symbol => {
        let best = null;
        marketScores.forEach((entry, market) => {
            if (market === symbol) return;
            if (!best || entry.score > best.score) best = { market, score: entry.score };
        });
        if (best && best.score > 0) return best.market;
        return pickRandom(symbol);
    };

    /**
     * Move the running bot to another market: swap the symbol the engine trades
     * and proposes on, resubscribe the tick stream, wait for that market's
     * history, and warm its payout table without holding up the tick.
     */
    const switchToMarket = async symbol => {
        const previous = symbolOf();
        if (!symbol || symbol === previous) return previous;

        planCache.delete(previous);
        if (tradeEngine?.options) tradeEngine.options.symbol = symbol;
        if (tradeEngine?.tradeOptions) tradeEngine.tradeOptions.symbol = symbol;

        try {
            await tradeEngine.switchSymbol(symbol);
        } catch {
            // A market we could not stream is not worth crashing a session for.
            if (tradeEngine?.options) tradeEngine.options.symbol = previous;
            if (tradeEngine?.tradeOptions) tradeEngine.tradeOptions.symbol = previous;
            return previous;
        }

        planCache.delete(symbol);
        marketSwitchedAt = Date.now();
        ensurePayouts(payoutOptions()); // price the new market in the background
        return symbol;
    };

    return {
        /* ---------------- AI core ---------------- */

        visionAnalyse: async (horizon, minEdge, minLean, minConfidence, minAgreement, risk) => {
            const plan = await getPlan({
                horizon: horizon ?? undefined,
                minEdge: minEdge ?? undefined,
                minLean: minLean ?? undefined,
                minConfidence: minConfidence ?? undefined,
                risk: risk ?? undefined,
                minAgreement: minAgreement ?? undefined,
            });
            if (!plan) return localize('Not enough ticks yet for the AI to read the market.');
            return plan.summary;
        },

        visionBarrier: async () => (await getPlan())?.barrier ?? -1,
        visionDirection: async () => (await getPlan())?.direction ?? 'wait',
        visionProbability: async () => round(((await getPlan())?.probability ?? 0) * 100, 3),
        visionFair: async () => round(((await getPlan())?.fair ?? 0) * 100, 3),
        visionEdge: async () => round(((await getPlan())?.edge ?? 0) * 100, 3),
        visionBias: async () => round((await getPlan())?.biasPoints ?? 0, 3),
        visionConfidence: async () => round((await getPlan())?.confidence ?? 0, 1),
        visionAgreement: async () => round(((await getPlan())?.agreementRatio ?? 0) * 100, 1),
        visionPayout: async () => round((await getPlan())?.payout ?? 0, 4),
        visionGo: async () => Boolean((await getPlan())?.go),
        visionReason: async () => (await getPlan())?.reason ?? localize('no plan'),
        visionSummary: async () => (await getPlan())?.summary ?? localize('no plan'),
        visionHorizon: async () => horizonTicks(),

        visionStake: async baseStake => {
            const plan = await getPlan();
            const base = num(baseStake, 1);
            if (!plan?.best || !plan.go) return round(base * 0.25, 2);
            return round(base * clamp(plan.stakeFactor, 0, 1), 2);
        },

        visionDigitProbability: async digit => {
            const plan = await getPlan();
            const index = clamp(Math.round(num(digit, 0)), 0, 9);
            if (!plan) return 10;
            return round((plan.distribution[index] || 0) * 100, 3);
        },

        visionRegime: async () => {
            const plan = await getPlan();
            if (!plan) return 'unknown';
            const hurstValue = plan.hurst ?? 0.5;
            const acf = plan.acf ?? 0;
            if (hurstValue > 0.58) return 'trend';
            if (hurstValue < 0.42) return 'reversion';
            if (acf < -0.12) return 'chop';
            if (plan.entropy < 3.1) return 'biased';
            return 'balanced';
        },

        visionFeature: async name => {
            const plan = await getPlan();
            const ticks = (await readTicks());
            const key = String(name || '').toLowerCase();
            const features = plan?.features || [0, 0, 1, 0, 0];
            switch (key) {
                case 'displacement':
                    return round(features[0] ?? 0, 4);
                case 'drift':
                    return round(features[1] ?? 0, 4);
                case 'volratio':
                    return round(features[2] ?? 1, 4);
                case 'digit':
                    return round(features[3] ?? 0, 4);
                case 'parity':
                    return round(features[4] ?? 0, 4);
                case 'volatility':
                    return round(math.stdDev(math.returns(ticks)), 6);
                case 'entropy':
                    return round(math.digitEntropy(ticks), 4);
                case 'hurst':
                    return round(math.hurst(ticks), 4);
                case 'acf':
                    return round(math.autocorrelation(ticks, 1), 4);
                case 'streak':
                    return round(math.streak(ticks), 0);
                case 'digitstreak':
                    return round(math.digitStreak(ticks), 0);
                case 'spread':
                    return round(math.digitSpread(ticks), 3);
                case 'even':
                    return round(math.evenShare(ticks), 2);
                case 'rsi':
                    return round(math.rsi(ticks, 14), 2);
                case 'drawdown':
                    return round(math.maxDrawdown(ticks), 6);
                case 'speed':
                    return round(measuredTickRate.get(symbolOf()) || 0, 2);
                default:
                    return 0;
            }
        },

        visionModelVote: async model => {
            const plan = await getPlan();
            const key = String(model || 'analog').toLowerCase();
            const expert = plan?.experts?.[key];
            if (!expert || !plan?.best) return 50;
            const barrier = plan.best.barrier;
            const probability =
                plan.best.direction === 'over'
                    ? ai.probabilityOver(expert.distribution, barrier)
                    : ai.probabilityUnder(expert.distribution, barrier);
            return round(probability * 100, 3);
        },

        visionModelWeight: async model => {
            const plan = await getPlan();
            const key = String(model || 'analog').toLowerCase();
            return round((plan?.experts?.[key]?.share ?? 0) * 100, 2);
        },

        /** Teach the AI from a settled contract; pass -1 to read the contract. */
        visionLearn: async digit => {
            const symbol = symbolOf();
            const cached = planCache.get(symbol);
            const contract = tradeEngine?.data?.contract || {};
            const outcome = Number(digit);
            const actual = Number.isFinite(outcome) && outcome >= 0 ? Math.round(outcome) : lastDigitFromContract();
            if (actual < 0) return memory.brainSize(symbol).trained;

            const brain = memory.loadBrain(symbol);
            const expertDistributions = Object.entries(cached?.plan?.experts || {}).map(([name, expert]) => ({
                name,
                distribution: expert.distribution,
            }));
            const probability = cached?.plan?.probability ?? null;
            const won = contract.sell_price != null
                ? Number(contract.sell_price) > Number(contract.buy_price)
                : typeof probability === 'number'
                    ? cached.plan.best
                        ? (cached.plan.best.direction === 'over' ? actual > cached.plan.best.barrier : actual < cached.plan.best.barrier)
                        : false
                    : false;

            const next = ai.learn(brain, {
                digit: actual,
                features: cached?.plan?.features || null,
                expertDistributions,
                won,
            });
            memory.saveBrain(symbol, next);
            memory.recordTrade({ won, profit: Number(contract.profit) || 0 });
            return next.trained;
        },

        visionBrainSize: async () => memory.brainSize(symbolOf()).trained,

        visionBrainStats: async () => {
            const stats = memory.brainSize(symbolOf());
            const winRate = stats.wins + stats.losses ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0;
            return `trained ${stats.trained} · net ${winRate.toFixed(1)}% · net-updates ${stats.neuralUpdates}`;
        },

        visionResetBrain: async () => {
            memory.resetBrain(symbolOf());
            planCache.delete(symbolOf());
            return true;
        },

        visionRefreshPayouts: async () => {
            await refreshPayouts(payoutOptions());
            return true;
        },

        visionPayoutLive: async () => Boolean(payoutSnapshot(payoutOptions())?.live),

        visionNotify: async message => {
            const plan = await getPlan().catch(() => null);
            const text = message != null && message !== '' ? String(message) : plan?.summary || localize('no plan');
            globalObserver.emit('ui.log.notify', {
                className: `journal__text--${toneFor(plan)}`,
                message: text,
                sound: 'silent',
                block_id: 'vision-notify',
            });
            return true;
        },

        visionLog: async message => {
            // eslint-disable-next-line no-console
            console.log(new Date().toLocaleTimeString(), String(message));
            return true;
        },

        /* ---------------- quant maths ---------------- */

        qSma: async (list, period) => round(math.sma(list, num(period, 14)), 6),
        qEma: async (list, period) => round(math.ema(list, num(period, 14)), 6),
        qWma: async (list, period) => round(math.wma(list, num(period, 14)), 6),
        qRsi: async (list, period) => round(math.rsi(list, num(period, 14)), 3),
        qStdDev: async list => round(math.stdDev(math.toNumbers(list)), 6),
        qVariance: async list => round(math.variance(math.toNumbers(list)), 8),
        qMean: async list => round(math.mean(math.toNumbers(list)), 6),
        qMedian: async list => round(math.median(math.toNumbers(list)), 6),
        qSlope: async list => round(math.slope(list), 8),
        qZscore: async (list, value) => {
            const values = math.toNumbers(list);
            const sigma = math.stdDev(values);
            if (!sigma) return 0;
            return round((num(value) - math.mean(values)) / sigma, 4);
        },
        qPercentile: async (list, p) => round(math.quantile(math.toNumbers(list), clamp(pct(p) / 100, 0, 1)), 6),
        qCorrelation: async (a, b) => round(math.correlation(a, b), 5),
        qAutocorr: async (list, lag) => round(math.autocorrelation(list, num(lag, 1)), 5),
        qHurst: async list => round(math.hurst(math.toNumbers(list)), 4),
        qEntropy: async list => round(math.digitEntropy(math.toNumbers(list)), 4),
        qAtr: async (list, period) => round(math.atr(list, num(period, 14)), 6),
        qVolatility: async (list, period) => round(math.stdDev(math.returns(math.windowSlice(list, num(period, 100)))), 6),
        qBollinger: async (list, period, deviations) => round(math.bollingerPercentB(list, num(period, 20), num(deviations, 2)), 4),
        qMacd: async (list, fast, slow, signalPeriod, wantSignal) =>
            round(math.macd(list, num(fast, 12), num(slow, 26), num(signalPeriod, 9), String(wantSignal) === 'true'), 8),
        qDrawdown: async list => round(math.maxDrawdown(math.toNumbers(list)), 6),
        qStreak: async list => round(math.streak(math.toNumbers(list)), 0),
        qStat: async (list, name) => round(math.statistic(list, name), 6),
        qReturns: async list => math.returns(math.toNumbers(list)).map(value => round(value, 8)),
        qLastDigits: async list => math.lastDigits(math.toNumbers(list)),
        qDigitCounts: async list => math.digitCounts(math.toNumbers(list)),
        qWindow: async (list, count) => math.windowSlice(list, num(count, 100)),
        qChange: async (list, count) => {
            const values = math.windowSlice(list, num(count, 20));
            if (values.length < 2) return 0;
            return round(values[values.length - 1] - values[0], 6);
        },
        qChangePercent: async (list, count) => {
            const values = math.windowSlice(list, num(count, 20));
            if (values.length < 2 || !values[0]) return 0;
            return round(((values[values.length - 1] - values[0]) / Math.abs(values[0])) * 100, 5);
        },
        qDigitOf: async (value, decimals) => {
            const parsed = Number(decimals);
            const dp = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
            return round(math.lastDigitOf(value, dp), 0);
        },
        qRound: async (value, decimals) => round(num(value), clamp(Math.round(num(decimals, 2)), 0, 8)),
        qClamp: async (value, low, high) => round(clamp(value, num(low, 0), num(high, 1)), 8),
        qMap: async (value, inLow, inHigh, outLow, outHigh) =>
            round(math.mapRange(num(value), num(inLow, 0), num(inHigh, 1), num(outLow, 0), num(outHigh, 1)), 6),
        qLerp: async (a, b, t) => round(math.lerp(num(a), num(b), clamp(t, 0, 1)), 6),
        qSeeded: async seed => round(math.seededRandom(num(seed, 1)), 8),
        qPipSize: async () => {
            const ticks = await readTicks();
            if (ticks.length) return math.inferPipSize(ticks);
            const pip = tradeEngine?.getPipSize?.();
            return Number.isFinite(pip) ? pip : 2;
        },

        /* ---------------- market analysis ---------------- */

        mDigitBias: async (list, digit) => {
            const frequencies = math.digitFrequencies(math.toNumbers(list));
            return round(frequencies[clamp(Math.round(num(digit)), 0, 9)] - 10, 3);
        },
        mDigitProbability: async (list, direction, barrier, horizon) => {
            const dir = String(direction || 'over').toLowerCase() === 'under' ? 'under' : 'over';
            return round(math.historicalOverUnder(list, clamp(Math.round(num(barrier)), 0, 9), num(horizon, 5), dir), 3);
        },
        mDigitFrequency: async (list, digit) => {
            const frequencies = math.digitFrequencies(math.toNumbers(list));
            return round(frequencies[clamp(Math.round(num(digit)), 0, 9)], 3);
        },
        mDominantDigit: async list => round(math.dominantDigit(math.toNumbers(list)), 0),
        mDigitSpread: async list => round(math.digitSpread(math.toNumbers(list)), 3),
        mDigitEntropy: async list => round(math.digitEntropy(math.toNumbers(list)), 4),
        mDigitChiSquare: async list => round(math.digitChiSquare(math.toNumbers(list)), 4),
        mDigitStreak: async list => round(math.digitStreak(math.toNumbers(list)), 0),
        mParityRun: async list => round(math.parityRun(math.toNumbers(list)), 0),
        mOverUnderRun: async (list, barrier) => round(math.overUnderRun(math.toNumbers(list), clamp(Math.round(num(barrier)), 0, 9)), 0),
        mEvenShare: async list => round(math.evenShare(math.toNumbers(list)), 3),
        mTransition: async (list, from, to, horizon) => {
            const digits = math.lastDigits(math.toNumbers(list));
            const matrix = math.transitionMatrix(digits, num(horizon, 1));
            const row = math.transitionRow(matrix, clamp(Math.round(num(from)), 0, 9));
            return round((row[clamp(Math.round(num(to)), 0, 9)] || 0) * 100, 3);
        },
        mDistanceToLevel: async (list, step) => round(math.distanceToLevel(list, num(step, 1)), 6),
        /** Count the ticks that actually arrive and remember the rate. */
        mMeasureSpeed: async () => {
            const waitMs = Math.max(500, 2200 * scaleSleep(1));
            const before = await readTicks();
            const beforeLength = before.length;
            const beforeLast = before.length ? before[before.length - 1] : 0;
            await new Promise(resolve => setTimeout(resolve, waitMs));
            const after = await readTicks();
            const growth = after.length > beforeLength ? after.length - beforeLength : 0;
            const moved = after.length && after[after.length - 1] !== beforeLast ? Math.max(growth, 1) : growth;
            const perMinute = (moved / (waitMs / 1000)) * 60;
            if (perMinute > 0) measuredTickRate.set(symbolOf(), round(perMinute, 2));
            return round(measuredTickRate.get(symbolOf()) || 0, 2);
        },

        mTickRate: async () => round(measuredTickRate.get(symbolOf()) || 0, 2),
        mHurst: async list => round(math.hurst(math.toNumbers(list)), 4),

        /* ---------------- risk and money ---------------- */

        rKelly: async (probability, payout) => round(math.kellyFraction(pct(probability) / 100, num(payout, 2)) * 100, 3),
        rStakeStep: async (current, multiplier, maxStake, baseStake, won) => {
            const base = num(baseStake, 0) || num(current, 1);
            const next = Boolean(won) ? base : num(current, base) * Math.max(1, num(multiplier, 2));
            return round(Math.min(next, Math.max(num(maxStake, base), base)), 2);
        },
        rSafeStake: async (stake, maxPercent) => {
            const balance = num(await tradeEngine.getBalance('NUM'), 0);
            const cap = balance * (clamp(pct(maxPercent) / 100, 0, 1) || 0.05);
            return round(Math.max(0.35, Math.min(num(stake, 0.35), cap || num(stake, 0.35))), 2);
        },
        rDrawdownOk: async limit => {
            const stats = memory.getStats();
            return Math.abs(stats.runningProfit || 0) < num(limit, 0) || (stats.runningProfit || 0) > 0;
        },
        rProfitGuard: async target => memory.getStats().runningProfit < num(target, 0),
        rLossGuard: async limit => Math.abs(Math.min(0, memory.getStats().runningProfit || 0)) < num(limit, 0),
        rLossStreak: async () => Math.max(0, -memory.getStats().streak),
        rWinStreak: async () => Math.max(0, memory.getStats().streak),
        rWinRate: async () => round(memory.winRate(), 2),
        rTrades: async () => memory.getStats().trades,
        rCooldown: async seconds => memory.secondsSinceLastTrade() >= num(seconds, 0),
        rSessionSeconds: async () => round(memory.secondsRunning(), 1),
        rBalance: async () => num(await tradeEngine.getBalance('NUM'), 0),

        /* ---------------- shortcuts ---------------- */

        xSpeed: async () => getSpeed(),
        xSpeedIndex: async () => (getSpeed() === 'slow' ? 0 : getSpeed() === 'fast' ? 2 : 1),
        xSpeedFactor: async () => getProfile().sleepFactor,

        xSmartSleep: async seconds => {
            const scaled = scaleSleep(num(seconds, 1));
            await new Promise(resolve => setTimeout(resolve, scaled * 1000));
            return true;
        },

        xWaitTicks: async count => {
            const wanted = Math.max(1, Math.round(scaleTicks(num(count, 1))));
            const start = await readTicks();
            const startLength = start.length;
            const startLast = start.length ? start[start.length - 1] : 0;
            const deadline = Date.now() + Math.max(4, wanted * 30) * 1000;
            // Prefer the tick count; fall back to a quote change when the
            // history window is already full and its length no longer grows.
            let seen = 0;
            while (seen < wanted && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 90));
                const ticks = await readTicks();
                const lastQuote = ticks.length ? ticks[ticks.length - 1] : 0;
                if (ticks.length > startLength) seen = ticks.length - startLength;
                else if (lastQuote !== startLast) seen = Math.max(seen, 1);
            }
            return true;
        },

        xAiShouldBuy: async minEdge => {
            const plan = await getPlan({ minEdge: minEdge ?? undefined });
            return Boolean(plan?.go);
        },

        xAiStake: async (baseStake, risk) => {
            const plan = await getPlan({ risk: risk ?? undefined });
            const base = num(baseStake, 1);
            if (!plan?.best || !plan.go) return round(base * 0.25, 2);
            return round(base * clamp(plan.stakeFactor, 0, 1), 2);
        },

        xAiSignal: async () => {
            const plan = await getPlan();
            if (!plan) return localize('warming up');
            return `${plan.go ? 'TRADE' : 'WAIT'} · ${plan.summary} · ${plan.reason}`;
        },

        /* ---------------- all markets ---------------- */

        /** The market the bot is trading right now. */
        visionMarket: async () => symbolOf(),

        /** Every market the bot may walk through, as a comma separated list. */
        visionMarketList: async () => MARKETS.join(','),

        visionMarketCount: async () => MARKETS.length,

        /** True once this market has enough history behind it to be read. */
        visionMarketReady: async () => (await readTicks()).length >= 80,

        /** Seconds since the bot last changed market. */
        visionMarketSeconds: async () => round(secondsOnMarket(), 1),

        /** 0-100: how worth trading the current market looks right now. */
        visionMarketScore: async () => {
            const plan = await getPlan();
            return scoreMarket(plan);
        },

        /**
         * Move the bot onto a market right now. Accepts a symbol (R_100) or one
         * of the choices: 'random', 'next', 'best'.
         */
        visionSwitchMarket: async symbol => {
            const current = symbolOf();
            const wanted = String(symbol || '').trim();
            if (!wanted) return current;
            return switchToMarket(resolveMarket(wanted, current));
        },

        /** The market the bot would move to for this choice, without moving. */
        visionPickMarket: async mode => resolveMarket(String(mode || '').trim(), symbolOf()),

        /**
         * Let the bot choose its own market.
         *
         * Every market it visits is scored and remembered, so "best" is a real
         * comparison rather than a guess. Modes:
         *   'suitable' — stay while this market scores at or above the floor,
         *                otherwise move to the best market seen so far;
         *   'random'   — jump to any other market once the dwell time is up;
         *   'next'     — walk the list in order;
         *   'best'     — always the best-scoring market seen so far.
         *
         * The dwell time keeps the bot from thrashing the API: it will not
         * change market more often than that, however bad the market looks.
         */
        visionAutoMarket: async (mode, minScore, dwell) => {
            const symbol = symbolOf();
            const wanted = String(mode || 'suitable').toLowerCase();
            const dwellSeconds = Math.max(0, num(dwell, 2));
            const floor = clamp(num(minScore, 0), 0, 100);

            // Score where we are standing, using the decision we already have
            // for this market rather than paying for another one.
            const cached = planCache.get(symbol);
            const score = cached?.plan ? scoreMarket(cached.plan) : 0;
            rememberMarket(symbol, score);

            if (secondsOnMarket() < dwellSeconds) return symbol;

            let target = symbol;
            if (wanted === 'random') target = pickRandom(symbol);
            else if (wanted === 'next') target = pickNext(symbol);
            else if (wanted === 'best') target = pickBestKnown(symbol);
            else if (score < floor) target = pickBestKnown(symbol);
            else return symbol;

            return switchToMarket(target);
        },
    };
};

export default getVisionInterface;
