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
    db = { active: first.id, scripts: [first], open: [first.id] };
    persist();
  }
  /* `open` is the tab bar's ordered set of open scripts (added for the tabbed
     editor). Migrate an older library that predates it, and prune ids that no
     longer exist. */
  if (!Array.isArray(db.open)) db.open = [db.active];
  db.open = db.open.filter(function (id) { return byIdRaw(id); });
  if (db.open.indexOf(db.active) === -1) db.open.unshift(db.active);
  function byIdRaw(id) {
    for (var i = 0; i < db.scripts.length; i++) if (db.scripts[i].id === id) return db.scripts[i];
    return null;
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

  function ensureOpen(id) {
    if (db.open.indexOf(id) === -1) { db.open.push(id); return true; }
    return false;
  }

  IDE.store = {
    list: function () { return db.scripts.slice(); },
    active: active,
    get: byId,
    /* open tabs (ordered) for the tabbed editor */
    openTabs: function () { return db.open.slice(); },
    create: function (name, code) {
      var s = { id: uid(), name: uniqueName(name || "Untitled"), code: code || "", mtime: Date.now() };
      db.scripts.push(s);
      db.active = s.id;
      db.open.push(s.id);
      persist();
      IDE.bus.emit("scripts");
      IDE.bus.emit("opentabs");
      IDE.bus.emit("script", s);
      return s;
    },
    setActive: function (id) {
      var s = byId(id);
      if (!s || db.active === id) return;
      db.active = id;
      var opened = ensureOpen(id);
      persist();
      if (opened) IDE.bus.emit("opentabs");
      IDE.bus.emit("script", s);
    },
    /* Open a script as a tab and make it active. Same as setActive but named
       for intent -- this is what the Scripts list and "+ New" call. */
    open: function (id) {
      var s = byId(id);
      if (!s) return;
      var opened = ensureOpen(id);
      var switched = db.active !== id;
      db.active = id;
      persist();
      if (opened) IDE.bus.emit("opentabs");
      if (switched) IDE.bus.emit("script", s);
    },
    /* Close a tab. If it was active, fall back to the neighbouring open tab.
       Never closes the last tab (there is always one script showing). */
    closeTab: function (id) {
      var i = db.open.indexOf(id);
      if (i === -1 || db.open.length <= 1) return;
      db.open.splice(i, 1);
      var switched = false;
      if (db.active === id) {
        db.active = db.open[Math.min(i, db.open.length - 1)];
        switched = true;
      }
      persist();
      IDE.bus.emit("opentabs");
      if (switched) IDE.bus.emit("script", active());
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
      var oi = db.open.indexOf(id);
      if (oi !== -1) db.open.splice(oi, 1);
      if (!db.scripts.length) {
        var fresh = { id: uid(), name: "Welcome", code: STARTER, mtime: Date.now() };
        db.scripts.push(fresh);
      }
      if (!db.open.length) db.open.push(db.scripts[0].id);
      if (db.active === id) {
        db.active = db.open[Math.min(oi < 0 ? 0 : oi, db.open.length - 1)];
        persist();
        IDE.bus.emit("scripts");
        IDE.bus.emit("opentabs");
        IDE.bus.emit("script", active());
        return;
      }
      persist();
      IDE.bus.emit("scripts");
      IDE.bus.emit("opentabs");
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
