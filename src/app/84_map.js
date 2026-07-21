/* 84_map.js -- world map tab.
 *
 * Not a port of the full webmap (that's a 2.65 MB terrain-analysis app). This is
 * the slice an IDE actually needs: where the player is, what the world
 * coordinates of a spot are, and how high the ground is there -- so you can
 * write `Pg.Spawn(t, x, y, z)` against a real place instead of guessing numbers.
 *
 * Data is baked by tools/gen_map.py into map-shade.png (relief) and
 * map-heights.b64 (coarse int16 grid), both inlined at build time so the IDE
 * stays a single offline file.
 *
 * Coordinate care, because two conventions bite here:
 *   - the source tensor is SOUTH-first (row 0 = min z); we flip for display so
 *     north is up, which means display row -> z is inverted.
 *   - world x runs WEST-positive in this game.
 */
(function () {
  var IDE = window.IDE, $ = IDE.$;

  var meta = null, shade = null, heights = null;
  var view = { scale: 1, ox: 0, oy: 0 };     /* canvas transform */
  var pin = null;                             /* {x, z} world */
  var player = null;                          /* {x, y, z} world */
  var follow = false, pollTimer = null, ready = false;

  function decodeHeights(b64) {
    var bin = atob(b64);
    var buf = new ArrayBuffer(bin.length);
    var u8 = new Uint8Array(buf);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Int16Array(buf);
  }

  /* ---- world <-> image ---------------------------------------------------- */

  function worldToImg(wx, wz) {
    var col = Math.floor(wx / meta.cell) - meta.originCellX;
    var iz = Math.floor(wz / meta.cell) - meta.originCellZ;
    return { x: col + 0.5, y: (meta.height - 1 - iz) + 0.5 };
  }

  function imgToWorld(px, py) {
    var col = Math.floor(px);
    var row = Math.floor(py);
    var iz = (meta.height - 1) - row;
    return {
      x: (col + meta.originCellX + 0.5) * meta.cell,
      z: (iz + meta.originCellZ + 0.5) * meta.cell
    };
  }

  function heightAt(wx, wz) {
    if (!heights) return null;
    var col = Math.floor(wx / meta.cell) - meta.originCellX;
    var iz = Math.floor(wz / meta.cell) - meta.originCellZ;
    if (col < 0 || iz < 0 || col >= meta.width || iz >= meta.height) return null;
    var ci = Math.floor(col / meta.coarseStep);
    var cr = Math.floor(iz / meta.coarseStep);
    var v = heights[cr * meta.coarseW + ci];
    if (v === meta.sentinel) return null;
    return v / 10;
  }

  /* ---- drawing ------------------------------------------------------------ */

  function draw() {
    var cv = $("mapCanvas");
    if (!cv || !shade) return;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    var g = cv.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#101014";
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = view.scale < 3;
    g.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    g.drawImage(shade, 0, 0);

    function ring(p, color, r) {
      g.beginPath();
      g.arc(p.x, p.y, r / view.scale, 0, 6.2832);
      g.strokeStyle = color;
      g.lineWidth = 2 / view.scale;
      g.stroke();
    }
    if (pin) {
      var pp = worldToImg(pin.x, pin.z);
      ring(pp, "#ffcc44", 6);
      g.beginPath();
      g.moveTo(pp.x - 9 / view.scale, pp.y); g.lineTo(pp.x + 9 / view.scale, pp.y);
      g.moveTo(pp.x, pp.y - 9 / view.scale); g.lineTo(pp.x, pp.y + 9 / view.scale);
      g.strokeStyle = "#ffcc44"; g.lineWidth = 1 / view.scale; g.stroke();
    }
    if (player) {
      var pl = worldToImg(player.x, player.z);
      ring(pl, "#49b4ff", 5);
      g.beginPath();
      g.arc(pl.x, pl.y, 2 / view.scale, 0, 6.2832);
      g.fillStyle = "#49b4ff"; g.fill();
    }
  }

  function fit() {
    var cv = $("mapCanvas");
    if (!cv || !shade) return;
    var s = Math.min(cv.clientWidth / shade.width, cv.clientHeight / shade.height);
    view.scale = s;
    view.ox = (cv.clientWidth - shade.width * s) / 2;
    view.oy = (cv.clientHeight - shade.height * s) / 2;
    draw();
  }

  function centreOn(wx, wz) {
    var cv = $("mapCanvas");
    var p = worldToImg(wx, wz);
    view.ox = cv.clientWidth / 2 - p.x * view.scale;
    view.oy = cv.clientHeight / 2 - p.y * view.scale;
    draw();
  }

  /* ---- readout ------------------------------------------------------------ */

  function fmt(n) { return (Math.round(n * 10) / 10).toString(); }

  function setReadout(wx, wz) {
    var el = $("mapReadout");
    if (!el) return;
    var y = heightAt(wx, wz);
    el.textContent = "x " + fmt(wx) + "   z " + fmt(wz) +
      (y === null ? "   (no height data)" : "   ground y " + fmt(y));
  }

  function pinText() {
    if (!pin) return "";
    var y = heightAt(pin.x, pin.z);
    return fmt(pin.x) + ", " + (y === null ? "0" : fmt(y)) + ", " + fmt(pin.z);
  }

  /* ---- live player -------------------------------------------------------- */

  var POS_LUA =
    "local u = Player.GetLocalCharacter() " +
    "if not u then return 'nil' end " +
    "local x, y, z = Object.GetPosition(u) " +
    "return tostring(x)..','..tostring(y)..','..tostring(z)";

  function pollPlayer() {
    if (!IDE.bridge || !IDE.bridge.connected()) { player = null; draw(); return; }
    IDE.bridge.run(POS_LUA).then(function (r) {
      if (!r || !r.ok || !r.value || r.value === "nil") return;
      var p = String(r.value).split(",").map(parseFloat);
      if (p.length < 3 || !isFinite(p[0])) return;
      player = { x: p[0], y: p[1], z: p[2] };
      if (follow) centreOn(player.x, player.z); else draw();
    }).catch(function () {});
  }

  function setPolling(on) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (on) { pollPlayer(); pollTimer = setInterval(pollPlayer, 1500); }
  }

  /* ---- init --------------------------------------------------------------- */

  function init() {
    var cv = $("mapCanvas");
    if (!cv) return;
    meta = window.MERCS_MAP_META;
    if (!meta) return;
    heights = window.MERCS_MAP_HEIGHTS ? decodeHeights(window.MERCS_MAP_HEIGHTS) : null;

    shade = new Image();
    shade.onload = function () { ready = true; fit(); };
    shade.src = window.MERCS_MAP_SHADE || "";

    /* pan */
    var drag = null;
    cv.addEventListener("mousedown", function (e) {
      drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
    });
    window.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      view.ox = drag.ox + dx; view.oy = drag.oy + dy;
      follow = false;
      var fb = $("mapFollow"); if (fb) fb.classList.remove("on");
      draw();
    });
    window.addEventListener("mouseup", function () { drag = null; });

    /* hover readout */
    cv.addEventListener("mousemove", function (e) {
      if (!ready) return;
      var r = cv.getBoundingClientRect();
      var px = (e.clientX - r.left - view.ox) / view.scale;
      var py = (e.clientY - r.top - view.oy) / view.scale;
      if (px < 0 || py < 0 || px >= shade.width || py >= shade.height) return;
      var wpt = imgToWorld(px, py);
      setReadout(wpt.x, wpt.z);
    });

    /* click to pin */
    cv.addEventListener("click", function (e) {
      if (!ready || (drag && drag.moved)) return;
      var r = cv.getBoundingClientRect();
      var px = (e.clientX - r.left - view.ox) / view.scale;
      var py = (e.clientY - r.top - view.oy) / view.scale;
      if (px < 0 || py < 0 || px >= shade.width || py >= shade.height) return;
      pin = imgToWorld(px, py);
      $("mapPin").textContent = pinText();
      draw();
    });

    /* zoom about the cursor */
    cv.addEventListener("wheel", function (e) {
      if (!ready) return;
      e.preventDefault();
      var r = cv.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var before = { x: (mx - view.ox) / view.scale, y: (my - view.oy) / view.scale };
      var k = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      view.scale = Math.max(0.15, Math.min(24, view.scale * k));
      view.ox = mx - before.x * view.scale;
      view.oy = my - before.y * view.scale;
      draw();
    }, { passive: false });

    $("mapFit").onclick = function () { follow = false; this.blur(); fit(); };
    $("mapFollow").onclick = function () {
      follow = !follow;
      this.classList.toggle("on", follow);
      if (follow && player) centreOn(player.x, player.z);
    };
    $("mapCopy").onclick = function () {
      if (!pin) return;
      if (navigator.clipboard) navigator.clipboard.writeText(pinText());
      var b = this; var old = b.textContent;
      b.textContent = "Copied"; setTimeout(function () { b.textContent = old; }, 1100);
    };
    $("mapInsert").onclick = function () {
      if (!pin || !IDE.editor) return;
      var t = pinText();
      if (IDE.editor.insertSnippet) IDE.editor.insertSnippet(t);
      else IDE.editor.set(IDE.editor.get() + "\n" + t);
    };
    $("mapTeleport").onclick = function () {
      if (!pin) return;
      var y = heightAt(pin.x, pin.z);
      var lua = "local u = Player.GetLocalCharacter() " +
        "if u then Object.SetPosition(u, " + fmt(pin.x) + ", " +
        ((y === null ? 0 : y) + 1.5) + ", " + fmt(pin.z) + ") end";
      IDE.runCode ? IDE.runCode(lua) : IDE.bridge.run(lua);
    };

    IDE.bus.on("status", function (s) { setPolling(s === "open"); });
    if (IDE.bridge && IDE.bridge.connected()) setPolling(true);

    /* the panel is hidden at load, so the canvas has no size until shown */
    Array.prototype.forEach.call(document.querySelectorAll('.stab[data-p="map"]'),
      function (t) { t.addEventListener("click", function () { setTimeout(fit, 0); }); });
    window.addEventListener("resize", function () { if (ready) draw(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
