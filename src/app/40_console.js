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

  /* ---- results ---- */
  function pending(codeText) {
    var row = document.createElement("div"); row.className = "row";
    row.dataset.code = codeText;
    var c = document.createElement("span"); c.className = "code";
    c.textContent = codeText.length > 220 ? codeText.slice(0, 220) + "…" : codeText;
    var rr = document.createElement("button"); rr.className = "rerun"; rr.textContent = "↺"; rr.title = "Run this again";
    rr.onclick = function () { IDE.runCode(row.dataset.code); };
    var r = document.createElement("span"); r.className = "res dim"; r.textContent = "running…";
    row.appendChild(c); row.appendChild(rr); row.appendChild(r); results.appendChild(row);
    while (results.childElementCount > 200) results.removeChild(results.firstChild);
    pendingRow = r; auto(results);
  }
  function result(o) {
    var r = pendingRow; pendingRow = null; if (!r) return;
    if (o.error) { r.className = "res err"; r.textContent = o.error; }
    else if (o.timedOut) { r.className = "res warn"; r.textContent = "no result within timeout (chunk likely still ran)"; }
    else if (o.ok === false) { r.className = "res err"; r.textContent = "runtime error: " + o.value; }
    else { r.className = "res ok"; r.textContent = (o.value === "" || o.value == null) ? "(no return value)" : o.value; }
    auto(results);
  }

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

  /* ---- log + filter ---- */
  var filterText = "";
  function matches(line) { return !filterText || line.toLowerCase().indexOf(filterText) >= 0; }
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
  });

  IDE.console = { pending: pending, result: result, clear: function (which) { feedOf(which).innerHTML = ""; } };
})();
