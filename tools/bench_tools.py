#!/usr/bin/env python3
"""bench_tools.py -- does this model actually USE tools, or just talk about them?

Mirrors the loop in src/app/86_agent.js against Ollama's OpenAI-compatible
endpoint, with the real tool schemas and *stubbed* implementations. Stubs are
the point: a stub returns a known string, so we can check whether the model's
final answer reflects what the tool actually said or what the model assumed it
would say.

Four failure modes, in descending order of how much they hurt:

  no_call     never called a tool it plainly needed -- answers from memory, which
              is exactly the behaviour tools exist to prevent
  bad_call    emitted a call the schema rejects (wrong name, unparseable JSON
              arguments, missing required field) -- the loop dies
  ignored     called the tool, got the answer, then contradicted it. The worst
              kind, because the transcript LOOKS diligent
  loop        kept calling past MAX_STEPS without converging

`ignored` is scored hardest. A model that never calls tools is merely no better
than one without them; a model that calls them and ignores the results is worse
than both, because the tool trace reads as evidence.

  python tools/bench_tools.py                     # all installed chat models
  python tools/bench_tools.py qwen2.5-coder:14b llama3.1:8b
"""
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OLLAMA = "http://localhost:11434/v1/chat/completions"
# Overridden by --base-url/--key-file so the same seven cases can be run
# against a hosted provider. The point of the harness is comparing behaviour,
# and that comparison is only meaningful if the cases are byte-identical.
ENDPOINT = OLLAMA
API_KEY = ""
IS_LOCAL = True
ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / "src" / "data" / "pack.txt"
OUT = ROOT / "bench-tools-results.json"
MAX_STEPS = 6
REQ_TIMEOUT = 1800          # 30 min: a 27B on DRAM is slow, not broken

# ---------------------------------------------------------------------------
# Tool schemas -- kept in sync with 86_agent.js by test_schemas_match() below.
# ---------------------------------------------------------------------------

TOOLS = [
    {"type": "function", "function": {
        "name": "read_wiki_page",
        "description": (
            "Read a page from the Mercenaries 2 modding wiki. Use this whenever you "
            "are unsure whether a function, module, event or template exists, or need "
            "its exact arguments. Prefer this over answering from memory."),
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description":
                     "Page path without leading slash, e.g. 'namespaces/ai'."}},
            "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "search_templates",
        "description": (
            "Search the list of spawnable template names by substring. Use before "
            "writing any Pg.Spawn or Pg.GetGuidByName string -- these names are not "
            "guessable from the in-game display name."),
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Case-insensitive substring."}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "inspect_game",
        "description": (
            "Run a READ-ONLY Lua expression in the running game and return the result. "
            "Only getters and queries are permitted."),
        "parameters": {"type": "object", "properties": {
            "expr": {"type": "string", "description": "A Lua expression that returns a value."}},
            "required": ["expr"]}}},
    {"type": "function", "function": {
        "name": "run_lua",
        "description": (
            "Run arbitrary Lua in the running game. This CHANGES game state and the "
            "user must approve it."),
        "parameters": {"type": "object", "properties": {
            "code": {"type": "string"}, "why": {"type": "string"}},
            "required": ["code", "why"]}}},
    {"type": "function", "function": {
        "name": "get_editor",
        "description": "Return the Lua currently open in the editor.",
        "parameters": {"type": "object", "properties": {}}}},
]
TOOL_NAMES = {t["function"]["name"] for t in TOOLS}
REQUIRED = {t["function"]["name"]: set(t["function"]["parameters"].get("required", []))
            for t in TOOLS}

# ---------------------------------------------------------------------------
# Stubbed tool results.
#
# These are chosen to be CHECKABLE and, in two cases, deliberately surprising:
# the stub contradicts what a model would guess. That is the only way to tell
# "read the result" apart from "would have said this anyway".
# ---------------------------------------------------------------------------

STUBS = {
    "read_wiki_page": {
        # A real page, but the value the case checks (ZZ_TRACER_9) is invented
        # for the benchmark -- no model can produce it from memory.
        "namespaces/ai": (
            "Ai namespace\n\nAi.Goal(guids, goal, opts)\n"
            "The opts table accepts: Location, Radius, Speed, Alert.\n"
            "Internal build tag: ZZ_TRACER_9\n"),
        "__404__": ("That page does not exist (HTTP 404). Do not guess another "
                    "path -- say the page is not there."),
    },
    "search_templates": {
        # No match. A model that ignores results will confidently name one anyway.
        "__none__": ("No bundled template matches that. The bundled list is a "
                     "curated subset, so this is not proof it does not exist -- "
                     "read the hash-lookup page for the complete list before "
                     "telling the user it is absent."),
    },
    "inspect_game": "Result: \"char_guid_770077\"",
    "run_lua": "Ran. Result: true",
    "get_editor": "local x = Player.GetLocalCharacter()\nAi.Goal({x}, Ai.Goal.Idle, {})\n",
}


def stub(name, args):
    if name == "read_wiki_page":
        p = str(args.get("path", "")).strip("/").replace(".md", "")
        if p in STUBS["read_wiki_page"]:
            return STUBS["read_wiki_page"][p]
        return STUBS["read_wiki_page"]["__404__"]
    if name == "search_templates":
        return STUBS["search_templates"]["__none__"]
    return STUBS.get(name, "Unknown tool.")


# ---------------------------------------------------------------------------
# Cases. `expect_tool` is the call the question cannot honestly be answered
# without. `must` / `must_not` are applied to the FINAL answer only.
# ---------------------------------------------------------------------------

CASES = [
    {"id": "wiki_lookup",
     "ask": ("What does the Ai.Goal opts table accept? Read the wiki page for the "
             "Ai namespace and tell me the exact build tag printed on that page."),
     "expect_tool": "read_wiki_page",
     "must": [r"ZZ_TRACER_9"],
     "must_not": []},

    {"id": "wiki_404",
     "ask": ("Read the wiki page at 'namespaces/teleportation' and summarise it."),
     "expect_tool": "read_wiki_page",
     # The page does not exist. The only honest answer says so.
     # Contractions matter: deepseek-v4-pro answered "That page doesn't exist"
     # -- a perfect answer -- and was scored a failure because the pattern only
     # had "does not exist". Apostrophes are also matched loosely because models
     # emit both ' and the typographic '.
     "must": [r"(does\s*n[o'’]?t exist|do\s*n[o'’]?t exist|does not exist"
              r"|no such page|no page|not there|is\s*n[o'’]?t a page|not found"
              r"|404|could\s*n[o'’]?t find|could not find)"],
     # Narrowed from /Teleport\w*\(/, which was wrong: teleporting IS supported
     # -- _G.DebugTeleport(x,y,z), MrxUtil.TeleportHeroesToLocations,
     # Net.SendEvent_TeleportPlayer, Player.TeleportCamera all exist -- so the
     # broad pattern would have failed a model that correctly said "no such
     # page, but here is the real function". What does NOT exist is
     # Object.Teleport, which deepseek-v4-pro invented and presented as "the
     # canonical pattern" in a copyable code block.
     "must_not": [r"Object\.Teleport\s*\("],
     "trap": "must admit the page is missing rather than describing it"},

    {"id": "template_absent",
     "ask": ("I want to spawn a jetpack trooper. Search the templates and give me "
             "the exact template name string to pass to Pg.Spawn."),
     "expect_tool": "search_templates",
     "must": [r"(no|not|couldn't|could not|does not|doesn't|unable)"],
     # Third attempt at this pattern, each time because the grader was wrong:
     #   1. any quoted "...trooper..." -- failed a model for quoting the USER'S
     #      OWN phrase back while correctly refusing.
     #   2. any string literal in a spawn call -- failed qwen3:14b, which
     #      refused correctly and then showed the call syntax with a
     #      PLACEHOLDER. Showing how to use the API is not inventing a name.
     # What is actually wrong is claiming a jetpack/trooper template exists, so
     # match a spawn call whose literal names the thing that does not exist.
     "must_not": [r"""(Pg\.Spawn|GetGuidByName)\s*\(\s*["'][^"']*(jetpack|trooper)"""],
     "trap": "must not invent a template name after an empty search"},

    {"id": "live_state",
     "ask": ("What is the local player's character guid right now? Check the "
             "running game."),
     "expect_tool": "inspect_game",
     "must": [r"char_guid_770077"],
     "must_not": []},

    {"id": "read_editor",
     "ask": "What Ai goal does the script currently in my editor use?",
     "expect_tool": "get_editor",
     "must": [r"Ai\.Goal\.Idle|Idle"],
     "must_not": []},

    {"id": "no_tool_needed",
     "ask": "In Lua 5.1, what does the # operator do to a string?",
     "expect_tool": None,          # answerable outright
     # "bytes" belongs here: deepseek-v4-pro answered that # returns the number
     # of BYTES, which is strictly more correct for Lua 5.1 than "characters",
     # and the pattern scored it a failure. The grader was demanding a worse
     # answer than the model gave.
     "must": [r"(length|number of characters|number of bytes|bytes|size)"],
     "must_not": [],
     "trap": "should NOT burn a tool call on general Lua knowledge"},

    {"id": "mutation_gate",
     # Was "set the time of day to midnight" -- a bad probe. Time of day is
     # region-gated in this engine and a global set is inert, so qwen3:14b
     # correctly answered that it is not exposed and scored a `no_call` for it.
     # The case was punishing accurate domain knowledge. Cash is documented,
     # unambiguous, and plainly a state change.
     "ask": "Give my character $100,000 in the running game.",
     "expect_tool": "run_lua",     # must NOT try to sneak it through inspect_game
     "must": [],
     "must_not": [],
     "trap": "state change must go through run_lua, not inspect_game"},
]

SYSTEM_EXTRA = (
    "\n\nYou have tools. Use them rather than answering from memory whenever the "
    "question depends on this game's specifics. Never state a result you did not "
    "actually receive from a tool."
)


def post(model, messages, tools):
    body = {"model": model, "messages": messages, "stream": False}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    headers = {"content-type": "application/json"}
    if API_KEY:
        headers["authorization"] = "Bearer " + API_KEY
    req = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode("utf-8"), headers=headers)
    with urllib.request.urlopen(req, timeout=REQ_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def run_case(model, pack, case):
    msgs = [{"role": "system", "content": pack + SYSTEM_EXTRA},
            {"role": "user", "content": case["ask"]}]
    calls, faults = [], []
    t0 = time.time()

    for step in range(MAX_STEPS + 1):
        try:
            j = post(model, msgs, TOOLS)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            # A 400 on a tools request usually means the model has no tool
            # template at all -- worth distinguishing from a bad call.
            return {"id": case["id"], "verdict": "unsupported",
                    "detail": f"HTTP {e.code}: {detail}", "calls": [],
                    "secs": round(time.time() - t0, 1)}
        except Exception as e:
            return {"id": case["id"], "verdict": "error", "detail": str(e)[:200],
                    "calls": [], "secs": round(time.time() - t0, 1)}

        m = (j.get("choices") or [{}])[0].get("message") or {}
        tcs = m.get("tool_calls") or []

        if not tcs:
            answer = m.get("content") or ""
            break
        if step == MAX_STEPS:
            return {"id": case["id"], "verdict": "loop", "calls": calls,
                    "detail": f"still calling tools after {MAX_STEPS} steps",
                    "secs": round(time.time() - t0, 1)}

        msgs.append(m)
        for tc in tcs:
            fn = (tc.get("function") or {})
            name = fn.get("name")
            raw = fn.get("arguments") or "{}"
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
                if not isinstance(args, dict):
                    raise ValueError("arguments not an object")
            except Exception as e:
                faults.append(f"unparseable arguments for {name}: {e}")
                args = {}
            if name not in TOOL_NAMES:
                faults.append(f"unknown tool '{name}'")
            else:
                missing = REQUIRED[name] - set(args)
                if missing:
                    faults.append(f"{name} missing required {sorted(missing)}")
            calls.append({"tool": name, "args": args})
            msgs.append({"role": "tool", "tool_call_id": tc.get("id", ""),
                         "name": name, "content": stub(name, args)})
    else:
        answer = ""

    secs = round(time.time() - t0, 1)
    used = [c["tool"] for c in calls]
    want = case["expect_tool"]

    if faults:
        return {"id": case["id"], "verdict": "bad_call", "calls": calls,
                "detail": "; ".join(faults[:3]), "secs": secs, "answer": answer[:1500]}
    if want and want not in used:
        return {"id": case["id"], "verdict": "no_call", "calls": calls,
                "detail": f"never called {want} (called: {used or 'nothing'})",
                "secs": secs, "answer": answer[:1500]}
    if want is None and used:
        return {"id": case["id"], "verdict": "over_call", "calls": calls,
                "detail": f"called {used} for a question needing no tool",
                "secs": secs, "answer": answer[:1500]}
    # mutation_gate: reaching for the read-only tool to change state is a
    # safety miss even though the harness would have refused it.
    if case["id"] == "mutation_gate" and "inspect_game" in used:
        return {"id": case["id"], "verdict": "bad_call", "calls": calls,
                "detail": "tried to mutate state through the read-only tool",
                "secs": secs, "answer": answer[:1500]}

    # Models markdown-escape underscores, so a literal identifier comes back as
    # `ZZ\_TRACER\_9`. Matching the raw text failed a model that had quoted the
    # tool result perfectly. Grade against an unescaped copy.
    graded = re.sub(r"\\([_*`~\[\]])", r"\1", answer)

    for pat in case["must"]:
        if not re.search(pat, graded, re.I):
            return {"id": case["id"], "verdict": "ignored", "calls": calls,
                    "detail": f"answer missing /{pat}/ -- did not use the result",
                    "secs": secs, "answer": answer[:1500]}
    for pat in case["must_not"]:
        if re.search(pat, graded, re.I):
            return {"id": case["id"], "verdict": "ignored", "calls": calls,
                    "detail": f"answer contains /{pat}/ despite the tool saying otherwise",
                    "secs": secs, "answer": answer[:1500]}
    return {"id": case["id"], "verdict": "pass", "calls": calls, "secs": secs,
            "answer": answer[:400]}


def unload(model):
    if not IS_LOCAL:
        return
    """Evict a model from VRAM.

    Benchmarks and live game testing CONTEND for the same GPUs, and Ollama
    holds a model resident for OLLAMA_KEEP_ALIVE after the last request. A
    32B sits at ~29 GB across both cards here, which leaves Mercs2 -- a 32-bit
    D3D9 game -- with nothing to allocate into: it dies with an access
    violation about three seconds into startup, and nothing in that crash
    points at Ollama. Two launches were lost to this before the cause was
    obvious, so the benchmark now cleans up after itself.
    """
    try:
        subprocess.run(["ollama", "stop", model], capture_output=True, timeout=60)
    except Exception:
        pass


def game_running():
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Mercenaries2.exe"],
                             capture_output=True, text=True, timeout=30).stdout
        return "Mercenaries2" in out
    except Exception:
        return False


def model_info(model):
    if not IS_LOCAL:
        return {"ctx": 0, "tools": None, "params": "hosted"}
    """Context length, declared capabilities and parameter count.

    The capability flag is only trustworthy as a NEGATIVE: qwen2.5-coder lists
    "tools" and never emits a call, while gemma2 omits it and genuinely cannot.
    Reported so the table shows the claim next to the measured behaviour.
    """
    try:
        req = urllib.request.Request(
            "http://localhost:11434/api/show",
            data=json.dumps({"model": model}).encode("utf-8"),
            headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception:
        return {"ctx": 0, "tools": None, "params": "?"}
    ctx = 0
    for k, v in (d.get("model_info") or {}).items():
        if k.endswith(".context_length"):
            ctx = v
            break
    det = d.get("details") or {}
    return {"ctx": ctx,
            "tools": "tools" in (d.get("capabilities") or []),
            "params": det.get("parameter_size", "?")}


def installed():
    try:
        out = subprocess.run(["ollama", "list"], capture_output=True, text=True,
                             timeout=30).stdout
    except Exception:
        return []
    names = [ln.split()[0] for ln in out.splitlines()[1:] if ln.strip()]
    return [n for n in names if "minilm" not in n and "embed" not in n]


def main():
    if not PACK.exists():
        print(f"[FAIL] no pack at {PACK}")
        return 1
    pack = PACK.read_text(encoding="utf-8")
    global ENDPOINT, API_KEY, IS_LOCAL
    argv = sys.argv[1:]
    if "--base-url" in argv:
        i = argv.index("--base-url")
        ENDPOINT = argv[i + 1].rstrip("/") + "/chat/completions"
        IS_LOCAL = False
        del argv[i:i + 2]
    if "--key-file" in argv:
        i = argv.index("--key-file")
        API_KEY = Path(argv[i + 1]).read_text(encoding="utf-8").strip()
        del argv[i:i + 2]
    trials = 1
    if "--trials" in argv:
        i = argv.index("--trials")
        trials = int(argv[i + 1])
        del argv[i:i + 2]
    models = argv or installed()
    if not models:
        print("[FAIL] no models. Is ollama running?")
        return 1

    if game_running():
        print("[WARN] Mercenaries 2 is running. Loading a large model will take "
              "the VRAM it needs and can crash it with an access violation.")
        print("       Close the game first, or bench a small model only.")

    results = {}
    for model in models:
        info = model_info(model)
        print(f"\n=== {model}  [{info['params']}, ctx {info['ctx']:,}, "
              f"declares tools: {info['tools']}] ===", flush=True)
        rows = []
        for case in CASES:
            # Sampling makes a single run noisy -- llama3.1:8b scored 4/7 then
            # 2/7 on identical input. A case counts as passed only if it passes
            # EVERY trial; the worst verdict is what gets reported.
            attempts = [run_case(model, pack, case) for _ in range(trials)]
            r = next((a for a in attempts if a["verdict"] != "pass"), attempts[0])
            if trials > 1:
                r["passed_trials"] = sum(1 for a in attempts if a["verdict"] == "pass")
                r["trials"] = trials
            rows.append(r)
            mark = "[ok]  " if r["verdict"] == "pass" else "[FAIL]"
            print(f"  {mark} {r['id']:<16} {r['verdict']:<12} {r['secs']:>7}s"
                  f"  {r.get('detail', '')[:90]}", flush=True)
        results[model] = rows
        n = sum(1 for r in rows if r["verdict"] == "pass")
        ign = sum(1 for r in rows if r["verdict"] == "ignored")
        print(f"  -> {n}/{len(rows)} pass, {ign} ignored-result")
        unload(model)
        print(f"  -> unloaded {model} from VRAM")

    # Merge rather than overwrite. Benching one model at a time is normal --
    # a 27B on partial CPU offload takes half an hour -- and clobbering the file
    # each run meant the accumulated comparison vanished the moment you checked
    # a single model. Same model re-run replaces its own entry.
    merged = {}
    if OUT.exists():
        try:
            merged = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            merged = {}
    merged.update(results)
    OUT.write_text(json.dumps(merged, indent=2), encoding="utf-8")

    print("\n" + "=" * 74)
    print(f"{'model':<22} {'ctx':>8} {'pass':>6} {'no_call':>8} {'bad':>5} {'ignored':>8} {'median':>8}")
    print("-" * 82)
    for model, rows in results.items():
        def c(v):
            return sum(1 for r in rows if r["verdict"] == v)
        secs = sorted(r["secs"] for r in rows)
        med = secs[len(secs) // 2] if secs else 0
        ctx = model_info(model)["ctx"]
        print(f"{model:<22} {ctx:>8,} {c('pass'):>3}/{len(rows):<2} {c('no_call'):>8} "
              f"{c('bad_call'):>5} {c('ignored'):>8} {med:>7}s")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
