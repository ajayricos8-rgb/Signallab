"""Generate the three shipped price-path DBot strategies.

    python3 artifacts/deriv-signal-lab/scripts/presets/gen_presets.py \
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/rise-fall-ensemble.xml \
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/step-markov-hedge.xml \
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/high-low-tick-sniper.xml

Run `validate_presets.py` afterwards, then the preset tests.

The presets are Blockly programs, not code, so this script is their source of
truth: variables, gates, guards and journal lines are declared once and emitted
as XML for all three bots. That keeps them consistent, and it makes it
impossible for one preset to drift into a state (no reachable purchase, a gate
nothing can clear) that only shows up live.
"""

import re
import sys
from xml.sax.saxutils import escape


class Emitter:
    def __init__(self):
        self.n = 0
        self.variables = []  # (id, name) in declaration order
        self.by_name = {}

    # ---- primitives ------------------------------------------------------
    def nid(self, prefix="b"):
        self.n += 1
        return f"{prefix}{self.n:04d}"

    def var(self, name):
        if name not in self.by_name:
            ident = "v" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
            self.by_name[name] = ident
            self.variables.append((ident, name))
        return self.by_name[name]

    def block(self, btype, fields=None, values=None, statements=None, nxt=None, mutation=None):
        for name in (fields or {}):
            if name == "VAR":
                self.var(fields[name])
        parts = [f'<block type="{btype}" id="{self.nid()}">']
        if mutation:
            attrs = " ".join(f'{name}="{escape(str(value))}"' for name, value in mutation.items())
            parts.append(f'  <mutation {attrs}></mutation>')
        for name, value in (fields or {}).items():
            if name == "VAR":
                # The id is what binds a get/set to the declared variable; a
                # name-only field makes Blockly mint a second variable with the
                # same label, and the two silently stop seeing each other.
                parts.append(f'  <field name="VAR" id="{self.var(value)}">{escape(str(value))}</field>')
            else:
                parts.append(f'  <field name="{name}">{escape(str(value))}</field>')
        for name, child in (values or {}).items():
            if child is None:
                continue
            parts.append(f'  <value name="{name}">')
            parts.append(self.indent(child, 2))
            parts.append("  </value>")
        for name, children in (statements or {}).items():
            body = self.stack(children) if isinstance(children, list) else children
            if body and body.strip():
                parts.append(f'  <statement name="{name}">')
                parts.append(self.indent(body, 2))
                parts.append("  </statement>")
        if nxt:
            parts.append("  <next>")
            parts.append(self.indent(nxt, 2))
            parts.append("  </next>")
        parts.append("</block>")
        return "\n".join(parts)

    @staticmethod
    def indent(text, level):
        pad = "  " * level
        return "\n".join(pad + line if line.strip() else line for line in text.split("\n"))

    def stack(self, blocks):
        out = ""
        for item in reversed(blocks):
            out = self.chain(item, out)
        return out

    @staticmethod
    def chain(rendered, nxt):
        if not nxt:
            return rendered
        close = rendered.rfind("</block>")
        return rendered[:close] + "  <next>\n" + Emitter.indent(nxt, 2) + "\n  </next>\n" + rendered[close:]

    # ---- value blocks ----------------------------------------------------
    def num(self, value):
        return self.block("math_number", fields={"NUM": value})

    def text(self, value):
        return self.block("text", fields={"TEXT": value})

    def get(self, name):
        return self.block("variables_get", fields={"VAR": name})

    def set_(self, name, value):
        return self.block("variables_set", fields={"VAR": name}, values={"VALUE": value})

    def arith(self, op, a, b):
        return self.block("math_arithmetic", fields={"OP": op}, values={"A": a, "B": b})

    def compare(self, op, a, b):
        return self.block("logic_compare", fields={"OP": op}, values={"A": a, "B": b})

    def logic(self, op, a, b):
        return self.block("logic_operation", fields={"OP": op}, values={"A": a, "B": b})

    def mod(self, a, b):
        return self.block("math_modulo", values={"DIVIDEND": a, "DIVISOR": b})

    def if_(self, cond, do, otherwise=None):
        return self.block(
            "controls_if",
            # Blockly creates ELSE inputs only when this mutation is present.
            # Without it, deserialization silently discards the whole branch.
            mutation={"else": "1"} if otherwise else None,
            values={"IF0": cond},
            statements={"DO0": do if isinstance(do, list) else [do], "ELSE": otherwise or []},
        )

    def notify(self, kind, message_block):
        return self.block(
            "notify",
            fields={"NOTIFICATION_TYPE": kind, "NOTIFICATION_SOUND": "silent"},
            values={"MESSAGE": message_block},
        )

    # ---- price blocks ----------------------------------------------------
    def decision(
        self, mode, horizon, floor, max_tie, agreement, min_edge, payout, confidence, require, min_ev="0", slip="0"
    ):
        # The confidence floor is an input of the decision block, not a check
        # bolted on afterwards: the engine grades the decisions it publishes, so
        # a floor applied downstream would grade a different population from the
        # one the strategy trades — and a model could look good on ticks it
        # never traded.
        return self.block(
            "x_price_decision",
            fields={"MODE": mode, "REQUIRE": require},
            values={
                "LIST": self.block("ticks"),
                "HORIZON": horizon,
                "THRESHOLD": floor,
                "MAX_TIE": max_tie,
                "MIN_AGREEMENT": agreement,
                "MIN_EDGE": min_edge,
                "PAYOUT": payout,
                "MIN_CONFIDENCE": confidence,
                "MIN_EV": min_ev,
                "SLIP": slip,
            },
        )

    def part(self, name, plan):
        return self.block("x_price_decision_part", fields={"PART": name}, values={"PLAN": plan})

    def mpart(self, name, plan):
        # The Markov plan has its own reader: the decision block's part list is
        # a different set of names, and Blockly drops a field value that is not
        # in a dropdown instead of failing.
        return self.block("x_price_markov_part", fields={"PART": name}, values={"PLAN": plan})

    def stake(self, plan, base, fraction, percent, max_stake):
        return self.block(
            "x_price_stake",
            values={
                "PROBABILITY": self.part("probability", plan),
                "PAYOUT": self.get("ai payout"),
                "BASE": base,
                "FRACTION": fraction,
                "PERCENT": percent,
                "MAX_STAKE": max_stake,
            },
        )

    def risk(self, stake_value, legs, percent):
        return self.block(
            "x_price_risk",
            values={
                "STAKE": stake_value,
                "LEGS": legs,
                "BASELINE": self.get("ai baseline"),
                "LOSS": self.get("ai loss limit"),
                "TARGET": self.get("ai profit target"),
                "PERCENT": percent,
            },
        )

    # ---- the AI multi-market scan ---------------------------------------
    def market_scan(self, family, horizon, payout, slip, tie):
        """Read every market Signal Lab shares with this bot's own model."""
        return self.block(
            "x_market_scan",
            fields={"FAMILY": family},
            values={
                "HORIZON": horizon,
                "PAYOUT": payout,
                "SLIP": slip,
                "EVERY": self.get("ai scan every"),
                "MAX_TIE": tie,
            },
        )

    def scan_switch_best(self):
        """Stand on the most suitable market from the last scan."""
        return self.block(
            "x_scan_switch_best",
            values={
                "FLOOR": self.get("ai scan floor"),
                "MARGIN": self.get("ai scan margin"),
                "DWELL": self.get("ai scan dwell"),
            },
        )

    def trade_due(self):
        """1 when no contract has been bought for `ai cadence` seconds."""
        return self.block("x_trade_due", values={"SECONDS": self.get("ai cadence")})

    def variables_xml(self):
        out = ["<variables>"]
        for ident, name in self.variables:
            out.append(f'  <variable type="" id="{ident}">{escape(name)}</variable>')
        out.append("</variables>")
        return "\n".join(out)

    # ---- trade definition ------------------------------------------------
    def trade_definition(self, market, submarket, symbol, tradetype_cat, tradetype, duration, amount, init):
        def field_block(name, pairs):
            out = f'<block type="trade_definition_{name}" id="{self.nid("td")}">'
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
            [("TRADETYPECAT_LIST", tradetype_cat), ("TRADETYPE_LIST", tradetype)],
            contract,
        )
        markets = reps(
            "market",
            [("MARKET_LIST", market), ("SUBMARKET_LIST", submarket), ("SYMBOL_LIST", symbol)],
            ttype,
        )
        options = self.block(
            "trade_definition_tradeoptions",
            fields={"DURATIONTYPE_LIST": "t", "CURRENCY_LIST": "USD", "AMOUNT_LIMITS": ""},
            values={"DURATION": duration, "AMOUNT": amount},
        )
        return (
            f'<block type="trade_definition" id="{self.nid("trade")}" x="0" y="0">\n'
            f'  <statement name="TRADE_OPTIONS">\n{self.indent(markets, 2)}\n  </statement>\n'
            f'  <statement name="INITIALIZATION">\n{self.indent(self.stack(init), 2)}\n  </statement>\n'
            f'  <statement name="SUBMARKET">\n{self.indent(options, 2)}\n  </statement>\n'
            "</block>"
        )

    def section(self, name, ident, body, x, y, statement):
        return (
            f'<block type="{name}" id="{ident}" x="{x}" y="{y}">\n'
            f'  <statement name="{statement}">\n{self.indent(self.stack(body), 2)}\n  </statement>\n'
            "</block>"
        )

    def document(self, comment, blocks):
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f"<!--\n{self.indent(comment.strip(), 1)}\n-->\n"
            '<xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">\n'
            f"{self.indent(self.variables_xml(), 1)}\n" + "\n".join(blocks) + "\n</xml>\n"
        )


# ==========================================================================
# shared preset builder
# ==========================================================================
def build(spec):
    e = Emitter()
    plan = "ai decision"

    defaults = [
        ("base stake", "0.35"),
        ("stake", None),                       # = base stake
        ("ai loss limit", "10"),
        ("ai profit target", "10"),
        ("ai stake percent", "5"),
        ("ai max stake", spec.get("max_stake", "1.5")),
        ("ai kelly fraction", "0.1"),
        ("ai duration", spec.get("duration", "5")),
        ("ai probability floor", spec.get("floor", "0")),
        ("ai min edge", spec.get("min_edge", "0.004")),
        ("ai max tie", spec.get("max_tie", "0.2")),
        ("ai min agreement", spec.get("agreement", "0.55")),
        ("ai min confidence", spec.get("confidence", "55")),
        ("ai payout", spec.get("payout", "0.95")),
        ("ai min ev", spec.get("min_ev", "0")),
        ("ai entry slip", spec.get("slip", "1")),
        ("ai loss streak stop", "3"),
        ("ai loss streak", "0"),
        ("ai skip count", "0"),
        ("ai contracts", "0"),
        # The AI multi-market scan and the entry cadence. The scan reads every
        # market Signal Lab shares once every `ai scan every` seconds and the
        # bot moves only when the challenger clears `ai scan floor` and beats
        # the market it is on by `ai scan margin`, never more often than
        # `ai scan dwell`. `ai cadence` is the at-least-one-trade-a-minute
        # clock: after that many seconds without a purchase the quality gates
        # stand aside while every money gate keeps its own value.
        ("ai scan every", "8"),
        ("ai scan floor", "25"),
        ("ai scan margin", "3"),
        ("ai scan dwell", "25"),
        ("ai cadence", "60"),
        # Session profit measured from the equity the bot started with: the
        # engine reports realised profit for the whole run, so a bot that is
        # restarted mid-run would otherwise see someone else's losses as its own.
        ("baseline profit", "0"),
    ]
    if spec["mode"] == "tick":
        # The structural knobs only exist on the High/Low Tick family: there is
        # no DNA gate to apply on a directional contract. The multi-market
        # scan runs on every family.
        defaults += [
            ("ai dna floor", spec.get("dna_floor", "0")),
            ("ai skill floor", spec.get("skill_floor", "-1")),
            ("ai market", ""),
        ]
    init = []
    for name, value in defaults:
        if name == "stake":
            init.append(e.set_("stake", e.get("base stake")))
        elif name == "ai market":
            # The market is a symbol, not a number: the scan assigns a string
            # to it, so it has to start as one.
            init.append(e.set_(name, e.text(value)))
        else:
            init.append(e.set_(name, e.num(value)))
    if spec.get("hedge_ratio"):
        init.insert(4, e.set_("ai hedge ratio", e.num(spec["hedge_ratio"])))
        init.insert(5, e.set_("ai legs", e.num(spec["legs"])))
    init.append(e.set_("ai baseline", e.block("x_session_profit")))
    init.append(
        e.set_(
            plan,
            e.decision(
                spec["mode"],
                e.get("ai duration"),
                e.get("ai probability floor"),
                e.get("ai max tie"),
                e.get("ai min agreement"),
                e.get("ai min edge"),
                e.get("ai payout"),
                e.get("ai min confidence"),
                spec.get("require", "edge"),
                e.get("ai min ev"),
                e.get("ai entry slip"),
            ),
        )
    )
    init.append(e.set_("ai ready", e.part("ready", e.get(plan))))
    init.append(e.set_("ai side", e.part("side", e.get(plan))))
    init.append(e.notify("info", e.text(spec["armed"])))
    if spec["mode"] == "tick":
        # The market's structural fingerprint, before a single contract is
        # bought: tie rate, grid ratio, drift and readability. A bot that starts
        # by describing where it is standing is a bot whose later silence can be
        # read.
        init.append(e.notify("info", e.block("x_price_dna")))
        init.append(e.notify("info", e.block("x_price_payout_table")))
        # Five ticks is not a duration until the tick rate is known. The clock
        # prints the contract length, the measured look-to-fill slip and how much
        # of a cycle one buy covers, so a ten-second contract on a 2 s market is
        # visible in the journal rather than implied.
        init.append(e.notify("info", e.block("x_price_clock")))
        if spec.get("apex"):
            # The v6 brain introduces itself: the deep net's training state and
            # the regime call, then the deep reverse-engineering diagnosis the
            # auto-tuning is derived from.
            init.append(e.notify("info", e.block("x_price_brain")))
            init.append(e.notify("info", e.block("x_price_reverse")))

    # ---- tick analysis: decide, then size the stake the buy will use ------
    tick = [
        # Exactly one market can be traded at a time, but every market can be
        # read: the AI scan runs this bot's own model over every stream Signal
        # Lab shares, all at the same moment, and `ai market` is the one it
        # rated most suitable. The models, the stake and every gate below are
        # unchanged — the scan only decides where the bot stands.
        e.market_scan(
            "high-low-tick" if spec["mode"] == "tick" else "rise-fall",
            e.get("ai duration"),
            e.get("ai payout"),
            e.get("ai entry slip"),
            e.get("ai max tie"),
        ),
        e.set_("ai market", e.scan_switch_best()),
    ]
    tick += [
        e.set_(
            "baseline profit",
            e.arith("MINUS", e.block("x_session_profit"), e.get("ai baseline")),
        ),
        e.set_(
            plan,
            e.decision(
                spec["mode"],
                e.get("ai duration"),
                e.get("ai probability floor"),
                e.get("ai max tie"),
                e.get("ai min agreement"),
                e.get("ai min edge"),
                e.get("ai payout"),
                e.get("ai min confidence"),
                spec.get("require", "edge"),
                e.get("ai min ev"),
                e.get("ai entry slip"),
            ),
        ),
        e.set_("ai ready", e.part("ready", e.get(plan))),
        e.set_("ai side", e.part("side", e.get(plan))),
        e.set_(
            "stake",
            e.stake(
                e.get(plan),
                e.get("base stake"),
                e.get("ai kelly fraction"),
                e.get("ai stake percent"),
                e.get("ai max stake"),
            ),
        ),
    ]

    # ---- purchase conditions ---------------------------------------------
    # A rendered block must never be pasted twice: two elements sharing an id
    # make Blockly bind the wrong one. Build the exposure multiplier fresh for
    # each use.
    legs = lambda: e.get("ai legs") if spec.get("hedge_ratio") else e.num("1")
    # Confidence is gated inside the engine (see `decision`), so what is left
    # here is the part that depends on the session: a losing streak widens the
    # floor instead of stopping the bot dead.
    # Rendered on demand: a block string carries its own ids, so a value reused
    # in two places would put the same id in the document twice and Blockly
    # would bind the wrong one.
    def streak_ok():
        return e.logic(
            "OR",
            e.compare("LT", e.get("ai loss streak"), e.get("ai loss streak stop")),
            e.compare(
                "GTE",
                e.part("confidence", e.get(plan)),
                e.arith("ADD", e.get("ai min confidence"), e.num("5")),
            ),
        )

    risk_ok = e.logic(
        "AND",
        streak_ok(),
        e.risk(e.get("stake"), legs(), e.get("ai stake percent")),
    )
    if spec["mode"] == "tick":
        # Three more guards that only make sense on this contract family:
        #
        #   the record   — a graded record whose whole interval sits under the
        #                  break-even is a broken estimate, not bad luck;
        #   the DNA      — a market whose structure cannot be measured is not a
        #                  market to size a position on;
        #   the skill    — a blend that cannot beat its own structural anchor
        #                  walk-forward has not earned an entry (ships off).
        risk_ok = e.logic(
            "AND",
            risk_ok,
            e.logic(
                "AND",
                e.logic(
                    "AND",
                    e.compare("EQ", e.part("stand-down", e.get(plan)), e.num("0")),
                    e.compare("GTE", e.part("dna-score", e.get(plan)), e.get("ai dna floor")),
                ),
                e.compare("GTE", e.part("skill", e.get(plan)), e.get("ai skill floor")),
            ),
        )
    # At least one entry a minute: when a whole `ai cadence` window passes with
    # no purchase, the gates that are about *quality* — the DNA floor, the skill
    # floor, a mild confidence bar — stand aside. Every money gate stays: the
    # risk block, the losing-streak cool-off and, on this contract family, the
    # graded-record stand-down. The cadence reports, it never trades by itself.
    cadence_money = e.logic(
        "AND",
        streak_ok(),
        e.risk(e.get("stake"), legs(), e.get("ai stake percent")),
    )
    if spec["mode"] == "tick":
        cadence_money = e.logic(
            "AND",
            cadence_money,
            e.compare("EQ", e.part("stand-down", e.get(plan)), e.num("0")),
        )
    cadence_ok = e.logic(
        "AND",
        e.compare("EQ", e.trade_due(), e.num("1")),
        e.logic(
            "AND",
            e.compare("EQ", e.get("ai ready"), e.num("1")),
            cadence_money,
        ),
    )
    entry_gate = e.logic(
        "OR",
        e.logic(
            "AND",
            e.compare("EQ", e.get("ai ready"), e.num("1")),
            risk_ok,
        ),
        cadence_ok,
    )

    if spec["mode"] == "tick":
        buy = e.block(
            "x_tick_decision_purchase",
            values={"SIDE": e.get("ai side"), "TICK": e.part("tick", e.get(plan))},
        )
    elif spec.get("hedge_ratio"):
        buy = e.block(
            "hedge_purchase",
            fields={"PURCHASE_LIST": "CALL", "HEDGE_LIST": "PUT"},
            values={"HEDGE_STAKE": e.get("ai hedge ratio")},
        )
    else:
        buy = e.if_(
            e.compare("EQ", e.get("ai side"), e.num("1")),
            e.block("purchase", fields={"PURCHASE_LIST": "CALL"}),
            [e.block("purchase", fields={"PURCHASE_LIST": "PUT"})],
        )

    before = [
        e.if_(
            e.compare("EQ", e.get("ai ready"), e.num("0")),
            [
                e.set_("ai skip count", e.arith("ADD", e.get("ai skip count"), e.num("1"))),
                e.if_(
                    e.compare("EQ", e.mod(e.get("ai skip count"), e.num("20")), e.num("1")),
                    e.notify("info", e.block("x_price_reason")),
                ),
            ],
            [
                e.if_(
                    entry_gate,
                    [
                        e.set_("ai skip count", e.num("0")),
                        e.notify("success", e.block("x_price_reason")),
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

    # ---- after settlement -------------------------------------------------
    brakes = e.logic(
        "AND",
        e.risk(e.get("base stake"), legs(), e.get("ai stake percent")),
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
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("5")), e.num("0")),
            e.notify("info", e.block("x_price_calibration")),
        ),
        # Which expert is actually carrying the decision, and how the market is
        # behaving. Every 25 settlements is often enough to see a regime change
        # without turning the journal into noise.
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_price_model_weights")),
        ),
        # The self-audit layer. Every line below is measured, not modelled:
        # what the blend has actually achieved, which expert is carrying it,
        # what the market's structure looks like now, and what each position is
        # really paying.
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("10")), e.num("0")),
            e.notify("info", e.block("x_price_audit")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_price_league")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_price_dna")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            e.notify("info", e.block("x_price_clock")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("5")), e.num("0")),
            e.notify("info", e.block("x_price_payout_table")),
        ),
        e.if_(
            brakes,
            [e.block("trade_again")],
            [e.notify("warn", e.text(spec["stopped"]))],
        ),
    ]
    if spec.get("apex"):
        # The v6 journal cadence slips in ahead of the session brakes: the AI
        # core and the reverse engineering every 25 settlements, the outcome
        # forecast alongside every payout ladder.
        brakes_if = after.pop()
        after += [
            e.if_(
                e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
                e.notify("info", e.block("x_price_brain")),
            ),
            e.if_(
                e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
                e.notify("info", e.block("x_price_reverse")),
            ),
            e.if_(
                e.compare("EQ", e.mod(e.get("ai contracts"), e.num("5")), e.num("0")),
                e.notify("info", e.block("x_price_forecast")),
            ),
            brakes_if,
        ]

    blocks = [
        e.trade_definition(
            spec["market"],
            spec["submarket"],
            spec["symbol"],
            spec["tradetype_cat"],
            spec["tradetype"],
            e.get("ai duration"),
            e.get("stake"),
            init,
        ),
        e.section("tick_analysis", spec["ids"]["tick"], tick, 0, 1500, "TICKANALYSIS_STACK"),
        e.section("before_purchase", spec["ids"]["before"], before, 0, 760, "BEFOREPURCHASE_STACK"),
        e.section("after_purchase", spec["ids"]["after"], after, 760, 760, "AFTERPURCHASE_STACK"),
    ]
    return e.document(spec["comment"], blocks)



# ==========================================================================
# the Markov hedge builder
# ==========================================================================
def build_markov(spec):
    """Step Index, four ticks, one exact Markov read, a partial hedge and a ladder.

    Deliberately not the same program as `build()`:

      * the four-tick window is the contract, not a knob to be talked out of,
        so the tie is priced rather than avoided — a strict Rise/Fall loses the
        stake when the exit prints equal to the entry, and on a fixed-step index
        that is 6 of the 16 four-step paths;
      * the side is the *main leg*, chosen per cycle. A hedge block names its
        two contracts in fields, so "buy the model's side and cover it" can only
        be true if the two directions are two blocks, one per side;
      * the stake is a user-owned ladder (base stake, multiplier, steps, cap)
        rather than a Kelly sizing. The user asked for it, so the bot prints
        what the ladder is doing instead of hiding it behind a fraction.
    """
    e = Emitter()
    plan = "ai decision"
    markov = "ai markov"

    # ---- the decision and the chain, both re-read on every tick ----------
    def dec(em):
        return em.decision(
            "step-hedge",
            em.get("ai duration"),
            em.num("0"),                      # no absolute probability floor
            em.get("ai max tie"),
            em.num("0"),                      # no agreement floor: the Markov gate is sharper
            em.get("ai min edge"),
            em.get("ai payout"),
            em.get("ai min confidence"),
            "always",                         # cadence: the gates below decide, not this one
            em.num("0"),
            em.get("ai entry slip"),
        )

    def mk(em):
        return em.block(
            "x_price_markov",
            values={
                "LIST": em.block("ticks"),
                "ORDER": em.get("ai markov order"),
                "HORIZON": em.get("ai duration"),
                "MEMORY": em.get("ai markov memory"),
                "PAYOUT": em.get("ai payout"),
                "MIN_SAMPLES": em.get("ai markov min samples"),
                "MAX_TIE": em.get("ai max tie"),
            },
        )

    def part(name):
        return e.mpart(name, e.get(markov))


    knobs = [
        # ---- the user's money knobs (edit these) -------------------------
        ("base stake", spec.get("base_stake", "0.35")),
        ("martingale multiplier", spec.get("multiplier", "1.8")),
        ("martingale steps", spec.get("steps", "2")),
        ("max stake", spec.get("max_stake", "2")),
        ("stake percent", spec.get("stake_percent", "5")),
        ("take profit", spec.get("take_profit", "5")),
        ("stop loss", spec.get("stop_loss", "5")),
        ("hedge ratio", spec.get("hedge_ratio", "0.3")),
        ("hedge legs", spec.get("legs", "1.3")),
        ("ai duration", spec.get("duration", "4")),
        # ---- the read ------------------------------------------------------
        ("ai payout", spec.get("payout", "0.95")),
        ("ai max tie", spec.get("max_tie", "0.45")),
        ("ai min edge", spec.get("min_edge", "0")),
        ("ai min confidence", spec.get("confidence", "0")),
        ("ai entry slip", spec.get("slip", "1")),
        ("ai markov order", spec.get("markov_order", "3")),
        ("ai markov memory", spec.get("markov_memory", "400")),
        ("ai markov min samples", spec.get("markov_samples", "120")),
        ("ai markov min z", spec.get("markov_z", "0.75")),
        ("ai markov min lift", spec.get("markov_lift", "0.01")),
        # Ships off (-1): the tie tax makes the unconditional four-tick shape
        # negative-EV, and a bot that refuses every entry teaches nothing. Set
        # 0 to refuse any entry whose modelled expected value is negative.
        ("ai markov min ev", spec.get("markov_ev", "-1")),
        # 1 = the ensemble and the chain must name the same side. Two models
        # that were fitted differently agreeing is the sharpest filter here.
        ("ai markov agreement", spec.get("markov_agreement", "1")),
    ]
    init = []
    for name, value in knobs:
        init.append(e.set_(name, e.num(value)))
    init.append(e.set_("stake", e.get("base stake")))
    init.append(e.set_("ai ladder step", e.num("0")))
    init.append(e.set_("ai ladder resets", e.num("0")))
    init.append(e.set_("ai contracts", e.num("0")))
    init.append(e.set_("ai skip count", e.num("0")))
    init.append(e.set_("ai baseline", e.block("x_session_profit")))
    init.append(e.set_("baseline profit", e.num("0")))
    init.append(e.set_(plan, dec(e)))
    init.append(e.set_(markov, mk(e)))
    init.append(e.set_("ai ready", e.part("ready", e.get(plan))))
    init.append(e.set_("ai side", e.part("side", e.get(plan))))
    init.append(e.set_("ai markov side", e.mpart("side", e.get(markov))))
    init.append(e.notify("info", e.text(spec["armed"])))
    init.append(e.notify("info", e.block("x_price_dna")))
    init.append(e.notify("info", e.block("x_price_clock")))

    tick = [
        e.set_(
            "baseline profit",
            e.arith("MINUS", e.block("x_session_profit"), e.get("ai baseline")),
        ),
        e.set_(plan, dec(e)),
        e.set_("ai ready", e.part("ready", e.get(plan))),
        e.set_("ai side", e.part("side", e.get(plan))),
        e.set_(markov, mk(e)),
        e.set_("ai markov side", e.mpart("side", e.get(markov))),
    ]

    # ---- the entry gates --------------------------------------------------
    def markov_ok():
        """The chain has to be readable, decisive and inside the tie budget."""
        return e.logic(
            "AND",
            e.logic(
                "AND",
                e.compare("EQ", part("ready"), e.num("1")),
                e.compare("EQ", part("tie-ok"), e.num("1")),
            ),
            e.logic(
                "AND",
                e.logic(
                    "AND",
                    e.compare("GTE", part("z"), e.get("ai markov min z")),
                    e.compare("GTE", part("lift"), e.get("ai markov min lift")),
                ),
                e.logic(
                    "AND",
                    e.compare("GTE", part("ev"), e.get("ai markov min ev")),
                    e.compare("GTE", part("edge"), e.get("ai min edge")),
                ),
            ),
        )

    def agrees():
        """Optional: both models must name the same side."""
        return e.logic(
            "OR",
            e.compare("EQ", e.get("ai markov agreement"), e.num("0")),
            e.compare("EQ", e.get("ai markov side"), e.get("ai side")),
        )

    def risk_ok(stake=None, legs=None):
        """The pair's combined exposure against the balance and the session brakes."""
        return e.block(
            "x_price_risk",
            values={
                "STAKE": stake or e.get("stake"),
                "LEGS": legs or e.get("hedge legs"),
                "BASELINE": e.get("ai baseline"),
                "LOSS": e.get("stop loss"),
                "TARGET": e.get("take profit"),
                "PERCENT": e.get("stake percent"),
            },
        )

    def entry_gate():
        return e.logic(
            "AND",
            e.compare("EQ", e.get("ai ready"), e.num("1")),
            e.logic("AND", markov_ok(), e.logic("AND", agrees(), risk_ok())),
        )

    def buy():
        """Buy the model's side as the main leg, cover it with the opposite.

        The hedge block names both contracts in dropdown fields, so a single
        block cannot follow a decision that flips side. Two blocks, one per
        direction, is what makes `hedge ratio` describe a hedge *of the
        decision* rather than a permanent long-rise position.
        """
        def leg(em, main, cover):
            return em.block(
                "hedge_purchase",
                fields={"PURCHASE_LIST": main, "HEDGE_LIST": cover},
                values={"HEDGE_STAKE": em.get("hedge ratio")},
            )

        return e.if_(
            e.compare("EQ", e.get("ai side"), e.num("1")),
            [leg(e, "CALL", "PUT")],
            [leg(e, "PUT", "CALL")],
        )

    before = [
        e.if_(
            entry_gate(),
            [
                e.set_("ai skip count", e.num("0")),
                e.notify("success", e.block("x_price_reason")),
                buy(),
            ],
            [
                e.set_("ai skip count", e.arith("ADD", e.get("ai skip count"), e.num("1"))),
                # A held cycle explains itself with the chain's own numbers: the
                # journal shows the probability, the tie, the z and the gate
                # rather than a bot that simply waits.
                e.if_(
                    e.compare("EQ", e.get("ai ready"), e.num("1")),
                    e.if_(
                        e.compare("EQ", e.mod(e.get("ai skip count"), e.num("10")), e.num("1")),
                        [
                            e.notify("info", e.block("x_price_markov_report")),
                            e.notify("warn", e.text(spec["held"])),
                        ],
                    ),
                    e.if_(
                        e.compare("EQ", e.mod(e.get("ai skip count"), e.num("20")), e.num("1")),
                        e.notify("info", e.block("x_price_reason")),
                    ),
                ),
            ],
        )
    ]

    # ---- settlement, the ladder and the session brakes -------------------
    def ladder():
        """A loss multiplies the next stake; a win, or a full ladder, resets it.

        Both the cap and the ladder length are the user's: `max stake` is a hard
        ceiling the multiplication can never pass, and `martingale steps` is how
        many times the ladder may climb before it is abandoned and the base
        stake is restored. A reset is announced, because a ladder that has been
        running is something the operator should see.
        """
        climb = e.if_(
            e.compare(
                "GT",
                e.arith("MULTIPLY", e.get("stake"), e.get("martingale multiplier")),
                e.get("max stake"),
            ),
            [e.set_("stake", e.get("max stake"))],
            [e.set_("stake", e.arith("MULTIPLY", e.get("stake"), e.get("martingale multiplier")))],
        )
        return e.if_(
            e.block("contract_check_result", fields={"CHECK_RESULT": "win"}),
            [
                e.set_("ai ladder step", e.num("0")),
                e.set_("stake", e.get("base stake")),
            ],
            [
                e.set_("ai ladder step", e.arith("ADD", e.get("ai ladder step"), e.num("1"))),
                e.if_(
                    e.compare("GTE", e.get("ai ladder step"), e.get("martingale steps")),
                    [
                        e.set_("ai ladder step", e.num("0")),
                        e.set_("stake", e.get("base stake")),
                        e.set_(
                            "ai ladder resets",
                            e.arith("ADD", e.get("ai ladder resets"), e.num("1")),
                        ),
                        e.notify("warn", e.text(spec["reset"])),
                    ],
                    [climb],
                ),
            ],
        )

    # The brakes are entry checks, not guaranteed exits: an open pair can settle
    # through them, and a ladder can put the next stake above what remains.
    brakes = e.logic(
        "AND",
        e.logic(
            "AND",
            e.compare(
                "GT",
                e.get("baseline profit"),
                e.arith("MULTIPLY", e.num("-1"), e.get("stop loss")),
            ),
            e.compare("LT", e.get("baseline profit"), e.get("take profit")),
        ),
        risk_ok(stake=e.get("base stake")),
    )

    after = [
        ladder(),
        e.set_("ai contracts", e.arith("ADD", e.get("ai contracts"), e.num("1"))),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("5")), e.num("0")),
            e.notify("info", e.block("x_price_calibration")),
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("10")), e.num("0")),
            [e.notify("info", e.block("x_price_markov_report")), e.notify("info", e.block("x_price_audit"))],
        ),
        e.if_(
            e.compare("EQ", e.mod(e.get("ai contracts"), e.num("25")), e.num("0")),
            [
                e.notify("info", e.block("x_price_model_weights")),
                e.notify("info", e.block("x_price_dna")),
            ],
        ),
        e.if_(brakes, [e.block("trade_again")], [e.notify("warn", e.text(spec["stopped"]))]),
    ]

    blocks = [
        e.trade_definition(
            spec["market"],
            spec["submarket"],
            spec["symbol"],
            spec["tradetype_cat"],
            spec["tradetype"],
            e.get("ai duration"),
            e.get("stake"),
            init,
        ),
        e.section("tick_analysis", spec["ids"]["tick"], tick, 0, 1500, "TICKANALYSIS_STACK"),
        e.section("before_purchase", spec["ids"]["before"], before, 0, 760, "BEFOREPURCHASE_STACK"),
        e.section("after_purchase", spec["ids"]["after"], after, 760, 760, "AFTERPURCHASE_STACK"),
    ]
    return e.document(spec["comment"], blocks)


# ==========================================================================
# the presets
# ==========================================================================
RISE_FALL = {
    "mode": "rise",
    # Keep a cadence: the ensemble still names the side and Kelly still sizes
    # it, but a fair market is a reason to trade the minimum stake, not a reason
    # to sit out. Set this to "edge" to restore the opportunistic behaviour.
    "require": "always",
    "market": "volidx",
    "submarket": "step_index",
    "symbol": "stpRNG",
    "tradetype_cat": "callput",
    "tradetype": "callput",
    "ids": {"tick": "rfTick01", "before": "rfBefore01", "after": "rfAfter01"},
    "armed": (
        "Rise/Fall AI armed — Step Index 100, five ticks. Sixteen price experts mixed by measured "
        "skill and gated by the live market regime, with a deep online brain learning from settled "
        "windows; an entry needs a positive edge over the payout break-even, side agreement, "
        "confidence and the risk gate. Skips explain themselves; every fifth entry prints the "
        "realised hit rate."
    ),
    "held": (
        "AI is ready but the entry gate held it — a losing-streak cool-off, the balance "
        "percentage, the loss limit or the profit target blocked this entry."
    ),
    "stopped": (
        "AI session stop — the loss limit, the profit target or the balance rule was reached. "
        "Open contracts still settle; restart the bot to begin a new session."
    ),
    "comment": """
Rise/Fall AI ensemble — Step Index 100, five ticks.

Sixteen experts answer the same question and are mixed by how well they have actually done:
structural anchor, long-run digit-step frequency, the Markov row for the current two-change
state, the last 250 windows, a kernel replay of states that looked like this one, an
analytical drift forecast, a serial-dependence fit, a deep online neural net, and a regime model
that switches between continuation and mean reversion depending on whether volatility is
expanding or the market is quiet and stretched, plus a position Markov chain, an
expansion-scaled volatility tilt, a microtrend pressure gauge, a granularity-range selector, an
entropy concentration reader, a Hurst long-memory probe and a phase-cycle reader. Each is scored
walk-forward with a Brier loss and the weights follow the multiplicative-weights rule, gated by
the live market regime, so a model that cannot read this market loses its vote on its own. The
blend is then shrunk toward the market base rate by its effective sample size.

Two calibration layers sit on top of that, and they are the difference between a bot that
looks clever and one that is measured:

  1. The rule's own record. Every published decision is graded against the tick that settled
     it. A record at or above the payout break-even sharpens the estimate; a record below it
     pulls the estimate back toward the structural anchor by the ratio. That is why a bad run
     now shrinks the stake instead of parking the bot: Kelly sizes the discounted estimate to
     the exchange minimum, and the bot keeps reading.
  2. The stake. Tenth-Kelly on the calibrated probability and the payout the contract actually
     quotes, floored at the exchange minimum, capped by "ai max stake" and the balance
     percent, and reduced while the session is losing.

The entry mode is "on the best read available": the ensemble's best side is bought on every
tick it can read, because Step Index is close to a fair random walk and an edge gate that
waits for a statistically significant lean sits out most of the tape. What that costs is
visible rather than hidden — the entry line prints the probability, the break-even, the edge,
the tie rate and the measured record. Set the decision block's entry field to "only with a
measured edge" if you would rather trade rarely and only on evidence.

THE MARKET
One Deriv contract is one market, but every market can be read. Every "ai scan every" seconds
this bot's own ensemble scores every market Signal Lab shares, all at the same moment, on one
comparable scale (measured EV, certainty, readability, sample and walk-forward skill), and the
bot stands on the most suitable one: only when that market clears "ai scan floor", beats the
market it is on by "ai scan margin", and "ai scan dwell" seconds have passed. The scan never
opens an order — the Purchase block below still buys, on the market the scan chose, with this
strategy's own stake and gates. If a whole "ai cadence" minute passes without a purchase, the
quality gates stand aside so the bot still trades at least once a minute; the stake, the loss
limit, the profit target, the drawdown brake and the losing-streak cool-off are never relaxed.

An even horizon on a fixed-step market ties about a third of windows and every tie loses, so
the horizon is the odd five-tick contract, and a measured tie rate above "ai max tie" refuses
the shape instead of hiding it. The decision is taken in Tick analysis, so the stake it sizes
is the stake Trade options sends. Session brakes: loss limit, profit target, drawdown and a
losing-streak cool-off. Every fifth settlement the journal prints the realised hit rate, every
twenty-fifth prints which expert is carrying the decision.

Estimates are historical and conditional, not calibrated odds. Test on demo first.
""",
}

STEP_MARKOV = {
    # Step Index, four ticks, a hedge whose main leg is the model's side.
    "mode": "step-hedge",
    "market": "volidx",
    "submarket": "step_index",
    "symbol": "stpRNG",
    "tradetype_cat": "callput",
    "tradetype": "callput",
    # ---- the user's money knobs -----------------------------------------
    "base_stake": "0.35",
    "multiplier": "1.8",
    "steps": "2",
    "max_stake": "2",
    "stake_percent": "5",
    "take_profit": "5",
    "stop_loss": "5",
    "hedge_ratio": "0.3",
    "legs": "1.3",
    # ---- the read -------------------------------------------------------
    "duration": "4",
    "payout": "0.95",
    "max_tie": "0.45",
    "min_edge": "0",
    "confidence": "0",
    "slip": "1",
    "markov_order": "3",
    "markov_memory": "400",
    "markov_samples": "120",
    "markov_z": "0.75",
    "markov_lift": "0.01",
    # Off by default: the strict four-tick shape pays a 37.5 % tie tax, so an
    # EV floor of 0 would refuse nearly every window and the bot would never
    # trade. Raise it to 0 to demand a positive modelled edge.
    "markov_ev": "-1",
    "markov_agreement": "1",
    "ids": {"tick": "smTick01", "before": "smBefore01", "after": "smAfter01"},
    "armed": (
        "Step Index Markov hedge armed — Step Index 100, four ticks. An order-three Markov chain on "
        "the tick directions is projected over the whole contract (ties included, because a strict "
        "Rise/Fall loses on them) and the sixteen-expert ensemble reads the same tape; the bot buys "
        "the model\'s side as the main leg and covers it with a fraction-sized opposite leg, on every "
        "tick both models agree and the chain clears its tie ceiling, z and lift gates. Stake ladder: "
        "base stake x martingale multiplier, capped by max stake and abandoned after martingale steps "
        "losses. Take profit and stop loss are session brakes."
    ),
    "held": (
        "Markov hedge held this cycle — the gate that stopped it is printed above: a thin chain, a "
        "four-tick tie rate over the ceiling, a lean too weak for its own sample (z), no lift over "
        "the unconditional read, a negative modelled expected value, the ensemble naming the other "
        "side, the stake ladder over the balance percent or the remaining loss budget."
    ),
    "reset": (
        "Step Index Markov hedge: the stake ladder reached its step limit and was abandoned — the next "
        "stake is the base stake again. The ladder is a recovery ladder, not a promise: on this shape "
        "it is paid for by the four-tick tie."
    ),
    "stopped": (
        "Step Index Markov hedge stopped — the take profit, the stop loss or the balance rule was "
        "reached. Open contracts still settle; restart the bot to begin a new session."
    ),
    "comment": """
Step Index Markov hedge — Step Index 100, four ticks, one exact chain instead of a vote.

THE CONTRACT
Four ticks. The window is the contract, so the shape is the shape: of the sixteen +1/-1
four-step paths, five finish up, five finish down and six finish back at the entry. A strict
Rise/Fall loses the stake on that sixth case — Deriv's own contract type for "win on equal" is
CALLE/PUTE, not CALL/PUT — so P(tie) is a cost of the shape and this bot prices it instead of
hoping it away. At a 0.95 payout a win pays 1.95x, so a contract needs 1/(1+0.95) = 51.3 % to
break even, and the unconditioned four-tick shape offers 31.25 % on either side. The bot
therefore does not trade the shape unconditioned; it trades *states* where the chain's projection
is better than that, and it stands aside when it is not.

THE CHAIN
An order-three Markov chain is fitted on the tick directions (up / flat / down) over the last
"ai markov memory" steps, with every state pulled toward the market's own base rate by a small
Dirichlet prior so a state seen twice cannot speak for it. The forecast is not "the one-step
probability raised to the fourth power": the module carries a distribution over (chain state,
net displacement) forward one tick at a time, so the last layer is the exact settlement
distribution of a four-tick contract — P(up), P(down) and P(tie), with the tie charged as a loss.
Everything the gate reads is measured on that distribution:

  ready          the chain has fitted "ai markov min samples" transitions and the current state
                 has been seen often enough (at least 1/8 of that) to speak for itself;
  tie-ok         P(tie) is under "ai max tie". This is the gate the shape needs: an even horizon
                 on a fixed-step index ties 37.5 % unconditionally, and a persistent stretch of
                 tape is the only thing that lowers it;
  z              how many standard errors the chosen side's probability sits above its own
                 unconditional read, on the state's own sample count — a lean from twelve
                 transitions is not a lean;
  lift           the same difference as a probability, so a thin state with a big z cannot pass;
  ev             p(1 + payout) - 1 for the chosen side, with the tie charged. Ships off (-1);
                 set "ai markov min ev" to 0 to refuse every negative-expectation entry;
  agreement      the ensemble and the chain must name the same side. They are fitted on the same
                 tape with different mathematics, so agreement is the sharpest filter here.

THE HEDGE
The main leg is the model's side and the cover is "hedge ratio" of the main stake on the
opposite side. Two hedge blocks, one per direction, because a hedge block names its two
contracts in fields: with a single block the main leg would always be Rise whatever the models
said. Two equal legs would lock in the spread on every cycle, so the cover is deliberately
partial — it caps the swing without turning the trade into a guaranteed loss. At the 0.35 base
stake a 0.3 cover rounds to 0.11, under Deriv's own minimum, so the first cycles buy the model's
side alone and the journal says so; the pair appears once the ladder carries enough stake. Both legs are
risk-checked at the pair's combined exposure ("hedge legs" = 1 + ratio) before either order is
sent, and After purchase waits for both to settle.

THE LADDER AND THE BRAKES
After a losing cycle the stake is multiplied by "martingale multiplier", up to "max stake", and
"martingale steps" says how many rungs the ladder may climb before it is abandoned and the base
stake restored; a win always restores it. A ladder is a recovery device, not an edge: on a shape
whose expectation is negative it turns a slow loss into a fast one, which is why the cap, the
step limit, the balance percent and the stop loss all exist and why every reset is announced.
"take profit" and "stop loss" measure the bot's own session profit from the equity it started
with, and are entry checks — an open pair can settle through them.

THE CADENCE
There is no dwell, no cooldown and no market scan: the bot stands on Step Index, re-reads on the
tick after each settlement, and buys on every cycle that clears its gates. On a fair tape that is
a minority of cycles, and that is the point — this bot is built to open many positions per
minute only while the chain has something to say. The physical ceiling is the contract: four
ticks on a two-second market is eight seconds open, so about seven cycles a minute, fourteen
contracts if both legs count. To trade more of those cycles, lower "ai markov min z" and
"ai markov min lift" toward zero — the bot will buy on almost every readable tick and the entry
line will show exactly what each read was worth. The journal prints the chain's numbers on every
held cycle (every tenth) and on every tenth settlement, so "why did it not trade" is answered with
figures rather than a shrug.

HONESTY
These are conditional frequencies measured on this market's own ticks, not calibrated odds, and a
positive modelled edge means only "this read beat the price", which is often false. The four-tick
strict shape is a losing shape unless the chain finds real structure; no staking plan changes
that. Test on demo first.
""",
}

TICK_SNIPER = {
    "mode": "tick",
    "market": "volidx",
    "submarket": "random_index",
    "symbol": "R_100",
    "tradetype_cat": "highlowticks",
    "tradetype": "highlowticks",
    # The APEX core (v6): sixteen experts, a deep online brain, regime-gated
    # mixture, DNA v2 auto-reverse-engineering and per-outcome calibration.
    "apex": True,
    # Cadence posture: trade the best read every cycle instead of waiting for a
    # statistically significant edge. Measured on live-like ladders, the old
    # sniper posture (min_ev 0.01 one-sigma) published 0 entries in ~800 ticks
    # on R_100-likes — a bot that never trades teaches nothing. The cadence
    # still buys the best of ten by expected value; Kelly sizes thin reads to
    # the exchange minimum, and the journal prints the EV, quote and record
    # behind every entry so the cost of the cadence is visible, not hidden.
    # To restore the selective sniper: entry "only with a measured edge",
    # ai min ev 0.01, ai min agreement 0.5.
    "require": "always",
    # The value gate on this family is the expected value of the chosen
    # contract against the live ten-outcome ladder, not an absolute probability
    # (there is no single probability that means anything across five positions)
    # and not a scalar break-even (the ten quotes are different contracts).
    # Ships at 0 in cadence mode: the ladder still RANKS all ten outcomes, the
    # veto is off.
    "floor": "0",
    "min_edge": "0",
    "min_ev": "0",
    "max_tie": "0.35",
    "agreement": "0",
    # In cadence mode the engine does not veto on confidence; this knob paces
    # the losing-streak cool-off instead (trade through a 3-loss streak only at
    # confidence 55+). The DNA floor still refuses unreadable markets outright.
    "confidence": "50",
    # Fallback only: the live TICKHIGH/TICKLOW ladder prices every position, and
    # this number is used for the first ticks before the quotes arrive.
    "payout": "3.5",
    "max_stake": "1",
    "slip": "1",
    "dna_floor": "35",
    # Walk-forward skill floor on the blend vs the structural anchor. Ships at
    # -1 (off): the skill still shrinks the estimate through the trust curve,
    # and raising this knob makes it a hard entry gate instead.
    "skill_floor": "-1",
    "ids": {"tick": "hlTick01", "before": "hlBefore01", "after": "hlAfter01"},
    "armed": (
        "High/Low Tick AI Sniper v6 armed — five-tick contract, cadence mode. Sixteen experts mixed by "
        "measured skill and gated by the live market regime, a deep online brain that learns from settled "
        "windows only, a tie-aware structural prior, and a live ten-outcome payout ladder: the bot buys "
        "the position with the highest expected value against what Deriv actually quotes on every cycle "
        "it can read, sizing thin reads down to the exchange minimum. Every skip names its gate; every "
        "tenth settlement prints the self-audit, every twenty-fifth the expert league, the market DNA, the "
        "AI core, the reverse engineering and the execution clock, every fifth the payout ladder and the "
        "outcome forecast. Demo first: estimates are not guarantees; confirm equal-extreme settlement with Deriv."
    ),
    "held": (
        "AI is ready but the entry gate held it — a losing-streak cool-off, the DNA floor, the skill floor, "
        "the rule's own graded record, the balance percentage, the loss limit or "
        "the profit target blocked this entry."
    ),
    "stopped": (
        "AI session stop — the loss limit, the profit target or the balance rule was reached. "
        "Open contracts still settle; restart the bot to begin a new session."
    ),
    "comment": """
High/Low Tick AI Sniper v6 (APEX core) — the five-tick contract Deriv sells for this trade type.

WHAT IS BEING BOUGHT
Of the next five quotes, which position holds the strict high or the strict low? Ten outcomes
(tick 1-5 high, tick 1-5 low). This model assumes a shared extreme loses on that side; Deriv's
published description does not specify the tie rule, so confirm it in demo. Under that assumption the
probability a contract is paid on is the conditional position probability times the chance that
this window prints a strict extreme at all. Sixteen experts answer it — tie-aware structural anchor,
long-run history, the two-change Markov row, the recent regime, a kernel replay of similar
moments, a drift forecast, positional persistence, a deep online neural net, a volatility-regime
model, a Markov chain on the last settled window's extreme, an expansion-scaled volatility tilt,
a microtrend pressure gauge, a granularity-range selector, an entropy concentration reader, a Hurst
long-memory probe and an extreme-phase cycle reader — each scored using delayed Brier losses on historical windows, so an expert that cannot read this market loses its vote on its own. The blend is
shrunk toward the structural prior by its effective sample size AND by its measured skill: a
blend that cannot beat the prior does not get to publish a 60 % probability.

THE INTERNAL BRAIN
The neural expert is a deep online network (8 market features → 10 tanh hidden units → softmax
over the ten outcomes), trained walk-forward with backpropagation on settled windows only, with
L2 decay so thin samples cannot teach it fantasies. A meta-learner keeps a separate Brier
scoreboard per market regime (expansion, reversion, balanced) and gates the live mixture by the
regime the tape is in: trend readers are trusted when a trend is on, range readers when it is
not. The AI core journal line reports the net's update count and weight norm, the live regime,
whether the regime board is trusted yet, and the three experts carrying the decision.

THE STRUCTURE, AND WHY IT IS NOT THE OBVIOUS ONE
The continuous random walk prior is the discrete arcsine law: over five ticks, position 1 and
position 5 are likeliest (27.3 % each) and the middle the least likely (14.1 %). Real ticks live
on a quote grid, and a grid walk is not the same animal. Enumerating every five-step +/-1 path
gives 18.75 / 12.5 / 6.25 / 12.5 / 18.75 with a TIE in 31.25 % of windows. The engine measures
the market's own tie rate and interpolates between the two structures, so a Step index is never
priced with a Volatility 100 prior. (v4 normalised each side to 100 % and forgot the tie mass:
on a Step index that overstated its win probability by 45 %.)

THE PAYOUT LADDER IS THE GAME
Deriv quotes TICKHIGH and TICKLOW per selected_tick, and those ten quotes are different
contracts. The bot reads all ten from live proposals and ranks outcomes by expected value,
p(m+1) - 1, against the quote it would actually be paid. It buys the best-ranked position on
every cycle it can read — "ai min ev" is the veto that restores selectivity (set the entry field
to "only with a measured edge" and ai min ev to 0.01 to refuse everything below a one-sigma
EV floor), and the journal prints the quote, the fair odds and the EV on every entry. A single
payout number cannot do any of this, which is why the old preset could not see a mispriced
position even in principle.

CADENCE, NOT VIGIL
This preset keeps a trading cadence: the ensemble's best read is bought on every cycle the bot
can read (about one position per contract length — five ticks plus re-entry), because a fair
market is a reason to trade the minimum stake, not a reason to sit out. Measured against
live-like ladders, the selective posture published 0 entries in ~800 ticks on R_100-like tape;
the cadence publishes on nearly every readable cycle, and what that costs is visible rather
than hidden — the entry line prints the probability, the quote, the EV and the measured record.
Kelly sizes thin reads to the 0.35 exchange minimum; the DNA floor still refuses unreadable
markets outright (the AI scan then moves the bot), and the losing-streak cool-off still paces
entries after three straight losses. After a whole minute without a purchase the quality gates
stand aside so the bot still trades at least once a minute; the money gates never do.

THE EXECUTION CLOCK
Five ticks is the contract, but it is not a duration until the tick rate is known: on R_100 a tick
is two seconds, so the contract lasts ten, and one buy covers a fifth of the cycle — which is why
a High/Low Tick bot always has five positions overlapping, each a one-in-five bet. The look-to-fill
time is measured from this session's own tick service and charged as entry slip; past three
quarters of a tick the bot refuses the market outright rather than trading a window it cannot be
filled inside of. The clock is printed at start-up and every twenty-fifth settlement.

SELF-AUDIT AND SELF-DEFENCE
Every published decision is filed with the tick it was made on and graded when the window
settles — per outcome, not just overall, so a high-tick-3 read that keeps missing is shrunk
without punishing the reads that earned their keep. The record is used, not just printed: a record
at or above the break-even sharpens the estimate, a record below it pulls the estimate back toward
the structural prior, and once forty decisions are graded a Wilson bound that still sits under the
break-even sets "stand down" and the bot stops buying until the record recovers. Every tenth
settlement prints the self-audit (skill, certainty, calibration, record vs break-even, tie forecast
vs long-run, DNA, quotes and label fidelity), every twenty-fifth the expert league, the market DNA,
the AI core, the reverse engineering and the clock, every fifth the live payout ladder and the
outcome forecast.

AUTO-REVERSE-ENGINEERING
Market DNA v2 fingerprints the tape far beyond ties and grid ratio: Hurst long-memory exponent,
extreme-shape entropy on both sides, spike (jump) rate, extreme-phase autocorrelation, tie
clustering, range compression and tick sigma. From those measurements the bot derives its own
auto-tuning — a wider EV bound on grid tape, heavier anchor trust on spike tape, patience on
compressed tape — and prints the whole diagnosis in the reverse-engineering journal line. The
"ai skill floor" knob (ships off at -1) can additionally refuse entries while the blend's
walk-forward skill is under water.

RISK
The stake is tenth-Kelly on the calibrated probability and the quoted payout, floored at
Deriv's 0.35 minimum, capped by "ai max stake" and the balance percent, and divided by the
session drawdown. There is no martingale: a loss never raises the next stake. The session brakes
are the loss limit, the profit target, the balance percentage and a losing-streak cool-off. One
tick of entry slip is charged against the estimate, because the contract's five ticks start
when Deriv processes the buy, not when the model looked.

THE MULTI-MARKET SCAN
High/Low Ticks are quoted on every synthetic index, and they do not pay the same. Every
"ai scan every" seconds the bot's own model reads every market Signal Lab shares, all at the
same moment, and scores them on one comparable scale (measured EV, certainty, DNA readability,
sample and walk-forward skill). The bot then stands on the most suitable one: only when that
market clears "ai scan floor", beats the market it is on by "ai scan margin", and "ai scan dwell"
seconds have passed. A switch costs a cold tick stream, so the margin and the dwell stop the bot
thrashing between them. The scan never opens an order — the Purchase block below still buys, on
the market the scan chose, with this strategy's own stake and gates.

HONESTY
These are historical, conditional estimates. Deriv prices this contract with the same
mathematics you just read, so a positive expected value means "my conditional read beats their
model" — a weak claim that is often false. The bot is built to say so: it prints its skill, its
record and the gate that stopped it. Test on demo first.
""",
}

if __name__ == "__main__":
    outputs = {
        "rise": (RISE_FALL, sys.argv[1]),
        "hedge": (STEP_MARKOV, sys.argv[2]),
        "tick": (TICK_SNIPER, sys.argv[3]),
    }
    for kind, (spec, path) in outputs.items():
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(build_markov(spec) if kind == "hedge" else build(spec))
        print("wrote", path)
