/* 63_shell.js -- wires the docking layout to the app.
 *
 * Registers every panel with the dock, mounts it into #dockRoot, and builds the
 * left activity bar. The activity bar is the way back to a panel you closed or
 * lost: click an icon and the dock reveals that panel (re-adding it if it had
 * been closed), VS Code style. Panel *arrangement* is the dock's job; this file
 * only decides what exists and how to summon it.
 */
(function () {
  var IDE = window.IDE, $ = IDE.$;

  /* id -> {title, icon, activity}. Order here is the activity-bar order.
     `activity:false` = registered and dockable, but not a summon button
     (the editor and output are effectively always present). */
  var PANELS = [
    ["editor",    "Editor",    "‹›", false],
    ["output",    "Output",    "▤",  false],
    ["scripts",   "Scripts",   "❑",  true],
    ["examples",  "Examples",  "◫",  true],
    ["api",       "API",       "ƒ",  true],
    ["templates", "Templates", "⬢",  true],
    ["inspect",   "Inspect",   "🔍", true],
    ["assist",    "Assistant", "✦",  true],
    ["map",       "Map",       "🗺", true]
  ];

  PANELS.forEach(function (p) {
    IDE.dock.register(p[0], { title: p[1], closable: p[3] });
  });

  IDE.dock.mount($("dockRoot"));

  /* ---- activity bar ------------------------------------------------------ */
  var bar = $("activity");
  var buttons = {};
  PANELS.filter(function (p) { return p[3]; }).forEach(function (p) {
    var b = document.createElement("button");
    b.className = "actbtn";
    b.type = "button";
    b.title = p[1];
    b.textContent = p[2];
    b.setAttribute("aria-label", p[1]);
    b.onclick = function () {
      /* If it's already the active tab of a visible leaf, a second click hides
         it (toggle); otherwise reveal + focus it. */
      if (IDE.dock.isOpen(p[0]) && b.classList.contains("active")) {
        IDE.dock.close ? IDE.dock.close(p[0]) : IDE.dock.show(p[0]);
      } else {
        IDE.dock.show(p[0]);
      }
    };
    buttons[p[0]] = b;
    bar.appendChild(b);
  });

  /* Keep the activity bar in sync: an icon is "active" when its panel is the
     visible tab of some leaf. */
  function sync() {
    PANELS.forEach(function (p) {
      var b = buttons[p[0]]; if (!b) return;
      b.classList.toggle("active", IDE.dock.activeSomewhere(p[0]));
      b.classList.toggle("present", IDE.dock.isOpen(p[0]));
    });
  }
  IDE.dock.on("change", sync);
  sync();

  /* A reset-layout affordance, tucked at the bottom of the activity bar. */
  var spacer = document.createElement("div");
  spacer.className = "actspace";
  bar.appendChild(spacer);
  var reset = document.createElement("button");
  reset.className = "actbtn dim";
  reset.type = "button";
  reset.title = "Reset the panel layout";
  reset.textContent = "⟲";
  reset.onclick = function () { IDE.dock.reset(); };
  bar.appendChild(reset);
})();
