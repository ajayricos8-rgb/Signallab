import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
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

            if (this.is_proposal_subscription_required) {
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
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

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
         * Buy BOTH sides of a hedge in one before-purchase pass: the main leg
         * at the trade-options stake and the opposite leg at `second_stake`
         * (the same stake when not given). The two buy requests are sent
         * together, so both positions open in the same second, and the engine
         * then waits for BOTH contracts to settle before After purchase runs
         * (see OpenContract). Contract-detail blocks keep reading the main
         * leg; totals, runs and the contract log count each leg.
         */
        purchaseHedge(contract_type, hedge_contract_type, second_stake) {
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }
            if (!hedge_contract_type || hedge_contract_type === contract_type) {
                return this.purchase(contract_type);
            }

            const mainAmount = Number(this.tradeOptions.amount);
            const hedgeAmount = Math.max(0.35, Number(second_stake) || mainAmount);

            // Select both proposals up front: buying the first leg renews the
            // proposal list, which would discard the second leg's price. A
            // different second-leg stake cannot reuse the subscribed proposal
            // (its amount is fixed), so that leg buys directly instead.
            const useProposals = this.is_proposal_subscription_required;
            const mainProposal = useProposals ? this.selectProposal(contract_type) : null;
            const hedgeProposal =
                useProposals && hedgeAmount === mainAmount ? this.selectProposal(hedge_contract_type) : null;

            const buyMain = mainProposal
                ? () => api_base.api.send({ buy: mainProposal.id, price: mainProposal.askPrice })
                : () => api_base.api.send(tradeOptionToBuy(contract_type, this.tradeOptions));
            const buyHedge = hedgeProposal
                ? () => api_base.api.send({ buy: hedgeProposal.id, price: hedgeProposal.askPrice })
                : () =>
                      api_base.api.send(
                          tradeOptionToBuy(hedge_contract_type, { ...this.tradeOptions, amount: hedgeAmount })
                      );

            this.isSold = false;
            contractStatus({ id: 'contract.purchase_sent', data: mainAmount });
            contractStatus({ id: 'contract.purchase_sent', data: hedgeAmount });

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

            return Promise.allSettled([doUntilDone(buyMain), doUntilDone(buyHedge)]).then(([main, hedge]) => {
                const bought = [];
                if (main.status === 'fulfilled') bought.push({ buy: main.value.buy, type: contract_type });
                if (hedge.status === 'fulfilled') bought.push({ buy: hedge.value.buy, type: hedge_contract_type });

                if (bought.length === 0) {
                    // Neither leg could be bought: fail the way a failed
                    // single purchase fails.
                    throw main.status === 'rejected' ? main.reason : hedge.reason;
                }
                if (bought.length === 1) {
                    // One leg was rejected outright: track the leg that did
                    // open as a normal single position rather than strand it,
                    // and say so loudly in the log.
                    log(LogTypes.ERROR, {
                        error: `Hedge: only the ${bought[0].type} leg opened; the opposite leg was rejected.`,
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
