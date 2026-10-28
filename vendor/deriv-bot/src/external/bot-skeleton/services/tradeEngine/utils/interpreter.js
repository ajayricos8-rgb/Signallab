import { isMultiplierContract } from '@/components/shared';
import cloneThorough from '@/utils/clone';
import JSInterpreter from '@deriv/js-interpreter';
import { unrecoverable_errors } from '../../../constants/messages';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import Interface from '../Interface';
import { createScope } from './cliTools';

JSInterpreter.prototype.takeStateSnapshot = function () {
    const newStateStack = cloneThorough(this.stateStack, undefined, undefined, undefined, true);
    return newStateStack;
};

JSInterpreter.prototype.restoreStateSnapshot = function (snapshot) {
    this.stateStack = cloneThorough(snapshot, undefined, undefined, undefined, true);
    this.global = this.stateStack[0].scope.object || this.stateStack[0].scope;
    this.initFunc_(this, this.global);
};

const botInitialized = bot => bot && bot.tradeEngine.options;
const botStarted = bot => botInitialized(bot) && bot.tradeEngine.tradeOptions;
const shouldRestartOnError = (bot, errorName = '') =>
    !unrecoverable_errors.includes(errorName) && botInitialized(bot) && bot.tradeEngine.options.shouldRestartOnError;

const shouldStopOnError = (bot, errorName = '') => {
    const stopErrors = ['SellNotAvailableCustom', 'ContractCreationFailure', 'InvalidtoBuy'];
    if (stopErrors.includes(errorName) && botInitialized(bot)) {
        return true;
    }
    return false;
};

const timeMachineEnabled = bot => botInitialized(bot) && bot.tradeEngine.options.timeMachineEnabled;

// TODO chek beforState & duringState & startState
const Interpreter = () => {
    let $scope = createScope();
    let bot = Interface($scope);
    let interpreter = {};
    let onFinish;

    $scope.observer.register('REVERT', watchName =>
        revert(watchName === 'before' ? $scope.beforeState : $scope.duringState)
    );

    function revert(state) {
        interpreter.restoreStateSnapshot(state);
        interpreter.paused_ = false;
        loop();
    }

    function loop() {
        if ($scope.stopped || !interpreter.run()) {
            onFinish(interpreter.pseudoToNative(interpreter.value));
        }
    }

    function createAsync(js_interpreter, func, resumeOnError = true) {
        const asyncFunc = (...args) => {
            const callback = args.pop();

            // Workaround for unknown number of args
            const reversed_args = args.slice().reverse();
            const first_defined_arg_idx = reversed_args.findIndex(arg => arg !== undefined);

            // Remove extra undefined args from end of the args
            const function_args = first_defined_arg_idx < 0 ? [] : reversed_args.slice(first_defined_arg_idx).reverse();
            // End of workaround

            // Promise.resolve().then(...) so a Bot.* function that returns a
            // plain value — or throws synchronously — behaves exactly like an
            // async one. Calling .then on a non-promise used to throw inside
            // the interpreter step, which killed loop() mid-flight: the run
            // promise never settled and the workspace sat on "Bot is
            // starting" forever. A custom block must never be able to wedge
            // the trading loop that way.
            Promise.resolve()
                .then(() => func(...function_args.map(arg => js_interpreter.pseudoToNative(arg))))
                .then(rv => {
                    callback(js_interpreter.nativeToPseudo(rv));
                    loop();
                })
                .catch(e => {
                    // e.error for errors get from API, e for code errors
                    $scope.observer.emit('Error', e.error || e);
                    // A failed read must not wedge the trading loop either:
                    // without a callback the interpreter stays paused on this
                    // call forever and the bot silently stops trading. Hand
                    // the strategy an undefined result and carry on. Order
                    // placement opts out (resumeOnError = false): its own
                    // revert/retry machinery decides how execution continues,
                    // and resuming blindly past a failed buy would corrupt
                    // the before/during-purchase scope machine.
                    if (resumeOnError) {
                        callback(js_interpreter.nativeToPseudo(undefined));
                        loop();
                    }
                });
        };

        // TODO: This is a workaround, create issue on original repo, once fixed
        // remove this. We don't know how many args are going to be passed, so we
        // assume a max of 100.
        const MAX_ACCEPTABLE_FUNC_ARGS = 100;
        Object.defineProperty(asyncFunc, 'length', { value: MAX_ACCEPTABLE_FUNC_ARGS + 1 });
        return js_interpreter.createAsyncFunction(asyncFunc);
    }

    function initFunc(js_interpreter, scope) {
        const bot_interface = bot.getInterface();
        const {
            getTicksInterface,
            getSignalLabInterface,
            getVisionInterface,
            alert,
            prompt,
            sleep,
            console: custom_console,
        } = bot_interface;
        const ticks_interface = getTicksInterface;
        const signal_lab_interface = getSignalLabInterface;
        const vision_interface = getVisionInterface;

        js_interpreter.setProperty(scope, 'console', js_interpreter.nativeToPseudo(custom_console));
        js_interpreter.setProperty(scope, 'alert', js_interpreter.nativeToPseudo(alert));
        js_interpreter.setProperty(scope, 'prompt', js_interpreter.nativeToPseudo(prompt));
        js_interpreter.setProperty(
            scope,
            'getPurchaseReference',
            js_interpreter.nativeToPseudo(bot_interface.getPurchaseReference)
        );

        const pseudo_bot_interface = js_interpreter.nativeToPseudo(bot_interface);

        Object.entries(ticks_interface).forEach(([name, f]) =>
            js_interpreter.setProperty(pseudo_bot_interface, name, createAsync(js_interpreter, f))
        );

        // Signal Lab data blocks: ticks collected by the parent app plus the
        // account snapshot it shares. Same async wrapping, so a script sees a
        // plain value and waits while the parent's snapshot is in flight.
        Object.entries(signal_lab_interface).forEach(([name, f]) =>
            js_interpreter.setProperty(pseudo_bot_interface, name, createAsync(js_interpreter, f))
        );

        // Vision Lab blocks: the analysis, AI, risk and shortcut library. Every
        // call is async-wrapped so a strategy sees a plain value even though the
        // heavy maths runs outside the interpreter.
        Object.entries(vision_interface || {}).forEach(([name, f]) =>
            js_interpreter.setProperty(pseudo_bot_interface, name, createAsync(js_interpreter, f))
        );

        js_interpreter.setProperty(
            pseudo_bot_interface,
            'start',
            js_interpreter.nativeToPseudo((...args) => {
                const { start } = bot_interface;
                if (shouldRestartOnError(bot)) {
                    $scope.startState = js_interpreter.takeStateSnapshot();
                }
                try {
                    start(...args);
                } catch (e) {
                    // Bot.start runs natively inside an interpreter step: a
                    // synchronous throw (e.g. a custom limit reached) would
                    // abort the whole program with no error shown anywhere —
                    // the bot just silently stops. Route it through the same
                    // error handling as every other failure instead.
                    $scope.observer.emit('Error', e?.error || e);
                }
            })
        );

        js_interpreter.setProperty(
            pseudo_bot_interface,
            'purchase',
            createAsync(js_interpreter, bot_interface.purchase, false)
        );
        js_interpreter.setProperty(
            pseudo_bot_interface,
            'purchaseHedge',
            createAsync(js_interpreter, bot_interface.purchaseHedge, false)
        );
        js_interpreter.setProperty(
            pseudo_bot_interface,
            'sellAtMarket',
            createAsync(js_interpreter, bot_interface.sellAtMarket, false)
        );
        js_interpreter.setProperty(scope, 'Bot', pseudo_bot_interface);
        js_interpreter.setProperty(
            scope,
            'watch',
            createAsync(
                js_interpreter,
                watchName => {
                    const { watch } = bot.getInterface();

                    if (timeMachineEnabled(bot)) {
                        const snapshot = interpreter.takeStateSnapshot();
                        if (watchName === 'before') {
                            $scope.beforeState = snapshot;
                        } else {
                            $scope.duringState = snapshot;
                        }
                    }

                    return watch(watchName);
                },
                false
            )
        );

        js_interpreter.setProperty(scope, 'sleep', createAsync(js_interpreter, sleep));
    }

    async function stop() {
        return new Promise((resolve, reject) => {
            try {
                const global_timeouts = globalObserver.getState('global_timeouts') ?? [];
                const is_timeouts_cancellable = Object.keys(global_timeouts).every(
                    timeout => global_timeouts[timeout].is_cancellable
                );

                if (!bot.tradeEngine.contractId && is_timeouts_cancellable) {
                    api_base.is_stopping = true;
                    // When user is rate limited, allow them to stop the bot immediately
                    // granted there is no active contract.
                    global_timeouts.forEach(timeout => clearTimeout(global_timeouts[timeout]));
                    terminateSession().then(() => {
                        api_base.is_stopping = false;
                        resolve();
                    });
                } else if (
                    bot.tradeEngine.isSold === false &&
                    !$scope.is_error_triggered &&
                    isMultiplierContract(bot?.tradeEngine?.data?.contract?.contract_type ?? '')
                ) {
                    globalObserver.register('contract.status', async contractStatus => {
                        if (contractStatus.id === 'contract.sold') {
                            terminateSession().then(() => resolve());
                        }
                    });
                } else {
                    api_base.is_stopping = true;
                    terminateSession().then(() => {
                        api_base.is_stopping = false;
                        resolve();
                    });
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    async function terminateSession() {
        return new Promise((resolve, reject) => {
            try {
                $scope.stopped = true;
                $scope.is_error_triggered = false;
                globalObserver.emit('bot.stop');
                const { ticksService } = $scope;
                // Unsubscribe previous ticks_history subscription
                // Unsubscribe the subscriptions from Proposal, Balance and OpenContract
                api_base.clearSubscriptions();

                ticksService.unsubscribeFromTicksService().then(() => {
                    resolve();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    async function unsubscribeFromTicksService() {
        const { ticksService } = $scope;
        return new Promise((resolve, reject) => {
            try {
                ticksService.unsubscribeFromTicksService().then(() => {
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function run(code) {
        return new Promise((resolve, reject) => {
            const onError = e => {
                if ($scope.stopped) {
                    return;
                }
                // DBot handles 'InvalidToken' internally
                if (e.code === 'InvalidToken') {
                    globalObserver.emit('client.invalid_token');
                    return;
                }
                if (shouldStopOnError(bot, e?.code)) {
                    globalObserver.emit('ui.log.error', e.message);
                    globalObserver.emit('bot.click_stop');
                    return;
                }

                // A running bot stops only when the user stops it, when a
                // configured limit ends it (CustomLimitsReached), or when
                // the failure is genuinely unrecoverable (insufficient
                // balance, contract validation, authentication...).
                // Everything else — a flaky proposal renewal, a timed-out
                // tick read, a momentary API error — is a journal entry,
                // not a stop signal: purchases and sells revert/retry
                // through their own machinery, background proposal
                // requests renew themselves, and plain reads resume with
                // an undefined result. The old behaviour tore the session
                // down and tried to restart into a fresh interpreter that
                // was never actually created, so one transient error (a
                // matter of time on any long run) silently killed the bot.
                if (unrecoverable_errors.includes(e?.code) || !botStarted(bot)) {
                    $scope.is_error_triggered = true;
                    reject(e);
                    return;
                }

                globalObserver.emit('Error', e);
            };

            $scope.observer.register('Error', onError);

            interpreter = new JSInterpreter(code, initFunc);
            onFinish = resolve;

            loop();
        });
    }

    return { stop, run, terminateSession, bot, unsubscribeFromTicksService };
};
export default Interpreter;

export const createInterpreter = () => new Interpreter();
