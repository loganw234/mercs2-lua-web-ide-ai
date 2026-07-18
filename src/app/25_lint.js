/* 25_lint.js -- the beginner guardrails. luaparse (vendored, CM.luaparse) gives a real Lua 5.1 parse;
   on top of it we run checks tuned for "first script ever" mistakes:
     * syntax errors, retold in plain English (missing end, = vs ==, != vs ~=, unclosed strings...)
     * unknown Ess.* / native / Loader.* calls -- a WARNING with a did-you-mean when it's a close typo,
       a soft INFO otherwise (our API data is observed usage, not the engine's full surface -- never fight
       the user over a call we merely haven't seen)
     * colon-vs-dot on API namespaces (Object:GetPosition -> Object.GetPosition)
     * argument counts wildly outside what the game's own scripts ever pass (natives with >=5 sightings)
     * while-true-without-break -- scripts run ON the game's thread, that's a hard freeze
     * print() -> Ess.Log, and assignments that would clobber a game global
   Exposes IDE.lint { check(view) -> CM diagnostics, validate(code) -> {errors, warnings} }.
   30_run.js gates Run on validate(): syntax errors block (with a friendly message), warnings never do. */
(function () {
  var IDE = window.IDE, CM = window.CM, lp = CM.luaparse;

  var LOADER = { Printf: 1, WsSend: 1, IsKeyDown: 1, PopKeyEvents: 1, ClearKeyEvents: 1, GetKeyboardState: 1, SaveVar: 1, LoadVar: 1 };
  /* calls whose first (literal) argument is a spawn template -- checked against MERCS_TEMPLATES below.
     A small, explicit set on purpose: this is a soft nudge for the common cases, not an attempt to trace
     every possible way a template string reaches the engine. */
  var TPL_CALLS = { "Pg.Spawn": 1, "Ess.Object.spawn": 1, "Ess.Object.spawnAhead": 1, "Ess.Easy.Vehicle.summon": 1 };

  var K = null;
  function knowledge() {
    if (K) return K;
    var ess = window.ESS_API || { namespaces: [], completions: [] };
    var nat = (window.MERCS_NATIVES && window.MERCS_NATIVES.natives) || {};
    var essPaths = {}; ess.completions.forEach(function (c) { essPaths[c] = 1; });
    var essNs = {}; ess.namespaces.forEach(function (n) { essNs[n.name] = 1; });
    var tplSet = {};
    ((window.MERCS_TEMPLATES && window.MERCS_TEMPLATES.categories) || []).forEach(function (cat) {
      cat.items.forEach(function (it) { tplSet[it.name] = 1; });
    });
    return (K = { essPaths: essPaths, essNs: essNs, essList: ess.completions, nat: nat, tplSet: tplSet });
  }

  /* ---- tiny Levenshtein + did-you-mean ---- */
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99;
    var m = a.length, n = b.length, row = [], i, j;
    for (j = 0; j <= n; j++) row[j] = j;
    for (i = 1; i <= m; i++) {
      var prev = row[0]; row[0] = i;
      for (j = 1; j <= n; j++) {
        var cur = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[n];
  }
  function nearest(name, candidates) {
    var lo = name.toLowerCase(), best = null, bestD = 3;
    for (var i = 0; i < candidates.length; i++) {
      var d = lev(lo, candidates[i].toLowerCase());
      if (d < bestD || (d === bestD && best === null)) { bestD = d; best = candidates[i]; }
    }
    return bestD <= 2 ? best : null;
  }

  /* ---- luaparse's message, retold for a first-timer ---- */
  function friendly(e) {
    var m = String(e.message || e).replace(/^\[\d+:\d+\]\s*/, "");
    if (/'then' expected near '='/.test(m)) return "Lua compares with == (a single = assigns). Use == inside this if.";
    if (/expected near '!'|unexpected symbol '!'/.test(m)) return "Lua writes “not equal” as ~= and “not” as the word not — ! isn't used.";
    if (/'end' expected/.test(m)) return "A block is missing its end — every function / if / for / while needs a matching end." ;
    if (/'then' expected/.test(m)) return "This if is missing its then: write  if <condition> then";
    if (/'do' expected/.test(m)) return "This loop is missing its do: write  while <condition> do   or   for ... do";
    if (/unfinished string/.test(m)) return "This string never closes — add the matching quote.";
    if (/unfinished long (comment|string)/.test(m)) return "This --[[ block never closes — add the matching ]].";
    if (/malformed number/.test(m)) return "That's not a valid Lua number.";
    if (/'=' expected/.test(m)) return m + " — if you meant “plus equals”, Lua has no +=; write  x = x + 1";
    if (/unexpected symbol near '\/'|unexpected symbol '\/'/.test(m)) return m + " — if you meant a comment, Lua uses --, not //.";
    if (/near '<eof>'/.test(m)) return "The script ends mid-statement — something at the bottom is unfinished. " + m;
    return m;
  }

  /* ---- AST helpers ---- */
  function walk(n, fn) {
    if (!n || typeof n !== "object") return;
    if (n.type) fn(n);
    for (var k in n) {
      if (k === "loc" || k === "range" || k === "raw" || k === "type") continue;
      var v = n[k];
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) walk(v[i], fn); }
      else if (v && typeof v === "object") walk(v, fn);
    }
  }
  function dotted(n) {           // Ess.Easy.Vehicle.summon -> {root:"Ess", path, range}; colon chains -> null
    var parts = [], range = n.range;
    while (n && n.type === "MemberExpression" && n.indexer === ".") { parts.unshift(n.identifier.name); n = n.base; }
    if (n && n.type === "Identifier" && parts.length) { parts.unshift(n.name); return { root: n.name, path: parts.join("."), range: range }; }
    return null;
  }
  function hasEscape(nodes) {
    var found = false;
    (nodes || []).forEach(function (s) { walk(s, function (x) { if (x.type === "BreakStatement" || x.type === "ReturnStatement") found = true; }); });
    return found;
  }

  /* ---- the analysis ---- */
  function analyze(code) {
    var errors = [], warnings = [], api = knowledge();
    var ast;
    try {
      ast = lp.parse(code, { luaVersion: "5.1", locations: true, ranges: true });
    } catch (e) {
      var idx = (typeof e.index === "number") ? Math.min(e.index, Math.max(0, code.length - 1)) : 0;
      errors.push({ from: idx, to: Math.min(idx + 1, code.length), severity: "error",
                    message: friendly(e), line: e.line || 1, col: e.column || 0 });
      return { errors: errors, warnings: warnings };
    }

    try {
      walk(ast, function (n) {
        /* calls */
        if (n.type === "CallExpression" || n.type === "StringCallExpression" || n.type === "TableCallExpression") {
          var base = n.base;

          /* colon-vs-dot on an API namespace:  Object:GetPosition(g) */
          if (base && base.type === "MemberExpression" && base.indexer === ":" &&
              base.base && base.base.type === "Identifier") {
            var rootName = base.base.name;
            if (rootName === "Ess" || rootName === "Loader" || api.nat[rootName]) {
              warnings.push({ from: base.range[0], to: base.range[1], severity: "warning",
                message: "Use a dot here: " + rootName + "." + base.identifier.name + "(...). The colon is for methods on your own objects." });
            }
            return;
          }

          var p = base ? dotted(base) : null;

          /* unknown template-name string literal on a known spawn-like call. luaparse's default
             encodingMode leaves .value null on string literals (byte-level, not auto-decoded) -- .raw
             still has the quotes, so strip a single matching pair rather than trusting .value. */
          if (p && TPL_CALLS[p.path] && n.type === "CallExpression" && n.arguments && n.arguments[0] &&
              n.arguments[0].type === "StringLiteral") {
            var raw = n.arguments[0].raw || "";
            var tplName = /^["']([\s\S]*)["']$/.test(raw) ? raw.slice(1, -1) : null;
            if (tplName && tplName.trim() && !api.tplSet[tplName]) {
              warnings.push({ from: n.arguments[0].range[0], to: n.arguments[0].range[1], severity: "info",
                message: '"' + tplName + '" isn\'t in the known template list — double-check the spelling, or browse the Templates tab in the sidebar.' });
            }
          }

          /* print() -> the game log */
          if (base && base.type === "Identifier" && base.name === "print") {
            warnings.push({ from: base.range[0], to: base.range[1], severity: "warning",
              message: "print() doesn't reach the game — use Ess.Log(...) and watch the Log & telemetry tab." });
          }

          if (p && p.path.indexOf("Ess.") === 0 && !api.essPaths[p.path]) {
            var ns = p.path.slice(0, p.path.lastIndexOf("."));
            var sug = nearest(p.path, api.essList);
            if (sug) {
              warnings.push({ from: p.range[0], to: p.range[1], severity: "warning",
                message: p.path + " isn't in the Ess API — did you mean " + sug + "?" });
            } else if (api.essNs[ns]) {
              warnings.push({ from: p.range[0], to: p.range[1], severity: "info",
                message: p.path + " isn't in the API reference — double-check the name in the sidebar (" + ns + " is there)." });
            } else {
              warnings.push({ from: p.range[0], to: p.range[1], severity: "info",
                message: p.path + " isn't in the API reference — browse the sidebar to find the right call." });
            }
          } else if (p && p.root === "Loader" && p.path.split(".").length === 2 && !LOADER[p.path.split(".")[1]]) {
            var lsug = nearest(p.path.split(".")[1], Object.keys(LOADER));
            warnings.push({ from: p.range[0], to: p.range[1], severity: lsug ? "warning" : "info",
              message: p.path + " isn't a lua-bridge function" + (lsug ? " — did you mean Loader." + lsug + "?" : ".") });
          } else if (p && api.nat[p.root] && p.path.split(".").length === 2) {
            var fn = p.path.split(".")[1], members = api.nat[p.root], entry = members[fn];
            if (!entry) {
              var msug = nearest(fn, Object.keys(members));
              if (msug) {
                warnings.push({ from: p.range[0], to: p.range[1], severity: "warning",
                  message: p.path + " — the game's scripts never call this; did you mean " + p.root + "." + msug + "?" });
              } else {
                warnings.push({ from: p.range[0], to: p.range[1], severity: "info",
                  message: p.path + " isn't seen anywhere in the game's own scripts — it may exist, but double-check the name." });
              }
            } else if (n.type === "CallExpression" && entry.n >= 5 && entry.min != null) {
              var argc = (n.arguments || []).length;
              if (argc < entry.min || argc > entry.max) {
                var range = entry.min === entry.max ? String(entry.min) : entry.min + "–" + entry.max;
                warnings.push({ from: p.range[0], to: n.range[1], severity: "warning",
                  message: p.path + " — the game's scripts always pass " + range + " argument" + (entry.max === 1 ? "" : "s") +
                           " (you have " + argc + ")." + (entry.example ? "  e.g.  " + entry.example : "") });
              }
            }
          }
        }

        /* while true with no way out = the game's thread never comes back */
        if (n.type === "WhileStatement" && n.condition &&
            n.condition.type === "BooleanLiteral" && n.condition.value === true && !hasEscape(n.body)) {
          warnings.push({ from: n.range[0], to: Math.min(n.range[0] + 10, n.range[1]), severity: "error",
            message: "This loop never ends and will FREEZE the game — scripts run on the game's own thread. For something that repeats, use Ess.Loop.start(\"id\", interval, function() ... return true end)." });
        }
        if (n.type === "RepeatStatement" && n.condition &&
            n.condition.type === "BooleanLiteral" && n.condition.value === false && !hasEscape(n.body)) {
          warnings.push({ from: n.range[0], to: Math.min(n.range[0] + 10, n.range[1]), severity: "error",
            message: "repeat ... until false never ends and will FREEZE the game — use Ess.Loop.start(...) for repeating work." });
        }

        /* clobbering a game global */
        if (n.type === "AssignmentStatement") {
          (n.variables || []).forEach(function (v) {
            if (v.type === "Identifier" && (v.name === "Ess" || v.name === "Loader" || api.nat[v.name])) {
              warnings.push({ from: v.range[0], to: v.range[1], severity: "warning",
                message: "This replaces the game's " + v.name + " object for every script — pick a different variable name." });
            }
          });
        }
      });
    } catch (e) { /* a checker bug must never take down the editor */ }

    return { errors: errors, warnings: warnings };
  }

  /* CM lint source (20_editor's linter() delegates here) */
  function check(view) {
    var code = view.state.doc.toString();
    if (!code.trim()) return [];
    var r = analyze(code), max = code.length;
    return r.errors.concat(r.warnings).map(function (d) {
      return { from: Math.min(d.from, max), to: Math.min(Math.max(d.to, d.from), max), severity: d.severity, message: d.message };
    });
  }

  IDE.lint = { check: check, validate: analyze };
})();
