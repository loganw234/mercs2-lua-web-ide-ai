/* 15_store.js -- the script library: many named scripts in localStorage instead of the old single buffer.
   Pure data layer -- the sidebar UI lives in 55_scripts.js. First run migrates the legacy single-script
   key (m2ide.script) so nobody's work vanishes on upgrade.
   Bus events:  "scripts" (the list changed: create/rename/delete/import)  |  "script" (the ACTIVE one
   switched -- the editor should load it fresh). saveActive() emits neither: autosave must stay silent. */
(function () {
  var IDE = window.IDE, KEY = "m2ide.lib.v1";

  var STARTER = "-- Mercs2 Lua IDE - write Lua, hit Run (Ctrl/Cmd+Enter).\n" +
                "-- Type \"Ess.\" for autocomplete; browse the full API in the sidebar.\n\n" +
                "return Ess.VERSION\n";

  function persist() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
  function uid() { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  var db = null;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!db || !db.scripts || !db.scripts.length) {
    var legacy = null;
    try { legacy = localStorage.getItem(IDE.cfg.scriptKey); } catch (e) {}
    var first = { id: uid(), name: legacy != null ? "My script" : "Welcome", code: legacy != null ? legacy : STARTER, mtime: Date.now() };
    db = { active: first.id, scripts: [first] };
    persist();
  }

  function byId(id) {
    for (var i = 0; i < db.scripts.length; i++) if (db.scripts[i].id === id) return db.scripts[i];
    return null;
  }
  function active() { return byId(db.active) || db.scripts[0]; }

  function uniqueName(want) {
    var names = {}, i;
    db.scripts.forEach(function (s) { names[s.name] = 1; });
    if (!names[want]) return want;
    for (i = 2; ; i++) if (!names[want + " " + i]) return want + " " + i;
  }

  IDE.store = {
    list: function () { return db.scripts.slice(); },
    active: active,
    get: byId,
    create: function (name, code) {
      var s = { id: uid(), name: uniqueName(name || "Untitled"), code: code || "", mtime: Date.now() };
      db.scripts.push(s);
      db.active = s.id;
      persist();
      IDE.bus.emit("scripts");
      IDE.bus.emit("script", s);
      return s;
    },
    setActive: function (id) {
      var s = byId(id);
      if (!s || db.active === id) return;
      db.active = id;
      persist();
      IDE.bus.emit("script", s);
    },
    saveActive: function (code) {
      var s = active();
      if (!s || s.code === code) return;
      s.code = code; s.mtime = Date.now();
      persist();
    },
    rename: function (id, name) {
      var s = byId(id);
      if (!s || !name || !name.trim()) return;
      s.name = uniqueName(name.trim()); s.mtime = Date.now();
      persist();
      IDE.bus.emit("scripts");
    },
    duplicate: function (id) {
      var s = byId(id);
      if (!s) return;
      return IDE.store.create(s.name + " copy", s.code);
    },
    remove: function (id) {
      var idx = -1;
      for (var i = 0; i < db.scripts.length; i++) if (db.scripts[i].id === id) idx = i;
      if (idx < 0) return;
      db.scripts.splice(idx, 1);
      if (!db.scripts.length) {
        var fresh = { id: uid(), name: "Welcome", code: STARTER, mtime: Date.now() };
        db.scripts.push(fresh);
      }
      if (db.active === id) {
        db.active = db.scripts[Math.min(idx, db.scripts.length - 1)].id;
        persist();
        IDE.bus.emit("scripts");
        IDE.bus.emit("script", active());
        return;
      }
      persist();
      IDE.bus.emit("scripts");
    },
    /* backup/restore: the whole library as one JSON file. Restore is always additive (merge, never
       clobber) -- imported scripts land as brand-new entries with fresh ids, name-deduped the same way
       a fresh "+ New" would be, so a restore can never silently overwrite in-progress work. */
    exportAll: function () {
      return JSON.stringify({
        exportedAt: Date.now(),
        scripts: db.scripts.map(function (s) { return { name: s.name, code: s.code }; })
      }, null, 2);
    },
    importAll: function (jsonText) {
      var parsed;
      try { parsed = JSON.parse(jsonText); } catch (e) { return { ok: false, error: "not valid JSON" }; }
      var list = Array.isArray(parsed) ? parsed : parsed.scripts;
      if (!Array.isArray(list)) return { ok: false, error: "no scripts array found in that file" };
      var added = 0;
      list.forEach(function (item) {
        if (!item || typeof item.code !== "string") return;
        db.scripts.push({ id: uid(), name: uniqueName(item.name || "Untitled"), code: item.code, mtime: Date.now() });
        added++;
      });
      if (added) { persist(); IDE.bus.emit("scripts"); }
      return { ok: true, added: added };
    }
  };
})();
