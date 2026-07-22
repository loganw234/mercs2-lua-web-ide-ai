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
  var KEY = "m2ide.ai.cfg";

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
    maxTokens: 4000,
    sendEditor: true,
    sendLog: true,
    agentMode: false
  };

  var cfg = null;

  function load() {
    if (cfg) return cfg;
    cfg = {};
    for (var k in DEFAULT) cfg[k] = DEFAULT[k];
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var got = JSON.parse(raw);
        for (var g in got) if (g in DEFAULT) cfg[g] = got[g];
      }
    } catch (e) { /* corrupt or blocked storage -- defaults are fine */ }
    return cfg;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
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
        model: c.model, system: system, messages: rest,
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

  /* Non-streaming completion, with optional tools.
   *
   * The tool loop is deliberately NOT streamed. Assembling tool_calls out of
   * SSE deltas means stitching partial JSON argument fragments across frames,
   * and providers disagree about how they chunk them -- a good way to ship a
   * parser that works on one backend and silently mangles another. Tool turns
   * are short; the final answer is what the user waits on, and that still
   * streams through chat(). */
  function completeOpenAI(c, messages, tools, opts) {
    var headers = { "content-type": "application/json" };
    if (c.key) headers.authorization = "Bearer " + c.key;
    var body = { model: c.model, messages: messages, stream: false,
                 max_tokens: c.maxTokens };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
    return fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST", headers: headers, body: JSON.stringify(body), signal: opts.signal
    }).then(function (res) {
      if (!res.ok) return httpError(res);
      return res.json();
    }).then(function (j) {
      var m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      return { content: m.content || "", toolCalls: m.tool_calls || [],
               reasoning: m.reasoning_content || m.reasoning || "", raw: m };
    });
  }

  /* The agent loop (86_agent.js) speaks the OpenAI shape throughout -- its
     conversation carries OpenAI-style assistant tool_calls and {role:"tool"}
     results. This converts that conversation on every request rather than
     making the loop provider-aware: system messages lift to the top-level
     field, tool results fold into user-role tool_result blocks (consecutive
     ones merged -- Anthropic wants them in ONE user turn), and assistant
     tool_calls become tool_use blocks. */
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
    var body = { model: c.model, system: conv.system, messages: conv.messages,
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
      load();
      for (var k in patch) if (k in DEFAULT) cfg[k] = patch[k];
      save();
      IDE.bus.emit("ai:config", cfg);
      return cfg;
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
