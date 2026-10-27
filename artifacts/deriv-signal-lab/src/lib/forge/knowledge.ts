// Layer 8 — THE DERIV KNOWLEDGE BASE.
//
// The forge is only as good as what it is taught, so the teaching material is
// an explicit, versioned, auditable object rather than a set of constants
// scattered across the analyzers. Every entry states one fact about the
// instrument, the contract, the statistics or the execution, and declares HOW
// the forge is allowed to use it:
//
//   feature  — the fact becomes an input the network can condition on
//              (e.g. the market's volatility class, the tick cadence).
//   prior    — the fact sets the no-edge anchor and the shrinkage target the
//              model is regularised toward (the fair rate for this contract).
//   teacher  — the fact says which already-audited layer may teach the model
//              during distillation (the family-weighted engine estimate, the
//              analysis prior, the rolling frequency baseline).
//   veto     — the fact is a hard rule that can only REMOVE conviction:
//              equality loses both Over and Under sides, a flat expiry loses
//              both Rise and Fall sides, an edge inside its own error bar is
//              not a signal, and a contract whose price exceeds fair value
//              cannot be profitable however likely it is.
//   gate     — the fact sets a sample or timing condition the model must meet
//              before it is allowed to speak (purge, minimum holdout, decay).
//
// The registry is deliberately "vast" in the only sense that is honest: it
// keeps growing as a data file, it is complete for the tool's four contract
// families and every market family the app can attach to, and no entry claims
// a guarantee the statistics cannot support. Nothing here is a prediction by
// itself; it is the syllabus the forge is trained against, and every entry is
// printed on the model card so the user can audit what the model was taught.
//
// Pure data + pure helpers: no I/O, no clock, safe in the scan Web Workers.
import type { ForgeFamily } from './types.ts';

/** Version stamp for the syllabus. Bump whenever an entry changes meaning. */
export const FORGE_KNOWLEDGE_VERSION = '2026.10.24';

export type ForgeKnowledgeDomain =
  | 'contract'
  | 'payout'
  | 'feed'
  | 'statistics'
  | 'structure'
  | 'risk'
  | 'execution'
  | 'market';

export type ForgeKnowledgeUse = 'feature' | 'prior' | 'teacher' | 'veto' | 'gate';

export type ForgeKnowledgeEntry = {
  /** Stable id; the training log and the model card both reference it. */
  id: string;
  domain: ForgeKnowledgeDomain;
  title: string;
  /** The fact itself, in one sentence a user can check. */
  statement: string;
  /** How the forge is allowed to apply it. */
  use: ForgeKnowledgeUse;
  /** Contract families this entry applies to. */
  families: readonly ForgeFamily[];
};

const DIGIT: readonly ForgeFamily[] = ['digit'];
const QUOTE: readonly ForgeFamily[] = ['rise-fall'];
const BOTH: readonly ForgeFamily[] = ['digit', 'rise-fall'];

/**
 * The syllabus. Ordered by domain so the generated card reads as a curriculum:
 * what the instrument is, what the contract pays, what the feed can tell us,
 * what may be inferred, what must never be inferred, when to enter, and which
 * market you are on.
 */
export const FORGE_KNOWLEDGE: readonly ForgeKnowledgeEntry[] = [
  /* ---------------------------------------------------------------- contract */
  {
    id: 'contract.matches-strict',
    domain: 'contract',
    title: 'Matches is an exact-terminal-digit contract',
    statement: 'Matches wins only when the terminal digit equals the chosen target under the strict contract; it is not "at least one match during the contract".',
    use: 'prior',
    families: DIGIT,
  },
  {
    id: 'contract.even-odd-zero',
    domain: 'contract',
    title: 'Even/Odd counts zero as even',
    statement: 'Even/Odd wins on the terminal digit\'s parity, and zero is even, so the no-edge rate is one half under uniform digits.',
    use: 'prior',
    families: DIGIT,
  },
  {
    id: 'contract.over-under-strict',
    domain: 'contract',
    title: 'Over/Under equality loses both sides',
    statement: 'Over b wins only when the terminal digit is strictly greater than b and Under b only when strictly less, so equality is a loss on both sides and the fair rate is (9 − b)/10 or b/10.',
    use: 'veto',
    families: DIGIT,
  },
  {
    id: 'contract.rise-fall-strict',
    domain: 'contract',
    title: 'Rise/Fall is a strict quote comparison',
    statement: 'Rise wins when the terminal quote is strictly above the entry quote and Fall when strictly below; a flat expiry loses both directions, so the fair rate is half the non-flat outcome mass.',
    use: 'prior',
    families: QUOTE,
  },
  {
    id: 'contract.horizon-settles',
    domain: 'contract',
    title: 'The contract settles on the exit tick, not the next tick',
    statement: 'Every forecast in the tool is a question about the digit or quote at origin + horizon, so a next-tick model cannot be reused for a 5-tick contract without re-pricing it.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'contract.digit-domain',
    domain: 'contract',
    title: 'Digits are a ten-class outcome',
    statement: 'A digit forecast is a distribution over exactly ten classes; any probability that is not on that simplex is a bug, not a signal.',
    use: 'gate',
    families: DIGIT,
  },
  {
    id: 'contract.barrier-domain',
    domain: 'contract',
    title: 'Over/Under barriers span 0…9',
    statement: 'The traded barrier is a single digit, and the research domain that is priced with usable mass is barriers 1–8 (0 and 9 have degenerate fair rates).',
    use: 'prior',
    families: DIGIT,
  },
  {
    id: 'contract.allow-equals-off',
    domain: 'contract',
    title: 'Allow-equals is a different contract',
    statement: 'Deriv offers "allow equals" separately; these tools price the strict contract, so an allow-equals payout must never be compared to a strict fair rate.',
    use: 'veto',
    families: BOTH,
  },

  /* ------------------------------------------------------------------ payout */
  {
    id: 'payout.includes-stake',
    domain: 'payout',
    title: 'Quoted payout includes the stake',
    statement: 'Break-even probability is ask / payout, because the quoted total payout returns the stake as well; a 90% "win rate" on a cheap contract can still lose money.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'payout.expected-value',
    domain: 'payout',
    title: 'A probability is not a profit',
    statement: 'Estimated net value per trade is p × payout − ask, so a real edge must exceed the spread the provider charges, not merely exceed the fair rate.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'payout.margin-requirement',
    domain: 'payout',
    title: 'A margin over break-even is required',
    statement: 'The bot demands at least a half-point of probability above break-even (and a live proposal) before it will buy, so a forge probability must be reported against that same cost, not against 50%.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'payout.payout-unavailable',
    domain: 'payout',
    title: 'Missing payout data blocks execution',
    statement: 'When the live proposal is missing or non-finite the tools refuse an automatic purchase rather than assuming an edge.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'payout.stake-discipline',
    domain: 'payout',
    title: 'Stake is a risk decision, not a signal decision',
    statement: 'No probability in this app may raise the stake; sizing stays with the user\'s configured stake and the bot\'s risk module.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'payout.martingale-refused',
    domain: 'payout',
    title: 'Loss recovery is not a model',
    statement: 'Doubling after a loss changes the distribution of outcomes without changing the expected value; the forge never consumes stake history as a feature.',
    use: 'veto',
    families: BOTH,
  },

  /* -------------------------------------------------------------------- feed */
  {
    id: 'feed.digit-precision',
    domain: 'feed',
    title: 'Keep the feed\'s verified digit precision',
    statement: 'The terminal digit is read from the verified pip size; a digit inferred from an arbitrarily formatted quote is not the traded digit.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'feed.chronological',
    domain: 'feed',
    title: 'Ticks are chronological, unique and gap-aware',
    statement: 'Rows are sorted by epoch and de-duplicated before any statistic is computed, and irregular gaps are measured rather than smoothed away.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'feed.tick-cadence',
    domain: 'feed',
    title: 'Tick cadence turns ticks into wall clock',
    statement: 'A one-tick window is worth the market\'s measured median tick spacing, so a window must be converted with the cadence of the market it was measured on.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'feed.staleness',
    domain: 'feed',
    title: 'A stale analysis is not a signal',
    statement: 'Snapshots older than fifteen minutes, or built on a frozen feed, are refused by the bot regardless of their probability.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'feed.one-second-variants',
    domain: 'feed',
    title: 'One-second indices are a different cadence',
    statement: 'Indices with a one-second tick print roughly sixty times more rows per minute, so a "5 ticks" duration on them is not comparable to a five-tick duration on a two-second index.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'feed.sample-maturity',
    domain: 'feed',
    title: 'Maturity scales with the usable sample',
    statement: 'Data quality grows with the number of valid ticks, their freshness and the stability of the structure test; a thin stream lowers every claim, including the forge\'s.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'feed.no-fabricated-digit',
    domain: 'feed',
    title: 'Never invent a missing observation',
    statement: 'A missing digit is dropped, never imputed from neighbours, because imputation manufactures exactly the serial dependence the tools are testing for.',
    use: 'veto',
    families: DIGIT,
  },

  /* -------------------------------------------------------------- statistics */
  {
    id: 'stats.chronological-split',
    domain: 'statistics',
    title: 'Train on the past, score on the future',
    statement: 'Every fitted layer is split chronologically into train / validation / holdout with a purge gap, and the holdout is scored once.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'stats.purge-overlap',
    domain: 'statistics',
    title: 'Purge the rows that straddle a boundary',
    statement: 'A row whose feature window or label reaches across a split boundary leaks the future into training, so it is dropped on both sides of the gap.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'stats.overlap-correction',
    domain: 'statistics',
    title: 'Overlapping rows are not independent evidence',
    statement: 'A five-tick contract replayed every two ticks reuses three of its five outcome increments, so the effective sample is discounted by the reuse factor.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'stats.brier-skill',
    domain: 'statistics',
    title: 'Score against the no-edge rate, not the class average',
    statement: 'Brier and log-loss skill are measured against the same fair probability the contract is priced on (uniform digits, a coin flip for direction), so "predict the historical average" is not skill.',
    use: 'teacher',
    families: BOTH,
  },
  {
    id: 'stats.paired-z',
    domain: 'statistics',
    title: 'A positive skill must clear its own noise',
    statement: 'The per-row Brier improvement is tested with a paired z; a model needs z ≥ 2 on at least 60 unseen rows before it carries any weight.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'stats.calibration',
    domain: 'statistics',
    title: 'Calibration is a separate question from discrimination',
    statement: 'A temperature or isotonic correction is fitted on a slice the model did not train on, and reliability is reported next to Brier loss because the two measure different failures.',
    use: 'teacher',
    families: BOTH,
  },
  {
    id: 'stats.multiple-comparisons',
    domain: 'statistics',
    title: 'Many tests produce false positives',
    statement: 'The analysis engines apply a Bonferroni correction for the number of simultaneous tests, and the cross-market scan discounts the best-of-pool z by the expected maximum.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'stats.selection-bias',
    domain: 'statistics',
    title: 'The winner of a scan is a selection',
    statement: 'Reporting the strongest of thirteen markets and sixteen contracts is a selection; the measured edge must be shrunk by the expected maximum before it is published.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'stats.wilson-interval',
    domain: 'statistics',
    title: 'Rate estimates carry Wilson intervals',
    statement: 'A hit rate on a handful of non-overlapping outcomes is reported with its Wilson interval, and a lower bound below the fair rate is not evidence of an edge.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'stats.min-expected-counts',
    domain: 'statistics',
    title: 'Chi-square needs mass in every cell',
    statement: 'Digit uniformity is tested only with at least fifty observations, and transition independence requires every retained expected cell to be at least five.',
    use: 'gate',
    families: DIGIT,
  },
  {
    id: 'stats.null-not-proof',
    domain: 'statistics',
    title: 'Failing to reject is not proof of randomness',
    statement: 'A runs test that does not fire cannot certify fairness; the tools report "no measured structure", not "provably random".',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'stats.distillation',
    domain: 'statistics',
    title: 'Learn from audited teachers, not only from raw outcomes',
    statement: 'With a few hundred binary outcomes per contract, fitting on hard labels alone is high variance; mixing the label with an audited teacher\'s probability reduces that variance without inventing new information.',
    use: 'teacher',
    families: BOTH,
  },
  {
    id: 'stats.no-leakage',
    domain: 'statistics',
    title: 'The holdout may not choose anything',
    statement: 'Weights, thresholds, temperatures and feature choices are all fixed before the holdout is scored; a search that peeks at the holdout is a fit, not a measurement.',
    use: 'gate',
    families: BOTH,
  },

  /* --------------------------------------------------------------- structure */
  {
    id: 'structure.uniformity',
    domain: 'structure',
    title: 'Digit uniformity is the first question',
    statement: 'A digit market is measured for uniformity before any conditioning; when the ten classes match uniform, a digit bias must come from somewhere else or not at all.',
    use: 'feature',
    families: DIGIT,
  },
  {
    id: 'structure.transitions',
    domain: 'structure',
    title: 'Serial dependence requires a transition test',
    statement: 'Transition independence compares the observed digit-pair table to the product of its margins, so a repeating pair is only structure when the table says so.',
    use: 'feature',
    families: DIGIT,
  },
  {
    id: 'structure.conditional-entropy',
    domain: 'structure',
    title: 'Conditional entropy measures memory',
    statement: 'The entropy of the next digit given the last one, relative to the marginal entropy, is a direct measure of how much the past could inform the exit digit.',
    use: 'feature',
    families: DIGIT,
  },
  {
    id: 'structure.parity-runs',
    domain: 'structure',
    title: 'Parity runs test alternation, not continuation',
    statement: 'The runs test counts alternations in the even/odd sequence; a long streak is not by itself continuation or reversal evidence.',
    use: 'feature',
    families: DIGIT,
  },
  {
    id: 'structure.gap-hazard',
    domain: 'structure',
    title: 'A long-absent digit is censored, not "due"',
    statement: 'Gap ages are censored at the sample start and shrunk toward a prior; the longest-missing digit does not become more likely because it is missing.',
    use: 'veto',
    families: DIGIT,
  },
  {
    id: 'structure.trend-vs-reversion',
    domain: 'structure',
    title: 'Trend and mean reversion are opposite regimes',
    statement: 'A Hurst exponent above 0.55 with a variance ratio above one points to persistence; Hurst below 0.45 with a low variance ratio points to reversion; near 0.5 the path is a random walk.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'structure.autocorrelation',
    domain: 'structure',
    title: 'Autocorrelation is dependence, not profit',
    statement: 'A Ljung–Box rejection shows returns are not white noise; it does not show that a tradable edge survives the spread.',
    use: 'veto',
    families: QUOTE,
  },
  {
    id: 'structure.volatility-regime',
    domain: 'structure',
    title: 'Volatility regime scales every distance',
    statement: 'Pullback depths, breakout heights and standard errors are all in units of local volatility; comparing them across regimes without rescaling is meaningless.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'structure.level-reversion',
    domain: 'structure',
    title: 'Level reversion needs a unit-root test',
    statement: 'A level-reversion forecast is only offered after a level-KPSS diagnostic on 500+ ticks; otherwise the fitted equilibrium is a coincidence of the sample.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'structure.structural-break',
    domain: 'structure',
    title: 'A break invalidates a fitted regime',
    statement: 'CUSUM and regime-shift tests flag the moments a market\'s behaviour changes; a signal measured before a break is not evidence after it.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'structure.flat-rate',
    domain: 'structure',
    title: 'Flat expiries widen the fair rate\'s uncertainty',
    statement: 'The share of unchanged expiries is measured, not assumed; it lowers both sides\' fair rate and raises the variance of every direction estimate.',
    use: 'feature',
    families: QUOTE,
  },

  /* -------------------------------------------------------------------- risk */
  {
    id: 'risk.edge-inside-error',
    domain: 'risk',
    title: 'An edge inside its error bar is not a signal',
    statement: 'When the published edge is smaller than its own measured standard error the call is WEAK regardless of how many engines agree.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'risk.correlated-sources',
    domain: 'risk',
    title: 'Correlated sources share one vote',
    statement: 'Engines fitted on the same rows, and models fitted on those engines\' outputs, carry a family credit so the same evidence is never counted twice.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'risk.unvalidated-is-inert',
    domain: 'risk',
    title: 'An unvalidated model has no vote',
    statement: 'A model that has not beaten the no-edge rate out of sample is reported but cannot raise a probability or a confidence score.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'risk.asymmetry',
    domain: 'risk',
    title: 'Unvalidated evidence may only subtract',
    statement: 'When an unvalidated layer disagrees materially it may lower the published number; when it agrees it may not raise it. The forge is stricter still: below its own gate it carries no vote at all, in either direction, because it is fitted once per candidate in a scan of dozens and the expected maximum of that search is not a measurement. That asymmetry is what keeps selection honest.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'risk.conviction-cap',
    domain: 'risk',
    title: 'Conviction is capped by the verdict',
    statement: 'A no-edge call can never advertise high conviction and a speculative call is capped below a decisive one, so conviction cannot outrun the measurement.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'risk.one-signal',
    domain: 'risk',
    title: 'Run Analysis always ends in one ranked signal',
    statement: 'The best candidate is always published so the bot can load and run it; the honesty lives in the verdict, never in withholding the analysis.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'risk.no-auto-entry',
    domain: 'risk',
    title: 'No model places an order on its own',
    statement: 'The forge can rank, explain, trim and veto a call; execution stays behind the configured bot switch and the live proposal check.',
    use: 'veto',
    families: BOTH,
  },

  /* --------------------------------------------------------------- execution */
  {
    id: 'execution.validity-window',
    domain: 'execution',
    title: 'An edge decays; the window is measured',
    statement: 'Replaying each signal with a delayed entry measures how fast the edge decays, and the entry is never allowed to wait longer than the last lag that still clears fair odds.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'execution.entry-context',
    domain: 'execution',
    title: 'Digit entries are a tick context, not a price',
    statement: 'A digit contract settles on the exit tick\'s digit, so its entry point is the context digit printed before the entry tick, validated on the newer rows.',
    use: 'feature',
    families: DIGIT,
  },
  {
    id: 'execution.entry-excursion',
    domain: 'execution',
    title: 'Quote entries are measured excursions',
    statement: 'Pullback and breakout levels are percentiles of the excursions replayed signals actually printed before expiry, and a trigger is only offered when it beat buying at the signal on newer rows.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'execution.no-chase',
    domain: 'execution',
    title: 'Do not chase a missed entry',
    statement: 'A quote that trades beyond the plan\'s tolerance is a missed entry, not a better one; re-running the analysis is the only correct response.',
    use: 'veto',
    families: BOTH,
  },
  {
    id: 'execution.tick-window',
    domain: 'execution',
    title: 'Window outranks patience',
    statement: 'The entry window is the stricter of the measured validity and the plan\'s own cap, so no configuration can extend a window the data did not support.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'execution.rebase',
    domain: 'execution',
    title: 'Re-base relative levels, keep absolute ones',
    statement: 'Excursion levels move with the quote; equilibrium-anchored levels stay put. Mixing the two erases the stretch the level was measured on.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'execution.snapshot-replacement',
    domain: 'execution',
    title: 'A newer analysis replaces an older one',
    statement: 'Two analyses of the same market are not additive evidence; the newest snapshot is the only one the bot may act on.',
    use: 'gate',
    families: BOTH,
  },

  /* ------------------------------------------------------------------ market */
  {
    id: 'market.synthetic-indices',
    domain: 'market',
    title: 'Synthetic indices are generated, 24/7',
    statement: 'Deriv synthetic indices are algorithmically generated continuous streams with no session close, so there is no overnight gap or session-open effect to model.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'market.volatility-class',
    domain: 'market',
    title: 'The index number is the volatility class',
    statement: 'Volatility 10/25/50/75/100/250 differ in the size of their typical tick move, which scales every excursion, barrier and error bar.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'market.hourly-variants',
    domain: 'market',
    title: '1HZ variants tick once per second',
    statement: 'The 1HZ family prints one tick per second by design, which sets both the expected cadence and the wall-clock value of a multi-tick duration.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'market.crash-boom',
    domain: 'market',
    title: 'Crash/Boom are jump processes, not diffusions',
    statement: 'Crash and Boom indices drift steadily and spike against the drift at random; a Hurst/variance-ratio read on them measures the jump process, so their direction contracts need the jump regime reported.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'market.step-index',
    domain: 'market',
    title: 'Step indices move in fixed increments',
    statement: 'Step indices move by a constant increment per tick, so a rise/fall contract is a question about the sign of a discrete step sequence rather than of a diffusion.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'market.jump-indices',
    domain: 'market',
    title: 'Jump indices mix a base move with a rare jump',
    statement: 'Jump indices carry a directional base with occasional large jumps, which makes the flat rate and the tail behaviour materially different from the volatility family.',
    use: 'feature',
    families: QUOTE,
  },
  {
    id: 'market.digit-uniformity-prior',
    domain: 'market',
    title: 'Synthetic digits start from a fair prior',
    statement: 'The generating process for the synthetic indices is built to be fair, so the default position for every digit contract is its fair rate until the market\'s own data shows otherwise out of sample.',
    use: 'prior',
    families: DIGIT,
  },
  {
    id: 'market.cross-market-independence',
    domain: 'market',
    title: 'Markets are analysed independently, then ranked',
    statement: 'Each market is fitted on its own stream; the scan ranks the results, and the ranking is charged a selection penalty for the number of markets compared.',
    use: 'gate',
    families: BOTH,
  },
  {
    id: 'market.symbol-family',
    domain: 'market',
    title: 'The symbol names the market family',
    statement: 'R_10…R_250 are volatility indices, 1HZ… are one-second variants, BOOM/CRASH and STEP and JD/JD100 are jump processes; the family sets the priors the forge conditions on.',
    use: 'feature',
    families: BOTH,
  },
  {
    id: 'market.no-external-fundamentals',
    domain: 'market',
    title: 'There are no fundamentals to read',
    statement: 'Synthetic indices have no earnings, news or order book available to this app, so no feature may claim a fundamental cause; every input is price, digit or time.',
    use: 'veto',
    families: BOTH,
  },
];

/* -------------------------------------------------------------------------- */
/* Market atlas: the taxonomy the market features are derived from            */
/* -------------------------------------------------------------------------- */

export type ForgeMarketClass = 'volatility' | 'volatility-1s' | 'jump' | 'step' | 'crash-boom' | 'basket' | 'unknown';

export type ForgeMarketProfile = {
  /** Symbol as the Deriv feed names it, e.g. R_100. */
  symbol: string;
  name: string;
  kind: ForgeMarketClass;
  /** Volatility class parsed from the name (1 for the 1HZ family by cadence). */
  volatilityClass: number | null;
  /** Expected milliseconds between ticks for this family. */
  expectedTickMs: number;
  /** Contract families this market is priced for without special caveats. */
  suitedTo: readonly ForgeFamily[];
  /** One line of instrument knowledge shown on the model card. */
  note: string;
};

const VOLATILITY_CLASSES = [10, 25, 50, 75, 100, 250] as const;

function volatilityProfile(symbol: string, name: string, oneSecond: boolean): ForgeMarketProfile {
  const match = /(\d+)/.exec(name) ?? /(\d+)/.exec(symbol);
  const index = match ? Number(match[1]) : null;
  const parsed = VOLATILITY_CLASSES.find((value) => value === index) ?? index;
  return {
    symbol,
    name,
    kind: oneSecond ? 'volatility-1s' : 'volatility',
    volatilityClass: parsed,
    expectedTickMs: oneSecond ? 1_000 : 2_000,
    suitedTo: BOTH,
    note: oneSecond
      ? `${name} prints one tick every second, so a tick duration is a second and a multi-tick contract is a short wall-clock window.`
      : `${name} ticks about every two seconds with a volatility class of ${parsed ?? 'unknown'}, which scales every excursion and error bar on the tool.`,
  };
}

/**
 * The atlas the app can attach to. It is intentionally a data table: adding a
 * market is adding a row, and `marketProfile` degrades gracefully to a parsed
 * profile for any symbol that is not listed, so a new Deriv market never turns
 * the analysis into an error.
 */
export const FORGE_MARKET_ATLAS: readonly ForgeMarketProfile[] = [
  ...VOLATILITY_CLASSES.flatMap((value) => [
    volatilityProfile(`R_${value}`, `Volatility ${value}`, false),
    volatilityProfile(`1HZ${value}V`, `Volatility ${value} (1s)`, true),
  ]),
  {
    symbol: 'BOOM500',
    name: 'Boom 500',
    kind: 'crash-boom',
    volatilityClass: 500,
    expectedTickMs: 1_000,
    suitedTo: QUOTE,
    note: 'Boom 500 drifts down and spikes up at random; the direction call is a jump-process question, so the flat rate and the tail dominate the estimate.',
  },
  {
    symbol: 'BOOM1000',
    name: 'Boom 1000',
    kind: 'crash-boom',
    volatilityClass: 1_000,
    expectedTickMs: 1_000,
    suitedTo: QUOTE,
    note: 'Boom 1000 drifts down with rarer, larger upward spikes; the level-reversion read is unreliable between spikes.',
  },
  {
    symbol: 'CRASH500',
    name: 'Crash 500',
    kind: 'crash-boom',
    volatilityClass: 500,
    expectedTickMs: 1_000,
    suitedTo: QUOTE,
    note: 'Crash 500 drifts up and spikes down at random; a Rise read must survive the jump regime, not just the drift.',
  },
  {
    symbol: 'CRASH1000',
    name: 'Crash 1000',
    kind: 'crash-boom',
    volatilityClass: 1_000,
    expectedTickMs: 1_000,
    suitedTo: QUOTE,
    note: 'Crash 1000 drifts up with rarer, larger downward spikes; a long window spans more jump risk than a short one.',
  },
  {
    symbol: 'stpRNG',
    name: 'Step Index',
    kind: 'step',
    volatilityClass: null,
    expectedTickMs: 2_000,
    suitedTo: QUOTE,
    note: 'Step Index moves in fixed increments, so the tick sequence is discrete and the flat rate is structurally different from the volatility family.',
  },
  {
    symbol: 'JD10',
    name: 'Jump 10',
    kind: 'jump',
    volatilityClass: 10,
    expectedTickMs: 2_000,
    suitedTo: QUOTE,
    note: 'Jump 10 mixes a small base move with occasional jumps; the variance-ratio read is dominated by the jump component.',
  },
  {
    symbol: 'JD100',
    name: 'Jump 100',
    kind: 'jump',
    volatilityClass: 100,
    expectedTickMs: 2_000,
    suitedTo: QUOTE,
    note: 'Jump 100 carries a larger volatility class with the same jump structure, so its excursions scale with the base move, not the jump.',
  },
];

const parsedProfiles = new Map<string, ForgeMarketProfile>(
  FORGE_MARKET_ATLAS.map((profile) => [profile.symbol.toUpperCase(), profile]),
);

/**
 * Instrument knowledge for a symbol. Falls back to a parsed profile so an
 * unlisted market is described honestly (unknown class, default cadence)
 * instead of being silently treated as Volatility 100.
 */
export function marketProfile(symbol: string | null | undefined, name?: string | null): ForgeMarketProfile {
  const key = (symbol ?? '').toUpperCase();
  const listed = parsedProfiles.get(key);
  if (listed) return listed;
  const label = name && name.trim() ? name : symbol && symbol.trim() ? symbol : 'Unknown market';
  const upper = `${key} ${label.toUpperCase()}`;
  const oneSecond = upper.includes('1HZ') || upper.includes('1S') || upper.includes('ONE SECOND');
  const jump = upper.includes('JUMP') || /^JD\d*/u.test(key);
  const step = upper.includes('STEP') || key.startsWith('STPRNG');
  const crashBoom = upper.includes('BOOM') || upper.includes('CRASH');
  const basket = upper.includes('BASKET');
  const kind: ForgeMarketClass = crashBoom
    ? 'crash-boom'
    : step
      ? 'step'
      : jump
        ? 'jump'
        : basket
          ? 'basket'
          : oneSecond
            ? 'volatility-1s'
            : upper.includes('VOLATILITY') || /^R_\d+/u.test(key) || /^1HZ/u.test(key)
              ? 'volatility'
              : 'unknown';
  const match = /(\d+)/.exec(label) ?? /(\d+)/.exec(key);
  const volatilityClass = kind === 'volatility' || kind === 'volatility-1s' || kind === 'jump' || kind === 'crash-boom'
    ? (match ? Number(match[1]) : null)
    : null;
  return {
    symbol: key || 'UNKNOWN',
    name: label,
    kind,
    volatilityClass,
    expectedTickMs: oneSecond || crashBoom ? 1_000 : 2_000,
    suitedTo: kind === 'volatility' || kind === 'volatility-1s' ? BOTH : QUOTE,
    note: kind === 'unknown'
      ? `${label} is not in the instrument atlas, so the market features fall back to the feed's own measured cadence and no instrument-specific prior is applied.`
      : `${label} is classified as ${kind} from the symbol; the classification sets the cadence prior and the structural caveats the forge conditions on.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Curriculum + summary                                                       */
/* -------------------------------------------------------------------------- */

/** Entries that apply to a contract family, in syllabus order. */
export function knowledgeFor(family: ForgeFamily): ForgeKnowledgeEntry[] {
  return FORGE_KNOWLEDGE.filter((entry) => entry.families.includes(family));
}

/** Entries of one use, for the gates and priors the trainer applies. */
export function knowledgeByUse(family: ForgeFamily, use: ForgeKnowledgeUse): ForgeKnowledgeEntry[] {
  return knowledgeFor(family).filter((entry) => entry.use === use);
}

export type ForgeKnowledgeSummary = {
  version: string;
  family: ForgeFamily;
  /** Entries taught for this family. */
  total: number;
  byDomain: Array<{ domain: ForgeKnowledgeDomain; count: number }>;
  byUse: Array<{ use: ForgeKnowledgeUse; count: number }>;
  /** The entries that can only remove conviction, listed on the card. */
  vetoes: string[];
  /** The entries that set the anchor or the shrinkage target. */
  priors: string[];
};

export function summarizeKnowledge(family: ForgeFamily): ForgeKnowledgeSummary {
  const entries = knowledgeFor(family);
  const domains: ForgeKnowledgeDomain[] = ['contract', 'payout', 'feed', 'statistics', 'structure', 'risk', 'execution', 'market'];
  const uses: ForgeKnowledgeUse[] = ['feature', 'prior', 'teacher', 'veto', 'gate'];
  return {
    version: FORGE_KNOWLEDGE_VERSION,
    family,
    total: entries.length,
    byDomain: domains.map((domain) => ({ domain, count: entries.filter((entry) => entry.domain === domain).length })),
    byUse: uses.map((use) => ({ use, count: entries.filter((entry) => entry.use === use).length })),
    vetoes: entries.filter((entry) => entry.use === 'veto').map((entry) => entry.statement),
    priors: entries.filter((entry) => entry.use === 'prior').map((entry) => entry.statement),
  };
}

/**
 * The anchor a forecast is shrunk toward before any evidence: the contract's
 * fair rate. This is the prior half of the knowledge base — the syllabus says
 * the synthetic feeds start fair, so the model must earn every point above it.
 */
export function knowledgeAnchor(fair: number): number {
  if (!Number.isFinite(fair)) return 0.5;
  return Math.max(0.001, Math.min(0.999, fair));
}

/**
 * Prior pull toward the anchor, in probability units. Applied to the teacher
 * targets during distillation so a thin contract cannot drift far from fair on
 * a handful of rows: with 60 rows the pull is ~4 points, with 600 it is under
 * half a point.
 */
export function knowledgeShrinkagePoints(rows: number): number {
  const sample = Math.max(0, Number.isFinite(rows) ? rows : 0);
  return 0.05 * (60 / (60 + sample));
}
