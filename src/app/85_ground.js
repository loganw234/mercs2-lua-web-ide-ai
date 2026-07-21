/* 85_ground.js -- did the model actually get this from somewhere?
 *
 * The single failure mode this whole project keeps hitting is an invented
 * identifier stated confidently: a namespace, a module, a method that does not
 * exist. Five rounds of wiki auditing, the local-model benchmark's `invented`
 * column, and three live agent runs all reduce to it. Prompt rules reduce it.
 * Tool access reduces it. Neither eliminates it -- a model read the correct
 * page and still answered with a function that was not on it.
 *
 * So stop asking the model to be careful and check the claim instead. Every
 * API-shaped name in an answer either appears in something the model was shown
 * -- the reference pack, a tool result, the user's own buffer -- or it does
 * not. If it does not, the model did not get it from anywhere we can point at.
 *
 * This is deliberately NOT part of the agent loop. It needs no tools, no
 * particular provider, and no cooperation from the model, so it applies to
 * every answer: streamed or agentic, DeepSeek or a 0.5B running on a laptop.
 * When the model will not correct itself, the user still gets told.
 *
 * It is a heuristic and it is honest about that: it proves a name was NOT in
 * the sources, never that a name is wrong. Grounded is not the same as correct.
 */
(function () {
  var IDE = window.IDE;

  /* Dotted references -- Ai.Goal, Pg.Spawn, MrxFollow.Create, MrxFollow.follow.
   *
   * The method half is deliberately case-insensitive. An earlier version
   * required it to start uppercase and therefore sailed straight past
   * `MrxFollow.follow(npc, player)` -- a fabricated call on a real module,
   * which is the most plausible-looking kind of wrong answer there is. Engine
   * calls here are PascalCase but resident modules expose lowercase methods,
   * so the narrow pattern was checking the half of the API least likely to be
   * invented.
   *
   * Bare words are still not checked: too noisy to be useful. */
  var API_RE = /\b[A-Z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*\b/g;

  /* Filenames match the pattern and are not API references. The wiki is full of
     "mrxfollow.lua" and "vz-patch.wad", and flagging those would be constant
     noise. */
  var FILE_EXT = /\.(lua|gfx|wad|json|md|html?|txt|ini|asi|exe|py|js|css|png|jpe?g|csv|zip|bin|dll|toml|yml|yaml)$/i;

  /* Prose collisions that match the pattern but are not API references. */
  var IGNORE = { "U.S": 1, "I.E": 1, "E.G": 1 };

  function names(text) {
    var hits = String(text || "").match(API_RE) || [];
    var out = [], seen = {};
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (seen[h] || IGNORE[h] || FILE_EXT.test(h)) continue;
      seen[h] = 1;
      out.push(h);
    }
    return out;
  }

  /* answer: the model's text. sources: array of strings it was shown.
     -> { ungrounded: [names], checked: n } */
  function check(answer, sources) {
    var hay = (sources || []).join("\n");
    var all = names(answer);
    var bad = [];
    for (var i = 0; i < all.length; i++) {
      if (hay.indexOf(all[i]) === -1) bad.push(all[i]);
    }
    return { ungrounded: bad, checked: all.length };
  }

  /* Second pass: are these names documented ANYWHERE on the wiki?
   *
   * `check` only proves a name was not in what the model was shown, and the
   * pack is a slice of the wiki -- so on the small tier that fires on plenty of
   * perfectly real functions. This resolves the ambiguity against the full
   * index: `absent` really is undocumented, `elsewhere` is real and merely
   * outside the pack. Only `absent` deserves a warning.
   *
   * -> Promise<{absent: [], elsewhere: []}>, rejects if the index is unreachable.
   */
  function verify(candidates) {
    if (!candidates || !candidates.length) {
      return Promise.resolve({ absent: [], elsewhere: [] });
    }
    if (!IDE.agent || !IDE.agent.index) {
      return Promise.reject(new Error("no wiki index available"));
    }
    return IDE.agent.index().then(function (idx) {
      var hay = "";
      for (var i = 0; i < idx.length; i++) {
        hay += (idx[i].title || "") + "\n" + (idx[i].content || "") + "\n";
      }
      var absent = [], elsewhere = [];
      for (var k = 0; k < candidates.length; k++) {
        (hay.indexOf(candidates[k]) === -1 ? absent : elsewhere).push(candidates[k]);
      }
      return { absent: absent, elsewhere: elsewhere };
    });
  }

  IDE.ground = { check: check, names: names, verify: verify };
})();
