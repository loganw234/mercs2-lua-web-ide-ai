#!/usr/bin/env python3
"""bench_median.py -- read repeated bench_reason runs and report the DISTRIBUTION.

A single trial at these model sizes is noisy: the same model can score 9/10 then
7/10 on identical inputs (different sampling seed). Running N trials and reading the
median -- not one lucky draw -- is what turns "looks like 9/10" into a number you can
stand behind. This reports, per (model, budget):

  * per-trial pass counts, e.g. [9,8,9,7,9,8]  -> you can see the spread at a glance
  * median & mean of those pass counts, and mean cell score
  * "solid" passes: tasks that pass in a MAJORITY of trials (the reliable core)
  * inventions per run (grounding discipline, averaged over trials)

  python tools/bench_median.py                         # all models/budgets present
  python tools/bench_median.py --models qwen3:14b,qwen3:8b --budgets B1,B2
  python tools/bench_median.py --tasks                 # add per-task reliability
"""
import argparse
import json
import statistics as st
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT / "bench-reason-results.json"

SHORT = {
    "hf.co/unsloth/Qwen3-14B-128K-GGUF:UD-Q4_K_XL": "qwen3:14b-128K(YaRN)",
    "myaniu/qwen2.5-1m:14b-instruct-q6_K_M": "qwen2.5-1M:14b",
}


def load(path):
    """Read the results, tolerating a concurrent writer (retry once on a torn read)."""
    for _ in range(2):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8")).get("cells", {})
        except Exception:  # noqa: BLE001
            continue
    return {}


def analyse(cells):
    # (model,budget) -> task -> {trial: (verdict, score, n_invented)}
    tree = defaultdict(lambda: defaultdict(dict))
    for k, v in cells.items():
        model, bud, task, tr = k.rsplit("|", 3)
        g = v.get("grade", {})
        if g.get("verdict") in ("ERROR", "TRUNCATED"):
            continue
        tree[(model, bud)][task][int(tr)] = (
            g.get("verdict"), g.get("score", 0), len(g.get("invented", [])))
    return tree


def report(tree, models, budgets, show_tasks):
    keys = sorted(tree, key=lambda mb: (models.index(mb[0]) if mb[0] in models else 99, mb[1]))
    hdr = "%-22s %-3s %-5s %-21s %5s %5s %6s %7s" % (
        "model", "bud", "cmp/t", "per-trial pass (p or p/n)", "med", "solid", "meanS", "inv/run")
    print(hdr)
    print("-" * len(hdr))
    for (model, bud) in keys:
        if models and model not in models:
            continue
        if budgets and bud not in budgets:
            continue
        tasks = tree[(model, bud)]
        trials = sorted({tr for t in tasks.values() for tr in t})
        ntrials = len(trials)
        ntask = len(tasks)
        # per trial: (passes, tasks-present). The runner fills task-by-task, so mid-run
        # only early tasks have later trials -- a trial with n<ntask is INCOMPLETE and
        # must not be read as a low score. The median is taken over complete trials only.
        per_trial, per_trial_scores, per_trial_inv = [], [], []
        for tr in trials:
            present = [t for t in tasks.values() if tr in t]
            passes = sum(1 for t in present if t[tr][0] == "pass")
            per_trial.append((passes, len(present)))
            per_trial_scores += [t[tr][1] for t in present]
            per_trial_inv.append(sum(t[tr][2] for t in present))
        # solid = task passes in a strict majority of the trials it ran
        solid = sum(1 for t in tasks.values()
                    if (g := [t[tr][0] == "pass" for tr in trials if tr in t])
                    and sum(g) > len(g) / 2)
        complete = [p for (p, n) in per_trial if n == ntask]
        med = st.median(complete) if complete else 0
        meanS = sum(per_trial_scores) / len(per_trial_scores) if per_trial_scores else 0
        inv_run = sum(per_trial_inv) / len(per_trial_inv) if per_trial_inv else 0
        # incomplete trials shown as passes/present so they can't masquerade as a crash
        pt = "[" + ",".join((str(p) if n == ntask else "%d/%d" % (p, n))
                            for (p, n) in per_trial) + "]"
        ncomp = len(complete)
        med_s = ("%5.1f" % med) if complete else "  -- "
        print("%-22s %-3s %d/%-3d %-21s %s %4d/%d %6.2f %6.1f" % (
            SHORT.get(model, model), bud, ncomp, ntrials, pt, med_s, solid, ntask, meanS, inv_run))

    if show_tasks:
        print("\nper-task reliability (passes / trials):")
        for (model, bud) in keys:
            if (models and model not in models) or (budgets and bud not in budgets):
                continue
            tasks = tree[(model, bud)]
            trials = sorted({tr for t in tasks.values() for tr in t})
            print("  %s %s:" % (SHORT.get(model, model), bud))
            for task in sorted(tasks):
                got = [tasks[task][tr][0] == "pass" for tr in trials if tr in tasks[task]]
                flag = "" if (got and all(got)) else ("  <-- flaky" if any(got) else "  <-- never")
                print("    %-16s %d/%d%s" % (task, sum(got), len(got), flag))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(DEFAULT))
    ap.add_argument("--models", default="")
    ap.add_argument("--budgets", default="")
    ap.add_argument("--tasks", action="store_true", help="add per-task reliability breakdown")
    a = ap.parse_args()
    models = [m.strip() for m in a.models.split(",") if m.strip()]
    budgets = [b.strip() for b in a.budgets.split(",") if b.strip()]
    report(analyse(load(a.file)), models, budgets, a.tasks)


if __name__ == "__main__":
    main()
