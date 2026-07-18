/* 50_api.js -- the API panel: the Ess reference (window.ESS_API, off CAPABILITIES.md) plus a "the game's
   own functions" section (window.MERCS_NATIVES, scraped from the decompiled base-game scripts, with real
   call sites). Clicking a call opens the doc pane at the bottom -- signature, tier badge (Easy / Core /
   Raw / Native), what the namespace is for, a real example for natives -- with an Insert button that drops
   it in as a tab-through snippet. The completion list the editor consumes also lives here. */
(function () {
  var IDE = window.IDE, data = window.ESS_API || { namespaces: [], completions: [] };
  var natives = (window.MERCS_NATIVES && window.MERCS_NATIVES.natives) || {};
  var tree = IDE.$("apiTree"), search = IDE.$("apiSearch"), docEl = IDE.$("apiDoc");

  /* ---- one merged model: Ess namespaces first, then the engine's own ---- */
  var MODEL = data.namespaces.map(function (ns) {
    return { name: ns.name, group: ns.group || "", doc: ns.doc || "", calls: ns.calls };
  });
  Object.keys(natives).sort().forEach(function (nsName) {
    var members = natives[nsName];
    MODEL.push({
      name: nsName, group: "game native", native: true,
      doc: "The engine's own " + nsName + ".* functions, as the base game's scripts actually use them. Lower-level than Ess — check the example call sites.",
      calls: Object.keys(members).sort().map(function (fn) {
        var e = members[fn];
        return { path: nsName + "." + fn, sig: e.example || nsName + "." + fn + "(…)", native: e };
      })
    });
  });

  function tierOf(path, native) {
    if (native) return ["native", "Native"];
    if (path.indexOf("Ess.Easy") === 0) return ["easy", "Easy — guardrails on"];
    if (path.indexOf("Ess.Raw") === 0) return ["raw", "Raw — building blocks"];
    return ["core", "Core"];
  }

  /* ---- doc pane ---- */
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function showDoc(ns, c) {
    var tier = tierOf(c.path, !!c.native), html = "";
    html += '<div class="sig">' + esc(c.sig) + "</div>";
    html += '<span class="tier ' + tier[0] + '">' + esc(tier[1]) + "</span>";
    /* per-call doc (wiki-sourced, what THIS function actually does) takes priority; the namespace doc
       (what the whole namespace is FOR) shows as a smaller secondary note when a per-call doc exists,
       or as the main doc when it doesn't -- the pre-per-call-doc fallback. */
    var callDoc = c.doc || (c.native && c.native.doc);
    if (callDoc) html += '<div class="doc">' + esc(callDoc) + "</div>";
    if (ns.doc) html += '<div class="' + (callDoc ? "nsnote" : "doc") + '">' + esc(ns.doc) + "</div>";
    if (c.native) {
      html += '<div class="doc">The game’s own scripts call this ' + c.native.n + "×" +
              (c.native.min != null ? ", always with " + (c.native.min === c.native.max ? c.native.min : c.native.min + "–" + c.native.max) + " argument" + (c.native.max === 1 ? "" : "s") : "") + ".</div>";
      if (c.native.example) html += '<div class="exlabel">a real call from the game:</div><div class="ex">' + esc(c.native.example) + "</div>";
    }
    html += '<button class="btn small go" id="apiInsert">Insert into script</button>';
    docEl.innerHTML = html;
    docEl.classList.remove("hidden");
    IDE.$("apiInsert").onclick = function () { IDE.editor.insertSnippet(templateFor(c)); };
  }

  /* insert form: Ess calls use the documented arg names; natives use the real example's args as
     placeholder names (Object.AddLabel(uGuid, "Prisoner") -> ${uGuid}, ${Prisoner}) */
  function templateFor(c) {
    if (!c.native) return IDE.callTemplate(c);
    var m = /\(([^]*)\)$/.exec(c.native.example || "");
    var args = m && m[1].trim() ? m[1].split(",").map(function (a) {
      return "${" + (a.trim().replace(/[^\w .:-]/g, "").trim() || "arg") + "}";
    }) : [];
    return c.path + "(" + (args.length ? args.join(", ") : "${}") + ")";
  }

  /* ---- the tree ---- */
  function build(filter) {
    filter = (filter || "").trim().toLowerCase();
    tree.innerHTML = "";
    MODEL.forEach(function (ns) {
      var nsHit = ns.name.toLowerCase().indexOf(filter) >= 0;
      var calls = ns.calls.filter(function (c) { return !filter || nsHit || c.path.toLowerCase().indexOf(filter) >= 0; });
      if (filter && !nsHit && !calls.length) return;

      var open = !!filter;
      var nsEl = document.createElement("div"); nsEl.className = "ns" + (ns.native ? " nat" : "");
      nsEl.innerHTML = esc(ns.name) + '<span class="g">' + esc(ns.group) + "</span>";
      var wrap = document.createElement("div");
      function paint() {
        wrap.innerHTML = "";
        if (!open) return;
        if (ns.doc) { var d = document.createElement("div"); d.className = "nsdoc"; d.textContent = ns.doc; wrap.appendChild(d); }
        (filter ? calls : ns.calls).forEach(function (c) {
          var el = document.createElement("div"); el.className = "call";
          el.textContent = c.sig.replace(/^Ess\./, ""); el.title = c.sig + " — click for details";
          el.onclick = function () { showDoc(ns, c); };
          wrap.appendChild(el);
        });
      }
      nsEl.onclick = function () { open = !open; paint(); };
      tree.appendChild(nsEl); tree.appendChild(wrap); paint();
    });
    if (!tree.childElementCount) { var e = document.createElement("div"); e.className = "nsdoc"; e.textContent = "no matches"; tree.appendChild(e); }
  }

  /* lookup(path): exact-match a dotted call/namespace path against the merged model -- used by the
     editor's hover tooltip (20_editor.js) so it doesn't need its own copy of this data shape. */
  function lookup(path) {
    for (var i = 0; i < MODEL.length; i++) {
      var ns = MODEL[i];
      if (ns.name === path) return { ns: ns, c: null };
      for (var j = 0; j < ns.calls.length; j++) if (ns.calls[j].path === path) return { ns: ns, c: ns.calls[j] };
    }
    return null;
  }

  search.addEventListener("input", function () { build(search.value); });
  IDE.api = { completions: function () { return data.completions; }, build: build, lookup: lookup, tierOf: tierOf };
  build("");
})();
