"""Generate the three shipped price-path DBot strategies.

    python3 artifacts/deriv-signal-lab/scripts/presets/gen_presets.py \
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/rise-fall-ensemble.xml \
        artifacts/deriv-signal-lab/src/lib/bot-store/bots/step-rise-fall-hedge.xml \
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

    def block(self, btype, fields=None, values=None, statements=None, nxt=None):
        for name in (fields or {}):
            if name == "VAR":
                self.var(fields[name])
        parts = [f'<block type="{btype}" id="{self.nid()}">']
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
    def decision(self, mode, horizon, floor, max_tie, agreement, min_edge, payout, confidence, require):
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
            },
        )

    def part(self, name, plan):
        return self.block("x_price_decision_part", fields={"PART": name}, values={"PLAN": plan})

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
        ("ai loss streak stop", "3"),
        ("ai loss streak", "0"),
        ("ai skip count", "0"),
        ("ai contracts", "0"),
        # Session profit measured from the equity the bot started with: the
        # engine reports realised profit for the whole run, so a bot that is
        # restarted mid-run would otherwise see someone else's losses as its own.
        ("baseline profit", "0"),
    ]
    init = []
    for name, value in defaults:
        if name == "stake":
            init.append(e.set_("stake", e.get("base stake")))
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
            ),
        )
    )
    init.append(e.set_("ai ready", e.part("ready", e.get(plan))))
    init.append(e.set_("ai side", e.part("side", e.get(plan))))
    init.append(e.notify("info", e.text(spec["armed"])))

    # ---- tick analysis: decide, then size the stake the buy will use ------
    tick = [
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
    streak_ok = e.logic(
        "OR",
        e.compare("LT", e.get("ai loss streak"), e.get("ai loss streak stop")),
        e.compare("GTE", e.part("confidence", e.get(plan)), e.arith("ADD", e.get("ai min confidence"), e.num("5"))),
    )
    entry_gate = e.logic(
        "AND",
        e.compare("EQ", e.get("ai ready"), e.num("1")),
        e.logic(
            "AND",
            streak_ok,
            e.risk(e.get("stake"), legs(), e.get("ai stake percent")),
        ),
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
        e.if_(
            brakes,
            [e.block("trade_again")],
            [e.notify("warn", e.text(spec["stopped"]))],
        ),
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
# the three presets
# ==========================================================================
RISE_FALL = {
    "mode": "rise",
    "market": "volidx",
    "submarket": "step_index",
    "symbol": "stpRNG",
    "tradetype_cat": "callput",
    "tradetype": "callput",
    "ids": {"tick": "rfTick01", "before": "rfBefore01", "after": "rfAfter01"},
    "armed": (
        "Rise/Fall AI armed — Step Index 100, five ticks. Eight price experts mixed by measured "
        "skill; an entry needs a positive edge over the payout break-even, side agreement, "
        "confidence and the risk gate. Skips explain themselves; every fifth entry prints the "
        "realised hit rate."
    ),
    "held": (
        "AI is ready but the entry gate held it — the confidence floor, a losing-streak "
        "cool-off, the balance percentage, the loss limit or the profit target blocked this entry."
    ),
    "stopped": (
        "AI session stop — the loss limit, the profit target or the balance rule was reached. "
        "Open contracts still settle; restart the bot to begin a new session."
    ),
    "comment": """
Rise/Fall AI ensemble — Step Index 100, five ticks.

Eight price experts (anchor, frequency, Markov transition, recent, kernel analog, drift,
serial dependence, online softmax net) are scored walk-forward with a Brier loss and mixed
by measured skill, then shrunk toward the market base rate by their effective sample size.
The entry is value-gated: the blended probability must clear the break-even implied by the
payout Deriv actually quotes (1/(1+payout)) by "ai min edge", and the traded side must carry
"ai min agreement" of the model weight. An absolute probability floor of 0.56 could never be
reached on Step Index — that is why this bot used to sit idle — so the gate is the edge, and
the floor stays available at 0 for anyone who wants it.

An even horizon on a fixed-step market ties about a third of windows and every tie loses, so
the horizon is the odd five-tick contract and a measured tie rate above "ai max tie" refuses
the shape instead of hiding it.

The decision is taken in Tick analysis, so the stake it sizes is applied by Trade options
before Deriv prices the proposals. Risk: tenth-Kelly on the measured edge, floored at the
exchange minimum, capped by "ai max stake" and the balance percent, and reduced while the
session is losing. Session brakes: loss limit, profit target, drawdown and a losing-streak
cool-off. Every fifth entry the journal prints the realised hit rate of the decisions this
bot actually published.

The last gate is evidence, not another opinion. Every published decision is graded against
the tick that settled it, and once twenty-five of them have a record the bot stops entering
while that record sits below the payout break-even. A model whose estimates run hot is a
losing bot with good explanations; this is the gate that notices. Grading continues while
entries are paused, so the bot resumes on its own when the record recovers.

Estimates are historical and conditional, not calibrated odds. Step Index is close to a fair
random walk: expect the bot to decline a good share of ticks rather than force trades. Test
on demo first.
""",
}

STEP_HEDGE = {
    "mode": "step-hedge",
    "market": "volidx",
    "submarket": "step_index",
    "symbol": "stpRNG",
    "tradetype_cat": "callput",
    "tradetype": "callput",
    "hedge_ratio": "0.25",
    "legs": "1.25",
    "max_stake": "2",
    # Four ticks, as this preset is meant to trade. A four-tick contract on a
    # fixed-step index returns to its entry price 6 times in 16 (37.5 %), and a
    # tie loses: that is the cost of this horizon, so it is measured, printed
    # on every entry line and allowed by "ai max tie" instead of being papered
    # over with a shape the operator did not ask for.
    "duration": "4",
    # The true tie rate of a four-tick step window is 37.5 %; the knob sits
    # above it so sampling noise in a short history cannot make the bot skip a
    # cycle it is meant to trade. Set it back to 0.2 to refuse this shape.
    "max_tie": "0.5",
    # Keep the cadence. The ensemble still names the side and the Kelly stake
    # still sizes the position, but a fair market is a reason to trade small,
    # not a reason to stop: this preset re-enters after every settlement.
    "require": "always",
    "min_edge": "0",
    "agreement": "0",
    "confidence": "0",
    "ids": {"tick": "shTick01", "before": "shBefore01", "after": "shAfter01"},
    "armed": (
        "Step Index AI hedge armed — Step Index 100, four ticks. The ensemble names the side on "
        "every readable tick and the Kelly stake sizes it; when the stake is large enough the "
        "opposite leg is bought at \"ai hedge ratio\" of it, so the pair keeps most of a measured "
        "edge while it caps the swing. Every entry is risk-checked at the pair's combined "
        "exposure before either order is sent."
    ),
    "held": (
        "AI is ready but the entry gate held it — the pair's combined exposure against the "
        "balance percentage, the loss limit or the profit target blocked this cycle."
    ),
    "stopped": (
        "AI session stop — the loss limit, the profit target or the balance rule was reached. "
        "Open contracts still settle; restart the bot to begin a new session."
    ),
    "comment": """
Step Index AI hedge — Step Index 100, four ticks, both legs priced from the same decision.

This preset is built to keep trading. It re-enters on the tick after every settlement, and
the ensemble names the side on every tick it can read rather than waiting for a fair market
to become favourable — the pause after a closed contract is one tick (about two seconds on
Step Index), not the ten-second gate-and-wait cycle this bot used to sit in.

What that costs, stated plainly. A four-tick contract on a fixed-step index returns to its
entry price 6 times in 16 windows — 37.5 % — and a returning window is a tie, which loses
both Rise and Fall. So the horizon itself caps the achievable win rate well under the
51.3 % break-even a 0.95 payout needs; no amount of modelling fixes a shape that cannot
settle a winner. The tie rate is measured on every call, printed on every entry line
("tie 37.5 %"), and bounded by "ai max tie" — set that knob to 0.2 and the bot will refuse
four ticks on this market and say so, which is the setting to use if you would rather have
accuracy than cadence. Five ticks (odd) removes the tie entirely.

What each part does:

  1. The decision is "on the best read available": the ensemble's measured probability picks
     the side, and the Kelly stake sizes the position. A thin read is traded *small* — at the
     exchange minimum — instead of not at all. Set the decision block's entry field to "only
     with a measured edge" to restore the old behaviour, where a read under the payout
     break-even was skipped.
  2. The hedge is partial: "ai hedge ratio" sizes the opposite leg as a fraction of the main
     stake. At the 0.35 exchange minimum the second leg would round below Deriv's own minimum,
     so the preset buys the model's side alone and says so in the journal; the pair appears
     once the stake is large enough to carry it. Two equal legs are never bought, because that
     locks in a loss of the spread every cycle.
  3. The risk gate checks the *pair's* combined exposure (main stake x (1 + ratio)) against the
     balance percent, the loss limit and the remaining budget before either order is sent, and
     After purchase waits for both legs to settle before the next cycle.

Session brakes still stop the bot: the loss limit, the profit target and the balance rule are
entry checks, not guarantees, and open contracts can settle beyond them. Estimates are
historical and conditional, not calibrated odds. Test on demo first.
""",
}

TICK_SNIPER = {
    "mode": "tick",
    "market": "volidx",
    "submarket": "random_index",
    "symbol": "R_100",
    "tradetype_cat": "highlowticks",
    "tradetype": "highlowticks",
    "floor": "0",
    "min_edge": "0.005",
    "max_tie": "0.35",
    "agreement": "0.5",
    "confidence": "50",
    "payout": "3.5",
    "max_stake": "1",
    "ids": {"tick": "hlTick01", "before": "hlBefore01", "after": "hlAfter01"},
    "armed": (
        "High/Low Tick AI armed — R_100, five-tick contract. Eight experts and the arcsine "
        "structure of a random walk vote on which tick prints the strict high or low; the entry "
        "must clear the payout break-even, the model agreement, the confidence floor, the rule's "
        "own graded record and the risk gate, and the buy sends the chosen prediction tick."
    ),
    "held": (
        "AI is ready but the entry gate held it — the confidence floor, a losing-streak "
        "cool-off, the balance percentage, the loss limit or the profit target blocked this entry."
    ),
    "stopped": (
        "AI session stop — the loss limit, the profit target or the balance rule was reached. "
        "Open contracts still settle; restart the bot to begin a new session."
    ),
    "comment": """
High/Low Tick AI — R_100, the five-tick contract Deriv sells for this trade type.

The question is narrow and exact: of the next five quotes, which position holds a strict high
or a strict low? Ten outcomes (tick 1-5 high, tick 1-5 low); a window whose extreme is shared
is discarded rather than guessed. Eight experts answer it — structural anchor, long-run
outcome histogram, the two-change Markov row, the last 250 windows, a kernel replay of similar
states, a drift forecast, a serial-dependence fit and an online softmax net — each scored
walk-forward with a Brier loss so an expert that cannot read this market loses its vote on its
own. The blend is shrunk toward the anchor by its effective sample size.

The anchor is the interesting part, and it is why this bot trades at all. For a symmetric
random walk the position of the running maximum follows the discrete arcsine law: over five
ticks, tick 1 and tick 5 are the likeliest (27 % each) and the middle tick the least likely
(14 %). The previous preset gated on an absolute 26 % probability while the blended estimate
was normalised over ten joint outcomes — half the scale the market actually prices — so the
gate could never open and the bot never bought anything. Two fixes: each side is normalised
over its own five positions, exactly as the contract is priced, and the anchor carries the
arcsine structure instead of a flat one-in-five guess.

Agreement is measured on the *side* (high vs low), not on the exact tick index: requiring
seven models to name the same one of five ticks scored a strong consensus as disagreement.
The payout is read from the live TICKHIGH/TICKLOW proposals, so the edge gate compares the
estimate with what the contract actually pays; 3.5 is only the fallback before the first
quotes arrive.

The buy sends the chosen prediction tick directly, the stake is tenth-Kelly on the measured
probability (floored at the exchange minimum, capped by "ai max stake" and the balance
percent), and the session brakes are the loss limit, the profit target, the drawdown and a
losing-streak cool-off. Every fifth entry the journal prints the realised hit rate — and once
twenty-five published decisions have been graded, a hit rate below the break-even stops the
entries until the record recovers. That gate matters more here than anywhere else: if Deriv
already prices the arcsine structure into its tick payouts, the record will say so and the
bot will stand down instead of paying for a discovery it did not make.

These are historical, conditional estimates, not calibrated odds. A strict extreme can still
fail on execution delay or an overlapping window. Test on demo first.
""",
}

if __name__ == "__main__":
    outputs = {
        "rise": (RISE_FALL, sys.argv[1]),
        "hedge": (STEP_HEDGE, sys.argv[2]),
        "tick": (TICK_SNIPER, sys.argv[3]),
    }
    for _, (spec, path) in outputs.items():
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(build(spec))
        print("wrote", path)
