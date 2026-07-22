#!/usr/bin/env bash
# bench-runner.sh -- friendly launcher + live tracker for the Mercs2 Lua IDE model
# benchmarks (Linux / macOS twin of bench-runner.ps1). Wraps the Python harness so
# you can benchmark your own local models without memorising flags or staring at a
# blank screen.
#
#   bash tools/bench-runner.sh
#
# It walks you through: pick a host (Ollama / LM Studio / any OpenAI-compatible
# endpoint), pick which of your models to test, pick the test, then streams live
# results with a running counter so you always know how far along it is.
#
# Needs: Python 3 and curl on PATH. The reasoning test's compile check also uses
# `lupa` (optional: pip install lupa) -- without it that one signal is just skipped.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- colours (only if stdout is a terminal) --------------------------------
if [ -t 1 ]; then
  CY=$'\e[36m'; GN=$'\e[32m'; RD=$'\e[31m'; YL=$'\e[33m'; DIM=$'\e[2m'; Z=$'\e[0m'
else
  CY=; GN=; RD=; YL=; DIM=; Z=
fi
head(){ printf '\n%s%s%s\n%s%s%s\n' "$CY" "$1" "$Z" "$DIM" "$(printf '%*s' "${#1}" '' | tr ' ' '-')" "$Z"; }
warn(){ printf '%s%s%s\n' "$YL" "$1" "$Z"; }
err(){  printf '%s%s%s\n' "$RD" "$1" "$Z"; }
ok(){   printf '%s%s%s\n' "$GN" "$1" "$Z"; }

# --- preflight -------------------------------------------------------------
printf '%s=====================================================%s\n' "$CY" "$Z"
printf '%s  Mercs2 IDE -- local model benchmark runner%s\n' "$CY" "$Z"
printf '%s=====================================================%s\n' "$CY" "$Z"

PY=""
for c in python3 python; do command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }; done
[ -z "$PY" ] && { err "Python 3 was not found on PATH. Install it, then re-run."; exit 1; }
command -v curl >/dev/null 2>&1 || { err "curl was not found on PATH."; exit 1; }
[ -f "$ROOT/tools/bench_tools.py" ] || { err "Run this from inside the repo (tools/bench-runner.sh)."; exit 1; }
printf '%spython: %s%s\n' "$DIM" "$PY" "$Z"

# --- 1. host ---------------------------------------------------------------
head "1. Where are your models hosted?"
echo "  [1] Ollama          (http://localhost:11434)   -- full test suite"
echo "  [2] LM Studio       (http://localhost:1234)    -- start it with:  lms server start --cors"
echo "  [3] Other endpoint  (any OpenAI-compatible /v1 URL)"
read -rp "Choose 1-3 [1]: " host_choice
host_choice="${host_choice:-1}"

hostkind="ollama"; openai_base=""; tags_url=""; keyfile=""
case "$host_choice" in
  2) hostkind="lmstudio"; openai_base="http://localhost:1234/v1"; tags_url="$openai_base/models" ;;
  3) hostkind="custom"
     read -rp "Enter the base URL (e.g. http://localhost:1234/v1 or http://10.0.0.5:8000/v1): " u
     openai_base="${u%/}"; tags_url="$openai_base/models"
     read -rp "API key if the endpoint needs one (blank for local): " k
     if [ -n "$k" ]; then keyfile="$(mktemp)"; printf '%s' "$k" > "$keyfile"; fi ;;
  *) hostkind="ollama"; openai_base="http://localhost:11434/v1"; tags_url="http://localhost:11434/api/tags" ;;
esac

# --- 2. discover models (parse JSON with Python, so no jq dependency) -------
head "2. Finding your models..."
# read into an array without mapfile, so it also works on macOS's stock bash 3.2
models=()
while IFS= read -r _m; do [ -n "$_m" ] && models+=("$_m"); done < <(
  curl -fsS --max-time 10 "$tags_url" 2>/dev/null | "$PY" -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if isinstance(d.get("models"), list):        # Ollama /api/tags
    for m in d["models"]: print(m.get("name",""))
elif isinstance(d.get("data"), list):         # OpenAI /v1/models (LM Studio, custom)
    for m in d["data"]: print(m.get("id",""))
' 2>/dev/null | sort
)

if [ "${#models[@]}" -eq 0 ]; then
  err "Couldn't reach the host at $tags_url"
  [ "$hostkind" = "ollama" ]   && warn "  Is Ollama running?  Try:  ollama serve"
  [ "$hostkind" = "lmstudio" ] && warn "  Is the LM Studio server up WITH CORS?  Try:  lms server start --cors"
  read -rp "Type model names separated by commas (or blank to quit): " manual
  [ -z "$manual" ] && exit 0
  IFS=',' read -ra models <<< "$manual"
  for i in "${!models[@]}"; do models[$i]="$(echo "${models[$i]}" | xargs)"; done
fi

ok "Found ${#models[@]} model(s):"
for i in "${!models[@]}"; do printf "  [%2d] %s\n" $((i+1)) "${models[$i]}"; done

# --- 3. select models ------------------------------------------------------
head "3. Which models to benchmark?"
printf '%s  Enter numbers (e.g. 1,3,5 or 1-4), or "all".%s\n' "$DIM" "$Z"
read -rp "Selection [all]: " sel_raw
sel_raw="${sel_raw:-all}"

parse_sel(){ # $1 raw, $2 count -> prints valid 1-based indices, sorted & unique
  local raw count tok a b; raw="$(echo "$1" | tr ',' ' ')"; count="$2"
  if [ "$(echo "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" = "all" ]; then
    seq 1 "$count"; return
  fi
  for tok in $raw; do
    if [[ "$tok" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"; [ "$a" -le "$b" ] && seq "$a" "$b"
    elif [[ "$tok" =~ ^[0-9]+$ ]]; then echo "$tok"; fi
  done | awk -v c="$count" '$1>=1 && $1<=c' | sort -n | uniq
}

chosen=()
while read -r idx; do chosen+=("${models[$((idx-1))]}"); done < <(parse_sel "$sel_raw" "${#models[@]}")
[ "${#chosen[@]}" -eq 0 ] && { err "No valid models selected."; exit 1; }
ok "Selected: $(IFS=', '; echo "${chosen[*]}")"

# --- 4. select test --------------------------------------------------------
head "4. Which test?"
echo "  [1] Tool use     -- does the model actually CALL its tools? (works on any host)"
if [ "$hostkind" = "ollama" ]; then
  echo "  [2] Reasoning    -- grounded Lua tasks, small-pack budgets B1+B2 (Ollama only)"
  echo "  [3] Both"
fi
read -rp "Choose [1]: " test_choice
test_choice="${test_choice:-1}"
if [ "$hostkind" != "ollama" ] && [ "$test_choice" != "1" ]; then
  warn "Reasoning needs Ollama's native API for context control -- running Tool use instead."
  test_choice="1"
fi

head "5. How deep?"
echo "  [1] Quick    -- 2 trials, small-pack reasoning (B1,B2). Fast sanity check."
echo "  [2] Median   -- 6 trials, small-pack reasoning (B1,B2). Steady numbers (recommended)."
echo "  [3] Full     -- 6 trials + namespace-pack reasoning (B3, the code-writing regime)."
printf '%s  [4] Heavy    -- 2 trials, adds the 71k Ess pack (B4). ~20 min/task, big-context model.%s\n' "$YL" "$Z"
printf '%s  [5] Max      -- 1 trial, ALL tiers up to the full 240k pack (B4-B7).%s\n' "$YL" "$Z"
printf '%s               B3+ auto-skip on models without the context; B7 needs ~256k.%s\n' "$DIM" "$Z"
read -rp "Choose 1-5 [2]: " depth
timeout_s=2400
case "$depth" in
  1) trials=2; budgets="B1,B2" ;;
  3) trials=6; budgets="B1,B2,B3" ;;
  4) trials=2; budgets="B1,B2,B3,B4"; timeout_s=3600 ;;
  5) trials=1; budgets="B1,B2,B3,B4,B5,B6,B7"; timeout_s=10800 ;;
  *) trials=6; budgets="B1,B2" ;;
esac
budget_count=$(echo "$budgets" | tr ',' ' ' | wc -w)

if [ "$depth" = "4" ] || [ "$depth" = "5" ]; then
  echo
  warn "  !!  HEAVY CONTEXT RUN  !!"
  if [ "$depth" = "5" ]; then
    warn "  Max loads packs up to 240,000 tokens. On consumer hardware each task can take"
    warn "  tens of minutes to HOURS -- the KV cache spills to system RAM -- and only runs"
    warn "  at all on a model with matching native context (others skip those tiers). A full"
    warn "  Max run can take many hours, possibly overnight or longer."
  else
    warn "  Heavy loads the 71k Ess pack (B4): roughly 20 minutes per task on a 14B, and only"
    warn "  on a model that can hold ~90k tokens of context (others skip B4)."
  fi
  read -rp "  Type 'yes' to confirm you want this slow run: " confirm
  if [ "$confirm" != "yes" ]; then warn "Cancelled."; [ -n "$keyfile" ] && rm -f "$keyfile"; exit 0; fi
fi

# --- runner with live streaming + running counter --------------------------
run_bench(){ # $1 total, $2.. python args
  local total="$1"; shift
  local errf; errf="$(mktemp)"; local n=0 line col
  cd "$ROOT" || return 1
  while IFS= read -r line; do
    case "$line" in
      *'[ok]'*|*' pass '*|*'pass '*score=1*) col="$GN" ;;
      *'[FAIL]'*|*INVENTED*|*nocompile*|*' wrong '*|*' miss '*) col="$RD" ;;
      '==='*|'-- '*) col="$CY" ;;
      *'->'*|SUMMARY*|*SKIP*|*'!TRUNC'*) col="$YL" ;;
      *) col="" ;;
    esac
    case "$line" in
      *'[ok]'*|*'[FAIL]'*|*score=*)
        n=$((n+1))
        printf '%s[%d/%d]%s %s%s%s\n' "$DIM" "$n" "$total" "$Z" "$col" "$line" "$Z" ;;
      *) printf '%s%s%s\n' "$col" "$line" "$Z" ;;
    esac
  done < <("$PY" -u "$@" 2>"$errf")
  local rc=${PIPESTATUS[0]:-0}
  if [ "$rc" -ne 0 ] && [ -s "$errf" ]; then
    err "The benchmark exited with an error:"; tail -20 "$errf" | sed 's/^/  /'
  fi
  rm -f "$errf"
}

host_args=()
[ "$hostkind" != "ollama" ] && host_args+=(--base-url "$openai_base")
[ -n "$keyfile" ] && host_args+=(--key-file "$keyfile")

head "Ready"
echo "  host   : $hostkind"
echo "  models : $(IFS=', '; echo "${chosen[*]}")"
echo "  trials : $trials"
[ "$test_choice" != "1" ] && echo "  budgets: $budgets"
read -rp "Start? [Y/n]: " go
[[ "$go" =~ ^[nN] ]] && { warn "Cancelled."; [ -n "$keyfile" ] && rm -f "$keyfile"; exit 0; }
warn "Tip: close Mercenaries 2 first -- loading a big model can take the VRAM it needs."

if [ "$test_choice" = "1" ] || [ "$test_choice" = "3" ]; then
  head "Tool-use benchmark"
  run_bench $(( ${#chosen[@]} * 11 )) "$ROOT/tools/bench_tools.py" "${host_args[@]}" --trials "$trials" "${chosen[@]}"
fi
if [ "$test_choice" = "2" ] || [ "$test_choice" = "3" ]; then
  head "Reasoning benchmark (budgets $budgets, $trials trials)"
  csv="$(IFS=,; echo "${chosen[*]}")"
  run_bench $(( ${#chosen[@]} * budget_count * 10 * trials )) "$ROOT/tools/bench_reason.py" --models "$csv" --budgets "$budgets" --trials "$trials" --timeout "$timeout_s"
fi

[ -n "$keyfile" ] && rm -f "$keyfile"

# --- done ------------------------------------------------------------------
head "Done"
ok "Results saved in the repo root:"
[ "$test_choice" != "2" ] && echo "  bench-tools-results.json   (tool use)"
[ "$test_choice" != "1" ] && echo "  bench-reason-results.json  (reasoning)"
echo
printf '%sSee a visual dashboard of the numbers:%s\n' "$DIM" "$Z"
printf '%s  %s tools/bench_viz.py   ->  opens bench-viz.html%s\n' "$DIM" "$PY" "$Z"
if [ "$test_choice" != "1" ]; then
  printf '%sReasoning distribution across trials:%s\n' "$DIM" "$Z"
  printf '%s  %s tools/bench_median.py%s\n' "$DIM" "$PY" "$Z"
fi
echo
ok "The short version: for a local agent, prefer a modern qwen3-generation model."
printf '%s  Details + how to read the results: AI-FORK.md and TESTING-PLAN.md%s\n' "$DIM" "$Z"
