/* smoke.js -- boot the BUILT dist/index.html headlessly in jsdom and exercise the app's real APIs:
 * store CRUD + migration, editor get/set/insert, lint verdicts, run gating, examples/API data presence.
 * jsdom has no layout engine, so CodeMirror's measurement calls get tiny stubs -- rendering fidelity is
 * Logan's half of the test; THIS half proves the page boots wire-to-wire with no module blowing up.
 * Run:  node smoke.js   (from tools/vendor; exits 1 on any failure) */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "dist", "index.html"), "utf8");

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => { if (!/Could not parse CSS/.test(String(e))) errors.push("jsdomError: " + e.message); });
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://127.0.0.1:27050/",
  pretendToBeVisual: true,          // requestAnimationFrame etc.
  virtualConsole: vc,
  beforeParse(window) {
    // no layout engine: CodeMirror measures rects constantly -- give it harmless zeros
    const rect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
    window.Range.prototype.getClientRects = function () { const l = [rect()]; l.item = i => l[i]; return l; };
    window.Range.prototype.getBoundingClientRect = rect;
    window.Element.prototype.getClientRects = function () { const l = [rect()]; l.item = i => l[i]; return l; };
    window.Element.prototype.scrollIntoView = function () {};
    // the page auto-connects; give it a WebSocket that just sits there closed
    window.WebSocket = class {
      constructor() { setTimeout(() => this.onclose && this.onclose({}), 5); }
      send() {} close() {}
    };
  },
});

const w = dom.window;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? " -- " + extra : "")); }
}

setTimeout(() => {
  const IDE = w.IDE;
  ok("page booted, IDE namespace exists", !!IDE);
  ok("no page errors during boot", errors.length === 0, errors.join(" | "));
  ok("data: ESS_API loaded", w.ESS_API && w.ESS_API.completions.length > 400, w.ESS_API && w.ESS_API.completions.length);
  ok("data: natives loaded", w.MERCS_NATIVES && Object.keys(w.MERCS_NATIVES.natives).length === 40);
  ok("data: examples loaded", w.ESS_EXAMPLES && w.ESS_EXAMPLES.categories.length === 8);

  // ---- store ----
  ok("store: starts with Welcome script", IDE.store.list().length === 1 && IDE.store.active().name === "Welcome");
  const s2 = IDE.store.create("Test script", "return 1");
  ok("store: create + becomes active", IDE.store.active().id === s2.id && IDE.store.list().length === 2);
  ok("editor: loaded new script's code", IDE.editor.get() === "return 1");
  IDE.store.rename(s2.id, "Renamed");
  ok("store: rename", IDE.store.get(s2.id).name === "Renamed");
  IDE.store.duplicate(s2.id);
  ok("store: duplicate", IDE.store.list().length === 3 && IDE.store.active().name === "Renamed copy");
  IDE.store.remove(IDE.store.active().id);
  ok("store: remove falls back to a survivor", IDE.store.list().length === 2);
  ok("store: unique names", IDE.store.create("Renamed", "").name === "Renamed 2");

  // ---- editor ----
  IDE.editor.set("local x = 1\n");
  ok("editor: set/get round-trip", IDE.editor.get() === "local x = 1\n");
  IDE.editor.insertSnippet("Ess.Log(${msg})");
  ok("editor: snippet insert (placeholder resolved)", IDE.editor.get().indexOf("Ess.Log(msg)") === 0, JSON.stringify(IDE.editor.get()));

  // ---- lint verdicts through the real page ----
  ok("lint: syntax error caught", IDE.lint.validate("if x = 1 then end").errors.length === 1);
  ok("lint: Ess typo did-you-mean", /summon/.test((IDE.lint.validate('Ess.Easy.Vehicle.sumon("V")').warnings[0] || {}).message));
  ok("lint: freeze loop flagged", IDE.lint.validate("while true do end").warnings.some(d => /FREEZE/.test(d.message)));
  ok("lint: clean code is clean", IDE.lint.validate('Ess.Player.giveCash(1000)').warnings.length === 0);

  // ---- run gating (not connected; syntax error must block before the bridge) ----
  IDE.editor.set("function broken(");
  IDE.run();
  const res = w.document.getElementById("results").textContent;
  ok("run: syntax error blocks with friendly message", /didn't send it/.test(res), res.slice(0, 80));

  // ---- sidebar DOM actually rendered ----
  ok("scripts panel rendered rows", w.document.querySelectorAll(".scrow").length >= 2);
  ok("examples gallery rendered cards", w.document.querySelectorAll(".excard").length === 45);
  ok("API tree rendered (Ess + natives)", w.document.querySelectorAll(".ns").length > 100);

  // ---- theme toggle: auto -> dark -> light -> auto ----
  const themeBtn = w.document.getElementById("themeBtn");
  themeBtn.click();
  ok("theme: force dark", w.document.documentElement.getAttribute("data-theme") === "dark");
  themeBtn.click();
  ok("theme: force light + persisted", w.document.documentElement.getAttribute("data-theme") === "light" && w.localStorage.getItem("m2ide.theme") === "light");
  themeBtn.click();
  ok("theme: back to auto", !w.document.documentElement.hasAttribute("data-theme"));

  // ---- REPL: bare expression wraps in return(), history recorded ----
  const repl = w.document.getElementById("repl");
  repl.value = "Ess.VERSION";
  repl.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const rows = w.document.querySelectorAll("#results .row");
  const last = rows[rows.length - 1];
  ok("repl: expression auto-wrapped in return()", last && last.dataset.code.indexOf("return (Ess.VERSION") === 0, last && last.dataset.code);
  ok("repl: history persisted", (JSON.parse(w.localStorage.getItem("m2ide.replhist.v1")) || []).pop() === "Ess.VERSION");
  ok("repl: not-connected still friendly", /not connected/.test(last.textContent));

  // ---- re-run button exists and re-fires ----
  const before = w.document.querySelectorAll("#results .row").length;
  last.querySelector(".rerun").click();
  ok("results: re-run adds a fresh row", w.document.querySelectorAll("#results .row").length === before + 1);

  // ---- the serializer wrap is valid Lua ----
  let sent = null;
  const b = new w.EssBridge("ws://x", { WebSocketImpl: function () {} });
  b.state = "open";
  b.ws = { send: (d) => { sent = JSON.parse(d).code; } };
  b.run("return Ess.VERSION");
  let wrapOk = true, wrapErr = "";
  try { w.CM.luaparse.parse(sent, { luaVersion: "5.1" }); } catch (e) { wrapOk = false; wrapErr = e.message; }
  ok("bridge: serializer wrap parses as Lua 5.1", wrapOk, wrapErr);
  ok("bridge: wrap still single-line tagged protocol", /Loader\.WsSend\('<<<WSR:/.test(sent) && /__ideser/.test(sent));

  // ---- panic button goes through the gated path ----
  w.document.getElementById("panic").click();
  const panicRow = [...w.document.querySelectorAll("#results .row")].pop();
  ok("panic: stop-loops snippet submitted", /Ess\.Loop\.stop/.test(panicRow.dataset.code));

  // ---- layout + log chrome present ----
  ok("splitters present", !!w.document.getElementById("hsplit") && !!w.document.getElementById("vsplit"));
  ok("log filter + latest chip present", !!w.document.getElementById("logFilter") && !!w.document.getElementById("latest"));

  console.log(fail ? "\n" + fail + " FAILED, " + pass + " passed" : "\nall " + pass + " passed");
  process.exit(fail ? 1 : 0);
}, 400);
