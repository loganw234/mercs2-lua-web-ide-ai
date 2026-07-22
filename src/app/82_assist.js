/* 82_assist.js -- the AI assistant panel.
 *
 * Talks to whatever IDE.provider is configured (see 80_provider.js). The value
 * over the wiki's chat page is context: this one can see the editor buffer, the
 * current selection and the live game log, so "why is this failing?" needs no
 * copy-paste. Conversations persist across reloads via IDE.chats (81_chats.js).
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
  var SEL_MAX = 20000;         /* chars of the selection we will attach */
  var FILE_MAX = 120000;       /* per attached file; source docs are usually tiny */

  var logRing = [];
  var pendingFiles = [];       /* [{name, text}] attached to the NEXT question, any count */
  var busy = false, abortCtl = null, packText = null;
  var sendSel = true;          /* the Selection chip: per-question, defaults on */
  var stick = true;            /* auto-scroll is pinned to the bottom */

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

  function selectionText() {
    try { return (IDE.editor && IDE.editor.selection) ? IDE.editor.selection() : ""; }
    catch (e) { return ""; }
  }

  function scriptName() {
    try { var s = IDE.store && IDE.store.active(); return s ? s.name : ""; }
    catch (e) { return ""; }
  }

  function buildContext() {
    var c = IDE.provider.get();
    var parts = [];
    if (c.sendEditor) {
      var src = editorText();
      if (src.trim()) {
        if (src.length > EDITOR_MAX) src = src.slice(0, EDITOR_MAX) + "\n-- [truncated]";
        var name = scriptName();
        parts.push("--- current script" + (name ? ": " + name : "") +
          " ---\n```lua\n" + src + "\n```\n--- end script ---");
      }
    }
    var sel = sendSel ? selectionText() : "";
    if (sel.trim()) {
      if (sel.length > SEL_MAX) sel = sel.slice(0, SEL_MAX) + "\n-- [truncated]";
      parts.push("--- selected code (the question is about this part) ---\n```lua\n" +
        sel + "\n```\n--- end selection ---");
    }
    if (c.sendLog && logRing.length) {
      var tail = logRing.slice(-LOG_SEND).join("\n");
      parts.push("--- recent game log (newest last) ---\n```\n" + tail + "\n```\n--- end log ---");
    }
    for (var f = 0; f < pendingFiles.length; f++) {
      var pf = pendingFiles[f];
      var txt = pf.text.length > FILE_MAX ? pf.text.slice(0, FILE_MAX) + "\n[truncated]" : pf.text;
      var fence = /```/.test(txt) ? "````" : "```";   /* avoid closing the fence early */
      parts.push("--- attached file: " + pf.name + " ---\n" + fence + "\n" + txt +
        "\n" + fence + "\n--- end file ---");
    }
    return parts.join("\n\n");
  }

  /* Read dropped/picked files as text and queue them for the next question.
     No count limit -- reference docs are usually small and users may have many;
     the context-budget bar shows the cost. Binary files are skipped. */
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || "");
        if (/�/.test(text.slice(0, 4000))) {   /* replacement char => binary */
          setStatus("Skipped " + file.name + " — looks binary, not text.", true);
          return;
        }
        pendingFiles.push({ name: file.name, text: text });
        refreshChips();
      };
      reader.onerror = function () { setStatus("Could not read " + file.name + ".", true); };
      reader.readAsText(file);
    });
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
          "-token context but the selected pack needs about " +
          need.toLocaleString() + ". It will be silently truncated from the " +
          "front, losing the rules that stop it inventing API names. Pick a " +
          "smaller Bundled tier in Assistant settings, or use a longer-context model.",
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
    var packs = window.MERCS_PACKS || {};
    packText = packs[c.packTier] || packs.small || window.MERCS_PACK || "";
    return Promise.resolve(packText);
  }

  /* ---- rendering --------------------------------------------------------- */

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

  /* Tiny Lua highlighter for code blocks, on the same design tokens the editor
     uses. Tokenises the RAW code (so string/comment contents never match the
     keyword branch) and escapes per token. */
  var LUA_KW = /^(and|break|do|else|elseif|end|false|for|function|goto|if|in|local|nil|not|or|repeat|return|then|true|until|while)$/;
  var LUA_GLOBAL = /^(Ess|Pg|Sys|Player|Ai|Vz|Easy|Game|World|Cam|Ui|Debug|Net)$/;
  function hlLua(src) {
    var re = /--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|\[(=*)\[[\s\S]*?\]\2\]|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b[A-Za-z_]\w*\b/g;
    var out = "", last = 0, m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      var t = m[0], cls = "";
      if (t.lastIndexOf("--", 0) === 0) cls = "hl-c";
      else if (t[0] === '"' || t[0] === "'" || t[0] === "[") cls = "hl-s";
      else if (/^\d|^0[xX]/.test(t)) cls = "hl-n";
      else if (LUA_KW.test(t)) cls = "hl-k";
      else if (LUA_GLOBAL.test(t)) cls = "hl-g";
      out += cls ? '<span class="' + cls + '">' + esc(t) + "</span>" : esc(t);
      last = m.index + t.length;
    }
    return out + esc(src.slice(last));
  }

  function render(text) {
    var out = "", parts = text.split("```");
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var m = parts[i].match(/^([a-zA-Z0-9_-]*)\n([\s\S]*)$/);
        var lang = m ? (m[1] || "code") : "code";
        var code = (m ? m[2] : parts[i]).replace(/\n$/, "");
        var isLua = /^lua$/i.test(lang);
        out += '<div class="ai-code"><div class="ai-codehead"><span>' + esc(lang) +
          '</span><span class="ai-codeacts">' +
          '<button type="button" class="ai-act ai-copy" title="Copy code">Copy</button>' +
          (isLua ? '<button type="button" class="ai-act ai-insert" title="Insert at the cursor">Insert</button>' +
            '<button type="button" class="ai-act ai-replace" title="Replace the whole script">Replace</button>' : "") +
          '</span></div><pre><code>' + (isLua ? hlLua(code) : esc(code)) + "</code></pre></div>";
      } else {
        out += prose(parts[i]);
      }
    }
    return out;
  }

  /* Pull a model's inline reasoning out of the answer text. Reasoning that
     arrives as a separate `reasoning`/`reasoning_content` field is handled in
     the provider; this is for models (the Qwen family especially) that put it
     inline. Two inline shapes occur, and only handling the first was why a Qwen
     on LM Studio showed no thought panel:

       1. <think> ... </think> rest      -- explicit open + close.
       2. ... reasoning ... </think> rest -- CLOSE ONLY. Qwen chat templates
          inject the opening <think> into the prompt, so the model streams the
          reasoning text and just the closing tag; there is no opening tag in
          the output at all. */
  function splitThink(raw) {
    var open = raw.indexOf("<think>");
    var close = raw.indexOf("</think>");
    /* Shape 1: an opening tag with only whitespace before it. */
    if (open !== -1 && /^\s*$/.test(raw.slice(0, open))) {
      var s = open + 7;
      if (close === -1) return { think: raw.slice(s), rest: "" };
      return { think: raw.slice(s, close), rest: raw.slice(close + 8).replace(/^\s+/, "") };
    }
    /* Shape 2: a closing tag with no opening tag before it -> the open was in
       the prompt; everything up to the close is the thought. */
    if (close !== -1 && (open === -1 || open > close)) {
      return { think: raw.slice(0, close), rest: raw.slice(close + 8).replace(/^\s+/, "") };
    }
    return { think: "", rest: raw };
  }

  /* ---- DOM --------------------------------------------------------------- */

  function logEl() { return $("aiLog"); }
  function scrollEl() { return $("aiScroll"); }

  function nearBottom() {
    var sc = scrollEl();
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
  }

  function scrollBottom(force) {
    var sc = scrollEl();
    if (force || stick) sc.scrollTop = sc.scrollHeight;
    updateJump();
  }

  function updateJump() {
    var j = $("aiJump");
    if (j) j.classList.toggle("hidden", nearBottom());
  }

  /* A tool call as an expandable chip: the summary says what was called, the
     body holds what came back. The result matters most for run_lua -- the user
     just approved code to run in THEIR game, so what happened must be visible
     in the chat, not only fed back to the model. */
  var TOOL_OUT_MAX = 2000;
  function toolChip(t) {
    var d = document.createElement("details");
    d.className = "ai-tool" + (t.bad ? " bad" : "") + (t.pending ? " pending" : "");
    var s = document.createElement("summary");
    s.textContent = "▸ " + t.name + (t.detail ? "  " + t.detail : "");
    d.appendChild(s);
    if (t.result) {
      var o = document.createElement("div");
      o.className = "ai-toolout";
      o.textContent = t.result;
      d.appendChild(o);
    }
    return d;
  }

  function warnEl(w) {
    var d = document.createElement("div");
    d.className = "ai-ungrounded";
    if (w.unverified) {
      d.innerHTML = "<strong>Unverified:</strong> " + esc(w.unverified.join(", ")) +
        " — not in the reference pack, and the wiki index could not be reached " +
        "to check further.";
    } else {
      d.innerHTML = "<strong>Not documented:</strong> " + esc((w.absent || []).join(", ")) +
        " — " + ((w.absent || []).length === 1 ? "this name does" : "these names do") +
        " not appear anywhere in the wiki. Treat as invented until you confirm " +
        "it yourself." +
        (w.elsewhere && w.elsewhere.length
          ? "<br><span class=\"ai-ok\">" + esc(w.elsewhere.join(", ")) +
            " checked out — documented, just not in the loaded pack.</span>"
          : "");
    }
    return d;
  }

  function actsHtml(kinds) {
    var map = {
      copy: '<button type="button" class="ai-act ai-copymsg" title="Copy message">Copy</button>',
      edit: '<button type="button" class="ai-act ai-editmsg" title="Edit and resend">Edit</button>',
      regen: '<button type="button" class="ai-act ai-regen" title="Regenerate this answer">↻ Retry</button>'
    };
    return '<div class="ai-acts">' + kinds.map(function (k) { return map[k]; }).join("") + "</div>";
  }

  /* One message row, built from persisted state -- a restored chat renders
     identically to how it looked live (tool chips and warnings included). */
  function msgRow(m, i, msgs) {
    var el = document.createElement("div");
    var isUser = m.role === "user";
    el.className = "ai-msg " + (isUser ? "ai-user" : "ai-bot");
    el.setAttribute("data-i", String(i));
    if (isUser) {
      el.innerHTML = '<div class="ai-bubble"></div>' + actsHtml(["copy", "edit"]);
      el.querySelector(".ai-bubble").innerHTML =
        "<p>" + esc(m.display || m.content).replace(/\n/g, "<br>") + "</p>";
    } else {
      var last = i === msgs.length - 1;
      el.innerHTML =
        (m.think ? '<details class="ai-think"><summary>Thought process</summary><div class="ai-thinkbody"></div></details>' : "") +
        (m.tools && m.tools.length ? '<div class="ai-tools"></div>' : "") +
        '<div class="ai-body"></div>' +
        actsHtml(last ? ["copy", "regen"] : ["copy"]);
      if (m.think) el.querySelector(".ai-thinkbody").textContent = m.think;
      if (m.tools && m.tools.length) {
        var box = el.querySelector(".ai-tools");
        m.tools.forEach(function (t) { box.appendChild(toolChip(t)); });
      }
      el.querySelector(".ai-body").innerHTML = render(m.content || "");
      if (m.warn) el.querySelector(".ai-body").appendChild(warnEl(m.warn));
    }
    return el;
  }

  function renderAll() {
    var log = logEl();
    log.innerHTML = "";
    var msgs = IDE.chats.current().msgs;
    for (var i = 0; i < msgs.length; i++) log.appendChild(msgRow(msgs[i], i, msgs));
    updateEmpty();
    stick = true;
    scrollBottom(true);
  }

  function updateEmpty() {
    var empty = $("aiEmpty");
    if (!empty) return;
    var has = IDE.chats.current().msgs.length > 0;
    empty.classList.toggle("hidden", has);
    var conf = IDE.provider.configured();
    $("aiSugg").classList.toggle("hidden", !conf);
    $("aiSetup").classList.toggle("hidden", conf);
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
    if (send) {
      send.textContent = b ? "◼" : "➤";
      send.title = b ? "Stop generating (Esc)" : "Send (Enter) — Shift+Enter for a new line";
      send.classList.toggle("stop", b);
    }
  }

  /* ---- header: model chip + chat history ---------------------------------- */

  function refreshModel() {
    var el = $("aiModelChip");
    if (!el) return;
    var c = IDE.provider.get();
    var ok = IDE.provider.configured();
    el.textContent = ok ? (c.model || c.preset) : "choose a model…";
    el.classList.toggle("unset", !ok);
    var p = IDE.provider.preset(c.preset);
    el.title = (ok ? "Model: " + c.model + (p ? "  (" + p.label + ")" : "")
                   : "No provider configured") + " — click to change";
  }

  function ago(ts) {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 86400 * 7) return Math.round(s / 86400) + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  function histShown() { return !$("aiHist").classList.contains("hidden"); }
  function hideHist() { $("aiHist").classList.add("hidden"); }

  function renderHist() {
    var box = $("aiHist");
    box.innerHTML = "";
    var cur = IDE.chats.current().id;
    var list = IDE.chats.list().filter(function (s) { return s.msgs.length || s.id === cur; });
    if (!list.length) {
      box.innerHTML = '<div class="ai-histempty">No chats yet</div>';
      return;
    }
    list.forEach(function (s) {
      var r = document.createElement("div");
      r.className = "ai-histrow" + (s.id === cur ? " on" : "");
      r.innerHTML = '<span class="ai-histmain"><span class="ai-histtitle"></span>' +
        '<span class="ai-histwhen"></span></span>' +
        '<button type="button" class="ai-act ai-histdel" title="Delete this chat">✕</button>';
      r.querySelector(".ai-histtitle").textContent = s.title || "New chat";
      r.querySelector(".ai-histwhen").textContent =
        ago(s.ts) + " · " + Math.ceil(s.msgs.length / 2) + (s.msgs.length > 2 ? " turns" : " turn");
      r.addEventListener("click", function (e) {
        if (e.target.closest(".ai-histdel")) {
          IDE.chats.remove(s.id);
          renderHist();
          renderAll();
          return;
        }
        if (busy && abortCtl) abortCtl.abort();
        IDE.chats.select(s.id);
        hideHist();
        renderAll();
      });
      box.appendChild(r);
    });
  }

  /* ---- composer chips ----------------------------------------------------- */

  function chipEl(kind, label, on, title) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ai-chip" + (on ? " on" : "");
    b.setAttribute("data-kind", kind);
    b.title = title + (on ? " — attached, click to drop" : " — off, click to attach");
    b.textContent = label;
    return b;
  }

  function refreshChips() {
    var box = $("aiChips");
    if (!box) return;
    var c = IDE.provider.get();
    box.innerHTML = "";
    var name = scriptName();
    box.appendChild(chipEl("script", "⌘ " + (name || "Script"), !!c.sendEditor,
      "Attach the current script to each question"));
    var sel = selectionText();
    if (sel.trim()) {
      var lines = sel.split("\n").length;
      box.appendChild(chipEl("sel", "⌥ Selection · " + lines + (lines === 1 ? " line" : " lines"),
        sendSel, "Attach the selected code to this question"));
    }
    box.appendChild(chipEl("log", "≡ Game log", !!c.sendLog,
      "Attach the last " + LOG_SEND + " game-log lines"));
    box.appendChild(chipEl("agent", "⚒ Agent", !!c.agentMode,
      "Let the assistant search the docs and examples, inspect the live game, and propose script edits or Lua to run (changes always ask first)"));
    pendingFiles.forEach(function (pf, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ai-chip on ai-chip-file";
      b.setAttribute("data-kind", "file");
      b.setAttribute("data-idx", String(i));
      b.title = "Attached: " + pf.name + " (" + Math.round(pf.text.length / 1024 * 10) / 10 +
        " KB) — click to remove";
      b.textContent = "📎 " + pf.name + " ✕";
      box.appendChild(b);
    });
  }

  /* ---- send -------------------------------------------------------------- */

  function send(opts) {
    opts = opts || {};
    if (busy) { if (abortCtl) abortCtl.abort(); return; }

    if (!IDE.provider.configured()) {
      setStatus("Configure a provider first.", true);
      openSettings();
      return;
    }

    var sess = IDE.chats.current();
    var sessId = sess.id;
    var input = $("aiInput");

    if (opts.regen) {
      /* drop the last assistant turn and re-ask with the same user message */
      while (sess.msgs.length && sess.msgs[sess.msgs.length - 1].role === "assistant") sess.msgs.pop();
      if (!sess.msgs.length || sess.msgs[sess.msgs.length - 1].role !== "user") return;
      IDE.chats.save();
      renderAll();
    } else {
      var q = (opts.text != null ? opts.text : (input.value || "")).trim();
      if (!q) return;
      var ctx = buildContext();
      /* Note attached files in the DISPLAYED message so the user can see what
         went along, then clear the queue -- attachments are per-question. */
      var fileNote = pendingFiles.length
        ? "\n\n📎 " + pendingFiles.map(function (f) { return f.name; }).join(", ")
        : "";
      IDE.chats.append({ role: "user", content: ctx ? (q + "\n\n" + ctx) : q, display: q + fileNote });
      pendingFiles = [];
      refreshChips();
      if (opts.text == null) { input.value = ""; autoGrow(); }
      renderAll();
    }
    setStatus("");

    /* live assistant row -- replaced by the persisted render on finish */
    var row = document.createElement("div");
    row.className = "ai-msg ai-bot";
    row.innerHTML =
      '<details class="ai-think live" hidden><summary>Thinking…</summary><div class="ai-thinkbody"></div></details>' +
      '<div class="ai-tools" hidden></div>' +
      '<div class="ai-body"><span class="ai-cursor">▍</span></div>';
    logEl().appendChild(row);
    var body = row.querySelector(".ai-body");
    var think = row.querySelector(".ai-think");
    var tbody = row.querySelector(".ai-thinkbody");
    var toolsEl = row.querySelector(".ai-tools");
    stick = true;
    scrollBottom(true);

    var reasoning = "", answer = "", toolText = "", toolSteps = [];
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
      var msg = "Waiting for the model… " + s + "s";
      if (s >= 300) {
        msg += " — past Ollama's default 5-minute load timeout; if this is a " +
               "first run, raise OLLAMA_LOAD_TIMEOUT and retry.";
      } else if (s >= 120) {
        msg += " — still going. A large model loading from disk into RAM can " +
               "take this long the first time.";
      } else if (s >= 25) {
        msg += " — normal for a large local model, especially on CPU/RAM.";
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
        body.innerHTML = render(st.rest) + '<span class="ai-cursor">▍</span>';
      }
      scrollBottom();
    }

    loadPack().then(function (pack) {
      checkContext();
      var msgs = [];
      if (pack) msgs.push({ role: "system", content: pack });
      var h = IDE.chats.current().msgs;
      for (var i = 0; i < h.length; i++) {
        msgs.push({ role: h[i].role, content: h[i].content });
      }

      /* Agent mode streams each step (content + reasoning) live and shows each
         tool call as it happens -- locally-hosted users want to watch the
         thinking and abort a run heading off the rails. The reasoning streams
         into the thought panel; the answer settles to the final step's content
         at the end. */
      if (IDE.provider.get().agentMode && IDE.agent) {
        toolsEl.hidden = false;
        return IDE.agent.run(msgs, {
          onStep: function (name, args) {
            firstToken = firstToken || Date.now();
            stopTick();
            /* Content streamed before this tool call was the model narrating
               its intent; clear the answer body so the tool result and the
               real answer that follow are not prefixed by it. Reasoning (the
               thought panel) is kept -- it is the running log the user watches. */
            answer = "";
            paint();
            var detail = args.path || args.query || args.expr || args.name || args.why || "";
            var t = { name: name, detail: detail, pending: true };
            toolSteps.push(t);
            toolsEl.appendChild(toolChip(t));
            scrollBottom();
          },
          onResult: function (name, out) {
            toolText += "\n" + out;
            var bad = /^(Refused|Could not|Error|Failed|That page does not exist|Not connected)/.test(out);
            var t = null;
            for (var i = toolSteps.length - 1; i >= 0; i--) {
              if (toolSteps[i].pending) { t = toolSteps[i]; break; }
            }
            if (t) {
              t.pending = false;
              if (bad) t.bad = true;
              t.result = String(out).slice(0, TOOL_OUT_MAX);
              var el = toolsEl.querySelector(".ai-tool.pending");
              if (el) {
                var fresh = toolChip(t);
                /* Game-touching calls (and failures) open by default: the user
                   approved run_lua and deserves to SEE the outcome, not click
                   for it. Wiki lookups stay collapsed -- they are plumbing. */
                if (t.name === "run_lua" || t.name === "inspect_game" || t.bad) fresh.open = true;
                el.replaceWith(fresh);
              }
            }
            scrollBottom();
          },
          confirm: function (why, code) { return askConfirm(why, code); },
          proposeEdit: function (why, code) { return askEdit(why, code); }
        }, {
          signal: abortCtl.signal,
          /* Stream live so the run is watchable and abortable. reasoning and
             answer are built here; do NOT re-add r.reasoning below or it
             double-counts the final step. */
          onReasoning: function (t) { sawToken(); reasoning += t; paint(); },
          onDelta: function (t) { sawToken(); answer += t; paint(); }
        }).then(function (r) {
          /* Settle to the clean final answer (the last step's content), which
             the onStep reset already isolated from earlier narration. */
          if (r.content) answer = r.content;
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
      if (st.rest || all || toolSteps.length) {
        toolSteps.forEach(function (t) { delete t.pending; });
        var m = {
          role: "assistant",
          content: st.rest || "(no answer)",
          think: all || undefined,
          tools: toolSteps.length ? toolSteps : undefined
        };
        /* Append to the chat that ASKED -- the user may have switched since. */
        IDE.chats.appendTo(sessId, m);
        if (IDE.chats.current().id === sessId) {
          renderAll();
          var lastRow = logEl().lastElementChild;
          if (lastRow) attachWarn(lastRow, m, toolText);
        } else {
          row.remove();
        }
      } else {
        row.remove();
        if (!stopped) setStatus("No answer came back.", true);
      }
      setBusy(false);
      abortCtl = null;
    }
  }

  /* Flag API names the model was never shown.
   *
   * This runs on EVERY answer, not just agent mode, because it needs nothing
   * from the model: no tool support, no instruction-following, no particular
   * provider. That matters because the local model with the best domain
   * knowledge here (qwen2.5-coder) cannot call tools at all -- so
   * self-correction is unavailable to exactly the users most likely to get an
   * invented answer. Telling the user directly is the only guarantee that does
   * not depend on the model cooperating.
   *
   * The verdict is persisted onto the message (m.warn) so a restored chat
   * keeps its warnings without re-hitting the wiki index. */
  function attachWarn(rowEl, m, toolText) {
    var g = IDE.ground.check(m.content || "", [packText || "", toolText || ""]);
    if (!g.ungrounded.length) return;
    var body = rowEl.querySelector(".ai-body");
    if (!body) return;
    var w = document.createElement("div");
    w.className = "ai-ungrounded";
    w.textContent = "Checking " + g.ungrounded.length + " identifier(s) against the wiki…";
    body.appendChild(w);

    /* Second opinion against the FULL wiki index.
       The pack is only a slice of the wiki -- measured, 4 of 14 known-real
       functions are missing from the small tier -- so "absent from the pack"
       would fire on roughly a third of correct answers, and a warning that
       cries wolf gets ignored, which is worse than no warning. The index
       covers every page, so a name missing from it is a claim worth making. */
    IDE.ground.verify(g.ungrounded).then(function (v) {
      if (!v.absent.length) {
        /* All real, just outside the pack. Say nothing -- a warning here
           would be pure noise. */
        w.remove();
        return;
      }
      m.warn = { absent: v.absent, elsewhere: v.elsewhere };
      IDE.chats.save();
      w.replaceWith(warnEl(m.warn));
    }).catch(function () {
      /* Offline or the index would not load: fall back to the weaker claim
         rather than dropping the warning entirely. */
      m.warn = { unverified: g.ungrounded };
      IDE.chats.save();
      w.replaceWith(warnEl(m.warn));
    });
  }

  function newChat() {
    if (busy && abortCtl) abortCtl.abort();
    IDE.chats.create();
    renderAll();
    setStatus("");
    hideHist();
    var i = $("aiInput");
    if (i) i.focus();
  }

  /* Line diff (plain LCS) for the propose_script gate. Returns
     [{t:" "|"-"|"+", s:line}], or null when the inputs are too big to diff
     responsibly -- the caller falls back to showing the new code whole. */
  function lineDiff(oldText, newText) {
    var A = oldText.split("\n"), B = newText.split("\n");
    if (A.length * B.length > 250000) return null;
    var n = A.length, m = B.length, i, j;
    var L = new Array(n + 1);
    for (i = n; i >= 0; i--) {
      L[i] = new Array(m + 1);
      for (j = m; j >= 0; j--) {
        if (i === n || j === m) L[i][j] = 0;
        else if (A[i] === B[j]) L[i][j] = L[i + 1][j + 1] + 1;
        else L[i][j] = Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    var ops = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: " ", s: A[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ t: "-", s: A[i] }); i++; }
      else { ops.push({ t: "+", s: B[j] }); j++; }
    }
    while (i < n) ops.push({ t: "-", s: A[i++] });
    while (j < m) ops.push({ t: "+", s: B[j++] });
    return ops;
  }

  /* Confirmation gate for propose_script: show WHAT would change (a real
     diff, long unchanged runs collapsed), apply only on a click. Same safety
     stance as run_lua -- the model proposes, the user disposes. */
  function askEdit(why, code) {
    return new Promise(function (resolve) {
      var wrap = document.createElement("div");
      wrap.className = "ai-confirm";
      wrap.innerHTML =
        '<div class="ai-confirm-why"></div>' +
        '<div class="ai-diff"></div>' +
        '<div class="ai-confirm-acts">' +
        '<button type="button" class="ai-btn ai-yes">Apply to editor</button>' +
        '<button type="button" class="ai-mini ai-no">Keep mine</button></div>';
      var box = wrap.querySelector(".ai-diff");
      var ops = lineDiff(editorText(), code);
      var adds = 0, dels = 0;
      if (!ops) {
        var pre = document.createElement("pre");
        pre.className = "ai-confirm-code";
        pre.innerHTML = hlLua(code);
        box.replaceWith(pre);
      } else {
        ops.forEach(function (o) { if (o.t === "+") adds++; else if (o.t === "-") dels++; });
        function addLine(t, s) {
          var d = document.createElement("div");
          d.className = "dline" + (t === "+" ? " add" : t === "-" ? " del" : "");
          d.textContent = (t === " " ? "  " : t + " ") + s;
          box.appendChild(d);
        }
        function addSkip(count) {
          var d = document.createElement("div");
          d.className = "dline skip";
          d.textContent = "⋯ " + count + " unchanged lines";
          box.appendChild(d);
        }
        var i = 0;
        while (i < ops.length) {
          if (ops[i].t !== " ") { addLine(ops[i].t, ops[i].s); i++; continue; }
          var s = i;
          while (i < ops.length && ops[i].t === " ") i++;
          var run = ops.slice(s, i);
          var lead = s === 0 ? 0 : 3, tail = i >= ops.length ? 0 : 3;
          if (run.length <= lead + tail + 2) {
            run.forEach(function (o) { addLine(" ", o.s); });
          } else {
            run.slice(0, lead).forEach(function (o) { addLine(" ", o.s); });
            addSkip(run.length - lead - tail);
            run.slice(run.length - tail).forEach(function (o) { addLine(" ", o.s); });
          }
        }
      }
      wrap.querySelector(".ai-confirm-why").textContent =
        "Proposed edit: " + why + (ops ? "  (+" + adds + " −" + dels + ")" : "");
      logEl().appendChild(wrap);
      scrollBottom(true);
      function done(v) { wrap.remove(); resolve(v); }
      wrap.querySelector(".ai-yes").onclick = function () { done(true); };
      wrap.querySelector(".ai-no").onclick = function () { done(false); };
    });
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
      wrap.querySelector(".ai-confirm-code").innerHTML = hlLua(code);
      logEl().appendChild(wrap);
      scrollBottom(true);
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

  function openSettings() { $("settingsModal").classList.remove("hidden"); fillSettings(); }
  function closeSettings() { $("settingsModal").classList.add("hidden"); }
  /* let anything (e.g. the activity-bar gear) open Settings */
  IDE.settings = { open: openSettings, close: closeSettings };

  /* Entry point for the rest of the IDE -- e.g. the "ask AI" button on a
     failed Results row. Fronts the panel and sends; if a reply is already
     streaming, the question lands in the composer instead so nothing is
     silently dropped. */
  IDE.assist = {
    ask: function (q) {
      if (IDE.dock && IDE.dock.show) IDE.dock.show("assist");
      if (busy) {
        var i = $("aiInput");
        if (i) { i.value = q; autoGrow(); i.focus(); }
        return;
      }
      send({ text: q });
    },
    open: function () { if (IDE.dock && IDE.dock.show) IDE.dock.show("assist"); }
  };

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

    var tsel = $("aiPackTier");
    if (tsel && !tsel.options.length) {
      (window.MERCS_PACK_INFO || []).forEach(function (t) {
        var o = document.createElement("option");
        o.value = t.key;
        o.textContent = t.label + " — " + fmtTokens(t.tokens) + " tokens";
        tsel.appendChild(o);
      });
    }
    if (tsel) tsel.value = c.packTier || "small";
    if ($("aiModelCtx")) $("aiModelCtx").value = c.modelCtx ? c.modelCtx : "";
    reflectBudget();

    $("aiPackUrl").value = c.packUrl;
    $("aiSendEditor").checked = !!c.sendEditor;
    $("aiSendLog").checked = !!c.sendLog;
    $("aiAgent").checked = !!c.agentMode;
    var p = IDE.provider.preset(c.preset);
    $("aiNote").textContent = (p && p.note) ? p.note : "";
  }

  function fmtTokens(n) {
    return n >= 1000 ? (Math.round(n / 100) / 10) + "k" : String(n);
  }

  /* IDE Use = what the agent adds on top of the pack every turn: the tool
     schemas (~1.3k, fixed) plus whatever context is attached to the question --
     the open editor script and the game-log tail (buildContext). Shown live, so
     "why did my window fill up" is answerable at a glance: a big open script
     costs real budget, an empty editor costs almost nothing. */
  function ideUseTokens() {
    var tools = (window.IDE.agent && IDE.agent.tools) ?
      Math.round(JSON.stringify(IDE.agent.tools()).length / 4) : 0;
    var ctx = Math.round((buildContext() || "").length / 4);
    return { tools: tools, ctx: ctx, total: tools + ctx };
  }

  /* Render the context-budget bar plus the tier's descriptive note. Segments:
     Reference pack | IDE Use | Free. If the model's context window is unknown,
     the bar shows only what the agent needs and asks for the window. A URL
     override supersedes the whole thing. */
  function reflectBudget() {
    var barEl = $("aiBudget"), noteEl = $("aiPackNote"), tsel = $("aiPackTier");
    if (!barEl || !noteEl) return;

    if ($("aiPackUrl") && $("aiPackUrl").value.trim()) {
      barEl.innerHTML = "";
      noteEl.textContent = "Using the Pack URL override below; the bundled tier and its budget are ignored.";
      return;
    }
    var info = (window.MERCS_PACK_INFO || []).filter(function (t) { return t.key === (tsel && tsel.value); })[0];
    if (!info) { barEl.innerHTML = ""; noteEl.textContent = ""; return; }

    noteEl.textContent = info.note;

    var pack = info.tokens;
    var ide = ideUseTokens();
    var need = pack + ide.total;
    /* Read the LIVE input, not saved config, so the bar updates as you type
       (fillSettings seeds the input from config on open). */
    var ctxEl = $("aiModelCtx");
    var ctx = Math.max(0, parseInt(ctxEl ? ctxEl.value : IDE.provider.get().modelCtx, 10) || 0);

    function seg(cls, tok, basis) {
      var w = basis > 0 ? Math.max(0, Math.min(100, tok / basis * 100)) : 0;
      return '<span class="seg ' + cls + '" style="width:' + w.toFixed(1) + '%"></span>';
    }
    var bars, readout;
    if (ctx > 0) {
      var over = need > ctx, free = Math.max(0, ctx - need);
      barEl.className = over ? "ai-budget over" : "ai-budget";
      bars = seg("pack", pack, ctx) + seg("ide", ide.total, ctx) +
        (over ? "" : seg("free", free, ctx));
      readout = over
        ? "⚠ This tier needs " + fmtTokens(need) + " but your window is only " +
          fmtTokens(ctx) + " — over by " + fmtTokens(need - ctx) + ". Pick a smaller tier."
        : "<b>" + fmtTokens(free) + " free</b> of " + fmtTokens(ctx) +
          " for your scripts, chat and the reply · pack " + fmtTokens(pack) +
          " + IDE Use " + fmtTokens(ide.total);
    } else {
      barEl.className = "ai-budget unknown";
      bars = seg("pack", pack, need) + seg("ide", ide.total, need);
      readout = "Needs ≈" + fmtTokens(need) + " (pack " + fmtTokens(pack) +
        " + IDE Use " + fmtTokens(ide.total) + "). Enter your model's context " +
        "window above to see what's left for your work.";
    }
    barEl.innerHTML =
      '<div class="ai-budget-track">' + bars + '</div>' +
      '<div class="ai-budget-read">' + readout + '</div>' +
      '<div class="ai-budget-key"><span class="k pack"></span>pack' +
      '<span class="k ide"></span>IDE Use (tools + open script &amp; log)' +
      (ctx > 0 ? '<span class="k free"></span>free' : '') + '</div>';
  }

  function applyPreset() {
    var p = IDE.provider.preset($("aiPreset").value);
    if (!p) return;
    $("aiBase").value = p.baseUrl;
    $("aiModel").value = p.model;
    $("aiNote").textContent = p.note || "";
  }

  /* Read the whole form and persist it. Returns whether it actually stuck.
     Called on EVERY field change (autosave) as well as from the Save button --
     see the wiring note. Kept side-effect-light so it is cheap to call per
     keystroke. */
  function collectAndPersist() {
    var id = $("aiPreset").value;
    var p = IDE.provider.preset(id);
    var ok = IDE.provider.set({
      preset: id,
      api: p ? p.api : "openai",
      baseUrl: $("aiBase").value.trim(),
      model: $("aiModel").value.trim(),
      key: $("aiKey").value.trim(),
      packTier: $("aiPackTier") ? $("aiPackTier").value : "small",
      modelCtx: $("aiModelCtx") ? (parseInt($("aiModelCtx").value, 10) || 0) : 0,
      packUrl: $("aiPackUrl").value.trim(),
      sendEditor: $("aiSendEditor").checked,
      sendLog: $("aiSendLog").checked,
      agentMode: $("aiAgent").checked
    });
    packText = null;   /* tier or packUrl may have changed */
    /* Surface a real persistence failure instead of hiding it: private mode,
       storage quota, or a file:// origin the browser won't grant storage to.
       This is the difference between "my settings vanish on reload" being a
       mystery and being a one-line explanation. */
    var warn = $("aiSaveWarn");
    if (warn) {
      if (ok) { warn.hidden = true; warn.textContent = ""; }
      else {
        warn.hidden = false;
        warn.textContent = "⚠ Couldn't save settings to this browser (" +
          (IDE.provider.saveError() || "storage blocked") + "). If you opened " +
          "the IDE as a file://, some browsers deny it storage — serve it over " +
          "http (even a local server) so settings persist.";
      }
    }
    return ok;
  }

  function saveSettings() {
    var ok = collectAndPersist();
    closeSettings();
    setStatus(ok ? "Provider saved." : "Settings could NOT be saved — see the warning in settings.", !ok);
    setTimeout(function () { setStatus(""); }, ok ? 1800 : 5000);
  }

  /* Autosave: persist the instant any field changes, so settings survive
     closing the modal by ANY route -- X, Cancel, the backdrop, or Escape.
     Everything else in this IDE (scripts, layout, theme) autosaves, so a
     Save-button-only settings panel was a trap: configure, close the normal
     way, lose it all. The Save button stays as a reassuring explicit action. */
  function wireAutosave() {
    var fields = ["aiPreset", "aiBase", "aiModel", "aiKey", "aiPackTier",
                  "aiModelCtx", "aiPackUrl", "aiSendEditor", "aiSendLog", "aiAgent"];
    fields.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      var ev = (el.tagName === "SELECT" || el.type === "checkbox") ? "change" : "input";
      el.addEventListener(ev, function () { collectAndPersist(); });
    });
  }

  /* ---- wiring ------------------------------------------------------------ */

  function init() {
    if (!$("aiLog")) return;

    $("aiSend").onclick = function () { send(); };
    $("aiNew").onclick = newChat;
    $("aiGear").onclick = openSettings;
    $("aiModelChip").onclick = openSettings;
    $("aiSetupBtn").onclick = openSettings;
    $("aiHistBtn").onclick = function () {
      if (histShown()) { hideHist(); return; }
      renderHist();
      $("aiHist").classList.remove("hidden");
    };
    document.addEventListener("mousedown", function (e) {
      if (histShown() && !e.target.closest("#aiHist") && !e.target.closest("#aiHistBtn")) hideHist();
    });

    $("aiSettingsClose").onclick = closeSettings;
    $("aiSettingsCancel").onclick = closeSettings;
    $("aiSettingsSave").onclick = saveSettings;
    $("aiPreset").onchange = applyPreset;
    if ($("aiPackTier")) $("aiPackTier").onchange = reflectBudget;
    if ($("aiPackUrl")) $("aiPackUrl").oninput = reflectBudget;
    if ($("aiModelCtx")) $("aiModelCtx").oninput = reflectBudget;
    wireAutosave();   /* persist on every change, not just the Save button */

    /* modal dismissal: click the backdrop (not the dialog) or press Escape */
    $("settingsModal").addEventListener("mousedown", function (e) {
      if (e.target === this) closeSettings();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("settingsModal").classList.contains("hidden")) closeSettings();
    });

    var input = $("aiInput");
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === "Escape" && busy && abortCtl) abortCtl.abort();
    });
    input.addEventListener("input", autoGrow);
    /* the Selection chip reflects the editor's live selection -- refresh it
       whenever the pointer or focus comes back to the composer */
    input.addEventListener("focus", refreshChips);
    document.querySelector(".ai-composer").addEventListener("mouseenter", refreshChips);

    $("aiChips").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".ai-chip") : null;
      if (!b) return;
      var c = IDE.provider.get();
      var k = b.getAttribute("data-kind");
      if (k === "script") IDE.provider.set({ sendEditor: !c.sendEditor });
      else if (k === "log") IDE.provider.set({ sendLog: !c.sendLog });
      else if (k === "agent") IDE.provider.set({ agentMode: !c.agentMode });
      else if (k === "sel") sendSel = !sendSel;
      else if (k === "file") { pendingFiles.splice(parseInt(b.getAttribute("data-idx"), 10), 1); }
      refreshChips();
    });

    /* File attachment: the button opens a picker; the composer also takes drops. */
    if ($("aiAttach")) $("aiAttach").onclick = function () { $("aiFile").click(); };
    if ($("aiFile")) $("aiFile").addEventListener("change", function (e) {
      addFiles(e.target.files);
      e.target.value = "";   /* allow re-picking the same file */
    });
    var comp = document.querySelector(".ai-composer");
    if (comp) {
      comp.addEventListener("dragover", function (e) { e.preventDefault(); comp.classList.add("dragover"); });
      comp.addEventListener("dragleave", function (e) {
        if (e.target === comp || !comp.contains(e.relatedTarget)) comp.classList.remove("dragover");
      });
      comp.addEventListener("drop", function (e) {
        e.preventDefault(); comp.classList.remove("dragover");
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      });
    }

    $("aiSugg").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.getAttribute("data-send")) send({ text: b.getAttribute("data-send") });
      else if (b.getAttribute("data-fill")) {
        input.value = b.getAttribute("data-fill");
        autoGrow();
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    });

    scrollEl().addEventListener("scroll", function () {
      stick = nearBottom();
      updateJump();
    });
    $("aiJump").onclick = function () { stick = true; scrollBottom(true); };

    /* message + code-block actions, delegated on the log */
    logEl().addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b) return;

      var block = b.closest(".ai-code");
      if (block && (b.classList.contains("ai-copy") || b.classList.contains("ai-insert") ||
                    b.classList.contains("ai-replace"))) {
        var code = block.querySelector("code").textContent;
        if (b.classList.contains("ai-copy")) {
          if (navigator.clipboard) navigator.clipboard.writeText(code);
          flash(b, "Copied");
        } else if (b.classList.contains("ai-insert")) {
          if (IDE.editor && IDE.editor.insertSnippet) IDE.editor.insertSnippet(code);
          else if (IDE.editor) IDE.editor.set(editorText() + "\n" + code);
          flash(b, "Done");
        } else {
          if (IDE.editor && IDE.editor.set) IDE.editor.set(code);
          flash(b, "Done");
        }
        return;
      }

      var rowEl = b.closest(".ai-msg");
      if (!rowEl) return;
      var i = parseInt(rowEl.getAttribute("data-i"), 10);
      var msgs = IDE.chats.current().msgs;
      var m = msgs[i];
      if (!m) return;

      if (b.classList.contains("ai-copymsg")) {
        var txt = m.role === "user" ? (m.display || m.content) : m.content;
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
        flash(b, "Copied");
      } else if (b.classList.contains("ai-editmsg")) {
        if (busy) return;
        input.value = m.display || m.content;
        msgs.splice(i);            /* drop this turn and everything after */
        IDE.chats.save();
        renderAll();
        autoGrow();
        input.focus();
      } else if (b.classList.contains("ai-regen")) {
        send({ regen: true });
      }
    });

    IDE.bus.on("ai:config", function () {
      refreshModel();
      refreshChips();
      updateEmpty();
    });
    IDE.bus.on("script", refreshChips);

    renderAll();
    refreshModel();
    refreshChips();
    autoGrow();

    /* Chats hydrate from IndexedDB asynchronously (81_chats.js). The first
       renderAll above runs against the not-yet-hydrated store, so re-render once
       the restored sessions are in -- and again if the history panel is open. */
    if (IDE.chats.ready) {
      IDE.chats.ready().then(function () {
        renderAll();
        if (histShown()) renderHist();
      });
    }
  }

  function flash(btn, txt) {
    var was = btn.textContent;
    btn.textContent = txt;
    setTimeout(function () { btn.textContent = was; }, 1200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
