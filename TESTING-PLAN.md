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
