/* 86_agent.js -- the agentic tool harness.
 *
 * Gives the assistant a way to FETCH what it doesn't know instead of guessing.
 * That matters here more than it would elsewhere: this project's whole failure
 * history is confidently-invented identifiers, and every one of those traced to
 * material the model could not see. A pack can only ever hold a slice of the
 * wiki; a tool can reach all of it.
 *
 * Tools -- bundled data first (instant, offline, exactly grounded), network
 * and game after:
 *   search_api(query)        the bundled Ess reference + engine natives
 *   search_examples(query)   the bundled smoke-tested example scripts
 *   read_example(name)       one example's full source
 *   read_wiki_page(path)     the real page, straight from wiki.mercs2.tools
 *   search_wiki(query)       the wiki's full-text index
 *   search_templates(query)  the bundled spawnable-template list
 *   get_ide_state()          live IDE facts: connection, delivery, scripts
 *   inspect_game(expr)       READ-ONLY Lua in the running game (auto-runs)
 *   run_lua(code)            arbitrary Lua -- ALWAYS asks the user first
 *   propose_script(code)     replace the editor script -- diff + Apply gate
 *   get_editor()             the current buffer
 *
 * Safety: `inspect_game` is allowlisted to read-shaped calls so the model can
 * look around freely. Anything that could change the game goes through
 * `run_lua`, and anything that would change the user's CODE goes through
 * `propose_script` -- both show exactly what will happen and execute nothing
 * without an explicit click. The split exists so that "let the model explore"
 * does not have to mean "let the model act".
 */
(function () {
  var IDE = window.IDE;

  var WIKI = "https://wiki.mercs2.tools";
  var MAX_PAGE_CHARS = 14000;
  var MAX_STEPS = 10;         /* tool round trips before we stop and answer.
                                 Raised from 6 with the bundled-data tools: a
                                 search -> read -> inspect -> propose chain is
                                 a legitimate 6+ calls, and every call is now
                                 visible in the chat, so a longer leash costs
                                 nothing in opacity. */

  /* Calls that only read. Anything not matching is refused by inspect_game and
     must go through run_lua (which asks). Deliberately conservative: a missing
     entry costs a confirmation click, a wrong entry costs the user's game. */
  var READ_ONLY = /^(?:[A-Za-z_][\w.]*\s*=\s*)?(?:local\s+[\w,\s]+=\s*)?(?:return\s+)?(?:[\w.]*\.)?(Get|Is|Has|Find|Count|Query|Enumerate|pairs|ipairs|tostring|tonumber|type|table\.|string\.|math\.)/;
  var MUTATORS = /\b(Set(?!ting)|Spawn|Remove|Kill|Destroy|Delete|Add|Give|Teleport|Apply|Play|Stop|Enable|Disable|Create|Attach|Detach|Explode|Damage|Revive)\w*\s*\(/;

  /* The wiki's just-the-docs search index: 3,485 per-heading entries with
     {title, content, url}. Fetched lazily on first search and cached for the
     session -- it is 4.8 MB, which is far too much to pull on page load for a
     tool the user may never trigger, and perfectly fine once.
     This is the cheap version of RAG: no embeddings, no vector store, no build
     step, because the wiki already generates and serves this file. */
  var searchIdx = null, searchPromise = null;

  /* Models phrase searches as questions ("how do I make a character
     invincible"), and every one of those filler words appears in thousands of
     the 3,485 sections -- so without this the ranking is driven by "how" and
     "make" rather than "invincible", and the top hits are unrelated pages that
     happen to be wordy. Dropped only if content words survive. */
  var STOP = ("a an the and or but if is are was were be been being do does did " +
    "how what when where which who why can could should would will i you it its " +
    "my me we they them this that these those to of in on at by for with from " +
    "as into about get got make made use using want need help please there here " +
    "any some all no not have has had").split(" ");

  function contentTerms(raw) {
    var all = raw.split(/[^\w.]+/).filter(function (t) { return t.length > 1; });
    var kept = all.filter(function (t) { return STOP.indexOf(t) === -1; });
    return kept.length ? kept : all;
  }

  function loadIndex() {
    if (searchIdx) return Promise.resolve(searchIdx);
    if (searchPromise) return searchPromise;
    searchPromise = fetch(WIKI + "/assets/js/search-data.json")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        searchIdx = Object.keys(j).map(function (k) { return j[k]; })
          .filter(function (e) { return e && e.url; });
        return searchIdx;
      })
      .catch(function (e) { searchPromise = null; throw e; });
    return searchPromise;
  }

  /* Term-overlap scoring. A title hit is worth far more than a body hit: these
     are API reference pages, so the thing you searched for IS usually a title. */
  function scoreEntry(e, terms) {
    var title = (e.title || "").toLowerCase();
    var doc = (e.doc || "").toLowerCase();
    var content = (e.content || "").toLowerCase();
    var score = 0, matched = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i], hit = 0;
      if (title.indexOf(t) !== -1) { score += 10; hit = 1; }
      if (doc.indexOf(t) !== -1) { score += 4; hit = 1; }
      var n = content.split(t).length - 1;
      if (n) { score += Math.min(n, 4); hit = 1; }
      matched += hit;
    }
    /* Every term matching somewhere beats one term matching loudly. */
    if (matched === terms.length && terms.length > 1) score += 15;
    return { score: matched ? score : 0, matched: matched };
  }

  /* Normalise anything page-shaped to a bare wiki path.
     ".lua" is in here because of a real miss: the wiki pages describe
     themselves as "Module: mrxfollow.lua", so a model asked to read that module
     requests "resident/mrxfollow.lua" -- entirely reasonable, and it 404'd,
     which cost the answer. Strip the extensions the wiki itself puts in front
     of the model rather than expecting it to know which are page names. */
  function pagePath(url) {
    return String(url)
      .replace(/^\/+/, "")
      .replace(/#.*$/, "")
      .replace(/\.(html?|md|lua)$/i, "");
  }

  function txtFromHtml(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    ["script", "style", "nav", "header", "footer", ".site-nav", ".search",
     ".site-header", ".site-footer"].forEach(function (sel) {
      Array.prototype.forEach.call(doc.querySelectorAll(sel), function (n) { n.remove(); });
    });
    var main = doc.querySelector(".main-content") || doc.querySelector("main") || doc.body;
    var t = (main.innerText || main.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  /* ---- bundled-data indexes ----------------------------------------------
     The build inlines the full API reference (window.ESS_API + MERCS_NATIVES)
     and the smoke-tested examples (window.ESS_EXAMPLES). These are the BEST
     sources the agent has: instant, offline, and exactly what the grounding
     check trusts -- so the tools over them are listed first and their
     descriptions steer the model here before the network. */
  var apiCache = null, exCache = null;

  function apiEntries() {
    if (apiCache) return apiCache;
    apiCache = [];
    var data = window.ESS_API || { namespaces: [] };
    (data.namespaces || []).forEach(function (ns) {
      (ns.calls || []).forEach(function (c) {
        apiCache.push({ path: c.path, sig: c.sig || c.path, doc: c.doc || "",
                        ns: ns.name, nsdoc: ns.doc || "" });
      });
    });
    var nat = (window.MERCS_NATIVES && window.MERCS_NATIVES.natives) || {};
    Object.keys(nat).forEach(function (nsName) {
      var members = nat[nsName];
      Object.keys(members).forEach(function (fn) {
        var e = members[fn];
        apiCache.push({ path: nsName + "." + fn,
                        sig: e.example || nsName + "." + fn + "(...)",
                        doc: (e.doc || "") +
                             (e.example ? " Real call from the game: " + e.example : ""),
                        ns: nsName, nsdoc: "the engine's own functions", native: true });
      });
    });
    return apiCache;
  }

  function apiCard(e) {
    return e.sig + "\n  " + (e.doc || "(no per-call doc)") +
      "\n  [" + (e.native ? "engine native" : "Ess") + "] namespace " + e.ns +
      (e.nsdoc ? " -- " + e.nsdoc : "");
  }

  function exampleList() {
    if (exCache) return exCache;
    exCache = [];
    var d = window.ESS_EXAMPLES || { categories: [] };
    (d.categories || []).forEach(function (c) {
      (c.items || []).forEach(function (it) {
        exCache.push({ name: it.name || "", desc: it.desc || "",
                       code: it.code || "", cat: c.name || "" });
      });
    });
    return exCache;
  }

  var TOOLS = [
    {
      type: "function",
      function: {
        name: "search_api",
        description:
          "Search the BUNDLED API reference: every documented Ess.* call plus " +
          "the engine's own native functions with real call sites from the " +
          "base game. Instant and offline. Use this FIRST for 'is there a " +
          "function that...', exact signatures, and argument lists. Pass a " +
          "full dotted name to get the complete entry for that call.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords or a dotted call name." }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_examples",
        description:
          "Search the bundled, smoke-tested example scripts by keyword. The " +
          "best answer to 'how do I ...' is usually a WORKING example adapted " +
          "to the user's need, not code written from memory. Returns names and " +
          "descriptions; read the code with read_example.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords, e.g. 'spawn vehicle', 'loop', 'faction'." }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_example",
        description:
          "Read the full Lua source of one bundled example script, by the " +
          "exact name search_examples returned.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "An example name from search_examples." }
          },
          required: ["name"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_wiki_page",
        description:
          "Read a page from the Mercenaries 2 modding wiki. Use this whenever you " +
          "are unsure whether a function, module, event or template exists, or need " +
          "its exact arguments. Prefer this over answering from memory.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              /* Do NOT put example page names here.
                 An earlier version listed 'resident/mrxfollow' as a sample
                 path. Asked how to make an NPC follow the player, a model ran
                 one weak search, read nothing, and answered with MrxFollow --
                 lifted straight out of this description, presented as fact. It
                 happened to be a real module, so the answer looked good; had
                 the example been arbitrary the same mechanism would have
                 produced a confident fabrication. A tool description is part of
                 the prompt, so anything API-shaped in it is something the model
                 can and will repeat back. Folder names only. */
              description:
                "Page path without leading slash, as returned by search_wiki. " +
                "Folders: namespaces, resident, ess, vz, contract-framework, " +
                "lua-bridge-api, spawn-reference, deep-dives, tutorials, uilib, " +
                "shell. Use search_wiki first to find the path."
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_wiki",
        description:
          "Search the whole modding wiki by keyword and get back matching page " +
          "paths with snippets. Use this FIRST when you do not already know which " +
          "page covers something -- it is better than guessing a path for " +
          "read_wiki_page. Then read the most promising result.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keywords, e.g. 'spawn helicopter', 'Ai.Goal opts', 'save game safe'."
            }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_templates",
        description:
          "Search the list of spawnable template names by substring. Use before " +
          "writing any Pg.Spawn or Pg.GetGuidByName string -- these names are not " +
          "guessable from the in-game display name.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Case-insensitive substring, e.g. 'soldier', 'heli'." }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "inspect_game",
        description:
          "Run a READ-ONLY Lua expression in the running game and return the result. " +
          "Only getters and queries are permitted. Use it to check real state, e.g. " +
          "'return tostring(Player.GetLocalCharacter())'. Fails if the IDE is not " +
          "connected to a running game.",
        parameters: {
          type: "object",
          properties: {
            expr: { type: "string", description: "A Lua expression that returns a value." }
          },
          required: ["expr"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_lua",
        description:
          "Run arbitrary Lua in the running game. This CHANGES game state and the " +
          "user must approve it, so use it only when they have asked for something " +
          "to happen. Prefer inspect_game for looking at things.",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "Lua to execute." },
            why: { type: "string", description: "One line the user will see, explaining the intent." }
          },
          required: ["code", "why"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "propose_script",
        description:
          "Propose a complete replacement for the script open in the editor. " +
          "The user is shown a diff and must click Apply -- nothing changes " +
          "without their approval. Use this when asked to fix, extend or " +
          "rewrite their script. Always send the WHOLE script (the full file " +
          "after your change), never a fragment.",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "The complete new script." },
            why: { type: "string", description: "One line the user will see, summarising the change." }
          },
          required: ["code", "why"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_ide_state",
        description:
          "Report the IDE's live state: whether the game is connected (and " +
          "the likely reason if not), how this page is being served, and the " +
          "user's scripts. Call this FIRST for connection problems, 'nothing " +
          "happens when I run', or any question about the editor itself.",
        parameters: { type: "object", properties: {} }
      }
    },
    {
      type: "function",
      function: {
        name: "get_editor",
        description: "Return the Lua currently open in the editor.",
        parameters: { type: "object", properties: {} }
      }
    }
  ];

  /* ---- execution --------------------------------------------------------- */

  function templates() {
    var t = window.MERCS_TEMPLATES;
    if (!t) return [];
    var out = [];
    (t.categories || []).forEach(function (c) {
      (c.items || c.names || []).forEach(function (n) {
        out.push(typeof n === "string" ? n : (n.name || n.key || ""));
      });
    });
    return out.filter(Boolean);
  }

  function execute(name, args, ui) {
    try {
      if (name === "search_api") {
        var aq = String(args.query || "").trim();
        if (!aq) return Promise.resolve("Empty query.");
        var entries = apiEntries();
        var alc = aq.toLowerCase();
        /* a dotted-name query that matches a path exactly (or as a suffix,
           so "Player.pose" finds "Ess.Player.pose") gets the full card */
        var full = entries.filter(function (e) {
          var p = e.path.toLowerCase();
          return p === alc || p.slice(-(alc.length + 1)) === "." + alc;
        });
        if (full.length) {
          return Promise.resolve(full.slice(0, 5).map(apiCard).join("\n\n"));
        }
        var aterms = contentTerms(alc);
        if (!aterms.length) return Promise.resolve("Query too short.");
        var ascored = [];
        entries.forEach(function (e) {
          var hay = (e.path + " " + e.sig + " " + e.doc).toLowerCase();
          var s = 0, matched = 0;
          aterms.forEach(function (t) {
            var n = hay.split(t).length - 1;
            if (e.path.toLowerCase().indexOf(t) !== -1) s += 8;
            if (n) { s += Math.min(n, 3); matched++; }
          });
          if (matched === aterms.length && aterms.length > 1) s += 6;
          if (matched) ascored.push({ s: s, m: matched, e: e });
        });
        ascored = ascored.filter(function (r) {
          return r.m >= (aterms.length === 1 ? 1 : Math.ceil(aterms.length / 2));
        });
        if (!ascored.length) {
          return Promise.resolve(
            "Nothing in the bundled API reference matches '" + aq + "'. It " +
            "covers every documented Ess call and the natives the base game " +
            "itself uses, so this is strong evidence no such call exists " +
            "under that name. Try different words, or search_wiki for " +
            "concept/guide pages -- and do NOT invent a name.");
        }
        ascored.sort(function (a, b) { return b.s - a.s; });
        var alines = ascored.slice(0, 20).map(function (r) {
          var doc = r.e.doc.replace(/\s+/g, " ").slice(0, 110);
          return r.e.path + " -- " + r.e.sig + (doc ? "\n    " + doc : "");
        });
        return Promise.resolve(
          "Matching calls (pass a full dotted name to search_api for the " +
          "complete entry):\n\n" + alines.join("\n"));
      }

      if (name === "search_examples") {
        var xq = String(args.query || "").toLowerCase().trim();
        if (!xq) return Promise.resolve("Empty query.");
        var xterms = contentTerms(xq);
        if (!xterms.length) return Promise.resolve("Query too short.");
        var xhits = exampleList().map(function (x) {
          var hay = (x.name + " " + x.desc + " " + x.cat + " " + x.code).toLowerCase();
          var matched = 0;
          xterms.forEach(function (t) { if (hay.indexOf(t) !== -1) matched++; });
          return { m: matched, x: x };
        }).filter(function (h) {
          return h.m >= (xterms.length === 1 ? 1 : Math.ceil(xterms.length / 2));
        });
        if (!xhits.length) {
          return Promise.resolve(
            "No bundled example matches '" + xq + "' (there are " +
            exampleList().length + "). Try broader words, or build from " +
            "search_api results instead -- and never present guessed code as " +
            "a tested example.");
        }
        xhits.sort(function (a, b) { return b.m - a.m; });
        return Promise.resolve(
          "Matching examples (read one with read_example):\n\n" +
          xhits.slice(0, 12).map(function (h) {
            return h.x.name + " -- " + h.x.desc;
          }).join("\n"));
      }

      if (name === "read_example") {
        var want = String(args.name || "").toLowerCase().trim();
        if (!want) return Promise.resolve("Empty name.");
        var all = exampleList(), hit = null;
        for (var xi = 0; xi < all.length; xi++) {
          if (all[xi].name.toLowerCase() === want) { hit = all[xi]; break; }
        }
        if (!hit) {
          var near = all.filter(function (x) {
            return x.name.toLowerCase().indexOf(want) !== -1;
          });
          if (near.length === 1) hit = near[0];
          else if (near.length) {
            return Promise.resolve("No exact match. Did you mean:\n" +
              near.slice(0, 8).map(function (x) { return x.name; }).join("\n"));
          } else {
            return Promise.resolve(
              "No bundled example named '" + args.name + "'. Use " +
              "search_examples first and pass a name from its results.");
          }
        }
        return Promise.resolve(
          "-- Example: " + hit.name + "\n-- " + hit.desc + "\n\n" + hit.code);
      }

      if (name === "get_ide_state") {
        var lines = [];
        var connected = IDE.bridge && IDE.bridge.connected();
        var wsEl = IDE.$ && IDE.$("url");
        var wsUrl = (wsEl && wsEl.value) || "ws://127.0.0.1:27050";
        lines.push("Game connection: " + (connected
          ? "CONNECTED (" + wsUrl + ")"
          : (IDE.bridge ? IDE.bridge.state() : "unknown") + " -- NOT connected (" + wsUrl + ")"));
        if (location.protocol === "file:") {
          lines.push("Page delivery: opened from disk (file://) -- no browser " +
            "restriction on reaching 127.0.0.1.");
        } else {
          lines.push("Page delivery: " + location.origin +
            (location.protocol === "https:"
              ? " (hosted https -- some browsers BLOCK connections from here " +
                "to 127.0.0.1; downloading the editor or letting the " +
                "lua-bridge serve it fixes that)"
              : ""));
        }
        try {
          var act = IDE.store.active();
          lines.push("Active script: \"" + act.name + "\" (" + act.code.length +
            " chars). Library: " + IDE.store.list().length + " scripts, " +
            IDE.store.openTabs().length + " open as tabs.");
        } catch (e) {}
        if (!connected) {
          lines.push("Until the user connects (game running with the " +
            "lua-bridge mod, then the Connect button, top right), nothing " +
            "can run in the game: inspect_game, run_lua and the Run button " +
            "will all report not connected.");
        }
        return Promise.resolve(lines.join("\n"));
      }

      if (name === "propose_script") {
        var newCode = String(args.code || "");
        if (!newCode.trim()) return Promise.resolve("No code given.");
        if (!ui || !ui.proposeEdit) {
          return Promise.resolve("The editor-edit gate is unavailable here.");
        }
        return ui.proposeEdit(args.why || "Apply this version of the script?", newCode)
          .then(function (okd) {
            if (!okd) {
              return "The user declined the edit -- the script is unchanged. " +
                "Ask what they want different rather than re-proposing the same code.";
            }
            if (IDE.editor && IDE.editor.set) {
              IDE.editor.set(newCode);
              return "Applied. The editor now contains the proposed script " +
                "(the user can undo with Ctrl+Z).";
            }
            return "Could not reach the editor.";
          });
      }

      if (name === "read_wiki_page") {
        /* Accept what search_wiki hands back verbatim (".html", anchors, a
           leading slash) as well as a bare path -- the model should not have to
           reformat one tool's output to feed the next. */
        var p = pagePath(String(args.path || "").replace(/\.md$/, ""));
        if (!/^[\w\-./]+$/.test(p)) return Promise.resolve("Refused: bad path.");
        return fetch(WIKI + "/" + p, { headers: { accept: "text/html" } })
          .then(function (r) {
            if (!r.ok) {
              /* Point at the recovery instead of only forbidding the mistake.
                 "Do not guess another path" on its own left a model with
                 nowhere to go, so it gave up on a page that existed. */
              return "No page at /" + p + " (HTTP " + r.status + "). Do not " +
                "guess another path -- call search_wiki with keywords instead, " +
                "and use a path from its results. If search finds nothing " +
                "either, say the wiki does not document it.";
            }
            return r.text();
          })
          .then(function (h) {
            if (h.lastIndexOf("That page does not exist", 0) === 0) return h;
            var t = txtFromHtml(h);
            return t.length > MAX_PAGE_CHARS
              ? t.slice(0, MAX_PAGE_CHARS) + "\n\n[truncated -- ask for a narrower page]"
              : t;
          })
          .catch(function (e) { return "Could not fetch the page: " + e.message; });
      }

      if (name === "search_wiki") {
        var sq = String(args.query || "").toLowerCase().trim();
        if (!sq) return Promise.resolve("Empty query.");
        var terms = contentTerms(sq);
        if (!terms.length) return Promise.resolve("Query too short.");
        return loadIndex().then(function (idx) {
          /* Relevance floor. Without it a nonsense query still returns pages,
             because one incidental word ("token") matches somewhere in 3,485
             sections -- and a confident-looking hit list is exactly how a model
             talks itself into an API that does not exist. Demand that a
             majority of the query's terms actually appear. */
          var minMatch = terms.length === 1 ? 1 : Math.ceil(terms.length / 2);
          var scored = [];
          for (var i = 0; i < idx.length; i++) {
            var r = scoreEntry(idx[i], terms);
            if (r.score > 0 && r.matched >= minMatch) {
              scored.push({ s: r.score, m: r.matched, e: idx[i] });
            }
          }
          if (!scored.length) {
            return "No wiki page matches '" + sq + "'. Nothing in the wiki " +
              "covers those terms together. Try fewer or different keywords -- " +
              "and do NOT invent an API name because the search came back empty. " +
              "An empty result is evidence the thing may not exist.";
          }
          scored.sort(function (a, b) { return b.s - a.s; });
          /* One line per PAGE, not per heading -- the index is per-section, so
             without this the top 8 can all be the same page. */
          var seen = {}, out = [];
          for (var k = 0; k < scored.length && out.length < 8; k++) {
            var e = scored[k].e, path = pagePath(e.url);
            if (seen[path]) continue;
            seen[path] = 1;
            var snip = (e.content || "").replace(/\s+/g, " ").slice(0, 160);
            out.push(path + "\n    " + (e.title || e.doc || "") +
                     (snip ? " -- " + snip : ""));
          }
          /* Say so when nothing matched the query fully -- a partial hit list
             looks identical to a confident one otherwise. */
          var weak = scored[0].m < terms.length;
          return "Matching pages (pass a path to read_wiki_page):\n\n" +
            out.join("\n") +
            (weak ? "\n\nNote: no page matched all of your terms, so these are " +
                    "partial matches only. Read before relying on any of them." : "");
        }).catch(function (e) {
          return "Could not load the wiki search index: " + e.message;
        });
      }

      if (name === "search_templates") {
        var q = String(args.query || "").toLowerCase();
        if (!q) return Promise.resolve("Empty query.");
        var hits = templates().filter(function (n) { return n.toLowerCase().indexOf(q) !== -1; });
        if (!hits.length) {
          return Promise.resolve(
            "No bundled template matches '" + q + "'. The bundled list is a curated " +
            "subset, so this is not proof it does not exist -- read the hash-lookup " +
            "page for the complete list before telling the user it is absent.");
        }
        return Promise.resolve(hits.slice(0, 60).join("\n") +
          (hits.length > 60 ? "\n... " + (hits.length - 60) + " more" : ""));
      }

      if (name === "inspect_game") {
        var expr = String(args.expr || "");
        if (MUTATORS.test(expr) || !READ_ONLY.test(expr.trim())) {
          return Promise.resolve(
            "Refused: inspect_game is read-only and that looks like it changes state. " +
            "If the user asked for this to happen, use run_lua instead.");
        }
        if (!IDE.bridge || !IDE.bridge.connected()) {
          return Promise.resolve("Not connected to a running game, so this cannot be checked.");
        }
        return IDE.bridge.run(expr).then(function (r) {
          if (!r) return "No result.";
          if (r.timedOut) return "The game did not answer in time.";
          return r.ok ? ("Result: " + JSON.stringify(r.value))
                      : ("Error: " + (r.error || "unknown"));
        });
      }

      if (name === "run_lua") {
        if (!IDE.bridge || !IDE.bridge.connected()) {
          return Promise.resolve("Not connected to a running game.");
        }
        return ui.confirm(args.why || "Run this in the game?", args.code || "")
          .then(function (okd) {
            if (!okd) return "The user declined to run this.";
            return IDE.bridge.run(String(args.code || "")).then(function (r) {
              return r && r.ok ? ("Ran. Result: " + JSON.stringify(r.value))
                               : ("Failed: " + ((r && r.error) || "unknown"));
            });
          });
      }

      if (name === "get_editor") {
        var src = (IDE.editor && IDE.editor.get) ? IDE.editor.get() : "";
        return Promise.resolve(src.trim() ? src : "The editor is empty.");
      }

      return Promise.resolve("Unknown tool: " + name);
    } catch (e) {
      return Promise.resolve("Tool error: " + e.message);
    }
  }

  /* ---- the loop ---------------------------------------------------------- */

  /* messages: full conversation incl. system pack.
     ui: { onStep(name, args), onResult(name, text), confirm(why, code) -> Promise<bool> }
     Resolves { content, steps } -- content is the final assistant text. */
  /* Within a single run the model re-reads `convo` on every step, so a wiki page or
     example read early on rides along — full text — on every step after. Send a COMPACTED
     view instead: the last few tool results stay verbatim (the model is likely acting on
     them now), older ones shrink to a stub that keeps the pairing intact (same role/id) and
     a hint of what was there, so the model can re-call the tool if it truly needs the rest.
     The real `convo` (and the grounding set) stays whole. */
  var KEEP_RAW_RESULTS = 2;   /* default; overridable per profile (settings) */
  var STUB_CHARS = 220;
  function keepRaw() {
    var c = IDE.provider.get(); var n = c && c.keepRawResults;
    return (typeof n === "number" && n >= 1) ? n : KEEP_RAW_RESULTS;
  }
  function compactConvo(convo) {
    var keep = keepRaw();
    var toolIdx = [];
    for (var i = 0; i < convo.length; i++) if (convo[i] && convo[i].role === "tool") toolIdx.push(i);
    if (toolIdx.length <= keep) return convo;
    var stubUntil = toolIdx[toolIdx.length - keep]; /* keep this one + newer raw */
    return convo.map(function (m, i) {
      if (!m || m.role !== "tool" || i >= stubUntil) return m;
      var full = String(m.content || "");
      if (full.length <= STUB_CHARS) return m;
      var stub = full.slice(0, STUB_CHARS).replace(/\s+\S*$/, "") +
        " … [" + (full.length - STUB_CHARS) + " more chars elided to save context; call this tool again if you need the rest]";
      return { role: "tool", tool_call_id: m.tool_call_id, name: m.name, content: stub };
    });
  }

  function run(messages, ui, opts) {
    opts = opts || {};
    var convo = messages.slice();
    var steps = [];
    var nudged = false;
    var cfgSteps = IDE.provider.get().maxSteps;
    var MAX = (typeof cfgSteps === "number" && cfgSteps >= 1) ? cfgSteps : MAX_STEPS;  /* per-profile cap */

    /* Everything the model has legitimately been shown: the reference pack in
       the system message, plus every tool result so far. */
    var grounding = messages.map(function (m) {
      return typeof m.content === "string" ? m.content : "";
    }).join("\n");

    /* The grounding check lives in 85_ground.js, because it is not an
       agent-mode concern -- it applies to every answer from every provider.
       Here it is reused as a self-correction step: catch the ungrounded name
       before the user ever sees it, and give the model one chance to fix it. */
    function ungrounded(text) {
      return IDE.ground.check(text, [grounding]).ungrounded;
    }

    function step(n) {
      return IDE.provider.complete(compactConvo(convo), TOOLS, opts).then(function (res) {
        /* About to answer with API names it was never shown. Nudge once, and
           name them -- a vague "are you sure?" invites the model to restate the
           same thing more confidently. If it still cannot ground them, its
           answer stands and the tool list shows the user what was actually
           consulted. */
        if (!res.toolCalls.length && !nudged) {
          var bad = ungrounded(res.content);
          if (bad.length) {
            nudged = true;
            convo.push(res.raw);
            convo.push({ role: "user", content:
              "Stop. These identifiers appear in your answer but in neither the " +
              "reference above nor anything a tool returned: " +
              bad.join(", ") + ". You did not get them from a source -- do not " +
              "present them as real. Use search_wiki to find the page that " +
              "actually covers this, read it, and answer only from what it " +
              "says. If nothing documents it, say the wiki does not cover it." });
            return step(n);
          }
        }

        if (!res.toolCalls.length || n >= MAX) {
          /* Out of budget with calls still pending: tell the model plainly
             rather than letting it answer as if the calls had succeeded. */
          if (res.toolCalls.length) {
            convo.push({ role: "user", content:
              "Tool budget exhausted. Answer with what you have, and say which " +
              "lookup you did not get to rather than assuming its result." });
            return IDE.provider.complete(compactConvo(convo), null, opts).then(function (f) {
              return { content: f.content, reasoning: f.reasoning, steps: steps };
            });
          }
          return { content: res.content, reasoning: res.reasoning, steps: steps };
        }

        convo.push(res.raw);
        var chain = Promise.resolve();
        res.toolCalls.forEach(function (tc) {
          chain = chain.then(function () {
            var fname = tc.function && tc.function.name;
            var args = {};
            try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); }
            catch (e) { args = {}; }
            if (ui.onStep) ui.onStep(fname, args);
            return execute(fname, args, ui).then(function (out) {
              steps.push({ tool: fname, args: args, result: String(out).slice(0, 400) });
              /* Grow the grounding set as results arrive, or a name the model
                 legitimately just fetched would be flagged as invented. */
              grounding += "\n" + out;
              if (ui.onResult) ui.onResult(fname, String(out));
              convo.push({ role: "tool", tool_call_id: tc.id,
                           name: fname, content: String(out) });
            });
          });
        });
        return chain.then(function () { return step(n + 1); });
      });
    }
    return step(0);
  }

  IDE.agent = { tools: function () { return TOOLS.slice(); }, execute: execute, run: run,
                MAX_STEPS: MAX_STEPS,
                /* The grounding check uses this as a second opinion: the pack is
                   a slice of the wiki, so "absent from the pack" is a weak
                   claim, while "absent from the entire wiki index" is a strong
                   one. Same lazily-loaded index the search tool uses. */
                index: loadIndex };
})();
