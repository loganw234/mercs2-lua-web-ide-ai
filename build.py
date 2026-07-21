#!/usr/bin/env python3
"""build.py -- merge src/ into ONE standalone dist/index.html.

Inlines everything (CSS, the generated Ess API JSON, the vendored ess-bridge.js, and every app/*.js) so
the output is a single self-contained file with zero external requests. That one file works three ways:
  * hosted on GitHub Pages (open the URL),
  * downloaded and opened straight off disk (file://),
  * served by the lua-bridge itself at http://127.0.0.1:27050/ (the bulletproof, all-browsers path).

Edit files under src/ (or regenerate the API with tools/gen_api.py), then re-run:  python build.py
"""
import base64
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"


def build_info():
    """The build's identity: the git commit it was built from. The downloaded copy compares this against
    the repo's current HEAD (75_update.js) to offer updates. Falls back to "dev" outside a git checkout."""
    try:
        sha = subprocess.check_output(["git", "rev-parse", "--short=7", "HEAD"], cwd=ROOT, text=True).strip()
        date = subprocess.check_output(["git", "show", "-s", "--format=%cI", "HEAD"], cwd=ROOT, text=True).strip()
        return {"sha": sha, "date": date}
    except Exception:
        return {"sha": "dev", "date": ""}


def guard(s):
    # never let inlined content close the <script>/<style> early
    return s.replace("</script", "<\\/script").replace("</style", "<\\/style")


def main():
    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = (SRC / "styles.css").read_text(encoding="utf-8")
    api = (SRC / "data" / "ess-api.json").read_text(encoding="utf-8")
    natives = (SRC / "data" / "natives.json").read_text(encoding="utf-8")
    examples = (SRC / "data" / "examples.json").read_text(encoding="utf-8")
    templates = (SRC / "data" / "templates.json").read_text(encoding="utf-8")
    # The assistant's reference packs. ALL tiers are bundled so a user can pick
    # the biggest one their model's context can hold, offline, with no fetch.
    # Copied from the wiki repo's helpbot/pack/ (build_pack.py --tiers); the
    # token counts and context guidance below must track those files.
    #   tokens: est_tokens from build_pack (chars/4). min_ctx: smallest context
    #   that holds the pack with usable headroom for a script + a few turns +
    #   the reply. headroom = min_ctx - tokens.
    PACK_TIERS = [
        {"key": "small", "label": "Small", "file": "pack-small.txt",
         "tokens": 10930, "min_ctx": 16384, "good_ctx": 32768,
         "note": "Core rules, gotchas, idioms, lua-bridge. Fits a 16k model with "
                 "~5k to spare (short scripts and brief chats). 32k is comfortable "
                 "(~21k headroom). The honest floor."},
        {"key": "smallplus", "label": "Small+", "file": "pack-smallplus.txt",
         "tokens": 45096, "min_ctx": 65536, "good_ctx": 131072,
         "note": "Adds the full namespace + game reference. Needs a 64k model "
                 "(~19k headroom for your script and the conversation)."},
        {"key": "medium", "label": "Medium", "file": "pack-medium.txt",
         "tokens": 98322, "min_ctx": 131072, "good_ctx": 200000,
         "note": "Adds Ess and the resident modules -- most questions answerable "
                 "without a wiki lookup. Needs 128k (~30k headroom)."},
        {"key": "large", "label": "Large", "file": "pack-large.txt",
         "tokens": 157480, "min_ctx": 200000, "good_ctx": 262144,
         "note": "Adds spawn templates + the contract framework. The ONLY tier "
                 "that carries the template list, so the only one that fully stops "
                 "invented spawn names. Needs 200k (~43k headroom)."},
        {"key": "full", "label": "Full", "file": "pack-full.txt",
         "tokens": 240032, "min_ctx": 262144, "good_ctx": 1000000,
         "note": "Everything, no omissions. ~16k headroom at 256k, so practical "
                 "only on long-context hosted models (DeepSeek V4, Gemini). Local "
                 "models generally cannot hold this."},
    ]
    packs = {}
    for t in PACK_TIERS:
        packs[t["key"]] = (SRC / "data" / "packs" / t["file"]).read_text(encoding="utf-8")
    pack_info = [{k: t[k] for k in ("key", "label", "tokens", "min_ctx", "good_ctx", "note")}
                 for t in PACK_TIERS]
    # Map tab data, baked by tools/gen_map.py from the webmap tensor.
    map_meta = (SRC / "data" / "map-meta.json").read_text(encoding="utf-8")
    map_heights = (SRC / "data" / "map-heights.b64").read_text(encoding="utf-8")
    map_white = base64.b64encode((SRC / "data" / "map-white.jpg").read_bytes()).decode("ascii")
    map_color = base64.b64encode((SRC / "data" / "map-color.png").read_bytes()).decode("ascii")

    parts = [(SRC / "lib" / "vendor.js").read_text(encoding="utf-8"),
             (SRC / "lib" / "ess-bridge.js").read_text(encoding="utf-8")]
    for p in sorted((SRC / "app").glob("*.js")):
        parts.append("/* ==== %s ==== */\n%s" % (p.name, p.read_text(encoding="utf-8")))
    app = "\n".join(parts)

    html = (html
            .replace("/*__CSS__*/", guard(css))
            .replace("/*__API__*/", "window.ESS_API=" + guard(api) + ";")
            .replace("/*__NATIVES__*/", "window.MERCS_NATIVES=" + guard(natives) + ";")
            .replace("/*__EXAMPLES__*/", "window.ESS_EXAMPLES=" + guard(examples) + ";")
            .replace("/*__TEMPLATES__*/", "window.MERCS_TEMPLATES=" + guard(templates) + ";")
            .replace("/*__PACK__*/",
                     "window.MERCS_PACKS=" + json.dumps(packs) + ";"
                     "window.MERCS_PACK_INFO=" + json.dumps(pack_info) + ";"
                     "window.MERCS_PACK=window.MERCS_PACKS.small;")
            .replace("/*__MAPDATA__*/",
                     "window.MERCS_MAP_META=" + guard(map_meta) + ";"
                     "window.MERCS_MAP_HEIGHTS=" + json.dumps(map_heights) + ";"
                     "window.MERCS_MAP_WHITE=\"data:image/jpeg;base64," + map_white + "\";"
                     "window.MERCS_MAP_COLOR=\"data:image/png;base64," + map_color + "\";")
            .replace("/*__BUILD__*/", "window.IDE_BUILD=" + json.dumps(build_info()) + ";")
            .replace("/*__APP__*/", guard(app)))

    out = ROOT / "dist" / "index.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print("[build] wrote %s (%d KB, %d app modules + vendor + bridge)" % (out, out.stat().st_size // 1024, len(parts) - 2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
