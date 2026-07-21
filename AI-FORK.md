# AI assistant fork — private test build

A local fork of `mercs2-lua-web-ide` with a provider-agnostic AI assistant panel.
**Not a git repo, no remote, not published.** Merge back by copying the files
listed under "What changed" once it's proven.

Serve it with `python -m http.server 8614 --directory dist`, or just open
`dist/index.html`.

## Design

The assistant talks **straight from the browser to whatever endpoint you
configure**, with your own key. Nothing is proxied through mercs2.tools. That
was chosen for three reasons, in order:

1. A hosted Worker **cannot reach `localhost`**, so proxying would rule out
   local models entirely.
2. The key stays on the user's machine.
3. It costs the project nothing, so there's no spend cap, no rate limiting, no
   Turnstile, and nothing that looks like commercialising the game's IP.

The trade is that **CORS becomes the user's problem** — see Known limits.

## What changed vs upstream

| File | Change |
|---|---|
| `src/app/80_provider.js` | **new** — provider config + OpenAI/Anthropic adapters |
| `src/app/85_ground.js` | **new** — ungrounded-identifier check (see below) |
| `src/app/86_agent.js` | **new** — tool definitions + the agent loop |
| `src/app/82_assist.js` | **new** — the panel, context capture, rendering |
| `src/data/packs/*.txt` | **new** — all five reference-pack tiers, bundled |
| `src/index.html` | Assistant tab + panel markup, `/*__PACK__*/` placeholder |
| `src/styles.css` | `.ai-*` styles appended |
| `src/app/60_ui.js` | tab switcher made generic (see below) |
| `build.py` | inlines every tier as `window.MERCS_PACKS` + `MERCS_PACK_INFO` |

`60_ui.js` previously hid the five known panels by id, so a sixth panel stayed
visible when you switched away from it. It now toggles every `.spanel` against
`"panel" + Capitalised(data-p)`, which every existing panel already satisfied —
so adding a sidebar panel needs no edit there again.

## Context capture

This is the whole point of putting it in the IDE rather than linking to the wiki
chat. Each question can carry:

- **the editor buffer** (capped at 60k chars)
- **the last 40 game-log lines**, from a 120-line ring buffer fed off `IDE.bus`

Both are toggleable in settings. The pack is always sent as the **first** system
message and nothing dynamic precedes it, so it stays a stable prefix and keeps
caching on providers that do prefix caching (DeepSeek's is the reason a 240k
pack costs a tenth of a cent per warm turn).

Answers render markdown, tables and fenced code. Lua blocks get **Insert** and
**Replace** buttons wired to `IDE.editor`.

## Providers

Presets ship for DeepSeek, OpenAI, OpenRouter, Anthropic, Ollama, LM Studio,
llama.cpp and Custom. Only the OpenAI-compatible shape and Anthropic's need
separate code; everything else is a base-URL/model change.

**Only DeepSeek is marked tested** — the others are labelled `(untested)` in the
dropdown deliberately. Removing that label should mean someone actually ran it.

## Pack tiers

**All five tiers are bundled** (Assistant settings → *Bundled tier*). Pick the
largest one your model's context can hold — the pack is sent as a fixed system
prefix, so its tokens are spent every turn and the rest of the window is what's
left for your script, the conversation, and the reply. The dropdown states each
tier's cost and headroom live; the table below is the same data.

| tier | tokens | min context | headroom at min | adds |
|---|---|---|---|---|
| Small | 10.9k | 16k | ~5k | core rules, gotchas, idioms, lua-bridge |
| Small+ | 45.1k | 64k | ~19k | full namespace + game reference |
| Medium | 98.3k | 128k | ~30k | Ess + resident modules |
| Large | 157.5k | 200k | ~43k | spawn templates + contract framework |
| Full | 240k | 256k+ | ~16k | everything (hosted long-context only) |

Headroom = min context − pack tokens: what remains for the editor buffer, chat
history, and the model's answer (default reply cap 4k). Small at exactly 16k is
tight — fine for short questions, 32k is comfortable. The counts come from
`build_pack.py --tiers` in the wiki repo; the files are copied into
`src/data/packs/` and inlined by `build.py`, which owns the per-tier token
counts and guidance in `PACK_TIERS`. Re-copy after regenerating the wiki packs.

Every tier below Full carries a banner naming the sections it lacks and telling
the model to refuse rather than guess. This matters: the `templates` section is
the only thing preventing invented spawn names, and it does not fit below the
Large tier. **A model on a small tier will invent template names** — the banner
is what stops it doing so silently. The grounding check (`85_ground.js`) is the
backstop when it doesn't.

Bundling all tiers put the single-file build at ~4.1 MB. That was a deliberate
trade for offline tier-switching with no fetch; a `packUrl` override still
exists for pointing at an out-of-band pack.

## Verified

Against a mocked streaming provider, in-browser:

- pack sent as system message, first, 56,799 chars, prefix intact
- editor buffer and log tail both reach the request; a real log line survived
- reasoning stream lands in the collapsible pane, auto-collapses on first answer token
- markdown, fenced code with language label, and tables all render
- **Insert** appended to the editor (91 → 152 chars) with the right content
- settings round-trip: preset switch repopulates base URL/model/note, config persists
- no console errors

## Running a big model on system RAM

A 27B on DRAM can take **minutes** before the first token, and with `stream:true`
the provider sends nothing at all until then. Three things make that work rather
than look like a hang:

1. **There is no client-side timeout anywhere in the AI path.** The fetch carries
   only the user's abort signal. Slow is never treated as an error — verified by
   test: a stalled endpoint ticks the counter with no error, then recovers
   cleanly when the token finally arrives.
2. **The status line shows elapsed seconds** and escalates its hint at 25s
   ("normal for a large local model"), 120s ("loading from disk into RAM"), and
   300s (past Ollama's default load timeout).
3. **Errors report how long they took.** "failed after 240s" points at model
   loading; "failed after 0.2s" points at a wrong URL or key.

**Two Ollama settings the OpenAI-compatible endpoint cannot set for you** —
both must be environment variables:

| Variable | Why |
|---|---|
| `OLLAMA_KEEP_ALIVE=60m` | **Verified:** `/v1/chat/completions` silently ignores a per-request `keep_alive`; the native `/api/chat` honours it. Without the env var the model unloads after 5 minutes and the next question pays the full reload. |
| `OLLAMA_LOAD_TIMEOUT` | Default is 5 minutes. A large model loading from disk into RAM can exceed that and Ollama itself aborts. |
| `OLLAMA_CONTEXT_LENGTH` | **Context, not parameter count, is what eats VRAM.** `llama3.1:8b` is a 4.9 GB model and Ollama loaded it at its full 131,072-token context — **23 GB across both GPUs**. The pack is ~11k tokens; 32k is plenty. |

### Local models and the game contend for the same GPUs

`qwen2.5-coder:32b` sits resident at ~29 GB across both cards. With that loaded
there is no VRAM left for Mercenaries 2, and a 32-bit D3D9 game does not fail
gracefully. `tools/bench_tools.py` now unloads each model when it finishes and
warns if the game is running.

Note this was **not** the cause of the launch crashes seen here: the game still
died with `C0000005 @ EIP=00861693`, identically, three times, with VRAM at
1.7 GB. That is a separate pre-existing fault in the game install, unrelated to
any of this. The VRAM contention is real and worth avoiding regardless.

CORS did **not** need `OLLAMA_ORIGINS` in testing (Ollama 0.32, browser at
`localhost:8614`), contrary to what the preset note originally claimed.

## Which local model to run

Measured with `tools/bench_local.py` against the bundled small pack, 12 cases,
2 trials each.

| Model | pass | **invented** | median/answer |
|---|---|---|---|
| **qwen3:14b** | **10/12** | **0** | 21.6s |
| qwen3:8b | 8/12 | **0** | 14.5s |
| qwen2.5-coder:14b | 20/24 | 1 | 10.9s |
| qwen2.5-coder:7b | 20/24 | 3 | 6.1s |
| qwen2.5-coder:1.5b | 5/12* | 3 | 3.4s |
| qwen2.5:0.5b | 3/7* | 1 | 3.5s |

\* earlier single-trial run on the larger pack; both are well below usable.
qwen2.5-coder rows are 2 trials (hence /24), qwen3 rows 1 trial (/12) — the
percentages are directly comparable, the raw counts are not.

**Recommendation: `qwen3:14b`, for everything.** It ties qwen2.5-coder:14b on
pass rate (83%), invents **zero** identifiers where that model invented one, and
scores 7/7 on tool use where qwen2.5-coder scores 0/7. There is no longer a
reason to run two different local models for chat and for agent mode.

This **supersedes the earlier split recommendation** ("llama3.1:8b for agent
mode, qwen2.5-coder:14b for plain chat"). That advice was correct given what had
been measured at the time; qwen3 had not been tested yet. llama3.1:8b in
particular dropped to 1/7 on tools once the graders were fixed and a second
trial was required.

If 14B is too slow, `qwen3:8b` is the fallback — also zero inventions, but 8/12
on Q&A and 4/7 on tools with two `ignored`, so its tool results need checking.
Below that is not worth running for this.

### Context window matters more than parameter count

**gemma2:27b is a worse fit than qwen2.5-coder:7b**, despite being four times
the size, because it reports an **8,192-token context**. The pack does not fit,
and the failure is silent: the model truncates **from the front**, which is
where the system rules and the tier banner live. Verified directly — a canary
token placed at position 0 of the system prompt never came back.

So a model that cannot hold the pack does not warn you. It answers confidently
having been stripped of every instruction telling it not to invent things.

| Tier | Tokens | Needs |
|---|---|---|
| small | 10,930 | **16k minimum** (leaves ~5.4k to converse), 32k comfortable |
| small+ | 45,096 | 64k |
| medium | 98,322 | 128k |
| large | 157,480 | 200k |
| full | 240,032 | 256k+ (DeepSeek V4, Gemini, GPT-5.x) |

There is no 8k tier. One was built and removed: 6k of pack in an 8k window
leaves nothing to hold a conversation in, and shipping a barely-working tier is
worse advice than "you need more context".

The assistant checks this for you on Ollama — it reads the model's real context
length from `/api/show` and warns before you discover it through a bad answer.

## Model benchmark

`python tools/bench_local.py [model ...]` scores installed Ollama models against
the bundled pack on seven cases with machine-checkable criteria. Grading prose by
eye across models is how you fool yourself, so `must` / `must_not` patterns decide
it, and `must_not` is weighted harder — a confidently invented identifier costs a
debugging session, a missing detail costs a follow-up question.

Results land in `bench-results.json`.

## Grounding check (`85_ground.js`) — the main safeguard

Every failure this project has hit is one thing: **an identifier asserted that
the model was never shown.** Five rounds of wiki auditing, the benchmark's
`invented` column, three live agent runs. Prompt rules reduce it. Tools reduce
it. Neither eliminates it — one run read the correct page and still answered
with `Ai.Follow`, which does not exist.

So the check does not ask the model to be careful. It reads the answer, pulls
out every dotted API name, and asks whether that name appears in anything the
model was actually shown.

It deliberately sits **outside** agent mode, because it needs nothing from the
model — no tool support, no instruction-following, no particular provider. That
matters: the best local model for domain knowledge here (`qwen2.5-coder`) cannot
call tools at all, so self-correction is unavailable to precisely the users most
likely to get an invented answer. Warning the user directly is the only
guarantee that does not depend on the model cooperating.

Two passes, because one is not honest on its own:

1. **Against the pack + tool results.** Fast, but weak — the pack is a slice of
   the wiki. Measured: **4 of 14 known-real functions are missing from the small
   tier**, so this alone would fire on roughly a third of *correct* answers. A
   warning that cries wolf gets ignored, which is worse than no warning.
2. **Against the full wiki search index.** Resolves the ambiguity. Names found
   there are real and merely outside the pack — the warning is silently dropped.
   Only names absent from the entire wiki are shown, as *"does not appear
   anywhere in the wiki — treat as invented"*.

Verified: `Ai.Follow` and `Pg.TotallyMadeUp` flagged; `Player.GetLocalPlayer`,
`Vehicle.GetFromRider`, `Object.Attach`, `Player.SetOutfit` all cleared silently
despite being absent from the pack. Zero false alarms on the four that would
otherwise have cried wolf.

Agent mode reuses it as a **self-correction step**: catch the ungrounded name
before the user sees it and give the model one chance, naming the specific
identifiers (a vague "are you sure?" just invites a more confident restatement).

**Known limits.** It proves a name was not in the sources — never that a name is
wrong, and never that a *grounded* answer is right. It only checks dotted names;
bare identifiers are too noisy. Filenames (`mrxfollow.lua`) are excluded by
extension. The method half is matched case-insensitively: an earlier version
required PascalCase and sailed straight past `MrxFollow.follow(...)`, a
fabricated call on a real module — it was checking the half of the API least
likely to be invented.

## Agent mode (tool calling)

Off by default; a checkbox in Assistant settings. When on, `86_agent.js` runs a
loop of up to 6 tool round trips before answering.

| Tool | Gate |
|---|---|
| `search_wiki(query)` | none — keyword search over the whole wiki |
| `read_wiki_page(path)` | none — fetches the live wiki, HTML stripped to text |
| `search_templates(query)` | none — the bundled template list |
| `inspect_game(expr)` | **allowlisted read-only**, auto-runs |
| `run_lua(code, why)` | **explicit user click, every call** |
| `get_editor()` | none |

The `inspect_game` / `run_lua` split is the whole safety design: the model may
look around the running game freely, but anything that could change it stops for
a click that shows the exact Lua first. "Let it explore" must not silently mean
"let it act".

Agent mode does **not** stream (assembling `tool_calls` out of SSE deltas means
stitching partial JSON across frames, and providers disagree on chunking). The
tool list renders live instead, so the panel shows progress and — more usefully —
shows *what was consulted*.

### Search, and why it's not embeddings

`search_wiki` is the tool that makes the rest work. Without it the model has to
*guess* a path for `read_wiki_page`, and a wrong guess just 404s — so it guesses
again, burning the step budget.

I earlier argued classic RAG wasn't worth building here. That still holds, and
this isn't it: **the wiki already serves a search index**, because just-the-docs
generates one. `/assets/js/search-data.json` is 3,485 per-heading entries of
`{title, content, url}`, 4.8 MB, `Access-Control-Allow-Origin: *`. No embeddings,
no vector store, no build step, no extra hosting. Fetched lazily on first search
and cached for the session — too big for page load, unnoticeable once (index
load plus three searches measured at 0.6s).

Two things it needed before it was honest, both found by trying junk queries:

- **A relevance floor.** `"zzqqxx nonsense token"` returned confident-looking
  hits, because *some* section contains "token". A hit list that looks identical
  whether or not it's relevant is the invention failure wearing a disguise — the
  model asks about an API that doesn't exist, gets pages back, and reads that as
  confirmation. Now a majority of query terms must actually appear, and an empty
  result says so in as many words: *an empty result is evidence the thing may
  not exist*. A partial-match list is labelled as partial.
- **Stopword stripping.** Models phrase searches as questions. `"how do I make a
  character invincible"` ranked on *how* and *make*, which appear in thousands
  of sections, and returned unrelated pages. Content words only (unless that
  leaves nothing).

`read_wiki_page` accepts whatever `search_wiki` prints — `.html`, anchors, a
leading slash — so the model never has to reformat one tool's output to feed the
next.

### Measured results

Regenerate with `python tools/bench_chart.py` after any benchmark run — the
section between the markers is rewritten in place from
`bench-tools-results.json`, so it should never drift from the actual numbers.

<!-- BENCH-CHARTS:start -->

### Tool-use pass rate

Seven cases with machine-checked criteria. Higher is better.

```
qwen3:14b          ████████████████████████████  7/7  100%
qwen3.6:27b        ████████████████████████████  7/7  100%
deepseek-v4-flash  ████████████████████          5/7   71%
deepseek-v4-pro    ████████████████████          5/7   71%
qwen3:8b           ████████████████              4/7   57%
cogito:14b         ████████████████              4/7   57%
hermes3:8b         ████████                      2/7   29%
granite3.3:8b      ████                          1/7   14%
llama3.1:8b        ████                          1/7   14%
glm4:9b            ████                          1/7   14%
qwen2.5-coder:14b  ▏                             0/7    0%
mistral-nemo:12b   ▏                             0/7    0%
```

### How they fail

`ignored` is the worst column, not `no_call`: a model that skips the tool is merely no better than one without tools, while a model that calls it and then contradicts the result produces a transcript that *looks* researched. `bad_call` means malformed arguments, which kills the loop.

| model | `bad_call` | `ignored` | `loop` | `no_call` | `over_call` |
|---|---|---|---|---|---|
| `qwen3:14b` | · | · | · | · | · |
| `qwen3.6:27b` | · | · | · | · | · |
| `deepseek-v4-flash` | · | · | ▇▇ 2 | · | · |
| `deepseek-v4-pro` | · | · | ▇▇ 2 | · | · |
| `qwen3:8b` | · | ▇▇ 2 | · | ▇ 1 | · |
| `cogito:14b` | · | ▇▇ 2 | · | ▇ 1 | · |
| `hermes3:8b` | ▇ 1 | ▇▇ 2 | · | ▇▇ 2 | · |
| `granite3.3:8b` | · | · | · | ▇▇▇▇▇▇ 6 | · |
| `llama3.1:8b` | · | ▇▇ 2 | · | ▇▇▇ 3 | ▇ 1 |
| `glm4:9b` | · | · | · | ▇▇▇▇▇▇ 6 | · |
| `qwen2.5-coder:14b` | · | ▇ 1 | · | ▇▇▇▇▇▇ 6 | · |
| `mistral-nemo:12b` | ▇ 1 | ▇▇ 2 | · | ▇▇▇▇ 4 | · |

### Median latency per case

Wall clock for one full case including any tool round trips. Shorter is better, but note the fastest models here are fast because they skip the tool call entirely.

```
hermes3:8b         ▉                                5.0s
granite3.3:8b      ▉                                5.1s
qwen2.5-coder:14b  ▉                                5.2s
deepseek-v4-flash  █                                5.4s
llama3.1:8b        █                                6.2s
glm4:9b            █▎                               7.2s
mistral-nemo:12b   █▎                               7.5s
deepseek-v4-pro    █▍                               8.1s
qwen3:8b           ██▎                             13.2s
qwen3:14b          ███▍                            20.5s
cogito:14b         ███▋                            22.2s
qwen3.6:27b        ████████████████████████████   171.8s
```

<!-- BENCH-CHARTS:end -->

### Which models actually call tools

`python tools/bench_tools.py [model ...]` → `bench-tools-results.json`. Seven
cases, real schemas, stubbed results. The stubs carry values no model could
guess (a tracer token, a deliberately empty search), which is the only way to
tell "read the result" from "would have said that anyway".

**Use `qwen3:14b`.** The only model that scored 7/7, and it did so on three
separate runs. 9.3 GB, 40,960 context — the *smallest* context in the field,
which is rather the point.

**Model generation predicts tool use; size and context do not.** mistral-nemo
advertises a 1,024,000-token context and scored 0/7. granite3.3 and glm4 both
carry 131,072 and scored 1/7 with six straight `no_call`s. Scaling qwen2.5-coder
7B → 14B → 32B changed nothing (0–1/7 throughout, at 7× the latency). Meanwhile
qwen3:14b wins on 40,960. qwen2.5-coder and qwen3 are the same vendor: it is the
*generation*, not the brand.

**`qwen3:8b` is not a cheap substitute** — 4/7 with two `ignored`. The gap
between 8B and 14B *within* qwen3 is wider than the gap between generations at
8B.

**For a large model on system RAM, `qwen3.6:27b` is flawless but slow** — a clean
sweep, zero failures of any kind, at ~175s median and 440s worst case with 28%
CPU offload (3.2 tok/s). Exactly what the no-client-timeout work above exists
for: a long wait, never an error.

That qwen2.5-coder never calls tools is the model, not our prompt — verified by
stripping everything away and asking "what's the weather in Paris?" with a
one-line system prompt and a single `get_weather` tool. 7b and 14b: **zero**
calls. llama3.1:8b: one, correctly.

**Ollama's capability flag is only trustworthy as a negative.** Every model here
lists `tools` under Capabilities, including the ones that never emit a call;
`gemma2:27b` omits it and genuinely can't. So the panel hard-warns on a missing
flag and promises nothing on a present one.

### Against the hosted flagship

Same seven cases, same harness, `--base-url https://api.deepseek.com`.

Both DeepSeek models scored 5/7 and **lost the same two cases the same way** —
`loop`, never converging within six tool round trips. Their chain on
`read_editor` was `get_editor → read_wiki_page → inspect_game ×8`: the first call
returned the script, which was enough to answer, and they kept probing anyway.
Neither ever produced `no_call`, `bad_call` or `ignored`, so the fair reading is
*"uses tools correctly, over-explores"* — a different thing entirely from the
local models that never reach for a tool at all.

Caveat on that: the benchmark's `inspect_game` stub returns a **constant** string
regardless of the query, so a model reasonably expecting new information from a
new query gets the same answer and tries again. Some of that looping is the
harness. In the live IDE those calls return real state.

Once, `deepseek-v4-pro` invented `Object.Teleport(uChar, x, y, z)` and presented
it as "the canonical pattern" in a copyable block. No such function exists —
though teleporting certainly does, via `_G.DebugTeleport(x,y,z)`,
`MrxUtil.TeleportHeroesToLocations`, `Net.SendEvent_TeleportPlayer` and
`Player.TeleportCamera`. **The grounding check caught it**, which is the
strongest validation of that mechanism so far: a paid flagship fabricated an
identifier and a free local check flagged it. It did not reproduce across two
later runs, so treat it as sampling-dependent, not a fixed property.

### A warning about this benchmark's own numbers

Eight grader defects were found and fixed while producing this table, **every one
of them penalising correct behaviour**:

| defect | wrongly failed |
|---|---|
| `does not exist` didn't match `doesn't exist` | a perfect DeepSeek answer |
| ...nor the typographic apostrophe `doesn’t` | any model |
| demanded "characters", rejected "number of bytes" | DeepSeek — the *more* correct Lua 5.1 answer |
| `/Teleport\w*\(/` too broad | any model citing the real `DebugTeleport` |
| markdown-escaped `ZZ\_TRACER\_9` | llama3.1, quoting the tool exactly |
| flagged the user's own phrase quoted back | llama3.1, while correctly refusing |
| flagged `Pg.Spawn("<placeholder>")` usage syntax | qwen3, while correctly refusing |
| `mutation_gate` asked for region-gated time-of-day | qwen3, for knowing it isn't exposed |

Do not trust a red cell without reading the stored answer behind it in
`bench-tools-results.json`. Across this work the ratio of grader bugs to genuine
model failures has been roughly one to one.

### Verified in-browser (llama3.1:8b, live Ollama, live wiki)

- all five tools exercised directly: live wiki fetch returns real page text
  (**CORS is fine**, HTML strips cleanly), a bad path returns the 404 refusal,
  template hit and miss both correct
- `inspect_game` **refused** `Weather.SetTimeOfDay(0)` and pointed at `run_lua`
- **the gate holds**: declining `run_lua` left the code never reaching
  `IDE.bridge.run` — only the approved call and the read-only one were executed.
  `inspect_game` ran without prompting, as intended
- full loop, real model: chose `read_wiki_page("namespaces/ai")` unprompted,
  quoted the page verbatim and accurately, 4.1s, 1 step
- full panel path: tool chip rendered inside the assistant row, cleared its
  pending state, answer rendered through the normal `finish()` renderer
- no console errors

Two grader bugs were found and fixed while producing that table, both of which
had failed a model that was behaving correctly: markdown-escaped underscores
(`ZZ\_TRACER\_9`) not matching the `must` pattern, and a `must_not` that flagged
a model for quoting the user's own phrase back while correctly refusing. The
grader now unescapes before matching and anchors the invention check on a
string literal reaching `Pg.Spawn(` — the actual damage — rather than on words
appearing in prose.

## Live game integration — verified end to end

Confirmed against a running game, character in-world at `3794.0, 450.8, -3911.0`:

| check | result |
|---|---|
| `inspect_game` guid | `userdata: 400057F7` — matches a raw-TCP `lua_repl` read exactly |
| `inspect_game` position | `3794.0, 450.8, -3911.0` — matches exactly |
| `inspect_game` on a mutator | **refused**, redirected to `run_lua` |
| `run_lua` declined | code **never reached** `IDE.bridge.run` |
| full agent loop | llama3.1:8b chose `inspect_game` unprompted, read the real coordinate, answered correctly in 9.4s |

**The bridge WebSocket does not work from the main menu.** This cost a lot of
time before Logan named it: `IDE.bridge.connect` returned `error`/`closed`
repeatedly, and a raw browser `WebSocket` failed with code 1006 (handshake never
completed) — while raw TCP to the same port worked fine, which made it look like
a browser or client bug. It is neither. Once the save is loaded and the world is
up, the identical call connects first try. **Load into the world before
connecting the IDE.**

Also: `Object.GetPosition` returns three values but the bridge surfaces only the
first, so `inspect_game` on it yields the x coordinate alone. Use
`string.format` to pack all three into one string. Relatedly `Loader.Printf`
does **not** do format substitution here — it printed a literal `%s`; wrap with
`string.format` yourself.

### `tools/gamectl.py` — drive the game window by hand

`launch.py`'s blind tap sequence is unreliable and its crash rate is high, so
this drives the window directly:

    python tools/gamectl.py state          # find the window
    python tools/gamectl.py shot out.bmp   # screenshot (PrintWindow, D3D-safe)
    python tools/gamectl.py key space
    python tools/gamectl.py key right

Keys go through `SendInput` with **hardware scan codes** — the game reads
DirectInput-style state and ignores the `WM_KEYDOWN` messages that
`SendKeys`/`PostMessage` generate. Screenshots use `PrintWindow` with
`PW_RENDERFULLCONTENT`; a plain `BitBlt` of a D3D surface comes back black.

Menu path from a cold start: **space** → *continue* → **right** (switch to "No")
→ **space**, then a few minutes of loading.

### Launch stability

The game crashes on startup **nondeterministically** — `C0000005`, usually at
`EIP=00861693`. Observed crashing with the 103 MB patch, a 2.41 MB gfx-only
patch, and **with no `vz-patch.wad` at all**, and succeeding with
`before-rainbow-20260720`. The wad is not the determinant; retrying is currently
the only known remedy. VRAM exhaustion was ruled out (it crashed identically
with 1.7 GB free).

## Known limits

- **CORS is the main failure mode.** A browser rejection surfaces as an opaque
  `TypeError`, so `80_provider.js` catches it and explains the likely cause
  instead. Local servers need it enabled: Ollama `OLLAMA_ORIGINS`, LM Studio has
  a toggle, llama.cpp needs the right `--host` flags.
- **No proxied mode.** Using the hosted Worker from the IDE would need
  `ide.mercs2.tools` added to both the Worker's `ALLOWED_ORIGIN` and the
  Turnstile widget's hostnames. `file://` can never work — Turnstile has no
  hostname to bind to.
- **Screenshots of `dist/index.html` time out** in the browser tool at 1.1 MB.
  JS introspection works fine, which is how the above was verified, but the
  visual pass needs a human.

## Not built yet

- Proxied mode for the hosted IDE.
- Publishing the larger pack tiers so `packUrl` has something to point at.
  They are committed in the wiki repo under `helpbot/pack/`, but that folder is
  excluded from the Jekyll build, so nothing serves them yet.
- Anthropic tool-calling. `IDE.provider.complete()` rejects with an explicit
  message rather than pretending; the local models this targets are all
  OpenAI-shaped.
- The wiki assistant (the hosted chat page) does **not** have the grounding
  check — only this fork does. It is provider-agnostic and would port directly.

## Open questions

- **The PMC rewording is untested.** The pack no longer contains the literal
  fake strings, on the reasoning that a reader copies code and skips prose. But
  the original wording came from an actual A/B against a 7B, and this
  replacement has not been run against one. Re-run `helpbot/eval/smoke-tests.md`
  before trusting it.
- **`OLLAMA_CONTEXT_LENGTH` does not stick** when set at user scope while the
  Ollama tray app is running — it respawns the server without it, so
  `llama3.1:8b` still loads at 131k context / 23 GB. Fully quit Ollama from the
  tray, then restart.
- **The game crashes on launch nondeterministically** and it is not the wad
  (see Launch stability above). Unresolved.
