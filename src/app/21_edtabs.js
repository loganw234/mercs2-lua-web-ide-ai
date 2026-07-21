/* 21_edtabs.js -- the editor tab bar (open scripts as tabs).
 *
 * The script library (15_store.js) grew an ordered `open` set on top of its
 * `active` id; this renders that set as a tab strip above the editor, so several
 * scripts can be open at once and switching is a click, not a trip to the
 * sidebar list. The store stays the single source of truth -- this view just
 * reflects it and calls back into it (open/setActive/closeTab).
 *
 * Loads after 20_editor.js so IDE.store and the #edTabs element both exist.
 */
(function () {
  var IDE = window.IDE, $ = IDE.$;

  var strip = $("edTabs");
  if (!strip) return;

  function render() {
    var openIds = IDE.store.openTabs();
    var activeId = IDE.store.active().id;
    strip.textContent = "";

    openIds.forEach(function (id) {
      var s = IDE.store.get(id);
      if (!s) return;
      var tab = document.createElement("div");
      tab.className = "edtab" + (id === activeId ? " on" : "");
      tab.title = s.name;

      var label = document.createElement("span");
      label.className = "edtab-label";
      label.textContent = s.name;
      tab.appendChild(label);

      /* Close is offered only when more than one tab is open -- the editor
         always shows something, so the last tab has no close affordance. */
      if (openIds.length > 1) {
        var x = document.createElement("span");
        x.className = "edtab-x";
        x.textContent = "✕";
        x.title = "Close tab";
        x.onclick = function (e) { e.stopPropagation(); IDE.store.closeTab(id); };
        tab.appendChild(x);
      }

      tab.onclick = function () { IDE.store.setActive(id); };
      strip.appendChild(tab);
    });

    /* trailing "+" opens a fresh script, same as the sidebar's + New */
    var add = document.createElement("button");
    add.className = "edtab-add";
    add.type = "button";
    add.textContent = "+";
    add.title = "New script";
    add.onclick = function () { IDE.store.create("Untitled"); };
    strip.appendChild(add);
  }

  IDE.bus.on("opentabs", render);
  IDE.bus.on("scripts", render);      /* a rename changes a tab's label */
  IDE.bus.on("script", render);       /* active switched -> move the highlight */
  render();
})();
