/* ess-bridge.js -- a tiny, dependency-free browser client for the Mercenaries 2 lua-bridge over WebSocket.
 * Connect straight from a web page to the live game -- no Python/relay -- once the bridge speaks WS
 * (see BRIDGE_WEBSOCKET.md for exactly what the bridge needs).
 *
 * WHY RESULTS WORK THE WAY THEY DO (read this -- it's the whole design):
 *   The bridge runs your Lua whenever the engine next drives its pump -- and the pump rides on the game's own
 *   (noop'd) native debug-print, which every stock script calls constantly, so chunks run promptly and
 *   reliably (driven overnight at 200-300k executed calls/sec). Results ride a tagged line back to us, exactly
 *   like tools/lua_repl.py -- but over a HIDDEN channel, not the log: this client wraps each chunk to
 *   `Loader.WsSend("<tag>"..result)`. Loader.WsSend is a bridge global that broadcasts to WS clients ONLY and
 *   never writes the log file, so result/plumbing traffic stays invisible to lua_loader_printf.log. The bridge
 *   delivers two feeds: {type:"ws"} (Loader.WsSend -- hidden, carries our tagged results + any mod telemetry)
 *   and {type:"log"} (Loader.Printf -- the real log, mirrored as the live console). No correlation plumbing in
 *   the bridge's C either -- the id lives in Lua.
 *
 *   You get TWO signals per run():
 *     * ACK    -- the bridge received + queued your chunk (immediate, reliable).
 *     * RESULT -- the tagged {type:"ws"} line came back. Reliable in practice (the pump fires constantly). If
 *                 none arrives within resultTimeout, run() resolves { timedOut:true } instead of hanging -- a
 *                 rare safety net (a dropped/slow line), not the norm; the chunk almost certainly ran.
 *
 *   Set onData for un-tagged {type:"ws"} pushes (a mod streaming telemetry via Loader.WsSend), and onLog for
 *   the {type:"log"} console feed.
 *
 * USAGE
 *   const bridge = new EssBridge("ws://127.0.0.1:27050");
 *   bridge.onLog = (line) => appendToConsole(line);          // the LIVE game log feed
 *   bridge.onStatus = (s) => setDot(s);                      // "connecting" | "open" | "closed" | "error"
 *   await bridge.connect();
 *   const r = await bridge.run('return Ess.VERSION');        // { ok:true, value:"0.2.1", acked:true }
 *   bridge.run('Ess.Player.giveCash(100000)');               // fire-and-forget is fine (still resolves)
 *
 * Works in any browser (native WebSocket). In Node, pass an impl: new EssBridge(url, { WebSocketImpl: require('ws') }).
 */
(function (root) {
  "use strict";

  var _seq = 0;
  function nextId() { return "q" + (++_seq).toString(36) + Date.now().toString(36); }

  // Wrap user code so it emits a single, nonce-tagged result line on the HIDDEN channel (Loader.WsSend --
  // WS-only, never logged), so result plumbing doesn't pollute lua_loader_printf.log. pcall the body so the
  // line ALWAYS fires (success OR error).
  //
  // IDE ADDITION (upstream candidate for the Ess repo's tools/): successful values go through a small
  // game-side serializer instead of bare tostring(), so returning a table shows {x=1, y={...}} rather than
  // "table: 0x...". Depth-capped (3), item-capped (40), cycle-safe, strings %q-quoted, and the final line
  // is newline-escaped -- the single-line transport constraint still holds. Errors stay plain tostring().
  // Lua 5.0-safe: pairs/type/tostring/table.insert/table.concat/string.format/string.gsub only.
  function wrap(code, tag) {
    var ser =
      "local __ideser do " +
      "local function s(v, d, seen) " +
        "local t = type(v) " +
        "if t == 'string' then return string.format('%q', v) end " +
        "if t ~= 'table' then return tostring(v) end " +
        "if seen[v] then return '<cycle>' end " +
        "if d > 3 then return '{...}' end " +
        "seen[v] = true " +
        "local p, n = {}, 0 " +
        "for k, x in pairs(v) do " +
          "n = n + 1 " +
          "if n > 40 then table.insert(p, '...') break end " +
          "local ks if type(k) == 'string' then ks = k else ks = '[' .. tostring(k) .. ']' end " +
          "table.insert(p, ks .. '=' .. s(x, d + 1, seen)) " +
        "end " +
        "seen[v] = nil " +
        "return '{' .. table.concat(p, ', ') .. '}' " +
      "end " +
      "__ideser = function(v) return (string.gsub(s(v, 0, {}), '\\n', '\\\\n')) end end\n";
    return ser +
           "local __ok, __r = pcall(function()\n" + code + "\nend)\n" +
           "Loader.WsSend('" + tag + "' .. (__ok and ('OK\\t' .. __ideser(__r)) or ('ERR\\t' .. tostring(__r))))\n";
  }

  function EssBridge(url, opts) {
    opts = opts || {};
    this.url = url || "ws://127.0.0.1:27050";
    this.resultTimeout = opts.resultTimeout || 8000;    // ms to wait for the tagged RESULT line
    this.autoReconnect = opts.autoReconnect !== false;  // default on
    this._WS = opts.WebSocketImpl || root.WebSocket;
    this.ws = null;
    this.state = "closed";
    this._pending = {};        // id -> { tag, resolve, timer, acked, onAck }
    this._reconnectDelay = 1000;
    this.onLog = opts.onLog || function () {};       // (line) the {type:"log"} console feed (Loader.Printf)
    this.onData = opts.onData || function () {};     // (line) un-tagged {type:"ws"} pushes (mod telemetry)
    this.onStatus = opts.onStatus || function () {}; // (state)
  }

  EssBridge.prototype._set = function (s) { this.state = s; try { this.onStatus(s); } catch (e) {} };

  EssBridge.prototype.connect = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self._WS) { reject(new Error("no WebSocket implementation available")); return; }
      self._set("connecting");
      var ws;
      try { ws = new self._WS(self.url); } catch (e) { self._set("error"); reject(e); return; }
      self.ws = ws;
      ws.onopen = function () { self._reconnectDelay = 1000; self._set("open"); resolve(); };
      ws.onerror = function () { self._set("error"); /* onclose follows */ };
      ws.onclose = function () {
        self._set("closed");
        self._failAll("connection closed");
        if (self.autoReconnect) {
          setTimeout(function () { self.connect().catch(function () {}); }, self._reconnectDelay);
          self._reconnectDelay = Math.min(self._reconnectDelay * 1.7, 3000);  /* IDE: cap low so the block-hint's ~10-try threshold trips in ~25s, and reconnects feel snappy */
        }
      };
      ws.onmessage = function (ev) { self._onMessage(ev.data); };
    });
  };

  EssBridge.prototype.close = function () {
    this.autoReconnect = false;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  };

  /* run(code, opts) -> Promise<{ ok, value, acked, timedOut, error? }>
   * Resolves on the tagged RESULT line, or after resultTimeout with { timedOut:true }. Always resolves
   * (never rejects) so fire-and-forget calls can't throw an unhandled rejection. */
  EssBridge.prototype.run = function (code, opts) {
    opts = opts || {};
    var self = this;
    return new Promise(function (resolve) {
      if (self.state !== "open" || !self.ws) { resolve({ ok: false, acked: false, error: "not connected" }); return; }
      var id = nextId();
      var tag = "<<<WSR:" + id + ">>>";
      var entry = { tag: tag, acked: false, onAck: opts.onAck || null, resolve: resolve };
      entry.timer = setTimeout(function () {
        delete self._pending[id];
        // no tagged line in the window -- rare (the pump fires constantly); the chunk most likely ran, the
        // line was just slow/lost. A never-hang safety net, not "it didn't execute".
        resolve({ ok: undefined, value: null, acked: entry.acked, timedOut: true });
      }, opts.resultTimeout || self.resultTimeout);
      self._pending[id] = entry;
      try { self.ws.send(JSON.stringify({ id: id, code: wrap(String(code), tag) })); }
      catch (e) { clearTimeout(entry.timer); delete self._pending[id]; resolve({ ok: false, acked: false, error: String(e) }); }
    });
  };

  EssBridge.prototype._onMessage = function (data) {
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }   // ignore non-JSON control frames

    if (msg.type === "ack") {
      var e = this._pending[msg.id];
      if (e) { e.acked = (msg.status === "queued"); if (e.onAck) { try { e.onAck(msg); } catch (x) {} } }
      return;
    }

    if (msg.type === "ws") {
      // the HIDDEN channel (Loader.WsSend). Our tagged RESULT lines ride here; everything else is a mod push.
      var wline = msg.line == null ? "" : String(msg.line);
      for (var id in this._pending) {
        var p = this._pending[id];
        var at = wline.indexOf(p.tag);
        if (at !== -1) {
          var rest = wline.slice(at + p.tag.length);
          var ok = rest.indexOf("OK\t") === 0;
          var value = rest.slice(rest.indexOf("\t") + 1);
          clearTimeout(p.timer); delete this._pending[id];
          p.resolve({ ok: ok, value: value, acked: true, timedOut: false });
          return;
        }
      }
      try { this.onData(wline); } catch (x) {}   // un-tagged -> a mod streaming telemetry
      return;
    }

    if (msg.type === "log") {   // the real Loader.Printf log, mirrored as the live console feed
      try { this.onLog(msg.line == null ? "" : String(msg.line)); } catch (x) {}
      return;
    }
  };

  EssBridge.prototype._failAll = function (why) {
    for (var id in this._pending) {
      var e = this._pending[id];
      clearTimeout(e.timer);
      e.resolve({ ok: false, value: null, acked: e.acked, timedOut: false, error: why });
    }
    this._pending = {};
  };

  root.EssBridge = EssBridge;
  if (typeof module !== "undefined" && module.exports) module.exports = EssBridge;
})(typeof self !== "undefined" ? self : this);
