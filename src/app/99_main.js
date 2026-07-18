/* 99_main.js -- bootstrap. Restore the saved WS url, open the active script from the library (a #s= share
   link becomes a NEW script so it never overwrites anyone's work), connect, and pop the onboarding card if
   we're not live shortly after load. */
(function () {
  var IDE = window.IDE, $ = IDE.$;

  var savedWs = null; try { savedWs = localStorage.getItem(IDE.cfg.wsKey); } catch (e) {}
  if (savedWs) $("url").value = savedWs;

  /* #z= is the LZ-string-compressed {n: name, c: code} form; #s= is the older plain-encoded, name-less
     form -- still parsed forever so a link minted before compression shipped keeps working. */
  var hz = /[#&]z=([^&]+)/.exec(location.hash || "");
  var hs = !hz && /[#&]s=([^&]+)/.exec(location.hash || "");
  if (hz || hs) {
    var sharedName = "Shared script", shared = null;
    try {
      if (hz) {
        var raw = (window.CM && CM.LZString) ? CM.LZString.decompressFromEncodedURIComponent(hz[1]) : null;
        var obj = raw != null ? JSON.parse(raw) : null;
        if (obj && typeof obj.c === "string") { shared = obj.c; if (obj.n) sharedName = obj.n; }
      } else {
        shared = decodeURIComponent(hs[1]);
      }
    } catch (e) {}
    if (shared != null) {
      IDE.store.create(sharedName, shared);   // emits "script" -> 55 loads it into the editor
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    }
  }
  if (!IDE.editor.get()) IDE.editor.reset(IDE.store.active().code);
  IDE.scriptsPanel.render();

  IDE.bridge.connect($("url").value);
  setTimeout(function () { if (IDE.bridge.state() !== "open") $("onboard").hidden = false; }, 2500);
  IDE.editor.focus();
})();
