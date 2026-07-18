/* 60_ui.js -- toolbar + chrome wiring: connect/disconnect, run/save/share, the sidebar's Scripts/Examples/API
   tabs, output tabs, onboarding, status dot, and the debounced autosave into the script library. */
(function () {
  var IDE = window.IDE, $ = IDE.$;

  function flash(btn, msg) { var o = btn.textContent; btn.textContent = msg; setTimeout(function () { btn.textContent = o; }, 1100); }
  function save() { IDE.store.saveActive(IDE.editor.get()); }

  IDE.bus.on("status", function (s) {
    $("dot").className = "dot " + s; $("state").textContent = s;
    $("connect").textContent = (s === "open" || s === "connecting") ? "Disconnect" : "Connect";
    if (s === "open") $("onboard").hidden = true;
  });

  $("connect").onclick = function () {
    var st = IDE.bridge.state();
    if (st === "open" || st === "connecting") { IDE.bridge.disconnect(); }
    else { try { localStorage.setItem(IDE.cfg.wsKey, $("url").value); } catch (e) {} IDE.bridge.connect($("url").value); }
  };
  $("run").onclick = function () { IDE.run(); };
  $("panic").onclick = function () {
    IDE.runCode('local n = 0\n' +
      'for id in pairs(Ess.Loop._reg) do Ess.Loop.stop(id) n = n + 1 end\n' +
      'if Ess.Time and Ess.Time.restoreScale then Ess.Time.restoreScale() end\n' +
      'return "stopped " .. n .. " loop(s), time scale restored"');
  };
  $("save").onclick = function () { save(); flash($("save"), "Saved"); };
  IDE.bus.on("save", function () { save(); flash($("save"), "Saved"); });
  $("share").onclick = function () {
    var code = IDE.editor.get(), name = IDE.store.active().name;
    /* LZ-string the payload (~3-4x more script per link) and carry the script name along -- #z= is the
       compressed form; #s= (plain encodeURIComponent, no name) is the old format, kept working forever
       as the fallback for any link minted before this shipped, or if LZString somehow isn't on window.CM. */
    var packed = (window.CM && CM.LZString) ? CM.LZString.compressToEncodedURIComponent(JSON.stringify({ n: name, c: code })) : null;
    var url = packed
      ? location.origin + location.pathname + "#z=" + packed
      : location.origin + location.pathname + "#s=" + encodeURIComponent(code);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { flash($("share"), "Link copied"); }, function () { prompt("Copy this link:", url); });
    else prompt("Copy this link:", url);
  };

  /* "grab what I'm aiming at" -- one click instead of a docs hunt for "how do I get a guid". Not routed
     through IDE.runCode: this is a fixed, trusted snippet, not user code, so it skips the lint gate and
     just needs the connected check that gate would otherwise provide. */
  $("grabTarget").onclick = function () {
    if (!IDE.bridge.connected()) { flash($("grabTarget"), "not connected"); return; }
    IDE.bridge.run(
      'local uGuid = Ess.Player.targetUnderReticle(0)\n' +
      'if not uGuid then return nil end\n' +
      'return tostring(uGuid) .. "\\t" .. Ess.Probe.describeSafe(uGuid)'
    ).then(function (r) {
      if (!r.ok || r.value == null) { flash($("grabTarget"), "nothing aimed at"); return; }
      var parts = String(r.value).split("\t");
      IDE.editor.insertSnippet(parts[0]);
      flash($("grabTarget"), parts[1] ? (parts[1].length > 34 ? parts[1].slice(0, 34) + "…" : parts[1]) : "grabbed");
    });
  };

  /* sidebar panels: Scripts / Examples / API */
  Array.prototype.forEach.call(document.querySelectorAll(".stab"), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll(".stab"), function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      var which = t.getAttribute("data-p");
      $("panelScripts").classList.toggle("hidden", which !== "scripts");
      $("panelExamples").classList.toggle("hidden", which !== "examples");
      $("panelApi").classList.toggle("hidden", which !== "api");
      $("panelTemplates").classList.toggle("hidden", which !== "templates");
      $("panelInspect").classList.toggle("hidden", which !== "inspect");
    };
  });

  /* output tabs */
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      var which = t.getAttribute("data-t");
      $("results").classList.toggle("hidden", which !== "results");
      $("log").classList.toggle("hidden", which !== "log");
      $("logFilter").classList.toggle("hidden", which !== "log" && which !== "results");
      $("logFilter").placeholder = which === "results" ? "filter results…" : "filter the log…";
      $("hlRules").classList.toggle("hidden", which !== "log");
      $("watchPanel").classList.toggle("hidden", which !== "watch");
      if (which !== "log") $("hlPanel").classList.add("hidden");
      $("latest").classList.add("hidden");
    };
  });
  $("clr").onclick = function () { var on = document.querySelector(".tab.on").getAttribute("data-t"); IDE.console.clear(on); };
  $("onboardClose").onclick = function () { $("onboard").hidden = true; };

  var t = null;
  IDE.bus.on("editorchange", function () { clearTimeout(t); t = setTimeout(save, 700); });

  IDE.ui = { flash: flash, save: save };
})();
