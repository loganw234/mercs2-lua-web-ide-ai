/* 20_editor.js -- the editor, on CodeMirror 6 (vendored as window.CM by tools/vendor -> src/lib/vendor.js).
   Lua highlighting (legacy stream mode, extended to tint the game's globals), real undo/redo, find/replace
   (Ctrl/Cmd+F), bracket matching + auto-close, auto-indent, folding, and an Ess.* autocomplete fed from the
   generated API JSON -- Easy-tier calls float to the top, and accepted calls insert as snippets with
   tab-through argument placeholders.
   Exposes IDE.editor { cm, get, set, reset, selection, focus, insertSnippet, jumpTo, relint }.
   The lint source delegates to IDE.lint (25_lint.js) so the two modules stay independent. */
(function () {
  var IDE = window.IDE, CM = window.CM, host = IDE.$("editor");

  /* ---- Lua mode, extended: the game's globals highlight like builtins ---- */
  var GLOB = { Ess: 1, Loader: 1 };
  Object.keys((window.MERCS_NATIVES && window.MERCS_NATIVES.natives) || {}).forEach(function (g) { GLOB[g] = 1; });
  var luaGame = Object.assign({}, CM.lua, {
    token: function (stream, state) {
      var t = CM.lua.token(stream, state);
      /* the base Lua mode lexes a dotted chain (Ess.Object.spawnAhead) as ONE "variable" token including
         the dots -- current() is the whole path, not just "Ess". Check the chain's ROOT segment against
         GLOB, not the full text, or a real Ess./Loader./native call never matches past its first dot. */
      if (t === "variable" || t == null) {
        var root = stream.current().split(".")[0];
        if (GLOB[root]) return "builtin";
      }
      return t;
    }
  });

  var hiStyle = CM.HighlightStyle.define([
    { tag: CM.tags.keyword, color: "var(--k)" },
    { tag: CM.tags.string, color: "var(--s)" },
    { tag: CM.tags.comment, color: "var(--c)", fontStyle: "italic" },
    { tag: CM.tags.number, color: "var(--num)" },
    { tag: CM.tags.standard(CM.tags.variableName), color: "var(--b)" },
    { tag: CM.tags.atom, color: "var(--num)" }
  ]);

  /* ---- Ess.* autocomplete off the generated API JSON ---- */
  var options = null;
  function sigArgs(sig) {           // "Ess.X.y(a, b)" -> ["a","b"]; no/empty parens -> []
    var m = /\(([^)]*)\)/.exec(sig || "");
    if (!m || !m[1].trim()) return [];
    return m[1].split(",").map(function (a) { return a.trim().replace(/[${}\\]/g, ""); }).filter(Boolean);
  }
  function callTemplate(path, args) {
    if (!args.length) return path + "(${})";
    return path + "(" + args.map(function (a) { return "${" + a + "}"; }).join(", ") + ")";
  }
  function braceCall(sig) { return /^[^(]*\{/.test(sig || ""); }   // Ess.TextConsole.open{ ... } table-call style
  IDE.callTemplate = function (c) {                                // 50_api reuses this
    return braceCall(c.sig) ? c.path + "{ ${} }" : callTemplate(c.path, sigArgs(c.sig));
  };

  var LUA_SNIPPETS = [
    { label: "function", tpl: "function ${name}(${args})\n\t${}\nend", detail: "function … end" },
    { label: "local", tpl: "local ${name} = ${value}", detail: "local variable" },
    { label: "if", tpl: "if ${condition} then\n\t${}\nend", detail: "if … then … end" },
    { label: "ifelse", tpl: "if ${condition} then\n\t${}\nelse\n\t\nend", detail: "if … else … end" },
    { label: "for", tpl: "for i = ${1}, ${10} do\n\t${}\nend", detail: "numeric for loop" },
    { label: "forin", tpl: "for ${k}, ${v} in pairs(${t}) do\n\t${}\nend", detail: "for … in pairs" },
    { label: "loop", tpl: 'Ess.Loop.start("${id}", ${1}, function()\n\t${}\n\treturn true\nend)', detail: "a repeating Ess.Loop tick" }
  ];

  function buildOptions() {
    var data = window.ESS_API || { namespaces: [] }, out = [];
    LUA_SNIPPETS.forEach(function (s) {
      out.push({ label: s.label, type: "keyword", detail: s.detail, apply: CM.snippet(s.tpl), boost: -1 });
    });
    data.namespaces.forEach(function (ns) {
      var easy = ns.name.indexOf("Ess.Easy") === 0;
      out.push({ label: ns.name, type: "class", info: ns.doc || undefined, boost: easy ? 2 : 0 });
      ns.calls.forEach(function (c) {
        var brace = braceCall(c.sig), args = sigArgs(c.sig);
        out.push({
          label: c.path, type: "function",
          detail: brace ? (/\{[^}]*\}/.exec(c.sig) || ["{…}"])[0] : "(" + args.join(", ") + ")",
          info: ns.doc || undefined,
          boost: c.path.indexOf("Ess.Easy.") === 0 ? 2 : 0,
          apply: CM.snippet(brace ? c.path + "{ ${} }" : callTemplate(c.path, args))
        });
      });
    });
    /* the engine's own functions, with the real arg shapes the game's scripts use */
    var nat = (window.MERCS_NATIVES && window.MERCS_NATIVES.natives) || {};
    Object.keys(nat).forEach(function (ns) {
      Object.keys(nat[ns]).forEach(function (fn) {
        var e = nat[ns][fn], path = ns + "." + fn;
        var m = /\(([^]*)\)$/.exec(e.example || "");
        var args = m && m[1].trim() ? m[1].split(",").map(function (a) {
          return a.trim().replace(/[^\w .:-]/g, "").trim() || "arg";
        }) : [];
        out.push({
          label: path, type: "function",
          detail: "(" + args.join(", ") + ")",
          info: e.example ? "game native — e.g.  " + e.example : "game native",
          boost: -1,
          apply: CM.snippet(callTemplate(path, args))
        });
      });
    });
    return out;
  }
  function essCompletions(ctx) {
    var word = ctx.matchBefore(/[A-Za-z_][\w.]*/);
    if (!word && !ctx.explicit) return null;
    if (word && word.text.length < 2 && !ctx.explicit) return null;
    if (!options) options = buildOptions();
    return { from: word ? word.from : ctx.pos, options: options, validFor: /^[\w.]*$/ };
  }

  /* ---- template-name autocomplete: typing inside an open "..."/'...' offers every confirmed spawnable
     template (window.MERCS_TEMPLATES). Simple "are we after an unclosed quote on this line" heuristic --
     matches this codebase's existing pragmatic style (no full syntax-tree lookup for editor-time checks;
     that's what 25_lint.js's separate luaparse pass is for). */
  var tplOptions = null;
  function buildTemplateOptions() {
    var data = window.MERCS_TEMPLATES || { categories: [] }, out = [];
    data.categories.forEach(function (cat) {
      cat.items.forEach(function (it) {
        out.push({ label: it.name, type: "text", detail: cat.name + (it.sub ? " · " + it.sub : "") });
      });
    });
    return out;
  }
  function templateCompletions(ctx) {
    var m = ctx.matchBefore(/["']([^"'\n]*)$/);
    if (!m) return null;
    if (!tplOptions) tplOptions = buildTemplateOptions();
    return { from: m.from + 1, options: tplOptions, validFor: /^[^"'\n]*$/ };
  }

  /* ---- hover docs: mousing over any Ess.* / native token shows the same info the doc pane (50_api.js)
     would -- signature, tier, namespace doc, and a real call-site example for natives. Reuses the API
     data already loaded for autocomplete rather than re-fetching anything. */
  function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function tokenAt(doc, pos) {
    var line = doc.lineAt(pos), text = line.text, i = pos - line.from, start = i, end = i;
    function ok(ch) { return /[\w.]/.test(ch); }
    while (start > 0 && ok(text[start - 1])) start--;
    while (end < text.length && ok(text[end])) end++;
    if (start === end) return null;
    return { text: text.slice(start, end), from: line.from + start, to: line.from + end };
  }
  function hoverInfo(view, pos) {
    var tok = tokenAt(view.state.doc, pos);
    if (!tok || !/^[A-Za-z_][\w.]*$/.test(tok.text)) return null;
    var found = (IDE.api && IDE.api.lookup) ? IDE.api.lookup(tok.text) : null;
    var nat = null;
    if (!found) {
      var parts = tok.text.split(".");
      var natives = (window.MERCS_NATIVES && window.MERCS_NATIVES.natives) || {};
      if (parts.length === 2 && natives[parts[0]] && natives[parts[0]][parts[1]]) {
        nat = { path: tok.text, entry: natives[parts[0]][parts[1]] };
      }
    }
    if (!found && !nat) return null;
    return {
      pos: tok.from, end: tok.to, above: true,
      create: function () {
        var dom = document.createElement("div"); dom.className = "hovertip";
        if (found) {
          var c = found.c, tier = IDE.api.tierOf(c ? c.path : found.ns.name, false);
          var callDoc = c && c.doc;
          dom.innerHTML = '<div class="htsig">' + escHtml(c ? c.sig : found.ns.name) + "</div>" +
            '<span class="httier ' + tier[0] + '">' + escHtml(tier[1]) + "</span>" +
            (callDoc ? '<div class="htdoc">' + escHtml(callDoc) + "</div>"
                     : (found.ns.doc ? '<div class="htdoc">' + escHtml(found.ns.doc) + "</div>" : ""));
        } else {
          dom.innerHTML = '<div class="htsig">' + escHtml(nat.path) + '</div><span class="httier native">Native</span>' +
            (nat.entry.doc ? '<div class="htdoc">' + escHtml(nat.entry.doc) + "</div>" : "") +
            (nat.entry.example ? '<div class="htdoc">real call: ' + escHtml(nat.entry.example) + "</div>" : "");
        }
        return { dom: dom };
      }
    };
  }

  /* ---- the view ---- */
  function extensions() {
    return [
      CM.keymap.of([
        { key: "Mod-Enter", run: function () { IDE.bus.emit("run"); return true; }, preventDefault: true },
        { key: "Mod-s", run: function () { IDE.bus.emit("save"); return true; }, preventDefault: true }
      ]),
      CM.lineNumbers(),
      CM.highlightActiveLineGutter(),
      CM.highlightSpecialChars(),
      CM.history(),
      CM.foldGutter(),
      CM.drawSelection(),
      CM.dropCursor(),
      CM.indentOnInput(),
      CM.bracketMatching(),
      CM.closeBrackets(),
      CM.autocompletion({ override: [essCompletions, templateCompletions] }),
      CM.hoverTooltip(hoverInfo, { hideOnChange: true }),
      CM.highlightActiveLine(),
      CM.highlightSelectionMatches(),
      CM.search({ top: true }),
      CM.StreamLanguage.define(luaGame),
      CM.syntaxHighlighting(hiStyle),
      CM.indentUnit.of("  "),
      CM.linter(function (view) { return (IDE.lint && IDE.lint.check) ? IDE.lint.check(view) : []; }),
      CM.lintGutter(),
      CM.keymap.of([{ key: "Tab", run: CM.acceptCompletion }].concat(
        CM.closeBracketsKeymap, CM.defaultKeymap, CM.searchKeymap,
        CM.historyKeymap, CM.foldKeymap, CM.completionKeymap, [CM.indentWithTab])),
      CM.EditorView.updateListener.of(function (u) { if (u.docChanged) IDE.bus.emit("editorchange"); })
    ];
  }
  function makeState(doc) { return CM.EditorState.create({ doc: doc || "", extensions: extensions() }); }
  var view = new CM.EditorView({ parent: host, state: makeState("") });

  IDE.editor = {
    cm: view,
    get: function () { return view.state.doc.toString(); },
    /* set: replace the text in place (undo-able). reset: fresh state incl. history -- use when switching scripts. */
    set: function (v) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, selection: { anchor: 0 } });
    },
    reset: function (v) { view.setState(makeState(v)); },
    selection: function () {
      var r = view.state.selection.main;
      return view.state.sliceDoc(r.from, r.to);
    },
    focus: function () { view.focus(); },
    /* insertSnippet: "${x}" placeholders tab through; plain text drops in at the caret. */
    insertSnippet: function (text) {
      var r = view.state.selection.main;
      if (/\$\{/.test(text)) CM.snippet(text)(view, null, r.from, r.to);
      else view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    jumpTo: function (line, col) {
      var doc = view.state.doc, l = doc.line(Math.max(1, Math.min(line || 1, doc.lines)));
      var pos = Math.min(l.from + (col || 0), l.to);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
    relint: function () { CM.forceLinting(view); }
  };
})();
