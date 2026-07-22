# Tool-use testing plan

What is settled, what to keep testing, and how to run the hosted sweep.

## Settled: local models

The local question is answered and does not need re-litigating.

| tier | model | why |
|---|---|---|
| **Default** | `qwen3:14b` | 7/7 on three separate runs. 9.3 GB, 40,960 ctx. |
| **Large / DRAM** | `qwen3.6:27b` | Clean sweep, zero failures. ~175s median at 28% CPU offload. |
| **Floor** | `qwen3:8b` | 4/7. Usable but two `ignored`; do not present as equivalent. |

Everything else tested — llama3.1, mistral-nemo, granite3.3, hermes3, glm4,
cogito, command-r7b, the whole qwen2.5-coder line — scored 0–4/7 and is not
worth carrying forward except as a control.

**Keep the qwen3 family in every future run.** They are the only models with a
demonstrated pass, so they are the regression baseline: if a harness change
drops qwen3:14b below 7/7, suspect the harness before the model. That has
already been the right call eight times out of eight.

## Reasoning + context-budget sweep (Qwen family)

The plan above answers "does the model *call* tools." A second axis — does it
*reason* well, and how does that change with the context budget you can afford — is
measured by `bench_reason.py` (see AI-FORK.md → Benchmark suite). This is where the
Qwen "best fit" question is actually settled.

**Scope.** 0.5B → 35B; generations 2.5 / 3 / 3.6; dense, A3B MoE, and long-context
builds (Qwen2.5-14B-1M, Unsloth Qwen3-14B-128K YaRN). Budgets B1–B7 pair a pack tier
with the `num_ctx` to hold it: B1/B2 = small pack (grounding discipline), B3 = small+
(namespaces — the model writes real code), B4 = Ess pack, and B5–B7 climb to the
medium / large / **full 240k-token** packs as heavy stress tiers.

**Results (settled this session):**
- **Local, 6-trial medians (small pack):** `qwen3:14b` wins (median **8.5–9.0**), then
  Qwen3-14B-128K/YaRN (8.0), `qwen3:8b` (7.0–8.0), `qwen3:30b-a3b` (6.5). Generation ≫
  size held under repeats.
- **The 30B-A3B is a split personality:** the *worst* local on the small pack (it wants
  to write code, not refuse when blind) but the *best* once handed the namespace pack
  (B3: 9/10, 0 inventions, at ~14B speed).
- **DeepSeek-V4-pro (hosted flagship, full B1–B7 ladder):** score climbs **7→9** and
  fabrication crashes **3.7→0.2** as it gets more pack — the cleanest proof the reference
  is the mechanism. Yet it **invents MORE than the local Qwens when blind** (3.7/run on
  the small pack) and its small-pack median (7.0) sits *below* qwen3:14b's (8.5). The
  full picture + the "how much the reference matters" chart live in the `bench_viz`
  dashboard.
- **B4–B7 are stress tiers**, not routine: big packs spill the KV cache to DRAM (~20
  min/task at B4, hours at B7, needs a ≥256k-context model — others auto-skip). Gated by
  `--timeout` and, in the runner scripts, a typed "yes".

**Harness fixes this session (both protect testers, not just this box):**
- **The tool bench wedged big-context models.** A 131k/262k-context model loaded its
  *full* window through the OpenAI endpoint → a ~32 GB KV cache in DRAM. Fixed:
  `bench_tools` now uses Ollama's native `/api/chat` with a per-request `num_ctx` cap
  (32k) — the only thing that overrides a Modelfile-pinned context (`OLLAMA_CONTEXT_LENGTH`
  can't).
- **A grader false-positive** flagged idiomatic uppercase module tables (`local M = {}`
  → `M.foo`) as invented engine calls, which would have penalised *good* code. Fixed to
  exclude locally-defined bases; `--regrade` re-applied it to every stored cell for free.

**What it settled (recommendations):**
- **`qwen3:14b` is the local default** — best median, tight variance, 11/11 tools.
- **The qwen2.5-coder line is dead for agent mode** — 0–1/11 tools at every size,
  answering the OSS-vs-template question below: it's the *weights*, not the serving
  template (declares `tools:true`, never emits a call).
- **A stock 14B can't hold the namespace pack** (40,960 native); the full reference needs
  a long-context build or an A3B MoE. And on the small pack the disciplined local 14B
  *beats the flagship* — so the pack tier you can afford matters as much as model choice.

**For testers running their own models.** `tools/bench-runner.ps1` (Windows) and
`tools/bench-runner.sh` (Linux/macOS) wrap all of the above so nobody has to memorise
flags: a host picker (Ollama / LM Studio / any OpenAI-compatible endpoint), model
multi-select from an auto-discovered list, a depth menu (Quick 2× · Median 6× · Full
+B3 · Heavy +B4 · Max +B5–B7), and live streamed per-case progress so they're never
staring at a blank screen. The Heavy/Max depths reach the stress tiers but require a
typed `yes` first. Needs Python 3 on PATH; `lupa` optional (skips the compile signal).

## Before the hosted sweep: two harness fixes

Do these first or the hosted numbers will repeat known distortions.

1. **Make the `inspect_game` stub non-constant.** It currently returns the same
   `"char_guid_770077"` for every query. Both DeepSeek models `loop`ed partly
   because a fresh query returned a stale-looking answer, so they tried again.
   Return something keyed to the expression so a model can tell its calls apart.
   Until this is fixed, `loop` is not a trustworthy verdict.
2. **Decide whether `mutation_gate` should require execution.** qwen3 answered
   with correct grounded Lua instead of calling `run_lua`. For an IDE assistant
   that is arguably right. Either accept "correct code, no call" as a pass, or
   split it into its own verdict — do not keep scoring it as a plain failure.

## Hosted sweep

Every provider below speaks the OpenAI chat-completions shape, so the existing
harness runs against them unchanged:

```
python tools/bench_tools.py --trials 2 \
  --base-url <url> --key-file <path-outside-the-repo> <model> [model ...]
```

Keep keys out of the repo. `--key-file` exists so a key never appears in shell
history or a tracked file.

| provider | base URL | notes |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | the other flagship baseline |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compat shim; Google's own SDK is a different shape |
| OpenRouter | `https://openrouter.ai/api/v1` | **best value per key** — one key reaches Llama, Mistral, Qwen, GLM, Kimi, DeepSeek and the OSS models |
| Groq | `https://api.groq.com/openai/v1` | very fast; good for latency comparison |
| Mistral | `https://api.mistral.ai/v1` | worth checking directly — `mistral-nemo` scored 0/7 locally, and it is worth knowing whether that is the weights or the local template |
| Together / Fireworks | `https://api.together.xyz/v1`, `https://api.fireworks.ai/inference/v1` | hosted open-weights |
| xAI | `https://api.x.ai/v1` | |

**Start with OpenRouter.** One key covers most of the interesting matrix, which
means one signup rather than seven, and it lets the open-weights models be
compared at the same quantisation the hosts actually serve.

### The OSS models specifically

`gpt-oss:20b` and `gpt-oss:120b` are worth a slot in both columns — they are
open-weight and tool-tuned, so they can be run **locally via Ollama and hosted
via OpenRouter**, which gives a clean read on how much of a model's tool
behaviour is the weights versus the serving template. That comparison is
otherwise impossible, and given qwen2.5-coder's total refusal to emit calls
despite declaring the capability, it is a real question.

### Anthropic — deferred, correctly

Skipped for the initial series. It is the one provider that is not
OpenAI-shaped: different message structure, different tool-call encoding, and a
required opt-in header for browser calls. Two things would need writing:

- `bench_tools.py` — an Anthropic request/response adapter
- `80_provider.js` — `IDE.provider.complete()` currently rejects Anthropic with
  an explicit "not wired yet" message rather than pretending

Worth doing after the sweep, not before. Nothing else is blocked on it.

## Cost

The pack is ~11k tokens and each case is a handful of short turns; two trials
across seven cases is roughly 150–200k input tokens per model. On a
prefix-caching provider most of that is cached after the first case. Expect
cents per model on mid-tier pricing, and single-digit dollars for a broad
OpenRouter sweep including a frontier model or two.

## Reading the results

Two rules, both learned the hard way:

1. **Never trust a red cell without reading the answer behind it.** Eight grader
   defects have been found in this benchmark, every one penalising *correct*
   behaviour — a contraction it didn't match, a more-accurate answer it rejected,
   a placeholder it mistook for an invention. Stored answers live in
   `bench-tools-results.json`.
2. **Two trials minimum.** Single runs swing wildly — llama3.1:8b scored 4/7 and
   then 2/7 on identical input. A case counts as passed only if it passes every
   trial.

The verdict that matters most is `ignored`: a model that skips a tool is merely
no better than one without tools, but a model that calls the tool and then
contradicts the result produces a transcript that *looks* researched. `no_call`
is a capability gap; `ignored` is a trust problem.

## Future: discriminating tests for the top tier

The current `bench_reason` set has a **ceiling problem**. qwen3:8b, qwen3:14b and
qwen3:30b-a3b all land 8–9/10 — the tasks are too easy to separate the models that
matter. A close tie at the top is not "they're equal," it's "the ruler is too
coarse." The next battery needs three things: tasks with *more independent failure
points*, grading that *runs the code* instead of pattern-matching it, and engine
footguns strong models still trip on. Below, each item is written to be turnable
into a `bench_reason` task (prompt + machine-checkable signal).

### The upgrade that matters most: behavioural grading (run it, don't just compile it)

Today a synthesis task passes if it compiles and mentions the right calls. That does
not separate "wrote plausible code" from "wrote *correct* code" — which is exactly
the gap between tied models. `tools/checkpure.py` already proves the pattern: load
the answer's Lua into `lupa`, stub the engine surface, and **assert on behaviour.**
For a spawn task, stub `Pg.Spawn` to *record its arguments* and assert the code
called it N times at the right coordinates. That one change turns coord-ring from a
"has `math.cos`" checkbox into "did you actually place 6 points on a radius-20
circle" — a question the current set can't ask. Applies to any task whose
correctness is a computable fact: counts, coordinates, offsets, ordering, idempotent
state. Keep the stub surface tiny and per-task; anything touching real engine state
stays a compile-only or refuse task.

### Battery 1 — engine-semantics footguns (highest discrimination)

These are facts a model cannot pattern-match its way through; it either knows the
Mercs2 convention or it invents a plausible wrong one. All are real footguns from
the project's own history.

- **Facing / yaw.** "Spawn a crate 10 m directly in *front* of the player, given the
  player's position and yaw." The engine's forward is `(+sin(yaw), +cos(yaw))` — and
  `Object.GetYaw` returns the **chest** bone yaw, not view direction. *Signal:* run
  it, assert the crate lands on the +forward axis (not +x, not mirrored). This
  single sign error shipped in Ess for weeks; it will split the field.
- **West-positive X.** "Move an object 5 m west." Game X is **west-positive**, so
  west is `+x`. *Signal:* assert the delta sign. Most models will guess east.
- **Region-gated atmosphere.** "Make it start raining." Global `Atmosphere.SetSky` /
  `SetTime` are **inert** outside a named `rgn_atmo` region (Begin/End SetValue).
  *Signal:* pass requires either the region mechanism or an honest "this needs a
  weather region" — a bare `SetSky` call is the *wrong* answer that looks right.
- **`Ess.Probe.nearby` self-inclusion.** "Find enemies near the player and damage
  them." Raw `Pg.FastCollect*` includes the player; forgetting to exclude
  `Ess.Player.character(0/1)` caused a real player-kill. *Signal:* the answer must
  exclude the player (or use `Ess.Probe.nearby`, which now does).
- **Vehicle-occupancy inversion.** Give code that treats
  `Vehicle.GetFromRider(char) == nil` as "on foot." The semantics are inverted — a
  **nil guid means "entered."** *Signal:* debug task; must identify the inversion.
- **Local-not-networked spawns.** "In co-op, spawn a boss every player can see and
  fight." Spawns are **local per machine**; host logic must be gated on
  `Net.IsMultiplayer() and Net.IsClient()` and the spawn replicated deliberately.
  *Signal:* pass requires the Net gate; a naive `Pg.Spawn` in a shared handler is the
  trap.

### Battery 2 — compounding-constraint synthesis (many failure points)

One wrong link fails the chain, so scores spread instead of saturating.

- **Squad → faction → vehicle → waypoint.** "Spawn three soldiers allied to the
  player, load them into a nearby vehicle, and order the vehicle to coordinates
  (100, 5, −200)." Real spawn template + correct ally handling + vehicle entry +
  `Ai.Goal` with the `Location=` key (not `Position=`) + coord. *Signal:* compile +
  each link present + no invention.
- **Crewed heli deliver.** "Fly a helicopter with an AI pilot to a set of
  coordinates and have it hold there." Needs a **crewed** vehicle (the `(Full)`
  template variant), `Ai.Deliver` for heli nav, and a hold. *Signal:* correct
  template variant + `Ai.Deliver` + no hand-rolled waypoint math a heli ignores.
- **Placement geometry, behaviourally graded.** Ring (have it), then **grid**,
  **spiral**, and **evenly along the segment between two points** — each snapped to
  ground height. *Signal:* run with a stubbed `Pg.Spawn`, assert the actual point
  set (count, spacing, radius/pitch). This is the cleanest tie-breaker in the set.

### Battery 3 — subtle-logic debugging (wrong behaviour, not wrong function)

The current debug tasks are wrong-*function* (Debug.Printf, `+=`). Harder: code that
uses the right calls and still misbehaves.

- **Timer double-arm leak.** A callback that re-arms *and* re-registers a second
  timer each fire, stacking exponentially. Must spot the leak, not just "it repeats."
- **Same-coord spawn loop.** A `for` loop that spawns N units but reuses the loop-
  invariant base coordinate, stacking them on one spot. Must spot the missing
  per-iteration offset.
- **Un-looped HUD.** A HUD value set once at script load and never re-polled, so it
  never updates. Must identify that it needs a timer/loop, not a one-shot set.

### Battery 4 — API discrimination & Ess tier judgment

- **Role vs Goal, combined.** "Patrol a route *and* engage enemies on sight" — the
  answer must combine `Ai.Role` (posture) with the patrol goal, not pick one.
- **Tier judgment.** "The beginner-friendly one-liner to summon a vehicle ahead of
  the player." Correct is `Ess.Easy.Vehicle.summon`; a raw `Pg.Spawn` + transform
  math is *technically* right but the wrong tier for the ask. Grades judgment, which
  is where a stronger model should pull ahead.
- **Bone-keyed position.** "Get the world position of the player's right hand."
  `Object.GetHardpointPosition` (hash-keyed bone), not `Object.GetPosition` (origin).
  *Signal:* distinguishes recall depth.

### Battery 5 — refactor / judgment (given code, improve it)

- Rewrite a raw-`Pg.*` script using `Ess.Easy` for a beginner (tests they know the
  friendlier surface exists).
- Add `pcall` guards around the fallible calls in a given script (the primer rule),
  without wrapping the infallible ones.
- Convert `print()` debugging to `Loader.Printf` / `Ess.Log`.

### Grading refinements for a close finish

- **Behavioural assertion** (Battery-1/2 above) is the primary new discriminator.
- **Finer partial credit.** More independent checkpoints per task → scores spread
  across [0,1] instead of clumping at pass/fail.
- **Median across ≥6 trials as the tiebreaker**, plus per-task *reliability* (does it
  pass a hard task 6/6 or 4/6?) — `bench_median.py` already reports this; a model
  that passes the footgun tasks *consistently* beats one that gets them half the time.
- **Efficiency as a secondary axis.** At equal correctness, tokens-to-answer and
  latency separate the 8B from the 30B — worth surfacing for the "best fit on *my*
  hardware" question.
- **Grounding-stress count.** Seed a few tasks whose naive answer uses a plausible
  fake (`Object.SetFaction`, `Ai.Follow`); the tiebreak metric is simply who resists.
