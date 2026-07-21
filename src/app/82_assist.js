/* 82_assist.js -- the AI assistant panel.
 *
 * Talks to whatever IDE.provider is configured (see 80_provider.js). The value
 * over the wiki's chat page is context: this one can see the editor buffer and
 * the live game log, so "why is this failing?" needs no copy-paste.
 *
 * The reference pack is prepended as the system message. It is a stable prefix,
 * which matters for cost on providers that cache prefixes -- so it must be sent
 * byte-identical every turn and nothing dynamic may precede it.
 */
(function () {
  var IDE = window.IDE, $ = IDE.$;

  var LOG_KEEP = 120;          /* log lines retained for context */
  var LOG_SEND = 40;           /* how many we actually attach */
  var EDITOR_MAX = 60000;      /* chars of the buffer we will attach */
  var STORE = "m2ide.ai.chat";

  var logRing = [];
  var history = [];            /* {role, content, display?, think?} */
  var busy = false, abortCtl = null, packText = null;

  /* ---- context capture --------------------------------------------------- */

  IDE.bus.on("log", function (d) {
    if (!d || !d.line) return;
    logRing.push(String(d.line));
    if (logRing.length > LOG_KEEP) logRing.shift();
  });

  function editorText() {
    try { return (IDE.editor && IDE.editor.get) ? IDE.editor.get() : ""; }
    catch (e) { return ""; }
  }

  function buildContext() {
    var c = IDE.provider.get();
    var parts = [];
    if (c.sendEditor) {
      var src = editorText();
      if (src.trim()) {
        if (src.length > EDITOR_MAX) src = src.slice(0, EDITOR_MAX) + "\n-- [truncated]";
        parts.push("--- current editor buffer ---\n```lua\n" + src + "\n```\n--- end buffer ---");
      }
    }
    if (c.sendLog && logRing.length) {
      var tail = logRing.slice(-LOG_SEND).join("\n");
      parts.push("--- recent game log (newest last) ---\n```\n" + tail + "\n```\n--- end log ---");
    }
    return parts.join("\n\n");
  }

  /* ---- pack -------------------------------------------------------------- */

  /* Ask Ollama how much context the chosen model actually has, and warn if the
     pack cannot fit.
     Why this exists: gemma2:27b reports CONTEXT 8192. Feeding it the 14.8k
     "small" pack truncates silently, and the truncation eats the FRONT -- a
     canary at position 0 did not survive. The front is the system rules and the
     tier banner, so the user ends up with a model that looks configured, has
     lost every anti-invention instruction, and says nothing about it. Ollama is
     the only provider we can ask cheaply, so we only check there. */
  function checkContext() {
    var c = IDE.provider.get();
    if (!/localhost:11434|127\.0\.0\.1:11434/.test(c.baseUrl)) return;
    var root = c.baseUrl.replace(/\/v1\/?$/, "");
    fetch(root + "/api/show", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: c.model })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.model_info) return;
      var ctx = 0;
      for (var k in d.model_info) {
        if (/\.context_length$/.test(k)) { ctx = d.model_info[k]; break; }
      }
      /* Agent mode needs a model that emits tool calls. Ollama reports a
         capability list, and a MISSING "tools" entry is reliable -- gemma2:27b
         omits it and cannot do this at all. The presence of it is NOT reliable:
         qwen2.5-coder declares "tools" and then never emits a call, even for a
         one-line system prompt and an unmissable question. So only the negative
         is worth a hard warning; the positive gets no promise. */
      var caps = d.capabilities || [];
      if (IDE.provider.get().agentMode && caps.indexOf("tools") === -1) {
        setStatus(c.model + " does not support tool calling, so agent mode " +
          "cannot work with it. Turn agent mode off, or switch to a model that " +
          "does (llama3.1:8b is the one verified here).", true);
      }

      if (!ctx || packText === null) return;
      var need = Math.ceil(packText.length / 4) + 1500;   /* pack + room to talk */
      if (need > ctx) {
        setStatus("Warning: " + c.model + " has a " + ctx.toLocaleString() +
          "-token context but the reference pack needs about " +
          need.toLocaleString() + ". It will be silently truncated from the " +
          "front, losing the rules that stop it inventing API names. Use a " +
          "smaller pack tier (set Pack URL to pack-tiny.txt) or a longer-context model.",
          true);
      }
    }).catch(function () { /* best effort only */ });
  }

  function loadPack() {
    if (packText !== null) return Promise.resolve(packText);
    var c = IDE.provider.get();
    if (c.packUrl) {
      return fetch(c.packUrl).then(function (r) {
        if (!r.ok) throw new Error("pack fetch failed: HTTP " + r.status);
        return r.text();
      }).then(function (t) { packText = t; return t; });
    }
    packText = window.MERCS_PACK || "";
    return Promise.resolve(packText);
  }

  /* ---- rendering (ported from the wiki assistant) ------------------------- */

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(md) {
    return md
      .replace(/`([^`\n]+)`/g, function (_, c) { return "<code>" + c + "</code>"; })
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+[^\s<).,])/g,
        '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }

  /* A table only starts once its |---| separator has arrived. Without this
     look-ahead the first row of a streaming table is claimed by no branch and
     the paragraph loop spins forever. */
  function isTable(lines, i) {
    return /^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]);
  }

  function prose(text) {
    var lines = esc(text).split("\n"), html = "", i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      if (isTable(lines, i)) {
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        html += '<div class="ai-tw"><table>';
        rows.forEach(function (r, n) {
          var cells = r.replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); });
          if (n === 1 && cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) return;
          var tag = n === 0 ? "th" : "td";
          html += "<tr>" + cells.map(function (c) {
            return "<" + tag + ">" + inline(c) + "</" + tag + ">";
          }).join("") + "</tr>";
        });
        html += "</table></div>";
        continue;
      }
      var h = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (h) { html += '<div class="ai-h">' + inline(h[2]) + "</div>"; i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        var ordered = /^\s*\d+\./.test(lines[i]), items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "")); i++;
        }
        var t = ordered ? "ol" : "ul";
        html += "<" + t + ">" + items.map(function (x) { return "<li>" + inline(x) + "</li>"; }).join("") + "</" + t + ">";
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,6})\s|^\s*([-*]|\d+\.)\s/.test(lines[i]) && !isTable(lines, i)) {
        para.push(lines[i]); i++;
      }
      if (!para.length) { para.push(lines[i]); i++; }
      html += "<p>" + inline(para.join("<br>")) + "</p>";
    }
    return html;
  }

  function render(text) {
    var out = "", parts = text.split("```");
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var m = parts[i].match(/^([a-zA-Z0-9_-]*)\n([\s\S]*)$/);
        var lang = m ? (m[1] || "code") : "code";
        var code = (m ? m[2] : parts[i]).replace(/\n$/, "");
        out += '<div class="ai-code"><div class="ai-codehead"><span>' + esc(lang) +
          '</span><span class="ai-codeacts">' +
          '<button type="button" class="ai-mini ai-copy">Copy</button>' +
          (/^lua$/i.test(lang) ? '<button type="button" class="ai-mini ai-insert">Insert</button>' +
            '<button type="button" class="ai-mini ai-replace">Replace</button>' : "") +
          '</span></div><pre><code>' + esc(code) + "</code></pre></div>";
      } else {
        out += prose(parts[i]);
      }
    }
    return out;
  }

  function splitThink(raw) {
    if (raw.lastIndexOf("<think>", 0) !== 0) return { think: "", rest: raw };
    var e = raw.indexOf("</think>");
    if (e === -1) return { think: raw.slice(7), rest: "" };
    return { think: raw.slice(7, e), rest: raw.slice(e + 8) };
  }

  /* ---- DOM --------------------------------------------------------------- */

  function logEl() { return $("aiLog"); }

  function addRow(who, label) {
    var el = document.createElement("div");
    el.className = "ai-row ai-" + who;
    el.innerHTML = '<div class="ai-who">' + label + "</div>" +
      '<details class="ai-think" hidden><summary>Thinking...</summary><div class="ai-thinkbody"></div></details>' +
      '<div class="ai-body"></div>';
    logEl().appendChild(el);
    logEl().scrollTop = logEl().scrollHeight;
    return el;
  }

  function setStatus(msg, err) {
    var s = $("aiStatus");
    if (!s) return;
    s.textContent = msg || "";
    s.className = err ? "ai-status ai-err" : "ai-status";
  }

  function setBusy(b) {
    busy = b;
    var send = $("aiSend");
    if (send) { send.textContent = b ? "Stop" : "Ask"; send.classList.toggle("stopping", b); }
  }

  /* ---- send -------------------------------------------------------------- */

  function ask() {
    if (busy) { if (abortCtl) abortCtl.abort(); return; }
    var input = $("aiInput");
    var q = (input.value || "").trim();
    if (!q) return;

    if (!IDE.provider.configured()) {
      setStatus("Configure a provider first (gear icon).", true);
      openSettings();
      return;
    }

    var ctx = buildContext();
    var content = ctx ? (q + "\n\n" + ctx) : q;
    history.push({ role: "user", content: content, display: q });
    var urow = addRow("user", "You");
    urow.querySelector(".ai-body").innerHTML = "<p>" + esc(q).replace(/\n/g, "<br>") + "</p>";
    input.value = "";
    autoGrow();
    setStatus("");

    var row = addRow("bot", "Assistant");
    var body = row.querySelector(".ai-body");
    var think = row.querySelector(".ai-think");
    var tbody = row.querySelector(".ai-thinkbody");
    body.innerHTML = '<span class="ai-cursor">|</span>';

    var reasoning = "", answer = "", toolText = "";
    abortCtl = new AbortController();
    setBusy(true);

    /* Long-wait feedback.
     *
     * A 27B running on system RAM can take MINUTES before the first token, and
     * with stream:true the provider sends absolutely nothing until then -- so
     * without this the panel looks frozen and people kill it or reload.
     *
     * There is deliberately NO client-side timeout anywhere in this path: the
     * fetch carries only the user's abort signal. Slow is not an error. The
     * ticker exists purely so the user can see it is still alive and decide for
     * themselves whether to wait. */
    var t0 = Date.now(), firstToken = 0, tick = null;
    function waited() { return Math.round((Date.now() - t0) / 1000); }
    function tickStatus() {
      if (firstToken) return;
      var s = waited();
      var msg = "Waiting for the model... " + s + "s";
      if (s >= 300) {
        msg += " -- past Ollama's default 5-minute load timeout; if this is a " +
               "first run, raise OLLAMA_LOAD_TIMEOUT and retry.";
      } else if (s >= 120) {
        msg += " -- still going. A large model loading from disk into RAM can " +
               "take this long the first time.";
      } else if (s >= 25) {
        msg += " -- normal for a large local model, especially on CPU/RAM.";
      }
      setStatus(msg);
    }
    tick = setInterval(tickStatus, 1000);
    tickStatus();
    function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

    function paint() {
      var st = splitThink(answer);
      var all = (reasoning + st.think).trim();
      if (all) {
        think.hidden = false;
        tbody.textContent = all;
        if (!st.rest) think.open = true;
      }
      if (st.rest) {
        if (think.open) think.open = false;
        body.innerHTML = render(st.rest) + '<span class="ai-cursor">|</span>';
      }
      logEl().scrollTop = logEl().scrollHeight;
    }

    loadPack().then(function (pack) {
      checkContext();
      var msgs = [];
      if (pack) msgs.push({ role: "system", content: pack });
      for (var i = 0; i < history.length; i++) {
        msgs.push({ role: history[i].role, content: history[i].content });
      }

      /* Agent mode runs a non-streaming tool loop, so nothing would appear for
         many seconds. Show each tool call as it happens instead -- it is also
         the only way the user can see WHAT the model looked at, which is the
         point of having tools at all. */
      if (IDE.provider.get().agentMode && IDE.agent) {
        var toolsEl = document.createElement("div");
        toolsEl.className = "ai-tools";
        body.parentNode.insertBefore(toolsEl, body);
        return IDE.agent.run(msgs, {
          onStep: function (name, args) {
            firstToken = firstToken || Date.now();
            stopTick();
            var d = document.createElement("div");
            d.className = "ai-tool pending";
            var detail = args.path || args.query || args.expr || args.why || "";
            d.textContent = "> " + name + (detail ? "  " + detail : "");
            toolsEl.appendChild(d);
            logEl().scrollTop = logEl().scrollHeight;
          },
          onResult: function (name, out) {
            toolText += "\n" + out;
            var last = toolsEl.querySelector(".ai-tool.pending:last-child") ||
                       toolsEl.lastChild;
            if (last) {
              last.classList.remove("pending");
              last.classList.toggle("bad", /^(Refused|Could not|Error|Failed|That page does not exist|Not connected)/.test(out));
            }
          },
          confirm: function (why, code) { return askConfirm(why, code); }
        }, { signal: abortCtl.signal }).then(function (r) {
          answer = r.content || "";
          return null;
        });
      }

      function sawToken() {
        if (firstToken) return;
        firstToken = Date.now();
        stopTick();
        setStatus("");
      }
      return IDE.provider.chat(msgs, {
        signal: abortCtl.signal,
        onReasoning: function (t) { sawToken(); reasoning += t; paint(); },
        onDelta: function (t) { sawToken(); answer += t; paint(); }
      });
    }).then(function () {
      finish(false);
    }).catch(function (e) {
      stopTick();
      if (e && e.name === "AbortError") { finish(true); return; }
      row.remove();
      setBusy(false);
      abortCtl = null;
      var msg = e && e.message ? e.message : String(e);
      /* Give the wait context: "failed after 4 minutes" points at a model-load
         problem, "failed after 0.2s" points at a wrong URL or bad key. */
      setStatus(msg + "  (after " + waited() + "s)", true);
    });

    function finish(stopped) {
      stopTick();
      setStatus("");
      var st = splitThink(answer);
      var all = (reasoning + st.think).trim();
      if (st.rest || all) {
        history.push({ role: "assistant", content: st.rest || "(no answer)", think: all || undefined });
        body.innerHTML = render(st.rest || "");

        /* Flag API names the model was never shown.
         *
         * This runs on EVERY answer, not just agent mode, because it needs
         * nothing from the model: no tool support, no instruction-following,
         * no particular provider. That matters because the local model with
         * the best domain knowledge here (qwen2.5-coder) cannot call tools at
         * all -- so self-correction is unavailable to exactly the users most
         * likely to get an invented answer. Telling the user directly is the
         * only guarantee that does not depend on the model cooperating. */
        var g = IDE.ground.check(st.rest || "", [packText || "", toolText]);
        if (g.ungrounded.length) {
          var w = document.createElement("div");
          w.className = "ai-ungrounded";
          w.textContent = "Checking " + g.ungrounded.length +
            " identifier(s) against the wiki…";
          body.appendChild(w);

          /* Second opinion against the FULL wiki index.
             The pack is only a slice of the wiki -- measured, 4 of 14 known-real
             functions are missing from the small tier -- so "absent from the
             pack" would fire on roughly a third of correct answers, and a
             warning that cries wolf gets ignored, which is worse than no
             warning. The index covers every page, so a name missing from it is
             a claim worth making. */
          IDE.ground.verify(g.ungrounded).then(function (v) {
            if (!v.absent.length) {
              /* All real, just outside the pack. Say nothing -- a warning here
                 would be pure noise. */
              w.remove();
              return;
            }
            w.className = "ai-ungrounded";
            w.innerHTML = "<strong>Not documented:</strong> " +
              esc(v.absent.join(", ")) +
              " — " + (v.absent.length === 1 ? "this name does" : "these names do") +
              " not appear anywhere in the wiki. Treat as invented until you " +
              "confirm it yourself." +
              (v.elsewhere.length
                ? "<br><span class=\"ai-ok\">" + esc(v.elsewhere.join(", ")) +
                  " checked out — documented, just not in the loaded pack.</span>"
                : "");
          }).catch(function () {
            /* Offline or the index would not load: fall back to the weaker
               claim rather than dropping the warning entirely. */
            w.innerHTML = "<strong>Unverified:</strong> " +
              esc(g.ungrounded.join(", ")) +
              " — not in the reference pack, and the wiki index could not be " +
              "reached to check further.";
          });
        }
        if (all) { think.hidden = false; think.open = false; think.querySelector("summary").textContent = "Thought process"; }
        persist();
      } else {
        row.remove();
        if (!stopped) setStatus("No answer came back.", true);
      }
      setBusy(false);
      abortCtl = null;
    }
  }

  function persist() {
    try { sessionStorage.setItem(STORE, JSON.stringify({ h: history })); } catch (e) {}
  }

  function newChat() {
    if (busy && abortCtl) abortCtl.abort();
    history = [];
    logEl().innerHTML = "";
    setStatus("");
    try { sessionStorage.removeItem(STORE); } catch (e) {}
  }

  /* Confirmation gate for run_lua. Model-written Lua executing in someone's
     running game is the one genuinely dangerous thing here, so it is never
     implicit: the code is shown verbatim and nothing happens without a click. */
  function askConfirm(why, code) {
    return new Promise(function (resolve) {
      var wrap = document.createElement("div");
      wrap.className = "ai-confirm";
      wrap.innerHTML =
        '<div class="ai-confirm-why"></div>' +
        '<pre class="ai-confirm-code"></pre>' +
        '<div class="ai-confirm-acts">' +
        '<button type="button" class="ai-btn ai-yes">Run it</button>' +
        '<button type="button" class="ai-mini ai-no">Don\'t run</button></div>';
      wrap.querySelector(".ai-confirm-why").textContent = why;
      wrap.querySelector(".ai-confirm-code").textContent = code;
      logEl().appendChild(wrap);
      logEl().scrollTop = logEl().scrollHeight;
      function done(v) { wrap.remove(); resolve(v); }
      wrap.querySelector(".ai-yes").onclick = function () { done(true); };
      wrap.querySelector(".ai-no").onclick = function () { done(false); };
    });
  }

  function autoGrow() {
    var i = $("aiInput");
    if (!i) return;
    i.style.height = "auto";
    i.style.height = Math.min(i.scrollHeight, 160) + "px";
  }

  /* ---- settings ---------------------------------------------------------- */

  function openSettings() { $("aiSettings").classList.remove("hidden"); fillSettings(); }
  function closeSettings() { $("aiSettings").classList.add("hidden"); }

  function fillSettings() {
    var c = IDE.provider.get();
    var sel = $("aiPreset");
    if (!sel.options.length) {
      IDE.provider.presets().forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.label + (p.tested ? "" : " (untested)");
        sel.appendChild(o);
      });
    }
    sel.value = c.preset;
    $("aiBase").value = c.baseUrl;
    $("aiModel").value = c.model;
    $("aiKey").value = c.key;
    $("aiPackUrl").value = c.packUrl;
    $("aiSendEditor").checked = !!c.sendEditor;
    $("aiSendLog").checked = !!c.sendLog;
    $("aiAgent").checked = !!c.agentMode;
    var p = IDE.provider.preset(c.preset);
    $("aiNote").textContent = (p && p.note) ? p.note : "";
  }

  function applyPreset() {
    var p = IDE.provider.preset($("aiPreset").value);
    if (!p) return;
    $("aiBase").value = p.baseUrl;
    $("aiModel").value = p.model;
    $("aiNote").textContent = p.note || "";
  }

  function saveSettings() {
    var id = $("aiPreset").value;
    var p = IDE.provider.preset(id);
    IDE.provider.set({
      preset: id,
      api: p ? p.api : "openai",
      baseUrl: $("aiBase").value.trim(),
      model: $("aiModel").value.trim(),
      key: $("aiKey").value.trim(),
      packUrl: $("aiPackUrl").value.trim(),
      sendEditor: $("aiSendEditor").checked,
      sendLog: $("aiSendLog").checked,
      agentMode: $("aiAgent").checked
    });
    packText = null;   /* packUrl may have changed */
    closeSettings();
    setStatus("Provider saved.");
    setTimeout(function () { setStatus(""); }, 1800);
  }

  /* ---- wiring ------------------------------------------------------------ */

  function init() {
    if (!$("aiLog")) return;

    $("aiSend").onclick = ask;
    $("aiNew").onclick = newChat;
    $("aiGear").onclick = openSettings;
    $("aiSettingsClose").onclick = closeSettings;
    $("aiSettingsSave").onclick = saveSettings;
    $("aiPreset").onchange = applyPreset;

    $("aiInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
    });
    $("aiInput").addEventListener("input", autoGrow);

    logEl().addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b) return;
      var block = b.closest(".ai-code");
      var code = block ? block.querySelector("code").textContent : "";
      if (b.classList.contains("ai-copy")) {
        if (navigator.clipboard) navigator.clipboard.writeText(code);
        b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200);
      } else if (b.classList.contains("ai-insert")) {
        if (IDE.editor && IDE.editor.insertSnippet) IDE.editor.insertSnippet(code);
        else if (IDE.editor) IDE.editor.set(editorText() + "\n" + code);
      } else if (b.classList.contains("ai-replace")) {
        if (IDE.editor && IDE.editor.set) IDE.editor.set(code);
      }
    });

    /* restore this tab's conversation */
    try {
      var raw = sessionStorage.getItem(STORE);
      if (raw) {
        var d = JSON.parse(raw);
        (d.h || []).forEach(function (m) {
          var r = addRow(m.role === "user" ? "user" : "bot", m.role === "user" ? "You" : "Assistant");
          r.querySelector(".ai-body").innerHTML = m.role === "user"
            ? "<p>" + esc(m.display || m.content) + "</p>" : render(m.content || "");
          if (m.think) {
            var t = r.querySelector(".ai-think");
            t.hidden = false; t.querySelector("summary").textContent = "Thought process";
            r.querySelector(".ai-thinkbody").textContent = m.think;
          }
        });
        history = d.h || [];
      }
    } catch (e) {}

    autoGrow();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
