/* 52_templates.js -- the Templates sidebar tab: browse every confirmed spawnable template name
   (window.MERCS_TEMPLATES, scraped by tools/gen_templates.py from Logan's own curated spawn menus) by
   category. Click a name to insert it as a quoted string at the caret -- the same one-click pattern the
   API panel's "Insert into script" button uses, just for magic strings instead of calls. This data is
   also the source behind the editor's in-string autocomplete (20_editor.js) and the linter's
   unknown-template warning (25_lint.js). */
(function () {
  var IDE = window.IDE, data = window.MERCS_TEMPLATES || { categories: [] };
  var tree = IDE.$("tplTree"), search = IDE.$("tplSearch");

  function build(filter) {
    filter = (filter || "").trim().toLowerCase();
    tree.innerHTML = "";
    data.categories.forEach(function (cat) {
      var items = cat.items.filter(function (it) { return !filter || it.name.toLowerCase().indexOf(filter) >= 0; });
      if (!items.length) return;
      var open = !!filter;
      var catEl = document.createElement("div"); catEl.className = "ns";
      catEl.innerHTML = cat.name + '<span class="g">' + items.length + "</span>";
      var wrap = document.createElement("div");
      function paint() {
        wrap.innerHTML = "";
        if (!open) return;
        items.forEach(function (it) {
          var el = document.createElement("div"); el.className = "call";
          el.textContent = it.name + (it.sub ? "  ·  " + it.sub : "");
          el.title = 'Insert "' + it.name + '" at the caret';
          el.onclick = function () { IDE.editor.insertSnippet('"' + it.name + '"'); };
          wrap.appendChild(el);
        });
      }
      catEl.onclick = function () { open = !open; paint(); };
      tree.appendChild(catEl); tree.appendChild(wrap); paint();
    });
    if (!tree.childElementCount) { var e = document.createElement("div"); e.className = "nsdoc"; e.textContent = "no matches"; tree.appendChild(e); }
  }

  search.addEventListener("input", function () { build(search.value); });
  IDE.templates = { build: build };
  build("");
})();
