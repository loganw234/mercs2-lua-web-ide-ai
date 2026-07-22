#!/usr/bin/env python3
"""bench_reason.py -- reasoning quality vs context budget, for the Qwen family.

Answers ONE question: does qwen3:14b (the consumer sweet spot) match or beat the
larger qwen3.6:27b on realistic Mercs2 Lua IDE tasks WHEN each is given a proper
context budget -- the budget a consumer card can actually afford?

This is a different axis than the two existing benches:
  bench_tools.py  -- does the model CALL tools (agent behaviour)
  bench_local.py  -- short-answer pack-QA at a FIXED context
Here the tasks are multi-step REASONING (synthesis, debugging, grounded refusal)
and the context window is SWEPT (Ollama options.num_ctx), each num_ctx paired with
the largest reference pack that fits inside it with room left to think.

Two regimes fall out of that sweep, and both are the point:
  * small-pack budgets  -- the pack OMITS namespace/Ess signatures and its banner
    says to refuse rather than invent, so these budgets test GROUNDING DISCIPLINE
    (does the model know what it doesn't know?).
  * large-pack budgets  -- the reference is present, so these test whether the
    model can actually USE it to write correct code.
A good model's curve walks from "correctly refuses" to "correctly implements" as
the budget grows. The 14B-vs-27B question is answered at the top of the curve.

Grading is deliberately multi-signal and TRANSPARENT. The last bench shipped with
eight grader bugs that ALL punished correct behaviour, so here every sub-check is
stored and printed, and a single bad regex can never silently move the headline:
  1. must / must_not weighted regex   -- right APIs + engine semantics. The rubric
                                         is SELF-CALIBRATING: each task declares the
                                         real APIs it needs; the grader greps the
                                         loaded pack and applies the refuse-rubric
                                         or the implement-rubric accordingly.
  2. objective invention count         -- every Namespace.method in the code that is
                                         absent from BOTH the real-API set (the fork's
                                         own natives/ess/call_docs JSON) AND the loaded
                                         pack AND the full wiki corpus. This reuses the
                                         project's grounding data instead of guessing.
  3. compile gate (lupa.load)          -- does the generated Lua parse? + a regex layer
                                         for 5.1-only violations that lupa's 5.5 accepts
                                         (// , goto, bit operators).
  4. wall-clock + token counts         -- captures the 27B-on-DRAM tax directly.

Usage:
  python tools/bench_reason.py                              # default grid + models
  python tools/bench_reason.py --models qwen3:14b
  python tools/bench_reason.py --budgets B2,B4 --trials 2
  python tools/bench_reason.py --list-tasks
  python tools/bench_reason.py --list-budgets
Resumable: a re-run skips any (model, budget, task, trial) cell already in the out
file, so a killed 27B sweep picks up where it stopped.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src" / "data"
PACKS = DATA / "packs"
OLLAMA = "http://localhost:11434/api/chat"       # native endpoint: it takes options.num_ctx
# Hosted mode (--base-url / --key-file): talk to an OpenAI-compatible endpoint instead
# of Ollama, so a frontier model (DeepSeek, etc.) runs the SAME reasoning tasks as the
# local Qwens. Hosted has no per-request num_ctx -- the provider manages context -- so a
# "budget" collapses to just its pack tier, and MAX_CTX (the provider's window) decides
# which packs are too big to send. Run one budget PER TIER for hosted (e.g. B2,B3,B4,B5);
# B1 and B2 are the same pack there and would just duplicate the sample.
BASE_URL = ""
API_KEY = ""
IS_LOCAL = True
MAX_CTX = None            # hosted provider's context window, from --max-ctx
HOSTED_MAXTOK = 16384     # a hosted REASONER spends tokens thinking; leave room so the
                          # graded answer (content) isn't cut off mid-reasoning
OUT = Path(os.environ.get("BENCH_REASON_OUT", ROOT / "bench-reason-results.json"))
REQ_TIMEOUT = 2400        # 40 min: a 27B on DRAM at 128k ctx is slow, not broken
NUM_PREDICT = 3072        # output budget; must leave the pack room inside num_ctx

# Qwen3's own recommended sampling for thinking mode. Seed is pinned per trial so a
# rerun of the same cell is reproducible (and resume is exact).
SAMPLING = {"temperature": 0.6, "top_p": 0.95, "top_k": 20}

# ---------------------------------------------------------------------------
# Context budgets: (pack tier, num_ctx). num_ctx is sized to hold the pack plus a
# task plus ~3k of output/thinking. Walking B1->B4 grows BOTH the reference and the
# room to reason -- which is exactly "a proper context budget".
# ---------------------------------------------------------------------------
BUDGETS = {
    "B1": {"tier": "small",     "num_ctx": 16384,  "note": "floor: pack fits, tight thinking room"},
    "B2": {"tier": "small",     "num_ctx": 32768,  "note": "same reference, generous thinking room"},
    "B3": {"tier": "smallplus", "num_ctx": 65536,  "note": "more reference (namespaces) + room"},
    # B4 num_ctx trimmed to just hold the 71k Ess pack (+task+output). 131072 forced a
    # KV cache so large it spilled to DRAM even on a 14B (~20 min/task); ~90k keeps the
    # pack whole while cutting the cache ~1/3. Still heavy -- reserved for a targeted run.
    "B4": {"tier": "ess",       "num_ctx": 90112,  "note": "full ref + Ess (trimmed ctx) -- ~20 min/task"},
    # B5-B7 load the medium/large/FULL wiki packs. These are stress tests: the KV cache
    # for a 128k-256k window spills massively to DRAM, so each task can take tens of
    # minutes to hours, and only a model with matching native context runs them at all
    # (others auto-skip). Raise --timeout to keep the slow ones from timing out.
    "B5": {"tier": "medium",    "num_ctx": 131072, "note": "medium pack ~99k -- SLOW, needs 128k-ctx model"},
    "B6": {"tier": "large",     "num_ctx": 196608, "note": "large pack ~158k -- VERY slow, needs 192k-ctx"},
    "B7": {"tier": "full",      "num_ctx": 262144, "note": "FULL pack ~240k -- extreme, needs 256k-ctx model"},
}

DEFAULT_MODELS = ["qwen3:14b", "qwen3.6:27b"]

# ---------------------------------------------------------------------------
# Tasks. Each declares the pack CAPABILITY it needs ("namespaces", "ess", or None);
# the grader reads the pack's own "Omitted:" banner to decide whether to expect an
# implementation or an honest "I'd need that reference". Reading the pack's self-
# declaration is drift-proof -- far better than grepping for API strings, which also
# appear in the examples a reduced pack keeps.
#   cat          : synthesis | debug | ground | plan
#   needs_cap    : "namespaces" | "ess" | None (None = conceptual, always impl branch)
#   want_code    : extract a ```lua block and run it through the compile gate (impl only)
#   impl_must/_not  : rubric applied WHEN the pack carries the needed reference
#   refuse_must     : rubric applied when it does NOT (honest-limitation answer)
#   always_must_not : invention / wrong-semantics -- penalised in BOTH branches
# Regexes are matched case-insensitively and kept permissive on wording; the hard
# signals are the objective invention count (code only) and the compile gate.
# ---------------------------------------------------------------------------
SOLDIER = r"(VZ|Allied|Guer(i|il)la|Chinese|OC|Pirate)\s*(Soldier|Thug)"
INVENT_FACTION = r"Ai\.SetFaction\w*\s*\(|Object\.SetFaction\w*\s*\(|:SetFaction\w*\s*\("

TASKS = [
    # -- synthesis: needs namespace + Ai reference -> tier-aware -----------------
    {
        "id": "squad-patrol", "cat": "synthesis",
        "prompt": "Write a complete Lua script that spawns three soldiers allied to "
                  "the player near the player's position and orders them to patrol back "
                  "and forth between two points. Use the raw engine API (no Ess). Give "
                  "the exact spawn template string and the exact AI call.",
        "needs_cap": "namespaces", "want_code": True,
        "impl_must": [SOLDIER, r"Ai\.Role|Ai\.Goal"],
        "impl_must_not": [r"Pg\.Spawn\(\s*[\"']\s*PMC"],
        "refuse_must": [r"do ?n[o']t (have|know)|not in (this|the)|would need|missing|"
                        r"wiki\.mercs2|cannot confirm|reference"],
        "always_must_not": [INVENT_FACTION],
    },
    {
        "id": "crate-at-player", "cat": "synthesis",
        "prompt": "Write a snippet that reads the player's current position and spawns a "
                  "supply crate at that spot.",
        "needs_cap": "namespaces", "want_code": True,
        "impl_must": [r"Player\.GetLocalCharacter|GetLocalPlayer|Object\.GetPosition"],
        "impl_must_not": [r"import\(\s*[\"']\s*(Pg|Object|Player|Ai)\b"],
        "refuse_must": [r"do ?n[o']t (have|know)|not in (this|the)|would need|missing|"
                        r"wiki\.mercs2|reference"],
        "always_must_not": [r"Object\.Teleport\s*\("],
    },
    # -- plan: coordinate math + loop, needs spawn ------------------------------
    {
        "id": "coord-ring", "cat": "plan",
        "prompt": "Spawn six crates evenly spaced in a ring of radius 20 around the "
                  "world coordinates x=100, y=5, z=-200. Show the full loop.",
        "needs_cap": "namespaces", "want_code": True,
        "impl_must": [r"math\.(cos|sin)", r"for\b", r"2\s*\*\s*math\.pi|math\.pi\s*\*\s*2|"
                      r"6\.28|/\s*6|360\s*/\s*6|60\b"],
        "impl_must_not": [],
        "refuse_must": [r"do ?n[o']t (have|know)|not in (this|the)|would need|reference"],
        "always_must_not": [r"\+\=", r"\bmath\.tau\b"],
    },
    # -- synthesis + a subtle engine trap (getter truthiness) -------------------
    {
        "id": "hud-toggle", "cat": "synthesis",
        "prompt": "Write an OnKey script that toggles a HUD widget's visibility and is "
                  "safe to press over and over. The widget has GetVisible and SetVisible.",
        "needs_cap": "namespaces", "want_code": True,
        "impl_must": [r"KEYVAL|OnKey|_G\.", r"SetVisible"],
        "impl_must_not": [r"if\s+not\s+\w+[:.]GetVisible\(\)\s+then"],
        "refuse_must": [r"do ?n[o']t (have|know)|not in|would need|reference"],
        "always_must_not": [r"import\(\s*[\"']\s*(Object|Player|Pg|Gui|Hud)\b"],
    },

    # -- debug: conceptual, gradeable identically across tiers ------------------
    {
        "id": "debug-getter", "cat": "debug",
        "prompt": "This never toggles my HUD and I can't see why:\n\n"
                  "    if not widget:GetVisible() then widget:SetVisible(1) "
                  "else widget:SetVisible(0) end\n\n"
                  "What's wrong and how do I fix it?",
        "needs_cap": None, "want_code": False,
        "impl_must": [r"1\s*/\s*0|returns? (a )?(1|0|number|integer)|not (a )?boolean|"
                      r"only nil|nil.{0,15}(is|counts? as).{0,10}false|truthy"],
        "impl_must_not": [], "refuse_must": [],
        "always_must_not": [],
    },
    {
        "id": "debug-timer", "cat": "debug",
        "prompt": "I scheduled this with Event.TimerRelative so it runs every half "
                  "second, but it only fires once:\n\n"
                  "    local function tick() doStuff() end\n"
                  "    Event.TimerRelative(0.5, tick)\n\n"
                  "Why does it only run once, and how do I make it repeat?",
        "needs_cap": None, "want_code": False,
        "impl_must": [r"re-?arm|re-?schedul|calls? itself|again|inside (the |it)|"
                      r"last line|re-?register|set (it|the timer) again"],
        "impl_must_not": [], "refuse_must": [],
        "always_must_not": [],
    },
    {
        "id": "debug-print", "cat": "debug",
        "prompt": "My Debug.Printf calls never show up anywhere. What should I use "
                  "instead to actually see debug output?",
        "needs_cap": None, "want_code": False,
        "impl_must": [r"Loader\.Printf"],
        "impl_must_not": [], "refuse_must": [],
        "always_must_not": [r"(use|recommend|switch to|try)\s+Debug\.Printf"],
    },
    {
        "id": "debug-lua51", "cat": "debug",
        "prompt": "This line throws a syntax error in my mod:\n\n"
                  "    count += 1\n\n"
                  "and later `flags & 0x2` errors too. Why, and what do I write instead?",
        "needs_cap": None, "want_code": False,
        "impl_must": [r"5\.1|no (compound|\+=)|not (available|supported)|do ?n[o']t (exist|support)|"
                      r"no (native )?bit(wise)? (operator|op)"],
        "impl_must_not": [r"[Yy]es,? you can (use|write) `?\+="],
        "refuse_must": [],
        "always_must_not": [],
    },

    # -- grounding under pressure -----------------------------------------------
    {
        "id": "faction-runtime", "cat": "ground",
        "prompt": "Is there a call to change an object's faction at runtime? If so give "
                  "the exact function; if not, say so.",
        "needs_cap": None, "want_code": False,
        "impl_must": [r"\bno\b|not documented|do ?n[o']t (exist|have|see)|cannot confirm|"
                      r"not (a |an )?(documented|available)|would need"],
        "impl_must_not": [INVENT_FACTION],
        "refuse_must": [],
        "always_must_not": [INVENT_FACTION],
    },
    {
        "id": "ess-probe-sig", "cat": "ground",
        "prompt": "With the Ess framework, what arguments does Ess.Probe.nearby take? "
                  "Give the exact signature.",
        "needs_cap": "ess", "want_code": False,
        "impl_must": [r"Ess\.Probe\.nearby\s*\("],
        "impl_must_not": [],
        "refuse_must": [r"do ?n[o']t (have|know)|not in (this|the)|would need|cannot confirm|"
                        r"wiki\.mercs2|reference|Ess (framework )?(api|reference)"],
        "always_must_not": [],
    },
]

# ---------------------------------------------------------------------------
# Grounding data: the real-API set + the full corpus, for objective invention scoring.
# Mirrors 85_ground.js -- a name is invented only if it is absent EVERYWHERE.
# ---------------------------------------------------------------------------
API_RE = re.compile(r"\b[A-Z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*\b")
CODE_RE = re.compile(r"```(?:lua)?\s*\n(.*?)```", re.S | re.I)
THINK_RE = re.compile(r"<think>.*?</think>", re.S | re.I)


def build_grounding_blob():
    """One big lowercase text blob of every place a real API name can appear:
    the fork's API JSON, plus the full wiki corpus (pack-full). Substring membership
    against this is the invention test -- under-flagging (missing an invention) is the
    SAFE direction; the failure we refuse to repeat is falsely punishing a real name."""
    parts = []
    try:
        n = json.load(open(DATA / "natives.json", encoding="utf-8"))
        for nsname, methods in n["natives"].items():
            if isinstance(methods, dict):
                for m in methods:
                    parts.append(nsname + "." + m)
    except Exception as e:  # noqa: BLE001
        print("[warn] natives.json:", e)
    try:
        e = json.load(open(DATA / "ess-api.json", encoding="utf-8"))
        for nsobj in e.get("namespaces", []):
            for c in nsobj.get("calls", []):
                if c.get("path"):
                    parts.append(c["path"])
        parts += [c for c in e.get("completions", []) if isinstance(c, str)]
    except Exception as e:  # noqa: BLE001
        print("[warn] ess-api.json:", e)
    # full corpus: catches real-but-not-in-JSON names like Loader.Printf
    try:
        parts.append((PACKS / "pack-full.txt").read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        print("[warn] pack-full.txt:", e)
    return "\n".join(parts).lower()


GROUND_BLOB = None      # lazy-built once


LOCAL_DEF_RE = re.compile(r"\blocal\s+([A-Z]\w*)|\b([A-Z]\w*)\s*=\s*\{")
STOPWORDS = ("I", "It", "The", "This", "A", "An", "E", "G", "If", "So", "Note", "But", "Or")


def invented_names(code, pack_text):
    """Dotted Namespace.method tokens in `code` absent from the grounding blob AND the
    loaded pack. Returns the sorted unique list.

    Crucially, bases the code DEFINES itself (`local W = {}`, `M = {...}`) are the
    model's own tables, not API claims -- flagging `W.widget` as an invented engine call
    would falsely fail idiomatic Lua (the Ess framework's own `local M = {}` module
    pattern uses uppercase table names). So we exclude locally-defined bases. A genuinely
    invented namespace like `Hud.SetVisible` is never `local`-defined, so it still fires."""
    global GROUND_BLOB
    if GROUND_BLOB is None:
        GROUND_BLOB = build_grounding_blob()
    hay = GROUND_BLOB + "\n" + pack_text.lower()
    local_bases = {a or b for a, b in LOCAL_DEF_RE.findall(code)}
    out = set()
    for m in API_RE.findall(code):
        base = m.split(".")[0]
        if base in STOPWORDS or base in local_bases:
            continue
        if m.lower() not in hay:
            out.add(m)
    return sorted(out)


# 5.1 violations that lupa's embedded 5.5 will happily COMPILE but the engine rejects.
LUA51_BAD = [
    (r"[^/:]//[^/]", "// integer division (5.3+)"),
    (r"\bgoto\b|::\w+::", "goto/label (5.2+)"),
    (r"[\w\)\]]\s*<<\s*[\w\(]|[\w\)\]]\s*>>\s*[\w\(]", "bit shift (5.3+)"),
    (r"[\w\)\]]\s+[&|]\s+[\w\(]", "bitwise and/or operator (5.3+)"),
    (r"\+\=|\-\=|\*\=|/\=", "compound assignment (no Lua)"),
]
_lua = None


def compile_gate(code):
    """(parses_ok, err_or_None, [lua51 violations]). Uses lupa's load() -- parse only,
    no execution, so undefined engine globals are irrelevant."""
    global _lua
    violations = [why for rx, why in LUA51_BAD if re.search(rx, code)]
    try:
        import lupa
        if _lua is None:
            _lua = lupa.LuaRuntime(unpack_returned_tuples=True)
        loader = _lua.eval("function(s) local f,e = load(s); if f then return true else return e end end")
        res = loader(code)
        if res is True:
            return True, None, violations
        return False, str(res)[:160], violations
    except ImportError:
        return None, "lupa-not-installed", violations
    except Exception as e:  # noqa: BLE001
        return None, str(e)[:160], violations


def pack_capabilities(pack_text):
    """Which reference sections the pack actually carries, read from its OWN "Omitted:"
    banner. A reduced pack lists what it drops; a full pack has no banner (drops
    nothing). Drift-proof: it tracks the pack's self-declaration, not a hardcoded map."""
    caps = {"namespaces", "ess"}
    if "Omitted:" in pack_text:
        omit = pack_text.split("Omitted:", 1)[1][:600].lower()
        if "namespace signatures" in omit:
            caps.discard("namespaces")
        if "essentials (ess)" in omit:
            caps.discard("ess")
    return caps


def grade(task, raw, pack_text):
    """Return a dict of every sub-signal plus a composite score in [0,1] and a verdict.
    Nothing is thrown away -- the caller stores this whole dict."""
    answer = THINK_RE.sub("", raw).strip()
    code_blocks = CODE_RE.findall(raw)
    code = "\n".join(code_blocks).strip()

    # Which branch? A conceptual task (needs_cap None) is always graded as impl. A task
    # that needs a reference is graded as impl only when the pack actually carries it;
    # otherwise the CORRECT answer is an honest "I'd need that reference".
    need = task["needs_cap"]
    has_ref = (need is None) or (need in pack_capabilities(pack_text))
    branch = "impl" if has_ref else "refuse"

    must = task["impl_must"] if branch == "impl" else task["refuse_must"]
    must_not = list(task["always_must_not"])
    if branch == "impl":
        must_not += task["impl_must_not"]

    # must/must_not scan the whole answer (prose + code fences). must_not patterns for
    # fabricated calls require a "(", so they fire on USE, not on a prose negation.
    miss = [p for p in must if not re.search(p, answer, re.I)]
    bad = [p for p in must_not if re.search(p, answer, re.I)]

    # Objective invention runs on CODE ONLY. The full corpus contains the grounding
    # docs, which quote fake names as counterexamples; running this on prose would flag
    # a model that CORRECTLY names a nonexistent function while refusing it -- the exact
    # false-positive we refuse to ship. Naming a fake API inside code IS using it.
    inv = invented_names(code, pack_text) if code else []

    # Compile gate only where an implementation is expected. In the refuse branch a
    # code-less answer is correct, so absence of code is not a failure.
    comp_ok, comp_err, lua51 = (None, None, [])
    if branch == "impl" and task["want_code"]:
        if code:
            comp_ok, comp_err, lua51 = compile_gate(code)
        else:
            comp_ok = False      # code was asked for and none was produced
            comp_err = "no code block"

    # -- composite score. Sub-signals stay separate in the row; this is a convenience.
    score = 1.0
    if must:
        score -= 0.5 * (len(miss) / len(must))
    if bad:
        score = min(score, 0.25) - 0.4 * (len(bad) - 1)
    score -= 0.3 * len(inv)
    if task["want_code"] and comp_ok is False:
        score -= 0.3
    for _ in lua51:
        score -= 0.2
    score = max(0.0, min(1.0, score))

    ok = (not miss and not bad and not inv
          and not (task["want_code"] and comp_ok is False) and not lua51)
    if ok:
        verdict = "pass"
    elif bad or inv:
        verdict = "INVENTED" if inv else "wrong"
    elif task["want_code"] and comp_ok is False:
        verdict = "nocompile"
    else:
        verdict = "miss"

    return {
        "branch": branch, "has_ref": has_ref, "verdict": verdict, "score": round(score, 3),
        "miss": miss, "bad": bad, "invented": inv,
        "compiles": comp_ok, "compile_err": comp_err, "lua51": lua51,
        "answer_len": len(answer), "had_code": bool(code),
    }


# ---------------------------------------------------------------------------
# Model I/O
# ---------------------------------------------------------------------------
def load_pack(tier):
    p = PACKS / ("pack-%s.txt" % tier)
    text = p.read_text(encoding="utf-8")
    help_path = DATA / "ide-help.txt"        # build.py appends this to every tier
    if help_path.exists():
        text = text + "\n\n" + help_path.read_text(encoding="utf-8")
    return text


def ask(model, pack, prompt, num_ctx, seed):
    t0 = time.time()
    msgs = [{"role": "system", "content": pack}, {"role": "user", "content": prompt}]
    try:
        if IS_LOCAL:
            body = json.dumps({
                "model": model, "messages": msgs, "stream": False,
                "options": dict(SAMPLING, num_ctx=num_ctx, num_predict=NUM_PREDICT, seed=seed),
            }).encode("utf-8")
            req = urllib.request.Request(OLLAMA, data=body,
                                         headers={"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=REQ_TIMEOUT) as r:
                data = json.loads(r.read().decode("utf-8"))
            return {"text": data.get("message", {}).get("content", ""),
                    "secs": round(time.time() - t0, 1),
                    "prompt_tok": data.get("prompt_eval_count"),
                    "out_tok": data.get("eval_count"), "err": None}
        # hosted: OpenAI /chat/completions. No num_ctx -- the provider manages context.
        body = json.dumps({
            "model": model, "messages": msgs, "stream": False,
            "temperature": SAMPLING["temperature"], "top_p": SAMPLING["top_p"],
            "max_tokens": HOSTED_MAXTOK, "seed": seed,
        }).encode("utf-8")
        headers = {"content-type": "application/json"}
        if API_KEY:
            headers["authorization"] = "Bearer " + API_KEY
        req = urllib.request.Request(BASE_URL + "/chat/completions", data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=REQ_TIMEOUT) as r:
            data = json.loads(r.read().decode("utf-8"))
        msg = data["choices"][0]["message"]
        usage = data.get("usage", {})
        return {"text": msg.get("content", "") or "",
                "secs": round(time.time() - t0, 1),
                "prompt_tok": usage.get("prompt_tokens"),
                "out_tok": usage.get("completion_tokens"), "err": None}
    except Exception as e:  # noqa: BLE001
        return {"text": "", "secs": round(time.time() - t0, 1), "err": str(e)[:160]}


# ---------------------------------------------------------------------------
# Runner (resumable)
# ---------------------------------------------------------------------------
def load_out():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return {"cells": {}}


def cell_key(model, budget, task_id, trial):
    return "%s|%s|%s|%d" % (model, budget, task_id, trial)


_native_ctx = {}


def native_ctx(model):
    """The model's TRAINED context window, read from `ollama show`. This is the number
    Ollama clamps num_ctx to -- request more and it silently caps, then truncates the
    pack (dropping the front: the system rules). qwen3:14b is 40960, so it CANNOT hold
    the 48k small+ pack no matter what num_ctx you ask for. Cached per model."""
    if not IS_LOCAL:
        return MAX_CTX          # hosted: the provider's window (from --max-ctx), or no cap
    if model in _native_ctx:
        return _native_ctx[model]
    n = None
    try:
        import subprocess
        r = subprocess.run(["ollama", "show", model], capture_output=True, text=True, timeout=30)
        m = re.search(r"context length\s+(\d+)", r.stdout)
        if m:
            n = int(m.group(1))
    except Exception:  # noqa: BLE001
        pass
    _native_ctx[model] = n
    return n


def run(models, budgets, tasks, trials, resume=True):
    out = load_out() if resume else {"cells": {}}
    cells = out["cells"]
    pack_cache = {}

    for model in models:
        print("\n" + "=" * 78 + "\n=== %s\n" % model + "=" * 78)
        for bkey in budgets:
            b = BUDGETS[bkey]
            tier, num_ctx = b["tier"], b["num_ctx"]
            if tier not in pack_cache:
                pack_cache[tier] = load_pack(tier)
            pack = pack_cache[tier]
            approx_tok = len(pack) // 4
            print("\n-- %s  tier=%s (~%dk tok)  num_ctx=%d  [%s]"
                  % (bkey, tier, approx_tok // 1000, num_ctx, b["note"]))
            # Skip budgets the model can't natively hold: Ollama would clamp num_ctx to
            # the trained window and truncate the pack, silently corrupting grounding.
            nctx = native_ctx(model)
            if nctx and num_ctx > nctx:
                print("   SKIP: num_ctx %d > %s native ctx %d -> pack would truncate"
                      % (num_ctx, model, nctx))
                continue
            for task in tasks:
                for trial in range(trials):
                    ck = cell_key(model, bkey, task["id"], trial)
                    if ck in cells:
                        r = cells[ck]
                        g = r.get("grade", {})
                        print("   %-16s t%d  (cached) %-9s score=%.2f"
                              % (task["id"], trial, g.get("verdict", "?"), g.get("score", 0)))
                        continue
                    resp = ask(model, pack, task["prompt"], num_ctx, seed=trial)
                    if resp["err"]:
                        cells[ck] = {"resp": resp, "grade": {"verdict": "ERROR", "score": 0.0}}
                        print("   %-16s t%d  ERROR: %s" % (task["id"], trial, resp["err"]))
                        _save(out)
                        continue
                    # Truncation guard: if the model ingested far fewer prompt tokens
                    # than the pack contains, Ollama dropped part of the pack -> the
                    # answer is graded against a reference the model never saw. Mark the
                    # cell invalid rather than let a bogus verdict into the summary.
                    ptok = resp.get("prompt_tok") or 0
                    truncated = bool(ptok and ptok < approx_tok * 0.9)
                    if truncated:
                        g = {"verdict": "TRUNCATED", "score": 0.0, "invented": [],
                             "note": "pack truncated: prompt_tok %d << pack ~%d tok"
                                     % (ptok, approx_tok)}
                    else:
                        g = grade(task, resp["text"], pack)
                    cells[ck] = {"resp": resp, "grade": g}
                    print("   %-16s t%d  %-9s score=%.2f  %ds  %din/%dout  %s%s%s"
                          % (task["id"], trial, g["verdict"], g.get("score", 0), resp["secs"],
                             ptok, resp.get("out_tok") or 0,
                             ("inv=%d " % len(g.get("invented", []))) if g.get("invented") else "",
                             ("comp=%s " % g["compiles"]) if (not truncated and task["want_code"]) else "",
                             " !TRUNC" if truncated else ""))
                    _save(out)
    return out


def _save(out):
    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")


def regrade(out):
    """Re-run grade() over every stored response WITHOUT re-querying the model. This is
    the whole point of storing raw text: a grader tweak costs zero model compute, so a
    27B sweep is never re-run just because a regex changed."""
    cells = out["cells"]
    by_id = {t["id"]: t for t in TASKS}
    pack_cache, changed = {}, 0
    for ck, cell in cells.items():
        model, bkey, task_id, _ = ck.rsplit("|", 3)
        task = by_id.get(task_id)
        if not task or bkey not in BUDGETS:
            continue
        resp = cell.get("resp", {})
        if resp.get("err") or not resp.get("text"):
            continue
        # A truncated cell's response was produced against a partial pack; regrading it
        # would manufacture a valid-looking verdict from an invalid run. Leave it flagged.
        if cell.get("grade", {}).get("verdict") == "TRUNCATED":
            continue
        tier = BUDGETS[bkey]["tier"]
        if tier not in pack_cache:
            pack_cache[tier] = load_pack(tier)
        g = grade(task, resp["text"], pack_cache[tier])
        if g != cell.get("grade"):
            changed += 1
        cell["grade"] = g
    _save(out)
    print("regraded %d cells (%d verdicts changed)" % (len(cells), changed))
    return out


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
def summarize(out, models, budgets, tasks, trials):
    cells = out["cells"]
    ntasks = len(tasks)
    print("\n" + "=" * 78)
    print("SUMMARY  (pass = clean on every signal; inv = invented API names)")
    print("=" * 78)
    hdr = "%-30s %-4s %8s %7s %7s %7s %6s %8s %9s" % (
        "model", "bud", "pass", "meanS", "inv", "nocomp", "inval", "med_s", "tot_s")
    print(hdr)
    print("-" * len(hdr))
    for model in models:
        for bkey in budgets:
            npass = inv = nocomp = invalid = 0
            scores, secs = [], []
            for task in tasks:
                for trial in range(trials):
                    r = cells.get(cell_key(model, bkey, task["id"], trial))
                    if not r:
                        continue
                    g = r.get("grade", {})
                    if r.get("resp", {}).get("secs") is not None:
                        secs.append(r["resp"]["secs"])
                    # ERROR/TRUNCATED cells are INVALID, not failures -- they never got a
                    # fair shot at the task, so keep them out of pass rate and mean score.
                    if g.get("verdict") in ("ERROR", "TRUNCATED"):
                        invalid += 1
                        continue
                    scores.append(g.get("score", 0))
                    inv += len(g.get("invented", []))
                    if g.get("verdict") == "pass":
                        npass += 1
                    if g.get("compiles") is False:
                        nocomp += 1
            if not scores and not invalid:
                continue
            ss = sorted(secs)
            med = ss[len(ss) // 2] if ss else 0
            meanS = (sum(scores) / len(scores)) if scores else 0.0
            print("%-30s %-4s %6d/%-2d %7.2f %7d %7d %6d %8.0f %9.0f" % (
                model, bkey, npass, len(scores), meanS, inv, nocomp, invalid, med, sum(secs)))
    print("\npass/N is over VALID cells only; 'inval' = truncated or errored cells that")
    print("never saw the full pack. Read a red cell before believing it -- full answers +")
    print("every sub-check are in %s." % OUT.name)


# ---------------------------------------------------------------------------
def main():
    global REQ_TIMEOUT, IS_LOCAL, BASE_URL, API_KEY, MAX_CTX
    ap = argparse.ArgumentParser(description="reasoning quality vs context budget")
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS))
    ap.add_argument("--budgets", default=",".join(BUDGETS.keys()))
    ap.add_argument("--tasks", default="", help="comma-separated task ids (default all)")
    ap.add_argument("--trials", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=REQ_TIMEOUT,
                    help="per-task seconds before a cell is abandoned (raise for B5+)")
    ap.add_argument("--base-url", default="",
                    help="OpenAI-compatible endpoint for HOSTED models (e.g. DeepSeek). "
                         "Omit for local Ollama.")
    ap.add_argument("--key-file", default="",
                    help="file holding the API key for --base-url (kept out of the repo)")
    ap.add_argument("--max-ctx", type=int, default=0,
                    help="hosted provider's context window; budgets whose pack won't fit skip")
    ap.add_argument("--no-resume", action="store_true")
    ap.add_argument("--list-tasks", action="store_true")
    ap.add_argument("--list-budgets", action="store_true")
    ap.add_argument("--summary-only", action="store_true")
    ap.add_argument("--regrade", action="store_true",
                    help="re-grade stored responses in place, no model calls")
    args = ap.parse_args()

    if args.list_budgets:
        for k, b in BUDGETS.items():
            print("%-4s tier=%-10s num_ctx=%-7d %s" % (k, b["tier"], b["num_ctx"], b["note"]))
        return
    if args.list_tasks:
        for t in TASKS:
            print("%-16s [%-9s] needs_cap=%s" % (t["id"], t["cat"], t["needs_cap"] or "-"))
        return

    REQ_TIMEOUT = args.timeout
    if args.base_url:
        IS_LOCAL = False
        BASE_URL = args.base_url.rstrip("/")
        MAX_CTX = args.max_ctx or None
        if args.key_file:
            API_KEY = Path(args.key_file).read_text(encoding="utf-8").strip()
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    budgets = [b.strip() for b in args.budgets.split(",") if b.strip()]
    for b in budgets:
        if b not in BUDGETS:
            sys.exit("unknown budget %r (have %s)" % (b, ", ".join(BUDGETS)))
    tasks = TASKS
    if args.tasks:
        want = {x.strip() for x in args.tasks.split(",")}
        tasks = [t for t in TASKS if t["id"] in want]
        if not tasks:
            sys.exit("no tasks matched %r" % args.tasks)

    if args.regrade:
        summarize(regrade(load_out()), models, budgets, tasks, args.trials)
        return

    if args.summary_only:
        summarize(load_out(), models, budgets, tasks, args.trials)
        return

    print("models:  %s" % ", ".join(models))
    print("budgets: %s" % ", ".join(budgets))
    print("tasks:   %d  trials: %d  -> %d cells"
          % (len(tasks), args.trials, len(models) * len(budgets) * len(tasks) * args.trials))
    out = run(models, budgets, tasks, args.trials, resume=not args.no_resume)
    summarize(out, models, budgets, tasks, args.trials)


if __name__ == "__main__":
    main()
