/* 42_repl.js -- the one-line REPL under the output panel. Enter sends the line through the same gated
   IDE.runCode path as everything else; ArrowUp/Down walk a persisted history. A bare EXPRESSION
   ("Ess.VERSION", "1+1") isn't a valid Lua statement, so if `return (<input>)` parses we send that form
   instead -- a beginner poking at values always sees a result, never "unexpected symbol". */
(function () {
  var IDE = window.IDE, CM = window.CM, input = IDE.$("repl"), KEY = "m2ide.replhist.v1";

  var hist = [];
  try { hist = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) {}
  var nav = hist.length, draft = "";

  function parses(code) {
    try { CM.luaparse.parse(code, { luaVersion: "5.1" }); return true; } catch (e) { return false; }
  }

  function submit() {
    var raw = input.value.trim();
    if (!raw) return;
    var form = raw;
    var ret = "return (" + raw + "\n)";
    if (parses(ret)) form = ret;          // expression -> show its value (also surfaces call return values)
    IDE.runCode(form);
    hist = hist.filter(function (h) { return h !== raw; });
    hist.push(raw);
    if (hist.length > 50) hist = hist.slice(-50);
    try { localStorage.setItem(KEY, JSON.stringify(hist)); } catch (e) {}
    nav = hist.length; draft = "";
    input.value = "";
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (e.key === "ArrowUp") {
      if (!nav) return;
      if (nav === hist.length) draft = input.value;
      nav--; input.value = hist[nav];
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (nav >= hist.length) return;
      nav++;
      input.value = nav === hist.length ? draft : hist[nav];
      e.preventDefault();
    }
  });

  IDE.repl = {
    run: function (code) { IDE.runCode(code); },
    fill: function (code) { input.value = code; input.focus(); }
  };
})();
