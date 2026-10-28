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
import {
    createEntryPacer,
    DEFAULT_ENTRY_GAP_MS,
    entryDecision,
    MIN_TICKS_TO_READ,
    readBarrier,
    readDirection,
    readStake,
    waitingReason,
} from '../utils/vision-entry.mjs';
import { createMarketPicker, scoreMarket, VOLATILITY_MARKETS } from '../utils/vision-markets.mjs';
import { ensurePayouts, peekPayouts, payoutSnapshot, refreshPayouts } from '../utils/vision-payouts.js';

const PLAN_REUSE_MS = 15_000;
const DEFAULT_HORIZON = 5;
const DEFAULT_MIN_EDGE = -100; // the block default: significance decides, the value gate is off
const DEFAULT_MIN_CONFIDENCE = 0;
const DEFAULT_MIN_LEAN = 0; // the block default: trade the strongest measured lean
const DEFAULT_RISK = 0.6;
const DEFAULT_TARGET_EDGE = 0.04;

const planCache = new Map();
/** The last decision each market produced, so a thin tick can still be priced. */
const lastPlan = new Map();
/** Last measured ticks-per-minute, per market. */
const measuredTickRate = new Map();
/**
 * One pacer for the whole session: however many strategies and blocks read it,
 * the bot never opens contracts faster than this. Two seconds is the shipped
 * default — "as often as possible" still has to mean "one position at a time".
 */
const pacer = createEntryPacer({ gapMs: DEFAULT_ENTRY_GAP_MS });

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
     *
     * This used to give up below eighty ticks and return nothing at all, which
     * is a trap on a market the bot just switched to: no plan means no entry,
     * and the tick analysis that switches markets every couple of seconds can
     * keep a session below that floor forever. The engine is perfectly able to
     * read twelve ticks, so twelve is the floor — and below it the last decision
     * this market produced is handed back rather than nothing, so trade options
     * are never built from a missing barrier.
     */
    const getPlan = async (overrides = {}, options = {}) => {
        const symbol = symbolOf();
        const cached = planCache.get(symbol);

        /**
         * One decision per tick, made by the tick command.
         *
         * Only the AI read block rebuilds the plan (`fresh: true`); every other
         * block — the barrier and stake in the trade options, the entry switch
         * in the purchase conditions, the summary in the journal — reads the
         * plan the tick command just made. Rebuilding per block used to let the
         * trade options price a barrier that the purchase conditions had already
         * moved past, and it made every getter pay for the ensemble again.
         */
        if (options.fresh !== true && cached && Date.now() - cached.at < PLAN_REUSE_MS) {
            return applyOverrides(cached.plan, overrides);
        }

        const ticks = await readTicks();
        if (ticks.length < MIN_TICKS_TO_READ) return lastPlan.get(symbol) || null;

        const signature = signatureOf(ticks);

        // Price on whatever table we already have and let the live one land in
        // the background: waiting for twenty proposals is what makes a bot on a
        // two-second market miss the tick it was analysing.
        const payouts = peekPayouts(payoutOptions());
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
        if (plan?.best) lastPlan.set(symbol, plan);
        return applyOverrides(plan, overrides);
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
        const passes =
            plan.best.bias > 0 &&
            (relaxed ||
                (plan.best.rawBias > 0 &&
                    plan.best.tStat >= minLean &&
                    plan.confidence >= minConfidence &&
                    plan.agreementRatio >= minAgreement)) &&
            (!strictValue || plan.best.adjusted >= minEdge / 100);
        // Same rule as the engine: with every bar off the plan is always
        // tradeable, because "trade the strongest thing you can see" cannot mean
        // "sit out whenever that thing is not above the fair odds".
        const forced = Boolean(relaxed && !strictValue && !passes);
        const go = Boolean(passes || forced);
        return {
            ...plan,
            go,
            forced,
            reason: passes ? 'entry confirmed' : forced ? 'no measured lean — trading the safest contract anyway' : plan.reason,
        };
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
     * Every volatility index the bot is allowed to walk through, and the picker
     * that decides which one to stand on. The picker is pure (see
     * vision-markets.mjs) so the choice can be tested without a live engine.
     */
    const MARKETS = VOLATILITY_MARKETS;
    const picker = createMarketPicker({ markets: MARKETS });

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
        picker.markSwitched();
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
            }, { fresh: true });
            if (!plan) {
                const ticks = await readTicks();
                return waitingReason({ ticks: ticks.length, min: MIN_TICKS_TO_READ });
            }
            return plan.summary;
        },

        visionBarrier: async () => readBarrier(await getPlan(), lastPlan.get(symbolOf())),
        visionDirection: async () => readDirection(await getPlan(), lastPlan.get(symbolOf())),
        visionProbability: async () => round(((await getPlan())?.probability ?? 0) * 100, 3),
        visionFair: async () => round(((await getPlan())?.fair ?? 0) * 100, 3),
        visionEdge: async () => round(((await getPlan())?.edge ?? 0) * 100, 3),
        visionBias: async () => round((await getPlan())?.biasPoints ?? 0, 3),
        visionConfidence: async () => round((await getPlan())?.confidence ?? 0, 1),
        visionAgreement: async () => round(((await getPlan())?.agreementRatio ?? 0) * 100, 1),
        visionPayout: async () => round((await getPlan())?.payout ?? 0, 4),
        /**
         * The entry switch. `true` whenever the AI has a contract it is willing
         * to buy; with the bars off that is every tick, because a plan that
         * picks a barrier and then refuses to buy it is the bug this fixes.
         */
        visionGo: async () => {
            const plan = await getPlan();
            return entryDecision({ plan, last: lastPlan.get(symbolOf()), forceEntry: true }).go;
        },
        visionReason: async () => {
            const plan = await getPlan();
            if (!plan) {
                const ticks = await readTicks();
                return waitingReason({ ticks: ticks.length, min: MIN_TICKS_TO_READ });
            }
            return plan.reason;
        },
        visionSummary: async () => {
            const plan = await getPlan();
            if (plan) return plan.summary;
            const ticks = await readTicks();
            return `${waitingReason({ ticks: ticks.length, min: MIN_TICKS_TO_READ })} · buying the neutral Over ${readBarrier(null, null)} until the AI can read this market`;
        },
        visionHorizon: async () => horizonTicks(),

        visionStake: async baseStake => {
            const plan = await getPlan();
            const base = num(baseStake, 1);
            const decision = entryDecision({ plan, last: lastPlan.get(symbolOf()) });
            if (!plan?.best || !decision.go) return readStake(base * 0.25);
            return readStake(base * clamp(plan.stakeFactor, 0.2, 1));
        },

        /* ---------------- entry pacing ---------------- */

        /**
         * May the strategy open a position right now? Defaults to one entry per
         * two seconds, so a bot reading a one-second market still cannot buy a
         * contract per second.
         */
        visionEntryReady: async gapSeconds => {
            if (gapSeconds !== undefined && gapSeconds !== null && String(gapSeconds) !== '') {
                pacer.setGapSeconds(gapSeconds);
            }
            return pacer.ready();
        },

        /** Record that a position was just opened. */
        visionMarkEntry: async () => {
            pacer.mark();
            return true;
        },

        /**
         * Hold the strategy until the pace allows another entry.
         *
         * Call it between settling a contract and asking for the next one: the
         * tick block keeps reading the market while this waits, so the trade
         * options that follow are built from a decision made a moment ago
         * rather than from the one that bought the last contract.
         */
        visionWaitForEntry: async gapSeconds => {
            if (gapSeconds !== undefined && gapSeconds !== null && String(gapSeconds) !== '') {
                pacer.setGapSeconds(gapSeconds);
            }
            const cap = Date.now() + Math.max(1_000, pacer.gapMs + 1_000);
            while (!pacer.ready() && Date.now() < cap) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise(resolve => setTimeout(resolve, 120));
            }
            return true;
        },

        /** Set (and read back) the minimum seconds between entries. */
        visionEntryGap: async gapSeconds => {
            if (gapSeconds !== undefined && gapSeconds !== null && String(gapSeconds) !== '') {
                pacer.setGapSeconds(gapSeconds);
            }
            return round(pacer.gapMs / 1000, 2);
        },

        visionSecondsSinceEntry: async () => round(pacer.waitMs() / 1000, 2),

        /** How many ticks this market has, and whether that is enough to read. */
        visionTicks: async () => (await readTicks()).length,

        visionReady: async () => (await readTicks()).length >= MIN_TICKS_TO_READ,

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
            let balance = 0;
            try {
                balance = num(await tradeEngine.getBalance('NUM'), 0);
            } catch {
                balance = 0; // An unreadable balance must not stop the bot.
            }
            const cap = balance * (clamp(pct(maxPercent) / 100, 0, 1) || 0.05);
            // The 0.35 floor is Deriv's minimum stake: an amount below it is
            // rejected outright, which would silently swallow every entry.
            return round(Math.max(0.35, Math.min(num(stake, 0.35), cap || num(stake, 0.35))), 2);
        },
        rDrawdownOk: async limit => {
            const stats = memory.getStats();
            return Math.abs(stats.runningProfit || 0) < num(limit, 0) || (stats.runningProfit || 0) > 0;
        },
        rProfitGuard: async target => (memory.getStats().runningProfit || 0) < num(target, 0),
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
            return entryDecision({ plan, last: lastPlan.get(symbolOf()), forceEntry: true }).go;
        },

        xAiStake: async (baseStake, risk) => {
            const plan = await getPlan({ risk: risk ?? undefined });
            const base = num(baseStake, 1);
            const decision = entryDecision({ plan, last: lastPlan.get(symbolOf()) });
            if (!plan?.best || !decision.go) return readStake(base * 0.25);
            return readStake(base * clamp(plan.stakeFactor, 0.2, 1));
        },

        xAiSignal: async () => {
            const plan = await getPlan();
            if (!plan) {
                const ticks = await readTicks();
                return `TRADE (neutral) · ${waitingReason({ ticks: ticks.length, min: MIN_TICKS_TO_READ })}`;
            }
            const decision = entryDecision({ plan, last: lastPlan.get(symbolOf()) });
            return `${decision.go ? 'TRADE' : 'WAIT'}${decision.forced ? ' (forced)' : ''} · ${plan.summary} · ${plan.reason}`;
        },

        /* ---------------- all markets ---------------- */

        /** The market the bot is trading right now. */
        visionMarket: async () => symbolOf(),

        /** Every market the bot may walk through, as a comma separated list. */
        visionMarketList: async () => MARKETS.join(','),

        visionMarketCount: async () => MARKETS.length,

        /** True once this market has enough history behind it to be read. */
        visionMarketReady: async () => (await readTicks()).length >= MIN_TICKS_TO_READ,

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
            return switchToMarket(picker.resolve(wanted, current));
        },

        /** The market the bot would move to for this choice, without moving. */
        visionPickMarket: async mode => picker.resolve(String(mode || '').trim(), symbolOf()),

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

            // Score where we are standing, using the decision we already have
            // for this market rather than paying for another one.
            const cached = planCache.get(symbol);
            const score = cached?.plan ? scoreMarket(cached.plan) : 0;
            picker.recordScore(symbol, score);

            /**
             * A market we have not managed to read yet is not a market to
             * compare: leaving it before the first decision means the bot
             * spends a session hopping between streams and never trading on
             * any of them — every switch trades a warm history for a cold one.
             * So the bot stays until this market has produced a readable tick
             * history, or until it is clear the market is never going to (a
             * dead stream should not pin a session either).
             */
            const tickCount = (await readTicks()).length;
            const secondsHere = picker.secondsOnMarket();
            const stuck = secondsHere > Math.max(20, num(dwell, 2) * 4);
            if (tickCount < MIN_TICKS_TO_READ && !stuck) return symbol;

            const target = picker.choose({ mode, minScore, dwell, current: symbol, score });
            if (target === symbol) return symbol;

            const moved = await switchToMarket(target);
            if (moved === target) picker.markSwitched();
            // Never buy on the new market's prices using the old market's plan.
            return moved;
        },

        /** Seconds since the bot last changed market. */
        visionMarketSeconds: async () => round(picker.secondsOnMarket(), 1),
    };
};

export default getVisionInterface;
