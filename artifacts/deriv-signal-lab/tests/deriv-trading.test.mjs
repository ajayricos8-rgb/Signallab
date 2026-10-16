import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barrierFor,
  buildBalanceRequest,
  buildBuyRequest,
  buildContractSubscriptionRequest,
  buildPortfolioRequest,
  buildProfitTableRequest,
  buildProposalRequest,
  buildSellRequest,
  contractToClosedPosition,
  formatAmount,
  formatSignedAmount,
  mergeClosedPositions,
  mergePortfolioPositions,
  parseBalanceMessage,
  parseBuyMessage,
  parseContractMessage,
  parseErrorMessage,
  parsePortfolioMessage,
  parseProfitTableMessage,
  parseProposalMessage,
  receiptToOpenPosition,
  removeOpenPosition,
  upsertOpenPosition,
} from '../src/lib/deriv-trading.ts';

const riseRequest = {
  contractType: 'CALL',
  symbol: 'R_100',
  currency: 'USD',
  stake: 1.5,
  duration: 5,
  durationUnit: 't',
  barrier: null,
};

test('proposal requests use the v1 field names and send a barrier only for digit contracts', () => {
  const rise = buildProposalRequest(riseRequest, 42);
  assert.deepEqual(rise, {
    proposal: 1,
    amount: 1.5,
    basis: 'stake',
    contract_type: 'CALL',
    currency: 'USD',
    duration: 5,
    duration_unit: 't',
    underlying_symbol: 'R_100',
    req_id: 42,
  });
  assert.equal('symbol' in rise, false);
  assert.equal('barrier' in rise, false);

  const over = buildProposalRequest({ ...riseRequest, contractType: 'DIGITOVER', barrier: '5' }, 43);
  assert.equal(over.barrier, '5');
  assert.equal(over.underlying_symbol, 'R_100');
});

test('digit barriers are rendered as digits and withheld elsewhere', () => {
  assert.equal(barrierFor('DIGITOVER', 5), '5');
  assert.equal(barrierFor('DIGITUNDER', 0), '0');
  assert.equal(barrierFor('DIGITMATCH', 9), '9');
  assert.equal(barrierFor('DIGITEVEN', 9), null);
  assert.equal(barrierFor('CALL', 3), null);
  assert.equal(barrierFor('DIGITOVER', null), null);
  assert.equal(barrierFor('DIGITOVER', 1.5), null);
});

test('a buy reuses the quoted proposal id and never exceeds the quoted ask price', () => {
  const quote = { id: 'a'.repeat(40), askPrice: 1.23 };
  assert.deepEqual(buildBuyRequest(quote, 7), { buy: 'a'.repeat(40), price: 1.23, req_id: 7 });
});

test('account and history requests match the published request schemas', () => {
  assert.deepEqual(buildBalanceRequest(1), { balance: 1, subscribe: 1, req_id: 1 });
  assert.deepEqual(buildPortfolioRequest(2), { portfolio: 1, req_id: 2 });
  assert.deepEqual(buildContractSubscriptionRequest(3), { proposal_open_contract: 1, subscribe: 1, req_id: 3 });
  assert.deepEqual(buildProfitTableRequest(4, 25), {
    profit_table: 1,
    description: 1,
    limit: 25,
    sort: 'DESC',
    req_id: 4,
  });
  assert.deepEqual(buildSellRequest(4867502908, 5), { sell: 4867502908, price: 0, req_id: 5 });
});

test('proposal responses require a proposal id and a positive ask price', () => {
  const quote = parseProposalMessage({
    msg_type: 'proposal',
    proposal: {
      id: 'b'.repeat(32),
      ask_price: 1.19,
      payout: 1.95,
      spot: 1234.56,
      spot_time: 1_700_000_000,
      date_start: 1_700_000_001,
      date_expiry: 1_700_000_005,
      longcode: 'Rise if …',
    },
  });
  assert.equal(quote.id, 'b'.repeat(32));
  assert.equal(quote.askPrice, 1.19);
  assert.equal(quote.payout, 1.95);
  assert.equal(quote.dateExpiry, 1_700_000_005);

  assert.equal(parseProposalMessage({ proposal: { ask_price: 1.19 } }), null);
  assert.equal(parseProposalMessage({ proposal: { id: 'b'.repeat(32), ask_price: 0 } }), null);
  assert.equal(parseProposalMessage({ proposal: { id: 'b'.repeat(32), ask_price: 'not-a-number' } }), null);
  assert.equal(parseProposalMessage({}), null);
});

test('buy receipts require a contract id and a numeric buy price', () => {
  const receipt = parseBuyMessage({
    msg_type: 'buy',
    buy: {
      contract_id: 4867502908,
      buy_price: 1.19,
      payout: 1.95,
      balance_after: 9_998.81,
      purchase_time: 1_700_000_002,
      start_time: 1_700_000_003,
      longcode: 'Rise if …',
      shortcode: 'CALL_R_100_5T',
      transaction_id: 10867502908,
    },
  });
  assert.equal(receipt.contractId, 4867502908);
  assert.equal(receipt.buyPrice, 1.19);
  assert.equal(receipt.balanceAfter, 9998.81);
  assert.equal(parseBuyMessage({ buy: { buy_price: 1 } }), null);
  assert.equal(parseBuyMessage({ buy: { contract_id: 5 } }), null);
});

test('balance responses carry value and currency', () => {
  assert.deepEqual(parseBalanceMessage({ balance: { balance: 10000, currency: 'USD' } }), {
    balance: 10000,
    currency: 'USD',
  });
  assert.equal(parseBalanceMessage({ balance: { currency: 'USD' } }), null);
  assert.equal(parseBalanceMessage({ balance: { balance: 'x' } }), null);
});

test('portfolio rows read the v1 underlying_symbol field and stay open positions only', () => {
  const positions = parsePortfolioMessage({
    msg_type: 'portfolio',
    portfolio: {
      contracts: [
        {
          contract_id: 12345,
          contract_type: 'DIGITOVER',
          currency: 'USD',
          buy_price: 1,
          payout: 1.95,
          date_start: 1_700_000_000,
          expiry_time: 1_700_000_005,
          longcode: 'Over 5 …',
          shortcode: 'DIGITOVER_R_100_5T_5',
          underlying_symbol: 'R_100',
        },
        { contract_id: 'not-a-number', underlying_symbol: 'R_50' },
      ],
    },
  });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, 'R_100');
  assert.equal(positions[0].contractType, 'DIGITOVER');
  assert.equal(positions[0].isSold, false);
  assert.equal(positions[0].source, 'portfolio');
  assert.deepEqual(parsePortfolioMessage({ portfolio: {} }), []);
  assert.deepEqual(parsePortfolioMessage({}), []);
});

test('live contract updates map settlement flags and derive a missing profit from the sell price', () => {
  const open = parseContractMessage({
    msg_type: 'proposal_open_contract',
    proposal_open_contract: {
      contract_id: 777,
      contract_type: 'CALL',
      underlying_symbol: '1HZ100V',
      currency: 'USD',
      buy_price: 1,
      payout: 1.95,
      profit: -0.4,
      current_spot: 1000.12,
      entry_spot: 1000.02,
      is_sold: 0,
      is_valid_to_sell: 1,
      tick_count: 5,
      tick_passed: 3,
    },
  });
  assert.equal(open.symbol, '1HZ100V');
  assert.equal(open.isSold, false);
  assert.equal(open.isValidToSell, true);
  assert.equal(open.profit, -0.4);
  assert.equal(open.tickPassed, 3);

  const settled = parseContractMessage({
    proposal_open_contract: {
      contract_id: 777,
      contract_type: 'CALL',
      underlying_symbol: '1HZ100V',
      currency: 'USD',
      buy_price: 1,
      sell_price: 1.95,
      is_sold: 1,
      status: 'won',
    },
  });
  assert.equal(settled.isSold, true);
  assert.equal(settled.profit, 0.95);
  assert.equal(settled.status, 'won');

  assert.equal(parseContractMessage({ proposal_open_contract: {} }), null);
  assert.equal(parseContractMessage({}), null);
});

test('profit table rows are converted with a computed profit because v1 reports sell prices', () => {
  const rows = parseProfitTableMessage({
    msg_type: 'profit_table',
    profit_table: {
      count: 2,
      transactions: [
        {
          contract_id: 11,
          contract_type: 'DIGITEVEN',
          underlying_symbol: 'R_50',
          currency: 'USD',
          buy_price: 1,
          sell_price: 0,
          payout: 1.95,
          purchase_time: 1_700_000_000,
          sell_time: 1_700_000_010,
          shortcode: 'DIGITEVEN_R_50_5T',
        },
        {
          contract_id: 12,
          contract_type: 'DIGITODD',
          underlying_symbol: 'R_50',
          currency: 'USD',
          buy_price: 1,
          sell_price: 1.95,
          payout: 1.95,
          purchase_time: 1_700_000_020,
          sell_time: 1_700_000_030,
        },
        { contract_id: 13, underlying_symbol: 'R_50', buy_price: 1 },
      ],
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].profit, -1);
  assert.equal(rows[1].profit, 0.95);
  assert.equal(rows[0].symbol, 'R_50');
  assert.equal(rows[0].source, 'profit-table');
  assert.equal(rows.find((row) => row.contractId === 13), undefined);
});

test('settled stream contracts become closed history rows until the profit table catches up', () => {
  const position = parseContractMessage({
    proposal_open_contract: {
      contract_id: 900,
      contract_type: 'DIGITMATCH',
      underlying_symbol: '1HZ25V',
      currency: 'USD',
      buy_price: 2,
      sell_price: 3.8,
      is_sold: 1,
      date_start: 1_700_000_000,
    },
  });
  const closed = contractToClosedPosition(position);
  assert.equal(closed.profit, 1.8);
  assert.equal(closed.sellPrice, 3.8);
  assert.equal(closed.source, 'contract');
  assert.equal(closed.symbol, '1HZ25V');
});

test('buy receipts render as pending open positions with the requested contract', () => {
  const position = receiptToOpenPosition(
    { contractId: 5, buyPrice: 1, payout: 1.95, balanceAfter: 99, purchaseTime: 10, startTime: 11, longcode: 'x', shortcode: 'y', transactionId: 1 },
    riseRequest,
  );
  assert.equal(position.contractId, 5);
  assert.equal(position.contractType, 'CALL');
  assert.equal(position.symbol, 'R_100');
  assert.equal(position.profit, null);
  assert.equal(position.isSold, false);
});

test('socket errors surface the Deriv message, then the code, then a fallback', () => {
  assert.equal(parseErrorMessage({ error: { code: 'PriceError', message: 'Stake is too low.' } }), 'Stake is too low.');
  assert.equal(parseErrorMessage({ error: { code: 'PriceError' } }), 'PriceError');
  assert.equal(parseErrorMessage({ error: {} }), 'Deriv rejected the request.');
  assert.equal(parseErrorMessage({ msg_type: 'buy' }), null);
});

test('amount formatting stays explicit about the currency it belongs to', () => {
  assert.equal(formatAmount(1.5, 'USD'), '1.50 USD');
  assert.equal(formatAmount(1.5, null), '1.50');
  assert.equal(formatAmount(null, 'USD'), '—');
  assert.equal(formatSignedAmount(0.95, 'USD'), '+0.95 USD');
  assert.equal(formatSignedAmount(-1, 'USD'), '-1.00 USD');
  assert.equal(formatSignedAmount(0, 'USD'), '0.00 USD');
});

test('portfolio snapshots keep the live profit the contract stream already delivered', () => {
  const live = {
    contractId: 1,
    contractType: 'CALL',
    symbol: 'R_100',
    currency: 'USD',
    buyPrice: 1,
    payout: 1.95,
    profit: 0.42,
    profitPercentage: 42,
    entrySpot: 100,
    exitSpot: null,
    currentSpot: 101,
    status: 'open',
    longcode: null,
    shortcode: null,
    buyTime: 100,
    expiryTime: 105,
    isSold: false,
    isExpired: false,
    isValidToSell: true,
    tickCount: 5,
    tickPassed: 2,
    source: 'contract',
  };
  const snapshotRow = {
    ...live,
    profit: null,
    profitPercentage: null,
    currentSpot: null,
    status: null,
    isValidToSell: false,
    tickCount: null,
    tickPassed: null,
    source: 'portfolio',
  };
  const merged = mergePortfolioPositions([live], [snapshotRow]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].profit, 0.42);
  assert.equal(merged[0].currentSpot, 101);
  assert.equal(merged[0].isValidToSell, true);
  assert.equal(merged[0].source, 'contract');

  // A contract bought in the last second is kept even if the snapshot predates it.
  const freshBuy = { ...live, contractId: 2, buyTime: 200 };
  assert.deepEqual(
    mergePortfolioPositions([freshBuy], [snapshotRow]).map((position) => position.contractId).sort(),
    [1, 2],
  );
});

test('open positions are inserted, refreshed and removed by contract id', () => {
  const position = {
    contractId: 9,
    contractType: 'DIGITODD',
    symbol: 'R_50',
    currency: 'USD',
    buyPrice: 1,
    payout: 1.9,
    profit: null,
    profitPercentage: null,
    entrySpot: null,
    exitSpot: null,
    currentSpot: null,
    status: null,
    longcode: null,
    shortcode: null,
    buyTime: 5,
    expiryTime: null,
    isSold: false,
    isExpired: false,
    isValidToSell: false,
    tickCount: null,
    tickPassed: null,
    source: 'contract',
  };
  const inserted = upsertOpenPosition([], position);
  assert.equal(inserted.length, 1);
  const refreshed = upsertOpenPosition(inserted, { ...position, profit: -0.2, tickPassed: 4 });
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].profit, -0.2);
  assert.equal(refreshed[0].tickPassed, 4);
  assert.equal(refreshed[0].buyPrice, 1);
  assert.deepEqual(removeOpenPosition(refreshed, 9), []);
});

test('closed history deduplicates a contract across the stream and the profit table', () => {
  const fromStream = {
    contractId: 3,
    contractType: 'DIGITEVEN',
    symbol: 'R_25',
    currency: 'USD',
    buyPrice: 1,
    sellPrice: 1.9,
    payout: 1.9,
    profit: 0.9,
    purchaseTime: 10,
    sellTime: null,
    longcode: null,
    shortcode: null,
    source: 'contract',
  };
  const fromTable = { ...fromStream, sellTime: 20, source: 'profit-table' };
  const merged = mergeClosedPositions(mergeClosedPositions([], [fromStream]), [fromTable]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sellTime, 20);
  assert.equal(merged[0].source, 'profit-table');

  const older = { ...fromTable, contractId: 4, sellTime: 5 };
  assert.deepEqual(
    mergeClosedPositions(merged, [older]).map((row) => row.contractId),
    [3, 4],
  );
});

test('selected_tick is sent only for High/Low Tick proposals', () => {
  const base = { ...riseRequest, duration: 5, durationUnit: 't' };
  const high = buildProposalRequest({ ...base, contractType: 'TICKHIGH', selectedTick: 3 }, 50);
  assert.equal(high.selected_tick, 3);
  assert.equal(high.contract_type, 'TICKHIGH');
  assert.equal(high.duration, 5);
  assert.equal(high.duration_unit, 't');
  assert.equal('barrier' in high, false);

  const low = buildProposalRequest({ ...base, contractType: 'TICKLOW', selectedTick: 5 }, 51);
  assert.equal(low.selected_tick, 5);
  assert.equal(low.contract_type, 'TICKLOW');

  const unset = buildProposalRequest({ ...base, contractType: 'TICKHIGH', selectedTick: null }, 52);
  assert.equal('selected_tick' in unset, false);
  const omitted = buildProposalRequest({ ...base, contractType: 'CALL' }, 53);
  assert.equal('selected_tick' in omitted, false);
});
