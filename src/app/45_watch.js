/* 45_watch.js -- the Watch tab: pin expressions (Ess.Player.pose(0), Ess.Loop.isRunning("demo")) that
   re-poll every couple of seconds while connected, values updating live in a small table. The poor-man's
   debugger -- piggybacks on IDE.bridge.run, the same path the REPL uses, each row wrapping its expression
   the same way (`return (expr)`) so a bare expression just works. Each row is its own independent poll
   loop with a kill switch (the "×" button); polling silently no-ops while disconnected rather than
   erroring, and picks back up on its own once reconnected. Pinned expressions (not their last values)
   persist across reloads.

   The 🔍 object inspector (click on a Results row -- 40_console.js) lives in its own sidebar tab, not
   here -- see 46_inspector.js. */
(function () {
  var IDE = window.IDE, $ = IDE.$, KEY = "m2ide.watch.v1", INTERVAL = 2000;
  var list = $("watchList");
  var rows = [];

  function uid() { return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(rows.map(function (r) { return { expr: r.expr }; })));
    } catch (e) {}
  }
  function setStatus(row, text, cls) {
    row.valEl.className = "watchval " + cls;
    row.valEl.textContent = text;
  }

  function poll(row) {
    if (!IDE.bridge.connected()) { setStatus(row, "· not connected", "dim"); return; }
    IDE.bridge.run("return (" + row.expr + "\n)").then(function (r) {
      if (rows.indexOf(row) < 0) return;   // removed while the request was in flight
      if (r.error) { setStatus(row, r.error, "err"); return; }
      if (r.timedOut) { setStatus(row, "timed out", "err"); return; }
      if (r.ok === false) { setStatus(row, "error: " + r.value, "err"); return; }
      setStatus(row, (r.value === "" || r.value == null) ? "nil" : r.value, "ok");
    });
  }
  function removeRow(row) {
    clearInterval(row.timer);
    row.el.remove();
    rows = rows.filter(function (r) { return r !== row; });
    persist();
  }
  function addRow(expr) {
    var row = { id: uid(), expr: expr };
    var el = document.createElement("div"); el.className = "watchrow";
    var ex = document.createElement("span"); ex.className = "watchexpr"; ex.textContent = expr; ex.title = expr;
    var val = document.createElement("span"); val.className = "watchval dim"; val.textContent = "…";
    var rm = document.createElement("button"); rm.className = "watchrm"; rm.title = "Stop watching"; rm.textContent = "×";
    rm.onclick = function () { removeRow(row); };
    el.appendChild(ex); el.appendChild(val); el.appendChild(rm);
    row.valEl = val; row.el = el;
    list.appendChild(el);
    rows.push(row);
    poll(row);
    row.timer = setInterval(function () { poll(row); }, INTERVAL);
    return row;
  }

  $("watchAdd").onclick = function () {
    var expr = $("watchExpr").value.trim();
    if (!expr) return;
    addRow(expr);
    persist();
    $("watchExpr").value = "";
    $("watchExpr").focus();
  };
  $("watchExpr").addEventListener("keydown", function (e) { if (e.key === "Enter") $("watchAdd").click(); });

  var saved = [];
  try { saved = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) {}
  saved.forEach(function (s) { if (s && s.expr) addRow(s.expr); });

  /* a reconnect should re-poll everything right away rather than waiting out the interval */
  IDE.bus.on("status", function (s) { if (s === "open") rows.forEach(poll); });

  IDE.watch = { add: function (expr) { addRow(expr); persist(); } };
})();
