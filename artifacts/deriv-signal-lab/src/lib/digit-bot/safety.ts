// ENGINE N — Safety engine.
//
// Safety is deliberately separate from risk: the risk engine decides whether a
// trade fits the configured limits, while this engine decides whether the bot
// is permitted to operate at all. Stopping or pausing the bot only blocks new
// purchases; it never cancels or misreports a contract that Deriv has already
// accepted.
import type { BotMode, BotRunState, EngineFinding, ReasonCode, SafetyState } from './types.ts';

export function createSafetyState(): SafetyState {
  return {
    runState: 'idle',
    manualPause: false,
    autoPauseReasons: [],
    reasonCodes: [],
    canPurchase: false,
    lastStopAt: null,
    lastStopBy: null,
  };
}

function finalize(state: SafetyState, mode: BotMode): SafetyState {
  const reasonCodes: ReasonCode[] = [];
  if (state.manualPause) reasonCodes.push('MANUAL_PAUSE');
  for (const reason of state.autoPauseReasons) {
    const code = reason.toLowerCase().includes('balance')
      ? 'BALANCE_DISCREPANCY'
      : reason.toLowerCase().includes('authoriz') || reason.toLowerCase().includes('token')
        ? 'ACCOUNT_UNAUTHORIZED'
        : 'CONNECTION_INTERRUPTED';
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
  }
  const canPurchase = state.runState === 'running'
    && !state.manualPause
    && state.autoPauseReasons.length === 0
    && mode === 'live';
  return { ...state, reasonCodes, canPurchase };
}

export function startBot(state: SafetyState, mode: BotMode): SafetyState {
  return finalize({ ...state, runState: 'running', manualPause: false }, mode);
}

export function pauseBot(state: SafetyState, mode: BotMode): SafetyState {
  return finalize({ ...state, runState: 'paused', manualPause: true }, mode);
}

export function resumeBot(state: SafetyState, mode: BotMode): SafetyState {
  return finalize({ ...state, runState: 'running', manualPause: false }, mode);
}

/** Stops the bot without pretending anything already purchased was cancelled. */
export function stopBot(state: SafetyState, mode: BotMode, options: { now: number; by: 'user' | 'system' } = { now: Date.now(), by: 'user' }): SafetyState {
  return finalize({
    ...state,
    runState: 'stopped',
    manualPause: true,
    lastStopAt: options.now,
    lastStopBy: options.by,
  }, mode);
}

/** Registers an automatic pause cause; duplicates are collapsed. */
export function registerAutoPause(state: SafetyState, reason: string, mode: BotMode): SafetyState {
  if (state.autoPauseReasons.includes(reason)) return finalize(state, mode);
  return finalize({
    ...state,
    autoPauseReasons: [...state.autoPauseReasons, reason],
    runState: state.runState === 'running' ? 'paused' : state.runState,
  }, mode);
}

/** Clears one automatic pause cause once the condition is genuinely over. */
export function clearAutoPause(state: SafetyState, matcher: (reason: string) => boolean, mode: BotMode): SafetyState {
  const autoPauseReasons = state.autoPauseReasons.filter((reason) => !matcher(reason));
  // An automatic pause is a temporary interlock: once its last cause is over and
  // the user has not paused or stopped the bot themselves, it runs again.
  const wasAutoPaused = state.runState === 'paused' && !state.manualPause;
  const runState = wasAutoPaused && autoPauseReasons.length === 0 ? 'running' : state.runState;
  return finalize({ ...state, runState, autoPauseReasons }, mode);
}

export function setRunState(state: SafetyState, runState: BotRunState, mode: BotMode): SafetyState {
  return finalize({ ...state, runState }, mode);
}

export function safetyFinding(state: SafetyState, mode: BotMode): EngineFinding<SafetyState> {
  const reasons: string[] = [];
  if (state.manualPause) reasons.push('The bot is paused or stopped; new purchases are blocked. Contracts already bought continue to be monitored.');
  reasons.push(...state.autoPauseReasons);
  if (!reasons.length) reasons.push('No safety interlock is active.');
  return {
    engine: 'N',
    name: 'Safety engine',
    status: state.manualPause || state.autoPauseReasons.length ? 'blocked' : 'ok',
    dataQuality: 1,
    confidence: null,
    findings: state,
    reasons,
  };
}
