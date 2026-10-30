#!/usr/bin/env python3
"""Regenerate the three editable price-strategy DBot presets.

    python3 scripts/generate-price-bots.py

This entry point is kept because it is the name people (and old notes) reach
for, but it no longer carries a hand-built copy of the three strategies. A
second writer is how the presets drifted apart in the first place: this file
was still emitting the v4 gate chain (no EV floor, no entry slip, no market
DNA, no self-audit) months after the engine had moved on, so running it would
silently overwrite the shipped v5 bot with a weaker one.

`scripts/presets/gen_presets.py` is the single source of truth. It declares the
variables, gates, guards and journal lines once and emits all three bots, so
the three can never disagree about what they are allowed to buy. This script is
now a thin alias that writes the same three files, in the same order, at the
same paths.

The presets are ordinary DBot strategies — importable, editable, inspectable —
not opaque binaries. Every decision they make comes from blocks that are also
in the Vision Lab -> Price strategies toolbox:

  x_price_decision        the sixteen-expert price ensemble (the brain), now with
                          the ten-outcome EV floor and the entry-slip charge
  x_price_decision_part   reads it: ready, side, tick, probability, tie rate,
                          edge, confidence, agreement, samples, horizon,
                          separation, stderr, record, evidence, quote,
                          fair-quote, ev-margin, tie-forecast, dna-score,
                          skill, stand-down, certainty
  x_price_reason          the journal line: the contract, or why it waited
  x_price_risk            the stake/legs/limits gate
  x_price_stake           fractional-Kelly sizing that follows the edge
  x_price_dna             the market's measured structure (High/Low Tick only)
  x_price_payout_table    the quoted payout ladder it prices against
  x_price_league          which expert is currently earning its weight
  x_price_audit           the bot's own record versus break-even
  x_price_brain           the deep net's training state and the regime call
  x_price_reverse         the DNA v2 auto-reverse-engineering diagnosis
  x_price_forecast        the full ten-outcome read in one line
  x_market_scan           the AI multi-market scan: read every shared market
                          with this bot's own model, all at the same moment
  x_scan_switch_best      stand on the most suitable market from that scan
  x_trade_due             the once-a-minute cadence clock

Run `scripts/presets/validate_presets.py src/lib/bot-store/bots/*.xml`
afterwards, then the preset tests.
"""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRESETS_DIR = ROOT / "scripts" / "presets"
BOTS = ROOT / "src" / "lib" / "bot-store" / "bots"

DEFAULT_TARGETS = [
    ("rise", BOTS / "rise-fall-ensemble.xml"),
    ("hedge", BOTS / "step-rise-fall-hedge.xml"),
    ("tick", BOTS / "high-low-tick-sniper.xml"),
]


def load_writer():
    """Import gen_presets.py by path (its directory is not a package)."""
    path = PRESETS_DIR / "gen_presets.py"
    spec = importlib.util.spec_from_file_location("gen_presets", path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_presets"] = module
    spec.loader.exec_module(module)
    return module


def main(argv):
    writer = load_writer()
    specs = {"rise": writer.RISE_FALL, "hedge": writer.STEP_HEDGE, "tick": writer.TICK_SNIPER}

    if len(argv) in (3, 4):
        # Legacy call shape: <rise.xml> [<hedge.xml>] <tick.xml>
        targets = [("rise", Path(argv[1]))]
        if len(argv) == 4:
            targets.append(("hedge", Path(argv[2])))
            targets.append(("tick", Path(argv[3])))
        else:
            targets.append(("tick", Path(argv[2])))
    elif len(argv) == 1:
        targets = DEFAULT_TARGETS
    else:
        raise SystemExit(__doc__)

    for kind, path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        xml = writer.build(specs[kind])
        path.write_text(xml, encoding="utf-8")
        print("wrote", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
