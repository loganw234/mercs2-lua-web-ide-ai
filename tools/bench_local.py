#!/usr/bin/env python3
"""bench_local.py -- score local models against the bundled reference pack.

Purpose: tell a local-hosting user which model size is actually worth running.
"Bigger is better" is not useful advice when the difference between 7B and 14B
might be one graded answer, and when a 27B on system RAM costs minutes per turn.

Each case has MACHINE-CHECKABLE criteria, because grading generated prose by
eye across N models is how you fool yourself. `must` patterns have to appear,
`must_not` patterns must not -- and `must_not` is weighted harder, since a
confidently invented identifier is the failure mode that actually costs a user
a debugging session.

Usage:
    python tools/bench_local.py                       # every installed model
    python tools/bench_local.py qwen2.5-coder:7b ...  # named models
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OLLAMA = "http://localhost:11434"
_DATA = Path(__file__).resolve().parent.parent / "src" / "data"
_packfile = "pack.txt"
for _a in sys.argv[1:]:
    if _a.startswith("--pack="):
        _packfile = _a.split("=", 1)[1]
PACK = (_DATA / _packfile).read_text(encoding="utf-8")

# (name, prompt, must[], must_not[])
CASES = [
    ("pmc-template",
     "How do I spawn a PMC soldier that fights alongside me? "
     "Give the exact Pg.Spawn template string.",
     [r"(VZ|Allied|Guerilla|Chinese|OC) Soldier|Pirate Thug"],
     [r"Pg\.Spawn\(\s*[\"']PMC"]),

    ("debug-output",
     "My debug prints never show up anywhere. What function should I use?",
     [r"Loader\.Printf"],
     [r"use\s+Debug\.Printf|recommend\s+Debug\.Printf"]),

    ("import-rule",
     "Write a snippet that gets the player's position and spawns a crate there.",
     [r"Player\.GetLocalCharacter|Object\.GetPosition"],
     [r"import\(\s*[\"']\s*(Pg|Object|Player|Ai|Vehicle|Event|Ess)"]),

    ("timer-rearm",
     "How do I make a function run every half second?",
     [r"TimerRelative", r"re-?arm|again|reschedul|first line|calls? itself"],
     []),

    ("lua51",
     "Can I write `count += 1` and use a bitwise AND in my script?",
     [r"5\.1|no.{0,20}(compound|\+=)|not available|does ?n[o']t (exist|support)"],
     [r"[Yy]es,? you can (use|write) `?\+="]),

    ("getter-truthiness",
     "Why does `if not widget:GetVisible() then` never toggle my HUD?",
     [r"1\s*/\s*0|returns? (1|0)|only nil|nil.{0,12}false.{0,12}fals"],
     []),

    ("invented-setter",
     "Is there a call to set an object's faction at runtime?",
     [r"no|not documented|does ?n[o']t exist"],
     [r"Ai\.SetFactionGuid\(|use `?Ai\.SetFaction"]),

    # --- harder cases -------------------------------------------------------
    # 7B and 14B both scored 7/7 on the set above, so it stopped discriminating.
    # These probe the subtle rules that actually caused production wrong answers.

    ("role-not-goal",
     "Using raw Ai calls only, no Ess: make an NPC follow the player.",
     [r"Ai\.Role"],
     [r"Ai\.Goal\s*[({][^)}]*Goal\s*=\s*[\"']Follow"]),

    ("goal-location-key",
     "Using raw Ai.Goal, send an NPC to the coordinates 100, 5, -200. "
     "Show the exact table.",
     [r"Location\s*="],
     [r"Position\s*=\s*[{\[]|Coords?\s*=\s*[{\[]"]),

    # The small pack OMITS the Ess API section, so the correct answer here is
    # either the real dispatch shape (if the tier includes it) or an explicit
    # "I don't have that reference". Inventing a plausible AIOrders method is
    # the only real failure -- which is precisely what the tier banner exists to
    # prevent, so this case measures the banner.
    ("aiorders-shape",
     "With Ess, order two soldiers to patrol a route. Show the exact call.",
     [r"Ess\.AIOrders\.command\(\s*\{|do ?n[o']t (have|know)|cannot confirm|"
      r"not in (this|the) (pack|reference)|check.{0,30}wiki\.mercs2|would need"],
     [r"AIOrders\.(action|patrol|move|disembark|enterVehicle)\s*\(",
      r"Ess\.AIOrders\.command\(\s*u?\w+\s*,"]),

    ("onkey-skeleton",
     "Write a complete OnKey script that toggles player invincibility, "
     "safe to press repeatedly.",
     [r"KEYVAL", r"_G\.", r"pcall|Loader\.Printf"],
     [r"import\(\s*[\"']\s*(Object|Player|Pg)"]),

    ("refuse-unknown-ess",
     "What arguments does Ess.Probe.nearby take? Give the exact signature.",
     [r"do ?n[o']t (have|know)|not in|cannot confirm|check|wiki\.mercs2|would need"],
     [r"Ess\.Probe\.nearby\s*\([a-zA-Z]"]),
]


def ask(model, prompt, timeout=900):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": PACK},
                     {"role": "user", "content": prompt}],
        "stream": False,
        "max_tokens": 700,
    }).encode("utf-8")
    req = urllib.request.Request(OLLAMA + "/v1/chat/completions", data=body,
                                 headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        txt = data["choices"][0]["message"]["content"]
        return txt, time.time() - t0, None
    except Exception as e:                                  # noqa: BLE001
        return "", time.time() - t0, str(e)[:120]


def installed():
    with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=15) as r:
        tags = json.loads(r.read().decode("utf-8"))
    skip = ("all-minilm", "nomic-embed", "bge-")
    return [m["name"] for m in tags.get("models", [])
            if not m["name"].startswith(skip)]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    trials = 1
    for a in sys.argv[1:]:
        if a.startswith("--trials="):
            trials = int(a.split("=", 1)[1])
    models = args or installed()
    print("pack: %d chars (~%d tokens)" % (len(PACK), len(PACK) // 4))
    print("models: %s" % ", ".join(models))
    print("trials: %d  (single runs are noisy at these sizes -- a model can\n"
          "         invent an identifier on one sample and not the next)\n" % trials)

    results = {}
    for m in models:
        print("=== %s" % m)
        row = {"pass": 0, "fail": 0, "invented": 0, "secs": [],
               "trials": trials, "per_case": {}}
        for name, prompt, must, must_not in CASES:
            verdicts = []
            for _ in range(trials):
                txt, secs, err = ask(m, prompt)
                row["secs"].append(secs)
                if err:
                    verdicts.append("ERROR")
                    continue
                bad = [p for p in must_not if re.search(p, txt, re.I)]
                miss = [p for p in must if not re.search(p, txt, re.I)]
                verdicts.append("INVENTED" if bad else ("miss" if miss else "ok"))
            ok = verdicts.count("ok")
            inv = verdicts.count("INVENTED")
            row["pass"] += ok
            row["fail"] += trials - ok
            row["invented"] += inv
            row["per_case"][name] = verdicts
            flag = "INVENTED" if inv else ("ok" if ok == trials else "mixed" if ok else "miss")
            print("  %-18s %-9s %d/%d ok%s"
                  % (name, flag, ok, trials, ("  (%d invented)" % inv) if inv else ""))
        results[m] = row
        print()

    total_cases = len(CASES) * trials
    print("=" * 78)
    print("%-24s %9s %10s %9s %8s" % ("model", "pass", "invented", "median", "total"))
    print("=" * 78)
    for m, r in sorted(results.items(), key=lambda kv: (kv[1]["invented"], -kv[1]["pass"])):
        s = sorted(r["secs"])
        med = s[len(s) // 2] if s else 0
        print("%-24s %4d/%-4d %10d %7.1fs %7.1fs"
              % (m, r["pass"], total_cases, r["invented"], med, sum(r["secs"])))
    print()
    print("Sorted by INVENTED first, then pass count. A model that invents an")
    print("identifier costs a debugging session; one that misses a detail costs")
    print("a follow-up question. Those are not the same kind of wrong.")

    out = Path(__file__).resolve().parent.parent / "bench-results.json"
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print("\nwrote %s" % out.name)


if __name__ == "__main__":
    main()
