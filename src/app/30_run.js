/* 30_run.js -- the one gated path from "code" to "the game". IDE.runCode(code, opts) is used by the Run
   button (selection or whole file), the REPL line, the Results re-run buttons, and the Stop-loops button.
   Before anything leaves the page it goes through IDE.lint: a syntax error BLOCKS the run with a
   plain-English message (and, for whole-file runs, jumps the caret there) -- a beginner should never
   wonder why the game ignored a script that could not have parsed. Warnings never block.

   Emits "ran" -> {code, result} on every completed round trip (never on a lint-block or not-connected
   early-return, since those never reached the game) -- the one hook a feature like the tutorial
   (80_tutorial.js) needs to advance a step only once a REAL result comes back, regardless of whether the
   code arrived via the Run button, the REPL, or a Results row's rerun. */
(function () {
  var IDE = window.IDE;

  /* opts: { jumpOnError: move the caret to a syntax error (whole-file runs only) } */
  function runCode(code, opts) {
    opts = opts || {};
    code = (code || "").trim();
    if (!code) return;

    if (IDE.lint) {
      var v = IDE.lint.validate(code);
      if (v.errors.length) {
        var e = v.errors[0];
        IDE.console.pending(code);
        IDE.console.result({ ok: false, error: "didn't send it — line " + e.line + ": " + e.message });
        if (opts.jumpOnError) { IDE.editor.jumpTo(e.line, e.col); IDE.editor.relint(); }
        return;
      }
    }

    if (!IDE.bridge.connected()) {
      IDE.console.pending(code);
      IDE.console.result({ ok: false, error: "not connected to the game — hit Connect (top right). Green dot = live, then Run again." });
      return;
    }

    IDE.console.pending(code);
    IDE.bridge.run(code).then(function (r) { IDE.console.result(r); IDE.bus.emit("ran", { code: code, result: r }); });
  }

  function run() {
    var sel = IDE.editor.selection();
    runCode(sel || IDE.editor.get(), { jumpOnError: !sel });
  }

  IDE.run = run;
  IDE.runCode = runCode;
  IDE.bus.on("run", run);
})();
