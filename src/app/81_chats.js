/* 81_chats.js -- conversation store for the AI assistant.
 *
 * Many named chat sessions, kept in IndexedDB (via 06_idb.js) rather than
 * localStorage. The reason is quota: agent conversations carry tool results,
 * reasoning, and attached files, so the history grows without bound, and once
 * it filled localStorage's ~5 MB it began throwing QuotaExceededError on every
 * OTHER write -- which is how a big chat log silently blocked the assistant
 * settings from saving. IndexedDB is disk-backed and effectively unbounded.
 *
 * The public API stays SYNCHRONOUS: an in-memory `db` is the source of truth
 * for reads, and every mutation writes through to IndexedDB in the background.
 * The store hydrates from IndexedDB once at startup; callers that must see the
 * restored chats wait on IDE.chats.ready(). On first run it MIGRATES any
 * existing localStorage history into IndexedDB and deletes the localStorage
 * key, which is what actually frees the quota that was blocking everything else.
 *
 * If IndexedDB is unavailable (private mode), it falls back to localStorage --
 * same behaviour as before, quota and all.
 *
 * A session: { id, title, ts, msgs: [{role, content, display?, think?, tools?,
 * warn?}] }. `content` is what the model saw; `display` is the clean question.
 */
(function () {
  var IDE = window.IDE;
  var KEY = "m2ide.ai.sessions.v1";
  var LEGACY = "m2ide.ai.chat";
  var MAX_SESSIONS = 40;
  var useIdb = !!(IDE.idb && IDE.idb.available);

  var db = { current: "", sessions: [] };   /* in-memory truth, read synchronously */
  var hydrated = false;
  var resolveReady;
  var readyP = new Promise(function (r) { resolveReady = r; });

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

  /* Write the whole store through to durable storage. Returns a promise that
     resolves when the write has committed (used by the migration to avoid
     deleting the localStorage copy before IndexedDB has the data). */
  function persist() {
    if (useIdb) {
      return IDE.idb.set(KEY, db).catch(function (e) {
        try { console.warn("[chats] IndexedDB write failed:", e && e.message); } catch (_) {}
      });
    }
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {
      try { console.warn("[chats] localStorage write failed:", e && e.name); } catch (_) {}
    }
    return Promise.resolve();
  }

  function adopt(loaded) {
    if (!loaded || !Array.isArray(loaded.sessions)) return false;
    db.sessions = loaded.sessions.filter(function (s) { return s && Array.isArray(s.msgs); });
    db.current = loaded.current || (db.sessions[0] && db.sessions[0].id) || "";
    return true;
  }

  /* Fold the pre-overhaul single conversation (sessionStorage) into the store. */
  function migrateLegacy() {
    try {
      var raw = sessionStorage.getItem(LEGACY);
      if (!raw) return;
      var old = JSON.parse(raw);
      if (old && old.h && old.h.length) {
        var s = { id: uid(), title: titleFor(old.h), ts: Date.now(), msgs: old.h };
        db.sessions.unshift(s);
        db.current = s.id;
      }
      sessionStorage.removeItem(LEGACY);
    } catch (e) { /* nothing to migrate */ }
  }

  function finishHydrate() {
    hydrated = true;
    resolveReady(db);
    try { IDE.bus.emit("chats:ready", db); } catch (e) {}
  }

  function hydrate() {
    if (!useIdb) {
      try { adopt(JSON.parse(localStorage.getItem(KEY))); } catch (e) {}
      migrateLegacy();
      finishHydrate();
      return;
    }
    IDE.idb.get(KEY).then(function (loaded) {
      var haveIdb = adopt(loaded && loaded.sessions && loaded.sessions.length ? loaded : null);
      /* First run on IndexedDB: pull any existing localStorage history across,
         then delete that key so it stops occupying the ~5 MB quota. Delete only
         AFTER the IndexedDB write commits, so a crash mid-migration can't lose
         the history. */
      var lsRaw = null;
      try { lsRaw = localStorage.getItem(KEY); } catch (e) {}
      if (!haveIdb && lsRaw) { try { adopt(JSON.parse(lsRaw)); } catch (e) {} }
      migrateLegacy();
      if (lsRaw != null) {
        persist().then(function () { try { localStorage.removeItem(KEY); } catch (e) {} });
      }
      finishHydrate();
    }).catch(function () {
      /* IndexedDB unreadable -- fall back to whatever localStorage holds. */
      try { adopt(JSON.parse(localStorage.getItem(KEY))); } catch (e) {}
      migrateLegacy();
      finishHydrate();
    });
  }

  hydrate();

  function byId(id) {
    for (var i = 0; i < db.sessions.length; i++) if (db.sessions[i].id === id) return db.sessions[i];
    return null;
  }

  function create() {
    for (var i = 0; i < db.sessions.length; i++) {
      if (!db.sessions[i].msgs.length) { db.current = db.sessions[i].id; persist(); return db.sessions[i]; }
    }
    var s = { id: uid(), title: "New chat", ts: Date.now(), msgs: [] };
    db.sessions.unshift(s);
    if (db.sessions.length > MAX_SESSIONS) db.sessions.length = MAX_SESSIONS;
    db.current = s.id;
    persist();
    return s;
  }

  function current() {
    /* Before hydration finishes, hand back a throwaway empty session rather
       than create() one -- creating (and persisting) a chat here would race the
       incoming IndexedDB data and leave an orphan blank. The panel re-renders
       on "chats:ready" with the real current session. */
    if (!hydrated) return { id: "", title: "New chat", ts: 0, msgs: [] };
    return byId(db.current) || create();
  }

  IDE.chats = {
    /* Resolves once the store has hydrated from IndexedDB -- the panel waits on
       this before its first render so restored chats are shown, not a blank. */
    ready: function () { return readyP; },
    hydrated: function () { return hydrated; },
    list: function () { return db.sessions.slice(); },
    get: byId,
    current: current,
    create: create,
    select: function (id) {
      var s = byId(id);
      if (s) { db.current = id; persist(); }
      return s;
    },
    remove: function (id) {
      for (var i = 0; i < db.sessions.length; i++) {
        if (db.sessions[i].id === id) { db.sessions.splice(i, 1); break; }
      }
      if (db.current === id) db.current = db.sessions.length ? db.sessions[0].id : "";
      persist();
    },
    append: function (msg) { return IDE.chats.appendTo(current().id, msg); },
    appendTo: function (id, msg) {
      var s = byId(id);
      if (!s) return null;
      s.msgs.push(msg);
      s.ts = Date.now();
      if (s.title === "New chat") s.title = titleFor(s.msgs);
      persist();
      return s;
    },
    save: persist
  };
})();
