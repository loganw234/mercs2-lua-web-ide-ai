/* 62_layout.js -- draggable splits: the sidebar edge (--sidew) and the editor/output divider (--outh).
   Plain pointer events, persisted to localStorage, sane clamps so nothing can be dragged into uselessness. */
(function () {
  var IDE = window.IDE, $ = IDE.$, KEY = "m2ide.layout.v1", rootStyle = document.documentElement.style;

  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
  if (saved.sidew) rootStyle.setProperty("--sidew", saved.sidew + "px");
  if (saved.outh) rootStyle.setProperty("--outh", saved.outh + "px");

  function persist() { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {} }

  function drag(el, onMove) {
    el.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      el.classList.add("drag");
      el.setPointerCapture(e.pointerId);
      function move(ev) { onMove(ev); }
      function up() {
        el.classList.remove("drag");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        persist();
      }
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }

  drag($("hsplit"), function (e) {
    saved.sidew = Math.max(180, Math.min(e.clientX, window.innerWidth * 0.5));
    rootStyle.setProperty("--sidew", saved.sidew + "px");
  });
  drag($("vsplit"), function (e) {
    var work = document.querySelector(".work").getBoundingClientRect();
    saved.outh = Math.max(120, Math.min(work.bottom - e.clientY, work.height - 120));
    rootStyle.setProperty("--outh", saved.outh + "px");
  });
})();
