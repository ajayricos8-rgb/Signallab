"""Generate the AI Even Switcher v2 — the shipped Even/Odd DBot strategy.

    python3 artifacts/deriv-signal-lab/scripts/presets/gen_even_switcher.py \\
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/ai-even-switcher.xml

Run `validate_presets.py` afterwards, then the parity tests.

This script is the bot's source of truth: variables, gates, guards and journal
lines are declared once and emitted as Blockly XML. The block emitter is shared
with the price presets (`gen_presets.py`) so the switcher can never disagree
with them about XML shape; only the decision blocks, the trade type and the
journal cadence are parity-specific.

The v2 bot in one paragraph: sixteen experts forecast P(even) at the settling
tick, both sides are priced against the live DIGITEVEN/DIGITODD quotes, and the
better expected value wins — the bot buys Even or Odd on every readable cycle
(the side switch the v1 bot only allowed itself in loss-recovery), sized by
tenth-Kelly down to the exchange minimum, roaming fourteen digit markets under
a score floor and a dwell time, and journaling every number behind every entry.
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
        ("baseline profit", "0"),
        ("ai dna floor", spec.get("dna_floor", "35")),
        ("ai skill floor", spec.get("skill_floor", "-1")),
        ("ai scout floor", spec.get("scout_floor", "15")),
        ("ai scout dwell", spec.get("scout_dwell", "90")),
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
        # Exactly one market per strategy is the workspace's rule, so the scout
        # asks the runtime first. The dwell is deliberately long: a switch
        # trades a warm tick stream for a cold one, and the models need 60
        # ticks before they will publish anything at all.
        e.set_(
            "ai market",
            e.block(
                "x_parity_auto_market",
                fields={"MODE": spec.get("scout_mode", "suitable")},
                values={"FLOOR": e.get("ai scout floor"), "DWELL": e.get("ai scout dwell")},
            ),
        ),
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
    # Confidence is gated inside the engine, so what is left here is the part
    # that depends on the session: a losing streak cools entries off instead
    # of stopping the bot dead (a hard stop with no entries can never see the
    # win that would reset it).
    streak_ok = e.logic(
        "OR",
        e.compare("LT", e.get("ai loss streak"), e.get("ai loss streak stop")),
        e.compare("GTE", parity_part(e, "confidence", e.get(plan)), e.arith("ADD", e.get("ai min confidence"), e.num("5"))),
    )
    risk_ok = e.logic(
        "AND",
        streak_ok,
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
    entry_gate = e.logic(
        "AND",
        e.compare("EQ", e.get("ai ready"), e.num("1")),
        risk_ok,
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
        # The cool-off counter follows the settled contract, not the session
        # balance: a win resets it, a loss counts once.
        e.if_(
            e.block("contract_check_result", fields={"CHECK_RESULT": "win"}),
            [e.set_("ai loss streak", e.num("0"))],
            [e.set_("ai loss streak", e.arith("ADD", e.get("ai loss streak"), e.num("1")))],
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
            brakes,
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
    "dna_floor": "35",
    "skill_floor": "-1",
    "scout_floor": "15",
    "scout_dwell": "90",
    "scout_mode": "suitable",
    "ids": {"tick": "parityTick01", "before": "parityBefore01", "after": "parityAfter01"},
    "armed": (
        "AI Even Switcher v2 armed — Even/Odd on a 5-tick contract, cadence mode. Sixteen experts forecast "
        "P(even) at the settling tick, both sides are priced against the live DIGITEVEN/DIGITODD quotes, and "
        "the better expected value wins: the bot buys Even or Odd on every cycle it can read, switching sides "
        "when the measurement switches, sizing thin reads down to the exchange minimum. Every skip names its "
        "gate; every fifth settlement prints the two-sided forecast and the live quotes, every tenth the "
        "self-audit, every twenty-fifth the expert league, the market DNA, the AI core and the reverse "
        "engineering. Demo first: estimates are not guarantees."
    ),
    "held": (
        "AI is ready but the entry gate held it — a losing-streak cool-off, the DNA floor, the skill floor, "
        "the rule's own graded record, the drawdown pause, the balance percentage, the loss limit or the "
        "profit target blocked this entry."
    ),
    "stopped": "Session brake — loss limit or profit target reached. Review the journal before restarting.",
    "comment": """AI Even Switcher v2 — Even/Odd, sixteen experts, both sides
============================================================

The v1 bot bought Even only and touched Odd solely in loss-recovery: half the
contract family, gated by red ink. This bot scores both sides every cycle and
buys whichever the measurement favours — the side switch is the strategy.

THE CONTRACT
Even wins when the last digit of the last tick is 0, 2, 4, 6 or 8; Odd wins
on 1, 3, 5, 7 or 9. There is no third outcome: parity cannot tie. Durations
are 1-10 ticks on fourteen synthetics (the ten Volatility indices plus Jump
10/25/50/100); both sides pay the same multiple, about 1.95x, read live from
Deriv's own proposals. The full mechanics, mathematics and strategy survey
are in docs/even-odd-research.md — read it before running this for real.

THE ENSEMBLE
Sixteen experts forecast P(even) at the settling tick. Eight are inherited
from the proven vision digit engine (fair anchor, long-run and recent digit
histograms, the Markov row, analog replay, the analytical price-to-digit
mapping, an online softmax net, the regime forecast), each summed to P(even);
eight are parity-native (long-run and recent even share, first- and
second-order parity Markov powered to the horizon, the 10-bin digit row, run
continuation, the parity-autocorrelation projector, an online parity
perceptron). Every expert is scored walk-forward with Brier loss against the
0.5 anchor over the settled past and mixed by measured skill, so an expert
that cannot read this market loses its vote on its own. The blend is shrunk
toward 50% by its effective sample size (256 pseudo-ticks of fair coin).

CADENCE, NOT VIGIL
This preset keeps a trading cadence: the better-EV side is bought on every
cycle the bot can read (about one position per contract length — five ticks
plus re-entry), because a fair market is a reason to trade the minimum stake,
not a reason to sit out. Tenth-Kelly sizes thin reads to the 0.35 exchange
minimum; the journal prints the probability, quote, EV, sigma and record
behind every entry so the cost of the cadence is visible, not hidden. To
restore the selective sniper: entry "only with a measured edge" plus
"ai min ev" above zero (and optionally "ai min edge" / "ai min agreement").

SELF-REVERSE-ENGINEERING
Before the ensemble speaks, the engine fingerprints the digit stream: even
share, runs z-score, parity-Markov dependence, alternation, entropy, repeat
rate and sample warmth, rolled into a 0-100 readability score. The DNA floor
(35) refuses markets the bot cannot measure; the reverse-engineering line
prints the deep diagnosis (phase, regime, memory, auto-tuning) every 25
settlements. Descriptive, never predictive. A frozen quote feed — one
price repeated, a phantom edge at a towering t-stat — is refused outright
before a single expert speaks, and the scout scores the dead tape 0.

CALIBRATION AND STAND-DOWN
Every published decision is filed with its quote and graded against the
settling tick, per side. After 20 graded decisions the estimate is pulled
toward 50% by the reliability ratio (realised / predicted); after 40, a
Wilson bound still under break-even sets stand-down and the bot stops buying
until the record recovers. The journal says so explicitly.

THE SCOUT
Even/Odd is quoted on fourteen synthetics and they neither pay nor read the
same. The scout scores the market the bot stands on (measured EV, certainty,
readability, sample, skill) and moves under the score floor — never more
often than the 90-second dwell, because every switch trades a warm tick
stream for a cold one.

RISK
Tenth-Kelly sizing, floored at 0.35, capped by max stake and the balance
percent, divided down while the session loses. No martingale, no recovery
ladder: a loss lowers the next stake, never raises it. The loss limit and
profit target read the trade engine's own session profit; the drawdown pause
and the losing-streak cool-off sit beside them. All of it is in "Run once at
start"; all of it announces in the journal.

Tuning, all of it in the "Run once at start" block:

    ai base stake        0.35  the first stake; Kelly moves it from here
    ai duration          5     ticks per contract (1-10); forecast aims +1
    ai probability floor 0     unconditional side-probability floor (off)
    ai min edge          0     selective: edge over break-even (off)
    ai min agreement     0     selective: model agreement 0-1 (off)
    ai min confidence    0     selective: confidence floor (off)
    ai payout            1.95  fallback multiple before live quotes arrive
    ai min ev            0     selective: one-sigma EV floor (off)
    ai entry slip        1     forecast ticks past the contract length
    ai loss limit        30    stop entering after this much session loss
    ai profit target     50    stop entering after this much session profit
    ai max drawdown      15    pause entries past this session loss
    ai loss streak stop  4     cool entries off past this many straight losses
    ai stake percent     2     never stake more than this % of the balance
    ai max stake         1.5   never stake more than this
    ai kelly fraction    0.1   tenth-Kelly sizing
    ai dna floor         35    refuse markets reading below this
    ai skill floor       -1    refuse blends below this skill (off)
    ai scout floor       15    move markets under this score
    ai scout dwell       90    seconds between market moves, minimum
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
