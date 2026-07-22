#Requires -Version 5.1
<#
  bench-runner.ps1 -- friendly launcher + live tracker for the Mercs2 Lua IDE model
  benchmarks. Wraps the Python harness (tools/bench_tools.py, tools/bench_reason.py)
  so you can benchmark your own local models without memorising flags or watching a
  blank screen.

  Just run it:   powershell -ExecutionPolicy Bypass -File tools\bench-runner.ps1

  It walks you through: pick a host (Ollama / LM Studio / any OpenAI-compatible
  endpoint), pick which of your models to test, pick the test, and then streams live
  results with a progress bar so you always know how far along it is.

  Needs: Python 3 on PATH. The reasoning test's compile check also uses `lupa`
  (optional: pip install lupa) -- without it that one signal is just skipped.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent   # tools/ -> repo root

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
function Write-Head($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan; Write-Host ("-" * $t.Length) -ForegroundColor DarkGray }
function Write-Warn($t) { Write-Host $t -ForegroundColor Yellow }
function Write-Err($t)  { Write-Host $t -ForegroundColor Red }
function Write-Ok($t)   { Write-Host $t -ForegroundColor Green }

function Find-Python {
    foreach ($c in @("python", "py", "python3")) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

# Parse a selection like "1,3,5", "1-4", "2 4 6", or "all" into 1-based indices.
function Parse-Selection($raw, $count) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    if ($raw.Trim().ToLower() -eq "all") { return 1..$count }
    $out = New-Object System.Collections.Generic.List[int]
    foreach ($tok in ($raw -split '[,\s]+' | Where-Object { $_ })) {
        if ($tok -match '^(\d+)-(\d+)$') {
            [int]$a = $matches[1]; [int]$b = $matches[2]
            if ($a -le $b) { $a..$b | ForEach-Object { $out.Add($_) } }
        } elseif ($tok -match '^\d+$') {
            $out.Add([int]$tok)
        }
    }
    return ($out | Where-Object { $_ -ge 1 -and $_ -le $count } | Select-Object -Unique)
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------
Clear-Host
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  Mercs2 IDE -- local model benchmark runner" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan

$Py = Find-Python
if (-not $Py) {
    Write-Err "Python 3 was not found on PATH. Install it, then re-run this script."
    return
}
if (-not (Test-Path (Join-Path $Root "tools\bench_tools.py"))) {
    Write-Err "Can't find the benchmark scripts. Run this from inside the repo (tools\bench-runner.ps1)."
    return
}
Write-Host "python: $Py" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. host
# ---------------------------------------------------------------------------
Write-Head "1. Where are your models hosted?"
Write-Host "  [1] Ollama            (http://localhost:11434)   -- full test suite"
Write-Host "  [2] LM Studio         (http://localhost:1234)    -- start it with:  lms server start --cors"
Write-Host "  [3] Other endpoint    (any OpenAI-compatible /v1 URL)"
$hostChoice = Read-Host "Choose 1-3 [1]"
if ([string]::IsNullOrWhiteSpace($hostChoice)) { $hostChoice = "1" }

$hostKind = "ollama"; $openaiBase = ""; $tagsUrl = ""; $keyFile = ""
switch ($hostChoice) {
    "2" {
        $hostKind = "lmstudio"
        $openaiBase = "http://localhost:1234/v1"
        $tagsUrl = "$openaiBase/models"
    }
    "3" {
        $hostKind = "custom"
        $u = Read-Host "Enter the base URL (e.g. http://localhost:1234/v1 or http://10.0.0.5:8000/v1)"
        $openaiBase = $u.TrimEnd("/")
        $tagsUrl = "$openaiBase/models"
        $k = Read-Host "API key if the endpoint needs one (blank for local)"
        if (-not [string]::IsNullOrWhiteSpace($k)) {
            $keyFile = Join-Path $env:TEMP "bench-key.txt"
            Set-Content -Path $keyFile -Value $k.Trim() -Encoding utf8 -NoNewline
        }
    }
    default {
        $hostKind = "ollama"
        $openaiBase = "http://localhost:11434/v1"
        $tagsUrl = "http://localhost:11434/api/tags"
    }
}

# ---------------------------------------------------------------------------
# 2. discover models
# ---------------------------------------------------------------------------
Write-Head "2. Finding your models..."
$models = @()
try {
    $resp = Invoke-RestMethod -Uri $tagsUrl -TimeoutSec 10
    if ($hostKind -eq "ollama") {
        $models = @($resp.models | ForEach-Object { $_.name })
    } else {
        $models = @($resp.data | ForEach-Object { $_.id })
    }
} catch {
    Write-Err "Couldn't reach the host at $tagsUrl"
    if ($hostKind -eq "ollama")   { Write-Warn "  Is Ollama running?  Try:  ollama serve" }
    if ($hostKind -eq "lmstudio") { Write-Warn "  Is the LM Studio server up WITH CORS?  Try:  lms server start --cors" }
    Write-Warn "  You can also type model names in manually below."
    $models = @()
}

if ($models.Count -eq 0) {
    $manual = Read-Host "No models found. Type model names separated by commas (or blank to quit)"
    if ([string]::IsNullOrWhiteSpace($manual)) { return }
    $models = @($manual -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

$models = @($models | Sort-Object)
Write-Ok ("Found {0} model(s):" -f $models.Count)
for ($i = 0; $i -lt $models.Count; $i++) {
    Write-Host ("  [{0,2}] {1}" -f ($i + 1), $models[$i])
}

# ---------------------------------------------------------------------------
# 3. select models
# ---------------------------------------------------------------------------
Write-Head "3. Which models to benchmark?"
Write-Host "  Enter numbers (e.g. 1,3,5 or 1-4), or 'all'." -ForegroundColor DarkGray
$sel = Parse-Selection (Read-Host "Selection [all]") $models.Count
if ($sel.Count -eq 0) { $sel = 1..$models.Count }
$chosen = @($sel | ForEach-Object { $models[$_ - 1] })
Write-Ok ("Selected: {0}" -f ($chosen -join ", "))

# ---------------------------------------------------------------------------
# 4. select test
# ---------------------------------------------------------------------------
Write-Head "4. Which test?"
Write-Host "  [1] Tool use     -- does the model actually CALL its tools? (works on any host)"
if ($hostKind -eq "ollama") {
    Write-Host "  [2] Reasoning    -- grounded Lua tasks, small-pack budgets B1+B2 (Ollama only)"
    Write-Host "  [3] Both"
}
$testChoice = Read-Host "Choose [1]"
if ([string]::IsNullOrWhiteSpace($testChoice)) { $testChoice = "1" }
if ($hostKind -ne "ollama" -and $testChoice -ne "1") {
    Write-Warn "Reasoning needs Ollama's native API for context control -- running Tool use instead."
    $testChoice = "1"
}

Write-Head "5. How deep?"
Write-Host "  [1] Quick    -- 2 trials, small-pack reasoning (B1,B2). Fast sanity check."
Write-Host "  [2] Median   -- 6 trials, small-pack reasoning (B1,B2). Steady numbers (recommended)."
Write-Host "  [3] Full     -- 6 trials + namespace-pack reasoning (B3, the code-writing regime)."
Write-Host "  [4] Heavy    -- 2 trials, adds the 71k Ess pack (B4). ~20 min/task, big-context model." -ForegroundColor Yellow
Write-Host "  [5] Max      -- 1 trial, ALL tiers up to the full 240k pack (B4-B7)." -ForegroundColor Yellow
Write-Host "               B3+ auto-skip on models without the context; B7 needs ~256k." -ForegroundColor DarkGray
$depth = Read-Host "Choose 1-5 [2]"
$timeout = 2400
switch ($depth) {
    "1"     { $trials = 2; $budgets = "B1,B2" }
    "3"     { $trials = 6; $budgets = "B1,B2,B3" }
    "4"     { $trials = 2; $budgets = "B1,B2,B3,B4"; $timeout = 3600 }
    "5"     { $trials = 1; $budgets = "B1,B2,B3,B4,B5,B6,B7"; $timeout = 10800 }
    default { $trials = 6; $budgets = "B1,B2" }
}
$budgetCount = ($budgets -split ",").Count

if ($depth -eq "4" -or $depth -eq "5") {
    Write-Host ""
    Write-Warn "  !!  HEAVY CONTEXT RUN  !!"
    if ($depth -eq "5") {
        Write-Warn "  Max loads packs up to 240,000 tokens. On consumer hardware each task can take"
        Write-Warn "  tens of minutes to HOURS -- the KV cache spills to system RAM -- and only runs"
        Write-Warn "  at all on a model with matching native context (others skip those tiers). A full"
        Write-Warn "  Max run can take many hours, possibly overnight or longer."
    } else {
        Write-Warn "  Heavy loads the 71k Ess pack (B4): roughly 20 minutes per task on a 14B, and only"
        Write-Warn "  on a model that can hold ~90k tokens of context (others skip B4)."
    }
    $confirm = Read-Host "  Type 'yes' to confirm you want this slow run"
    if ($confirm -ne "yes") { Write-Warn "Cancelled."; if ($keyFile) { Remove-Item $keyFile -ErrorAction SilentlyContinue }; return }
}

# ---------------------------------------------------------------------------
# runner with live progress
# ---------------------------------------------------------------------------
function Invoke-Bench {
    param([string[]]$ArgList, [int]$Total, [string]$Activity)
    $done = 0
    $errFile = Join-Path $env:TEMP ("bench-err-{0}.txt" -f $PID)
    Push-Location $Root
    try {
        & $Py -u @ArgList 2>$errFile | ForEach-Object {
            $line = [string]$_
            if     ($line -match '^\s*\[ok\]|\bpass\b.*score=|^\s*\S+\s+t\d+\s+pass') { Write-Host $line -ForegroundColor Green }
            elseif ($line -match '^\s*\[FAIL\]|INVENTED|nocompile|\bwrong\b')          { Write-Host $line -ForegroundColor Red }
            elseif ($line -match '^===|^-- ')                                          { Write-Host $line -ForegroundColor Cyan }
            elseif ($line -match '^\s*->|SUMMARY|SKIP|TRUNC')                          { Write-Host $line -ForegroundColor Yellow }
            else                                                                       { Write-Host $line }

            if ($line -match '\[ok\]|\[FAIL\]|score=') {
                $done++
                if ($Total -gt 0) {
                    $pct = [math]::Min(100, [int]($done * 100 / $Total))
                    Write-Progress -Activity $Activity -Status ("{0} of ~{1} done" -f $done, $Total) -PercentComplete $pct
                }
            }
        }
    } finally {
        Write-Progress -Activity $Activity -Completed
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0 -and (Test-Path $errFile)) {
        Write-Err "The benchmark exited with an error:"
        Get-Content $errFile | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed }
    }
    if (Test-Path $errFile) { Remove-Item $errFile -ErrorAction SilentlyContinue }
}

$commonHost = @()
if ($hostKind -ne "ollama") { $commonHost += @("--base-url", $openaiBase) }
if ($keyFile) { $commonHost += @("--key-file", $keyFile) }

Write-Head "Ready"
Write-Host ("  host    : {0}" -f $hostKind)
Write-Host ("  models  : {0}" -f ($chosen -join ", "))
Write-Host ("  trials  : {0}" -f $trials)
if ($testChoice -ne "1") { Write-Host ("  budgets : {0}" -f $budgets) }
$go = Read-Host "Start? [Y/n]"
if ($go -match '^[nN]') { Write-Warn "Cancelled."; return }
Write-Warn "Tip: close Mercenaries 2 first -- loading a big model can take the VRAM it needs."

if ($testChoice -eq "1" -or $testChoice -eq "3") {
    Write-Head "Tool-use benchmark"
    $a = @("tools\bench_tools.py") + $commonHost + @("--trials", "$trials") + $chosen
    Invoke-Bench -ArgList $a -Total ($chosen.Count * 11) -Activity "Tool-use benchmark"
}
if ($testChoice -eq "2" -or $testChoice -eq "3") {
    Write-Head "Reasoning benchmark (budgets $budgets, $trials trials)"
    $csv = $chosen -join ","
    $a = @("tools\bench_reason.py", "--models", $csv, "--budgets", $budgets, "--trials", "$trials", "--timeout", "$timeout")
    Invoke-Bench -ArgList $a -Total ($chosen.Count * $budgetCount * 10 * $trials) -Activity "Reasoning benchmark"
}

# ---------------------------------------------------------------------------
# done
# ---------------------------------------------------------------------------
Write-Head "Done"
Write-Ok "Results saved in the repo root:"
if ($testChoice -ne "2") { Write-Host "  bench-tools-results.json   (tool use)" }
if ($testChoice -ne "1") { Write-Host "  bench-reason-results.json  (reasoning)" }
Write-Host ""
Write-Host "See a visual dashboard of the numbers:" -ForegroundColor DarkGray
Write-Host "  $Py tools\bench_viz.py   ->  opens bench-viz.html" -ForegroundColor DarkGray
if ($testChoice -ne "1") {
    Write-Host "Reasoning distribution across trials:" -ForegroundColor DarkGray
    Write-Host "  $Py tools\bench_median.py" -ForegroundColor DarkGray
}
Write-Host ""
Write-Ok "The short version: for a local agent, prefer a modern qwen3-generation model."
Write-Host "  Details + how to read the results: AI-FORK.md and TESTING-PLAN.md" -ForegroundColor DarkGray
