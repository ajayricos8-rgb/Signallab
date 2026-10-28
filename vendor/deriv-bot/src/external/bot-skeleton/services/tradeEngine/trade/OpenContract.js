import { getRoundedNumber } from '@/components/shared';
import { api_base } from '../../api/api-base';
import { contract as broadcastContract, contractStatus } from '../utils/broadcast';
import { openContractReceived, sell } from './state/actions';

export default Engine =>
    class OpenContract extends Engine {
        observeOpenContract() {
            if (!api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'proposal_open_contract') {
                    const contract = data.proposal_open_contract;

                    if (!contract || !this.expectedContractId(contract?.contract_id)) {
                        return;
                    }

                    // A sold leg's totals are booked exactly once, even if
                    // the stream repeats its final update while the other
                    // hedge leg is still open.
                    if (contract.is_sold && this.settledContractIds?.has(contract.contract_id)) {
                        return;
                    }

                    // A hedge opens a second contract alongside the main one.
                    // The main leg keeps sole ownership of the contract flags
                    // and `data.contract` (every contract-detail block reads
                    // those), while the hedge leg only feeds the run panel,
                    // the totals and the settled-leg bookkeeping below.
                    const isMainLeg = contract.contract_id === this.contractId;

                    if (isMainLeg) {
                        this.setContractFlags(contract);

                        this.data.contract = contract;
                    }

                    broadcastContract({ accountID: api_base.account_info.loginid, ...contract });

                    if (contract.is_sold) {
                        this.updateTotals(contract);
                        contractStatus({
                            id: 'contract.sold',
                            data: contract.transaction_ids.sell,
                            contract,
                        });

                        if (!this.settledContractIds) this.settledContractIds = new Set();
                        this.settledContractIds.add(contract.contract_id);

                        // After purchase waits until EVERY open leg has
                        // settled — with a single contract that is this one,
                        // exactly as before.
                        const openIds = [this.contractId, ...(this.hedgeContractIds || [])].filter(Boolean);
                        const allSettled = openIds.every(id => this.settledContractIds.has(id));

                        if (allSettled) {
                            this.contractId = '';
                            this.hedgeContractIds = [];
                            this.settledContractIds = new Set();
                            clearTimeout(this.transaction_recovery_timeout);

                            if (this.afterPromise) {
                                this.afterPromise();
                            }

                            this.store.dispatch(sell());
                        }
                    } else if (isMainLeg) {
                        this.store.dispatch(openContractReceived());
                    }
                }
            });
            api_base.pushSubscription(subscription);
        }

        waitForAfter() {
            return new Promise(resolve => {
                this.afterPromise = resolve;
            });
        }

        setContractFlags(contract) {
            const { is_expired, is_valid_to_sell, is_sold, entry_tick } = contract;

            this.isSold = Boolean(is_sold);
            this.isSellAvailable = !this.isSold && Boolean(is_valid_to_sell);
            this.isExpired = Boolean(is_expired);
            this.hasEntryTick = Boolean(entry_tick);
        }

        expectedContractId(contractId) {
            if (!contractId) return false;
            if (contractId === this.contractId) return true;
            // Hedge legs opened by purchaseHedge settle through the same
            // stream; everything else keeps being ignored.
            return (this.hedgeContractIds || []).includes(contractId);
        }

        getSellPrice() {
            const { bid_price: bidPrice, buy_price: buyPrice, currency } = this.data.contract;
            return getRoundedNumber(Number(bidPrice) - Number(buyPrice), currency);
        }
    };
