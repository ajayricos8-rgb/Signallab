"""Generate the AI Even Switcher v2 — the shipped Even/Odd DBot strategy.

    python3 artifacts/deriv-signal-lab/scripts/presets/gen_even_switcher.py \\
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/ai-even-switcher.xml

Run `validate_presets.py` afterwards, then the parity tests.

This script is the bot's source of truth: variables, gates, guards and journal
lines are declared once and emitted as Blockly XML. The block emitter is shared
with the price presets (`gen_presets.py`) so the switcher can never disagree
with them about XML shape; only the decision blocks, the trade type and the
journal cadence are parity-specific.

The preset scores Even and Odd with a sixteen-model statistical ensemble,
selects the better modelled value, and waits for selective entry and session
risk gates. It does not promise an edge or rewrite itself.
"""

import importlib.util
import sys
from pathlib import Path
from xml.sax.saxutils import escape

PRESETS_DIR = Path(__file__).resolve().parent
ROOT = PRESETS_DIR.parents[1]


def load_gen_presets():
    """Import gen_presets.py by path (its directory is not a package)."""
    path = PRESETS_DIR / "gen_presets.py"
    spec = importlib.util.spec_from_file_location("gen_presets", path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_presets"] = module
    spec.loader.exec_module(module)
    return module


def parity_decision(e, horizon, floor, require, min_edge, payout, confidence, agreement, min_ev, slip):
    # The confidence floor is an input of the decision block, not a check
    # bolted on afterwards: the engine grades the decisions it publishes, so
    # a floor applied downstream would grade a different population from the
    # one the strategy trades.
    return e.block(
        "x_parity_decision",
        fields={"REQUIRE": require},
        values={
            "LIST": e.block("ticks"),
            "HORIZON": horizon,
            "THRESHOLD": floor,
            "MIN_EDGE": min_edge,
            "PAYOUT": payout,
            "MIN_CONFIDENCE": confidence,
            "MIN_AGREEMENT": agreement,
            "MIN_EV": min_ev,
            "SLIP": slip,
        },
    )


def parity_part(e, name, plan):
    return e.block("x_parity_decision_part", fields={"PART": name}, values={"PLAN": plan})


def parity_stake(e, plan_name, base, fraction, percent, max_stake):
    # The plan getter is rendered once per input: embedding one rendered
    # string twice would duplicate its id, and Blockly would silently drop
    # one of the two stake inputs.
    return e.block(
        "x_parity_stake",
        values={
            "PROBABILITY": parity_part(e, "probability", e.get(plan_name)),
            "PAYOUT": parity_part(e, "quote", e.get(plan_name)),
            "BASE": base,
            "FRACTION": fraction,
            "PERCENT": percent,
            "MAX_STAKE": max_stake,
        },
    )


def parity_risk(e, stake_value, legs, percent):
    return e.block(
        "x_parity_risk",
        values={
            "STAKE": stake_value,
            "LEGS": legs,
            "BASELINE": e.get("ai baseline"),
            "LOSS": e.get("ai loss limit"),
            "TARGET": e.get("ai profit target"),
            "PERCENT": percent,
        },
    )


def trade_definition_digits(e, market, submarket, symbol, duration, amount, init):
    """Trade definition for the digits family (Even/Odd takes no barrier)."""
    def field_block(name, pairs):
        out = f'<block type="trade_definition_{name}" id="{e.nid("td")}">'
        for key, value in pairs:
            out += f'<field name="{key}">{escape(str(value))}</field>'
        return out

    def reps(name, pairs, nxt=""):
        return field_block(name, pairs) + (f"<next>{nxt}</next>" if nxt else "") + "</block>"

    restart = reps(
        "restartbuysell",
        [("TIME_MACHINE_ENABLED", "FALSE")],
        reps("restartonerror", [("RESTARTONERROR", "FALSE")]),
    )
    candle = reps("candleinterval", [("CANDLEINTERVAL_LIST", "60")], restart)
    contract = reps("contracttype", [("TYPE_LIST", "both")], candle)
    ttype = reps(
        "tradetype",
        [("TRADETYPECAT_LIST", "digits"), ("TRADETYPE_LIST", "evenodd")],
        contract,
    )
    markets = reps(
        "market",
        [("MARKET_LIST", market), ("SUBMARKET_LIST", submarket), ("SYMBOL_LIST", symbol)],
        ttype,
    )
    # Even/Odd needs no barrier and no digit prediction: the mutation says so
    # explicitly, or the trade options render inputs the contract rejects.
    options = (
        f'<block type="trade_definition_tradeoptions" id="{e.nid("td")}">'
        '<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="false"></mutation>'
        f'<field name="DURATIONTYPE_LIST">t</field><field name="CURRENCY_LIST">USD</field>'
        f'  <value name="DURATION">\n{e.indent(duration, 2)}\n  </value>'
        f'  <value name="AMOUNT">\n{e.indent(amount, 2)}\n  </value>'
        f'<field name="AMOUNT_LIMITS"></field>'
        "</block>"
    )
    return (
        f'<block type="trade_definition" id="{e.nid("trade")}" x="0" y="0">\n'
        f'  <statement name="TRADE_OPTIONS">\n{e.indent(markets, 2)}\n  </statement>\n'
        f'  <statement name="INITIALIZATION">\n{e.indent(e.stack(init), 2)}\n  </statement>\n'
        f'  <statement name="SUBMARKET">\n{e.indent(options, 2)}\n  </statement>\n'
        "</block>"
    )


def build_parity(spec, emitter_cls):
    e = emitter_cls()
    plan = "ai decision"

    defaults = [
        ("base stake", "0.35"),
        ("stake", None),                       # = base stake
        ("ai loss limit", "30"),
        ("ai profit target", "50"),
        ("ai stake percent", "2"),
        ("ai max stake", spec.get("max_stake", "1.5")),
        ("ai kelly fraction", "0.1"),
        ("ai duration", spec.get("duration", "5")),
        ("ai probability floor", spec.get("floor", "0")),
        ("ai min edge", spec.get("min_edge", "0")),
        ("ai min agreement", spec.get("agreement", "0")),
        ("ai min confidence", spec.get("confidence", "0")),
        ("ai payout", spec.get("payout", "1.95")),
        ("ai min ev", spec.get("min_ev", "0")),
        ("ai entry slip", spec.get("slip", "1")),
        ("ai loss streak stop", "4"),
        ("ai loss streak", "0"),
        ("ai max drawdown", "15"),
        ("ai skip count", "0"),
        ("ai contracts", "0"),
        ("ai max contracts", "100"),
        ("baseline profit", "0"),
        ("ai dna floor", spec.get("dna_floor", "35")),
        ("ai skill floor", spec.get("skill_floor", "-1")),
        # The AI multi-market scan: every `ai scan every` seconds this bot's
        # own ensemble reads every market Signal Lab shares, and it stands on
        # the most suitable one. `ai cadence` is the at-least-one-trade-a-minute
        # clock that lets the quality gates stand aside, never the money gates.
        ("ai scan every", "8"),
        ("ai scan floor", "25"),
        ("ai scan margin", "3"),
        ("ai scan dwell", "25"),
        ("ai cadence", "60"),
        ("ai market", ""),
    ]
    init = []
    for name, value in defaults:
        if name == "stake":
            init.append(e.set_("stake", e.get("base stake")))
        elif name == "ai market":
            init.append(e.set_(name, e.text(value)))
        else:
            init.append(e.set_(name, e.num(value)))
    init.append(e.set_("ai baseline", e.block("x_session_profit")))
    init.append(
        e.set_(
            plan,
            parity_decision(
                e,
                e.get("ai duration"),
                e.get("ai probability floor"),
                spec.get("require", "always"),
                e.get("ai min edge"),
                e.get("ai payout"),
                e.get("ai min confidence"),
                e.get("ai min agreement"),
                e.get("ai min ev"),
                e.get("ai entry slip"),
            ),
        )
    )
    init.append(e.set_("ai ready", parity_part(e, "ready", e.get(plan))))
    init.append(e.set_("ai side", parity_part(e, "side", e.get(plan))))
    init.append(e.notify("info", e.text(spec["armed"])))
    # The digit stream's structural fingerprint, before a single contract is
    # bought: even share, runs, dependence, readability. A bot that starts by
    # describing where it is standing is a bot whose later silence can be read.
    init.append(e.notify("info", e.block("x_parity_dna")))
    init.append(e.notify("info", e.block("x_parity_payouts")))
    init.append(e.notify("info", e.block("x_parity_brain")))
    init.append(e.notify("info", e.block("x_parity_reverse")))

    # ---- tick analysis: decide, then size the stake the buy will use ------
    tick = [
        # Exactly one market can be traded at a time, but every market can be
        # read: the AI scan runs this bot's own parity ensemble over every digit
        # market Signal Lab shares, all at the same moment, and `ai market` is
        # the one it rated most suitable. The ensemble, the stake and every gate
        # below are unchanged — the scan only decides where the bot stands.
        e.market_scan(
            "even-odd",
            e.get("ai duration"),
            e.get("ai payout"),
            e.get("ai entry slip"),
            e.num(spec.get("max_tie", "0.2")),
        ),
        e.set_("ai market", e.scan_switch_best()),
        e.set_(
            "baseline profit",
            e.arith("MINUS", e.block("x_session_profit"), e.get("ai baseline")),
        ),
        e.set_(
            plan,
            parity_decision(
                e,
                e.get("ai duration"),
                e.get("ai probability floor"),
                spec.get("require", "always"),
                e.get("ai min edge"),
                e.get("ai payout"),
                e.get("ai min confidence"),
                e.get("ai min agreement"),
                e.get("ai min ev"),
                e.get("ai entry slip"),
            ),
        ),
        e.set_("ai ready", parity_part(e, "ready", e.get(plan))),
        e.set_("ai side", parity_part(e, "side", e.get(plan))),
        e.set_(
            "stake",
            parity_stake(
                e,
                plan,
                e.get("base stake"),
                e.get("ai kelly fraction"),
                e.get("ai stake percent"),
                e.get("ai max stake"),
            ),
        ),
    ]

    # ---- purchase conditions -----------------------------------------------
    # Confidence is gated inside the engine; a losing streak is a session stop
    # and requires an explicit restart, rather than a confidence-based bypass.
    # A losing streak is a hard session stop, never bypassed by model confidence.
    # Rendered on demand: a block string carries its own ids, so a value reused
    # in two places would put the same id in the document twice and Blockly
    # would bind the wrong one.
    def streak_ok():
        return e.compare("LT", e.get("ai loss streak"), e.get("ai loss streak stop"))

    risk_ok = e.logic(
        "AND",
        streak_ok(),
        parity_risk(e, e.get("stake"), e.num("1"), e.get("ai stake percent")),
    )
    # Four more guards:
    #
    #   the record   — a graded record whose whole interval sits under the
    #                  break-even is a broken estimate, not bad luck;
    #   the DNA      — a market whose structure cannot be measured is not a
    #                  market to size a position on;
    #   the skill    — a blend that cannot beat the fair coin walk-forward
    #                  has not earned an entry (ships off);
    #   the drawdown — past this session loss, entries pause until a restart
    #                  (the journal says so; the session brakes still apply).
    risk_ok = e.logic(
        "AND",
        risk_ok,
        e.logic(
            "AND",
            e.logic(
                "AND",
                e.compare("EQ", parity_part(e, "stand-down", e.get(plan)), e.num("0")),
                e.compare("GTE", parity_part(e, "dna-score", e.get(plan)), e.get("ai dna floor")),
            ),
            e.logic(
                "AND",
                e.compare("GTE", parity_part(e, "skill", e.get(plan)), e.get("ai skill floor")),
                e.compare("GT", e.get("baseline profit"), e.arith("MULTIPLY", e.num("-1"), e.get("ai max drawdown"))),
            ),
        ),
    )
    # At least one entry a minute: after a whole `ai cadence` window with no
    # purchase, the gates that are about *quality* — the DNA floor, the skill
    # floor, the drawdown pause — stand aside. Every money gate stays: the
    # parity risk block, the session brakes, the losing-streak cool-off, the
    # trade cap and a graded record that says the estimate itself is broken.
    # The cadence reports; the Purchase block still buys.
    cadence_money = e.logic(
        "AND",
        streak_ok(),
        e.logic(
            "AND",
            parity_risk(e, e.get("stake"), e.num("1"), e.get("ai stake percent")),
            e.logic(
                "AND",
                e.compare("EQ", parity_part(e, "stand-down", e.get(plan)), e.num("0")),
                e.compare("LT", e.get("ai contracts"), e.get("ai max contracts")),
            ),
        ),
    )
    cadence_ok = e.logic(
        "AND",
        e.compare("EQ", e.trade_due(), e.num("1")),
        e.logic(
            "AND",
            e.compare("EQ", e.get("ai ready"), e.num("1")),
            e.logic(
                "AND",
                e.compare("EQ", parity_part(e, "payout-live", e.get(plan)), e.num("1")),
                cadence_money,
            ),
        ),
    )
    entry_gate = e.logic(
        "OR",
        e.logic(
            "AND",
            e.compare("EQ", e.get("ai ready"), e.num("1")),
            e.logic(
                "AND",
                risk_ok,
                e.logic(
                    "AND",
                    e.compare("EQ", parity_part(e, "payout-live", e.get(plan)), e.num("1")),
                    e.compare("LT", e.get("ai contracts"), e.get("ai max contracts")),
                ),
            ),
        ),
        cadence_ok,
    )

    # The side switch: Even while the ensemble's better-EV side is Even, Odd
    # while it is Odd — decided fresh every cycle, not by the P&L.
    buy = e.if_(
        e.compare("EQ", e.get("ai side"), e.num("1")),
        e.block("purchase", fields={"PURCHASE_LIST": "DIGITEVEN"}),
        [e.block("purchase", fields={"PURCHASE_LIST": "DIGITODD"})],
    )

    before = [
        e.if_(
            e.compare("EQ", e.get("ai ready"), e.num("0")),
            [
                e.set_("ai skip count", e.arith("ADD", e.get("ai skip count"), e.num("1"))),
                e.if_(
                    e.compare("EQ", e.mod(e.get("ai skip count"), e.num("20")), e.num("1")),
                    e.notify("info", e.block("x_parity_reason")),
                ),
            ],
            [
                e.if_(
                    entry_gate,
                    [
                        e.set_("ai skip count", e.num("0")),
                        e.notify("success", e.block("x_parity_reason")),
                        buy,
                    ],
                    [
                        e.set_("ai skip count", e.arith("ADD", e.get("ai skip count"), e.num("1"))),
                        e.if_(
                            e.compare("EQ", e.mod(e.get("ai skip count"), e.num("20")), e.num("0")),
                            e.notify("warn", e.text(spec["held"])),
                        ),
                    ],
                ),
            ],
        )
    ]

    # ---- after settlement ----------------------------------------------------
    brakes = e.logic(
        "AND",
        parity_risk(e, e.get("base stake"), e.num("1"), e.get("ai stake percent")),
        e.logic(
            "AND",
            e.compare("GT", e.get("baseline profit"), e.arith("MULTIPLY", e.num("-1"), e.get("ai loss limit"))),
            e.compare("LT", e.get("baseline profit"), e.get("ai profit target")),
        ),
    )
    after = [
        e.set_("baseline profit", e.arith("MINUS", e.block("x_session_profit"), e.get("ai baseline"))),
        # The loss streak follows the settled contract: a win resets it,
        # a loss counts once, and another outcome does neither.
        e.if_(
            e.block("contract_check_result", fields={"CHECK_RESULT": "win"}),
            [e.set_("ai loss streak", e.num("0"))],
            [e.if_(
                e.block("contract_check_result", fields={"CHECK_RESULT": "loss"}),
                [e.set_("ai loss streak", e.arith("ADD", e.get("ai loss streak"), e.num("1")))],
            )],
        ),
        e.set_("ai contracts", e.arith("ADD", e.get("ai contracts"), e.num("1"))),
        # The two-sided read and the live quotes it was priced against, every
        # fifth settlement: the whole scan the side choice is made on.
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("5")), e.num("0")),
            e.notify("info", e.block("x_parity_forecast")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("5")), e.num("0")),
            e.notify("info", e.block("x_parity_payouts")),
        ),
        # The self-audit layer. Every tenth settlement the bot holds itself to
        # its own numbers; every twenty-fifth it shows who is carrying the
        # decision, what the market looks like now, what the brain has learned
        # and how it reverse-engineered the tape.
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("10")), e.num("0")),
            e.notify("info", e.block("x_parity_audit")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_parity_league")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_parity_dna")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_parity_brain")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_parity_reverse")),
        ),
        e.if_(
            e.logic("AND", brakes, e.logic("AND",
                e.compare("LT", e.get("ai loss streak"), e.get("ai loss streak stop")),
                e.logic("AND",
                    e.compare("LT", e.get("ai contracts"), e.get("ai max contracts")),
                    e.compare("GT", e.get("baseline profit"), e.arith("MULTIPLY", e.num("-1"), e.get("ai max drawdown"))),
                ),
            )),
            [e.block("trade_again")],
            [e.notify("warn", e.text(spec["stopped"]))],
        ),
    ]

    blocks = [
        trade_definition_digits(
            e,
            spec["market"],
            spec["submarket"],
            spec["symbol"],
            e.get("ai duration"),
            e.get("stake"),
            init,
        ),
        e.section("tick_analysis", spec["ids"]["tick"], tick, 0, 1500, "TICKANALYSIS_STACK"),
        e.section("before_purchase", spec["ids"]["before"], before, 0, 760, "BEFOREPURCHASE_STACK"),
        e.section("after_purchase", spec["ids"]["after"], after, 760, 760, "AFTERPURCHASE_STACK"),
    ]
    return e.document(spec["comment"], blocks)


EVEN_SWITCHER = {
    "market": "volidx",
    "submarket": "random_index",
    "symbol": "R_100",
    # `always` + a zero EV floor is what makes the switcher open positions at
    # all: with `edge` the ensemble had to publish a positive one-sigma edge on
    # a five-tick Even/Odd contract, and in 82 simulated cycles it never did,
    # so the bot sat in "Entry held" forever. The gates that matter — the
    # record, the DNA floor, the risk block, the brakes — are untouched.
    "require": "always",
    "floor": "0",
    "min_edge": "0",
    "min_ev": "0",
    "agreement": "0",
    "confidence": "0",
    "payout": "1.95",
    "slip": "1",
    "duration": "5",
    "max_stake": "1.5",
    "max_tie": "0.2",
    "dna_floor": "0",
    "skill_floor": "-1",
    "ids": {"tick": "parityTick01", "before": "parityBefore01", "after": "parityAfter01"},
    "armed": (
        "AI Even/Odd Switcher armed — 5 ticks, selective entry. An internal statistical ensemble "
        "scores both sides and switches between Even and Odd when its estimate changes. "
        "Entries require fresh quotes for both sides and a positive one-sigma modelled EV floor. "
        "Quotes and estimates can be wrong; execution may differ. Test on demo first."
    ),
    "held": (
        "Entry held: check the quote freshness, session limits, stake percentage, record, "
        "market readability and trade cap. The journal's decision is a model, not a guarantee."
    ),
    "stopped": "Session brake: loss, target, drawdown, loss streak or trade limit reached. Review before restarting.",
    "comment": """AI Even/Odd Switcher — selective statistical ensemble
=======================================================
Even wins on 0, 2, 4, 6, 8 and Odd wins on 1, 3, 5, 7, 9.
Both sides are scored each cycle; the model selects the better estimated EV,
not a loss-recovery side. Sixteen statistical experts, including small online
nets, are walk-forward scored. This is not a self-rewriting or predictive
AI guarantee; the market fingerprint and forecasts are descriptive estimates.

The preset requires separate, recent proposals for both sides, because a
fallback price cannot authorize an entry; its EV floor ships at zero so a
five-tick contract can be traded at all. The freshness window is the quote's
own, not a guarantee of the execution price. After a minute without a purchase
the quality gates stand aside, so the bot trades at least once a minute.
Backtest out of sample and use demo first.

The forecast record grades hypothetical tick outcomes, not actual fills. Entry
slip is an adjustable approximation, not a measurement of execution latency.
The preset reads every market Signal Lab shares — one scan of the bot's own
ensemble over all of them — and trades the market it rates most suitable; it
never trades more than one at a time. Availability, minimum stake and payout
depend on the account, symbol, currency and contract: verify them with Deriv
before trading.

Risk defaults: base 0.35, max 1.5, max 2% of balance (strict), 30 loss limit,
50 target, 15 session-loss pause, 4 consecutive losses and 100 contracts.
No martingale. A failed price, balance or safety gate blocks entry. Limits
cannot protect against disconnections or other execution/settlement anomalies.
Controls are editable in Run once at start. Research and limitations:
docs/even-odd-research.md.
""",
}


def main(argv):
    writer = load_gen_presets()
    out = Path(argv[1]) if len(argv) > 1 else ROOT / "src" / "lib" / "bot-store" / "bots" / "ai-even-switcher.xml"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_parity(EVEN_SWITCHER, writer.Emitter), encoding="utf-8")
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
