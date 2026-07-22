/* 06_idb.js -- a tiny promise-based IndexedDB key/value store.
 *
 * Why this exists: localStorage caps at ~5 MB per origin, and the chat history
 * (agent conversations carry tool results, reasoning, and attached files) grows
 * without bound. When it fills the quota, EVERY other localStorage write starts
 * throwing QuotaExceededError -- which is how a full chat log silently stopped
 * the assistant settings from saving. IndexedDB is disk-backed and measured in
 * hundreds of MB to GB, so the growing data lives here instead.
 *
 * One object store, string keys, structured-clone values (no JSON.stringify --
 * IndexedDB clones objects directly). Everything is async; callers that need a
 * synchronous API (IDE.chats) keep an in-memory cache and write through to this.
 *
 * IDE.idb.available is false in private-mode browsers that block IndexedDB --
 * callers fall back to localStorage there.
 */
(function () {
  var IDE = window.IDE;
  var DB = "m2ide", STORE = "kv", VER = 1;
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB, VER); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("idb blocked")); };
    });
    return dbp;
  }

  /* Run one transaction. `fn` gets the object store and returns an IDBRequest;
     we resolve with that request's result once the transaction COMMITS (not
     merely when the request fires) so a write is durable before we report it. */
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("idb tx aborted")); };
      });
    });
  }

  var available = false;
  try { available = !!window.indexedDB; } catch (e) { available = false; }

  IDE.idb = {
    available: available,
    get: function (key) { return tx("readonly", function (st) { return st.get(key); }); },
    set: function (key, val) { return tx("readwrite", function (st) { return st.put(val, key); }); },
    del: function (key) { return tx("readwrite", function (st) { return st.delete(key); }); }
  };
})();
