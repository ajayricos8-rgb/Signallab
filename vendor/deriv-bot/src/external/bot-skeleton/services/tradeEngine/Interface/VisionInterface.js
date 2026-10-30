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
import { DEFAULT_LATENCY, aiBrainReport, forecastReport, labelFidelity, marketDna, priceDecision, reverseEngineerReport } from '../utils/price-strategies.mjs';
import { parityQuotesFresh } from '../utils/parity-quote-safety.mjs';
import { PARITY_FALLBACK_PAYOUT, parityAuditReport, parityBrainReport, parityDecision, parityDna, parityForecastReport, parityLeagueReport, parityReverseReport, scoreParityMarket } from '../utils/parity-strategies.mjs';
import { adaptiveStake, priceRiskAllowed, resolvePriceContext } from '../utils/price-risk.mjs';
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
import { createMarketPicker, scoreMarket, VOLATILITY_MARKETS, DIGIT_MARKETS } from '../utils/vision-markets.mjs';
import {
    ensurePayouts,
    peekPayouts,
    peekTickPayouts,
    payoutSnapshot,
    refreshPayouts,
    refreshTickPayouts,
    tickPayoutSnapshot,
} from '../utils/vision-payouts.js';

const PLAN_REUSE_MS = 15_000;
const DEFAULT_HORIZON = 5;
const DEFAULT_MIN_EDGE = -100; // the block default: significance decides, the value gate is off
const DEFAULT_MIN_CONFIDENCE = 0;
const DEFAULT_MIN_LEAN = 0; // the block default: trade the strongest measured lean
const DEFAULT_RISK = 0.6;
const DEFAULT_TARGET_EDGE = 0.04;
/** Payout a price strategy falls back to before Deriv has quoted this market. */
const DEFAULT_PRICE_PAYOUT = 0.95;

const planCache = new Map();
/** The last decision each market produced, so a thin tick can still be priced. */
const lastPlan = new Map();
/** The last price-path decision, with its reason, per market. */
const lastPrice = new Map();
/**
 * Published price decisions waiting for their expiry tick, per market, and
 * their scorecard.
 *
 * The probability the ensemble reports is a *model* number. Whether the rule
 * that publishes it actually wins is an empirical question, so every decision
 * that reaches "ready" is filed here with the quote it was made on and graded
 * against the tick that settled it. `hit rate` is the only figure in these
 * strategies that is measured rather than inferred, which is why the presets
 * print it in the journal.
 */
const priceLedger = new Map();
const priceCalibration = new Map();
/** The last parity decision, with its reason, per market. */
const lastParity = new Map();
/**
 * Published parity decisions waiting for their settling tick, per market, and
 * their scorecard — the same honest grading as the price ledger, per side, so
 * an even read that keeps missing is shrunk without punishing the odd reads.
 */
const parityLedger = new Map();
const parityCalibration = new Map();
/**
 * The decision that was open when the current position was bought, per
 * market. Learning must score *that* forecast against the outcome — the
 * plan cache has moved on several ticks by settlement, and grading the
 * latest plan instead teaches the experts from forecasts they never made
 * for that expiry.
 */
const entrySnapshot = new Map();
/**
 * Forecasts awaiting their expiry tick, per market. Every forecast the AI
 * makes is scored against the digit that actually prints at its horizon —
 * not just the ones behind a bought contract — so the brain learns from
 * the whole tick stream, on unbiased samples, an order of magnitude
 * faster than trade-only learning ever could.
 */
const forecastLedger = new Map();
/** Last measured ticks-per-minute, per market. */
const measuredTickRate = new Map();
/**
 * Measured round trip of the tick service, per market — the best available
 * stand-in for "how long after the model looked does the order land". It is
 * the API leg of the latency; the engine's own bookkeeping is added on top.
 * Nothing here guesses at the market: if it has never been measured the symbol
 * class default is used, and the decision says so.
 */
const measuredLatency = new Map();
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

/**
 * Seconds per tick from the symbol name, as a fallback only.
 *
 * Deriv's 1-second indices print a tick every second and the continuous
 * indices every two; a market whose rate has been measured is never described
 * by this table. It exists so the execution clock is populated on the very
 * first read instead of waiting for `mMeasureSpeed` to be called.
 */
const TICK_SECONDS = symbol => {
    const name = String(symbol || '').toUpperCase();
    if (name.startsWith('1HZ')) return 1;
    return 2;
};

const getVisionInterface = tradeEngine => {
    const symbolOf = () => tradeEngine?.options?.symbol || tradeEngine?.symbol || 'default';

    const tradeOptions = () => tradeEngine?.tradeOptions || {};

    // Tick quotes arrive as numbers, so a trailing zero cannot be recovered
    // without the exchange's pip_size metadata. Fail closed when absent.
    const parityPipSize = () => {
        try {
            const pip = tradeEngine?.getPipSize?.();
            return Number.isInteger(pip) && pip >= 0 && pip <= 8 ? pip : null;
        } catch { return null; }
    };

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

    /**
     * The ten High/Low Tick quotes for this market, in decision order
     * ([H1..H5, L1..L5]), or null before Deriv has quoted them.
     */
    const tickPayouts = () => {
        const table = peekTickPayouts({ symbol: symbolOf(), currency: tradeOptions().currency || 'USD' });
        if (!table) return null;
        const vector = table.vector;
        return vector.some(value => value > 0) ? vector : null;
    };

    /**
     * A 0–100 read on how worth trading a High/Low Tick market is: measured
     * expected value, the engine's own certainty, the DNA readability, the
     * sample behind the decision and the blend's walk-forward skill. Used by
     * the market scout — it ranks markets, it does not promise profit.
     */
    const scoreTickMarket = (plan, dna) => {
        if (!plan) return 0;
        const ev = Number.isFinite(plan.ev) ? clamp(plan.ev, -0.2, 0.2) : 0;
        const evScore = clamp((ev + 0.05) / 0.15, 0, 1);
        const certainty = clamp(num(plan.certainty, 0) / 100, 0, 1);
        const readability = clamp(num(dna?.readability, 0) / 100, 0, 1);
        const sample = clamp(num(plan.samples, 0) / 600, 0, 1);
        const skill = clamp((50 + 200 * num(plan.skill, 0)) / 100, 0, 1);
        return Math.round(100 * (0.35 * evScore + 0.2 * certainty + 0.15 * readability + 0.15 * sample + 0.15 * skill) * 10) / 10;
    };

    /** The DNA of the market as it stands, reusing the decision's own report. */
    const priceDnaOf = async () => {
        const cached = lastPrice.get(symbolOf())?.dna;
        if (cached) return cached;
        return marketDna(await readTicks(), { horizon: 5 });
    };

    /** The parity DNA of the market as it stands. */
    const parityDnaOf = async () => {
        const cached = lastParity.get(symbolOf())?.dna;
        if (cached) return cached;
        return parityDna(await readTicks(), { pipSize: parityPipSize() });
    };

    const readTicks = async () => {
        const started = Date.now();
        try {
            const ticks = await tradeEngine.getTicks();
            return math.toNumbers(ticks);
        } catch {
            return [];
        } finally {
            // A round trip that timed out is not evidence of a slow market, but
            // it is evidence of a slow path: keep the slower of the two so the
            // clock errs on the side of the bot being late.
            const elapsed = (Date.now() - started) / 1000;
            const symbol = symbolOf();
            if (elapsed > 0 && elapsed < 30) {
                const previous = measuredLatency.get(symbol);
                measuredLatency.set(symbol, previous ? previous * 0.7 + elapsed * 0.3 : elapsed);
            }
        }
    };

    /**
     * The execution clock for this market: seconds per tick (measured if the
     * session has measured it, otherwise the symbol class), the look-to-fill
     * latency, and therefore whether a five-tick contract can honestly be
     * aligned to the window the model scored.
     */
    const tickClock = () => {
        const symbol = symbolOf();
        const rate = num(measuredTickRate.get(symbol), 0);
        const interval = rate > 0 ? clamp(60 / rate, 0.2, 60) : TICK_SECONDS(symbol);
        const latency = Math.max(DEFAULT_LATENCY, num(measuredLatency.get(symbol), 0) + 0.05);
        return { symbol, interval: round(interval, 3), latency: round(latency, 3), ...labelFidelity(interval, latency) };
    };

    /**
     * What a win actually pays on this market, from the proposals Deriv has
     * already sent for the running trade options: `payout / ask − 1`.
     *
     * Proposals belong to a purchase reference; a leftover quote from before a
     * market, duration or stake change must not price the next decision, so
     * anything carrying a different reference is ignored and the caller falls
     * back to its own figure.
     */
    const quotedPayout = contractTypes => {
        const proposals = tradeEngine?.data?.proposals || [];
        const reference =
            typeof tradeEngine?.getPurchaseReference === 'function' ? tradeEngine.getPurchaseReference() : null;
        let best = 0;
        proposals.forEach(proposal => {
            if (!proposal || proposal.error) return;
            if (!contractTypes.includes(proposal.contract_type)) return;
            if (reference && proposal.purchase_reference && proposal.purchase_reference !== reference) return;
            const ask = num(proposal.ask_price, 0);
            const payout = num(proposal.payout, 0);
            if (ask > 0 && payout > ask) best = Math.max(best, payout / ask - 1);
        });
        return best;
    };

    /**
     * Grade every published decision whose expiry tick has now printed.
     *
     * The quote guard is what makes a rolling or restarted tick list harmless:
     * if the remembered index no longer holds the quote the decision was made
     * on, the sample is dropped instead of being scored against another tick.
     */
    const gradePriceForecasts = (symbol, list) => {
        const prices = math.toNumbers(list);
        const ledger = priceLedger.get(symbol) || [];
        const calibration = priceCalibration.get(symbol) || { hits: 0, samples: 0, predicted: 0 };
        // Per-outcome ledger (v6): each outcome is judged on its own claims, so
        // a high-tick-3 read that keeps missing is shrunk without punishing the
        // reads that earned their keep.
        if (!calibration.byOutcome) {
            const cell = () => ({ hits: 0, samples: 0, predicted: 0 });
            calibration.byOutcome = { tick: Array.from({ length: 10 }, cell), dir: [cell(), cell()] };
        }
        const pending = [];
        ledger.forEach(entry => {
            const entryIndex = entry.index + 1;
            // A High/Low Tick contract settles on the five quotes after the
            // decision; a directional one on the quote `horizon` ticks later.
            const exitIndex = entry.mode === 'tick' ? entryIndex + 4 : entryIndex + entry.horizon;
            if (exitIndex >= prices.length) {
                pending.push(entry);
                return;
            }
            if (prices[entry.index] !== entry.lastQuote) return; // history shifted: drop
            let win = false;
            if (entry.mode === 'tick') {
                const window = prices.slice(entryIndex, entryIndex + 5);
                if (window.length < 5) {
                    pending.push(entry);
                    return;
                }
                const target = window[clamp(Math.round(num(entry.tick, 1)), 1, 5) - 1];
                const extreme = entry.side > 0 ? Math.max(...window) : Math.min(...window);
                // A shared extreme is not a win: the contract loses, and the
                // record has to say so or the calibration is flattered.
                win = target === extreme && window.filter(value => value === extreme).length === 1;
            } else {
                const change = prices[exitIndex] - prices[entryIndex];
                // Equality settles as a loss on both sides, so a tie is graded,
                // not dropped.
                win = entry.side > 0 ? change > 0 : change < 0;
            }
            const predicted = Math.max(0, Math.min(1, num(entry.winProbability, 0)));
            calibration.samples += 1;
            calibration.predicted += predicted;
            if (win) calibration.hits += 1;
            const outcome = entry.mode === 'tick'
                ? (entry.side > 0 ? 0 : 5) + clamp(Math.round(num(entry.tick, 1)), 1, 5) - 1
                : (entry.side > 0 ? 0 : 1);
            const lane = entry.mode === 'tick' ? calibration.byOutcome.tick : calibration.byOutcome.dir;
            if (lane && lane[outcome]) {
                lane[outcome].samples += 1;
                lane[outcome].predicted += predicted;
                if (win) lane[outcome].hits += 1;
            }
        });
        priceLedger.set(symbol, pending.slice(-64));
        priceCalibration.set(symbol, calibration);
        const laneReport = lane => lane.map(cell => ({
            hits: cell.hits,
            samples: cell.samples,
            rate: cell.samples ? cell.hits / cell.samples : 0,
            mean: cell.samples ? cell.predicted / cell.samples : 0,
        }));
        return {
            hits: calibration.hits,
            samples: calibration.samples,
            rate: calibration.samples ? calibration.hits / calibration.samples : 0,
            // Mean predicted win probability of the graded decisions: the
            // denominator that turns the record into a reliability ratio
            // (realised / predicted) instead of a comparison with break-even.
            mean: calibration.samples ? calibration.predicted / calibration.samples : 0,
            byOutcomeTick: laneReport(calibration.byOutcome.tick),
            byOutcomeDir: laneReport(calibration.byOutcome.dir),
        };
    };

    /** Remember a decision that reached "ready" so it can be graded later. */
    const filePriceForecast = (symbol, list, result, horizon) => {
        try {
            if (!result?.ready) return;
            const prices = math.toNumbers(list);
            if (!prices.length) return;
            const ledger = priceLedger.get(symbol) || [];
            ledger.push({
                index: prices.length - 1,
                lastQuote: prices[prices.length - 1],
                horizon: Math.max(1, Math.round(num(horizon, DEFAULT_HORIZON))),
                side: result.side,
                // What settles this decision, and what it claimed, so the record
                // can be graded on the contract rather than on a direction.
                mode: result.mode === 'tick' ? 'tick' : 'directional',
                tick: Math.max(0, Math.min(5, Math.round(num(result.tick, 0)))),
                winProbability: num(result.winProbability, 0),
            });
            priceLedger.set(symbol, ledger.slice(-64));
        } catch {
            // Calibration must never be able to break a trading tick.
        }
    };

    const calibrationOf = symbol => {
        const calibration = priceCalibration.get(symbol) || { hits: 0, samples: 0, predicted: 0 };
        return {
            ...calibration,
            rate: calibration.samples ? calibration.hits / calibration.samples : 0,
            mean: calibration.samples ? num(calibration.predicted, 0) / calibration.samples : 0,
        };
    };

    /** Grade hypothetical forecasts at their forecast horizon. These are not
     * actual contract results: execution latency and skipped buys can differ. */
    const gradeParityForecasts = (symbol, list) => {
        const prices = math.toNumbers(list);
        const ledger = parityLedger.get(symbol) || [];
        const calibration = parityCalibration.get(symbol) || { hits: 0, samples: 0, predicted: 0 };
        if (!calibration.byOutcome) {
            const cell = () => ({ hits: 0, samples: 0, predicted: 0 });
            calibration.byOutcome = { even: cell(), odd: cell() };
        }
        const pip = parityPipSize();
        if (pip === null) return { hits: 0, samples: 0, rate: 0, mean: 0, byOutcome: calibration.byOutcome };
        const digits = math.lastDigits(prices, pip);
        const pending = [];
        ledger.forEach(entry => {
            const exitIndex = entry.index + Math.max(1, Math.round(num(entry.forecastHorizon, 5)));
            if (exitIndex >= digits.length) {
                pending.push(entry);
                return;
            }
            if (prices[entry.index] !== entry.lastQuote) return; // history shifted: drop
            const digit = digits[exitIndex];
            if (!Number.isInteger(digit)) return;
            const win = entry.side > 0 ? digit % 2 === 0 : digit % 2 === 1;
            const predicted = Math.max(0, Math.min(1, num(entry.winProbability, 0)));
            calibration.samples += 1;
            calibration.predicted += predicted;
            if (win) calibration.hits += 1;
            const lane = entry.side > 0 ? calibration.byOutcome.even : calibration.byOutcome.odd;
            lane.samples += 1;
            lane.predicted += predicted;
            if (win) lane.hits += 1;
        });
        parityLedger.set(symbol, pending.slice(-64));
        parityCalibration.set(symbol, calibration);
        return {
            hits: calibration.hits,
            samples: calibration.samples,
            rate: calibration.samples ? calibration.hits / calibration.samples : 0,
            mean: calibration.samples ? num(calibration.predicted, 0) / calibration.samples : 0,
            byOutcome: calibration.byOutcome,
        };
    };

    /** Remember a parity decision that reached "model ready" for later grading. */
    const fileParityForecast = (symbol, list, result, duration) => {
        try {
            if (!result?.modelReady) return;
            const prices = math.toNumbers(list);
            if (!prices.length) return;
            const ledger = parityLedger.get(symbol) || [];
            ledger.push({
                index: prices.length - 1,
                lastQuote: prices[prices.length - 1],
                forecastHorizon: Math.max(1, Math.round(num(result.forecastHorizon, duration))),
                side: result.side,
                winProbability: num(result.winProbability, 0),
            });
            parityLedger.set(symbol, ledger.slice(-64));
        } catch {
            // Calibration must never be able to break a trading tick.
        }
    };

    const parityCalibrationOf = symbol => {
        const calibration = parityCalibration.get(symbol) || { hits: 0, samples: 0, predicted: 0 };
        return {
            ...calibration,
            rate: calibration.samples ? calibration.hits / calibration.samples : 0,
            mean: calibration.samples ? num(calibration.predicted, 0) / calibration.samples : 0,
        };
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
        // Horizons arrive expressed as contract durations ("analyse my
        // 5-tick trade"), but a buy's entry tick is the NEXT tick after
        // the purchase — so the expiry digit sits duration+1 ticks past
        // the last tick in hand, not duration. Forecasting the nearer
        // tick grades every h-step expert (Markov pairs, analog replays)
        // against the wrong expiry; analyse for the tick that settles.
        const forecastHorizon = Math.max(1, Math.round(num(overrides.horizon ?? horizonTicks(), DEFAULT_HORIZON))) + 1;
        const plan = ai.planTrade(ticks, {
            horizon: forecastHorizon,
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
        trackForecast(symbol, ticks, plan);
        return applyOverrides(plan, overrides);
    };

    /**
     * Shadow learning bookkeeping: file this forecast away, then grade
     * every earlier forecast whose expiry tick has now printed. The quote
     * guard makes a trimmed or restarted tick history harmless — if the
     * tick at the remembered index is not the tick the forecast was made
     * on, the sample is dropped rather than misgraded.
     */
    const trackForecast = (symbol, ticks, plan) => {
        try {
            if (!plan?.experts || !Array.isArray(plan.digits)) return;
            const ledger = forecastLedger.get(symbol) || [];
            let brain = null;
            const pending = [];
            ledger.forEach(entry => {
                const target = entry.index + entry.horizon;
                if (target >= plan.digits.length) {
                    pending.push(entry);
                    return;
                }
                if (ticks[entry.index] !== entry.lastQuote) return; // history shifted: drop
                brain = ai.learn(brain || memory.loadBrain(symbol), {
                    digit: plan.digits[target],
                    features: entry.features,
                    expertDistributions: entry.experts,
                    shadow: true,
                });
            });
            if (brain) memory.saveBrain(symbol, brain);
            pending.push({
                index: ticks.length - 1,
                lastQuote: ticks[ticks.length - 1],
                horizon: plan.horizon,
                features: plan.features || null,
                experts: Object.entries(plan.experts).map(([name, expert]) => ({
                    name,
                    distribution: expert.distribution,
                })),
            });
            forecastLedger.set(symbol, pending.slice(-64));
        } catch {
            // Learning must never be able to break a trading tick.
        }
    };

    /** Remember the decision about to be bought, for honest grading later. */
    const snapshotEntryPlan = () => {
        const cached = planCache.get(symbolOf());
        if (cached?.plan?.best) entrySnapshot.set(symbolOf(), cached.plan);
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
    /** The parity scout walks all fourteen Even/Odd markets, jumps included. */
    const parityPicker = createMarketPicker({ markets: DIGIT_MARKETS });

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
        refreshTickPayouts({ symbol, currency: tradeOptions().currency || 'USD' });
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
            snapshotEntryPlan();
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

        /**
         * The rule's own graded record: the share of the decisions it published
         * that went on to win, over the contracts that settled. Shadow samples
         * never count here — they were never paid.
         */
        visionRecord: async () => round(((await getPlan())?.hitRate ?? 0) * 100, 2),
        /** How many settled decisions that record is measured on. */
        visionRecordSamples: async () => (await getPlan())?.hitSamples ?? 0,
        /**
         * The calibration factor the record is applying to the estimate: 1 with
         * no record or a record at break-even, above 1 when the record has been
         * earned (up to 1.25), below 1 when it has not (down to 0.35).
         */
        visionCalibration: async () => round((await getPlan())?.calibration ?? 1, 3),

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

            // Grade the forecast that opened this contract (snapshotted at
            // entry), not whatever the plan cache holds by settlement —
            // the cache forecasts a later expiry by then, and grading it
            // would move the expert weights on evidence about a different
            // tick. Fall back to the cache only when no entry was marked.
            const opening = entrySnapshot.get(symbol) || null;
            if (opening) entrySnapshot.delete(symbol);
            const graded = opening || cached?.plan || null;

            const brain = memory.loadBrain(symbol);
            const expertDistributions = Object.entries(graded?.experts || {}).map(([name, expert]) => ({
                name,
                distribution: expert.distribution,
            }));
            const probability = graded?.probability ?? null;
            const won = contract.sell_price != null
                ? Number(contract.sell_price) > Number(contract.buy_price)
                : typeof probability === 'number'
                    ? graded.best
                        ? (graded.best.direction === 'over' ? actual > graded.best.barrier : actual < graded.best.barrier)
                        : false
                    : false;

            const next = ai.learn(brain, {
                digit: actual,
                features: graded?.features || null,
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

        /**
         * The price-path ensemble.
         *
         * The horizon is the *contract's* duration — resolved from Trade options
         * — so what the models replay is what will actually settle. A strategy
         * that cannot be priced (wrong unit, wrong family, tie-prone market the
         * strategy asked for) returns an all-zero plan and records the reason,
         * which `Bot.priceReason()` prints into the journal instead of leaving
         * the operator staring at a bot that "does nothing".
         *
         * The payout comes from the proposals Deriv has already quoted for this
         * market, not from a number typed into a block: `payout / ask − 1` is
         * what a win actually pays, and `1/(1+payout)` is the real break-even
         * the decision has to clear. A strategy's own `payout` figure is only
         * the fallback for the first tick, before the quotes arrive.
         *
         * The plan is [ready, side, tick, probability, tieRate, edge,
         * confidence, agreement, samples, horizon, separation, stderr,
         * breakEven, ev, hitRate, hitSamples, z, outcomeAgreement]. Read it
         * with `priceDecisionPart`; the first four slots are unchanged so old
         * strategies keep working.
         */
        priceDecision: async (list, mode, horizon, threshold, maxTie, minAgreement, minEdge, payout, minConfidence, require, minEv, slip) => {
            const symbol = symbolOf();
            const options = tradeOptions();
            const context = resolvePriceContext(mode, horizon, options, tradeEngine.options);
            const calibration = gradePriceForecasts(symbol, list);
            if (!context.ok) {
                lastPrice.set(symbol, { ready: false, reason: `cannot price this trade: ${context.reason}` });
                return new Array(18).fill(0);
            }
            // High/Low Tick quotes are per contract type, exactly like the two
            // directional ones, so the live payout is read here too instead of
            // trusting the number typed into the block.
            const priced = mode === 'tick' ? ['TICKHIGH', 'TICKLOW'] : ['CALL', 'PUT'];
            const quoted = quotedPayout(priced);
            const assumed = num(payout, DEFAULT_PRICE_PAYOUT);
            const effectivePayout = quoted > 0 ? quoted : assumed;
            /**
             * The ten-outcome pay-out ladder, when Deriv has quoted it.
             *
             * A single payout number prices the tick shown in Trade options and
             * nothing else, so a decision on tick 3 was being compared with the
             * tick-1 quote. When the ladder is known the engine ranks the ten
             * outcomes by expected value instead of by probability, which is
             * the only way a mispriced position can be found at all.
             */
            const ladder = mode === 'tick' ? tickPayouts() : null;
            // The execution clock, measured from this session's own tick service
            // and this market's own rate. It is what turns "five ticks" into a
            // duration a human can picture, and what stops the bot buying a
            // window it cannot be filled inside of.
            const clock = tickClock();
            const result = priceDecision(list, mode === 'tick' ? 'tick' : 'rise', context.horizon, threshold, {
                maxTie: num(maxTie, 0.2),
                minAgreement: num(minAgreement, 0),
                minEdge: num(minEdge, 0),
                minConfidence: num(minConfidence, 0),
                // 'always' keeps the cadence a hedged strategy needs: the best
                // side every readable tick, sized down when the read is thin.
                requireEdge: String(require) !== 'always',
                payout: effectivePayout,
                payouts: ladder || undefined,
                minEv: num(minEv, 0),
                // The contract's five ticks start when Deriv processes the buy,
                // not when the model looked: charge one tick of slip by default.
                entrySlip: num(slip, 1),
                // The rule's own graded record, measured on the decisions it
                // published. This is the one input that is evidence rather
                // than inference — including the per-outcome lane for this
                // contract family, so each outcome is calibrated on its own
                // claims.
                evidence: {
                    hits: calibration.hits,
                    samples: calibration.samples,
                    rate: calibration.rate,
                    mean: calibration.mean,
                    byOutcome: mode === 'tick' ? calibration.byOutcomeTick : calibration.byOutcomeDir,
                },
                interval: clock.interval,
                latency: clock.latency,
            });
            // File before the evidence veto is applied: a bot that stopped
            // publishing would also stop grading, and then it could never
            // demonstrate that the estimates had recovered.
            filePriceForecast(symbol, list, { ...result, mode, ready: result.modelReady }, context.horizon);
            lastPrice.set(symbol, {
                ...result,
                mode,
                payout: effectivePayout,
                payoutLive: quoted > 0,
                ladder,
                dna: mode === 'tick' ? marketDna(list, { horizon: 5 }) : null,
            });
            return [
                result.ready ? 1 : 0,
                result.side,
                result.tick,
                result.probability,
                result.tieRate,
                result.edge,
                result.confidence,
                result.agreement,
                result.samples,
                result.horizon,
                result.separation,
                result.stderr,
                result.breakEven,
                result.ev,
                calibration.rate,
                calibration.samples,
                result.z,
                result.outcomeAgreement,
                // 18, 19: the rule's measured record and the calibration it
                // applied to this estimate — the two numbers that make the
                // difference between "the model says" and "the model has been
                // right".
                Number.isFinite(result.hitRate) ? result.hitRate : 0,
                num(result.calibration, 1),
                // 20..26: the v5 layer — what the chosen contract is quoted at,
                // what it should be quoted at, the tie forecast behind the win
                // probability, the DNA readability of the market, the blend's
                // walk-forward skill, whether the rule's own record says stand
                // down, and how certain the whole thing is.
                num(result.payoutAt, 0),
                num(result.fairPayout, 0),
                num(result.evMargin, 0),
                num(result.tieForecast, 0),
                num(result.dnaScore, 0),
                num(result.skill, 0),
                num(result.standDown, 0),
                num(result.certainty, 0),
                // 28..33: the execution clock. A five-tick contract on a 2 s market
                // lasts ten seconds, the fill can land a fraction of a tick after
                // the quote the model scored, and one buy therefore covers a fifth
                // of the cycle — which is why a High/Low Tick bot always has five
                // positions in flight, not one.
                num(result.intervalSeconds, clock.interval),
                num(result.horizonSeconds, clock.horizon),
                num(result.expectedLag, clock.expectedLag),
                num(result.labelFidelity, clock.fidelity),
                num(result.stakeable, 1),
                num(result.quoted, 0),
                // 34: the one-sigma floor the EV gate actually compares with
                // `ai min ev`. A strategy that prints it is printing the number
                // that stopped it, not the optimistic one that tempted it.
                Number.isFinite(result.evLower) ? num(result.evLower, 0) : 0,
            ];
        },
        priceDecisionPart: async (plan, part) => {
            const index = {
                ready: 0,
                side: 1,
                tick: 2,
                probability: 3,
                tie: 4,
                edge: 5,
                confidence: 6,
                agreement: 7,
                samples: 8,
                horizon: 9,
                separation: 10,
                stderr: 11,
                'break-even': 12,
                ev: 13,
                hitrate: 14,
                hits: 15,
                z: 16,
                'outcome-agreement': 17,
                record: 18,
                evidence: 19,
                quote: 20,
                'fair-quote': 21,
                'ev-margin': 22,
                'tie-forecast': 23,
                'dna-score': 24,
                skill: 25,
                'stand-down': 26,
                certainty: 27,
                interval: 28,
                'horizon-seconds': 29,
                slip: 30,
                fidelity: 31,
                stakeable: 32,
                quoted: 33,
                'ev-lower': 34,
            }[part];
            return Array.isArray(plan) && index !== undefined ? num(plan[index], 0) : 0;
        },
        /** Why the last decision did (or did not) reach an entry, as one line. */
        priceReason: async () => String(lastPrice.get(symbolOf())?.reason || 'no decision yet'),
        /** Percent win probability the last decision measured (0-100). */
        priceProbability: async () => round(num(lastPrice.get(symbolOf())?.probability, 0) * 100, 1),
        /** Confidence 0-100: model agreement, evidence and separation combined. */
        priceConfidence: async () => round(num(lastPrice.get(symbolOf())?.confidence, 0), 1),
        /** Measured tie rate of the contract horizon, as a percentage. */
        priceTieRate: async () => round(num(lastPrice.get(symbolOf())?.tieRate, 0) * 100, 1),
        /** Payout ratio behind the last decision's break-even (0.95 = +95 %). */
        pricePayout: async () => round(num(lastPrice.get(symbolOf())?.payout, 0), 3),
        /**
         * The trade shape the models are pricing, as one line. When a bot will
         * not trade, this proves which contract it thinks it is reading —
         * wrong unit, wrong market or wrong duration is visible here instead of
         * being guessed at.
         */
        priceLayout: async () => {
            const options = tradeOptions();
            const plan = lastPrice.get(symbolOf());
            const unit = String(options.duration_unit || 't');
            return [
                `${symbolOf()}`,
                `${num(options.duration, 0)}${unit}`,
                `stake ${num(options.amount, 0)}`,
                plan?.payoutLive ? `payout ${(num(plan.payout, 0) * 100).toFixed(1)}% (live)` : `payout ${(num(plan?.payout, 0) * 100).toFixed(1)}% (assumed)`,
                `break-even ${(num(plan?.breakEven, 0.5) * 100).toFixed(1)}%`,
                plan ? `horizon ${num(plan.horizon, 0)}` : 'no decision yet',
            ].join(' · ');
        },
        /** Realised hit rate of the published decisions, as a percentage. */
        priceHitRate: async () => {
            const calibration = calibrationOf(symbolOf());
            return calibration.samples ? round((calibration.hits / calibration.samples) * 100, 1) : 0;
        },
        /** How many published decisions have been graded so far. */
        priceHitSamples: async () => calibrationOf(symbolOf()).samples,
        /**
         * The scorecard, as one line for the journal: what the rule actually
         * achieved against what the payout needs. This is the only line in the
         * presets that is measured rather than modelled.
         */
        priceScorecard: async () => {
            const symbol = symbolOf();
            const calibration = calibrationOf(symbol);
            const plan = lastPrice.get(symbol);
            const breakEven = num(plan?.breakEven, 0.5);
            if (!calibration.samples) {
                return `no graded entries yet · break-even ${(breakEven * 100).toFixed(1)}%`;
            }
            const rate = calibration.hits / calibration.samples;
            const edge = (rate - breakEven) * 100;
            return `${(rate * 100).toFixed(1)}% hit over ${calibration.samples} graded · break-even ${(breakEven * 100).toFixed(1)}% · ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pt`;
        },
        /** Per-model mixture weights, for the journal ("which model is talking"). */
        priceModelWeights: async () => {
            const plan = lastPrice.get(symbolOf());
            return (plan?.models || [])
                .slice()
                .sort((left, right) => right.weight - left.weight)
                .map(model => `${model.name} ${Math.round(model.weight * 100)}%`)
                .join(' · ');
        },
        /**
         * Edge-following stake. Kelly-sized from the measured probability and
         * the payout, tenth-scaled by default, capped by the operator's balance
         * percent and by `max stake`, floored at Deriv's minimum, and reduced
         * while the session is losing. A loss never raises the next stake —
         * the size always comes from the next measurement.
         */
        priceStake: async (probability, payout, base, fraction, percent, maxStake) => {
            let balance = 0;
            try {
                balance = num(await tradeEngine.getBalance('NUM'), 0);
            } catch {
                balance = 0; // An unreadable balance must not stop the bot.
            }
            const drawdown = Math.max(0, -num(tradeEngine.sessionProfit, 0));
            return adaptiveStake({
                probability: Number.isFinite(Number(probability)) ? num(probability, 0) : num(lastPrice.get(symbolOf())?.probability, 0),
                payout: num(payout, 0.95),
                base: num(base, 0.35),
                fraction: num(fraction, 0.1),
                balance,
                maxPercent: num(percent, 5),
                maxStake: num(maxStake, 0),
                drawdown,
                minStake: 0.35,
            });
        },
        /**
         * MARKET DNA — the market's measured structure, as one journal line.
         *
         * This is the reverse-engineering layer: tie rates, the grid ratio (how
         * many quote increments a typical tick moves), drift significance,
         * persistence, the chi-square displacement from the fair prior and a
         * 0–100 readability score. It describes; it does not predict.
         */
        priceDna: async () => {
            const dna = await priceDnaOf();
            if (!dna || !dna.windows) return String(dna?.verdict || 'no DNA yet — waiting for ticks');
            return `${dna.summary} · ${dna.verdict}`;
        },
        /** One measured field of the DNA report, for a strategy's own gate. */
        priceDnaPart: async part => {
            const dna = await priceDnaOf();
            if (!dna) return 0;
            const ends = (dna.strictHigh?.[0] || 0) + (dna.strictHigh?.[4] || 0);
            const middle = dna.strictHigh?.[2] || 0;
            const map = {
                score: dna.readability,
                tie: ((dna.tieHigh || 0) + (dna.tieLow || 0)) / 2,
                'tie-high': dna.tieHigh,
                'tie-low': dna.tieLow,
                grid: dna.gridRatio,
                drift: dna.driftZ,
                rho: dna.rho,
                chi: dna.chi,
                windows: dna.windows,
                expansion: dna.expansion,
                ends,
                middle,
                'end-ratio': middle > 0 ? ends / 2 / middle : 0,
                'tie-high-band': dna.tieBandHigh ? dna.tieBandHigh.high - dna.tieBandHigh.low : 0,
                'tie-low-band': dna.tieBandLow ? dna.tieBandLow.high - dna.tieBandLow.low : 0,
                'fair-end': dna.strictHigh?.[0] > 0 ? (1 - dna.strictHigh[0]) / dna.strictHigh[0] : 0,
                'fair-middle': middle > 0 ? (1 - middle) / middle : 0,
                // A categorical field, exposed as a number so a strategy can gate
                // on it without a string comparison: 0 grid, 1 mixed, 2
                // continuous, -1 not measured yet.
                phase: dna.phase === 'grid' ? 0 : dna.phase === 'mixed' ? 1 : dna.phase === 'continuous' ? 2 : -1,
            };
            return typeof map[part] === 'string' ? map[part] : round(num(map[part], 0), 4);
        },
        /**
         * THE EXECUTION CLOCK, as one line.
         *
         * Five ticks is not a duration until you know the market's tick rate.
         * This prints the rate, the resulting contract length, the measured
         * look-to-fill slip in ticks, the fidelity of the labels that slip
         * allows, and how many positions are in flight if the bot keeps one
         * ticket at a time. It is the difference between "five ticks" and
         * "ten seconds, one fifth of the cycle per contract".
         */
        priceClock: async () => {
            const clock = tickClock();
            const plan = lastPrice.get(symbolOf());
            const horizon = num(plan?.horizonSeconds, clock.horizon);
            return [
                `${clock.symbol}`,
                `${clock.interval.toFixed(clock.interval < 1 ? 2 : 0)}s/tick`,
                `contract ${horizon ? `${horizon.toFixed(0)}s` : 'unknown'}`,
                `slip ${clock.expectedLag.toFixed(2)}t`,
                `label fidelity ${(clock.fidelity * 100).toFixed(0)}%`,
                `${clock.concurrent} positions in flight`,
                `one buy covers ${(clock.stakeable * 100).toFixed(0)}% of the cycle`,
            ].join(' · ');
        },
        /** The expert leaderboard: measured skill against the structural anchor. */
        priceLeague: async () => {
            const plan = lastPrice.get(symbolOf());
            if (!plan?.league?.length) return 'no league yet — no decision has been scored';
            return plan.league
                .slice(0, 6)
                .map(
                    (expert, index) =>
                        `${index + 1}. ${expert.name} skill ${(num(expert.skill, 0) * 100).toFixed(0)} ` +
                        `(w ${Math.round(num(expert.weight, 0) * 100)}%, brier ${num(expert.brier, 0).toFixed(3)})`
                )
                .join(' · ');
        },
        /**
         * SELF-AUDIT — the bot holding itself to its own numbers.
         *
         * Walk-forward skill of the blend, the calibration it applied to the
         * estimate, the graded record against the break-even it was paid, the
         * tie forecast against the long-run tie rate, and whether the record
         * warrants standing down. Every figure here is measured, not modelled.
         */
        priceAudit: async () => {
            const plan = lastPrice.get(symbolOf());
            if (!plan) return 'no decision yet';
            const breakEven = num(plan.breakEven, 0.2);
            const graded = num(plan.hitSamples, 0);
            const rate = Number.isFinite(plan.hitRate) ? num(plan.hitRate, 0) : NaN;
            const record = Number.isFinite(rate) && graded
                ? `${(rate * 100).toFixed(1)}% over ${graded} (${rate >= breakEven ? '+' : ''}${((rate - breakEven) * 100).toFixed(1)}pt vs break-even)`
                : graded ? `${graded} graded` : 'no graded decisions yet';
            return [
                `blend skill ${(num(plan.skill, 0) * 100).toFixed(0)}`,
                `certainty ${num(plan.certainty, 0).toFixed(0)}`,
                `calibration ${num(plan.calibration, 1).toFixed(2)}×`,
                `record ${record}`,
                `tie ${(num(plan.tieForecast, 0) * 100).toFixed(1)}% vs ${(num(plan.tieRate, 0) * 100).toFixed(1)}% long-run`,
                `DNA ${num(plan.dnaScore, 0).toFixed(0)}/100`,
                `quotes ${num(plan.quoted, 0)}/10`,
                `label fidelity ${(num(plan.labelFidelity, 0) * 100).toFixed(0)}%`,
                num(plan.standDown, 0) ? 'STAND DOWN — the record is below break-even' : 'clear to trade',
            ].join(' · ');
        },
        /**
         * AI CORE — the internal brain, as one journal line.
         *
         * The deep net's walk-forward training state, the meta-learner's regime
         * call and whether the regime scoreboard is trusted yet, and the three
         * experts carrying the live decision. Everything here is measured on
         * settled windows, never asserted.
         */
        priceBrain: async () => aiBrainReport(lastPrice.get(symbolOf())),
        /**
         * REVERSE ENGINEERING — the DNA v2 diagnosis, as one journal line.
         *
         * Phase, Hurst memory, extreme entropy, jump rate, extreme-phase
         * persistence, tie clustering and compression, plus the auto-tuning the
         * bot derived from them (EV caution, anchor trust). Descriptive, not
         * predictive: it says what kind of market this is.
         */
        priceReverse: async () => reverseEngineerReport(await priceDnaOf()),
        /**
         * FORECAST — the full outcome read, as one journal line.
         *
         * The top outcomes by expected value with their win probabilities and
         * live quotes. The whole scan the EV gate decides on, in one line.
         */
        priceForecast: async () => forecastReport(lastPrice.get(symbolOf())),
        /**
         * The live ten-outcome quote ladder with its fair odds and the measured
         * expected value of each position — the table the EV scan decides on.
         */
        pricePayoutTable: async () => {
            const plan = lastPrice.get(symbolOf());
            const rows = plan?.evTable || [];
            if (!rows.length) return 'no live High/Low Tick ladder yet — using the fallback payout';
            const quoted = rows.filter(row => row.payout > 0);
            if (!quoted.length) return 'the ladder has not been quoted yet — the decision is ranked by probability';
            const best = rows.reduce((winner, row) =>
                Number.isFinite(row.ev) && (!winner || row.ev > winner.ev) ? row : winner, null);
            return rows
                .filter(row => row.payout > 0)
                .map(row => {
                    const marker = best && row.outcome === best.outcome ? '*' : '';
                    return `${row.label}${marker} ${row.payout.toFixed(2)}× (fair ${row.fairPayout.toFixed(2)}×, ` +
                        `p ${(row.probability * 100).toFixed(1)}%, EV ${(row.ev * 100).toFixed(1)}%)`;
                })
                .join(' · ');
        },
        /**
         * The expected value of one named contract at the live quote, or 0 when
         * that position has not been quoted. A strategy can read this to refuse
         * a position the bot would otherwise take.
         */
        priceContractEv: async (side, tick) => {
            const plan = lastPrice.get(symbolOf());
            const s = num(side, 0) >= 0 ? 1 : -1;
            const k = clamp(Math.round(num(tick, 1)), 1, 5);
            const outcome = s > 0 ? k - 1 : 5 + k - 1;
            const row = (plan?.evTable || [])[outcome];
            return row && row.payout > 0 && Number.isFinite(row.ev) ? round(row.ev * 100, 2) : 0;
        },
        /** Fair multiple of one position, from the measured win probability. */
        priceContractFair: async (side, tick) => {
            const plan = lastPrice.get(symbolOf());
            const s = num(side, 0) >= 0 ? 1 : -1;
            const k = clamp(Math.round(num(tick, 1)), 1, 5);
            const outcome = s > 0 ? k - 1 : 5 + k - 1;
            const row = (plan?.evTable || [])[outcome];
            if (!row) return 0;
            return round(num(row.fairPayout, 0), 3);
        },
        /**
         * Let the bot choose which volatility index it stands on.
         *
         * High/Low Ticks are quoted on every synthetic index, and the markets do
         * not pay the same: the ladder, the tie rate and the measured edge all
         * differ. This scores the market the bot is on (expected value, its own
         * certainty, the DNA readability and the sample) and moves when the
         * score falls under the floor — with a dwell time so a session cannot
         * spend its life switching between cold tick streams.
         */
        priceAutoMarket: async (mode, minScore, dwell) => {
            const symbol = symbolOf();
            const plan = lastPrice.get(symbol);
            const dna = plan?.dna || (await priceDnaOf());
            const score = plan ? scoreTickMarket(plan, dna) : 0;
            picker.recordScore(symbol, score);
            const ticks = await readTicks();
            const secondsHere = picker.secondsOnMarket();
            const stuck = secondsHere > Math.max(90, num(dwell, 90) * 2);
            if (ticks.length < 300 && !stuck) return symbol;
            const target = picker.choose({
                mode: String(mode || 'suitable'),
                minScore: num(minScore, 0),
                dwell: num(dwell, 90),
                current: symbol,
                score,
            });
            if (target === symbol) return symbol;
            const moved = await switchToMarket(target);
            if (moved === target) {
                picker.markSwitched();
                refreshTickPayouts({ symbol: moved, currency: tradeOptions().currency || 'USD' });
            }
            return moved;
        },
        /** The score the market scout gives the market the bot is standing on. */
        priceMarketScore: async () => {
            const plan = lastPrice.get(symbolOf());
            const dna = plan?.dna || (await priceDnaOf());
            return round(plan ? scoreTickMarket(plan, dna) : 0, 1);
        },

        /* ---------------- parity (Even/Odd) ----------------
         *
         * The Even/Odd ensemble behind the AI Even Switcher. Sixteen experts
         * forecast P(even) at the settling tick, both sides are priced against
         * the live DIGITEVEN/DIGITODD quotes, and the better expected value
         * wins. Published decisions are graded against the settling tick per
         * side, and the plan is:
         *
         * [ready, side, probability, even-probability, edge, confidence,
         *  agreement, samples, horizon, separation, stderr, record,
         *  calibration, quote, fair-quote, ev-margin, dna-score, skill,
         *  stand-down, certainty, ev-lower, t-stat, break-even, ev,
         *  hit-samples, payout-live]
         *
         * Read it with `parityDecisionPart`.
         */
        parityDecision: async (list, horizon, threshold, require, minEdge, payout, minConfidence, minAgreement, minEv, slip) => {
            const symbol = symbolOf();
            const pipSize = parityPipSize();
            if (pipSize === null) {
                lastParity.set(symbol, { reason: 'waiting for market pip size — cannot safely identify last digits' });
                return [];
            }
            const calibration = gradeParityForecasts(symbol, list);
            // Live Even/Odd quotes first: the payout table's two slots, then
            // the running trade options' own proposals, then the fallback.
            const table = peekPayouts(payoutOptions());
            const quoted = quotedPayout(['DIGITEVEN', 'DIGITODD']);
            const quotedMultiple = quoted > 0 ? quoted + 1 : 0;
            const freshQuotes = parityQuotesFresh(table);
            const liveEven = freshQuotes ? table.even : 0;
            const liveOdd = freshQuotes ? table.odd : 0;
            const assumed = num(payout, PARITY_FALLBACK_PAYOUT) || PARITY_FALLBACK_PAYOUT;
            const duration = clamp(Math.round(num(horizon, 5)) || 5, 1, 10);
            const result = parityDecision(list, duration, num(threshold, 0), {
                pipSize,
                minAgreement: num(minAgreement, 0),
                minEdge: num(minEdge, 0),
                minConfidence: num(minConfidence, 0),
                // 'always' keeps the cadence a switching strategy needs: the
                // better-EV side every readable cycle, sized down when thin.
                requireEdge: String(require) !== 'always',
                payout: assumed,
                payoutEven: liveEven || quotedMultiple || assumed,
                payoutOdd: liveOdd || quotedMultiple || assumed,
                payouts: liveEven || liveOdd ? { even: liveEven, odd: liveOdd } : undefined,
                minEv: num(minEv, 0),
                // The contract's ticks start when Deriv processes the buy, not
                // when the model looked: charge one tick of slip by default.
                entrySlip: num(slip, 1),
                // The rule's own graded record, per side — the one input that
                // is evidence rather than inference.
                evidence: {
                    hits: calibration.hits,
                    samples: calibration.samples,
                    rate: calibration.rate,
                    mean: calibration.mean,
                    byOutcome: calibration.byOutcome,
                },
            });
            // File before the value gate is applied: a bot that stopped
            // publishing would also stop grading, and then it could never
            // demonstrate that the estimates had recovered.
            fileParityForecast(symbol, list, result, duration);
            lastParity.set(symbol, {
                ...result,
                payoutLive: freshQuotes ? 1 : 0,
            });
            return [
                result.ready ? 1 : 0,
                result.side,
                result.probability,
                result.evenProbability,
                result.edge,
                result.confidence,
                result.agreement,
                result.samples,
                result.horizon,
                result.separation,
                result.stderr,
                Number.isFinite(result.hitRate) ? result.hitRate : 0,
                num(result.calibration, 1),
                num(result.payoutAt, 0),
                num(result.fairPayout, 0),
                num(result.evMargin, 0),
                num(result.dnaScore, 0),
                num(result.skill, 0),
                num(result.standDown, 0),
                num(result.certainty, 0),
                Number.isFinite(result.evLower) ? num(result.evLower, 0) : 0,
                num(result.tStat, 0),
                num(result.breakEven, 0.5),
                Number.isFinite(result.ev) ? num(result.ev, 0) : 0,
                num(result.hitSamples, 0),
                freshQuotes ? 1 : 0,
            ];
        },
        parityDecisionPart: async (plan, part) => {
            const index = {
                ready: 0,
                side: 1,
                probability: 2,
                'even-prob': 3,
                edge: 4,
                confidence: 5,
                agreement: 6,
                samples: 7,
                horizon: 8,
                separation: 9,
                stderr: 10,
                record: 11,
                evidence: 12,
                quote: 13,
                'fair-quote': 14,
                'ev-margin': 15,
                'dna-score': 16,
                skill: 17,
                'stand-down': 18,
                certainty: 19,
                'ev-lower': 20,
                't-stat': 21,
                'break-even': 22,
                ev: 23,
                'hit-samples': 24,
                'payout-live': 25,
            }[part];
            return Array.isArray(plan) && index !== undefined ? num(plan[index], 0) : 0;
        },
        /** Why the last parity decision did (or did not) reach an entry. */
        parityReason: async () => String(lastParity.get(symbolOf())?.reason || 'no decision yet'),
        /**
         * What DIGITEVEN and DIGITODD pay on this market right now, as one
         * journal line — and whether Deriv said so or the fallback did.
         */
        parityPayouts: async () => {
            const plan = lastParity.get(symbolOf());
            if (!plan) return 'no quotes yet — no decision has been scored';
            const live = plan.payoutLive ? 'live' : 'modelled';
            return (
                `quotes · EVEN ${num(plan.payoutEven, 0).toFixed(3)}× (fair ${num(plan.evTable?.[0]?.fairPayout, 0).toFixed(3)}×)` +
                ` · ODD ${num(plan.payoutOdd, 0).toFixed(3)}× (fair ${num(plan.evTable?.[1]?.fairPayout, 0).toFixed(3)}×)` +
                ` · ${live}`
            );
        },
        /** PARITY DNA — the digit stream's measured structure, one line. */
        parityDna: async () => {
            const dna = await parityDnaOf();
            if (!dna || !dna.windows) return String(dna?.verdict || 'no DNA yet — waiting for ticks');
            return `${dna.summary} · ${dna.verdict}`;
        },
        /** One measured field of the parity DNA report. */
        parityDnaPart: async part => {
            const dna = await parityDnaOf();
            if (!dna) return 0;
            const phase = { cold: 0, fair: 1, sticky: 2, alternating: 3, mixed: 4, frozen: 5 }[dna.phase] ?? 0;
            const regime = { unknown: 0, fair: 1, sticky: 2, alternating: 3, drifty: 4, frozen: 5 }[dna.regime] ?? 0;
            const fields = {
                score: dna.readability,
                'even-share': dna.evenShare,
                alternation: dna.alternation,
                'runs-z': dna.runsZ,
                'markov-chi': dna.markovChi,
                'digit-chi': dna.digitChi,
                entropy: dna.entropy,
                repeat: dna.repeatRate,
                'longest-run': dna.longestRun,
                warmth: dna.warmth,
                phase,
                regime,
                drift: dna.driftZ,
                ticks: dna.ticks,
            };
            return num(fields[part], 0);
        },
        /** Each expert's measured skill against the fair coin, best first. */
        parityLeague: async () => parityLeagueReport(lastParity.get(symbolOf())),
        /** The bot holding itself to its own numbers. */
        parityAudit: async () => parityAuditReport(lastParity.get(symbolOf())),
        /** The internal brain: nets, regime call, carrying experts. */
        parityBrain: async () => parityBrainReport(lastParity.get(symbolOf())),
        /** The market's deep diagnosis plus the derived auto-tuning. */
        parityReverse: async () => parityReverseReport(await parityDnaOf()),
        /** The full two-sided read: both sides, quotes and EVs. */
        parityForecast: async () => parityForecastReport(lastParity.get(symbolOf())),
        parityStake: async (probability, payout, base, fraction, percent, maxStake) => {
            let balance = 0;
            try {
                balance = num(await tradeEngine.getBalance('NUM'), 0);
            } catch {
                balance = 0; // An unreadable balance must not stop the bot.
            }
            const drawdown = Math.max(0, -num(tradeEngine.sessionProfit, 0));
            return adaptiveStake({
                probability: Number.isFinite(Number(probability)) ? num(probability, 0) : num(lastParity.get(symbolOf())?.probability, 0),
                payout: num(payout, PARITY_FALLBACK_PAYOUT),
                base: num(base, 0.35),
                fraction: num(fraction, 0.1),
                balance,
                maxPercent: num(percent, 5),
                maxStake: num(maxStake, 0),
                drawdown,
                minStake: 0.35,
            });
        },
        /**
         * Let the bot choose which of the fourteen Even/Odd markets it stands
         * on. The markets do not pay the same and do not read the same: this
         * scores the market the bot is on (expected value, certainty, DNA
         * readability, sample, skill) and moves when the score falls under the
         * floor — with a dwell time so a session cannot spend its life
         * switching between cold tick streams.
         */
        parityAutoMarket: async (mode, minScore, dwell) => {
            const symbol = symbolOf();
            const plan = lastParity.get(symbol);
            const dna = plan?.dna || (await parityDnaOf());
            const score = plan ? scoreParityMarket(plan, dna) : 0;
            parityPicker.recordScore(symbol, score);
            const ticks = await readTicks();
            const secondsHere = parityPicker.secondsOnMarket();
            const stuck = secondsHere > Math.max(90, num(dwell, 90) * 2);
            if (ticks.length < 300 && !stuck) return symbol;
            const target = parityPicker.choose({
                mode: String(mode || 'suitable'),
                minScore: num(minScore, 0),
                dwell: num(dwell, 90),
                current: symbol,
                score,
            });
            if (target === symbol) return symbol;
            const moved = await switchToMarket(target);
            if (moved === target) parityPicker.markSwitched();
            return moved;
        },
        /** The score the parity scout gives the market the bot is on. */
        parityMarketScore: async () => {
            const plan = lastParity.get(symbolOf());
            const dna = plan?.dna || (await parityDnaOf());
            return round(plan ? scoreParityMarket(plan, dna) : 0, 1);
        },
        /** Contracts this run has bought, from the engine's own run counter. */
        parityContracts: async () => num(tradeEngine.getTotalRuns?.(), 0),
        parityRisk: async (stake, legs, baseline, loss, target, percent) => {
            let balance;
            try { balance = await tradeEngine.getBalance('NUM'); } catch { return false; }
            // Unlike the shared price risk gate, never override the user's percentage
            // cap merely to reach a presumed minimum stake.
            if (!(Number(stake) * Number(legs) <= Number(balance) * Number(percent) / 100)) return false;
            return priceRiskAllowed({ stake, legs, baseline, loss, target, percent, balance,
                sessionProfit: tradeEngine.sessionProfit, hedgeIncomplete: tradeEngine.hedgeIncomplete });
        },

        /** Contracts this run has bought, from the engine's own run counter. */
        priceTrades: async () => num(tradeEngine.getTotalRuns?.(), 0),
        priceSessionProfit: async () => num(tradeEngine.sessionProfit, 0),
        priceRisk: async (stake, legs, baseline, loss, target, percent) => {
            let balance;
            try { balance = await tradeEngine.getBalance('NUM'); } catch { return false; }
            return priceRiskAllowed({ stake, legs, baseline, loss, target, percent, balance,
                sessionProfit: tradeEngine.sessionProfit, hedgeIncomplete: tradeEngine.hedgeIncomplete });
        },
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
            const go = entryDecision({ plan, last: lastPlan.get(symbolOf()), forceEntry: true }).go;
            if (go) snapshotEntryPlan();
            return go;
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
