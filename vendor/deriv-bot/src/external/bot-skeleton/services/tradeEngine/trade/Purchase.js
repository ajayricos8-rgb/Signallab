import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy, tradeOptionToProposal } from '../utils/helpers';
import { sanitizeHedgeOptions } from '../utils/hedge-options.mjs';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type, predictionOverride) {
            if (predictionOverride !== undefined &&
                (!['TICKHIGH', 'TICKLOW'].includes(contract_type) || !Number.isInteger(predictionOverride) || predictionOverride < 1 || predictionOverride > 5)) {
                throw new Error('High/Low Tick prediction must be an integer from 1 to 5.');
            }
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            if (this.is_proposal_subscription_required && predictionOverride === undefined) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, predictionOverride === undefined ? this.tradeOptions : { ...this.tradeOptions, prediction: predictionOverride });
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            // An analysis-selected tick must never be silently retried after
            // a lost response: the first request may already have been filled,
            // and the old prediction is no longer a current signal.
            if (predictionOverride !== undefined) return action().then(onSuccess);
            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        /**
         * Buy BOTH sides of a hedge in one before-purchase pass. Both legs
         * stake the trade-options amount; each leg carries its own
         * prediction/barrier offsets from the hedge block's Purchase 1 /
         * Purchase 2 rows (`main_options` / `hedge_options`:
         * { prediction, barrierOffset, secondBarrierOffset }) — e.g. Over 2
         * hedged with Under 7, or a Higher at +1.5 hedged with a Lower at
         * -1.5. Those block values are authoritative: the Trade options
         * barrier/prediction is not merged into a leg that carries its own.
         * The two buy
         * requests are sent together, so both positions open in the same
         * second, and the engine then waits for BOTH contracts to settle
         * before After purchase runs (see OpenContract). Contract-detail
         * blocks keep reading the main leg; totals, runs and the contract
         * log count each leg.
         */
        purchaseHedge(contract_type, hedge_contract_type, main_options = {}, hedge_options = {}) {
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }
            if (this.hedgeIncomplete) {
                throw new Error('A hedge previously opened only one leg. Inspect the account and restart the bot before trading again.');
            }
            if (!hedge_contract_type || hedge_contract_type === contract_type) {
                return this.purchase(contract_type);
            }

            // The hedge block's Purchase 1 / Purchase 2 rows are the ONLY
            // place a hedge leg's prediction/barriers are configured, so a
            // leg never inherits the Trade options barrier fields when the
            // block carries its own. Inheriting them duplicates the config
            // and can poison a leg with a value meant for another contract
            // (a leftover digit prediction read as an absolute price
            // barrier, an emptied Trade options offset landing on spot) —
            // Deriv rejects those buys with "Invalid barrier". Invalid
            // predictions and offsets are rejected before either buy, never
            // silently substituted with values from another block.
            // Sanitizing is contract-aware: a digit contract's barrier is
            // its prediction and it takes no price offsets; a price
            // contract takes offsets and must NEVER inherit a prediction
            // (a digit would be read as an absolute price barrier). A
            // block whose rows are stale for the workspace trade type —
            // e.g. Prediction rows left over after switching to
            // Higher/Lower — therefore degrades to a clean leg instead of
            // a guaranteed "Invalid barrier".
            const sanitizeBarrierOptions = (contractType, options) => sanitizeHedgeOptions(contractType, options);
            const barrierKeys = ['prediction', 'barrierOffset', 'secondBarrierOffset'];
            const hasBlockConfig = (contractType, options) => {
                const cleaned = sanitizeBarrierOptions(contractType, options);
                return barrierKeys.some(key => cleaned[key] !== undefined);
            };
            const legTradeOptions = (contractType, options) => {
                const leg = { ...this.tradeOptions };
                barrierKeys.forEach(key => delete leg[key]);
                // Block config wins outright; only a leg the block left
                // bare falls back to the (sanitized) Trade options values,
                // trading exactly like a standard Purchase.
                Object.assign(
                    leg,
                    hasBlockConfig(contractType, options)
                        ? sanitizeBarrierOptions(contractType, options)
                        : sanitizeBarrierOptions(contractType, this.tradeOptions)
                );
                return leg;
            };

            // Construct and validate both legs before either order is sent.
            const mainTradeOptions = legTradeOptions(contract_type, main_options);
            const hedgeTradeOptions = legTradeOptions(hedge_contract_type, hedge_options);
            for (const [type, options] of [[contract_type, mainTradeOptions], [hedge_contract_type, hedgeTradeOptions]]) {
                if (['TICKHIGH', 'TICKLOW'].includes(type) && options.prediction == null) {
                    throw new Error('Choose a prediction tick from 1 to 5 for both High/Low Tick legs.');
                }
            }

            // Select both proposals up front: buying the first leg renews the
            // proposal list, which would discard the second leg's price. A
            // leg with its own prediction/barriers cannot reuse the
            // subscribed proposal (those are priced from the trade options),
            // so that leg buys directly with its merged parameters instead.
            const priceBarrier = [mainTradeOptions, hedgeTradeOptions].some(options =>
                options.barrierOffset != null || options.secondBarrierOffset != null
            );
            const useProposals = this.is_proposal_subscription_required && !priceBarrier;
            const mainProposal =
                useProposals && !hasBlockConfig(contract_type, main_options) ? this.selectProposal(contract_type) : null;
            const hedgeProposal =
                useProposals && !hasBlockConfig(hedge_contract_type, hedge_options)
                    ? this.selectProposal(hedge_contract_type)
                    : null;

            const announce = (buy, type) => {
                contractStatus({ id: 'contract.purchase_received', data: buy.transaction_id, buy });
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type: type,
                    buy_price: buy.buy_price,
                });
            };

            // For price barriers, ask Deriv to price BOTH exact leg shapes
            // before placing either order. Never guess or alter a user's
            // barrier: availability and minimum distances vary by market.
            // This reduces partial hedges from invalid settings, but buys can
            // still fail independently after the quotes arrive.
            const quoteLeg = async (type, options) => {
                const request = tradeOptionToProposal({ ...options, contractTypes: [type] }, this.getPurchaseReference())[0];
                try {
                    const response = await api_base.api.send(request);
                    if (response?.error) throw response;
                    const proposal = response?.proposal;
                    if (!proposal?.id || !Number.isFinite(Number(proposal.ask_price))) throw new Error('No valid quote returned');
                    return { id: proposal.id, askPrice: Number(proposal.ask_price) };
                } catch (failure) {
                    const detail = failure?.error?.message || failure?.message || String(failure);
                    throw new Error(`Hedge ${type} quote rejected (market ${options.symbol}, duration ${request.duration}${request.duration_unit}, barrier ${options.barrierOffset ?? 'none'}): ${detail}. Review market availability, duration and barrier; neither leg was bought.`);
                }
            };
            const quotes = priceBarrier
                ? Promise.all([quoteLeg(contract_type, mainTradeOptions), quoteLeg(hedge_contract_type, hedgeTradeOptions)])
                : Promise.resolve([mainProposal, hedgeProposal]);
            return quotes.then(([first, second]) => {
                const buyMain = first
                    ? () => api_base.api.send({ buy: first.id, price: first.askPrice })
                    : () => api_base.api.send(tradeOptionToBuy(contract_type, mainTradeOptions));
                const buyHedge = second
                    ? () => api_base.api.send({ buy: second.id, price: second.askPrice })
                    : () => api_base.api.send(tradeOptionToBuy(hedge_contract_type, hedgeTradeOptions));
                this.isSold = false;
                contractStatus({ id: 'contract.purchase_sent', data: this.tradeOptions.amount });
                contractStatus({ id: 'contract.purchase_sent', data: this.tradeOptions.amount });
                // Do not automatically retry a buy on a lost response: the
                // broker may have filled it even though the reply was lost.
                return Promise.allSettled([Promise.resolve().then(buyMain), Promise.resolve().then(buyHedge)]);
            }).then(([main, hedge]) => {
                const bought = [];
                if (main.status === 'fulfilled') bought.push({ buy: main.value.buy, type: contract_type });
                if (hedge.status === 'fulfilled') bought.push({ buy: hedge.value.buy, type: hedge_contract_type });

                if (bought.length === 0) {
                    // A rejected response can be ambiguous after a disconnect;
                    // require account inspection before another hedge.
                    this.hedgeIncomplete = true;
                    throw main.status === 'rejected' ? main.reason : hedge.reason;
                }
                if (bought.length === 1) {
                    // One leg was rejected outright: track the leg that did
                    // open as a normal single position rather than strand it,
                    // and say so loudly in the log.
                    this.hedgeIncomplete = true;
                    const failure = main.status === 'rejected' ? main.reason : hedge.reason;
                    const detail = failure?.error?.message || failure?.message || String(failure);
                    log(LogTypes.ERROR, {
                        error: `Hedge: only the ${bought[0].type} leg opened; the opposite leg was rejected: ${detail}`,
                    });
                }

                this.settledContractIds = new Set();
                this.contractId = bought[0].buy.contract_id;
                this.hedgeContractIds = bought.slice(1).map(leg => leg.buy.contract_id);
                bought.forEach(leg => announce(leg.buy, leg.type));

                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
            });
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
