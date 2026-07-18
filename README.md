# Mercs2 Lua IDE

A live, in-browser Lua / [Ess](https://github.com/loganw234/mercs2-lua-essentials) editor for **Mercenaries 2**
modding, built for **beginners**. Write a script, hit **Run**, and it executes in your **running game** over the
`lua-bridge` — results and the live game log stream straight back to the page. No install, no build step to *use* it.

It's a single self-contained `dist/index.html` (editor, API reference, examples, and the WebSocket client all
inlined), so it works three ways:

- **Hosted** on GitHub Pages — just open the URL (works in Chrome; loopback is treated as trustworthy).
- **Downloaded** — grab `dist/index.html` and open it off disk (`file://`).
- **Served by the bridge** — the WS-capable `lua-bridge` can serve this file at
  `http://127.0.0.1:27050/`, the bulletproof path that dodges every mixed-content / private-network quirk.

## What you need to actually run scripts

1. The **WebSocket-capable `lua-bridge`** mod, with the game running.
2. It listening on `ws://127.0.0.1:27050` (the default).
3. Hit **Connect**. Green dot = live.

You can still write, save, and browse everything with no game attached — only *running* needs the bridge.

## Features

- **Real editor** — CodeMirror 6 (vendored, still zero external requests): Lua highlighting, undo/redo,
  find & replace (`Ctrl/Cmd+F`), bracket matching + auto-close, auto-indent, code folding.
  `Ctrl/Cmd+Enter` runs (the selection if you have one, else the whole file); `Ctrl/Cmd+S` saves.
- **Beginner guardrails** — every script is parsed *before* it's sent. Syntax errors block the run with a
  plain-English explanation (missing `end`, `=` vs `==`, `!=` vs `~=`, unclosed strings…) and jump you to the
  line. Live squiggles as you type, plus: did-you-mean for typo'd `Ess.*` / native / `Loader.*` calls,
  argument-count checks backed by how the game's own scripts call each native, colon-vs-dot fixes,
  `print()` → `Ess.Log` hints, and a hard warning on `while true` loops (they freeze the game).
- **Script library** — named scripts with rename / duplicate / delete, autosave as you type, import/export
  `.lua` files, and a one-click **Backup/Restore** of the whole library as one JSON file (the seatbelt
  against "clear browsing data" — restore always merges, never clobbers). **Share** links are LZ-string
  compressed (~3-4× more script per link) and carry the script's name; they open as a *new* script so they
  never clobber anyone's work, and old uncompressed links still open fine.
- **Examples gallery** — 45 categorized, smoke-tested examples generated straight from the Ess repo's
  `samples/recipes/` (the framework's living documentation), from "Am I connected?" to full missions.
  One click opens any of them as a new script to play with.
- **Two-layer API reference** — the full Ess API (~74 namespaces / 440+ calls, tier-badged Easy / Core / Raw)
  *plus* the engine's own native functions (40 namespaces / ~770 calls, scraped from the decompiled base-game
  scripts, each with a **real call site from the game** and observed argument counts). Most calls carry a
  real, specific description mined from the wiki (not just "here's the namespace") — click any call for
  docs, insert it as a snippet with tab-through argument placeholders, or just **hover** the token in the
  editor for the same doc as a tooltip. The same data powers autocomplete (`Ess.Easy.*` floats to the top).
- **Run & inspect** — a one-line **REPL** under the output (Enter sends, ↑ recalls history; bare
  expressions auto-wrap in `return` so `Ess.VERSION` just works), a hover **↺ re-run** on every past
  result, and returned **tables pretty-print** as `{x=1, y={...}}` (game-side serializer: depth-capped,
  cycle-safe) instead of `table: 0x...`.
- **Watch panel** — pin any expression (`Ess.Player.pose(0)`, `Ess.Loop.isRunning("demo")`) in the Watch
  tab and it re-polls live every couple of seconds while connected — the poor-man's debugger, and a fast
  way to actually see cause and effect instead of guessing at it.
- **🎯 Grab target** — one click while connected runs `Ess.Player.targetUnderReticle` +
  `Ess.Probe.describeSafe` on whatever you're aiming at in-game and drops its guid at the caret — turns
  "how do I even get a guid" from a docs hunt into one click.
- **■ Stop loops** — the "my script went wild" button: stops every `Ess.Loop` and restores the time scale.
- **Results + live log** — ok / runtime error / timeout per run, and the live `Loader.Printf` +
  `Loader.WsSend` telemetry feed with timestamps, a substring filter, smart follow (scroll up to pause
  autoscroll, "↓ latest" to jump back), and highlight rules — built-in tints for `PASS`/`FAIL`/`error`/
  `[recipe]` lines, plus your own pattern → color rules.
- **Comfort** — dark/light/auto theme toggle (bottom right), draggable sidebar + output splits, all persisted.
- **Update check** — the *downloaded* (and bridge-served) copy quietly asks GitHub about once a day whether
  a newer build exists (its git commit is stamped in at build time) and offers the release download in a
  dismissible bar. The hosted Pages copy is always current, so it never checks. Offline? Nothing happens.
- Zero external requests at runtime — one file, fully offline-capable.

## Build

The page is assembled from `src/` by a tiny Python script; every generated input is **committed**, so a plain
`python build.py` (or CI) needs nothing but Python:

```
python build.py           # src/* -> dist/index.html (standalone)
```

Regenerating the data (only when the upstream sources change):

```
python tools/gen_api.py         # src/data/CAPABILITIES.md            -> src/data/ess-api.json
python tools/gen_examples.py    # <ess repo>/samples/recipes + README -> src/data/examples.json
python tools/scrape_natives.py  # <decompiled game lua>/src           -> src/data/natives.json
python tools/gen_templates.py   # <spawn menu scripts + wiki>          -> src/data/templates.json
```

`gen_api.py` and `scrape_natives.py` both also merge in `src/data/call_docs.json` — real, wiki-sourced
per-call descriptions (`{"ess": {path: doc}, "natives": {path: doc}}`) that power the hover tooltip and
the API panel's doc pane beyond the bare signature. It's a committed, hand-curated/mined artifact, not
something either generator derives on its own — re-running either script preserves whatever's in it as
long as the paths still match; it just won't gain new entries unless `call_docs.json` itself is updated.

Regenerating the vendored editor bundle (only when bumping CodeMirror/luaparse/lz-string — needs Node):

```
cd tools/vendor && npm install && npm run build    # -> src/lib/vendor.js (committed)
node smoke.js                                      # headless boot + behavior test of dist/index.html
```

- `src/index.html` — page skeleton (with `/*__CSS__*/`, `/*__API__*/`, `/*__NATIVES__*/`, `/*__EXAMPLES__*/`,
  `/*__TEMPLATES__*/`, `/*__BUILD__*/`, `/*__APP__*/` inject markers).
- `src/styles.css` — all styling (dark/light), including the CodeMirror theme.
- `src/lib/vendor.js` — CodeMirror 6 + luaparse + lz-string, bundled to one IIFE (`window.CM`) by `tools/vendor/`.
- `src/lib/ess-bridge.js` — the vendored WebSocket client (kept in sync with the Ess repo's `tools/`;
  the IDE adds a table serializer to the result wrap — an upstream candidate).
- `src/app/*.js` — the app, one concern per file (`00_state` → `99_main`), merged in order.
- `src/data/` — `CAPABILITIES.md` (copied from the Ess repo), `call_docs.json` (hand-curated per-call
  docs, see above), and the four generated JSONs (`ess-api`/`natives`/`examples`/`templates`).
- `dist/index.html` — the built standalone page (committed, so Pages + downloads need no build).

`.github/workflows/pages.yml` regenerates the API, rebuilds, and deploys `dist/` to GitHub Pages on push.

## Keeping the data current

- **Ess API**: refresh `src/data/CAPABILITIES.md` from the Ess repo, re-run `tools/gen_api.py`.
- **Examples**: re-run `tools/gen_examples.py` (reads the Ess repo's `samples/` directly).
- **Natives**: re-run `tools/scrape_natives.py` against the decompiled game scripts.

Then `python build.py` and commit.
