import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Database,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useMarketFeed } from "@/components/market-feed-provider";
import { digitTicksOf } from "@/lib/market-feed";
import {
  FORGE_KNOWLEDGE,
  FORGE_KNOWLEDGE_VERSION,
  FORGE_MARKET_ATLAS,
  marketProfile,
  summarizeKnowledge,
  type ForgeKnowledgeDomain,
  type ForgeKnowledgeUse,
} from "@/lib/forge/knowledge";
import { FORGE_FEATURE_COUNT } from "@/lib/forge/features";
import { FORGE_TRAINING_PROFILE } from "@/lib/forge/forge";
import { FORGE_MODEL_ID } from "@/lib/forge/types";
import {
  auditDigitRandomness,
  forecastNextDigit,
  RANDOMNESS_AUDIT,
  type DigitRandomnessAudit,
} from "@/lib/forge/randomness-audit";

const DOMAINS: ForgeKnowledgeDomain[] = [
  "contract",
  "payout",
  "feed",
  "statistics",
  "structure",
  "risk",
  "execution",
  "market",
];
const KNOWLEDGE_USES: ForgeKnowledgeUse[] = [
  "feature",
  "prior",
  "teacher",
  "veto",
  "gate",
];
const DOMAIN_LABELS: Record<ForgeKnowledgeDomain, string> = {
  contract: "Contracts",
  payout: "Payout economics",
  feed: "Data feed",
  statistics: "Statistics",
  structure: "Market structure",
  risk: "Risk controls",
  execution: "Execution",
  market: "Market atlas",
};
const USE_LABELS: Record<ForgeKnowledgeUse, string> = {
  feature: "Feature",
  prior: "Prior",
  teacher: "Teacher",
  veto: "Veto",
  gate: "Gate",
};

const PERCENT = (value: number | null | undefined, places = 1) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(places)}%`;
const DECIMAL = (value: number | null | undefined, places = 2) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toFixed(places);

function MetricTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-background/45 px-3 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mono mt-1 text-sm font-bold tracking-tight text-foreground">
        {value}
      </div>
      {detail ? (
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

function StatusPill({ live, label }: { live: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${live ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-500" : "border-border bg-background/60 text-muted-foreground"}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse-line bg-emerald-500" : "bg-muted-foreground/60"}`}
      />
      {label}
    </span>
  );
}

function DigitDistribution({
  counts,
  expectedPerDigit,
}: {
  counts: readonly number[];
  expectedPerDigit: number;
}) {
  const maximum = Math.max(1, ...counts, expectedPerDigit);
  return (
    <div
      className="grid grid-cols-5 gap-x-3 gap-y-3 sm:grid-cols-10"
      aria-label="Observed digit frequencies"
    >
      {counts.map((count, digit) => (
        <div
          key={digit}
          className="min-w-0"
          title={`Digit ${digit}: ${count} observations; fair expectation ${expectedPerDigit.toFixed(1)}`}
        >
          <div className="mb-1 flex items-center justify-between gap-1 text-[10px]">
            <span className="mono font-bold">{digit}</span>
            <span className="mono text-muted-foreground">{count}</span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary/80"
              style={{ width: `${Math.min(100, (count / maximum) * 100)}%` }}
            />
            <span
              className="absolute inset-y-0 w-px bg-amber-400"
              style={{
                left: `${Math.min(100, (expectedPerDigit / maximum) * 100)}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ForecastBars({
  probabilities,
  topDigits,
}: {
  probabilities: readonly number[];
  topDigits: readonly number[];
}) {
  const maximum = Math.max(0.1, ...probabilities);
  return (
    <div className="mt-3 grid grid-cols-5 gap-x-2 gap-y-3 sm:grid-cols-10">
      {probabilities.map((probability, digit) => {
        const top = topDigits.includes(digit);
        return (
          <div
            key={digit}
            className="text-center"
            title={`Digit ${digit}: ${(probability * 100).toFixed(2)}% model estimate; 10% fair baseline`}
          >
            <div
              className={`mono text-[10px] font-bold ${top ? "text-primary" : "text-muted-foreground"}`}
            >
              {digit}
            </div>
            <div className="mx-auto mt-1 flex h-12 w-5 items-end overflow-hidden rounded-md bg-secondary">
              <div
                className={`w-full rounded-md ${top ? "bg-primary" : "bg-muted-foreground/40"}`}
                style={{
                  height: `${Math.max(4, (probability / maximum) * 100)}%`,
                }}
              />
            </div>
            <div className="mono mt-1 text-[9px] text-muted-foreground">
              {(probability * 100).toFixed(1)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KnowledgeLibrary() {
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<ForgeKnowledgeDomain | "all">("all");
  const [use, setUse] = useState<ForgeKnowledgeUse | "all">("all");
  const queryText = query.trim().toLocaleLowerCase();
  const knowledge = useMemo(
    () =>
      FORGE_KNOWLEDGE.filter(
        (entry) =>
          (domain === "all" || entry.domain === domain) &&
          (use === "all" || entry.use === use) &&
          (!queryText ||
            `${entry.title} ${entry.statement} ${entry.id}`
              .toLocaleLowerCase()
              .includes(queryText)),
      ),
    [domain, queryText, use],
  );

  return (
    <section
      className="rounded-2xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5"
      data-testid="base-knowledge-library"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpen size={16} />
          </div>
          <div>
            <div className="eyebrow">
              Curated syllabus · v{FORGE_KNOWLEDGE_VERSION}
            </div>
            <h3 className="mt-1 text-base font-bold tracking-tight">
              Deriv knowledge base
            </h3>
            <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
              Browse every rule the Forge is taught to respect: contract
              semantics, payout math, public feed, statistical tests, market
              structure, risk and execution. This is the app’s curated
              coverage—not all Deriv product, legal or proprietary
              documentation.
            </p>
          </div>
        </div>
        <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[10px] font-bold text-primary">
          {FORGE_KNOWLEDGE.length} lessons · {FORGE_MARKET_ATLAS.length} atlas
          profiles
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_220px_190px]">
        <label className="relative block">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the knowledge base"
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60"
            aria-label="Search the Deriv knowledge base"
            data-testid="base-knowledge-search"
          />
        </label>
        <select
          value={domain}
          onChange={(event) =>
            setDomain(event.target.value as ForgeKnowledgeDomain | "all")
          }
          className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary/60"
          aria-label="Filter knowledge by domain"
          data-testid="base-knowledge-domain-filter"
        >
          <option value="all">All domains</option>
          {DOMAINS.map((item) => (
            <option key={item} value={item}>
              {DOMAIN_LABELS[item]}
            </option>
          ))}
        </select>
        <select
          value={use}
          onChange={(event) =>
            setUse(event.target.value as ForgeKnowledgeUse | "all")
          }
          className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary/60"
          aria-label="Filter knowledge by use"
          data-testid="base-knowledge-use-filter"
        >
          <option value="all">All model uses</option>
          {KNOWLEDGE_USES.map((item) => (
            <option key={item} value={item}>
              {USE_LABELS[item]}
            </option>
          ))}
        </select>
      </div>

      <div
        className="mt-3 flex flex-wrap gap-1.5"
        aria-label="Knowledge counts by domain"
      >
        {DOMAINS.map((item) => {
          const count = FORGE_KNOWLEDGE.filter(
            (entry) => entry.domain === item,
          ).length;
          if (count === 0) return null;
          return (
            <button
              key={item}
              type="button"
              onClick={() => setDomain(domain === item ? "all" : item)}
              className={`rounded-full border px-2 py-1 text-[9px] font-semibold transition-colors ${domain === item ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
              title={`Filter to ${DOMAIN_LABELS[item]}`}
            >
              {DOMAIN_LABELS[item]} · {count}
            </button>
          );
        })}
      </div>

      <div className="mt-3 space-y-2">
        {DOMAINS.map((group) => {
          const entries = knowledge.filter((entry) => entry.domain === group);
          if (!entries.length) return null;
          return (
            <details
              key={group}
              className="group rounded-xl border border-border bg-background/25"
              open={domain === group || Boolean(queryText)}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-bold marker:hidden">
                <span>{DOMAIN_LABELS[group]}</span>
                <span className="mono text-[10px] font-medium text-muted-foreground">
                  {entries.length} {entries.length === 1 ? "lesson" : "lessons"}
                </span>
              </summary>
              <div className="grid gap-2 border-t border-border p-2 sm:grid-cols-2">
                {entries.map((entry) => (
                  <article
                    key={entry.id}
                    className="rounded-lg border border-border/80 bg-card/70 p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h4 className="text-[11px] font-bold leading-snug">
                        {entry.title}
                      </h4>
                      <span
                        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.08em] ${entry.use === "veto" ? "border-rose-500/30 bg-rose-500/10 text-rose-500" : entry.use === "gate" ? "border-amber-500/30 bg-amber-500/10 text-amber-500" : "border-border bg-background text-muted-foreground"}`}
                      >
                        {USE_LABELS[entry.use]}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                      {entry.statement}
                    </p>
                    <div className="mono mt-2 flex flex-wrap gap-2 text-[8px] text-muted-foreground/80">
                      <span>{entry.id}</span>
                      <span>
                        {entry.families
                          .map((family) =>
                            family === "digit" ? "Digit" : "Rise/Fall",
                          )
                          .join(" · ")}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </details>
          );
        })}
        {knowledge.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No knowledge entries match those filters.
          </p>
        ) : null}
      </div>

      <details
        className="mt-3 rounded-xl border border-border bg-background/25"
        data-testid="base-market-atlas"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-xs font-bold">
          <span className="inline-flex items-center gap-2">
            <Database size={14} className="text-primary" /> Instrument atlas
          </span>
          <span className="mono text-[10px] font-medium text-muted-foreground">
            {FORGE_MARKET_ATLAS.length} profiles
          </span>
        </summary>
        <div className="grid gap-2 border-t border-border p-2 sm:grid-cols-2 xl:grid-cols-3">
          {FORGE_MARKET_ATLAS.map((profile) => (
            <article
              key={profile.symbol}
              className="rounded-lg border border-border bg-card/70 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-[11px] font-bold">{profile.name}</h4>
                <span className="mono rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  {profile.symbol}
                </span>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                {profile.note}
              </p>
              <div className="mono mt-2 text-[9px] text-muted-foreground/80">
                {profile.kind} · ~
                {(profile.expectedTickMs / 1_000).toFixed(
                  profile.expectedTickMs % 1_000 === 0 ? 0 : 1,
                )}
                s cadence · {profile.suitedTo.join(" / ")}
              </div>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

function RandomnessChallenge({
  digits,
  symbol,
  lastEpoch,
  marketCount,
}: {
  digits: readonly number[];
  symbol: string;
  lastEpoch: number | null;
  marketCount: number;
}) {
  const [snapshot, setSnapshot] = useState<{
    audit: DigitRandomnessAudit;
    lastEpoch: number | null;
  } | null>(null);
  const forecast = useMemo(() => forecastNextDigit(digits), [digits]);
  const historical = snapshot?.audit;
  const stale = Boolean(historical && snapshot?.lastEpoch !== lastEpoch);
  const canAudit = digits.length >= RANDOMNESS_AUDIT.minimumDigits;

  useEffect(() => {
    setSnapshot(null);
  }, [symbol]);

  const runAudit = () => {
    setSnapshot({
      audit: auditDigitRandomness(digits, {
        selectionPool: Math.max(1, marketCount),
      }),
      lastEpoch,
    });
  };

  return (
    <section
      className="rounded-2xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5"
      data-testid="base-randomness-challenge"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Activity size={16} />
          </div>
          <div>
            <div className="eyebrow">RNG challenge · chronological replay</div>
            <h3 className="mt-1 text-base font-bold tracking-tight">
              Does the stream reveal repeatable memory?
            </h3>
            <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
              The probe predicts the next digit from earlier transitions only,
              then compares its walk-forward scores with a fair 10% per-digit
              baseline. No future rows are used to build a forecast.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={runAudit}
          disabled={!canAudit}
          className="focus-ring inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          data-testid="button-run-rng-audit"
        >
          <Sparkles size={14} />
          {historical ? "Re-run walk-forward test" : "Run walk-forward test"}
        </button>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
        <div
          className="rounded-xl border border-border bg-background/35 p-3 sm:p-4"
          data-testid="base-live-forecast"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="eyebrow">Exploratory next-digit estimate</div>
              <div className="mt-1 text-xs font-bold">
                {forecast
                  ? `After digit ${forecast.previousDigit}`
                  : "Waiting for verified digit history"}
              </div>
            </div>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-amber-600 dark:text-amber-300">
              Not a trade signal
            </span>
          </div>
          {forecast ? (
            <>
              <ForecastBars
                probabilities={forecast.probabilities}
                topDigits={forecast.topDigits}
              />
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {forecast.topDigits.map((digit, index) => (
                  <div
                    key={digit}
                    className="flex items-center justify-between rounded-lg border border-border bg-card/70 px-3 py-2"
                  >
                    <span className="text-[10px] text-muted-foreground">
                      {index === 0 ? "Highest estimate" : `Rank ${index + 1}`} ·
                      digit{" "}
                      <strong className="mono text-foreground">{digit}</strong>
                    </span>
                    <strong className="mono text-xs text-primary">
                      {PERCENT(forecast.probabilities[digit])}
                    </strong>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">
                Based on {forecast.transitionsUsed.toLocaleString()} prior
                transitions ({forecast.contextTransitions.toLocaleString()}{" "}
                after digit {forecast.previousDigit}), with smoothing toward the
                10% fair baseline. The top estimate is not validated just
                because it ranks first.
              </p>
            </>
          ) : (
            <p className="mt-3 text-[11px] text-muted-foreground">
              The feed must provide at least one digit with verified pip
              precision.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-background/35 p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="eyebrow">Test protocol</div>
            <span className="mono text-[9px] text-muted-foreground">
              {digits.length.toLocaleString()} verified digits
            </span>
          </div>
          <ol className="mt-3 space-y-2 text-[10px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2">
              <span className="mono text-primary">01</span>
              <span>
                Warm up on {RANDOMNESS_AUDIT.warmupTicks} earlier ticks; train
                from a rolling window of {RANDOMNESS_AUDIT.trainWindowTicks}.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mono text-primary">02</span>
              <span>
                Score every next-digit forecast before revealing the outcome;
                compare Brier and log-loss against uniform odds.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mono text-primary">03</span>
              <span>
                Require at least {RANDOMNESS_AUDIT.minimumForecasts} scored rows
                and a selection-adjusted paired-z threshold.
              </span>
            </li>
          </ol>
          {!canAudit ? (
            <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
              Need {Math.max(0, RANDOMNESS_AUDIT.minimumDigits - digits.length)}{" "}
              more verified digits before the historical screen can run.
            </p>
          ) : null}
        </div>
      </div>

      {historical ? (
        <div
          className="mt-3 rounded-xl border border-border bg-background/25 p-3 sm:p-4"
          data-testid="rng-audit-results"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="eyebrow">
                Historical walk-forward result ·{" "}
                {historical.sampleSize.toLocaleString()} digit snapshot
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {historical.forecastRows.toLocaleString()} forecasts scored
                after {historical.warmupTicks} warm-up ticks ·{" "}
                {historical.trainWindowTicks}-tick fit window
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold ${historical.passedHistoricalScreen ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-500" : "border-border bg-background text-muted-foreground"}`}
              data-testid="rng-audit-verdict"
            >
              {historical.passedHistoricalScreen ? (
                <CheckCircle2 size={12} />
              ) : (
                <CircleAlert size={12} />
              )}
              {historical.passedHistoricalScreen
                ? "Historical screen passed"
                : "No validated edge"}
            </span>
          </div>

          {stale ? (
            <p className="mt-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[10px] text-muted-foreground">
              New ticks have arrived since this snapshot. Re-run the test to
              refresh it.
            </p>
          ) : null}

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Brier skill vs fair"
              value={PERCENT(historical.brierSkill)}
              detail={`Model ${DECIMAL(historical.modelBrier)} · uniform ${DECIMAL(historical.fairBrier)}`}
            />
            <MetricTile
              label="Log-loss skill vs fair"
              value={PERCENT(historical.logLossSkill)}
              detail={`Model ${DECIMAL(historical.modelLogLoss)} · uniform ${DECIMAL(historical.fairLogLoss)}`}
            />
            <MetricTile
              label="Paired HAC z / bar"
              value={`${DECIMAL(historical.pairedZ)} / ${DECIMAL(historical.zBar)}`}
              detail="Short-range dependence-adjusted score difference"
            />
            <MetricTile
              label="Forecasts / gate"
              value={`${historical.forecastRows} / ${RANDOMNESS_AUDIT.minimumForecasts}`}
              detail={`${historical.selectionPool} markets in the selection correction`}
            />
            <MetricTile
              label="Digit entropy"
              value={PERCENT(historical.normalizedEntropy)}
              detail="1.0 is maximum observed ten-digit entropy"
            />
            <MetricTile
              label="Frequency χ² p"
              value={DECIMAL(historical.chiSquarePValue, 3)}
              detail="Marginal frequency check only; not a randomness certificate"
            />
            <MetricTile
              label="Same-digit rate"
              value={PERCENT(historical.repeatedDigitRate)}
              detail={`Fair independent baseline 10% · z ${DECIMAL(historical.repeatedDigitZ)}`}
            />
            <MetricTile
              label="Sample"
              value={`${historical.sampleSize.toLocaleString()} digits`}
              detail={`≈${historical.expectedPerDigit.toFixed(1)} expected per digit at uniform odds`}
            />
          </div>

          <div className="mt-4 rounded-lg border border-border bg-card/60 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] font-bold">
                Observed digit frequency
              </div>
              <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-sm bg-primary" />{" "}
                observed{" "}
                <span className="inline-block h-2 w-2 rounded-sm bg-amber-400" />{" "}
                uniform expectation
              </div>
            </div>
            <DigitDistribution
              counts={historical.counts}
              expectedPerDigit={historical.expectedPerDigit}
            />
          </div>

          <p
            className={`mt-3 rounded-lg border px-3 py-2 text-[10px] leading-relaxed ${historical.passedHistoricalScreen ? "border-emerald-500/25 bg-emerald-500/5 text-muted-foreground" : "border-amber-500/25 bg-amber-500/5 text-muted-foreground"}`}
          >
            {historical.passedHistoricalScreen
              ? "This stream passed the chosen historical screen on this snapshot. It is not proof the generator is predictable, it does not guarantee the next digit, and it says nothing by itself about payout or profitability. Confirm any pattern on a later untouched sample."
              : "No predictive edge cleared every screen on this snapshot. That is not proof of perfect randomness; the honest output is to keep the forecast exploratory and use the 10% fair baseline."}{" "}
            Repeated manual inspections are not fully corrected for here.
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function ForgeBaseWorkspace({
  onOpenAnalysis,
}: {
  onOpenAnalysis: () => void;
}) {
  const feed = useMarketFeed();
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const selectedMarket =
    feed.markets.find((market) => market.symbol === selectedSymbol) ??
    feed.markets[0] ??
    null;
  const selectedSymbolNow = selectedMarket?.symbol ?? "";
  const verifiedTicks = useMemo(
    () => (selectedMarket ? digitTicksOf(selectedMarket.ticks) : []),
    [selectedMarket?.ticks],
  );
  const digits = useMemo(
    () => verifiedTicks.map((tick) => tick.digit),
    [verifiedTicks],
  );
  const lastEpoch = verifiedTicks.at(-1)?.epoch ?? null;
  const profile = selectedMarket
    ? marketProfile(selectedMarket.symbol, selectedMarket.name)
    : null;
  const digitKnowledge = summarizeKnowledge("digit");
  const riseFallKnowledge = summarizeKnowledge("rise-fall");
  const shape = FORGE_TRAINING_PROFILE.shape;
  const parameterCount = shape
    .slice(1)
    .reduce((total, output, index) => total + output * (shape[index] + 1), 0);
  const filteredKnowledgeCount = FORGE_KNOWLEDGE.length;

  return (
    <div
      className="mx-auto w-full max-w-[1500px] space-y-4"
      data-testid="forge-base-workspace"
    >
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card p-5 shadow-[0_16px_50px_hsl(var(--primary)/0.06)] sm:p-7">
        <div className="pointer-events-none absolute -right-12 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex max-w-4xl items-start gap-3">
            <div className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_30px_hsl(var(--primary)/0.25)]">
              <BrainCircuit size={22} />
            </div>
            <div>
              <div className="eyebrow">SIGNAL LAB · FORGE CORE</div>
              <h2 className="mt-1 text-2xl font-extrabold tracking-[-0.04em] sm:text-3xl">
                The Base
              </h2>
              <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground sm:text-sm">
                The model room: inspect the Forge’s curriculum, see the live
                public stream, and challenge a causal next-digit probe against
                fair odds. The goal is measured evidence—not a claim that an
                independent random stream can be beaten.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenAnalysis}
              className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/55 px-3 py-2 text-[10px] font-bold text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              data-testid="button-base-open-analysis"
            >
              <Wrench size={12} /> Open AI Analysis
            </button>
            <StatusPill
              live={feed.status === "live" && Boolean(selectedMarket?.fresh)}
              label={
                feed.status === "live" && selectedMarket?.fresh
                  ? "Public feed live"
                  : feed.status === "error"
                    ? "Feed unavailable"
                    : "Research mode"
              }
            />
          </div>
        </div>
      </section>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Forge model profile"
      >
        <MetricTile
          label="Forge model"
          value={FORGE_MODEL_ID}
          detail={`${parameterCount.toLocaleString()} parameters · ${shape.join(" → ")} · up to ${FORGE_TRAINING_PROFILE.maxEpochs} epochs`}
        />
        <MetricTile
          label="Causal inputs"
          value={`${FORGE_FEATURE_COUNT} frozen features`}
          detail={`Ensemble, priors, cadence, structure · ${FORGE_TRAINING_PROFILE.maxReplayRows} replay-row cap`}
        />
        <MetricTile
          label="Knowledge syllabus"
          value={`${filteredKnowledgeCount} lessons`}
          detail={`${digitKnowledge.total} digit · ${riseFallKnowledge.total} Rise/Fall · ${DOMAINS.length} domains`}
        />
        <MetricTile
          label="Evidence gate"
          value="Purged walk-forward"
          detail={`50/20/30 split · ${Math.round(FORGE_TRAINING_PROFILE.distillationShare * 100)}% teacher distillation · independent holdout`}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
        <section
          className="rounded-2xl border border-card-border bg-card/90 p-4 panel-glow sm:p-5"
          data-testid="base-live-market"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Radio size={16} />
              </div>
              <div>
                <div className="eyebrow">Public market stream</div>
                <h3 className="mt-1 text-base font-bold tracking-tight">
                  Live instrument
                </h3>
              </div>
            </div>
            <select
              value={selectedMarket?.symbol ?? ""}
              onChange={(event) => setSelectedSymbol(event.target.value)}
              disabled={!feed.markets.length}
              className="max-w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-primary/60 disabled:opacity-60"
              aria-label="Choose a market for the randomness audit"
              data-testid="base-market-select"
            >
              {feed.markets.map((market) => (
                <option key={market.symbol} value={market.symbol}>
                  {market.name} · {market.symbol}
                </option>
              ))}
            </select>
          </div>

          {selectedMarket && profile ? (
            <>
              <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-lg font-extrabold tracking-tight">
                    {selectedMarket.name}
                  </div>
                  <div className="mono mt-0.5 text-[10px] text-muted-foreground">
                    {selectedMarket.symbol} · {profile.kind} ·{" "}
                    {profile.expectedTickMs / 1_000}s expected cadence
                  </div>
                </div>
                <StatusPill
                  live={selectedMarket.fresh}
                  label={
                    selectedMarket.fresh
                      ? "Streaming"
                      : selectedMarket.historyLoaded
                        ? "History loaded"
                        : "Waiting for data"
                  }
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <MetricTile
                  label="Ticks loaded"
                  value={selectedMarket.ticks.length.toLocaleString()}
                  detail="Shared history + live updates"
                />
                <MetricTile
                  label="Verified digits"
                  value={digits.length.toLocaleString()}
                  detail="Only digits read at verified pip precision"
                />
                <MetricTile
                  label="Current quote"
                  value={
                    selectedMarket.ticks
                      .at(-1)
                      ?.quote.toLocaleString(undefined, {
                        maximumFractionDigits: selectedMarket.precision ?? 6,
                      }) ?? "—"
                  }
                  detail={
                    lastEpoch
                      ? new Date(lastEpoch * 1_000).toLocaleTimeString()
                      : "No timestamp"
                  }
                />
                <MetricTile
                  label="Market classification"
                  value={profile.kind}
                  detail={profile.note}
                />
              </div>
            </>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
              Connecting to the shared public market feed…
            </div>
          )}
          {feed.error ? (
            <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
              {feed.error}
            </p>
          ) : null}
          <p className="mt-3 text-[9px] leading-relaxed text-muted-foreground">
            This page uses the shared public data socket only. It does not need
            a Deriv PAT and does not read account information.
          </p>
        </section>

        <RandomnessChallenge
          key={selectedSymbolNow}
          digits={digits}
          symbol={selectedSymbolNow}
          lastEpoch={lastEpoch}
          marketCount={feed.markets.length}
        />
      </section>

      <section
        className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 sm:p-5"
        data-testid="base-model-honesty"
      >
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-300">
            <ShieldCheck size={15} />
          </div>
          <div>
            <h3 className="text-xs font-bold">What “powerful” means here</h3>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              Forge fits locally during Run Analysis, learns from causal replay
              rows and audited teachers, and earns influence only after a purged
              holdout beats the contract’s fair baseline. It cannot see Deriv’s
              internal RNG seed/state, cannot promise a future digit, and never
              places an order by itself. Bigger networks or more epochs do not
              create information that is absent from the feed.
            </p>
          </div>
        </div>
      </section>

      <KnowledgeLibrary />
    </div>
  );
}
