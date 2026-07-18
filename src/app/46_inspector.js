/* 46_inspector.js -- the Inspect sidebar tab: click 🔍 on a Results row (40_console.js) and it takes over
   the sidebar with a live view of that guid -- name/position/health/faction/alive + Ess.Probe.describeSafe,
   one compound round-trip so every field lands in a single poll, re-polling every couple seconds while
   connected (same pattern as the Watch tab). Single-slot: inspecting a new value replaces whatever was
   there before, since this is "look at the thing I just got", not a pinned list. Not persisted across
   reload -- a stale guid from a past session is never a live object anyway. */
(function () {
  var IDE = window.IDE, $ = IDE.$, INTERVAL = 2000;
  var head = $("inspectHead"), exprEl = $("inspectExpr"), empty = $("inspectEmpty"), fields = $("inspectFields");
  var expr = null, timer = null;

  var FIELDS = [
    { key: "guid", label: "Guid" },
    { key: "name", label: "Name" },
    { key: "pos", label: "Position" },
    { key: "health", label: "Health" },
    { key: "maxHealth", label: "Max HP" },
    { key: "faction", label: "Faction" },
    { key: "alive", label: "Alive" },
    { key: "describe", label: "Description" }
  ];
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function query(e) {
    return "local uGuid = (" + e + "\n)\n" +
      "if uGuid == nil then return \"\" end\n" +
      "local function safe1(fn, ...) local ok, a = pcall(fn, ...); if ok then return a end return nil end\n" +
      "local name = safe1(Ess.Object.displayName, uGuid)\n" +
      "local hp = safe1(Ess.Object.health, uGuid)\n" +
      "local maxhp = safe1(Ess.Object.maxHealth, uGuid)\n" +
      "local fac = safe1(Ess.Probe.getFaction, uGuid)\n" +
      "local alive = safe1(Ess.Object.alive, uGuid)\n" +
      "local okpos, x, y, z = pcall(Ess.Object.pos, uGuid)\n" +
      "local posStr = (okpos and x) and string.format(\"%.1f, %.1f, %.1f\", x, y, z) or \"?\"\n" +
      "local descOk, desc = pcall(Ess.Probe.describeSafe, uGuid)\n" +
      "return table.concat({ tostring(uGuid), name and tostring(name) or \"?\", posStr,\n" +
      "  hp and tostring(hp) or \"?\", maxhp and tostring(maxhp) or \"?\", fac and tostring(fac) or \"?\",\n" +
      "  (alive == true) and \"yes\" or (alive == false and \"no\" or \"?\"), descOk and tostring(desc) or \"?\" }, \"\\t\")";
  }
  function renderFields(parts) {
    fields.innerHTML = "";
    FIELDS.forEach(function (f, i) {
      var d = document.createElement("div"); d.className = "inspectfield";
      d.innerHTML = "<span class=\"ifk\">" + f.label + "</span><span class=\"ifv\">" + esc(parts[i] || "?") + "</span>";
      fields.appendChild(d);
    });
  }
  function renderStatus(text, cls) {
    fields.innerHTML = "";
    var d = document.createElement("div"); d.className = "inspectstatus " + cls; d.textContent = text;
    fields.appendChild(d);
  }
  function poll() {
    if (!expr) return;
    if (!IDE.bridge.connected()) { renderStatus("· not connected", "dim"); return; }
    IDE.bridge.run(query(expr)).then(function (r) {
      if (!expr) return;   // stopped while the request was in flight
      if (r.error) { renderStatus(r.error, "err"); return; }
      if (r.timedOut) { renderStatus("timed out", "err"); return; }
      if (r.ok === false) { renderStatus("error: " + r.value, "err"); return; }
      if (r.value === "" || r.value == null) { renderStatus("nil (not a live object)", "dim"); return; }
      renderFields(String(r.value).split("\t"));
    });
  }
  function stop() {
    clearInterval(timer); timer = null; expr = null;
    head.classList.add("hidden");
    empty.classList.remove("hidden");
    fields.classList.add("hidden");
  }
  function inspect(e) {
    clearInterval(timer);
    expr = e;
    exprEl.textContent = e; exprEl.title = e;
    head.classList.remove("hidden");
    empty.classList.add("hidden");
    fields.classList.remove("hidden");
    fields.innerHTML = "";
    poll();
    timer = setInterval(poll, INTERVAL);
    var tab = document.querySelector('.stab[data-p="inspect"]');
    if (tab) tab.click();
  }
  $("inspectClose").onclick = stop;
  IDE.bus.on("status", function (s) { if (s === "open" && expr) poll(); });

  IDE.inspector = { inspect: inspect };
})();
