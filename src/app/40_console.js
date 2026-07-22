/* 40_console.js -- the two output feeds. Results rows carry a hover re-run button (the full code is kept
   on the row, not the truncated preview). Log lines get a dim HH:MM:SS stamp and a substring filter.
   Autoscroll is "smart follow": scrolling up pauses it and shows a "↓ latest" chip; scrolling back to the
   bottom (or clicking the chip) resumes. Result shapes come from ess-bridge.run(): {ok, value, timedOut,
   error} -- successful values arrive pre-serialized by the bridge wrap (tables print as {a=1, ...}). */
(function () {
  var IDE = window.IDE, results = IDE.$("results"), log = IDE.$("log"), latest = IDE.$("latest"), pendingRow = null;

  /* ---- smart follow ---- */
  var follow = { results: true, log: true };
  function feedOf(which) { return which === "log" ? log : results; }
  function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 24; }
  function auto(el) {
    var which = el === log ? "log" : "results";
    if (follow[which]) { el.scrollTop = el.scrollHeight; latest.classList.add("hidden"); }
    else if (!el.classList.contains("hidden")) latest.classList.remove("hidden");
  }
  [results, log].forEach(function (el) {
    el.addEventListener("scroll", function () {
      var which = el === log ? "log" : "results";
      follow[which] = nearBottom(el);
      if (follow[which]) latest.classList.add("hidden");
    });
  });
  latest.onclick = function () {
    var el = document.querySelector(".feed:not(.hidden)");
    var which = el === log ? "log" : "results";
    follow[which] = true;
    el.scrollTop = el.scrollHeight;
    latest.classList.add("hidden");
  };

  /* ---- results, persisted (last 100 survive a reload -- "the thing that worked yesterday") ---- */
  var HISTKEY = "m2ide.history.v1", MAXHIST = 100, pendingCode = null;
  var hist = [];
  try { hist = JSON.parse(localStorage.getItem(HISTKEY)) || []; } catch (e) {}
  function persistHist() { try { localStorage.setItem(HISTKEY, JSON.stringify(hist.slice(-MAXHIST))); } catch (e) {} }
  /* ---- runtime-error explainer: the lint layer (25_lint.js) catches mistakes BEFORE the run; this
     catches the common ones AFTER, once the game's own Lua error comes back. A small, hand-grown list --
     not an attempt to cover every possible Lua error, just the handful that account for most beginner
     "why did this fail" moments. Shown as a second line under the red result, never blocks anything. */
  var RUNTIME_EXPLAIN = [
    { test: /attempt to index a nil value \(global '([^']+)'\)/,
      explain: function (m) { return "\"" + m[1] + "\" is nil — that global was never set, or whatever sets it didn't run first. Check the spelling."; } },
    { test: /attempt to index a nil value \(local '([^']+)'\)/,
      explain: function (m) { return "\"" + m[1] + "\" is nil where you tried to use it — likely a spawn/lookup that returned nil (a bad template name, a guid that doesn't exist) and the result got used without checking for nil first."; } },
    { test: /attempt to index a nil value \(upvalue '([^']+)'\)/,
      explain: function (m) { return "\"" + m[1] + "\" (captured from an outer scope) is nil — check where it's set before this part runs."; } },
    { test: /attempt to index a nil value \(field '([^']+)'\)/,
      explain: function (m) { return "There's no \"" + m[1] + "\" field on that table — check the spelling, or that the table is actually what you think it is."; } },
    { test: /attempt to call a nil value \(global '([^']+)'\)/,
      explain: function (m) { return "\"" + m[1] + "\" isn't a real function — Ess.*/native calls are case-sensitive, double check the exact spelling in the sidebar (or hover it)."; } },
    { test: /attempt to call a nil value \(method '([^']+)'\)/,
      explain: function (m) { return "There's no method \"" + m[1] + "\" on that value — likely a typo, or a : where a . belongs (or the reverse)."; } },
    { test: /attempt to call a nil value \(field '([^']+)'\)/,
      explain: function (m) { return "\"" + m[1] + "\" isn't a real function on that table — check the spelling in the sidebar."; } },
    { test: /attempt to perform arithmetic on a nil value/,
      explain: function () { return "One side of a math operation (+ - * /) is nil — probably a variable that was never set, or a lookup that came back empty."; } },
    { test: /attempt to concatenate a nil value/,
      explain: function () { return "Trying to join text (..) with something that's nil — wrap it in tostring(...) first, or find out why it's nil."; } },
    { test: /attempt to compare (?:nil with|.* with nil)/,
      explain: function () { return "Comparing a nil value against something else — probably a variable that was never set."; } },
    { test: /bad argument #(\d+) to '([^']+)'/,
      explain: function (m) { return "Argument #" + m[1] + " to " + m[2] + " is the wrong type — check what you're passing (e.g. a number where a guid/string was expected, or the reverse)."; } }
  ];
  function explainRuntime(msg) {
    for (var i = 0; i < RUNTIME_EXPLAIN.length; i++) {
      var m = RUNTIME_EXPLAIN[i].test.exec(msg);
      if (m) return RUNTIME_EXPLAIN[i].explain(m);
    }
    return null;
  }

  function classify(o) {
    if (o.error) return { cls: "err", text: o.error };
    if (o.timedOut) return { cls: "warn", text: "no result within timeout (chunk likely still ran)" };
    if (o.ok === false) return { cls: "err", text: "runtime error: " + o.value, explain: explainRuntime(String(o.value)) };
    return { cls: "ok", text: (o.value === "" || o.value == null) ? "(no return value)" : o.value };
  }
  function renderExplain(row, explain) {
    var old = row.querySelector(".explain"); if (old) old.remove();
    if (!explain) return;
    var ex = document.createElement("div"); ex.className = "explain"; ex.textContent = "» " + explain;
    row.appendChild(ex);
  }
  /* a "🔍 inspect" button on any simple (non-table, non-empty) ok result -- re-evaluates that value as a
     guid in the Inspect sidebar tab (46_inspector.js). Not shown for table literals (a guid is never
     displayed as "{...}") or an empty/error result -- nothing sensible to inspect there. */
  function inspectable(outcome) {
    return outcome && outcome.cls === "ok" && outcome.text && outcome.text !== "(no return value)" &&
      outcome.text.charAt(0) !== "{";
  }
  function renderInspectBtn(row, r, outcome) {
    var old = row.querySelector(".inspect"); if (old) old.remove();
    if (!inspectable(outcome)) return;
    var ins = document.createElement("button"); ins.className = "inspect"; ins.textContent = "🔍"; ins.title = "Inspect this as a live object";
    ins.onclick = function () { IDE.inspector.inspect(outcome.text); };
    row.insertBefore(ins, r);
  }
  /* an "ask AI" button on every failed row -- the moment someone would give up
     and go ask a human is exactly when one click should hand the error, the
     code and the log to the assistant instead. Occupies the slot the inspect
     button uses on ok rows, so they never collide. IDE.assist is checked at
     CLICK time, not render time: restored history renders before 82_assist.js
     has loaded. */
  function renderAskBtn(row, outcome) {
    var old = row.querySelector(".askai"); if (old) old.remove();
    if (!outcome || outcome.cls !== "err") return;
    var b = document.createElement("button"); b.className = "askai"; b.textContent = "✨"; b.title = "Ask the AI assistant about this error";
    b.onclick = function () {
      if (!IDE.assist) return;
      IDE.assist.ask("This run failed.\n\nCode:\n```lua\n" + (row.dataset.code || "") +
        "\n```\nError: " + outcome.text +
        "\n\nExplain what went wrong and give me a corrected version.");
    };
    row.insertBefore(b, row.querySelector(".res"));
  }
  function makeRow(codeText, outcome) {
    var row = document.createElement("div"); row.className = "row";
    row.dataset.code = codeText;
    var c = document.createElement("span"); c.className = "code";
    c.textContent = codeText.length > 220 ? codeText.slice(0, 220) + "…" : codeText;
    var rr = document.createElement("button"); rr.className = "rerun"; rr.textContent = "↺"; rr.title = "Run this again";
    rr.onclick = function () { IDE.runCode(row.dataset.code); };
    var r = document.createElement("span");
    if (outcome) { r.className = "res " + outcome.cls; r.textContent = outcome.text; }
    else { r.className = "res dim"; r.textContent = "running…"; }
    row.appendChild(c); row.appendChild(rr); row.appendChild(r);
    if (outcome) { renderInspectBtn(row, r, outcome); renderAskBtn(row, outcome); renderExplain(row, outcome.explain); }
    return row;
  }
  function trimResultsDom() { while (results.childElementCount > 200) results.removeChild(results.firstChild); }
  function pending(codeText) {
    var row = makeRow(codeText);
    results.appendChild(row);
    trimResultsDom();
    pendingRow = row.querySelector(".res");
    pendingCode = codeText;
    applyFilterTo(row);
    auto(results);
  }
  function result(o) {
    var r = pendingRow; pendingRow = null; if (!r) return;
    var outcome = classify(o);
    r.className = "res " + outcome.cls; r.textContent = outcome.text;
    renderInspectBtn(r.parentElement, r, outcome);
    renderAskBtn(r.parentElement, outcome);
    renderExplain(r.parentElement, outcome.explain);
    hist.push({ code: pendingCode, cls: outcome.cls, text: outcome.text, explain: outcome.explain, t: Date.now() });
    persistHist();
    applyFilterTo(r.parentElement);
    auto(results);
  }
  function restoreHistory() {
    hist.forEach(function (h) { results.appendChild(makeRow(h.code, { cls: h.cls, text: h.text, explain: h.explain })); });
    trimResultsDom();
  }
  restoreHistory();

  /* ---- highlight rules: built-in tints for PASS/FAIL/error/[recipe], plus a couple of user-defined
     pattern -> color rules (localStorage, first match wins, user rules checked before the built-ins so
     a user rule can override one if they want a different color). Pattern is plain text, or /regex/flags. */
  var HLKEY = "m2ide.hlrules.v1";
  var userRules = [];
  try { userRules = JSON.parse(localStorage.getItem(HLKEY)) || []; } catch (e) {}
  function persistRules() { try { localStorage.setItem(HLKEY, JSON.stringify(userRules)); } catch (e) {} }
  var BUILTIN = [
    { test: /\bFAIL\b/, cls: "hl-fail" },
    { test: /\berror\b/i, cls: "hl-error" },
    { test: /\bPASS\b/, cls: "hl-pass" },
    { test: /\[recipe\]/, cls: "hl-recipe" }
  ];
  function userRegex(pattern) {
    var m = /^\/(.*)\/([a-z]*)$/.exec(pattern || "");
    try { return m ? new RegExp(m[1], m[2]) : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
    catch (e) { return null; }
  }
  function highlightLine(el, line) {
    for (var i = 0; i < userRules.length; i++) {
      var re = userRegex(userRules[i].pattern);
      if (re && re.test(line)) { el.style.color = userRules[i].color; return; }
    }
    for (var j = 0; j < BUILTIN.length; j++) {
      if (BUILTIN[j].test.test(line)) { el.classList.add(BUILTIN[j].cls); return; }
    }
  }
  function renderRules() {
    var wrap = IDE.$("hlList");
    wrap.innerHTML = "";
    if (!userRules.length) {
      var e = document.createElement("div"); e.className = "hlempty"; e.textContent = "no custom rules yet";
      wrap.appendChild(e);
    }
    userRules.forEach(function (r, i) {
      var row = document.createElement("div"); row.className = "hlrulerow";
      var sw = document.createElement("span"); sw.className = "hlswatch"; sw.style.background = r.color;
      var pat = document.createElement("span"); pat.className = "hlpat"; pat.textContent = r.pattern; pat.title = r.pattern;
      var rm = document.createElement("button"); rm.className = "hlrm"; rm.textContent = "×"; rm.title = "Remove this rule";
      rm.onclick = function () { userRules.splice(i, 1); persistRules(); renderRules(); };
      row.appendChild(sw); row.appendChild(pat); row.appendChild(rm);
      wrap.appendChild(row);
    });
  }
  IDE.$("hlRules").onclick = function () { IDE.$("hlPanel").classList.toggle("hidden"); };
  IDE.$("hlAdd").onclick = function () {
    var p = IDE.$("hlPattern").value.trim();
    if (!p) return;
    userRules.push({ pattern: p, color: IDE.$("hlColor").value || "#ffcc00" });
    persistRules(); renderRules();
    IDE.$("hlPattern").value = "";
  };
  renderRules();

  /* ---- filter: one shared input, applied to whichever feed (log OR results) is currently active --
     "searchable like the log" extends to results too, since persisted history is only useful if you can
     re-find the one that worked. ---- */
  var filterText = "";
  function matches(line) { return !filterText || line.toLowerCase().indexOf(filterText) >= 0; }
  function rowMatches(row) {
    if (!filterText) return true;
    var resEl = row.querySelector(".res");
    var text = (row.dataset.code + " " + (resEl ? resEl.textContent : "")).toLowerCase();
    return text.indexOf(filterText) >= 0;
  }
  function applyFilterTo(row) { row.classList.toggle("hidden", !rowMatches(row)); }
  IDE.bus.on("log", function (d) {
    var el = document.createElement("div"); el.className = "logline" + (d.kind === "ws" ? " ws" : "");
    var ts = document.createElement("span"); ts.className = "lt";
    ts.textContent = new Date().toTimeString().slice(0, 8);
    el.appendChild(ts); el.appendChild(document.createTextNode(d.line));
    highlightLine(el, d.line);
    if (!matches(d.line)) el.classList.add("hidden");
    log.appendChild(el);
    while (log.childElementCount > 600) log.removeChild(log.firstChild);
    auto(log);
  });
  IDE.$("logFilter").addEventListener("input", function () {
    filterText = this.value.trim().toLowerCase();
    Array.prototype.forEach.call(log.children, function (el) {
      el.classList.toggle("hidden", !matches(el.textContent.slice(8)));   // slice off the HH:MM:SS stamp
    });
    Array.prototype.forEach.call(results.children, applyFilterTo);
  });

  IDE.console = {
    pending: pending, result: result,
    clear: function (which) {
      feedOf(which).innerHTML = "";
      if (which === "results") { hist = []; persistHist(); }
    }
  };
})();
