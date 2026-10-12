import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock3,
  Database,
  Play,
  Radio,
  ShieldAlert,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import {
  analyzeDigits,
  evaluateHistoricalContract,
  supportedTickDurations,
  type DigitAnalysis,
  type DigitContractCandidate,
  type HistoricalContractOutcomes,
} from '@/lib/digit-analysis';
import { analyzePriceContext } from '@/lib/price-context';
import { useDerivDigitFeed, type DigitContractSupport } from '@/hooks/use-deriv-digit-feed';

type DigitFamily = 'over-under' | 'even-odd' | 'matches';
type Feed = ReturnType<typeof useDerivDigitFeed>;
type RankedCandidate = {
  contract: DigitContractCandidate;
  outcomes: HistoricalContractOutcomes;
  baseline: HistoricalContractOutcomes;
  label: string;
};
type DigitScanSnapshot = {
  ranAt: number;
  symbol: string;
  selectedDuration: number | null;
  latestDigit: number | null;
  analysis: DigitAnalysis;
  freshAtRun: boolean;
  candidate: RankedCandidate | null;
  candidates: RankedCandidate[];
  reason: string;
};

const DIGITS = Array.from({ length: 10 }, (_, digit) => digit);
const MINIMUM_DIGIT_TICKS = 500;
const MINIMUM_CONDITIONAL_OUTCOMES = 100;
const FAMILY_CONTRACTS: Record<DigitFamily, string[]> = {
  'over-under': ['DIGITOVER', 'DIGITUNDER'],
  'even-odd': ['DIGITEVEN', 'DIGITODD'],
  matches: ['DIGITMATCH'],
};
const FAMILY_DETAILS: Record<DigitFamily, { title: string; eyebrow: string; description: string; empty: string }> = {
  'over-under': {
    title: 'Over/Under digit research',
    eyebrow: 'DIGITOVER · DIGITUNDER',
    description: 'Choose a tick expiry reported by Deriv. The engine compares only Deriv-reported barriers, applies strict greater-than / less-than settlement rules, and selects the research barrier automatically.',
    empty: 'No contract-and-barrier combination has enough validated evidence at this expiry to rank yet.',
  },
  'even-odd': {
    title: 'Even/Odd digit research',
    eyebrow: 'DIGITEVEN · DIGITODD',
    description: 'Choose a tick expiry reported by Deriv. Even and Odd are compared using historical outcomes conditioned on the current digit parity. Zero is even; both sides use actual final digits.',
    empty: 'No parity combination has enough validated evidence at this expiry to rank yet.',
  },
  matches: {
    title: 'Matches digit research',
    eyebrow: 'DIGITMATCH',
    description: 'Choose a tick expiry reported by Deriv. When DIGITMATCH is supported, the engine ranks the full valid final-digit domain from 0 through 9—including zero—using outcomes conditioned on the current final digit.',
    empty: 'No target digit has enough validated evidence at this expiry to rank yet.',
  },
};

function candidateLabel(candidate: DigitContractCandidate): string {
  if (candidate.family === 'over-under') return `${candidate.contractType === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${candidate.barrier}`;
  if (candidate.family === 'even-odd') return candidate.contractType === 'DIGITEVEN' ? 'EVEN' : 'ODD';
  return `MATCH ${candidate.targetDigit}`;
}

function contractDisplayLabel(candidate: DigitContractCandidate): string {
  return candidate.family === 'over-under' ? `${candidateLabel(candidate)} · strict barrier` : candidateLabel(candidate);
}

function familySupports(feed: Feed, contractType: string): DigitContractSupport[] {
  return feed.contracts.filter((contract) => contract.contractType === contractType && contract.expiryType.toLowerCase() === 'tick');
}

function conditionalContext(family: DigitFamily, latestDigit: number | null): { digit?: number; parity?: 0 | 1 } | null {
  if (latestDigit === null) return null;
  if (family === 'even-odd') return { parity: (latestDigit % 2) as 0 | 1 };
  return { digit: latestDigit };
}

function runResearchRanking(
  family: DigitFamily,
  feed: Feed,
  analysis: DigitAnalysis,
  selectedDuration: number | null,
): { candidates: RankedCandidate[]; reason: string } {
  const latestDigit = analysis.lastDigit;
  if (!feed.selectedMarket) return { candidates: [], reason: 'No selected symbol metadata is available.' };
  if (!feed.contractsLoaded) return { candidates: [], reason: 'Waiting for Deriv to verify the selected symbol’s available contracts.' };
  if (!feed.historyLoaded || feed.ticks.length < MINIMUM_DIGIT_TICKS) {
    return { candidates: [], reason: `At least ${MINIMUM_DIGIT_TICKS} validated digit ticks are required.` };
  }
  if (!feed.fresh) return { candidates: [], reason: 'Live tick freshness is not confirmed; this scan is not eligible.' };
  if (feed.precisionError || feed.selectedMarket.precision === null) {
    return { candidates: [], reason: feed.precisionError || 'Verified decimal precision is unavailable.' };
  }
  if (feed.selectedMarket.tradingSuspended === true) return { candidates: [], reason: 'Deriv reports that trading is suspended for this symbol.' };
  if (feed.selectedMarket.exchangeOpen === false) return { candidates: [], reason: 'Deriv reports that the selected market is closed.' };
  if (latestDigit === null) return { candidates: [], reason: 'No validated final digit is available.' };
  if (selectedDuration === null) return { candidates: [], reason: 'Choose a tick expiry reported by Deriv; the engine does not infer a duration.' };
  if (!Number.isInteger(selectedDuration) || selectedDuration < 1) {
    return { candidates: [], reason: 'The selected tick expiry is invalid.' };
  }

  const context = conditionalContext(family, latestDigit);
  if (!context) return { candidates: [], reason: 'The current digit context is unavailable.' };
  const supportedContracts = FAMILY_CONTRACTS[family].flatMap((contractType) => familySupports(feed, contractType));
  if (!supportedContracts.length) return { candidates: [], reason: 'Deriv did not report the required digit contract for this symbol.' };
  const supportsAtDuration = supportedContracts.filter((support) =>
    supportedTickDurations(support.minDuration, support.maxDuration).includes(selectedDuration),
  );
  if (!supportsAtDuration.length) {
    return { candidates: [], reason: `Deriv did not report ${selectedDuration} ticks as a supported expiry for this contract family.` };
  }

  const ranked: RankedCandidate[] = [];
  const addCandidate = (contract: DigitContractCandidate, support: DigitContractSupport) => {
    if (!supportedTickDurations(support.minDuration, support.maxDuration).includes(selectedDuration)) return;
    const outcomes = evaluateHistoricalContract(feed.ticks, contract, selectedDuration, context);
    const baseline = evaluateHistoricalContract(feed.ticks, contract, selectedDuration);
    if (outcomes.sample < MINIMUM_CONDITIONAL_OUTCOMES || outcomes.smoothedHistoricalHitRate === null || baseline.empiricalHitRate === null) return;
    ranked.push({ contract, outcomes, baseline, label: candidateLabel(contract) });
  };

  if (family === 'over-under') {
    for (const contractType of FAMILY_CONTRACTS[family]) {
      for (const support of supportsAtDuration.filter((item) => item.contractType === contractType)) {
        for (const barrier of support.barriers) {
          if (!Number.isInteger(barrier) || barrier < 0 || barrier > 9) continue;
          if (contractType === 'DIGITOVER' && barrier >= 9) continue;
          if (contractType === 'DIGITUNDER' && barrier <= 0) continue;
          addCandidate({ family, contractType: contractType as 'DIGITOVER' | 'DIGITUNDER', barrier }, support);
        }
      }
    }
  } else if (family === 'even-odd') {
    for (const contractType of FAMILY_CONTRACTS[family]) {
      for (const support of supportsAtDuration.filter((item) => item.contractType === contractType)) {
        addCandidate({ family, contractType: contractType as 'DIGITEVEN' | 'DIGITODD' }, support);
      }
    }
  } else {
    for (const support of supportsAtDuration.filter((item) => item.contractType === 'DIGITMATCH')) {
      for (const targetDigit of support.targets) {
        if (!Number.isInteger(targetDigit) || targetDigit < 0 || targetDigit > 9) continue;
        addCandidate({ family, contractType: 'DIGITMATCH', targetDigit }, support);
      }
    }
  }

  const uniqueRanked = [...new Map(ranked.map((candidate) => {
    const contract = candidate.contract;
    const discriminator = contract.family === 'over-under'
      ? `${contract.contractType}:${contract.barrier}`
      : contract.family === 'matches'
        ? `${contract.contractType}:${contract.targetDigit}`
        : contract.contractType;
    return [`${contract.family}:${discriminator}:${candidate.outcomes.durationTicks}`, candidate];
  })).values()];
  uniqueRanked.sort((left, right) => {
    const rateDifference = (right.outcomes.smoothedHistoricalHitRate ?? -Infinity) - (left.outcomes.smoothedHistoricalHitRate ?? -Infinity);
    return rateDifference || right.outcomes.sample - left.outcomes.sample || left.label.localeCompare(right.label);
  });
  if (!uniqueRanked.length) {
    if (family === 'over-under' && !supportsAtDuration.some((support) => support.barriers.length > 0)) {
      return { candidates: [], reason: 'Deriv did not provide a verifiable barrier list for this expiry; the engine will not guess barrier limits.' };
    }
    if (family === 'matches' && !supportsAtDuration.some((support) => support.targets.length > 0)) {
      return { candidates: [], reason: 'The valid Matches target-digit domain could not be verified for this contract response.' };
    }
    return { candidates: [], reason: `No candidate had ${MINIMUM_CONDITIONAL_OUTCOMES} conditional historical outcomes at ${selectedDuration} ticks.` };
  }
  return { candidates: uniqueRanked, reason: '' };
}

function formatQuote(value: number | undefined, precision: number | null): string {
  if (value === undefined || !Number.isFinite(value) || precision === null) return '—';
  return value.toFixed(precision);
}

function formatRate(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatInterval(interval: { lower: number; upper: number } | null): string {
  return interval ? `${formatRate(interval.lower)}–${formatRate(interval.upper)}` : '—';
}

function formatDifference(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const points = value * 100;
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} pp`;
}

function formatMetric(value: number | null, decimalPlaces = 3): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(decimalPlaces);
}

function formatIndicator(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : Number(value.toPrecision(5)).toString();
}

function feedStatusLabel(feed: Feed): string {
  if (feed.status === 'live') return feed.fresh ? 'Live · fresh' : 'Live · stale';
  if (feed.status === 'connecting') return 'Connecting to Deriv';
  if (feed.status === 'loading') return 'Loading verified market data';
  if (feed.status === 'reconnecting') return 'Reconnecting';
  return 'Feed error';
}

function FeedStatusBadge({ feed }: { feed: Feed }) {
  const live = feed.status === 'live' && feed.fresh;
  const error = feed.status === 'error' || Boolean(feed.feedError);
  const tone = live
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
    : error
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-500';
  return (
    <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${tone}`} aria-live="polite" data-testid="digit-feed-status">
      {live ? <Wifi size={14} /> : error ? <WifiOff size={14} /> : <Radio size={14} className={feed.status === 'connecting' || feed.status === 'reconnecting' ? 'animate-pulse-line' : ''} />}
      {feedStatusLabel(feed)}
    </div>
  );
}

function SymbolPicker({ feed, family }: { feed: Feed; family: DigitFamily }) {
  return (
    <label className="block min-w-0">
      <span className="eyebrow">Market · Deriv active symbols</span>
      <select
        value={feed.selectedSymbol}
        onChange={(event) => feed.setSelectedSymbol(event.target.value)}
        disabled={!feed.symbols.length}
        className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-semibold text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={`Choose market for ${family} analysis`}
        data-testid={`${family}-symbol-select`}
      >
        {!feed.symbols.length && <option value="">Loading available markets…</option>}
        {feed.symbols.map((symbol) => (
          <option key={symbol.symbol} value={symbol.symbol}>
            {symbol.name} · {symbol.symbol}{symbol.precision === null ? ' · digit precision unavailable' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function DigitFrequencyPanel({ analysis }: { analysis: DigitAnalysis }) {
  const window1000 = analysis.windows.find((window) => window.window === 1_000)!;
  const currentRow = analysis.lastDigit === null ? null : analysis.transitionProbabilities[analysis.lastDigit];
  const currentCounts = analysis.lastDigit === null ? null : analysis.transitionCounts[analysis.lastDigit];
  const currentTransitionSample = currentCounts?.reduce((sum, count) => sum + count, 0) ?? 0;
  const currentParity = analysis.lastDigit === null ? null : analysis.lastDigit % 2;
  const parityCounts = currentParity === null ? null : analysis.parityTransitions[currentParity];
  const parityTransitionSample = parityCounts?.reduce((sum, count) => sum + count, 0) ?? 0;
  const nextDigits = currentRow && currentTransitionSample > 0
    ? currentRow.map((probability, digit) => ({ probability, digit, count: currentCounts?.[digit] ?? 0 })).filter((item) => item.probability !== null).sort((left, right) => (right.probability ?? 0) - (left.probability ?? 0)).slice(0, 3)
    : [];

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="digit-frequency-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow">Shared digit engine</div><h3 className="mt-1 text-sm font-bold">All ten final digits</h3><p className="mt-1 text-[11px] text-muted-foreground">Validated observations only · rolling features use the latest 1,000 digits.</p></div>
        <div className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">N <span className="mono ml-1 font-semibold text-foreground">{analysis.sampleSize}</span></div>
      </div>
      <div className="mt-4 space-y-2.5">
        {DIGITS.map((digit) => {
          const count = analysis.digitCounts[digit];
          const rate = analysis.digitFrequencies[digit];
          const weighted = analysis.weightedFrequencies[digit];
          const gap = window1000.gapsSinceAppearance[digit];
          const width = rate === null ? 0 : rate * 100;
          return (
            <div key={digit} className="grid grid-cols-[22px_52px_38px_minmax(0,1fr)_74px] items-center gap-2 text-[10px]" data-testid={`digit-frequency-${digit}`}>
              <span className="mono font-bold">{digit}</span>
              <span className="mono text-muted-foreground">{count} · {formatRate(rate)}</span>
              <span className="mono text-muted-foreground" title="Ticks since last appearance in the current rolling window">{gap === null ? 'gap —' : `gap ${gap}`}</span>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} /></div>
              <span className="mono text-right text-muted-foreground">EW {formatRate(weighted)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
        <div><div className="eyebrow">Entropy</div><div className="mono mt-1 text-xs font-semibold">{analysis.entropyBits === null ? '—' : `${analysis.entropyBits.toFixed(3)} bits`} <span className="text-[9px] text-muted-foreground">/ 3.322 max</span></div></div>
        <div><div className="eyebrow">Parity count</div><div className="mono mt-1 text-xs font-semibold">Even {analysis.parityCounts[0]} · Odd {analysis.parityCounts[1]}</div></div>
        <div><div className="eyebrow">Current runs</div><div className="mono mt-1 text-xs font-semibold">Digit {analysis.currentDigitRun} · parity {analysis.currentParityRun}</div></div>
        <div><div className="eyebrow">Observed parity transitions</div><div className="mono mt-1 text-[10px] font-semibold">{parityTransitionSample ? `from ${currentParity === 0 ? 'even' : 'odd'} · E ${formatRate(parityCounts![0] / parityTransitionSample)} · O ${formatRate(parityCounts![1] / parityTransitionSample)} (n=${parityTransitionSample})` : '—'}</div></div>
      </div>
      <div className="mt-4 rounded-lg border border-border bg-background/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-xs font-semibold">Rolling distribution and parity</div><div className="mt-0.5 text-[9px] text-muted-foreground">Window comparisons overlap and are descriptive, not independent samples.</div></div><span className="mono text-[9px] text-muted-foreground">LAST DIGIT {analysis.lastDigit ?? '—'}</span></div>
        <div className="mt-2 space-y-1.5">
          {analysis.windows.filter((window) => [50, 100, 500, 1_000].includes(window.window)).map((window) => (
            <div key={window.window} className="grid grid-cols-[64px_48px_minmax(0,1fr)_auto] items-center gap-2 text-[10px]">
              <span>{window.window} ticks</span><span className="mono text-muted-foreground">n={window.sample}</span><span className="mono text-muted-foreground">H {window.normalizedEntropy === null ? '—' : window.normalizedEntropy.toFixed(2)}</span><span className="mono text-right">E {formatRate(window.evenRate)} · O {formatRate(window.oddRate)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-border bg-background/30 p-3">
        <div className="text-xs font-semibold">Observed transitions from current digit</div>
        <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground">{currentTransitionSample ? `${currentTransitionSample} historical transitions out of digit ${analysis.lastDigit}; Laplace-smoothed row estimates are shown only as descriptive statistics.` : 'No preceding transitions from the current digit are present.'}</p>
        {nextDigits.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{nextDigits.map(({ digit, probability, count }) => <span key={digit} className="rounded-md border border-border px-2 py-1 text-[10px]"><span className="mono font-semibold">→ {digit}</span><span className="ml-2 text-muted-foreground">{count} · {formatRate(probability)}</span></span>)}</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground"><span>Most frequent: {analysis.mostFrequentDigit ?? '—'}</span><span>Least observed: {analysis.leastObservedDigit ?? '—'}</span><span>All digits 0–9 remain in the distribution.</span></div>
    </section>
  );
}


function PriceContextPanel({ feed, analysis }: { feed: Feed; analysis: ReturnType<typeof analyzePriceContext> }) {
  const precision = feed.selectedMarket?.precision ?? null;
  const asOf = analysis.asOfEpoch === null ? '—' : new Date(analysis.asOfEpoch * 1_000).toLocaleTimeString();
  const priceMetrics = [
    { label: 'EMA 9', value: formatQuote(analysis.ema9 ?? undefined, precision) },
    { label: 'EMA 21', value: formatQuote(analysis.ema21 ?? undefined, precision) },
    { label: 'EMA 50', value: formatQuote(analysis.ema50 ?? undefined, precision) },
    { label: 'RSI 14', value: analysis.rsi14 === null ? '—' : `${formatMetric(analysis.rsi14, 1)} / 100` },
    { label: 'ROC · 14 ticks', value: analysis.roc14Percent === null ? '—' : `${formatMetric(analysis.roc14Percent, 3)}%` },
    { label: 'Log-return volatility · 50 ticks', value: analysis.realizedVolatility50Percent === null ? '—' : `${formatMetric(analysis.realizedVolatility50Percent, 4)}%` },
  ];

  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid="price-context-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="eyebrow">Separate evidence family · price only</div><h3 className="mt-1 text-sm font-bold">Tick-price technical context</h3><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Calculated from validated quotes in the latest 1,000 ticks; this context is not used to rank or predict digit outcomes.</p></div>
        <div className="rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-[10px] text-muted-foreground">N <span className="mono ml-1 font-semibold text-foreground">{analysis.sampleSize}</span><span className="ml-2">as of {asOf}</span></div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {priceMetrics.map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">{label}</div><div className="mono mt-1 text-xs font-semibold">{value}</div></div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_1fr_1.4fr]">
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">MACD · 12 / 26 / 9</div><div className="mono mt-1 text-[10px] font-semibold">Line {formatIndicator(analysis.macdLine)} · Signal {formatIndicator(analysis.macdSignal)} · Hist {formatIndicator(analysis.macdHistogram)}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Confirmed tick swings · 3-tick pivot</div><div className="mt-1 text-[10px] font-semibold">{analysis.swingStructure}</div></div>
        <div className="rounded-lg border border-border bg-background/30 px-3 py-2"><div className="eyebrow">Interpretation limits</div><div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Tick-indexed context only; no candle OHLC, traded-volume confirmation, formal primary/secondary Dow trend, ATR or ADX. It cannot justify a specific final digit.</div></div>
      </div>
    </section>
  );
}

function HistoricalRanking({ family, candidates }: { family: DigitFamily; candidates: RankedCandidate[] }) {
  const rows = family === 'matches'
    ? (() => {
      const latestDuration = candidates[0]?.outcomes.durationTicks;
      return candidates.filter((candidate) => candidate.outcomes.durationTicks === latestDuration).slice(0, 10);
    })()
    : candidates.slice(0, 8);
  return (
    <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5" data-testid={`${family}-candidate-ranking`}>
      <div><div className="eyebrow">Historical candidate ranking</div><h3 className="mt-1 text-sm font-bold">{family === 'matches' ? 'Target digits · selected expiry' : family === 'even-odd' ? 'Parity · selected expiry' : 'Barriers · selected expiry'}</h3><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Sorted by smoothed current-context hit rate at the selected expiry. The all-history baseline and in-sample difference are separate; this is not a calibrated or payout-adjusted forecast.</p></div>
      {rows.length ? (
        <div className="mt-3 space-y-2">
          {rows.map((candidate, index) => (
            <div key={`${candidate.outcomes.durationTicks}-${candidate.label}-${index}`} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2 ${index === 0 ? 'border-primary/25 bg-primary/5' : 'border-border bg-background/25'}`}>
              <div className="min-w-0"><div className="truncate text-[11px] font-semibold">{candidate.label} <span className="text-muted-foreground">· {candidate.outcomes.durationTicks} ticks</span></div><div className="mt-0.5 text-[9px] text-muted-foreground">{candidate.outcomes.hits} / {candidate.outcomes.sample} conditioned · baseline {formatRate(candidate.baseline.empiricalHitRate)} · Δ {formatDifference(candidate.outcomes.empiricalHitRate === null || candidate.baseline.empiricalHitRate === null ? null : candidate.outcomes.empiricalHitRate - candidate.baseline.empiricalHitRate)}{candidate.outcomes.barrierEqual ? ` · ${candidate.outcomes.barrierEqual} exact-barrier losses` : ''}</div></div>
              <div className="text-right"><div className="eyebrow">Observed</div><div className="mono text-xs font-semibold">{formatRate(candidate.outcomes.empiricalHitRate)}</div><div className="eyebrow mt-1">Nominal 95% range</div><div className="mono text-[9px] text-muted-foreground">{formatInterval(candidate.outcomes.wilson95)}</div></div>
            </div>
          ))}
        </div>
      ) : <div className="mt-4 rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">No qualified ranking is available yet.</div>}
    </section>
  );
}

function DigitContractTool({ family }: { family: DigitFamily }) {
  const feed = useDerivDigitFeed();
  const [snapshot, setSnapshot] = useState<DigitScanSnapshot | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const latestTick = feed.ticks.at(-1) ?? null;
  const currentAnalysis = analyzeDigits(feed.ticks);
  const currentPriceContext = analyzePriceContext(feed.ticks);
  const familyDetails = FAMILY_DETAILS[family];
  const relevantContracts = feed.contracts.filter((contract) => FAMILY_CONTRACTS[family].includes(contract.contractType));
  const availableDurations = [...new Set(relevantContracts
    .filter((contract) => contract.expiryType.toLowerCase() === 'tick')
    .flatMap((contract) => supportedTickDurations(contract.minDuration, contract.maxDuration)))].sort((left, right) => left - right);
  const supportedDurationCount = availableDurations.length;

  useEffect(() => {
    setSnapshot(null);
    setSelectedDuration(null);
  }, [feed.selectedSymbol]);

  useEffect(() => {
    setSnapshot(null);
  }, [selectedDuration]);

  function handleRunAnalysis() {
    if (isScanning) return;
    setIsScanning(true);
    window.setTimeout(() => {
      const analysis = analyzeDigits(feed.ticks);
      const ranking = runResearchRanking(family, feed, analysis, selectedDuration);
      const blockingReason = !feed.selectedMarket
        ? 'No selected market metadata is available.'
        : feed.precisionError
          ? feed.precisionError
          : !feed.historyLoaded
            ? 'Waiting for real historical tick data.'
            : feed.ticks.length < MINIMUM_DIGIT_TICKS
              ? `Only ${feed.ticks.length} validated digit ticks; ${MINIMUM_DIGIT_TICKS} are required.`
              : !feed.fresh
                ? 'Live tick freshness is not confirmed; no research candidate is published.'
                : !feed.contractsLoaded
                  ? 'Contract availability has not been verified by Deriv.'
                  : '';
      setSnapshot({
        ranAt: Date.now(),
        symbol: feed.selectedSymbol,
        selectedDuration,
        latestDigit: analysis.lastDigit,
        analysis,
        freshAtRun: feed.fresh,
        candidate: blockingReason ? null : ranking.candidates[0] ?? null,
        candidates: blockingReason ? [] : ranking.candidates,
        reason: blockingReason || ranking.reason,
      });
      setIsScanning(false);
    }, 30);
  }

  const snapshotMatchesSelected = snapshot?.symbol === feed.selectedSymbol && snapshot.selectedDuration === selectedDuration;
  const shownSnapshot = snapshotMatchesSelected ? snapshot : null;
  const resultCandidate = shownSnapshot?.candidate ?? null;
  const candidates = shownSnapshot?.candidates ?? [];
  const isReady = Boolean(feed.selectedMarket && feed.historyLoaded && feed.contractsLoaded && feed.fresh && !feed.precisionError);
  const dataQualityLabel = feed.precisionError
    ? 'Blocked · precision mismatch'
    : feed.selectedMarket?.precision !== null && feed.selectedMarket && feed.historyLoaded && feed.contractsLoaded && feed.fresh
      ? 'Precision-checked · fresh'
      : 'Incomplete or stale';

  return (
    <div className="animate-rise-in space-y-5 pt-5" data-testid={`${family}-analysis`}>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><div className="eyebrow">{familyDetails.eyebrow} · multi-engine research</div><h2 className="mt-1 text-2xl font-extrabold tracking-[-0.04em] sm:text-3xl">{familyDetails.title}</h2><p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{familyDetails.description} No orders are placed from this tool.</p></div>
        <FeedStatusBadge feed={feed} />
      </div>

      <section className="rounded-xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.75fr)_minmax(180px,0.55fr)_minmax(260px,1.2fr)_auto] lg:items-end">
          <SymbolPicker feed={feed} family={family} />
          <label className="block min-w-0">
            <span className="eyebrow">Tick expiry · Deriv metadata</span>
            <select
              value={selectedDuration ?? ''}
              onChange={(event) => setSelectedDuration(event.target.value ? Number(event.target.value) : null)}
              disabled={!feed.contractsLoaded || !availableDurations.length}
              className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-semibold text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={`Choose Deriv-supported tick expiry for ${family} analysis`}
              data-testid={`${family}-duration-select`}
            >
              <option value="">{feed.contractsLoaded ? 'Choose tick expiry…' : 'Loading contract rules…'}</option>
              {availableDurations.map((duration) => <option key={duration} value={duration}>{duration} {duration === 1 ? 'tick' : 'ticks'}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Quote</div><div className="mono mt-1 text-sm font-semibold">{formatQuote(latestTick?.quote, feed.selectedMarket?.precision ?? null)}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Final digit</div><div className="mono mt-1 text-sm font-semibold">{latestTick?.digit ?? '—'}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Verified precision</div><div className="mono mt-1 text-sm font-semibold">{feed.selectedMarket?.precision === null || !feed.selectedMarket ? '—' : `${feed.selectedMarket.precision} dp`}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Valid digit ticks</div><div className="mono mt-1 text-sm font-semibold">{feed.ticks.length}</div></div>
          </div>
          <button type="button" onClick={handleRunAnalysis} disabled={isScanning} className="focus-ring flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60" data-testid={`button-run-analysis-${family}`}>
            <Play size={16} fill="currentColor" />{isScanning ? 'Analyzing digits…' : 'Run Analysis'}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
          <span>{feed.selectedMarket?.name ?? 'No market selected'}{feed.selectedMarket?.market ? ` · ${feed.selectedMarket.market}` : ''}</span>
          <span>{feed.selectedMarket?.exchangeOpen === null || !feed.selectedMarket ? 'Market hours unverified' : feed.selectedMarket.exchangeOpen ? 'Exchange open' : 'Exchange closed'}</span>
          <span>{feed.selectedMarket?.tradingSuspended ? 'Trading suspended' : feed.selectedMarket ? 'Suspension check passed' : 'Suspension unknown'}</span>
          <span>{feed.contractsLoaded ? `${relevantContracts.length} Deriv-supported contract types` : 'Checking contract support'}</span>
          <span>{supportedDurationCount} unique Deriv-supported tick expiries · choose one</span>
          <span>Deriv App ID {feed.appId}</span>
          <span>Digit count is not traded volume</span>
        </div>
        {feed.feedError && <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{feed.feedError}</span></div>}
        {feed.contractError && <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground" role="status"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" /><span>{feed.contractError}</span></div>}
        {feed.precisionError && <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-destructive" role="alert" data-testid="digit-precision-error"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{feed.precisionError}</span></div>}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]" data-testid={`${family}-signal-summary`}>
        <article className="signal-panel rounded-xl border border-card-border p-5 panel-glow sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="eyebrow">Trade-grade decision</div><span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-amber-500">WAIT · no auto-trading</span></div>
          <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div><div className="text-5xl font-extrabold tracking-[-0.06em] text-amber-500">WAIT</div><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{shownSnapshot ? resultCandidate ? `Analysis ranked ${resultCandidate.label} for ${shownSnapshot.symbol} at the selected ${resultCandidate.outcomes.durationTicks}-tick expiry from available historical outcomes.` : shownSnapshot.reason || familyDetails.empty : 'Choose a Deriv-reported tick expiry, then press Run Analysis to evaluate this market’s expiry-specific digit outcomes.'}</p></div>
            {shownSnapshot && resultCandidate ? (
              <div className="w-full max-w-sm rounded-xl border border-primary/25 bg-primary/5 px-4 py-3" data-testid={`${family}-research-candidate`}>
                <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-primary">Research candidate · not validated</div>
                <div className="mt-2 text-xl font-extrabold">{resultCandidate.label}</div>
                <div className="mt-1 text-[10px] text-muted-foreground">{shownSnapshot.symbol} · selected {resultCandidate.outcomes.durationTicks}-tick expiry</div>
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/70 pt-3 text-xs sm:grid-cols-4"><div><div className="eyebrow">Conditioned rate</div><div className="mono mt-1 font-semibold">{formatRate(resultCandidate.outcomes.empiricalHitRate)}</div></div><div><div className="eyebrow">All-history base</div><div className="mono mt-1 font-semibold">{formatRate(resultCandidate.baseline.empiricalHitRate)}</div></div><div><div className="eyebrow">Nominal 95% interval</div><div className="mono mt-1 font-semibold">{formatInterval(resultCandidate.outcomes.wilson95)}</div></div><div><div className="eyebrow">Sample</div><div className="mono mt-1 font-semibold">{resultCandidate.outcomes.hits} / {resultCandidate.outcomes.sample}</div></div></div>
                <div className="mt-2 text-[10px] text-muted-foreground">Conditional difference vs all-history base: {formatDifference(resultCandidate.outcomes.empiricalHitRate === null || resultCandidate.baseline.empiricalHitRate === null ? null : resultCandidate.outcomes.empiricalHitRate - resultCandidate.baseline.empiricalHitRate)} (in-sample only).</div>
                {resultCandidate.outcomes.barrierEqual > 0 && <div className="mt-2 text-[10px] text-muted-foreground">Exact barrier was observed {resultCandidate.outcomes.barrierEqual} times and counted as a loss.</div>}
                <div className="mt-2 text-[10px] text-muted-foreground">Conditioned on {resultCandidate.outcomes.contextDigit !== null ? `starting digit ${resultCandidate.outcomes.contextDigit}` : resultCandidate.outcomes.contextParity === 0 ? 'an even starting digit' : 'an odd starting digit'}.</div>
              </div>
            ) : (
              <div className="w-full max-w-sm rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{shownSnapshot ? shownSnapshot.reason || familyDetails.empty : 'No scan has been run for this market yet.'}</div>
            )}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3" data-testid={`${family}-evidence-status`}>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Data quality</div><div className="mt-1 text-[11px] font-semibold">{dataQualityLabel}</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Model reliability</div><div className="mt-1 text-[11px] font-semibold">Not validated</div></div>
            <div className="rounded-lg border border-border bg-background/35 px-3 py-2"><div className="eyebrow">Signal strength</div><div className="mt-1 text-[11px] font-semibold">Not scored · WAIT</div></div>
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-background/45 p-3 text-xs leading-relaxed text-muted-foreground"><ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" /><span>Historical frequencies and smoothed rankings are descriptive research, not calibrated probabilities. The nominal 95% Wilson interval assumes independent Bernoulli outcomes; overlapping tick horizons violate that simplifying assumption, so it is not a calibrated forecast interval. No account currency, authorized proposal, live payout, break-even, expected-value, out-of-sample validation or risk service is connected. Actionable signal remains WAIT.</span></div>
          {shownSnapshot && <div className="mt-3 text-[10px] text-muted-foreground">Snapshot {new Date(shownSnapshot.ranAt).toLocaleTimeString()} · {shownSnapshot.analysis.sampleSize} validated digits · live freshness at scan: {shownSnapshot.freshAtRun ? 'confirmed' : 'not confirmed'}</div>}
        </article>

        <article className="rounded-xl border border-card-border bg-card/90 p-5 panel-glow">
          <div className="flex items-center justify-between gap-3"><div><div className="eyebrow">Live selected market</div><h3 className="mt-1 text-base font-bold">{feed.selectedMarket?.name ?? 'Waiting for active symbols'}</h3></div><Activity size={18} className={feed.fresh ? 'text-emerald-500' : 'text-muted-foreground'} /></div>
          <div className="mt-1 text-[10px] text-muted-foreground">{feed.selectedSymbol || 'No active symbol'} · {feed.selectedMarket?.market ?? 'market metadata unavailable'}</div>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4"><div><div className="eyebrow">Feed status</div><div className="mt-1 text-sm font-semibold">{feedStatusLabel(feed)}</div></div><div><div className="eyebrow">Source age</div><div className="mono mt-1 text-sm font-semibold">{feed.sourceAgeMs === null ? '—' : `${Math.max(0, Math.floor(feed.sourceAgeMs / 1000))}s`}</div></div><div><div className="eyebrow">History</div><div className="mt-1 text-sm font-semibold">{feed.historyLoaded ? 'Loaded' : 'Waiting / unavailable'}</div></div><div><div className="eyebrow">Contract rules</div><div className="mt-1 text-sm font-semibold">{feed.contractsLoaded ? 'Queried' : 'Waiting / unavailable'}</div></div></div>
          {feed.selectedMarket?.precision !== null && feed.selectedMarket && <div className="mt-4 rounded-md border border-border bg-background/35 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">Final digits use Deriv pip_size = {feed.selectedMarket.pipSize} and {feed.selectedMarket.precision} displayed decimal places. Any metadata mismatch blocks digit analysis.</div>}
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <DigitFrequencyPanel analysis={shownSnapshot?.analysis ?? currentAnalysis} />
        <HistoricalRanking family={family} candidates={candidates} />
      </section>

      <PriceContextPanel feed={feed} analysis={currentPriceContext} />

      <section className="grid gap-3 md:grid-cols-3">
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><Database size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Verified input pipeline</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Active-symbol pip_size, history pip_size and live tick pip_size must agree. Quotes are decimal-scaled before extracting the last displayed digit; invalid precision blocks analysis.</p></div></div>
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><BarChart3 size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Expiry-aware research</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Each candidate uses the final observed digit exactly N ticks after each historical entry and conditions on the current digit or parity. Overlapping comparisons are not independent and are not a calibration set.</p></div></div>
        <div className="flex items-start gap-3 rounded-xl border border-card-border bg-card/80 p-4"><Clock3 size={17} className="mt-0.5 shrink-0 text-primary" /><div><div className="text-xs font-bold">Not implemented yet</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Formal multi-horizon Dow analysis, candle-based ATR / ADX, account-currency proposal quotes, payout/EV gating, model calibration, walk-forward backtesting, persistent signal storage, machine learning and execution remain unavailable.</p></div></div>
      </section>

      <div className="text-[10px] leading-relaxed text-muted-foreground" aria-live="polite"><Zap size={12} className="mr-1 inline text-primary" />{shownSnapshot ? `${shownSnapshot.analysis.sampleSize} real validated digits were analyzed for ${shownSnapshot.symbol}.` : isReady ? `Choose one of ${supportedDurationCount} Deriv-supported tick expiries, then run analysis.` : 'Waiting for live data, pip precision, contract metadata and sufficient history.'} No simulated digits, fabricated probabilities or order placement are used.</div>
    </div>
  );
}

export function OverUnderTool() { return <DigitContractTool family="over-under" />; }
export function EvenOddTool() { return <DigitContractTool family="even-odd" />; }
export function MatchesTool() { return <DigitContractTool family="matches" />; }
