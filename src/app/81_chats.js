/* 81_chats.js -- conversation store for the AI assistant.
 *
 * Many named chat sessions in localStorage instead of the old single
 * sessionStorage conversation. Pure data layer -- the panel UI lives in
 * 82_assist.js. First run migrates the legacy key (m2ide.ai.chat) so an
 * in-progress conversation survives the upgrade.
 *
 * A session: { id, title, ts, msgs: [{role, content, display?, think?,
 * tools?, warn?}] }. `content` is what the model saw (question + attached
 * context); `display` is the clean question for the UI. `tools` and `warn`
 * are render state persisted so a restored chat looks like it did live.
 */
(function () {
  var IDE = window.IDE;
  var KEY = "m2ide.ai.sessions.v1";
  var LEGACY = "m2ide.ai.chat";
  var MAX_SESSIONS = 40;

  var db = null;

  function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function titleFor(msgs) {
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "user") {
        var t = (msgs[i].display || msgs[i].content || "").replace(/\s+/g, " ").trim();
        if (!t) break;
        return t.length > 48 ? t.slice(0, 48) + "…" : t;
      }
    }
    return "New chat";
  }

  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }

  function load() {
    if (db) return db;
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!db || !Array.isArray(db.sessions)) db = { current: "", sessions: [] };
    db.sessions = db.sessions.filter(function (s) { return s && Array.isArray(s.msgs); });
    /* migrate the pre-overhaul single conversation so nobody loses a chat */
    try {
      var raw = sessionStorage.getItem(LEGACY);
      if (raw) {
        var old = JSON.parse(raw);
        if (old && old.h && old.h.length) {
          var s = { id: uid(), title: titleFor(old.h), ts: Date.now(), msgs: old.h };
          db.sessions.unshift(s);
          db.current = s.id;
          save();
        }
        sessionStorage.removeItem(LEGACY);
      }
    } catch (e) {}
    return db;
  }

  function byId(id) {
    load();
    for (var i = 0; i < db.sessions.length; i++) if (db.sessions[i].id === id) return db.sessions[i];
    return null;
  }

  function create() {
    load();
    /* reuse an existing empty chat instead of stacking blanks */
    for (var i = 0; i < db.sessions.length; i++) {
      if (!db.sessions[i].msgs.length) {
        db.current = db.sessions[i].id;
        save();
        return db.sessions[i];
      }
    }
    var s = { id: uid(), title: "New chat", ts: Date.now(), msgs: [] };
    db.sessions.unshift(s);
    if (db.sessions.length > MAX_SESSIONS) db.sessions.length = MAX_SESSIONS;
    db.current = s.id;
    save();
    return s;
  }

  function current() {
    load();
    return byId(db.current) || create();
  }

  IDE.chats = {
    list: function () { load(); return db.sessions.slice(); },
    get: byId,
    current: current,
    create: create,
    select: function (id) {
      var s = byId(id);
      if (s) { db.current = id; save(); }
      return s;
    },
    remove: function (id) {
      load();
      for (var i = 0; i < db.sessions.length; i++) {
        if (db.sessions[i].id === id) { db.sessions.splice(i, 1); break; }
      }
      if (db.current === id) db.current = db.sessions.length ? db.sessions[0].id : "";
      save();
    },
    /* Append to the CURRENT session. */
    append: function (msg) { return IDE.chats.appendTo(current().id, msg); },
    /* Append to a session by id -- a reply that finishes (or aborts) after the
       user has switched chats must still land in the chat that asked. */
    appendTo: function (id, msg) {
      var s = byId(id);
      if (!s) return null;
      s.msgs.push(msg);
      s.ts = Date.now();
      if (s.title === "New chat") s.title = titleFor(s.msgs);
      save();
      return s;
    },
    save: save
  };
})();
