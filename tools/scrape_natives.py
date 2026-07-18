#!/usr/bin/env python3
"""scrape_natives.py -- mine the DECOMPILED base-game Lua for the engine's native API surface.

The decompiled scripts (resident/ shell/ vz/) *use* the engine's C-registered functions but never define
them -- so:  every function CALLED anywhere in the corpus, minus every function DEFINED anywhere in the
corpus, minus the Lua 5.0 stdlib  =  the native API the game exposes to scripts. Per native we also record
how often it's called, the min/max argument counts actually seen (arity hints for the IDE's linter), and
one short real call site (for docs/examples).

Usage:  python tools/scrape_natives.py [path-to-decompiled-src]
Writes: src/data/natives.json
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "natives.json"
DEFAULT_SRC = r"C:\Users\logan\Desktop\Mercs2_Decompiled_Lua\docs\mercs2-luacd\src"
CALL_DOCS = ROOT / "src" / "data" / "call_docs.json"   # {"ess": {...}, "natives": {path: doc}} -- wiki-sourced, merged in below

# Lua 5.0-era stdlib -- known, not "native to the engine" (the game shipped Lua 5.0: string.gfind etc.)
LUA_STD = {
    "assert", "collectgarbage", "dofile", "error", "gcinfo", "getfenv", "getmetatable", "ipairs",
    "loadfile", "loadlib", "loadstring", "next", "pairs", "pcall", "print", "rawequal", "rawget",
    "rawset", "require", "select", "setfenv", "setmetatable", "tonumber", "tostring", "type",
    "unpack", "xpcall", "_G", "_VERSION",
    "string", "table", "math", "io", "os", "coroutine", "debug",
}

DEF_RES = [
    re.compile(r"^\s*function\s+([A-Za-z_]\w*)\s*\("),                       # function Foo(
    re.compile(r"^\s*function\s+([A-Za-z_]\w*)[.:]([A-Za-z_]\w*)\s*\("),     # function Ns.f( / Ns:f(
    re.compile(r"^\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*function\b"),         # Foo = function
    re.compile(r"^\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*function\b"),      # Ns.f = function
    re.compile(r"^\s*([A-Za-z_]\w*)\s*=\s*(?:\{|inherit\b)"),                # Foo = { / Foo = inherit(
    re.compile(r"^\s*local\s+([A-Za-z_]\w*)\b"),                             # local Foo
]
CALL_RE = re.compile(r"\b([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(")


def strip_comments(text):
    """Coarse: drop --[[ ]] blocks and -- line tails (good enough for machine-decompiled output)."""
    text = re.sub(r"--\[(=*)\[.*?\]\1\]", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def count_args(text, open_idx):
    """From the '(' at open_idx, walk to the matching ')' (string-aware), count top-level commas.
    Returns (argc, span_text) or (None, None) if unbalanced/huge."""
    depth, i, n = 0, open_idx, len(text)
    commas, content_start = 0, open_idx + 1
    has_content = False
    while i < n and i - open_idx < 4000:
        c = text[i]
        if c in "\"'":
            q = c
            i += 1
            while i < n and text[i] != q:
                if text[i] == "\\":
                    i += 1
                i += 1
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                argc = 0 if not has_content else commas + 1
                return argc, text[open_idx:i + 1]
        elif depth == 1:
            if c == ",":
                commas += 1
            elif not c.isspace():
                has_content = True
        i += 1
    return None, None


def main():
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC)
    files = sorted(src.rglob("*.lua"))
    if not files:
        print("[scrape] no .lua files under %s" % src)
        return 1

    defined = set()          # names & Ns.name defined ANYWHERE in the game's own scripts
    calls = {}               # "Ns.f" or "f" -> {n, min, max, example}

    texts = {}
    for p in files:
        try:
            texts[p] = strip_comments(p.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue

    # each game script runs as its own class environment: a bare `function Foo()` in mrxguibase.lua IS
    # MrxGuiBase.Foo. Map lowercase file basenames -> the namespace casings actually used in calls.
    base_by_lower = {}
    for p, text in texts.items():
        for m in CALL_RE.finditer(text):
            if m.group(2):
                base_by_lower.setdefault(m.group(1).lower(), m.group(1))

    for p, text in texts.items():
        file_cls = base_by_lower.get(p.stem.lower())
        for line in text.splitlines():
            for rx in DEF_RES:
                m = rx.match(line)
                if not m:
                    continue
                g = m.groups()
                bare = len(g) == 1 or not g[1]
                defined.add(g[0] if bare else g[0] + "." + g[1])
                if bare and file_cls:
                    defined.add(file_cls + "." + g[0])   # class-environment member
                    defined.add(file_cls)
                if not bare:
                    defined.add(g[0])     # defining Ns.f also marks Ns itself as script-side

    for p, text in texts.items():
        for m in CALL_RE.finditer(text):
            base, member = m.group(1), m.group(2)
            name = base + "." + member if member else base
            open_idx = text.index("(", m.end() - 1)
            argc, span = count_args(text, open_idx)
            e = calls.setdefault(name, {"n": 0, "min": None, "max": None, "example": None})
            e["n"] += 1
            if argc is not None:
                e["min"] = argc if e["min"] is None else min(e["min"], argc)
                e["max"] = argc if e["max"] is None else max(e["max"], argc)
                ex = name + span
                ex = re.sub(r"\s+", " ", ex)
                if len(ex) <= 90 and (e["example"] is None or len(ex) < len(e["example"])):
                    e["example"] = ex

    # instance variables, not namespaces: Hungarian prefixes (oFoo/tFoo/uFoo/mFoo...) and lowercase names
    JUNK = re.compile(r"^_?[a-z]|^_?[otumsbinf][A-Z]")

    # native = called but never defined by the scripts, and not the Lua stdlib
    natives = {}
    script_ns = set()
    for name, e in calls.items():
        base = name.split(".")[0]
        if base in LUA_STD:
            continue
        if "." in name and JUNK.match(base):
            continue
        if name in defined or base in defined:
            if "." in name:
                script_ns.add(base)
            continue
        if "." not in name and JUNK.match(name):
            continue
        natives[name] = e

    # per-call docs: real, wiki-sourced descriptions keyed by "Ns.fn", merged in (never derived from the
    # decompiled corpus itself) so a hover tooltip / API-panel click shows more than a call-site example.
    call_docs = {}
    if CALL_DOCS.exists():
        try:
            call_docs = json.loads(CALL_DOCS.read_text(encoding="utf-8")).get("natives", {})
        except Exception:
            call_docs = {}
    doc_hits = 0
    for name, e in natives.items():
        if name in call_docs:
            e["doc"] = call_docs[name]
            doc_hits += 1

    # group dotted natives by namespace; bare natives under ""
    grouped = {}
    for name, e in sorted(natives.items()):
        ns, _, fn = name.rpartition(".")
        grouped.setdefault(ns, {})[fn] = e

    # a namespace with SOME defined members is a script class the def-scan half-caught -- reclassify
    for ns in [n for n in grouped if n and n in script_ns]:
        del grouped[ns]
    # bare-name calls resolve through the game's class-environment inheritance (AddChild in a MrxGui
    # subclass etc.) -- statically unknowable, so they are NOT part of the emitted API data.
    grouped.pop("", None)

    data = {
        "source": str(src),
        "files": len(files),
        # engine C-registered API, as OBSERVED USAGE (not the full surface): per call, how many times the
        # game's own scripts call it, the min/max arg counts seen, and one short real call site.
        "natives": grouped,
    }
    OUT.write_text(json.dumps(data, indent=1), encoding="utf-8")

    n_dotted = sum(len(v) for v in grouped.values())
    print("[scrape] %d files -> %s (%d KB)" % (len(files), OUT, OUT.stat().st_size // 1024))
    print("[scrape] %d dotted natives in %d namespaces, %d with a real per-call doc" % (n_dotted, len(grouped), doc_hits))
    for ns in sorted(grouped):
        if ns:
            print("   %-24s %d" % (ns, len(grouped[ns])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
