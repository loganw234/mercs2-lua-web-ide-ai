#!/usr/bin/env python3
"""bench_chart.py -- render bench-tools-results.json as charts in AI-FORK.md.

Bar charts are drawn with block characters rather than as images on purpose:
this is a record-keeping section in a markdown file, so it wants to diff
cleanly, render in any editor, and never go stale against a binary asset
nobody remembers to regenerate.

Rewrites everything between the BENCH-CHARTS markers in AI-FORK.md, so re-run
it after any benchmark and the section updates in place.

  python tools/bench_chart.py            # update AI-FORK.md
  python tools/bench_chart.py --print    # just print, change nothing
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "bench-tools-results.json"
DOC = ROOT / "AI-FORK.md"
START = "<!-- BENCH-CHARTS:start -->"
END = "<!-- BENCH-CHARTS:end -->"

BLOCKS = "▏▎▍▌▋▊▉█"


def bar(value, maximum, width=28):
    """Sub-character resolution, so a 1/7 and a 2/7 do not look identical."""
    if maximum <= 0:
        return ""
    filled = (value / maximum) * width
    full = int(filled)
    rem = filled - full
    out = "█" * full
    if rem > 0.05 and full < width:
        out += BLOCKS[min(int(rem * len(BLOCKS)), len(BLOCKS) - 1)]
    return out or "▏"


def main():
    if not RESULTS.exists():
        print(f"[FAIL] no results at {RESULTS} -- run bench_tools.py first")
        return 1
    data = json.loads(RESULTS.read_text(encoding="utf-8"))
    if not data:
        print("[FAIL] results file is empty")
        return 1

    rows = []
    for model, cases in data.items():
        if not cases:
            continue
        total = len(cases)

        def count(v):
            return sum(1 for c in cases if c.get("verdict") == v)

        secs = sorted(c.get("secs", 0) for c in cases)
        row = {"model": model, "total": total, "pass": count("pass"),
               "median": secs[len(secs) // 2] if secs else 0}
        for c in cases:
            v = c.get("verdict")
            if v and v != "pass":
                row[v] = row.get(v, 0) + 1
        rows.append(row)

    rows.sort(key=lambda r: (-(r["pass"] / r["total"]), r["median"]))
    wm = max(len(r["model"]) for r in rows)
    slowest = max(r["median"] for r in rows) or 1

    out = [START, ""]
    out.append("### Tool-use pass rate")
    out.append("")
    ncases = max((r["total"] for r in rows), default=0)
    out.append("%d cases with machine-checked criteria. Higher is better. "
               "`unsupported` = the endpoint errored (rate limit / HTTP 5xx), "
               "not a model failure — those rows are not real scores."
               % ncases)
    out.append("")
    out.append("```")
    for r in rows:
        pct = 100 * r["pass"] / r["total"]
        out.append(f"{r['model']:<{wm}}  {bar(r['pass'], r['total']):<29} "
                   f"{r['pass']}/{r['total']}  {pct:3.0f}%")
    out.append("```")
    out.append("")

    out.append("### How they fail")
    out.append("")
    out.append("`ignored` is the worst column, not `no_call`: a model that skips the tool "
               "is merely no better than one without tools, while a model that calls it "
               "and then contradicts the result produces a transcript that *looks* "
               "researched. `bad_call` means malformed arguments, which kills the loop.")
    out.append("")
    # Columns are derived from the data, not hardcoded. A fixed list silently
    # hid the DeepSeek models' real failure mode: they scored 5/7 while showing
    # all-zero, because both losses were `loop` and there was no loop column.
    # A chart that can't show a failure is worse than no chart.
    kinds = []
    for model, cases in data.items():
        for c in cases:
            v = c.get("verdict")
            if v and v != "pass" and v not in kinds:
                kinds.append(v)
    kinds.sort()
    out.append("| model | " + " | ".join(f"`{k}`" for k in kinds) + " |")
    out.append("|---|" + "---|" * len(kinds))
    for r in rows:
        def cell(n):
            return "·" if n == 0 else f"{'▇' * min(n, 7)} {n}"
        cells = " | ".join(cell(r.get(k, 0)) for k in kinds)
        out.append(f"| `{r['model']}` | {cells} |")
    out.append("")

    out.append("### Median latency per case")
    out.append("")
    out.append("Wall clock for one full case including any tool round trips. Shorter is "
               "better, but note the fastest models here are fast because they skip the "
               "tool call entirely.")
    out.append("")
    out.append("```")
    for r in sorted(rows, key=lambda r: r["median"]):
        out.append(f"{r['model']:<{wm}}  {bar(r['median'], slowest):<29} {r['median']:>6.1f}s")
    out.append("```")
    out.append("")
    out.append(END)

    text = "\n".join(out)
    if "--print" in sys.argv:
        print(text)
        return 0

    doc = DOC.read_text(encoding="utf-8")
    if START in doc and END in doc:
        pre = doc[:doc.index(START)]
        post = doc[doc.index(END) + len(END):]
        DOC.write_text(pre + text + post, encoding="utf-8")
        print(f"[ok] updated charts in {DOC.name} ({len(rows)} models)")
    else:
        print(f"[FAIL] markers not found in {DOC.name}; add:\n{START}\n{END}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
