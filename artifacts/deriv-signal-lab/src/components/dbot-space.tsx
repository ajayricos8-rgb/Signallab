import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  ArrowRight, BookOpen, Boxes, BrainCircuit, ChartNoAxesCombined, CheckCircle2, CircleHelp, Link2, LoaderCircle,
  Library, LockKeyhole, Maximize2, Search, ShieldAlert, Signal, Sparkles, Unlink, Wallet, X, type LucideProps,
} from 'lucide-react';
import { useDerivTrading } from '@/components/deriv-trading-provider';
import { formatAmount } from '@/lib/deriv-trading';
import { useMarketFeed } from '@/components/market-feed-provider';
import { DbotAiCopilot, type DbotAiBlockInfo } from '@/components/dbot-ai-copilot';
import type { DbotAiAnalysisSnapshot } from '@/lib/dbot-ai';
import {
  bridgeStats, buildAccountMessage, buildBridgeSnapshot, buildBridgeUpdate, sameAccountState,
  type BridgeAccountMessage, type BridgeCursor, type BridgeSourceMarket,
} from '@/lib/dbot-bridge';
// The AI bot ships as a real strategy file, the same way Deriv ships its own:
// blocks in, blocks out. It is dropped into the builder untouched.
import aiVisionOverUnderXml from '@/lib/bot-store/bots/ai-vision-over-under.xml?raw';
import aiEvenSwitcherXml from '@/lib/bot-store/bots/ai-even-switcher.xml?raw';
import highLowTickSniperXml from '@/lib/bot-store/bots/high-low-tick-sniper.xml?raw';
import riseFallEnsembleXml from '@/lib/bot-store/bots/rise-fall-ensemble.xml?raw';
import stepRiseFallHedgeXml from '@/lib/bot-store/bots/step-rise-fall-hedge.xml?raw';

type SpaceView = 'builder' | 'chart' | 'store';
type LinkState = 'idle' | 'connecting' | 'connected';
type StrategyCategory = 'Progression' | 'Reverse progression' | 'Sequence' | 'AI';
type Strategy = {
  id: string;
  name: string;
  category: StrategyCategory;
  short: string;
  detail: string;
  risk: string;
  accent: string;
  icon: ComponentType<LucideProps>;
  /** Deriv quick-strategy forms open a form; our own bots load their blocks directly. */
  xml?: string;
};

// These map directly to Deriv's quick-strategy forms. Selecting one opens the
// real configuration flow; no strategy is silently generated or run.
const STRATEGIES: Strategy[] = [
  { id: 'MARTINGALE', name: 'Martingale', category: 'Progression', short: 'Increase the stake after a loss and reset it after a win.', detail: 'A loss-recovery progression that multiplies the next stake after a losing trade. Choose the multiplier and limits in the strategy form.', risk: 'Stake can grow rapidly during consecutive losses.', accent: 'blue', icon: Boxes },
  { id: 'D_ALEMBERT', name: "D’Alembert", category: 'Progression', short: 'Adjust your stake in fixed steps after wins and losses.', detail: 'A gradual progression that increases stake by a chosen unit after a loss and decreases it after a win.', risk: 'Consecutive losses can still increase your exposure.', accent: 'violet', icon: ChartNoAxesCombined },
  { id: 'OSCARS_GRIND', name: "Oscar’s Grind", category: 'Progression', short: 'A measured staking sequence that adjusts after wins.', detail: 'A progression that adjusts the stake during a sequence of trades according to the strategy’s profit target.', risk: 'Profit targets do not prevent a series of losses.', accent: 'amber', icon: Sparkles },
  { id: 'REVERSE_MARTINGALE', name: 'Reverse Martingale', category: 'Reverse progression', short: 'Increase the stake after a win rather than a loss.', detail: 'A reverse progression that multiplies the next stake following a win and resets after a loss.', risk: 'A loss can erase gains from a winning sequence.', accent: 'teal', icon: Boxes },
  { id: 'REVERSE_D_ALEMBERT', name: 'Reverse D’Alembert', category: 'Reverse progression', short: 'Step the stake up after a win and down after a loss.', detail: 'The reverse version of D’Alembert, using a configurable unit to adjust the stake after each result.', risk: 'Changing stake does not create a trading edge.', accent: 'rose', icon: ChartNoAxesCombined },
  { id: 'STRATEGY_1_3_2_6', name: '1-3-2-6', category: 'Sequence', short: 'Follow a four-step staking sequence across winning trades.', detail: 'A four-stage progression based on stake multiples of 1, 3, 2, and 6. Review the sequence and exit rules before use.', risk: 'The sequence can end in loss at any stage.', accent: 'indigo', icon: Sparkles },
  {
    id: 'AI_VISION_OVER_UNDER',
    name: 'AI Vision — Over/Under',
    category: 'AI',
    short: 'An online-learning digit brain on the volatility indices: eight models, payout-priced Over/Under contracts, a self-graded calibration layer and a live payout table from the first tick.',
    detail:
      'Not a staking template: the logic is the edge. It refreshes the payout table first, so the very first plan is priced on real quotes rather than a fallback, then keeps itself on the market it scores best and moves on when that score drops \u2014 never leaving a market whose tick history has not arrived. Eight models forecast the last digit at expiry: long-run and recent frequency, the digit transition table, a kernel replay of similar states, an analytical price forecast, a fair-odds anchor, an online-trained neural net, and a regime model that reverses a stretch on a quiet tape and refuses to extrapolate a burst on an expanding one. Each is scored walk-forward, so a model that cannot read this market loses its vote. Every Over/Under barrier is priced against the payout table and the contract with the best expected value wins, behind four session brakes. The second layer is self-grading: after twenty settled decisions the bot compares its own hit rate with the break-even of the payouts it was paid and pulls its estimate toward the fair anchor by that ratio \u2014 sharpening an earned record and shrinking an unearned one instead of parking the bot. The brain learns from every settlement, survives restarts, prints its scorecard and plan every twentieth settlement and its reasoning every twentieth skip.',
    risk:
      'The model and payout estimates are not guarantees and can be wrong; a positive modelled edge may disappear when quotes move. The stronger gates intentionally reduce trade frequency. The stake halves after a loss inside a 0.5\u20131 band and never doubles. Start on demo, keep the base stake small, and set a session loss limit.',
    accent: 'emerald',
    icon: BrainCircuit,
    xml: aiVisionOverUnderXml,
  },
  {
    id: 'AI_EVEN_SWITCHER',
    name: 'AI Even Switcher',
    category: 'AI',
    short: 'Sixteen experts forecast P(even) at the settling tick and the bot buys whichever side Deriv has mispriced \u2014 Even or Odd, switched by the measurement every cycle, across fourteen digit markets with a self-graded record.',
    detail:
      'The v1 bot bought Even only and touched Odd solely in loss-recovery; v2 scores both sides every cycle and buys whichever the measurement favours, so the side switch is the strategy. Sixteen experts forecast the chance the last digit at the settling tick is even: the eight proven vision digit models (fair anchor, long-run and recent histograms, the Markov row, analog replay, the analytical price-to-digit mapping, an online softmax net, the regime forecast), each summed to P(even), plus eight parity-native readers (long-run and recent even share, first- and second-order parity Markov powered to the horizon, the digit transition row, run continuation, a parity-autocorrelation projector and an online parity perceptron). Every expert is scored walk-forward with Brier loss against the 50/50 anchor over the settled past and mixed by measured skill, so an expert that cannot read this market loses its vote on its own, and the blend is shrunk toward 50 % by its effective sample size. Both sides are then priced against the live DIGITEVEN/DIGITODD quotes \u2014 read from Deriv\u2019s own proposals, both sides paid the same \u2014 and the better expected value wins; in cadence mode that side is bought on every cycle the bot can read, sized by tenth-Kelly down to the exchange minimum. (Set the entry field to \u201conly with a measured edge\u201d and \u201cai min ev\u201d above zero to restore the selective sniper.) Before the ensemble speaks the engine fingerprints the digit stream \u2014 even share, runs, dependence, alternation, entropy, sample warmth \u2014 into a readability score that refuses markets the bot cannot measure, and a frozen quote feed is refused outright: one repeated price makes every expert agree at a phantom edge, so the veto fires before a single expert speaks and the scout scores the dead tape 0. The forecast aims duration + 1 ticks out, because the contract\u2019s ticks start when Deriv processes the buy, while the grading ledger always scores against the true contract length. Every published decision is filed with its quote and graded against the settling tick per side; after twenty graded decisions the estimate is pulled toward 50 % by the reliability ratio, and after forty a Wilson bound still under break-even sets stand-down and the bot stops buying until the record recovers. A market scout scores all fourteen Even/Odd markets (ten Volatility indices plus Jump 10/25/50/100) on measured EV, certainty, readability, sample and skill, and moves under the score floor \u2014 never more often than the 90-second dwell, because every switch trades a warm tick stream for a cold one. Every skip names its gate, every entry prints side, probability, quote, EV, sigma and record, every fifth settlement the two-sided forecast and live quotes, every tenth the self-audit, every twenty-fifth the expert league, the market DNA, the AI core and the reverse engineering. The full mechanics, mathematics and strategy survey are in docs/even-odd-research.md.',
    risk:
      'Even/Odd pays about 1.95\u00d7 on a near-fair digit stream, so the margin is about 1.3 points and a payable lean must be measured, not hoped \u2014 the bot says so itself when it refuses. It keeps a trading cadence by design: the better-EV side on every readable cycle, sized down to the exchange minimum when the read is thin \u2014 the journal prints the EV, quote and record behind every entry so the cost of the cadence is visible. A loss never raises the next stake: no martingale, no recovery ladder. Start on demo, keep the base stake small, and set a session loss limit.',
    accent: 'teal',
    icon: BrainCircuit,
    xml: aiEvenSwitcherXml,
  },
  {
    id: 'HIGH_LOW_TICK_SNIPER', name: 'High/Low Tick AI Sniper v6', category: 'AI', icon: BrainCircuit, accent: 'emerald',
    short: 'Sixteen experts, a deep online brain, regime-gated mixture and DNA v2 auto-reverse-engineering: it buys the position of the next five ticks that Deriv has actually mispriced, and stands itself down when its own graded record says the read is not there.',
    detail:
      'The contract is exact and narrow: of the next five quotes, which position prints the strict high, or the strict low? That is ten outcomes, and a window whose extreme is shared is a loss on both sides. v6 prices all ten. It reads the live TICKHIGH and TICKLOW quotes for positions 1\u20135 from Deriv\u2019s own proposal stream, computes p(1 + multiple) \u2212 1 for every outcome against the multiple it would really be paid, and buys the best-ranked position on every cycle it can read, sizing thin reads down to the exchange minimum \u2014 about one position per contract length. (Set the entry field to \u201conly with a measured edge\u201d and \u201cai min ev\u201d above zero to restore the selective sniper, which refuses everything below a one-sigma EV floor instead.) The structure it reasons from is measured, not assumed: a continuous random walk gives the discrete arcsine law (27.3 / 15.6 / 14.1 / 15.6 / 27.3 %), but a walk on a quote grid is a different animal \u2014 enumerating every five-step \u00b11 path gives 18.75 / 12.5 / 6.25 / 12.5 / 18.75 % with a tie in 31.25 % of windows \u2014 so the bot reverse-engineers this market (tie rate, grid ratio, drift, serial correlation, volatility regime, Hurst memory, extreme entropy, jump rate, phase persistence, tie clustering, compression), interpolates the prior between the two structures, derives its own auto-tuning from the diagnosis and publishes it all as a market DNA score. Sixteen experts answer the same question (tie-aware anchor, long-run history, the two-change Markov row, recent regime, kernel replay of similar moments, drift, positional persistence, a deep online neural net, a volatility-regime model, a Markov chain on the last settled extreme, an expansion-scaled volatility tilt, a microtrend pressure gauge, a granularity-range selector, an entropy concentration reader, a Hurst long-memory probe and an extreme-phase cycle reader); each is scored walk-forward with a Brier loss under a regime-gated meta-learner, so an expert that cannot read this market loses its vote on its own and the league table shows who is currently earning their weight. The estimate is then calibrated against the decisions the rule has already published, per outcome \u2014 an earned record sharpens it, a losing one pulls it back to the structural prior \u2014 and once forty decisions are graded a Wilson bound still under break-even sets stand-down and the bot stops buying until the record recovers. One tick of entry slip is charged, because the five ticks start when Deriv processes the buy, not when the model looked. Five ticks is not a duration until the tick rate is known: it measures seconds per tick, turns that into the contract\u2019s real length \u2014 ten seconds on R_100, five on a 1-second index \u2014 charges the measured look-to-fill slip as wasted window, prints the label fidelity that slip allows, and refuses a market it cannot be filled inside of rather than trading a window it did not score. The stake is tenth-Kelly on the calibrated probability and the quoted multiple, floored at the exchange minimum, capped by max stake and the balance percent, and divided by session drawdown; there is no martingale, and the session brakes are the loss limit, the profit target and the balance rule. Every skip names its gate, every tenth settlement prints the self-audit, every twenty-fifth the expert league, the market DNA, the AI core, the reverse engineering and the execution clock, every fifth the live payout ladder and the outcome forecast. A market scout scores every synthetic on measured EV, certainty, readability, sample and walk-forward skill, and can move the bot to a better market when the one it stands on stops being readable, never more often than the dwell time. The full mathematics \u2014 the 32-path enumeration, the granularity study, tie economics, every strategy family and the Python that reproduces them \u2014 is in docs/high-low-ticks-research.md.',
    risk: 'These are conditional historical estimates, not calibrated odds. Deriv prices this contract from the same mathematics, so a positive modelled EV means only that the bot\u2019s conditional read beats the pricing model\u2019s \u2014 a claim that is often false, which is why the bot grades itself and can stand down. A shared extreme still loses, ties are real (31 % of windows on a pure \u00b11 walk) and the ten quotes move. It keeps a trading cadence by design: the best-ranked of ten on every readable cycle, sized down to the exchange minimum when the read is thin — the journal prints the EV, quote and record behind every entry so the cost of the cadence is visible. Stake never rises after a loss. Start on demo, keep the base stake small, and set a session loss limit.',
    xml: highLowTickSniperXml,
  },
  {
    id: 'RISE_FALL_ENSEMBLE', name: 'Rise/Fall AI Ensemble', category: 'AI', icon: BrainCircuit, accent: 'blue',
    short: 'Sixteen experts on Step Index 100, mixed by measured skill, gated by regime and calibrated against their own graded record — it trades every five-tick cycle and shrinks the stake, not the bot, when the record slips.',
    detail: 'Sixteen experts answer the same question and are mixed by how well they have actually done: a structural anchor, the long-run step frequency, the Markov row for the current two-change state, the last 250 windows, a kernel replay of states that looked like this one, an analytical drift forecast, a serial-dependence fit, a deep online neural net, and a regime model that switches between continuation and mean reversion depending on whether volatility is expanding or the market is quiet and stretched, plus a position Markov chain, volatility, microtrend, range, entropy, Hurst and cycle readers. Each is scored walk-forward with a Brier loss, so a model that cannot read this market loses its vote on its own, and the blend is shrunk toward the base rate by its effective sample size. Two calibration layers sit on top: the rule grades every decision it publishes against the tick that settled it, and a record below the payout break-even pulls the estimate back toward the anchor instead of parking the bot; the stake is tenth-Kelly on that calibrated probability and the payout Deriv actually quotes, floored at the exchange minimum and capped by max stake and the balance percent. The horizon is the odd five-tick contract, so no window can tie, and a measured tie rate above the limit refuses the shape outright. Every skip explains itself, every fifth settlement prints the realised hit rate, every twenty-fifth prints which expert is carrying the decision.',
    risk: 'Estimates are historical and conditional, not calibrated odds, and Step Index is close to a fair random walk: expect a hit rate near the payout break-even and a stake that sits at the exchange minimum for long stretches. It trades every cycle by design; if you would rather trade only on evidence, set the decision block to "only with a measured edge". Staking never martingales — a loss lowers the next stake. Start on demo.',
    xml: riseFallEnsembleXml,
  },
  {
    id: 'STEP_RISE_FALL_HEDGE', name: 'Step Index Rise/Fall Hedge', category: 'AI', icon: BrainCircuit, accent: 'violet',
    short: 'The same sixteen-expert, self-calibrating read on Step Index 100, entering every cycle and covering the position with a fraction-sized opposite leg.',
    detail: 'Built to keep trading: the ensemble names the side on every tick it can read and the bot re-enters on the tick after each settlement — about two seconds after a contract closes on Step Index. Sixteen experts (anchor, step frequency, Markov transition, recent windows, kernel replay, drift, serial dependence, a deep online net, a regime-switching model, position chain, volatility, microtrend, range, entropy, Hurst and cycle readers) are mixed by measured walk-forward skill under a regime-gated meta-learner, the estimate is calibrated against the rule’s own graded record per outcome, and the stake is tenth-Kelly on the result. The hedge is partial: "hedge ratio" sizes the opposite leg as a fraction of the main stake, and when the stake is too small to clear Deriv’s minimum for that leg the bot buys the model’s side alone and says so, because two equal legs lock in a loss of the spread every cycle. Both legs are risk-checked together at the combined exposure before either order is sent, and After purchase waits for both to settle. Five ticks keeps the horizon odd, so no window can tie — four ticks ties 37.5 % of the time and measured at about −16 points against the break-even.',
    risk: 'A hedged pair gives up part of a confident lean by construction: the opposite leg wins on the ticks the main leg loses and costs the spread when it wins. Step Index is close to a fair random walk, so expect a hit rate near break-even and a stake at the exchange minimum for long stretches. Four-tick is available by setting "ai duration" to 4 and "ai max tie" to 0.5, and the entry line will show the tie rate you are paying. Test on demo first.',
    xml: stepRiseFallHedgeXml,
  },
];

const views: { id: SpaceView; label: string; icon: ComponentType<LucideProps> }[] = [
  { id: 'builder', label: 'Bot builder', icon: Boxes },
  { id: 'chart', label: 'Charts', icon: ChartNoAxesCombined },
  { id: 'store', label: 'Bot store', icon: Library },
];

/** Consecutive automatic link attempts before we stop and ask for a click. */
const MAX_AUTO_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 25_000;
const FEED_INTERVAL_MS = 1_000;

export function DbotSpace({ onOpenSettings }: { onOpenSettings: () => void }) {
  const trading = useDerivTrading();
  const feed = useMarketFeed();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const tradingRef = useRef(trading);
  tradingRef.current = trading;
  const [view, setView] = useState<SpaceView>('builder');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [linkState, setLinkState] = useState<LinkState>('idle');
  const [linkAccount, setLinkAccount] = useState('');
  const [linkType, setLinkType] = useState<'demo' | 'real' | 'unknown'>('unknown');
  const grantRef = useRef<string | null>(null);
  const grantRevisionRef = useRef(0);
  const pendingStrategy = useRef<string | null>(null);
  const pendingLoad = useRef<{ xml: string; fileName: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [aiRunNotice, setAiRunNotice] = useState('');
  const [blockRegistry, setBlockRegistry] = useState<DbotAiBlockInfo[]>([]);
  const [aiRuntimeRegistered, setAiRuntimeRegistered] = useState(false);
  const [botRunning, setBotRunning] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [details, setDetails] = useState<Strategy | null>(null);
  // Automatic linking is the default: the workspace uses whichever account is
  // connected in Signal Lab. Pausing is the only manual step, and it lasts
  // until the user links again.
  const [autoLink, setAutoLink] = useState(true);
  const autoFailuresRef = useRef(0);
  const [autoPaused, setAutoPaused] = useState(false);
  const [shared, setShared] = useState({ markets: 0, ticks: 0 });

  // Data already collected by Signal Lab is streamed into the workspace, so
  // the Signal Lab blocks read the same ticks the analysis used.
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const cursorRef = useRef<BridgeCursor>({});
  const accountSentRef = useRef<BridgeAccountMessage | null>(null);
  const subscribedRef = useRef(false);
  const buildSource = useCallback((): BridgeSourceMarket[] => (
    feedRef.current.getSnapshot().map((market) => ({
      symbol: market.symbol,
      name: market.name,
      pipSize: market.pipSize,
      ticks: market.ticks,
    }))
  ), []);

  const send = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ source: 'signal-lab', ...message }, window.location.origin);
  }, []);

  const clearAiAnalysis = useCallback(() => {
    send({ type: 'clear-analysis' });
  }, [send]);

  const loadAiStrategy = useCallback((xml: string, name: string) => {
    if (!readyRef.current) {
      setNotice('The DBot workspace is still loading. Try loading the AI strategy again in a moment.');
      return;
    }
    setView('builder');
    setAiRunNotice(`${name} is loading into the DBot workspace…`);
    send({ type: 'load-bot', xml, name });
  }, [send]);

  const loadAndRunAiStrategy = useCallback((xml: string, name: string, analysis: DbotAiAnalysisSnapshot) => {
    if (!readyRef.current) {
      setAiRunNotice('The DBot workspace is still loading. Run Analysis again once it is ready.');
      return;
    }
    if (linkState !== 'connected' || trading.status !== 'connected' || !trading.activeAccount) {
      setAiRunNotice('Connect the Signal Lab account to DBot before loading and running this strategy.');
      return;
    }
    if (botRunning) {
      setAiRunNotice('Stop the current DBot strategy before loading another one.');
      return;
    }
    setView('builder');
    setAiRunNotice(`${name} is loading with its exact analysis snapshot…`);
    send({ type: 'load-bot', xml, name, runAfterLoad: true, analysisSnapshot: analysis });
  }, [botRunning, linkState, send, trading.activeAccount, trading.status]);

  /** The account snapshot the workspace is allowed to see, or null. */
  const currentAccountMessage = useCallback((): BridgeAccountMessage | null => {
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (!account || session.status !== 'connected' || grantRef.current !== account.accountId) return null;
    return buildAccountMessage({
      accountId: account.accountId,
      accountType: account.accountType === 'real' ? 'real' : account.accountType === 'demo' ? 'demo' : 'unknown',
      balance: session.balance ?? account.balance,
      currency: session.currency || account.currency,
      openPositions: session.openPositions,
      closedPositions: session.closedPositions,
    });
  }, []);

  const sendAccount = useCallback(() => {
    const account = currentAccountMessage();
    if (!account || sameAccountState(accountSentRef.current, account)) return;
    accountSentRef.current = account;
    send({ ...account } as unknown as Record<string, unknown>);
  }, [currentAccountMessage, send]);

  /** Tell the workspace to forget the account when the link ends. */
  const clearSharedAccount = useCallback(() => {
    if (!accountSentRef.current) return;
    accountSentRef.current = null;
    send({ type: 'signal-lab-account', accountId: '' });
  }, [send]);

  /** Count one automatic failure; after MAX_AUTO_ATTEMPTS stop retrying. */
  const failAutoLink = useCallback(() => {
    autoFailuresRef.current += 1;
    if (autoFailuresRef.current >= MAX_AUTO_ATTEMPTS) setAutoPaused(true);
  }, []);

  const sendSnapshot = useCallback(() => {
    const source = buildSource();
    const snapshot = buildBridgeSnapshot(source);
    cursorRef.current = snapshot.cursor;
    if (snapshot.message) send({ ...snapshot.message } as unknown as Record<string, unknown>);
    sendAccount();
    const stats = bridgeStats(source);
    setShared({ markets: stats.markets, ticks: stats.ticks });
  }, [buildSource, send, sendAccount]);

  const link = useCallback(async (automatic: boolean) => {
    if (!readyRef.current) return;
    const session = tradingRef.current;
    const account = session.activeAccount;
    if (session.status !== 'connected' || !account || grantRef.current) return;
    grantRef.current = account.accountId;
    const revision = ++grantRevisionRef.current;
    setLinkState('connecting');
    setLinkAccount(account.accountId);
    setLinkType(account.accountType === 'real' ? 'real' : 'demo');
    setNotice(automatic
      ? `Linking ${account.accountId} from Signal Lab automatically…`
      : `Connecting DBot to ${account.accountId}…`);
    try {
      const socket = await session.createBotSocket();
      if (grantRevisionRef.current !== revision
        || grantRef.current !== socket.accountId
        || tradingRef.current.activeAccount?.accountId !== socket.accountId
        || tradingRef.current.status !== 'connected') return;
      send({ type: 'connect-account', grantId: revision, ...socket });
    } catch (error) {
      if (grantRevisionRef.current !== revision) return;
      grantRef.current = null;
      grantRevisionRef.current += 1;
      failAutoLink();
      setLinkState('idle');
      setLinkAccount('');
      setNotice(error instanceof Error ? error.message : 'Could not connect DBot to this account.');
    }
  }, [send, failAutoLink]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.source !== 'signal-lab-dbot') return;
      if (data.type === 'block-registry') {
        const blocks = Array.isArray(data.blocks) ? data.blocks.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const block = entry as Record<string, unknown>;
          if (typeof block.type !== 'string' || typeof block.name !== 'string' || typeof block.category !== 'string') return [];
          return [{
            type: block.type.slice(0, 120),
            name: block.name.slice(0, 120),
            category: block.category.slice(0, 80),
            description: typeof block.description === 'string' ? block.description.slice(0, 300) : '',
          }];
        }).slice(0, 800) : [];
        setBlockRegistry(blocks);
        setAiRuntimeRegistered(data.aiRuntimeRegistered === true);
      } else if (data.type === 'bot-status') {
        setBotRunning(data.running === true);
      } else if (data.type === 'bot-run-started') {
        setBotRunning(true);
        setAiRunNotice(typeof data.message === 'string' ? data.message : 'DBot started the loaded strategy.');
      } else if (data.type === 'ready') {
        readyRef.current = true;
        setReady(true);
        if (viewRef.current !== 'store') send({ type: 'navigate', tab: viewRef.current });
        if (pendingLoad.current) {
          send({ type: 'load-bot', ...pendingLoad.current });
          pendingLoad.current = null;
        }
        if (pendingStrategy.current) {
          send({ type: 'quick-strategy', strategy: pendingStrategy.current });
          pendingStrategy.current = null;
        }
        // The workspace asks for its own copy of Signal Lab's data as soon as
        // it is ready; answer here in case the request raced the load event.
        if (subscribedRef.current) sendSnapshot();
      } else if (data.type === 'feed-subscribe') {
        subscribedRef.current = true;
        sendSnapshot();
      } else if (data.type === 'quick-strategy-open') {
        // The embedded wizard's footer is fixed to the iframe, not to the host
        // viewport. Bring it above the host's fixed navigation on small screens.
        window.requestAnimationFrame(() => {
          const bottom = frameRef.current?.getBoundingClientRect().bottom;
          if (bottom && bottom > window.innerHeight - 90) window.scrollBy({ top: bottom - window.innerHeight + 90, behavior: 'smooth' });
        });
      } else if (data.type === 'active-tab' && viewRef.current !== 'store') {
        if (data.tab === 1) setView('builder');
        else if (data.tab === 2) setView('chart');
      } else if (data.type === 'account-connected' && data.accountId === grantRef.current && data.grantId === grantRevisionRef.current) {
        autoFailuresRef.current = 0;
        setAutoPaused(false);
        setLinkState('connected');
        setLinkAccount(String(data.accountId));
        setLinkType(tradingRef.current.activeAccount?.accountType === 'real' ? 'real' : 'demo');
        setNotice('DBot is using the Signal Lab account. Its ticks, balance and open positions are shared with the workspace.');
        sendSnapshot();
      } else if (data.type === 'account-disconnected' && data.grantId === grantRevisionRef.current) {
        grantRef.current = null;
        grantRevisionRef.current += 1;
        clearSharedAccount();
        setLinkState('idle');
        setLinkAccount('');
        setLinkType('unknown');
        if (data.reason === 'connection-lost') {
          failAutoLink();
          setNotice('The DBot connection closed, so the strategy was stopped. Open contracts may still settle. Reconnecting to the Signal Lab account…');
        }
      } else if (data.type === 'account-error' && data.grantId === grantRevisionRef.current) {
        grantRef.current = null;
        grantRevisionRef.current += 1;
        clearSharedAccount();
        failAutoLink();
        setLinkState('idle');
        setLinkAccount('');
        setLinkType('unknown');
        setNotice(typeof data.message === 'string' ? data.message : 'DBot could not connect the account.');
      } else if (data.type === 'bot-loaded') {
        const name = typeof data.name === 'string' ? data.name : 'The bot';
        const message = data.runAfterLoad === true
          ? `${name} loaded; DBot is starting the guarded strategy…`
          : `${name} is on the canvas. Review the market, stake and limits before you run it.`;
        setNotice(message);
        setAiRunNotice(message);
      } else if (data.type === 'error') {
        const message = typeof data.message === 'string' ? data.message : 'DBot could not complete that action.';
        setNotice(message);
        setAiRunNotice(message);
      } else if (data.type === 'request-otp' && typeof data.requestId === 'number') {
        const accountId = data.accountId;
        const requestId = data.requestId;
        const session = tradingRef.current;
        if (!grantRef.current || accountId !== grantRef.current || session.activeAccount?.accountId !== grantRef.current || session.status !== 'connected') {
          send({ type: 'otp-response', requestId, accountId, error: 'The selected Signal Lab account is no longer connected.' });
          return;
        }
        const revision = grantRevisionRef.current;
        void session.createBotSocket().then((socket) => {
          if (grantRevisionRef.current !== revision || grantRef.current !== accountId || tradingRef.current.activeAccount?.accountId !== accountId || tradingRef.current.status !== 'connected') {
            send({ type: 'otp-response', requestId, accountId, error: 'The account changed while reconnecting.' });
            return;
          }
          send({ type: 'otp-response', requestId, accountId, url: socket.url });
        }).catch((error: unknown) => send({ type: 'otp-response', requestId, accountId, error: error instanceof Error ? error.message : 'Could not reconnect DBot.' }));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [send, sendSnapshot, clearSharedAccount, failAutoLink]);

  // A grant belongs to one exact account. Switching or disconnecting in Settings
  // revokes it and stops the bot rather than quietly trading a different account.
  useEffect(() => {
    if (!grantRef.current) return;
    if (trading.activeAccount?.accountId !== grantRef.current || trading.status !== 'connected') {
      send({ type: 'disconnect-account', grantId: grantRevisionRef.current });
      clearSharedAccount();
      grantRef.current = null;
      grantRevisionRef.current += 1;
      autoFailuresRef.current = 0;
      setAutoPaused(false);
      setLinkState('idle');
      setLinkAccount('');
      setLinkType('unknown');
      setNotice('DBot was disconnected because the Signal Lab account changed or disconnected. Open contracts may still settle.');
    }
  }, [trading.activeAccount?.accountId, trading.status, send, clearSharedAccount]);

  // Automatic linking: as soon as the workspace is ready and Signal Lab has an
  // account, DBot links that exact account without a button or a dialog.
  useEffect(() => {
    if (!autoLink || !ready || linkState !== 'idle') return;
    if (trading.status !== 'connected' || !trading.activeAccount) return;
    if (grantRef.current || autoFailuresRef.current >= MAX_AUTO_ATTEMPTS) return;
    const delay = autoFailuresRef.current === 0 ? 0 : Math.min(6_000 * autoFailuresRef.current, 18_000);
    const timer = window.setTimeout(() => { void link(true); }, delay);
    return () => window.clearTimeout(timer);
  }, [autoLink, ready, linkState, trading.status, trading.activeAccount, link]);

  // Stop retrying automatically once the account that failed is gone: a new
  // account (or a manual reconnect) gets a fresh set of attempts.
  useEffect(() => {
    autoFailuresRef.current = 0;
    setAutoPaused(false);
  }, [trading.activeAccount?.accountId]);

  useEffect(() => {
    if (linkState !== 'connecting') return;
    const timer = window.setTimeout(() => {
      send({ type: 'disconnect-account', grantId: grantRevisionRef.current });
      clearSharedAccount();
      grantRef.current = null;
      grantRevisionRef.current += 1;
      failAutoLink();
      setLinkState('idle');
      setLinkAccount('');
      setLinkType('unknown');
      setNotice('DBot did not confirm the account connection. Check the connection and try again.');
    }, CONNECT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [linkState, send, clearSharedAccount, failAutoLink]);

  // Stream the ticks Signal Lab already holds into the workspace, one frame a
  // second with only the new ticks, plus the account snapshot when it changes.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      const source = buildSource();
      const update = buildBridgeUpdate(source, cursorRef.current);
      cursorRef.current = update.cursor;
      if (update.message) send({ ...update.message } as unknown as Record<string, unknown>);
      sendAccount();
      const stats = bridgeStats(source);
      setShared((previous) => (
        previous.markets === stats.markets && previous.ticks === stats.ticks
          ? previous
          : { markets: stats.markets, ticks: stats.ticks }
      ));
    }, FEED_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ready, buildSource, send, sendAccount]);

  function selectView(next: SpaceView) {
    setView(next);
    setNotice('');
    if (next !== 'store' && readyRef.current) send({ type: 'navigate', tab: next });
  }

  /** Manual link: resumes automatic linking after a pause. */
  async function connectAccount() {
    if (linkState !== 'idle') return;
    if (!ready) { setNotice('Wait for the bot workspace to finish connecting before linking an account.'); return; }
    if (trading.status !== 'connected' || !trading.activeAccount) { onOpenSettings(); return; }
    autoFailuresRef.current = 0;
    setAutoPaused(false);
    setAutoLink(true);
    await link(false);
  }

  function disconnectAccount() {
    if (!window.confirm('Stop the DBot link and pause automatic linking? Open contracts may continue to settle on Deriv.')) return;
    send({ type: 'disconnect-account', grantId: grantRevisionRef.current });
    clearSharedAccount();
    grantRef.current = null;
    grantRevisionRef.current += 1;
    setAutoLink(false);
    setLinkState('idle');
    setLinkAccount('');
    setLinkType('unknown');
    setNotice('DBot unlinked and automatic linking paused. Press Link account to resume.');
  }

  function useStrategy(strategy: Strategy) {
    const isOwnBot = Boolean(strategy.xml);
    if (!window.confirm(
      isOwnBot
        ? `Load ${strategy.name} into the bot builder? It replaces the blocks currently on the canvas, and its settings live in the "Run once at start" block.`
        : `Open ${strategy.name} in Quick strategy? Review the market, stake, and loss limits before creating or running it.`,
    )) return;
    setDetails(null);
    setView('builder');
    if (isOwnBot) {
      if (readyRef.current) send({ type: 'load-bot', xml: strategy.xml, fileName: strategy.name });
      else { pendingLoad.current = { xml: strategy.xml as string, fileName: strategy.name }; setNotice('The bot will load as soon as the workspace connects.'); }
      return;
    }
    if (readyRef.current) send({ type: 'quick-strategy', strategy: strategy.id });
    else { pendingStrategy.current = strategy.id; setNotice('The strategy form will open as soon as the workspace connects.'); }
  }

  const matching = STRATEGIES.filter((item) =>
    (category === 'All' || item.category === category)
    && `${item.name} ${item.short} ${item.category}`.toLowerCase().includes(search.toLowerCase().trim()),
  );

  const linkLabel = useMemo(() => {
    if (linkState === 'connected') return `Auto-linked · ${linkAccount}${linkType === 'real' ? ' (real)' : ''}`;
    if (linkState === 'connecting') return `Linking ${linkAccount || 'account'}…`;
    if (trading.status !== 'connected' || !trading.activeAccount) return 'Connect an account in Settings';
    if (autoPaused) return 'Automatic link failed';
    if (!autoLink) return 'Linking paused';
    return 'Waiting to link';
  }, [autoLink, autoPaused, linkAccount, linkState, linkType, trading.activeAccount, trading.status]);

  return (
    <section className="dbot-space mx-auto w-full max-w-[1700px]" data-testid="dbot-space">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[.16em] text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Build, test, automate
          </div>
          <h2 className="text-2xl font-extrabold tracking-[-.045em] sm:text-3xl">DBot Space</h2>
          <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">
            Build a strategy with visual blocks, explore live charts, or start with a bot from the store. DBot uses the Signal Lab account automatically and shares the ticks, balance and positions collected there.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Deriv-style account cluster: live balance with a Real/Demo switch.
              It drives the same Signal Lab account selection the connection
              card uses, so DBot re-links to whichever account is active. */}
          <div className="inline-flex items-center gap-2.5 rounded-full border border-border bg-card py-1 pl-1 pr-3" data-testid="dbot-balance-toggle">
            <div className="flex rounded-full bg-muted p-0.5" role="group" aria-label="Account type">
              {(['demo', 'real'] as const).map((kind) => {
                const account = trading.accounts.find((entry) => entry.accountType === kind);
                const active = (trading.activeAccount?.accountType ?? linkType) === kind && Boolean(trading.activeAccount);
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={active}
                    data-testid={`dbot-toggle-${kind}`}
                    title={account ? `Trade on the ${kind} account (${account.accountId})` : `No ${kind} account connected yet — add one in Settings`}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${active ? (kind === 'real' ? 'bg-emerald-500 text-white' : 'bg-sky-500 text-white') : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => {
                      if (active) return;
                      if (botRunning) { setNotice('Stop the running bot before switching between demo and real accounts.'); return; }
                      if (!account) { setNotice(`No ${kind} account is connected. Connect a Deriv account with a ${kind} account in Settings, then use this toggle.`); return; }
                      void trading.selectAccount(account.accountId);
                      setNotice(kind === 'real'
                        ? `Switched to your REAL account ${account.accountId}. Bots will trade real money — double-check stake and limits before running.`
                        : `Switched to your demo account ${account.accountId}. Bots trade virtual funds here.`);
                    }}
                  >
                    {kind}
                  </button>
                );
              })}
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-foreground" data-testid="dbot-balance" title="Balance of the active account">
              <Wallet size={13} className="text-primary" />
              {trading.activeAccount
                ? formatAmount(trading.balance, trading.currency || trading.activeAccount?.currency)
                : '—'}
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[10px] font-semibold text-muted-foreground" data-testid="dbot-account-status">
            <span className={`h-1.5 w-1.5 rounded-full ${linkState === 'connected' ? 'bg-emerald-400' : linkState === 'connecting' ? 'bg-sky-400' : 'bg-amber-400'}`} />
            {linkLabel}
          </span>
          {linkState === 'connected' ? (
            <button type="button" onClick={disconnectAccount} className="dbot-outline-button" data-testid="dbot-disconnect-account"><Unlink size={14} /> Unlink</button>
          ) : (
            <button type="button" onClick={() => void connectAccount()} disabled={linkState === 'connecting'} className="dbot-outline-button" data-testid="dbot-connect-account">
              {linkState === 'connecting' ? <LoaderCircle className="animate-spin" size={14} /> : <Link2 size={14} />}
              {linkState === 'connecting' ? 'Linking…' : trading.status === 'connected' ? (autoLink ? 'Link now' : 'Link account') : 'Connect account'}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <div className="flex gap-1" role="tablist" aria-label="DBot Space sections">
          {views.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => selectView(id)} data-testid={`dbot-view-${id}`}
              className={`focus-ring -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3 text-xs font-bold transition-colors sm:px-4 sm:text-sm ${view === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <div className="hidden items-center gap-1.5 pb-2 text-[10px] font-medium text-muted-foreground sm:flex"><LockKeyhole size={12} /> Keep this browser tab open while running</div>
      </div>

      {notice && <div role="status" className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs leading-5 text-foreground" data-testid="dbot-notice"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss message" className="text-muted-foreground"><X size={14} /></button></div>}

      {/* Keep the frame mounted while viewing the store; unloading it would stop a running bot. */}
      <div className={view === 'store' ? 'hidden' : 'mt-4'}>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 sm:px-4">
            <div className="flex items-center gap-2 text-[11px] font-bold"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary"><Boxes size={13} /></span> Deriv Bot workspace <span className="hidden font-normal text-muted-foreground sm:inline">/ {view === 'chart' ? 'Charts' : 'Builder'}</span></div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid="dbot-shared-data" title="Ticks Signal Lab has collected and shares with the workspace">
                <Signal size={12} className={shared.ticks ? 'text-primary' : ''} />
                {shared.ticks
                  ? `${shared.markets} markets · ${shared.ticks.toLocaleString()} ticks shared`
                  : 'Waiting for Signal Lab ticks'}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid="dbot-workspace-status"><span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-400'}`} />{ready ? 'Workspace ready' : 'Connecting workspace'}</span>
              <button type="button" onClick={() => {
                const frame = frameRef.current;
                if (!frame?.requestFullscreen) { setNotice('Full screen is not available in this browser.'); return; }
                void frame.requestFullscreen().catch(() => setNotice('Full screen could not be opened in this browser.'));
              }} className="inline-flex items-center gap-1 text-[10px] font-bold text-primary hover:underline" title="Expand this workspace without reloading it" data-testid="dbot-fullscreen"><Maximize2 size={12} /> <span className="hidden sm:inline">Full screen</span></button>
            </div>
          </div>
          <iframe ref={frameRef} src={`${import.meta.env.BASE_URL}dbot/index.html#bot_builder`} title="Deriv Bot workspace" allow="fullscreen" allowFullScreen className="block w-full bg-white" style={{ height: 'min(850px, calc(100dvh - 160px))', minHeight: 480 }} data-testid="dbot-frame" onLoad={() => {
            readyRef.current = false;
            setReady(false);
            setBlockRegistry([]);
            setAiRuntimeRegistered(false);
            setBotRunning(false);
            setAiRunNotice('');
            subscribedRef.current = false;
            cursorRef.current = {};
            accountSentRef.current = null;
            if (grantRef.current) {
              grantRef.current = null;
              grantRevisionRef.current += 1;
              setLinkState('idle');
              setLinkAccount('');
              setLinkType('unknown');
              setNotice('The workspace reloaded and the account link ended. A running strategy has stopped; open contracts may still settle. Reconnecting…');
            }
            send({ type: 'hello' });
          }} />
        </div>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <p className="flex max-w-3xl items-start gap-2 text-[11px] leading-5 text-muted-foreground"><CircleHelp className="mt-0.5 shrink-0" size={13} /> Drag blocks from the menu, connect them to your strategy, and use the builder’s import and save controls for XML files. The <strong className="font-semibold text-foreground">Signal Lab</strong> block group reads the ticks, balance and positions this app already collected. A running bot needs this browser tab to remain open.</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-[10px] text-muted-foreground" data-testid="dbot-access-summary">
            <span className={`h-1.5 w-1.5 rounded-full ${linkState === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {linkState === 'connected' ? (
              <>
                <span className="font-semibold text-foreground">{linkAccount}</span>
                <span aria-hidden>·</span>
                <span>{formatAmount(trading.balance, trading.currency || trading.activeAccount?.currency)} balance</span>
                <span aria-hidden>·</span>
                <span>{trading.openPositions.length} open {trading.openPositions.length === 1 ? 'position' : 'positions'}</span>
                <span aria-hidden>·</span>
                <span>{shared.markets} markets shared</span>
                <span aria-hidden>·</span>
                <span>trading enabled</span>
              </>
            ) : (
              <span>Account, ticks and trading link automatically once Signal Lab is connected</span>
            )}
          </div>
        </div>
      </div>

      {view === 'store' && (
        <div className="py-5" data-testid="dbot-store">
          <div className="dbot-store-intro flex flex-wrap items-center justify-between gap-5 rounded-xl border border-primary/20 p-5 sm:p-6">
            <div><span className="dbot-kicker"><Sparkles size={12} /> STRATEGY LIBRARY</span><h3 className="mt-2 text-xl font-extrabold tracking-[-.035em]">A head start for your next bot.</h3><p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground sm:text-sm">Explore Deriv’s quick strategies, set your own parameters, and open the generated blocks in the builder.</p></div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card/75 px-3 py-2 text-xs font-semibold"><Library size={15} className="text-primary" /><span>{STRATEGIES.length} strategies</span></div>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-sm font-extrabold">Explore strategies</h3><p className="mt-1 text-[11px] text-muted-foreground">Free templates · customisable before use</p></div>
            <div className="flex flex-wrap gap-2">
              <label className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search strategies" aria-label="Search strategies" data-testid="dbot-store-search" className="h-9 w-48 rounded-lg border border-border bg-card pl-9 pr-3 text-xs outline-none focus:border-primary" /></label>
              <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter strategies" className="h-9 rounded-lg border border-border bg-card px-3 text-xs font-semibold outline-none focus:border-primary" data-testid="dbot-store-filter"><option>All</option><option>AI</option><option>Progression</option><option>Reverse progression</option><option>Sequence</option></select>
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {matching.map((strategy) => {
              const Icon = strategy.icon;
              return <article key={strategy.id} className="dbot-strategy-card flex min-h-[210px] flex-col rounded-xl border border-border bg-card p-4" data-testid={`dbot-strategy-${strategy.id}`}>
                <div className="flex items-start justify-between gap-3"><span className={`dbot-strategy-icon dbot-icon-${strategy.accent}`}><Icon size={19} /></span><span className="rounded-full border border-border px-2 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground">{strategy.category}</span></div>
                <h4 className="mt-4 text-sm font-extrabold tracking-tight">{strategy.name}</h4>
                <p className="mt-1.5 flex-1 text-xs leading-5 text-muted-foreground">{strategy.short}</p>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3"><button type="button" onClick={() => setDetails(strategy)} className="text-[11px] font-semibold text-muted-foreground hover:text-foreground">Learn more</button><button type="button" onClick={() => useStrategy(strategy)} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-primary hover:underline" data-testid={`dbot-use-${strategy.id}`}>Use strategy <ArrowRight size={13} /></button></div>
              </article>;
            })}
          </div>
          {!matching.length && <div className="mt-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No strategies match that search. Try another term or filter.</div>}
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[.06] p-4 text-xs leading-5 text-muted-foreground"><ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber-500" /><p><strong className="text-foreground">Trade responsibly.</strong> These are staking templates, not predictions or guarantees. Every strategy can lose money; review the generated blocks and test on a demo account first.</p></div>
        </div>
      )}

      {details && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" role="presentation" onMouseDown={() => setDetails(null)}><div role="dialog" aria-modal="true" aria-labelledby="dbot-details-title" className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-3"><div><div className="dbot-kicker"><BookOpen size={12} /> STRATEGY DETAILS</div><h3 id="dbot-details-title" className="mt-2 text-xl font-extrabold">{details.name}</h3></div><button type="button" onClick={() => setDetails(null)} aria-label="Close strategy details" className="rounded-md p-1 text-muted-foreground hover:bg-secondary"><X size={18} /></button></div><p className="mt-4 text-sm leading-6 text-muted-foreground">{details.detail}</p><p className="mt-4 rounded-lg bg-amber-500/10 p-3 text-xs leading-5 text-amber-600 dark:text-amber-300"><strong>Risk note:</strong> {details.risk}</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDetails(null)} className="dbot-outline-button">Close</button><button type="button" onClick={() => useStrategy(details)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"><CheckCircle2 size={14} /> Use strategy</button></div></div></div>}

      <DbotAiCopilot
        ready={ready}
        accountConnected={linkState === 'connected'}
        accountType={linkType}
        botRunning={botRunning}
        aiRuntimeRegistered={aiRuntimeRegistered}
        blockRegistry={blockRegistry}
        runNotice={aiRunNotice}
        onClearAnalysis={clearAiAnalysis}
        onLoadStrategy={loadAiStrategy}
        onLoadAndRun={loadAndRunAiStrategy}
      />
    </section>
  );
}
