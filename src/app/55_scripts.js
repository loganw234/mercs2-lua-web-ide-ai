/* 55_scripts.js -- the Scripts sidebar panel over IDE.store: the list (click to open), inline rename,
   duplicate / delete per row, + New, and .lua import/export. Also keeps the header's script-name label
   and the editor in sync when the active script changes. */
(function () {
  var IDE = window.IDE, $ = IDE.$;
  var list = $("scList"), nameEl = $("scriptName");

  function fmtWhen(t) {
    var d = Date.now() - t;
    if (d < 60e3) return "just now";
    if (d < 3600e3) return Math.round(d / 60e3) + "m ago";
    if (d < 86400e3) return Math.round(d / 3600e3) + "h ago";
    return new Date(t).toLocaleDateString();
  }

  function render() {
    var activeId = IDE.store.active().id;
    list.innerHTML = "";
    IDE.store.list().sort(function (a, b) { return b.mtime - a.mtime; }).forEach(function (s) {
      var row = document.createElement("div");
      row.className = "scrow" + (s.id === activeId ? " on" : "");
      var main = document.createElement("div"); main.className = "scmain";
      var nm = document.createElement("div"); nm.className = "scname"; nm.textContent = s.name;
      var when = document.createElement("div"); when.className = "scwhen"; when.textContent = fmtWhen(s.mtime);
      main.appendChild(nm); main.appendChild(when);
      main.onclick = function () { IDE.store.setActive(s.id); };
      main.ondblclick = function () { startRename(s, nm); };
      var acts = document.createElement("div"); acts.className = "scacts";
      [["✎", "Rename", function () { startRename(s, nm); }],
       ["⧉", "Duplicate", function () { IDE.store.duplicate(s.id); }],
       ["✕", "Delete", function () {
         if (confirm('Delete "' + s.name + '"? This cannot be undone.')) IDE.store.remove(s.id);
       }]].forEach(function (b) {
        var el = document.createElement("button");
        el.className = "scact"; el.textContent = b[0]; el.title = b[1];
        el.onclick = function (e) { e.stopPropagation(); b[2](); };
        acts.appendChild(el);
      });
      row.appendChild(main); row.appendChild(acts);
      list.appendChild(row);
    });
    nameEl.textContent = IDE.store.active().name;
  }

  function startRename(s, nm) {
    var input = document.createElement("input");
    input.className = "screname"; input.value = s.name; input.spellcheck = false;
    nm.replaceWith(input); input.focus(); input.select();
    var done = false;
    function commit(save) {
      if (done) return; done = true;
      if (save && input.value.trim() && input.value.trim() !== s.name) IDE.store.rename(s.id, input.value);
      else render();
    }
    input.onblur = function () { commit(true); };
    input.onkeydown = function (e) {
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    };
  }

  /* ---- toolbar: one "Actions" dropdown instead of a row of buttons -- new / import / export / backup /
     restore / deploy, each just a plain function here, wired to the <select>'s onchange below. ---- */
  function newScript() {
    IDE.store.create("Untitled", "-- " + new Date().toLocaleDateString() + "\n\n");
    IDE.editor.focus();
  }
  function importScripts() { $("scFile").click(); }
  $("scFile").onchange = function () {
    var files = Array.prototype.slice.call(this.files || []);
    this.value = "";
    files.forEach(function (f) {
      var rd = new FileReader();
      rd.onload = function () { IDE.store.create(f.name.replace(/\.(lua|txt)$/i, ""), String(rd.result)); };
      rd.readAsText(f);
    });
  };
  function exportScript() {
    var s = IDE.store.active();
    var blob = new Blob([IDE.editor.get()], { type: "text/x-lua" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = s.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") + ".lua" || "script.lua";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  /* ---- deploy as OnKey: bridges "ran it once in the IDE" to "it's a real mod now". Wraps the open
     script in the exact guard/state/action shape every Ess OnKey mod uses (samples/OnKey/StarterMod.lua),
     named after the script, ready to drop in scripts/OnKey/ and bind in lua_loader.ini. ---- */
  function onKeyWrap(modName, code) {
    return (
      "-- " + modName + ".lua -- exported from the Mercs2 Lua IDE. Bind it to a key in lua_loader.ini to\n" +
      "-- run it in-game:\n" +
      "--     [OnKey]\n" +
      "--     " + modName + ".lua=F5\n" +
      "-- ...then press that key in-game (pick any free key instead of F5). Needs Ess (1_Ess.lua) already\n" +
      "-- loaded as an OnLoad script.\n\n" +
      "-- GUARD -- bail cleanly if Ess isn't loaded (wrong load order, or not installed). Always first.\n" +
      "if not _G.Ess then Loader.Printf(\"" + modName + ": load Ess first (1_Ess.lua in scripts/OnLoad)\") return end\n\n" +
      "-- STATE -- an OnKey script re-runs top-to-bottom on EVERY keypress; this table survives across\n" +
      "-- those re-runs if your script needs to remember anything (a toggle, a counter, ...). Safe to\n" +
      "-- leave unused if it doesn't.\n" +
      "local S = Ess.State(\"" + modName + "\", {})\n\n" +
      "-- ACTION -- your script from the IDE, unchanged below this line.\n" +
      code
    );
  }
  function deployOnKey() {
    var s = IDE.store.active();
    var modName = s.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "MyMod";
    var wrapped = onKeyWrap(modName, IDE.editor.get());
    var blob = new Blob([wrapped], { type: "text/x-lua" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = modName + ".lua";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    flashActions("Downloaded — bind it in lua_loader.ini");
  }

  /* ---- whole-library backup / restore -- the seatbelt against "clear browsing data" ---- */
  function backupLibrary() {
    var blob = new Blob([IDE.store.exportAll()], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mercs2-ide-library-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function restoreLibrary() { $("scRestoreFile").click(); }
  $("scRestoreFile").onchange = function () {
    var file = (this.files || [])[0];
    this.value = "";
    if (!file) return;
    var rd = new FileReader();
    rd.onload = function () {
      var r = IDE.store.importAll(String(rd.result));
      if (r.ok) flashActions(r.added ? ("+" + r.added + " restored") : "0 found");
      else alert("Couldn't restore that file: " + r.error);
    };
    rd.readAsText(file);
  };

  /* ---- the dropdown itself: one <select> instead of six buttons. A message (deploy/restore) "flashes"
     by swapping the placeholder option's own text, since a <select>'s visible label is whatever option is
     selected, not any textContent of its own. ---- */
  var scActions = $("scActions"), placeholderOpt = scActions.querySelector('option[value=""]');
  function flashActions(msg) {
    var orig = placeholderOpt.textContent;
    placeholderOpt.textContent = msg;
    scActions.value = "";
    setTimeout(function () { placeholderOpt.textContent = orig; }, 1400);
  }
  scActions.onchange = function () {
    var v = this.value;
    this.value = "";
    if (v === "new") newScript();
    else if (v === "import") importScripts();
    else if (v === "export") exportScript();
    else if (v === "backup") backupLibrary();
    else if (v === "restore") restoreLibrary();
    else if (v === "deploy") deployOnKey();
  };

  /* ---- keep everything in sync ---- */
  IDE.bus.on("scripts", render);
  IDE.bus.on("script", function (s) {
    IDE.editor.reset(s.code);   // fresh editor state: switching scripts should not share undo history
    render();
    IDE.editor.focus();
  });

  IDE.scriptsPanel = { render: render };
  render();
})();
