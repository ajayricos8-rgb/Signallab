// ENGINE N — Safety and emergency stop engine.
//
// Safety is deliberately separate from risk: the risk engine decides whether a
// trade fits the configured limits, while this engine decides whether the bot
// is permitted to operate at all. Nothing can purchase while the emergency stop
// is engaged, and stopping never cancels or misreports a contract that Deriv
// has already accepted.
import type { BotMode, BotRunState, EngineFinding, ReasonCode, SafetyState } from './types.ts';

export function createSafetyState(): SafetyState {
  return {
    runState: 'idle',
    emergencyStop: false,
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
  if (state.emergencyStop) reasonCodes.push('EMERGENCY_STOP');
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
    && !state.emergencyStop
    && !state.manualPause
    && state.autoPauseReasons.length === 0
    && mode === 'live';
  return { ...state, reasonCodes, canPurchase };
}

export function startBot(state: SafetyState, mode: BotMode): SafetyState {
  if (state.emergencyStop) return finalize({ ...state, runState: 'emergency' }, mode);
  return finalize({ ...state, runState: 'running', manualPause: false }, mode);
}

export function pauseBot(state: SafetyState, mode: BotMode): SafetyState {
  return finalize({ ...state, runState: state.emergencyStop ? 'emergency' : 'paused', manualPause: true }, mode);
}

export function resumeBot(state: SafetyState, mode: BotMode): SafetyState {
  if (state.emergencyStop) return finalize({ ...state, runState: 'emergency' }, mode);
  return finalize({ ...state, runState: 'running', manualPause: false }, mode);
}

/** Stops the bot without pretending anything already purchased was cancelled. */
export function stopBot(state: SafetyState, mode: BotMode, options: { now: number; by: 'user' | 'system' } = { now: Date.now(), by: 'user' }): SafetyState {
  return finalize({
    ...state,
    runState: state.emergencyStop ? 'emergency' : 'stopped',
    manualPause: true,
    lastStopAt: options.now,
    lastStopBy: options.by,
  }, mode);
}

/**
 * Immediately blocks every new purchase. Contracts already bought on the
 * account stay open and continue to be monitored until Deriv settles them.
 */
export function engageEmergencyStop(state: SafetyState, options: { now: number; by: 'user' | 'system'; reason?: string } = { now: Date.now(), by: 'user' }): SafetyState {
  const autoPauseReasons = options.reason && !state.autoPauseReasons.includes(options.reason)
    ? [...state.autoPauseReasons, options.reason]
    : state.autoPauseReasons;
  return finalize({
    ...state,
    emergencyStop: true,
    runState: 'emergency',
    lastStopAt: options.now,
    lastStopBy: options.by,
    autoPauseReasons,
  }, 'analysis');
}

export function releaseEmergencyStop(state: SafetyState, mode: BotMode): SafetyState {
  return finalize({ ...state, emergencyStop: false, runState: state.manualPause ? 'paused' : 'idle' }, mode);
}

/** Registers an automatic pause cause; duplicates are collapsed. */
export function registerAutoPause(state: SafetyState, reason: string, mode: BotMode): SafetyState {
  if (state.autoPauseReasons.includes(reason)) return finalize(state, mode);
  return finalize({
    ...state,
    autoPauseReasons: [...state.autoPauseReasons, reason],
    runState: state.emergencyStop ? 'emergency' : state.runState === 'running' ? 'paused' : state.runState,
  }, mode);
}

/** Clears one automatic pause cause once the condition is genuinely over. */
export function clearAutoPause(state: SafetyState, matcher: (reason: string) => boolean, mode: BotMode): SafetyState {
  const autoPauseReasons = state.autoPauseReasons.filter((reason) => !matcher(reason));
  // An automatic pause is a temporary interlock: once its last cause is over and
  // the user has not paused or stopped the bot themselves, it runs again.
  const wasAutoPaused = state.runState === 'paused' && !state.manualPause;
  const runState = wasAutoPaused && autoPauseReasons.length === 0 && !state.emergencyStop ? 'running' : state.runState;
  return finalize({ ...state, runState, autoPauseReasons }, mode);
}

export function setRunState(state: SafetyState, runState: BotRunState, mode: BotMode): SafetyState {
  return finalize({ ...state, runState }, mode);
}

export function safetyFinding(state: SafetyState, mode: BotMode): EngineFinding<SafetyState> {
  const reasons: string[] = [];
  if (state.emergencyStop) reasons.push('Emergency stop engaged: new purchases are blocked. Contracts already bought continue to be monitored.');
  if (state.manualPause) reasons.push('The bot is paused.');
  reasons.push(...state.autoPauseReasons);
  if (!reasons.length) reasons.push('No safety interlock is active.');
  return {
    engine: 'N',
    name: 'Safety and emergency stop engine',
    status: state.emergencyStop || state.manualPause || state.autoPauseReasons.length ? 'blocked' : 'ok',
    dataQuality: 1,
    confidence: null,
    findings: state,
    reasons,
  };
}
