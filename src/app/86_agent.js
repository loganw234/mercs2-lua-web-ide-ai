/* 86_agent.js -- the agentic tool harness.
 *
 * Gives the assistant a way to FETCH what it doesn't know instead of guessing.
 * That matters here more than it would elsewhere: this project's whole failure
 * history is confidently-invented identifiers, and every one of those traced to
 * material the model could not see. A pack can only ever hold a slice of the
 * wiki; a tool can reach all of it.
 *
 * Tools:
 *   read_wiki_page(path)     the real page, straight from wiki.mercs2.tools
 *   search_templates(query)  the bundled spawnable-template list
 *   inspect_game(expr)       READ-ONLY Lua in the running game (auto-runs)
 *   run_lua(code)            arbitrary Lua -- ALWAYS asks the user first
 *   get_editor()             the current buffer
 *
 * Safety: `inspect_game` is allowlisted to read-shaped calls so the model can
 * look around freely. Anything that could change the game goes through
 * `run_lua`, which never executes without an explicit click. The split exists
 * so that "let the model explore" does not have to mean "let the model act".
 */
(function () {
  var IDE = window.IDE;

  var WIKI = "https://wiki.mercs2.tools";
  var MAX_PAGE_CHARS = 14000;
  var MAX_STEPS = 6;          /* tool round trips before we stop and answer */

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

  var TOOLS = [
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
  function run(messages, ui, opts) {
    opts = opts || {};
    var convo = messages.slice();
    var steps = [];
    var nudged = false;

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
      return IDE.provider.complete(convo, TOOLS, opts).then(function (res) {
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

        if (!res.toolCalls.length || n >= MAX_STEPS) {
          /* Out of budget with calls still pending: tell the model plainly
             rather than letting it answer as if the calls had succeeded. */
          if (res.toolCalls.length) {
            convo.push({ role: "user", content:
              "Tool budget exhausted. Answer with what you have, and say which " +
              "lookup you did not get to rather than assuming its result." });
            return IDE.provider.complete(convo, null, opts).then(function (f) {
              return { content: f.content, steps: steps };
            });
          }
          return { content: res.content, steps: steps };
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
