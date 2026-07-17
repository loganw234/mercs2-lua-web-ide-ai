/* 35_theme.js -- the dark/light toggle (bottom-right). Cycles auto -> dark -> light; "auto" follows the
   OS preference (data-theme removed), a forced choice stamps data-theme on <html>. Persisted; a tiny
   inline <head> script applies the saved choice before first paint so there's no flash. */
(function () {
  var IDE = window.IDE, KEY = "m2ide.theme", btn = IDE.$("themeBtn");
  var MODES = ["auto", "dark", "light"];
  var ICON = { auto: "◐", dark: "☾", light: "☀" };
  var LABEL = { auto: "auto (following your system)", dark: "dark", light: "light" };

  var mode = "auto";
  try { var saved = localStorage.getItem(KEY); if (MODES.indexOf(saved) > 0) mode = saved; } catch (e) {}

  function apply() {
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    btn.textContent = ICON[mode];
    btn.title = "Theme: " + LABEL[mode] + " — click to switch";
    try { mode === "auto" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, mode); } catch (e) {}
  }

  btn.onclick = function () {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    apply();
  };
  apply();

  IDE.theme = { mode: function () { return mode; } };
})();
