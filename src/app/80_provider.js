/* 80_provider.js -- provider-agnostic chat transport for the AI assistant.
 *
 * The IDE talks to whatever endpoint the user configures, in the browser, with
 * the user's own key. Nothing is proxied through a server we run: that keeps
 * cost at zero for us, keeps the key on the user's machine, and is the ONLY way
 * a local model can work at all (a hosted Worker cannot reach localhost).
 *
 * Nearly every provider speaks the OpenAI chat-completions shape, so one adapter
 * covers DeepSeek, OpenAI, OpenRouter, Groq, Together, Fireworks, vLLM, Ollama,
 * LM Studio, llama.cpp and LocalAI. Anthropic needs its own (different message
 * shape, different SSE events, and an explicit opt-in header for browser calls).
 *
 * Exposes IDE.provider:
 *   presets()                  -> [{id, label, baseUrl, model, needsKey, local, note}]
 *   get() / set(cfg)           -> persisted config
 *   configured()               -> bool
 *   chat(messages, opts)       -> Promise, streams via opts.onDelta / onReasoning
 */
(function () {
  var IDE = window.IDE;
  var KEY = "m2ide.ai.cfg";                  /* legacy single config -- migrated from */
  var PKEY = "m2ide.ai.profiles.v1";         /* { active, profiles: [{id, name, ...cfg}] } */

  /* Presets. `tested` marks what we have actually exercised; everything else is
     "should work, unverified" -- CORS is the usual failure and it is
     provider-specific, so we do not claim more than we know. */
  var PRESETS = [
    { id: "deepseek", label: "DeepSeek (recommended)", api: "openai",
      baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-pro",
      needsKey: true, local: false, tested: true,
      note: "1M context -- the only option that fits the full reference pack." },

    { id: "openai", label: "OpenAI", api: "openai",
      baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-terra",
      needsKey: true, local: false, tested: false },

    { id: "openrouter", label: "OpenRouter (free tier works)", api: "openai",
      baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-pro:free",
      needsKey: true, local: false, tested: false,
      note: "The FREE tier works here: make a free account, create a key, and " +
            "pick a model whose name ends in ':free' (rate-limited, no card " +
            "needed). Drop the ':free' suffix to use the paid tier. Designed " +
            "for browser calls; also a good fallback if another host blocks CORS." },

    { id: "anthropic", label: "Anthropic", api: "anthropic",
      baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5",
      needsKey: true, local: false, tested: false,
      note: "Sends the direct-browser-access opt-in header." },

    { id: "ollama", label: "Ollama (local)", api: "openai",
      baseUrl: "http://localhost:11434/v1", model: "qwen3:14b",
      needsKey: false, local: true, tested: true,
      note: "qwen3:14b is the tested pick -- 7/7 on tool use and zero invented " +
            "identifiers. Big models on CPU/RAM: set OLLAMA_KEEP_ALIVE=60m (the " +
            "OpenAI-compatible endpoint ignores per-request keep_alive), raise " +
            "OLLAMA_LOAD_TIMEOUT, and set OLLAMA_CONTEXT_LENGTH=32768 or a small " +
            "model will reserve VRAM for a 131k context it never uses." },

    { id: "lmstudio", label: "LM Studio (local)", api: "openai",
      baseUrl: "http://localhost:1234/v1", model: "local-model",
      needsKey: false, local: true, tested: false,
      note: "Enable CORS in LM Studio's server settings." },

    { id: "llamacpp", label: "llama.cpp server (local)", api: "openai",
      baseUrl: "http://localhost:8080/v1", model: "local-model",
      needsKey: false, local: true, tested: false,
      note: "Start llama-server with --host and CORS allowed." },

    { id: "custom", label: "Custom (OpenAI-compatible)", api: "openai",
      baseUrl: "", model: "", needsKey: false, local: false, tested: false }
  ];

  var DEFAULT = {
    preset: "deepseek",
    api: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    key: "",
    packTier: "small",    /* which bundled tier -- see window.MERCS_PACK_INFO */
    packUrl: "",          /* optional URL override; blank = use packTier */
    modelCtx: 0,          /* user's model context window, tokens; 0 = unknown */
    maxTokens: 4000,
    sendEditor: true,
    sendLog: true,
    agentMode: false,
    /* Advanced, per-profile context tuning — sensible defaults, exposed in settings so a
       profile can be matched to its model (a 40k local model wants different knobs than a
       hosted 1M one). */
    editorMode: "diff",   /* "diff" = full script once then diffs; "full" = whole script every turn */
    trimHistory: true,    /* auto-trim old messages to the model's context window */
    logSend: 40,          /* game-log lines attached per message */
    keepRawResults: 2,    /* agent: tool results kept verbatim (older ones summarized) */
    maxSteps: 10,         /* agent: max tool-call steps per run */
    promptCache: true     /* Anthropic: cache_control breakpoint on the reference pack */
  };

  /* Provider PROFILES. Users keep several named setups -- a free local model, a
     paid frontier one, a hosted DeepSeek -- and switch between them. Internally
     that is a list of profiles with one active; externally get()/set() operate
     on the ACTIVE profile, so every consumer (the panel, agent loop, budget bar)
     is unchanged. Same shape as the chats store: many named things, one current. */
  var store = null;   /* { active, profiles: [{id, name, <DEFAULT fields>}] } */

  function pid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function mkProfile(name, src) {
    var p = { id: pid(), name: name || "Profile" };
    for (var k in DEFAULT) p[k] = (src && k in src) ? src[k] : DEFAULT[k];
    return p;
  }

  function activeProfile() {
    if (!store) return null;
    for (var i = 0; i < store.profiles.length; i++) {
      if (store.profiles[i].id === store.active) return store.profiles[i];
    }
    return store.profiles[0] || null;
  }

  function load() {
    if (store) return activeProfile();
    try { store = JSON.parse(localStorage.getItem(PKEY)); } catch (e) { store = null; }
    if (!store || !Array.isArray(store.profiles) || !store.profiles.length) {
      /* First run on profiles: fold the legacy single config into "Default",
         then delete the old key so there is one home for provider settings. */
      var old = null;
      try { old = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
      var first = mkProfile("Default", old || {});
      store = { active: first.id, profiles: [first] };
      save();
      try { localStorage.removeItem(KEY); } catch (e) {}
    }
    /* backfill any field added since a profile was written; repair bad ids */
    store.profiles.forEach(function (p) {
      for (var k in DEFAULT) if (!(k in p)) p[k] = DEFAULT[k];
      if (!p.id) p.id = pid();
      if (!p.name) p.name = "Profile";
    });
    if (!activeProfile()) store.active = store.profiles[0].id;
    return activeProfile();
  }

  /* Persist and VERIFY it landed. A silent catch here was hiding real failures
     (private-mode / quota / a file:// origin the browser won't grant storage) --
     the settings looked saved and evaporated on reload. Now the failure is
     visible: save() returns false and stashes why, so the panel can say so. */
  var saveErr = null;
  function save() {
    try {
      localStorage.setItem(PKEY, JSON.stringify(store));
      if (localStorage.getItem(PKEY) == null) throw new Error("write did not stick");
      saveErr = null;
      return true;
    } catch (e) {
      saveErr = (e && (e.name || e.message)) || "unknown";
      try { console.warn("[ai] settings NOT persisted:", saveErr); } catch (_) {}
      return false;
    }
  }

  /* ---- SSE line reader shared by both adapters ---------------------------
     Providers differ in what they put in a frame, not in how frames arrive. */
  function readSSE(res, onFrame) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function (c) {
        if (c.done) return;
        buf += dec.decode(c.value, { stream: true });
        var frames = buf.split("\n\n");
        buf = frames.pop();
        for (var i = 0; i < frames.length; i++) {
          var lines = frames[i].split("\n");
          for (var j = 0; j < lines.length; j++) {
            var line = lines[j].trim();
            if (line.lastIndexOf("data:", 0) !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            var obj = null;
            try { obj = JSON.parse(payload); } catch (e) { continue; }
            onFrame(obj);
          }
        }
        return pump();
      });
    }
    return pump();
  }

  function httpError(res) {
    return res.text().then(function (t) {
      var msg = "";
      try { var j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.message || ""; }
      catch (e) { msg = t.slice(0, 300); }
      var hint = "";
      if (res.status === 401 || res.status === 403) hint = " -- check the API key.";
      else if (res.status === 404) hint = " -- check the base URL and model name.";
      else if (res.status === 429) hint = " -- rate limited by the provider.";
      throw new Error("HTTP " + res.status + (msg ? ": " + msg : "") + hint);
    });
  }

  /* ---- adapters --------------------------------------------------------- */

  function chatOpenAI(c, messages, opts) {
    var headers = { "content-type": "application/json" };
    if (c.key) headers.authorization = "Bearer " + c.key;
    var body = {
      model: c.model,
      messages: messages,
      stream: true,
      max_tokens: c.maxTokens
    };
    return fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST", headers: headers, body: JSON.stringify(body), signal: opts.signal
    }).then(function (res) {
      if (!res.ok) return httpError(res);
      return readSSE(res, function (o) {
        var d = o.choices && o.choices[0] && o.choices[0].delta;
        if (!d) return;
        /* Chain-of-thought streams under different names per provider:
           DeepSeek says reasoning_content, Ollama/OpenRouter say reasoning.
           Missing this looks like "streaming is broken" on a thinking model --
           every token until the final answer is silently dropped. */
        var r = d.reasoning_content || d.reasoning;
        if (r && opts.onReasoning) opts.onReasoning(r);
        if (d.content && opts.onDelta) opts.onDelta(d.content);
      });
    });
  }

  function chatAnthropic(c, messages, opts) {
    /* Anthropic takes the system prompt as a top-level field, not a message. */
    var system = "";
    var rest = [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") system += (system ? "\n\n" : "") + messages[i].content;
      else rest.push({ role: messages[i].role, content: messages[i].content });
    }
    return fetch(c.baseUrl.replace(/\/+$/, "") + "/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": c.key,
        "anthropic-version": "2023-06-01",
        /* required for calls made straight from a browser */
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: c.model, system: anthropicSystem(c, system), messages: rest,
        max_tokens: c.maxTokens, stream: true
      }),
      signal: opts.signal
    }).then(function (res) {
      if (!res.ok) return httpError(res);
      return readSSE(res, function (o) {
        if (o.type === "content_block_delta" && o.delta) {
          if (o.delta.type === "text_delta" && o.delta.text && opts.onDelta) opts.onDelta(o.delta.text);
          if (o.delta.type === "thinking_delta" && o.delta.thinking && opts.onReasoning) {
            opts.onReasoning(o.delta.thinking);
          }
        }
      });
    });
  }

  /* Streamed completion, with optional tools.
   *
   * This IS streamed, so agent mode shows the model thinking and answering live
   * -- locally-hosted users specifically want to watch and abort a run that
   * goes off the rails. Tool calls are assembled from the SSE deltas: the
   * OpenAI shape sends, per call index, the id + name in the first frame and
   * the JSON arguments in fragments across later frames, so id/name are set
   * once and arguments are concatenated. content and reasoning forward live via
   * opts.onDelta / opts.onReasoning. Returns the same shape as before. */
  function completeOpenAI(c, messages, tools, opts) {
    var headers = { "content-type": "application/json" };
    if (c.key) headers.authorization = "Bearer " + c.key;
    var body = { model: c.model, messages: messages, stream: true,
                 max_tokens: c.maxTokens };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
    var content = "", reasoning = "", calls = [];
    return fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST", headers: headers, body: JSON.stringify(body), signal: opts.signal
    }).then(function (res) {
      if (!res.ok) return httpError(res);
      return readSSE(res, function (o) {
        var d = o.choices && o.choices[0] && o.choices[0].delta;
        if (!d) return;
        var r = d.reasoning_content || d.reasoning;
        if (r) { reasoning += r; if (opts.onReasoning) opts.onReasoning(r); }
        if (d.content) { content += d.content; if (opts.onDelta) opts.onDelta(d.content); }
        if (d.tool_calls) {
          for (var i = 0; i < d.tool_calls.length; i++) {
            var tc = d.tool_calls[i];
            var idx = tc.index != null ? tc.index : i;
            if (!calls[idx]) calls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
            /* id and name arrive whole in the first frame (some backends resend
               them every frame) -- set once. Arguments are the streamed part. */
            if (tc.id && !calls[idx].id) calls[idx].id = tc.id;
            if (tc.function) {
              if (tc.function.name && !calls[idx].function.name) calls[idx].function.name = tc.function.name;
              if (tc.function.arguments) calls[idx].function.arguments += tc.function.arguments;
            }
          }
        }
      }).then(function () {
        var toolCalls = calls.filter(Boolean);
        var raw = { role: "assistant", content: content };
        if (toolCalls.length) raw.tool_calls = toolCalls;
        return { content: content, toolCalls: toolCalls, reasoning: reasoning, raw: raw };
      });
    });
  }

  /* The agent loop (86_agent.js) speaks the OpenAI shape throughout -- its
     conversation carries OpenAI-style assistant tool_calls and {role:"tool"}
     results. This converts that conversation on every request rather than
     making the loop provider-aware: system messages lift to the top-level
     field, tool results fold into user-role tool_result blocks (consecutive
     ones merged -- Anthropic wants them in ONE user turn), and assistant
     tool_calls become tool_use blocks. */
  /* Prompt caching. OpenAI/DeepSeek cache a stable prefix automatically (no markup) — we
     already keep [pack, …turns] ordering so that just works. Anthropic needs an explicit
     cache_control breakpoint: mark the whole system block (the reference pack, the big stable
     prefix — 11k–241k tokens) so a warm turn re-reads it from cache instead of re-billing it.
     Below Anthropic's ~1k-token minimum, caching does nothing, so leave the plain string. */
  function anthropicSystem(c, system) {
    if (c.promptCache !== false && system && system.length >= 4096) {
      return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    }
    return system;
  }

  function toAnthropic(messages) {
    var system = "", out = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === "system") { system += (system ? "\n\n" : "") + m.content; continue; }
      if (m.role === "tool") {
        var block = { type: "tool_result", tool_use_id: m.tool_call_id || "",
                      content: String(m.content || "") };
        var prev = out[out.length - 1];
        if (prev && prev.role === "user" && Array.isArray(prev.content)) prev.content.push(block);
        else out.push({ role: "user", content: [block] });
        continue;
      }
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
        var content = [];
        if (m.content) content.push({ type: "text", text: String(m.content) });
        for (var t = 0; t < m.tool_calls.length; t++) {
          var tc = m.tool_calls[t], input = {};
          try { input = JSON.parse((tc.function && tc.function.arguments) || "{}"); }
          catch (e) { input = {}; }
          content.push({ type: "tool_use", id: tc.id,
                         name: tc.function && tc.function.name, input: input });
        }
        out.push({ role: "assistant", content: content });
        continue;
      }
      out.push({ role: m.role, content: m.content });
    }
    return { system: system, messages: out };
  }

  function completeAnthropic(c, messages, tools, opts) {
    var conv = toAnthropic(messages);
    var body = { model: c.model, system: anthropicSystem(c, conv.system), messages: conv.messages,
                 max_tokens: c.maxTokens, stream: false };
    if (tools && tools.length) {
      body.tools = tools.map(function (t) {
        return { name: t.function.name, description: t.function.description,
                 input_schema: t.function.parameters };
      });
    }
    return fetch(c.baseUrl.replace(/\/+$/, "") + "/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": c.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body), signal: opts.signal
    }).then(function (res) {
      if (!res.ok) return httpError(res);
      return res.json();
    }).then(function (j) {
      var text = "", reasoning = "", toolCalls = [];
      (j.content || []).forEach(function (b) {
        if (b.type === "text") text += b.text || "";
        else if (b.type === "thinking") reasoning += b.thinking || "";
        else if (b.type === "tool_use") {
          /* back to the OpenAI shape the loop executes against */
          toolCalls.push({ id: b.id, type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        }
      });
      /* raw is what the loop pushes back into the conversation, so it must be
         OpenAI-shaped too -- toAnthropic re-converts it on the next round. */
      var raw = { role: "assistant", content: text };
      if (toolCalls.length) raw.tool_calls = toolCalls;
      return { content: text, toolCalls: toolCalls, reasoning: reasoning, raw: raw };
    });
  }

  IDE.provider = {
    presets: function () { return PRESETS.slice(); },
    /* Used by the agent loop. Both adapters return the same OpenAI-shaped
       {content, toolCalls, reasoning, raw} so the loop stays provider-blind. */
    complete: function (messages, tools, opts) {
      var c = load();
      opts = opts || {};
      var fn = c.api === "anthropic" ? completeAnthropic : completeOpenAI;
      return fn(c, messages, tools, opts);
    },
    preset: function (id) {
      for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
      return null;
    },
    get: function () { return load(); },
    set: function (patch) {
      var c = load();
      for (var k in patch) if (k in DEFAULT) c[k] = patch[k];
      var ok = save();
      IDE.bus.emit("ai:config", c);
      return ok;                      /* false = did not persist (see saveError) */
    },
    saveError: function () { return saveErr; },

    /* ---- profiles ---------------------------------------------------------
       Named provider setups, one active. get()/set() above act on the active
       one, so these are the only extra surface a caller needs. */
    profiles: function () {
      load();
      return store.profiles.map(function (p) { return { id: p.id, name: p.name }; });
    },
    activeProfileId: function () { load(); return store.active; },
    switchProfile: function (id) {
      load();
      for (var i = 0; i < store.profiles.length; i++) {
        if (store.profiles[i].id === id) {
          store.active = id; save();
          IDE.bus.emit("ai:config", store.profiles[i]);
          IDE.bus.emit("ai:profiles");
          return true;
        }
      }
      return false;
    },
    /* Create a profile and make it active. `copyActive` starts it from the
       current profile's values (tweak one field) rather than blank defaults. */
    newProfile: function (name, copyActive) {
      load();
      var p = mkProfile(name, copyActive ? activeProfile() : null);
      store.profiles.push(p);
      store.active = p.id;
      save();
      IDE.bus.emit("ai:config", p);
      IDE.bus.emit("ai:profiles");
      return p.id;
    },
    renameProfile: function (id, name) {
      load();
      if (!name || !name.trim()) return false;
      for (var i = 0; i < store.profiles.length; i++) {
        if (store.profiles[i].id === id) {
          store.profiles[i].name = name.trim(); save();
          IDE.bus.emit("ai:profiles");
          return true;
        }
      }
      return false;
    },
    deleteProfile: function (id) {
      load();
      if (store.profiles.length <= 1) return false;   /* always keep one */
      var idx = -1;
      for (var i = 0; i < store.profiles.length; i++) if (store.profiles[i].id === id) { idx = i; break; }
      if (idx < 0) return false;
      store.profiles.splice(idx, 1);
      if (store.active === id) store.active = store.profiles[0].id;
      save();
      IDE.bus.emit("ai:config", activeProfile());
      IDE.bus.emit("ai:profiles");
      return true;
    },
    configured: function () {
      var c = load();
      if (!c.baseUrl || !c.model) return false;
      var p = this.preset(c.preset);
      if (p && p.needsKey && !c.key) return false;
      return true;
    },
    /* messages: [{role, content}] -- system first. Streams through opts. */
    chat: function (messages, opts) {
      var c = load();
      opts = opts || {};
      if (!c.baseUrl || !c.model) {
        return Promise.reject(new Error("No provider configured -- open Assistant settings."));
      }
      var fn = c.api === "anthropic" ? chatAnthropic : chatOpenAI;
      return fn(c, messages, opts).catch(function (e) {
        if (e && e.name === "AbortError") throw e;
        /* A browser CORS rejection surfaces as an opaque TypeError, which is
           useless on its own -- name the likely cause instead. */
        if (e instanceof TypeError) {
          /* The browser gives an opaque TypeError for both "nothing is
             listening" and "CORS refused" -- it deliberately will not tell a
             page which. Name both, most likely first for a local endpoint. */
          var local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(c.baseUrl);
          throw new Error(
            "Could not reach " + c.baseUrl + ". Either nothing is listening there" +
            (local ? " (is the server actually running?)" : "") +
            ", or the provider refused the request from this page's origin (CORS). " +
            "The browser will not say which. Local servers usually need CORS " +
            "enabled explicitly: Ollama OLLAMA_ORIGINS, LM Studio has a toggle.");
        }
        throw e;
      });
    }
  };
})();
