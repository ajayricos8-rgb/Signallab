import React from 'react';
import ReactDomServer from 'react-dom/server';
import { localize } from '@deriv-com/translations';

const Arg = ({ ...props }) => {
    return React.createElement('arg', props);
};

const Block = ({ ...props }) => {
    return React.createElement('block', props);
};

const Category = ({ ...props }) => {
    return React.createElement('category', props);
};

const Example = ({ ...props }) => {
    return React.createElement('example', props);
};

const Examples = ({ ...props }) => {
    return React.createElement('examples', props);
};

const Field = ({ ...props }) => {
    return React.createElement('field', props);
};

const Mutation = ({ ...props }) => {
    return React.createElement('mutation', props);
};

const Next = ({ ...props }) => {
    return React.createElement('next', props);
};

const Shadow = ({ ...props }) => {
    return React.createElement('shadow', props);
};

const Statement = ({ ...props }) => {
    return React.createElement('statement', props);
};

const Value = ({ ...props }) => {
    return React.createElement('value', props);
};

const Xml = ({ ...props }) => {
    return React.createElement('xml', props);
};

export const ToolboxItems = () =>
    ReactDomServer.renderToStaticMarkup(
        <Xml xmlns='http://www.w3.org/1999/xhtml' id='toolbox'>
            <Category id='trade_parameters' name={localize('Trade parameters')}>
                <Block type='trade_definition'>
                    <Statement name='TRADE_OPTIONS'>
                        <Block type='trade_definition_market' deletable='false' movable='false'>
                            <Field name='MARKET_LIST' />
                            <Field name='SUBMARKET_LIST' />
                            <Field name='SYMBOL_LIST' />
                            <Next>
                                <Block type='trade_definition_tradetype' deletable='false' movable='false'>
                                    <Field name='TRADETYPECAT_LIST' />
                                    <Field name='TRADETYPE_LIST' />
                                    <Next>
                                        <Block type='trade_definition_contracttype' deletable='false' movable='false'>
                                            <Field name='TYPE_LIST' />
                                            <Next>
                                                <Block
                                                    type='trade_definition_candleinterval'
                                                    deletable='false'
                                                    movable='false'
                                                >
                                                    <Field name='CANDLEINTERVAL_LIST'>60</Field>
                                                    <Next>
                                                        <Block
                                                            type='trade_definition_restartbuysell'
                                                            deletable='false'
                                                            movable='false'
                                                        >
                                                            <Field name='TIME_MACHINE_ENABLED'>FALSE</Field>
                                                            <Next>
                                                                <Block
                                                                    type='trade_definition_restartonerror'
                                                                    deletable='false'
                                                                    movable='false'
                                                                >
                                                                    <Field name='RESTARTONERROR'>TRUE</Field>
                                                                </Block>
                                                            </Next>
                                                        </Block>
                                                    </Next>
                                                </Block>
                                            </Next>
                                        </Block>
                                    </Next>
                                </Block>
                            </Next>
                        </Block>
                    </Statement>
                </Block>
                <Block type='trade_definition_tradeoptions'>
                    <Mutation has_first_barrier='false' has_second_barrier='false' has_prediction='false' />
                    <Field name='DURATIONTYPE_LIST' />
                    <Field name='CURRENCY_LIST'>USD</Field>
                    <Value name='DURATION'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>1</Field>
                        </Shadow>
                    </Value>
                    <Value name='AMOUNT'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>1</Field>
                        </Shadow>
                    </Value>
                    <Field name='AMOUNT_LIMITS' />
                </Block>
                <Block type='trade_definition_multiplier'>
                    <Field name='MULTIPLIERTYPE_LIST' />
                    <Field name='CURRENCY_LIST'>USD</Field>
                    <Value name='AMOUNT'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>1</Field>
                        </Shadow>
                    </Value>
                    <Field name='AMOUNT_LIMITS' />
                </Block>
                <Block type='multiplier_take_profit'>
                    <Value name='AMOUNT'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>0</Field>
                        </Shadow>
                    </Value>
                </Block>
                <Block type='multiplier_stop_loss'>
                    <Value name='AMOUNT'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>0</Field>
                        </Shadow>
                    </Value>
                </Block>
                <Block type='trade_definition_accumulator'>
                    <Field name='GROWTHRATE_LIST' />
                    <Field name='CURRENCY_LIST'>USD</Field>
                    <Value name='AMOUNT'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>1</Field>
                        </Shadow>
                    </Value>
                </Block>
                <Block type='accumulator_take_profit'>
                    <Value name='AMOUNT'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>0</Field>
                        </Shadow>
                    </Value>
                </Block>
            </Category>
            <Category id='purchase_conditions' name={localize('Purchase conditions')}>
                <Block type='before_purchase' />
                <Block type='purchase' />
            </Category>
            <Category id='sell_conditions' name={localize('Sell conditions (optional)')}>
                <Block type='during_purchase' />
                <Block type='sell_at_market' />
            </Category>
            <Category id='trade_results' name={localize('Restart trading conditions')}>
                <Block type='after_purchase' />
                <Block type='trade_again' />
            </Category>

            <Category id='analysis' name={localize('Analysis')}>
                <Category id='indicators' name={localize('Indicators')}>
                    <Block type='sma_statement'>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='smaa_statement'>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='bb_statement'>
                        <Field name='BBRESULT_LIST'>0</Field>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                        <Next>
                                            <Block type='std_dev_multiplier_up' deletable='false' movable='false'>
                                                <Value name='UPMULTIPLIER'>
                                                    <Shadow type='math_number'>
                                                        <Field name='NUM'>5</Field>
                                                    </Shadow>
                                                </Value>
                                                <Next>
                                                    <Block type='std_dev_multiplier_down'>
                                                        <Value name='DOWNMULTIPLIER'>
                                                            <Shadow type='math_number'>
                                                                <Field name='NUM'>5</Field>
                                                            </Shadow>
                                                        </Value>
                                                    </Block>
                                                </Next>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='bba_statement'>
                        <Field name='BBRESULT_LIST'>0</Field>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                        <Next>
                                            <Block type='std_dev_multiplier_up' deletable='false' movable='false'>
                                                <Value name='UPMULTIPLIER'>
                                                    <Shadow type='math_number'>
                                                        <Field name='NUM'>5</Field>
                                                    </Shadow>
                                                </Value>
                                                <Next>
                                                    <Block type='std_dev_multiplier_down'>
                                                        <Value name='DOWNMULTIPLIER'>
                                                            <Shadow type='math_number'>
                                                                <Field name='NUM'>5</Field>
                                                            </Shadow>
                                                        </Value>
                                                    </Block>
                                                </Next>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='ema_statement'>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='emaa_statement'>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='rsi_statement'>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='rsia_statement'>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='macda_statement'>
                        <Field name='MACDFIELDS_LIST'>1</Field>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST' />
                                <Next>
                                    <Block type='fast_ema_period' deletable='false' movable='false'>
                                        <Value name='FAST_EMA_PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>12</Field>
                                            </Shadow>
                                        </Value>
                                        <Next>
                                            <Block type='slow_ema_period' deletable='false' movable='false'>
                                                <Value name='SLOW_EMA_PERIOD'>
                                                    <Shadow type='math_number'>
                                                        <Field name='NUM'>26</Field>
                                                    </Shadow>
                                                </Value>
                                                <Next>
                                                    <Block type='signal_ema_period' deletable='false' movable='false'>
                                                        <Value name='SIGNAL_EMA_PERIOD'>
                                                            <Shadow type='math_number'>
                                                                <Field name='NUM'>9</Field>
                                                            </Shadow>
                                                        </Value>
                                                    </Block>
                                                </Next>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                </Category>

                <Category name={localize('Tick and candle analysis')} id='tick_analysis'>
                    <Block type='tick_analysis' />
                    <Block type='tick' />
                    <Block type='last_digit' />
                    <Block type='stat' />
                    <Block type='stat_list' />
                    <Block type='ticks' />
                    <Block type='lastDigitList' />
                    <Block type='check_direction' />
                    <Block type='is_candle_black' />
                    <Block type='read_ohlc'>
                        <Field name='OHLCFIELD_LIST'>open</Field>
                        <Field name='CANDLEINTERVAL_LIST'>default</Field>
                        <Value name='CANDLEINDEX'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='read_ohlc_obj' />
                    <Block type='ohlc_values' />
                    <Block type='ohlc_values_in_list' />
                    <Block type='get_ohlc'>
                        <Field name='CANDLEINTERVAL_LIST'>default</Field>
                        <Value name='CANDLEINDEX'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='ohlc' />
                </Category>

                <Category name={localize('Contract')} id='contract_details'>
                    <Block type='contract_check_result' />
                    <Block type='read_details' />
                    <Block type='sell_price' />
                    <Block type='check_sell' />
                    <Block type='payout' />
                    <Block type='ask_price' />
                </Category>

                <Category name={localize('Stats')} id='stats'>
                    <Block type='balance' />
                    <Block type='total_profit' />
                    <Block type='total_runs' />
                </Category>
            </Category>

            <Category id='signal_lab' name={localize('Signal Lab')}>
                <Block type='signal_lab_last_tick'>
                    <Field name='MARKET_LIST'>R_100</Field>
                </Block>
                <Block type='signal_lab_ticks'>
                    <Field name='MARKET_LIST'>R_100</Field>
                </Block>
                <Block type='signal_lab_last_digit'>
                    <Field name='MARKET_LIST'>R_100</Field>
                </Block>
                <Block type='signal_lab_tick_change'>
                    <Field name='MARKET_LIST'>R_100</Field>
                    <Value name='TICKS'>
                        <Shadow type='math_number'>
                            <Field name='NUM'>10</Field>
                        </Shadow>
                    </Value>
                </Block>
                <Block type='signal_lab_balance' />
                <Block type='signal_lab_open_positions' />
                <Block type='signal_lab_profit' />
                <Block type='signal_lab_account' />
                <Block type='signal_lab_connected' />
                <Block type='signal_lab_analysis_gate'>
                    <Field name='FAMILY'>rise-fall</Field>
                    <Field name='SYMBOL'>R_100</Field>
                    <Field name='ANALYSIS_ID' />
                </Block>
                <Block type='signal_lab_gate_reason'>
                    <Field name='FAMILY'>rise-fall</Field>
                    <Field name='SYMBOL'>R_100</Field>
                    <Field name='ANALYSIS_ID' />
                </Block>
                <Category id='signal_lab_scan' name={localize('All markets scan')}>
                    <Block type='signal_lab_scan_markets'>
                        <Field name='FAMILY'>rise-fall</Field>
                        <Value name='DURATION'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>20</Field>
                            </Shadow>
                        </Value>
                        <Value name='MIN_SCORE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0.05</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='signal_lab_scan_best' />
                    <Block type='signal_lab_scan_score'>
                        <Field name='MARKET_LIST'>R_100</Field>
                    </Block>
                    <Block type='signal_lab_scan_rank'>
                        <Field name='MARKET_LIST'>R_100</Field>
                    </Block>
                    <Block type='signal_lab_scan_count' />
                    <Block type='signal_lab_scan_tradeable' />
                    <Block type='signal_lab_switch_market'>
                        <Field name='MARKET_LIST'>R_100</Field>
                    </Block>
                    <Block type='signal_lab_switch_to_best' />
                </Category>
                <Category id='signal_lab_hedge' name={localize('Hedging')}>
                    <Block type='signal_lab_hedge_legs'>
                        <Field name='MARKET_LIST'>R_100</Field>
                    </Block>
                    <Block type='signal_lab_hedge_pairs'>
                        <Field name='MARKET_LIST'>R_100</Field>
                    </Block>
                    <Block type='signal_lab_hedge_balanced'>
                        <Field name='MARKET_LIST'>R_100</Field>
                    </Block>
                    <Block type='signal_lab_hedge_count' />
                    <Block type='signal_lab_hedge_profit' />
                </Category>
                <Category id='signal_lab_virtual' name={localize('Virtual trading')}>
                    <Block type='signal_lab_virtual_buy'>
                        <Field name='DIRECTION'>rise</Field>
                        <Field name='MARKET_LIST'>R_100</Field>
                        <Value name='STAKE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='PAYOUT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1.9</Field>
                            </Shadow>
                        </Value>
                        <Value name='BARRIER'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>5</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='signal_lab_virtual_settle' />
                    <Block type='signal_lab_virtual_reset' />
                    <Block type='signal_lab_virtual_profit' />
                    <Block type='signal_lab_virtual_runs' />
                    <Block type='signal_lab_virtual_wins' />
                    <Block type='signal_lab_virtual_open' />
                    <Block type='signal_lab_virtual_balance' />
                </Category>
            </Category>

            <Category id='vision_lab' name={localize('Vision Lab')}>
                <Category id='vision_ai' name={localize('AI Core')}>
                    <Block type='vision_analyse'>
                        <Value name='HORIZON'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        {/* The bars ship off: a fresh block must trade, not wait
                            for an edge a fair market never offers. Raise them by
                            hand to make the AI picky. */}
                        <Value name='MIN_EDGE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>-100</Field>
                            </Shadow>
                        </Value>
                        <Value name='MIN_LEAN'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='MIN_CONFIDENCE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='RISK'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0.6</Field>
                            </Shadow>
                        </Value>
                        <Value name='AGREEMENT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='vision_go' />
                    <Block type='vision_entry_ready'>
                        <Value name='GAP'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='vision_mark_entry' />
                    <Block type='vision_wait_entry'>
                        <Value name='GAP'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='vision_ticks' />
                    <Block type='vision_ready' />
                    <Block type='vision_barrier' />
                    <Block type='vision_direction' />
                    <Block type='vision_contract' />
                    <Block type='vision_probability' />
                    <Block type='vision_fair' />
                    <Block type='vision_edge' />
                    <Block type='vision_bias' />
                    <Block type='vision_confidence' />
                    <Block type='vision_agreement' />
                    <Block type='vision_payout' />
                    <Block type='vision_stake'>
                        <Value name='BASE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='vision_reason' />
                    <Block type='vision_summary' />
                    <Block type='vision_horizon' />
                    <Block type='vision_digit_probability'>
                        <Value name='DIGIT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='vision_feature' />
                    <Block type='vision_model_vote' />
                    <Block type='vision_model_weight' />
                    <Block type='vision_regime' />
                    <Block type='vision_learn'>
                        <Value name='DIGIT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>-1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='vision_brain_size' />
                    <Block type='vision_brain_stats' />
                    <Block type='vision_reset_brain' />
                    <Block type='vision_refresh_payouts' />
                    <Block type='vision_payout_live' />
                    <Block type='vision_notify' />
                    <Block type='vision_log' />
                </Category>

                <Category id='vision_quant' name={localize('Quant maths')}>
                    <Block type='q_sma'>
                        <Value name='PERIOD'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>14</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_ema'>
                        <Value name='PERIOD'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>14</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_wma'>
                        <Value name='PERIOD'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>14</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_rsi'>
                        <Value name='PERIOD'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>14</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_macd'>
                        <Value name='FAST'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>12</Field>
                            </Shadow>
                        </Value>
                        <Value name='SLOW'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>26</Field>
                            </Shadow>
                        </Value>
                        <Value name='SIGNAL'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>9</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_bollinger'>
                        <Value name='PERIOD'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>20</Field>
                            </Shadow>
                        </Value>
                        <Value name='DEVIATIONS'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_stddev' />
                    <Block type='q_variance' />
                    <Block type='q_stat' />
                    <Block type='q_percentile'>
                        <Value name='P'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>50</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_zscore'>
                        <Value name='VALUE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_slope' />
                    <Block type='q_correlation' />
                    <Block type='q_autocorr'>
                        <Value name='LAG'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_hurst' />
                    <Block type='q_entropy' />
                    <Block type='q_atr'>
                        <Value name='PERIOD'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>14</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_volatility'>
                        <Value name='PERIOD'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>100</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_drawdown' />
                    <Block type='q_streak' />
                    <Block type='q_returns' />
                    <Block type='q_last_digits' />
                    <Block type='q_digit_counts' />
                    <Block type='q_window'>
                        <Value name='COUNT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>100</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_change'>
                        <Value name='COUNT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>20</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_change_percent'>
                        <Value name='COUNT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>20</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_digit_of'>
                        <Value name='VALUE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_round'>
                        <Value name='VALUE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='DIGITS'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_clamp'>
                        <Value name='VALUE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='LOW'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='HIGH'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_map'>
                        <Value name='VALUE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='IN_LOW'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='IN_HIGH'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='OUT_LOW'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='OUT_HIGH'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>100</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_lerp'>
                        <Value name='A'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='B'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='T'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0.5</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_seeded'>
                        <Value name='SEED'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='q_pip_size' />
                </Category>

                <Category id='vision_analysis' name={localize('Market analysis')}>
                    <Block type='m_digit_frequency'>
                        <Value name='DIGIT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='m_digit_bias'>
                        <Value name='DIGIT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='m_digit_probability'>
                        <Value name='BARRIER'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>5</Field>
                            </Shadow>
                        </Value>
                        <Value name='HORIZON'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>5</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='m_transition'>
                        <Value name='FROM'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='TO'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='HORIZON'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='m_dominant_digit' />
                    <Block type='m_digit_spread' />
                    <Block type='m_digit_chi_square' />
                    <Block type='m_digit_streak' />
                    <Block type='m_parity_run' />
                    <Block type='m_over_under_run'>
                        <Value name='BARRIER'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>5</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='m_even_share' />
                    <Block type='m_hurst' />
                    <Block type='m_distance_to_level'>
                        <Value name='STEP'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='m_measure_speed' />
                    <Block type='m_tick_rate' />
                </Category>

                <Category id='vision_risk' name={localize('Risk and money')}>
                    <Block type='r_kelly'>
                        <Value name='PROBABILITY'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>55</Field>
                            </Shadow>
                        </Value>
                        <Value name='PAYOUT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1.9</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='r_stake_step'>
                        <Value name='CURRENT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='MULTIPLIER'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                        <Value name='MAX'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>20</Field>
                            </Shadow>
                        </Value>
                        <Value name='BASE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='r_safe_stake'>
                        <Value name='STAKE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='PERCENT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='r_balance' />
                    <Block type='r_profit_guard'>
                        <Value name='TARGET'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>50</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='r_loss_guard'>
                        <Value name='LIMIT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>50</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='r_drawdown_ok'>
                        <Value name='LIMIT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>30</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='r_loss_streak' />
                    <Block type='r_win_streak' />
                    <Block type='r_win_rate' />
                    <Block type='r_trades' />
                    <Block type='r_cooldown'>
                        <Value name='SECONDS'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='r_session_seconds' />
                </Category>

                <Category id='vision_shortcut' name={localize('Shortcuts')}>
                    <Block type='x_speed' />
                    <Block type='x_speed_index' />
                    <Block type='x_speed_factor' />
                    <Block type='x_smart_sleep'>
                        <Value name='SECONDS'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='x_wait_ticks'>
                        <Value name='COUNT'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='x_ai_should_buy'>
                        <Value name='MIN_EDGE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>-100</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='x_ai_stake'>
                        <Value name='BASE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='RISK'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0.6</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='x_ai_signal' />
                    <Block type='x_ai_trade'>
                        <Value name='STAKE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0.35</Field>
                            </Shadow>
                        </Value>
                        <Value name='DURATION'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='MIN_EDGE'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>-100</Field>
                            </Shadow>
                        </Value>
                        <Value name='RISK'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0.6</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='x_payout_needed'>
                        <Value name='PROBABILITY'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>50</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='x_digits_over'>
                        <Value name='BARRIER'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>5</Field>
                            </Shadow>
                        </Value>
                    </Block>
                </Category>

            </Category>
            <Category id='utility' name={localize('Utility')}>
                <Category name={localize('Custom functions')} id='custom_functions' dynamic='PROCEDURE' />

                <Category name={localize('Variables')} id='variables' dynamic='VARIABLE' />

                <Category name={localize('Notifications')} id='notifications'>
                    <Block type='text_print'>
                        <Value name='TEXT'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_prompt_ext'>
                        <Field name='TYPE'>TEXT</Field>
                        <Value name='TEXT'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='notify'>
                        <Field name='NOTIFICATION_TYPE'>success</Field>
                        <Value name='MESSAGE'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='notify_telegram'>
                        <Value name='TELEGRAM_ACCESS_TOKEN'>
                            <Shadow type='text'>
                                <Field name='TEXT' />
                            </Shadow>
                        </Value>
                        <Value name='TELEGRAM_CHAT_ID'>
                            <Shadow type='text'>
                                <Field name='TEXT' />
                            </Shadow>
                        </Value>
                        <Value name='TELEGRAM_MESSAGE'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                </Category>

                <Category name={localize('Time')} id='time'>
                    <Block type='epoch' />
                    <Block type='timeout' />
                    <Block type='tick_delay' />
                    <Block type='totimestamp'>
                        <Value name='DATETIME'>
                            <Shadow type='text'>
                                <Field name='TEXT'>yyyy-mm-dd hh:mm:ss</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='todatetime'>
                        <Value name='TIMESTAMP'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                </Category>

                <Category name={localize('Math')} id='math'>
                    <Block type='math_number' />
                    <Block type='math_arithmetic'>
                        <Field name='OP'>ADD</Field>
                        <Value name='A'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='B'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_single'>
                        <Field name='OP'>ROOT</Field>
                        <Value name='NUM'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>9</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_trig'>
                        <Field name='OP'>SIN</Field>
                        <Value name='NUM'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>45</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_constant' />
                    <Block type='math_number_property'>
                        <Mutation divisor_input='false' />
                        <Field name='PROPERTY'>EVEN</Field>
                        <Value name='NUMBER_TO_CHECK'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_change'>
                        <Field name='VAR' variabletype=''>
                            item
                        </Field>
                        <Value name='DELTA'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_on_list' />
                    <Block type='math_round'>
                        <Field name='OP'>ROUND</Field>
                        <Value name='NUM'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>3.1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_modulo'>
                        <Value name='DIVIDEND'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>64</Field>
                            </Shadow>
                        </Value>
                        <Value name='DIVISOR'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>10</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_constrain'>
                        <Value name='Value'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>50</Field>
                            </Shadow>
                        </Value>
                        <Value name='LOW'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='HIGH'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>100</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_random_int'>
                        <Value name='FROM'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                        <Value name='TO'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>100</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='math_random_float' />
                </Category>

                <Category name={localize('Text')} id='text'>
                    <Block type='text'>
                        <Field name='TEXT'>abc</Field>
                    </Block>
                    <Block type='text_join'>
                        <Field name='VARIABLE' variabletype=''>
                            text
                        </Field>
                        <Statement name='STACK'>
                            <Block type='text_statement' movable='false'>
                                <Value name='TEXT'>
                                    <Shadow type='text'>
                                        <Field name='TEXT'>abc</Field>
                                    </Shadow>
                                </Value>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='text_append'>
                        <Field name='VAR' variabletype=''>
                            text
                        </Field>
                        <Value name='TEXT'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_length'>
                        <Value name='Value'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_isEmpty'>
                        <Value name='Value'>
                            <Shadow type='text'>
                                <Field name='TEXT' />
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_indexOf'>
                        <Field name='END'>FIRST</Field>
                        <Value name='Value'>
                            <Block type='variables_get'>
                                <Field name='VAR' variabletype=''>
                                    text
                                </Field>
                            </Block>
                        </Value>
                        <Value name='FIND'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_charAt'>
                        <Mutation at='true' />
                        <Field name='WHERE'>FROM_START</Field>
                        <Value name='Value'>
                            <Block type='variables_get'>
                                <Field name='VAR' variabletype=''>
                                    item
                                </Field>
                            </Block>
                        </Value>
                        <Value name='AT'>
                            <Shadow type='math_number_positive'>
                                <Field name='NUM'>1</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_getSubstring'>
                        <Mutation at1='true' at2='true' />
                        <Field name='WHERE1'>FROM_START</Field>
                        <Field name='WHERE2'>FROM_START</Field>
                        <Value name='STRING'>
                            <Block type='variables_get'>
                                <Field name='VAR' variabletype=''>
                                    text
                                </Field>
                            </Block>
                        </Value>
                        <Value name='AT1'>
                            <Shadow type='math_number_positive'>
                                <Field name='NUM'>0</Field>
                            </Shadow>
                        </Value>
                        <Value name='AT2'>
                            <Shadow type='math_number_positive'>
                                <Field name='NUM'>2</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_changeCase'>
                        <Field name='CASE'>UPPERCASE</Field>
                        <Value name='TEXT'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='text_trim'>
                        <Field name='MODE'>BOTH</Field>
                        <Value name='TEXT'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                </Category>

                <Category name={localize('Logic')} id='logic'>
                    <Block type='controls_if' />
                    <Block type='logic_compare' />
                    <Block type='logic_operation' />
                    <Block type='logic_negate' />
                    <Block type='logic_boolean' />
                    <Block type='logic_null' />
                    <Block type='logic_ternary' />
                </Category>

                <Category name={localize('Lists')} id='lists'>
                    <Block type='lists_create_with'>
                        <Field name='VARIABLE' variabletype=''>
                            list
                        </Field>
                        <Statement name='STACK'>
                            <Block type='lists_statement' movable='false'>
                                <Next>
                                    <Block type='lists_statement' movable='false' />
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                    <Block type='lists_repeat'>
                        <Value name='NUM'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>5</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='lists_length' />
                    <Block type='lists_isEmpty' />
                    <Block type='lists_indexOf' />
                    <Block type='lists_getIndex' />
                    <Block type='lists_setIndex' />
                    <Block type='lists_getSublist' />
                    <Block type='lists_split'>
                        <Mutation mode='SPLIT' />
                        <Field name='MODE'>SPLIT</Field>
                        <Value name='DELIM'>
                            <Shadow type='text'>
                                <Field name='TEXT'>,</Field>
                            </Shadow>
                        </Value>
                    </Block>
                    <Block type='lists_sort' />
                </Category>

                <Category name={localize('Loops')} id='loops'>
                    <Block type='controls_repeat' />
                    <Block type='controls_repeat_ext' />
                    <Block type='controls_whileUntil' />
                    <Block type='controls_for' />
                    <Block type='controls_forEach' />
                    <Block type='controls_flow_statements' />
                </Category>

                <Category name={localize('Miscellaneous')} id='misc'>
                    <Block type='loader' />
                    <Block type='block_holder' />
                    <Block type='console'>
                        <Value name='MESSAGE'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                        </Value>
                    </Block>
                </Category>
            </Category>

            <Examples id='examples'>
                <Example id='sell_available'>
                    <Block type='during_purchase'>
                        <Statement name='DURING_PURCHASE_STACK'>
                            <Block type='controls_if'>
                                <Value name='IF0'>
                                    <Block type='check_sell' />
                                </Value>
                                <Statement name='DO0'>
                                    <Block type='sell_at_market' />
                                </Statement>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='trade_again'>
                    <Block type='after_purchase'>
                        <Statement name='AFTERPURCHASE_STACK'>
                            <Block type='controls_if'>
                                <Value name='IF0'>
                                    <Block type='logic_compare'>
                                        <Field name='OP'>EQ</Field>
                                        <Value name='A'>
                                            <Block type='total_profit' />
                                        </Value>
                                        <Value name='B'>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    target_profit
                                                </Field>
                                            </Block>
                                        </Value>
                                    </Block>
                                </Value>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='sma_block_example'>
                    <Block type='sma_statement'>
                        <Field name='VARIABLE' variabletype=''>
                            sma
                        </Field>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST'>
                                    <Block type='ohlc_values'>
                                        <Field name='OHLCFIELD_LIST'>open</Field>
                                        <Field name='CANDLEINTERVAL_LIST'>default</Field>
                                    </Block>
                                </Value>
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='sma_array'>
                    <Block type='smaa_statement'>
                        <Field name='VARIABLE' variabletype=''>
                            smaa
                        </Field>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='sma_block_example_1'>
                    <Block type='sma_statement'>
                        <Field name='VARIABLE' variabletype=''>
                            sma
                        </Field>
                        <Statement name='STATEMENT'>
                            <Block type='input_list' deletable='false' movable='false'>
                                <Value name='INPUT_LIST'>
                                    <Block type='ticks' />
                                </Value>
                                <Next>
                                    <Block type='period' deletable='false' movable='false'>
                                        <Value name='PERIOD'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='in_candle_list_read'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            op
                        </Field>
                        <Value name='VALUE'>
                            <Block type='read_ohlc'>
                                <Field name='OHLCFIELD_LIST'>open</Field>
                                <Field name='CANDLEINTERVAL_LIST'>default</Field>
                                <Value name='CANDLEINDEX'>
                                    <Shadow type='math_number'>
                                        <Field name='NUM'>1</Field>
                                    </Shadow>
                                </Value>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='read_candle_value'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            op
                        </Field>
                        <Value name='VALUE'>
                            <Block type='read_ohlc_obj'>
                                <Field name='OHLCFIELD_LIST'>open</Field>
                                <Value name='OHLCOBJ'>
                                    <Block type='read_ohlc'>
                                        <Field name='OHLCFIELD_LIST'>open</Field>
                                        <Field name='CANDLEINTERVAL_LIST'>default</Field>
                                        <Value name='CANDLEINDEX'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>1</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Value>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='candle_list'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            candle_list
                        </Field>
                        <Value name='VALUE'>
                            <Block type='ohlc_values'>
                                <Field name='OHLCFIELD_LIST'>open</Field>
                                <Field name='CANDLEINTERVAL_LIST'>default</Field>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='candle_list_1'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            cl
                        </Field>
                        <Value name='VALUE'>
                            <Block type='ohlc_values_in_list'>
                                <Field name='OHLCFIELD_LIST'>open</Field>
                                <Value name='OHLCLIST'>
                                    <Block type='ohlc'>
                                        <Field name='CANDLEINTERVAL_LIST'>default</Field>
                                    </Block>
                                </Value>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='get_candle'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            candle_open_price
                        </Field>
                        <Value name='VALUE'>
                            <Block type='read_ohlc_obj'>
                                <Field name='OHLCFIELD_LIST'>epoch</Field>
                                <Value name='OHLCOBJ'>
                                    <Block type='get_ohlc'>
                                        <Field name='CANDLEINTERVAL_LIST'>default</Field>
                                        <Value name='CANDLEINDEX'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>2</Field>
                                            </Shadow>
                                        </Value>
                                    </Block>
                                </Value>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='check_result'>
                    <Block type='after_purchase'>
                        <Statement name='AFTERPURCHASE_STACK'>
                            <Block type='controls_if'>
                                <Value name='IF0'>
                                    <Block type='contract_check_result'>
                                        <Field name='CHECK_RESULT'>win</Field>
                                    </Block>
                                </Value>
                                <Statement name='DO0'>
                                    <Block type='trade_again' />
                                </Statement>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='sell_pl'>
                    <Block type='during_purchase'>
                        <Statement name='DURING_PURCHASE_STACK'>
                            <Block type='controls_if'>
                                <Value name='IF0'>
                                    <Block type='check_sell' />
                                </Value>
                                <Statement name='DO0'>
                                    <Block type='controls_if'>
                                        <Value name='IF0'>
                                            <Block type='logic_compare'>
                                                <Field name='OP'>EQ</Field>
                                                <Value name='A'>
                                                    <Block type='sell_price' />
                                                </Value>
                                                <Value name='B'>
                                                    <Block type='variables_get'>
                                                        <Field name='VAR' variabletype=''>
                                                            stake
                                                        </Field>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Value>
                                        <Statement name='DO0'>
                                            <Block type='sell_at_market' />
                                        </Statement>
                                    </Block>
                                </Statement>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='if-return'>
                    <Block type='procedures_defreturn'>
                        <Mutation>
                            <Arg name='x' />
                        </Mutation>
                        <Field name='NAME'>do something</Field>
                        <Statement name='STACK'>
                            <Block type='procedures_ifreturn'>
                                <Mutation value='1' />
                                <Value name='CONDITION'>
                                    <Block type='logic_compare'>
                                        <Field name='OP'>EQ</Field>
                                        <Value name='A'>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    x
                                                </Field>
                                            </Block>
                                        </Value>
                                        <Value name='B'>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    x
                                                </Field>
                                            </Block>
                                        </Value>
                                    </Block>
                                </Value>
                                <Value name='VALUE'>
                                    <Block type='text'>
                                        <Field name='TEXT'>x must be positive or zero</Field>
                                    </Block>
                                </Value>
                            </Block>
                        </Statement>
                        <Value name='RETURN'>
                            <Block type='math_single'>
                                <Field name='OP'>ROOT</Field>
                                <Value name='NUM'>
                                    <Shadow type='math_number'>
                                        <Field name='NUM'>9</Field>
                                    </Shadow>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            x
                                        </Field>
                                    </Block>
                                </Value>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='notify_telegram'>
                    <Block type='notify_telegram'>
                        <Value name='TELEGRAM_ACCESS_TOKEN'>
                            <Shadow type='text'>
                                <Field name='TEXT' />
                            </Shadow>
                            <Block type='variables_get'>
                                <Field name='VAR' variabletype=''>
                                    access_token
                                </Field>
                            </Block>
                        </Value>
                        <Value name='TELEGRAM_CHAT_ID'>
                            <Shadow type='text'>
                                <Field name='TEXT' />
                            </Shadow>
                            <Block type='variables_get'>
                                <Field name='VAR' variabletype=''>
                                    chat_id
                                </Field>
                            </Block>
                        </Value>
                        <Value name='TELEGRAM_MESSAGE'>
                            <Shadow type='text'>
                                <Field name='TEXT'>Enjoy!</Field>
                            </Shadow>
                        </Value>
                    </Block>
                </Example>
                <Example id='epoch'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            candle
                        </Field>
                        <Value name='VALUE'>
                            <Block type='read_ohlc'>
                                <Field name='OHLCFIELD_LIST'>open</Field>
                                <Field name='CANDLEINTERVAL_LIST'>default</Field>
                                <Value name='CANDLEINDEX'>
                                    <Shadow type='math_number'>
                                        <Field name='NUM'>1</Field>
                                    </Shadow>
                                </Value>
                            </Block>
                        </Value>
                        <Next>
                            <Block type='variables_set'>
                                <Field name='VAR' variabletype=''>
                                    Open Time
                                </Field>
                                <Value name='VALUE'>
                                    <Block type='read_ohlc_obj'>
                                        <Field name='OHLCFIELD_LIST'>epoch</Field>
                                        <Value name='OHLCOBJ'>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    candle
                                                </Field>
                                            </Block>
                                        </Value>
                                    </Block>
                                </Value>
                                <Next>
                                    <Block type='variables_set'>
                                        <Field name='VAR' variabletype=''>
                                            Open Time
                                        </Field>
                                        <Value name='VALUE'>
                                            <Block type='math_arithmetic'>
                                                <Field name='OP'>MINUS</Field>
                                                <Value name='A'>
                                                    <Shadow type='math_number'>
                                                        <Field name='NUM'>1</Field>
                                                    </Shadow>
                                                    <Block type='epoch' />
                                                </Value>
                                                <Value name='B'>
                                                    <Shadow type='math_number'>
                                                        <Field name='NUM'>1</Field>
                                                    </Shadow>
                                                    <Block type='variables_get'>
                                                        <Field name='VAR' variabletype=''>
                                                            Open Time
                                                        </Field>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Value>
                                        <Next>
                                            <Block type='controls_if'>
                                                <Value name='IF0'>
                                                    <Block type='logic_compare'>
                                                        <Field name='OP'>GTE</Field>
                                                        <Value name='A'>
                                                            <Block type='variables_get'>
                                                                <Field name='VAR' variabletype=''>
                                                                    Time Since Candle Opened
                                                                </Field>
                                                            </Block>
                                                        </Value>
                                                        <Value name='B'>
                                                            <Block type='math_number'>
                                                                <Field name='NUM'>30</Field>
                                                            </Block>
                                                        </Value>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Next>
                            </Block>
                        </Next>
                    </Block>
                </Example>
                <Example id='totimestamp'>
                    <Block type='before_purchase'>
                        <Statement name='BEFOREPURCHASE_STACK'>
                            <Block type='controls_if'>
                                <Value name='IF0'>
                                    <Block type='logic_compare'>
                                        <Field name='OP'>EQ</Field>
                                        <Value name='A'>
                                            <Block type='epoch' />
                                        </Value>
                                        <Value name='B'>
                                            <Block type='totimestamp'>
                                                <Value name='DATETIME'>
                                                    <Shadow type='text'>
                                                        <Field name='TEXT'>1957-08-31 00:00:00</Field>
                                                    </Shadow>
                                                </Value>
                                            </Block>
                                        </Value>
                                    </Block>
                                </Value>
                                <Statement name='DO0'>
                                    <Block type='purchase'>
                                        <Field name='PURCHASE_LIST'>CALL</Field>
                                    </Block>
                                </Statement>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='todatetime'>
                    <Block type='notify'>
                        <Field name='NOTIFICATION_TYPE'>success</Field>
                        <Field name='NOTIFICATION_SOUND'>silent</Field>
                        <Value name='MESSAGE'>
                            <Shadow type='text'>
                                <Field name='TEXT'>abc</Field>
                            </Shadow>
                            <Block type='todatetime'>
                                <Value name='TIMESTAMP'>
                                    <Shadow type='math_number'>
                                        <Field name='NUM'>0</Field>
                                    </Shadow>
                                    <Block type='epoch' />
                                </Value>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='constrain'>
                    <Block type='math_constrain'>
                        <Value name='VALUE'>
                            <Block type='math_number'>
                                <Field name='NUM'>5</Field>
                            </Block>
                        </Value>
                        <Value name='LOW'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>10</Field>
                            </Shadow>
                        </Value>
                        <Value name='HIGH'>
                            <Shadow type='math_number'>
                                <Field name='NUM'>20</Field>
                            </Shadow>
                        </Value>
                    </Block>
                </Example>
                <Example id='controls_if'>
                    <Block type='controls_if'>
                        <Mutation elseif='1' else='1' />
                        <Value name='IF0'>
                            <Block type='logic_compare'>
                                <Field name='OP'>EQ</Field>
                                <Value name='A'>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            var1
                                        </Field>
                                    </Block>
                                </Value>
                                <Value name='B'>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            var2
                                        </Field>
                                    </Block>
                                </Value>
                            </Block>
                        </Value>
                        <Value name='IF1'>
                            <Block type='logic_compare'>
                                <Field name='OP'>EQ</Field>
                                <Value name='A'>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            var3
                                        </Field>
                                    </Block>
                                </Value>
                                <Value name='B'>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            var4
                                        </Field>
                                    </Block>
                                </Value>
                            </Block>
                        </Value>
                    </Block>
                </Example>
                <Example id='compare_logic'>
                    <Block type='logic_compare'>
                        <Field name='OP'>EQ</Field>
                    </Block>
                </Example>
                <Example id='compare_logic_1'>
                    <Block type='logic_operation'>
                        <Field name='OP'>AND</Field>
                    </Block>
                </Example>
                <Example id='repeat_while'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            x
                        </Field>
                        <Value name='VALUE'>
                            <Block type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Block>
                        </Value>
                        <Next>
                            <Block type='controls_whileUntil'>
                                <Field name='MODE'>WHILE</Field>
                                <Value name='BOOL'>
                                    <Block type='logic_compare'>
                                        <Field name='OP'>LTE</Field>
                                        <Value name='A'>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    x
                                                </Field>
                                            </Block>
                                        </Value>
                                        <Value name='B'>
                                            <Block type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Block>
                                        </Value>
                                    </Block>
                                </Value>
                                <Statement name='DO'>
                                    <Block type='math_change'>
                                        <Field name='VAR' variabletype=''>
                                            x
                                        </Field>
                                        <Value name='DELTA'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>1</Field>
                                            </Shadow>
                                        </Value>
                                        <Next>
                                            <Block type='notify'>
                                                <Field name='NOTIFICATION_TYPE'>success</Field>
                                                <Field name='NOTIFICATION_SOUND'>silent</Field>
                                                <Value name='MESSAGE'>
                                                    <Shadow type='text'>
                                                        <Field name='TEXT'>abc</Field>
                                                    </Shadow>
                                                    <Block type='variables_get'>
                                                        <Field name='VAR' variabletype=''>
                                                            x
                                                        </Field>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Statement>
                            </Block>
                        </Next>
                    </Block>
                </Example>
                <Example id='repeat_until'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            x
                        </Field>
                        <Value name='VALUE'>
                            <Block type='math_number'>
                                <Field name='NUM'>20</Field>
                            </Block>
                        </Value>
                        <Next>
                            <Block type='controls_whileUntil'>
                                <Field name='MODE'>UNTIL</Field>
                                <Value name='BOOL'>
                                    <Block type='logic_compare'>
                                        <Field name='OP'>EQ</Field>
                                        <Value name='A'>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    x
                                                </Field>
                                            </Block>
                                        </Value>
                                        <Value name='B'>
                                            <Block type='math_number'>
                                                <Field name='NUM'>10</Field>
                                            </Block>
                                        </Value>
                                    </Block>
                                </Value>
                                <Statement name='DO'>
                                    <Block type='math_change'>
                                        <Field name='VAR' variabletype=''>
                                            x
                                        </Field>
                                        <Value name='DELTA'>
                                            <Shadow type='math_number'>
                                                <Field name='NUM'>-1</Field>
                                            </Shadow>
                                        </Value>
                                        <Next>
                                            <Block type='notify'>
                                                <Field name='NOTIFICATION_TYPE'>success</Field>
                                                <Field name='NOTIFICATION_SOUND'>silent</Field>
                                                <Value name='MESSAGE'>
                                                    <Shadow type='text'>
                                                        <Field name='TEXT'>abc</Field>
                                                    </Shadow>
                                                    <Block type='variables_get'>
                                                        <Field name='VAR' variabletype=''>
                                                            x
                                                        </Field>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Statement>
                            </Block>
                        </Next>
                    </Block>
                </Example>
                <Example id='controls_for'>
                    <Block type='controls_for'>
                        <Field name='VAR' variabletype=''>
                            i
                        </Field>
                        <Value name='FROM'>
                            <Block type='math_number'>
                                <Field name='NUM'>0</Field>
                            </Block>
                        </Value>
                        <Value name='TO'>
                            <Block type='math_number'>
                                <Field name='NUM'>10</Field>
                            </Block>
                        </Value>
                        <Value name='BY'>
                            <Block type='math_number'>
                                <Field name='NUM'>2</Field>
                            </Block>
                        </Value>
                        <Statement name='DO'>
                            <Block type='notify'>
                                <Field name='NOTIFICATION_TYPE'>success</Field>
                                <Field name='NOTIFICATION_SOUND'>silent</Field>
                                <Value name='MESSAGE'>
                                    <Shadow type='text'>
                                        <Field name='TEXT'>abc</Field>
                                    </Shadow>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            i
                                        </Field>
                                    </Block>
                                </Value>
                            </Block>
                        </Statement>
                    </Block>
                </Example>
                <Example id='controls_forEach'>
                    <Block type='lists_create_with'>
                        <Field name='VARIABLE'>list</Field>
                        <Statement name='STACK'>
                            <Block type='lists_statement'>
                                <Value name='VALUE'>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            item1
                                        </Field>
                                    </Block>
                                </Value>
                                <Next>
                                    <Block type='lists_statement'>
                                        <Value name='VALUE'>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    item2
                                                </Field>
                                            </Block>
                                        </Value>
                                        <Next>
                                            <Block type='lists_statement'>
                                                <Value name='VALUE'>
                                                    <Block type='variables_get'>
                                                        <Field name='VAR' variabletype=''>
                                                            item3
                                                        </Field>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Next>
                            </Block>
                        </Statement>
                        <Next>
                            <Block type='controls_forEach'>
                                <Field name='VAR' variabletype=''>
                                    i
                                </Field>
                                <Value name='LIST'>
                                    <Block type='variables_get'>
                                        <Field name='VAR' variabletype=''>
                                            list
                                        </Field>
                                    </Block>
                                </Value>
                                <Statement name='DO'>
                                    <Block type='notify'>
                                        <Field name='NOTIFICATION_TYPE'>success</Field>
                                        <Field name='NOTIFICATION_SOUND'>silent</Field>
                                        <Value name='MESSAGE'>
                                            <Shadow type='text'>
                                                <Field name='TEXT'>abc</Field>
                                            </Shadow>
                                            <Block type='variables_get'>
                                                <Field name='VAR' variabletype=''>
                                                    i
                                                </Field>
                                            </Block>
                                        </Value>
                                    </Block>
                                </Statement>
                            </Block>
                        </Next>
                    </Block>
                </Example>
                <Example id='break_out'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            x
                        </Field>
                        <Value name='VALUE'>
                            <Block type='logic_boolean'>
                                <Field name='BOOL'>TRUE</Field>
                            </Block>
                        </Value>
                        <Next>
                            <Block type='controls_repeat'>
                                <Field name='TIMES'>10</Field>
                                <Statement name='DO'>
                                    <Block type='controls_if'>
                                        <Value name='IF0'>
                                            <Block type='logic_negate'>
                                                <Value name='BOOL'>
                                                    <Block type='variables_get'>
                                                        <Field name='VAR' variabletype=''>
                                                            x
                                                        </Field>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Value>
                                        <Statement name='DO0'>
                                            <Block type='controls_flow_statements'>
                                                <Field name='FLOW'>BREAK</Field>
                                            </Block>
                                        </Statement>
                                        <Next>
                                            <Block type='notify'>
                                                <Field name='NOTIFICATION_TYPE'>success</Field>
                                                <Field name='NOTIFICATION_SOUND'>silent</Field>
                                                <Value name='MESSAGE'>
                                                    <Shadow type='text'>
                                                        <Field name='TEXT'>abc</Field>
                                                    </Shadow>
                                                </Value>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Statement>
                            </Block>
                        </Next>
                    </Block>
                </Example>
                <Example id='continue'>
                    <Block type='variables_set'>
                        <Field name='VAR' variabletype=''>
                            x
                        </Field>
                        <Value name='VALUE'>
                            <Block type='logic_boolean'>
                                <Field name='BOOL'>FALSE</Field>
                            </Block>
                        </Value>
                        <Next>
                            <Block type='controls_repeat'>
                                <Field name='TIMES'>10</Field>
                                <Statement name='DO'>
                                    <Block type='controls_if'>
                                        <Value name='IF0'>
                                            <Block type='logic_negate'>
                                                <Value name='BOOL'>
                                                    <Block type='variables_get'>
                                                        <Field name='VAR' variabletype=''>
                                                            x
                                                        </Field>
                                                    </Block>
                                                </Value>
                                            </Block>
                                        </Value>
                                        <Statement name='DO0'>
                                            <Block type='variables_set'>
                                                <Field name='VAR' variabletype=''>
                                                    x
                                                </Field>
                                                <Value name='VALUE'>
                                                    <Block type='logic_boolean'>
                                                        <Field name='BOOL'>TRUE</Field>
                                                    </Block>
                                                </Value>
                                                <Next>
                                                    <Block type='controls_flow_statements'>
                                                        <Field name='FLOW'>CONTINUE</Field>
                                                    </Block>
                                                </Next>
                                            </Block>
                                        </Statement>
                                        <Next>
                                            <Block type='notify'>
                                                <Field name='NOTIFICATION_TYPE'>success</Field>
                                                <Field name='NOTIFICATION_SOUND'>silent</Field>
                                                <Value name='MESSAGE'>
                                                    <Shadow type='text'>
                                                        <Field name='TEXT'>abc</Field>
                                                    </Shadow>
                                                </Value>
                                            </Block>
                                        </Next>
                                    </Block>
                                </Statement>
                            </Block>
                        </Next>
                    </Block>
                </Example>
            </Examples>
        </Xml>
    );
