/* 78_tutorial.js -- the guided first-script tutorial: connect -> say hello -> summon a taxi -> find a fare
   -> hold them -> mark the pickup/drop-off -> deploy it. One script, additively built in place across all
   six steps -- each step's code is the FULL accumulated script so far, so it's always immediately
   re-runnable (hot-reloadable) exactly as it'll behave once deployed, never a disconnected snippet the
   player has to mentally stitch together. Lives in its own dedicated "Tutorial: Taxi Fare" library entry
   so it never clobbers whatever the player already had open.

   Every step advances off a REAL signal from the game (30_run.js's "ran" bus event, carrying the actual
   bridge result) or real app state (bridge "status", or 55_scripts.js's "deployed" event) -- never just a
   "Next" click. All six code steps were live-verified against a running game before being written here:
   Ess.Probe.nearby(..., "humans") + Ess.Probe.getFaction == "Civ" finds a civilian, Ess.AIOrders.command
   with "hold" needs no extra opts, Ess.Mark.object + Ess.Easy.Mark.zone place the pickup/drop-off markers. */
(function () {
  var IDE = window.IDE, $ = IDE.$;
  var panel = $("tutorial"), stepLbl = $("tutStep"), dotsEl = $("tutDots"), titleEl = $("tutTitle"),
      bodyEl = $("tutBody"), toastEl = $("tutToast"), hintEl = $("tutHint"), doneEl = $("tutDone");
  var TUT_NAME = "Tutorial: Taxi Fare";
  var active = false, idx = -1, toastTimer = null;

  var TAXI_1 =
    'local uTaxi = Ess.Easy.Vehicle.summon("R90 Taxi")\n' +
    'return uTaxi and "your taxi\'s here" or "spawn failed -- try again"';
  var TAXI_2 =
    'local uTaxi = Ess.Easy.Vehicle.summon("R90 Taxi")\n\n' +
    'local px, py, pz = Ess.Player.pose(0)\n' +
    'local nearby = Ess.Probe.nearby(px, py, pz, 150, "humans")\n' +
    'local uFare = nil\n' +
    'for _, g in ipairs(nearby) do\n' +
    '  if Ess.Probe.getFaction(g) == "Civ" then uFare = g break end\n' +
    'end\n' +
    'return uFare and ("found a fare: " .. Ess.Name(uFare)) or "no civilians nearby -- try driving somewhere busier"';
  var TAXI_3 =
    'local uTaxi = Ess.Easy.Vehicle.summon("R90 Taxi")\n\n' +
    'local px, py, pz = Ess.Player.pose(0)\n' +
    'local nearby = Ess.Probe.nearby(px, py, pz, 150, "humans")\n' +
    'local uFare = nil\n' +
    'for _, g in ipairs(nearby) do\n' +
    '  if Ess.Probe.getFaction(g) == "Civ" then uFare = g break end\n' +
    'end\n' +
    'if not uFare then return "no civilians nearby -- try driving somewhere busier" end\n\n' +
    'Ess.AIOrders.command({ uFare }, "hold")\n' +
    'return "they\'re waiting for you now"';
  var TAXI_4 =
    'local uTaxi = Ess.Easy.Vehicle.summon("R90 Taxi")\n\n' +
    'local px, py, pz = Ess.Player.pose(0)\n' +
    'local nearby = Ess.Probe.nearby(px, py, pz, 150, "humans")\n' +
    'local uFare = nil\n' +
    'for _, g in ipairs(nearby) do\n' +
    '  if Ess.Probe.getFaction(g) == "Civ" then uFare = g break end\n' +
    'end\n' +
    'if not uFare then return "no civilians nearby -- try driving somewhere busier" end\n\n' +
    'Ess.AIOrders.command({ uFare }, "hold")\n' +
    'Ess.Mark.object(uFare, { kind = "objective", disc = true, radius = 4 })\n\n' +
    'local fx, fy, fz = Ess.Object.pos(uFare)\n' +
    'Ess.Easy.Mark.zone(fx + 30, fy, fz + 30, 8)\n\n' +
    'return "fare marked, destination ring dropped -- go pick them up!"';

  function stripQ(s) { return String(s).replace(/^"|"$/g, ""); }

  var STEPS = [
    { title: "Connect to your game",
      body: "This editor talks to your actual running game over a live socket. Hit <b>Connect</b> (top right) — the dot turns green once you're live.",
      code: null, watch: "status" },
    { title: "Say hello",
      body: "Let's make sure it's really talking to your game. Hit <b>Run</b> (▷) or press Ctrl/Cmd+Enter.",
      code: "return Ess.VERSION", watch: "ran",
      test: function (r) { return r.ok && r.value; },
      toast: function (r) { return "Ess " + stripQ(r.value) + " — you're live."; } },
    { title: "Summon a taxi",
      body: "Time to build something real instead of a demo. This spawns a taxi and drops you in the driver's seat. Hit Run.",
      code: TAXI_1, watch: "ran",
      test: function (r) { return r.ok && /here/.test(String(r.value)); },
      toast: function () { return "You're behind the wheel."; } },
    { title: "Find a fare",
      body: "A taxi needs a fare. This scans everyone within 150 units and picks the first civilian it finds. Hit Run — no luck? Drive somewhere busier and run it again.",
      code: TAXI_2, watch: "ran",
      test: function (r) { return r.ok && /^"?found a fare/.test(String(r.value)); },
      toast: function (r) { return stripQ(r.value) + "."; } },
    { title: "Make them wait",
      body: "AI orders always take a LIST of guids, even for one person — this tells your fare to hold position. Hit Run.",
      code: TAXI_3, watch: "ran",
      test: function (r) { return r.ok && /waiting for you/.test(String(r.value)); },
      toast: function () { return "They're not going anywhere."; } },
    { title: "Mark the pickup and drop-off",
      body: "Last piece: mark your fare so you can see them, and drop a \"go here\" ring 30 units past them for the drop-off. Hit Run.",
      code: TAXI_4, watch: "ran",
      test: function (r) { return r.ok && /marked/.test(String(r.value)); },
      toast: function () { return "That's a real taxi-fare minigame."; } },
    { title: "Make it a real mod",
      body: "This script is complete — spawn, find, hold, mark, all in one run. Open <b>Actions ▾</b> in the Scripts sidebar and pick <b>⬇ Deploy as OnKey</b> to turn it into a mod you can bind to a key.",
      code: null, watch: "deployed" }
  ];

  function renderDots() {
    dotsEl.innerHTML = "";
    STEPS.forEach(function (s, i) {
      var d = document.createElement("span");
      d.className = "tutdot" + (i < idx ? " done" : i === idx ? " on" : "");
      dotsEl.appendChild(d);
    });
  }
  function showToast(msg) {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    toastTimer = setTimeout(function () { toastEl.classList.add("hidden"); }, 3200);
  }
  function showStep() {
    var s = STEPS[idx];
    doneEl.classList.add("hidden");
    stepLbl.textContent = "Step " + (idx + 1) + " of " + STEPS.length;
    titleEl.textContent = s.title;
    bodyEl.innerHTML = s.body;
    hintEl.classList.add("hidden");
    renderDots();
    if (s.code != null) IDE.editor.set(s.code);
    if (s.watch === "status" && IDE.bridge.connected()) advance();
  }
  function advance(toast) {
    if (toast) showToast(toast);
    idx++;
    if (idx >= STEPS.length) { finish(); return; }
    showStep();
  }
  function finish() {
    stepLbl.textContent = "All done";
    dotsEl.innerHTML = ""; titleEl.textContent = ""; bodyEl.innerHTML = ""; hintEl.classList.add("hidden");
    toastEl.classList.add("hidden");
    doneEl.classList.remove("hidden");
    active = false;
  }
  function stop() { active = false; panel.classList.add("hidden"); }
  function start() {
    active = true; idx = 0;
    var existing = IDE.store.list().filter(function (s) { return s.name === TUT_NAME; })[0];
    if (existing) IDE.store.setActive(existing.id); else IDE.store.create(TUT_NAME, "");
    document.querySelector('.stab[data-p="scripts"]').click();
    panel.classList.remove("hidden");
    showStep();
  }

  IDE.bus.on("status", function (s) {
    if (!active) return;
    var st = STEPS[idx];
    if (st && st.watch === "status" && s === "open") advance();
  });
  IDE.bus.on("ran", function (p) {
    if (!active) return;
    var s = STEPS[idx];
    if (!s || s.watch !== "ran") return;
    if (s.test(p.result)) { advance(s.toast ? s.toast(p.result) : null); }
    else {
      hintEl.textContent = p.result.ok === false ? "That errored — check the Results tab, fix it up, and run again."
        : "Not quite there yet — check the Results tab and try again.";
      hintEl.classList.remove("hidden");
    }
  });
  IDE.bus.on("deployed", function () {
    if (!active) return;
    var s = STEPS[idx];
    if (s && s.watch === "deployed") advance();
  });

  $("tutStart").onclick = start;
  $("tutClose").onclick = stop;
  $("tutDoneClose").onclick = stop;

  IDE.tutorial = { start: start, stop: stop };
})();
