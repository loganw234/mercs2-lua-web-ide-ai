#!/usr/bin/env python3
"""bench_viz.py -- render the Qwen-family sweep as a self-contained HTML dashboard.

Reads the two result files (reasoning + tool-use) and emits ONE offline HTML page:
static inline SVG charts (no external libs, so it works as a locked-down Artifact)
plus the full numbers in tables. Coloured by model GENERATION, because the headline
finding is that the 2.5->3 jump matters more than parameter count.

  python tools/bench_viz.py                       # default in/out paths
  python tools/bench_viz.py --reason X --tools Y --out Z
"""
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# category -> colour (chosen to read on both light and dark backgrounds). "DS" is the
# hosted DeepSeek flagship, "CLOUD" the Ollama-cloud semi-frontier models -- both kept
# visually distinct from the local Qwen generations.
GEN_COLOR = {"DS": "#c65fb5", "CLOUD": "#12a5b8", "3.6": "#5b8def", "3": "#3aa675",
             "2.5": "#e0a030", "?": "#9aa0a6"}
GEN_ORDER = {"DS": 0, "CLOUD": 1, "3.6": 2, "3": 3, "2.5": 4, "?": 5}
GEN_LABEL = {"DS": "DeepSeek (flagship)", "CLOUD": "Cloud (semi-frontier)",
             "3.6": "Qwen 3.6", "3": "Qwen 3", "2.5": "Qwen 2.5"}


def gen_of(model):
    m = model.lower()
    if "cloud" in m:                  # Ollama-cloud (glm/kimi/minimax/qwen3.5:397b) -- must
        return "CLOUD"                # come before the qwen3 check (qwen3.5:397b-cloud)
    if "deepseek" in m:
        return "DS"
    if "qwen3.6" in m:
        return "3.6"
    if "qwen3" in m:
        return "3"
    if "qwen2.5" in m:
        return "2.5"
    return "?"


def size_of(model):
    m = re.search(r"(\d+\.?\d*)\s*b\b", model.lower())
    return float(m.group(1)) if m else None


def display(model):
    """Human-friendly short label for a possibly-namespaced ollama tag."""
    special = {
        "myaniu/qwen2.5-1m:14b-instruct-q6_K_M": "qwen2.5-1M:14b",
        "hf.co/unsloth/Qwen3-14B-128K-GGUF:UD-Q4_K_XL": "qwen3:14b-128K (YaRN)",
        "deepseek-v4-pro": "DeepSeek V4-pro",
    }
    if model in special:
        return special[model]
    return model.split("/")[-1].replace(":cloud", "").replace("-cloud", "")


# ---------------------------------------------------------------------------
def load_reason(*paths):
    """Merge cells from one or more result files (main sweep + the DeepSeek shards) ->
    {model: {per_budget:{bud:{pass,n,mean,inv}}, pass,n,mean,inv, small_mean, small_inv}}.
    small_* is over the small pack (B1+B2) only -- the one budget EVERY model ran, so
    it's the fair common ground for a cross-model bar (the aggregate over all budgets
    isn't, since only DeepSeek climbed the whole ladder)."""
    cells = {}
    for path in paths:
        if path and Path(path).exists():
            cells.update(json.loads(Path(path).read_text(encoding="utf-8")).get("cells", {}))
    per = defaultdict(lambda: defaultdict(lambda: {"pass": 0, "n": 0, "inv": 0, "scores": []}))
    for k, v in cells.items():
        model, bud, _task, _tr = k.rsplit("|", 3)
        if gen_of(model) == "?":          # drop stale non-Qwen/non-DeepSeek rows
            continue
        g = v.get("grade", {})
        if g.get("verdict") in ("ERROR", "TRUNCATED"):
            continue
        row = per[model][bud]
        row["n"] += 1
        row["scores"].append(g.get("score", 0))
        row["inv"] += len(g.get("invented", []))
        if g.get("verdict") == "pass":
            row["pass"] += 1
    out = {}
    for model, buds in per.items():
        pb, tp, tn, ti, allscores, small_scores, small_inv, small_n = {}, 0, 0, 0, [], [], 0, 0
        for bud, r in buds.items():
            mean = sum(r["scores"]) / len(r["scores"]) if r["scores"] else 0
            pb[bud] = {"pass": r["pass"], "n": r["n"], "mean": mean, "inv": r["inv"]}
            tp += r["pass"]; tn += r["n"]; ti += r["inv"]; allscores += r["scores"]
            if bud in ("B1", "B2"):
                small_scores += r["scores"]; small_inv += r["inv"]; small_n += r["n"]
        out[model] = {"per_budget": pb, "pass": tp, "n": tn, "inv": ti,
                      "mean": (sum(allscores) / len(allscores) if allscores else 0),
                      "small_mean": (sum(small_scores) / len(small_scores) if small_scores else 0),
                      "small_inv": (small_inv / (small_n / 10) if small_n else 0)}  # per 10-task run
    return out


def load_tools(*paths):
    """-> {model: {"pass":,"n":, "verdicts": {verdict: count}}}. Merges files (main
    bench-tools + the DeepSeek tool-use shard)."""
    data = {}
    for path in paths:
        if path and Path(path).exists():
            data.update(json.loads(Path(path).read_text(encoding="utf-8")))
    out = {}
    for model, rows in data.items():
        if gen_of(model) == "?":          # keep Qwen + DeepSeek; drop stale llama/gemma rows
            continue
        vd = defaultdict(int)
        for r in rows:
            vd[r.get("verdict", "?")] += 1
        out[model] = {"pass": vd.get("pass", 0), "n": len(rows), "verdicts": dict(vd)}
    return out


# ---------------------------------------------------------------------------
# tiny inline-SVG horizontal bar chart
# ---------------------------------------------------------------------------
def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def hbar(title, subtitle, items, vmax, fmt, unit=""):
    """items: [(label, value, gen)] already in the order to draw (top -> bottom)."""
    rowh, top, left, right, w = 30, 58, 210, 70, 720
    h = top + rowh * len(items) + 18
    plot = w - left - right
    svg = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}" '
           f'style="width:100%;height:auto;min-width:588px;max-width:760px">']
    svg.append(f'<text x="0" y="22" class="ct">{esc(title)}</text>')
    if subtitle:
        svg.append(f'<text x="0" y="42" class="cs">{esc(subtitle)}</text>')
    # gridlines at 0/25/50/75/100 %
    for frac in (0, .25, .5, .75, 1):
        x = left + plot * frac
        svg.append(f'<line x1="{x:.0f}" y1="{top-6}" x2="{x:.0f}" y2="{h-14}" class="grid"/>')
        svg.append(f'<text x="{x:.0f}" y="{h-2}" class="ax" text-anchor="middle">'
                   f'{fmt(vmax*frac)}</text>')
    for i, (label, val, gen) in enumerate(items):
        y = top + i * rowh
        bw = plot * (val / vmax) if vmax else 0
        col = GEN_COLOR.get(gen, GEN_COLOR["?"])
        svg.append(f'<text x="{left-10}" y="{y+rowh/2+4:.0f}" class="lbl" '
                   f'text-anchor="end">{esc(label)}</text>')
        svg.append(f'<rect x="{left}" y="{y+5:.0f}" width="{max(bw,1):.1f}" height="{rowh-12}" '
                   f'rx="4" fill="{col}"/>')
        svg.append(f'<text x="{left+bw+8:.0f}" y="{y+rowh/2+4:.0f}" class="val">'
                   f'{fmt(val)}{unit}</text>')
    svg.append("</svg>")
    return "\n".join(svg)


def scatter(title, subtitle, points):
    """points: [(label, x_params, y_score, gen)]. x on log scale."""
    import math
    w, h, top, left, bot = 760, 380, 56, 56, 46
    pw, ph = w - left - 24, h - top - bot
    xs = [p[1] for p in points if p[1]]
    xmin, xmax = min(xs), max(xs)
    lxmin, lxmax = math.log10(xmin * 0.8), math.log10(xmax * 1.25)

    def px(v):
        return left + pw * (math.log10(v) - lxmin) / (lxmax - lxmin)

    def py(s):
        return top + ph * (1 - s)  # score 0..1
    svg = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}" '
           f'style="width:100%;height:auto;min-width:588px;max-width:760px">']
    svg.append(f'<text x="0" y="22" class="ct">{esc(title)}</text>')
    if subtitle:
        svg.append(f'<text x="0" y="42" class="cs">{esc(subtitle)}</text>')
    for s in (0, .25, .5, .75, 1):
        y = py(s)
        svg.append(f'<line x1="{left}" y1="{y:.0f}" x2="{w-24}" y2="{y:.0f}" class="grid"/>')
        svg.append(f'<text x="{left-8}" y="{y+4:.0f}" class="ax" text-anchor="end">{s:.2f}</text>')
    for gx in (1, 2, 4, 8, 16, 32):
        if xmin * 0.8 <= gx <= xmax * 1.25:
            x = px(gx)
            svg.append(f'<text x="{x:.0f}" y="{h-14}" class="ax" text-anchor="middle">{gx}B</text>')
    svg.append(f'<text x="{left+pw/2:.0f}" y="{h-1}" class="ax" text-anchor="middle">'
               f'parameters (log scale)</text>')
    for label, xv, yv, gen in points:
        if not xv:
            continue
        x, y = px(xv), py(yv)
        col = GEN_COLOR.get(gen, GEN_COLOR["?"])
        svg.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="7" fill="{col}" '
                   f'stroke="var(--bg)" stroke-width="1.5"/>')
        svg.append(f'<text x="{x:.0f}" y="{y-12:.0f}" class="pt" text-anchor="middle">'
                   f'{esc(label)}</text>')
    svg.append("</svg>")
    return "\n".join(svg)


def legend(cats=("3.6", "3", "2.5")):
    items = "".join(
        f'<span class="lg"><i style="background:{GEN_COLOR[g]}"></i>{GEN_LABEL[g]}</span>'
        for g in cats)
    return f'<div class="legend">{items}</div>'


# pack tiers in order, with the budgets that map to each and an approx token size for
# the x-axis label. B1 and B2 are the same (small) pack, so they collapse to one point.
TIER_LADDER = [("small", ["B1", "B2"], "11k"), ("small+", ["B3"], "46k"),
               ("ess", ["B4"], "71k"), ("medium", ["B5"], "99k"),
               ("large", ["B6"], "158k"), ("full", ["B7"], "240k")]


def tier_values(pb, metric):
    """pb = a model's per_budget dict. metric 'mean' or 'inv'. -> [y or None per tier]."""
    ys = []
    for _name, buds, _sz in TIER_LADDER:
        present = [pb[b] for b in buds if b in pb]
        n = sum(v["n"] for v in present)
        if not n:
            ys.append(None); continue
        if metric == "mean":
            ys.append(sum(v["mean"] * v["n"] for v in present) / n)
        else:  # inventions per 10-task run
            ys.append(sum(v["inv"] for v in present) / (n / 10))
    return ys


def linechart(title, subtitle, series, ymaxR=4.0):
    """Dual-axis line chart over the TIER_LADDER x-axis. series = list of
    (name, color, [y per tier], axis 'L'|'R', dashed bool). L axis = score 0..1,
    R axis = inventions 0..ymaxR."""
    w, h, top, left, right, bot = 760, 360, 60, 52, 54, 74
    pw, ph = w - left - right, h - top - bot
    n = len(TIER_LADDER)

    def px(i):
        return left + (pw * i / (n - 1) if n > 1 else pw / 2)

    def pyL(v):
        return top + ph * (1 - max(0, min(1, v)))

    def pyR(v):
        return top + ph * (1 - max(0, min(ymaxR, v)) / ymaxR)

    svg = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}" '
           f'style="width:100%;height:auto;min-width:588px;max-width:760px">']
    svg.append(f'<text x="0" y="22" class="ct">{esc(title)}</text>')
    if subtitle:
        svg.append(f'<text x="0" y="42" class="cs">{esc(subtitle)}</text>')
    for f in (0, .25, .5, .75, 1):
        y = pyL(f)
        svg.append(f'<line x1="{left}" y1="{y:.0f}" x2="{w-right}" y2="{y:.0f}" class="grid"/>')
        svg.append(f'<text x="{left-7}" y="{y+4:.0f}" class="ax" text-anchor="end">{f:.2f}</text>')
        svg.append(f'<text x="{w-right+7}" y="{y+4:.0f}" class="ax">{f*ymaxR:.0f}</text>')
    svg.append(f'<text x="{left-7}" y="{top-14}" class="ax" text-anchor="end">score</text>')
    svg.append(f'<text x="{w-right+7}" y="{top-14}" class="ax">inv/run</text>')
    for i, (name, buds, sz) in enumerate(TIER_LADDER):
        x = px(i)
        svg.append(f'<text x="{x:.0f}" y="{h-bot+16:.0f}" class="ax" text-anchor="middle">{name}</text>')
        svg.append(f'<text x="{x:.0f}" y="{h-bot+30:.0f}" class="pt" text-anchor="middle">{sz}</text>')
    for name, color, ys, axis, dashed in series:
        pts = [(px(i), (pyL(y) if axis == "L" else pyR(y))) for i, y in enumerate(ys) if y is not None]
        if not pts:
            continue
        d = " ".join(f"{x:.0f},{y:.0f}" for x, y in pts)
        dash = ' stroke-dasharray="5 4"' if dashed else ''
        svg.append(f'<polyline points="{d}" fill="none" stroke="{color}" stroke-width="2.5"{dash}/>')
        for x, y in pts:
            svg.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="3.5" fill="{color}"/>')
    # inline legend row
    lx = left
    for name, color, ys, axis, dashed in series:
        dash = ' stroke-dasharray="4 3"' if dashed else ''
        svg.append(f'<line x1="{lx}" y1="{h-6}" x2="{lx+16}" y2="{h-6}" stroke="{color}" '
                   f'stroke-width="2.5"{dash}/>')
        svg.append(f'<text x="{lx+21}" y="{h-2}" class="pt">{esc(name)}</text>')
        lx += 24 + len(name) * 6.0
    svg.append("</svg>")
    return "\n".join(svg)


# ---------------------------------------------------------------------------
def build(reason, tools, out_path):
    models = sorted(set(reason) | set(tools),
                    key=lambda m: (GEN_ORDER[gen_of(m)], -(size_of(m) or 0)))

    # Bars use the SMALL-pack (B1/B2) numbers -- the one budget every model ran, so it's
    # the fair cross-model comparison (only DeepSeek climbed the whole ladder). It's also
    # the most revealing: it measures grounding discipline when the reference is ABSENT.
    r_items = sorted(((display(m), reason[m]["small_mean"], gen_of(m)) for m in reason),
                     key=lambda t: -t[1])
    inv_items = sorted(((display(m), reason[m]["small_inv"], gen_of(m)) for m in reason),
                       key=lambda t: t[1])          # low is good -> ascending
    inv_max = max([reason[m]["small_inv"] for m in reason] + [1.0])

    charts = []
    if reason:
        charts.append(hbar("Reasoning — small pack (no namespace reference)",
                           "mean score when the model must rely on discipline, not the docs (higher is better)",
                           r_items, 1.0, lambda v: f"{v:.2f}"))
        charts.append(hbar("Fabrication — small pack",
                           "invented API names per run when the reference is absent (LOWER is better)",
                           inv_items, inv_max, lambda v: f"{v:.1f}"))
        # The headline: how much the reference matters. DeepSeek is the only model that
        # spans the full ladder; overlay the best local that climbed to the namespace pack.
        ds = next((m for m in reason if "deepseek" in m.lower()), None)
        cser = []
        if ds:
            cser.append(("DeepSeek score", GEN_COLOR["DS"], tier_values(reason[ds]["per_budget"], "mean"), "L", False))
            cser.append(("DeepSeek inv/run", "#d9534f", tier_values(reason[ds]["per_budget"], "inv"), "R", True))
        if "qwen3:30b-a3b" in reason:
            cser.append(("qwen3:30b-a3b score", GEN_COLOR["3"],
                         tier_values(reason["qwen3:30b-a3b"]["per_budget"], "mean"), "L", False))
        cloud = [m for m in reason if gen_of(m) == "CLOUD"]
        if cloud:  # add the most-complete cloud ladder as a semi-frontier reference
            bc = max(cloud, key=lambda m: reason[m]["n"])
            cser.append((display(bc) + " score", GEN_COLOR["CLOUD"],
                         tier_values(reason[bc]["per_budget"], "mean"), "L", False))
        if cser:
            charts.append(linechart("How much the reference matters",
                          "give the model more of the pack: score climbs, fabrication collapses",
                          cser))
        pts = [(display(m), size_of(m), reason[m]["small_mean"], gen_of(m)) for m in reason if size_of(m)]
        charts.append(scatter("Generation beats size",
                              "small-pack score vs size: modern-gen small models sit above older-gen big ones",
                              pts))
    if tools:
        t_items = sorted(((display(m), tools[m]["pass"], gen_of(m)) for m in tools),
                         key=lambda t: -t[1])
        t_max = max([tools[m]["n"] for m in tools] + [1])
        charts.append(hbar("Tool use", "cases where the model called tools correctly (of %d)" % t_max,
                           t_items, t_max, lambda v: f"{v:.0f}"))

    # data tables
    def rtable():
        buds = sorted({b for m in reason for b in reason[m]["per_budget"]})
        head = "".join(f"<th>{b}</th>" for b in buds)
        rows = ""
        for m in models:
            if m not in reason:
                continue
            cells = ""
            for b in buds:
                pb = reason[m]["per_budget"].get(b)
                cells += (f"<td>{pb['pass']}/{pb['n']} · {pb['mean']:.2f}</td>" if pb else "<td>–</td>")
            rows += (f'<tr><td class="mname"><i style="background:{GEN_COLOR[gen_of(m)]}"></i>'
                     f'{esc(display(m))}</td>{cells}<td>{reason[m]["inv"]}</td></tr>')
        return (f'<h3>Reasoning — pass/N · mean score, by budget</h3>'
                f'<div class="tscroll"><table><thead><tr><th>model</th>{head}<th>inv</th></tr>'
                f'</thead><tbody>{rows}</tbody></table></div>')

    def ttable():
        if not tools:
            return ""
        verds = ["pass", "no_call", "bad_call", "ignored", "loop", "unsupported"]
        head = "".join(f"<th>{v}</th>" for v in verds)
        rows = ""
        for m in models:
            if m not in tools:
                continue
            vd = tools[m]["verdicts"]
            cells = "".join(f"<td>{vd.get(v,0) or ''}</td>" for v in verds)
            rows += (f'<tr><td class="mname"><i style="background:{GEN_COLOR[gen_of(m)]}"></i>'
                     f'{esc(display(m))}</td><td><b>{tools[m]["pass"]}/{tools[m]["n"]}</b></td>{cells}</tr>')
        return (f'<h3>Tool use — verdict breakdown</h3>'
                f'<div class="tscroll"><table><thead><tr><th>model</th><th>pass</th>{head}</tr>'
                f'</thead><tbody>{rows}</tbody></table></div>')

    # summary strip: top reasoning + top tool-use, glanceable before the charts
    def chips():
        out = []
        if reason:
            top = sorted(reason.items(), key=lambda kv: -kv[1]["small_mean"])[:3]
            for rank, (m, d) in enumerate(top, 1):
                out.append(f'<div class="chip"><span class="rk">R{rank}</span>'
                           f'<i style="background:{GEN_COLOR[gen_of(m)]}"></i>'
                           f'<b>{esc(display(m))}</b>'
                           f'<span class="cm">{d["small_mean"]:.2f} small-pack</span></div>')
        if tools:
            best = max(tools.items(), key=lambda kv: kv[1]["pass"])
            out.append(f'<div class="chip"><span class="rk">TOOLS</span>'
                       f'<i style="background:{GEN_COLOR[gen_of(best[0])]}"></i>'
                       f'<b>{esc(display(best[0]))}</b>'
                       f'<span class="cm">{best[1]["pass"]}/{best[1]["n"]} tool use</span></div>')
        return "".join(out)

    chart_html = "".join(f'<div class="card">{c}</div>' for c in charts)
    present = set(reason) | set(tools)
    cats = tuple(g for g in ("DS", "CLOUD", "3.6", "3", "2.5")
                 if any(gen_of(m) == g for m in present))
    html = (TEMPLATE.replace("{{LEGEND}}", legend(cats)).replace("{{CHIPS}}", chips())
                    .replace("{{CHARTS}}", chart_html)
                    .replace("{{RTABLE}}", rtable() if reason else "")
                    .replace("{{TTABLE}}", ttable()))
    Path(out_path).write_text(html, encoding="utf-8")
    print("wrote", out_path, "(%d models, reason=%d tools=%d)"
          % (len(models), len(reason), len(tools)))


TEMPLATE = """<meta charset="utf-8">
<title>Qwen family sweep</title>
<style>
  /* cool-biased neutrals -- a slate lean, so the greys read as chosen not default */
  :root{
    --bg:#fbfcfd; --panel:#ffffff; --fg:#12161b; --mut:#5a6472; --faint:#8a94a3;
    --line:#e5e9ef; --chip:#f1f4f8; --accent:#2ea36f;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#0f1113; --panel:#16191d; --fg:#e7ebf0; --mut:#98a2b2; --faint:#6a7382;
    --line:#242a31; --chip:#1b1f24; --accent:#37c98a;}}
  :root[data-theme="dark"]{
    --bg:#0f1113; --panel:#16191d; --fg:#e7ebf0; --mut:#98a2b2; --faint:#6a7382;
    --line:#242a31; --chip:#1b1f24; --accent:#37c98a;}
  :root[data-theme="light"]{
    --bg:#fbfcfd; --panel:#ffffff; --fg:#12161b; --mut:#5a6472; --faint:#8a94a3;
    --line:#e5e9ef; --chip:#f1f4f8; --accent:#2ea36f;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);
    font-size:15px;line-height:1.5;-webkit-text-size-adjust:100%;
    font-variant-numeric:tabular-nums;}
  .wrap{max-width:860px;margin:0 auto;padding:26px 18px 56px;}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--accent);margin:0 0 6px;}
  h1{font-size:23px;line-height:1.2;margin:0 0 4px;text-wrap:balance;letter-spacing:-.01em;}
  .sub{color:var(--mut);margin:0 0 18px;font-size:14px;}
  h3{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;
    color:var(--mut);margin:30px 0 10px;}
  /* summary strip */
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px;}
  .chip{display:flex;align-items:center;gap:7px;background:var(--chip);border:1px solid var(--line);
    border-radius:999px;padding:6px 12px 6px 8px;font-size:13px;}
  .chip .rk{font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--faint);
    background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:2px 5px;}
  .chip i{width:9px;height:9px;border-radius:2px;display:inline-block;}
  .chip .cm{color:var(--mut);font-family:var(--mono);font-size:12px;}
  .legend{display:flex;gap:15px;flex-wrap:wrap;margin:10px 0 2px;color:var(--mut);font-size:12.5px;}
  .lg{display:inline-flex;align-items:center;gap:6px;}
  .lg i,.mname i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none;}
  .key{color:var(--faint);font-size:12px;margin:8px 0 2px;font-family:var(--mono);}
  /* cards + charts */
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;
    padding:16px 16px 12px;margin:12px 0;overflow-x:auto;}
  .ct{font-family:var(--sans);font-size:14.5px;font-weight:650;fill:var(--fg);}
  .cs{font-family:var(--sans);font-size:11.5px;fill:var(--mut);}
  .lbl{font-family:var(--mono);font-size:11.5px;fill:var(--fg);}
  .val{font-family:var(--mono);font-size:11.5px;font-weight:600;fill:var(--fg);}
  .ax{font-family:var(--mono);font-size:10px;fill:var(--faint);}
  .grid{stroke:var(--line);stroke-width:1;}
  .pt{font-family:var(--mono);font-size:9.5px;fill:var(--mut);}
  /* tables scroll inside their own box; the page body never scrolls sideways */
  .tscroll{overflow-x:auto;border:1px solid var(--line);border-radius:12px;margin-top:6px;}
  table{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12.5px;
    font-variant-numeric:tabular-nums;}
  th,td{border-bottom:1px solid var(--line);padding:7px 11px;text-align:center;white-space:nowrap;}
  tr:last-child td{border-bottom:none;}
  th{color:var(--mut);font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;}
  th:first-child,td:first-child{text-align:left;position:sticky;left:0;background:var(--panel);}
  .mname{display:flex;align-items:center;gap:8px;white-space:nowrap;font-family:var(--sans);}
  .foot{color:var(--faint);font-size:12px;line-height:1.55;margin-top:28px;
    border-top:1px solid var(--line);padding-top:14px;}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;}}
</style>
<div class="wrap">
  <p class="eyebrow">Local model evaluation</p>
  <h1>Qwen family — reasoning &amp; tool-use sweep</h1>
  <p class="sub">Mercenaries&nbsp;2 Lua IDE assistant · finding the best-fit local model</p>
  <div class="chips">{{CHIPS}}</div>
  {{LEGEND}}
  <p class="key">higher reasoning &amp; tool-use bars are better · lower invention bars are better</p>
  {{CHARTS}}
  {{RTABLE}}
  {{TTABLE}}
  <p class="foot">Reasoning score: grounded Lua tasks graded on API correctness, a grounding check
  against the real API set, and a Lua compile gate. Tool use: whether the agent actually calls its
  tools (search the reference, read a page, inspect the game) instead of answering from memory.
  Bars are coloured by model generation — the sweep's clearest signal is that the 2.5→3 jump moves
  results more than parameter count does.</p>
</div>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reason", default=str(ROOT / "bench-reason-results.json"))
    ap.add_argument("--tools", default=str(ROOT / "bench-tools-results.json"))
    ap.add_argument("--ds-reason", default="", help="merged DeepSeek reasoning shards (ds-merged.json)")
    ap.add_argument("--ds-tools", default="", help="DeepSeek tool-use shard (ds-tools.json)")
    ap.add_argument("--cloud", default="", help="merged Ollama-cloud reasoning shards (cloud-merged.json)")
    ap.add_argument("--out", default=str(ROOT / "bench-viz.html"))
    a = ap.parse_args()
    build(load_reason(a.reason, a.ds_reason, a.cloud), load_tools(a.tools, a.ds_tools), a.out)


if __name__ == "__main__":
    main()
