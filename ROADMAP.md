# Roadmap — future features

Not started; a menu to pick from. Everything is filtered through the project's one rule: **does this help a
beginner get something happening in the game, faster and with less confusion?** Effort: S (an afternoon),
M (a day or two), L (a week-ish). Nothing here breaks the sacred single-file build.

## Shipped — 2026-07-18

All of former Tier 1, built, smoke-tested, and browser-verified in one session:

- **Template-name autocomplete + browser** — `tools/gen_templates.py` mined `AllInOneSpawnMenu.lua` +
  `CommonSpawnMenu.lua` (plus the wiki's spawn-reference pages for Skins/FX) into `src/data/templates.json`:
  667 confirmed names across Vehicles/Weapons/Skins/FX/Other. Wired into: in-string autocomplete
  (`20_editor.js`), a new sidebar **Templates** tab (`52_templates.js`, click a name to insert it quoted),
  and a linter info-level nudge (`25_lint.js`) on an unrecognized template string passed to
  `Pg.Spawn`/`Ess.Object.spawn`/`Ess.Object.spawnAhead`/`Ess.Easy.Vehicle.summon`.
- **Hover docs** — `hoverTooltip` added to the vendored CodeMirror bundle; reuses the same API-lookup data
  autocomplete already loads (`IDE.api.lookup`, exposed from `50_api.js`).
- **"Grab what I'm aiming at"** — a header button (`60_ui.js`) running the real
  `Ess.Player.targetUnderReticle(0)` + `Ess.Probe.describeSafe` pair, inserting the guid at the caret and
  flashing the description.
- **Watch panel** — a new third output tab (`45_watch.js`): pinned expressions re-poll every 2s while
  connected via the same `IDE.bridge.run` path the REPL uses, each row its own kill switch.
- **Library backup / restore** — `IDE.store.exportAll`/`.importAll` (`15_store.js`) plus two Scripts-panel
  buttons; restore is always additive, never overwrites.
- **Log highlight rules** — built-in tints for `PASS`/`FAIL`/`error`/`[recipe]` plus a small popover
  (`40_console.js`) for user pattern → color rules, persisted in localStorage.
- **Share-link compression** — real `lz-string` (not hand-rolled) now vendored into `src/lib/vendor.js`;
  `#z=` links carry `{name, code}` LZ-string-compressed, `#s=` (the old, name-less, uncompressed form)
  still parses forever as the fallback.

## Tier 2 — worth planning (medium effort, big payoff)

- **Interactive first-script tutorial** (L) — a guided overlay: connect → run `return Ess.VERSION` → toast
  → spawn a car → bind a hotkey loop. Each step advances only when the *real result* comes back from the
  game (the bridge tells us), so completing it means the user has actually done the loop, not read about
  it. The examples gallery provides the material; the missing piece is the step-runner + progress UI.
- **Object inspector** (M) — any guid in Results becomes clickable: drill into a live object
  (name/template/pos/health/faction/labels via `Ess.Probe.describeSafe` + `Ess.Object.*` getters) in a
  collapsible tree, with per-field refresh. Pairs naturally with the watch panel.
- **Deploy as OnKey** (M) — "Export for the game" wraps the current script in the OnKey boilerplate
  (guard / state / action, per the Ess `StarterMod` pattern), names it, and downloads it with a note about
  `lua_loader.ini` binding. Bridges the gap between "ran it once in the IDE" and "it's a real mod now".
- **Runtime-error explainer** (M) — the lint layer catches mistakes *before* the run; this catches them
  *after*: map common runtime errors ("attempt to index a nil value", bad guid patterns) to plain-English
  causes and next steps, shown under the red result line. Grows a case at a time; even 10 mappings cover
  most beginner pain.
- **Persistent run history** (S) — the Results feed survives reload (last ~100 rows, localStorage), with a
  "history" view searchable like the log. Beginners re-find "the thing that worked yesterday".
- **Ess-version drift warning** (S) — on connect, compare `Ess.VERSION` against the version the API data
  was generated from; if they differ, one dismissible line ("reference is from 0.2.1, game runs 0.3.0 —
  some calls may differ"). Kills a whole class of silent confusion.

## Tier 3 — ambitious / speculative

- **Live parameter playground** (L) — port the in-game `Playground.lua` idea into the IDE: pick an
  `Ess.Easy.*` call, get sliders/dropdowns for its parameters, hit run repeatedly. The API data plus
  template data make the UI generatable.
- **Webmap handoff** (M, cross-repo) — "pick a point on the map" opens the webmap in pick-mode; the chosen
  `x,y,z` lands back in the script at the caret. Two local files talking via URL hash + `postMessage` /
  clipboard fallback. Also the reverse: "show this position on the map" from a result row.
- **Script formatter** (M) — a small Lua pretty-printer (indent, spacing) behind a "Tidy up" button.
  Beginners' code drifts into chaos; one button restores readability. No external deps — the luaparse AST
  is already in the bundle.
- **User snippets** (S) — "save selection as snippet", listed alongside the built-in `function`/`loop`
  completions. Cheap once there's UI for naming.
- **Multi-tab editing** (M) — a tab strip above the editor for switching between open scripts without the
  sidebar round-trip, each keeping its own undo history (the per-script `EditorState` already exists —
  this is mostly chrome).
- **Storage upgrade** (M) — move the library to IndexedDB with a localStorage fallback + cross-tab sync via
  `storage` events, lifting the ~5 MB ceiling before anyone hits it. Do it when someone actually ships a
  big library; not before.

## Deliberately not planned

- **Cloud accounts / server-side anything** — the no-server, one-file property is the product.
- **A debugger with breakpoints** — the game's Lua runs on the engine thread; pausing it means freezing the
  game. The watch panel + inspector + explainer cover the need without the trap.
- **Bundling the lua-bridge installer into the page** — distribution of the native mod belongs to its own
  repo/release, not a web page download.
