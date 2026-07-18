#!/usr/bin/env python3
"""gen_templates.py -- build the template-name autocomplete/browser data from Logan's own spawn-menu
scripts, the highest-confidence source there is: every string in them was put there because someone
confirmed it actually spawns in-game (AllInOneSpawnMenu.lua's own comments even flag the couple of
DLC entries that DON'T spawn, which is what lets this script tell "confirmed" from "on this list but
known broken").

Primary sources (real, hand-curated spawn menus):
  - wad_reference/AllInOneSpawnMenu.lua  -- Ess.UI.Menu tree, ~500 vehicles + weapons + pickups +
    supply drops, each entry a `ctx:spawn("<template>", n)` / `ctx:hint("...")` pair. Nesting =
    Vehicles > {Empty|Fully Crewed|Driver Only} > <nation> > <family> > entry, which is mined into
    top-level category + a nation/weapon-type "sub". One real bug in the source is worked around here
    (see OPEN_RE below): a single "Capuchin Variants" node under Venezuelan Army/Fully Crewed is typo'd
    as `:entry(` instead of `:category(` -- it still opens a nested function block like every other
    category, so the parser treats anything that *opens a block without closing on the same line* as a
    category regardless of which method name introduced it.
  - wiki/sample-scripts-onkey.md's "CommonSpawnMenu.lua" entry -- a small embedded `tSpawnMenuOptions`
    table (Lua source lives only inside this wiki page, not as a standalone .lua file).

Supplementary sources (used ONLY to fill in Skins/FX, which the two menu scripts above don't cover at
all, plus a handful of extra confirmed weapon variants) -- both are wiki pages built from real
Pg.Spawn call sites / live spawn tests, not the raw unconfirmed hash-lookup table:
  - wiki/spawn-reference/pg-spawn-calls.md -- every literal string the shipped scripts pass to
    Pg.Spawn/Airstrike.SpawnOrdnance. Vehicle/weapon-shaped rows here are deliberately left alone (the
    two menu scripts already cover that ground far more thoroughly); only FX-shaped names
    (Explosion/particle/projectile/ordnance), a few standalone character templates ("VZ Soldier" etc,
    -> Skins), and a few misc world-prop templates get pulled in. DLC-only rows and a couple of
    ambiguous/test-looking ones are excluded (see EXCLUDE_DLC / EXCLUDE_AMBIGUOUS).
  - wiki/spawn-reference/weapons.md -- "confirmed, live spawn-tested" weapon pickups (46 rows); adds
    the case-variant/alias names (`Pistol (AL)`, `rifle`, `smg`, ...) the curated menu doesn't have.

Usage:  python tools/gen_templates.py
Writes: src/data/templates.json
"""
import html
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "templates.json"

DEFAULT_ALLINONE = r"C:\Users\logan\Desktop\Mercs2_Decompiled_Lua\docs\mercs2-luacd\wad_reference\AllInOneSpawnMenu.lua"
DEFAULT_ONKEY_WIKI = r"C:\Users\logan\Desktop\Mercs2_Decompiled_Lua\docs\mercs2-luacd\wiki\sample-scripts-onkey.md"
DEFAULT_PGSPAWN_MD = r"C:\Users\logan\Desktop\Mercs2_Decompiled_Lua\docs\mercs2-luacd\wiki\spawn-reference\pg-spawn-calls.md"
DEFAULT_WEAPONS_MD = r"C:\Users\logan\Desktop\Mercs2_Decompiled_Lua\docs\mercs2-luacd\wiki\spawn-reference\weapons.md"

CATEGORY_ORDER = ["Vehicles", "Weapons", "Skins", "FX", "Other"]

# ============================================================================
# AllInOneSpawnMenu.lua -- Ess.UI.Menu tree walker
# ============================================================================

# A leaf entry: everything (label, spawn call, hint) lives on one line and closes with its own end).
ENTRY_RE = re.compile(
    r':entry\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*function\(ctx\)\s*'
    r'ctx:spawn\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*\d+\s*\)\s*;?\s*'
    r'ctx:hint\(\s*"((?:[^"\\]|\\.)*)"\s*\)'
)
# A category node: opens a nested function and does NOT close on the same line. Matches both the real
# `:category(` calls and the one mistyped `:entry(` node mentioned above -- what matters structurally is
# that the line ends right after `function(param)` with nothing following.
OPEN_RE = re.compile(r':(?:category|entry)\(\s*"([^"]*)"\s*,\s*function\s*\([^)]*\)\s*$')

TOP_MAP = {"Vehicles": "Vehicles", "Weapons": "Weapons", "Pickups": "Other", "Supply Drops": "Other"}


def parse_allinone(path):
    """Returns (list of (category, sub, template) tuples, stats dict)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    stack = []
    out = []
    stats = {"unable": 0, "empty": 0, "underflow": 0}

    for raw in text.splitlines():
        line = raw.rstrip()
        m_entry = ENTRY_RE.search(line)
        if m_entry:
            label, template, hint = m_entry.groups()
            if not template:
                stats["empty"] += 1
                continue
            if "unable" in hint.lower():
                stats["unable"] += 1
                continue
            top_src = stack[0] if stack else ""
            category = TOP_MAP.get(top_src, "Other")
            if len(stack) >= 3:
                sub = stack[2]
            elif len(stack) >= 2:
                sub = stack[1]
            else:
                sub = ""
            # "Supply Drops" entries that aren't under a nested "Special Supply Drops" node have no
            # sub at all otherwise -- give them one so they're not the only ungrouped items in "Other".
            if not sub and top_src == "Supply Drops":
                sub = "Supply Drop"
            out.append((category, sub, template))
            continue
        m_open = OPEN_RE.search(line)
        if m_open:
            stack.append(m_open.group(1))
            continue
        if line.strip() == "end)":
            if stack:
                stack.pop()
            else:
                stats["underflow"] += 1
    return out, stats


# ============================================================================
# CommonSpawnMenu.lua -- embedded in the OnKey sample-scripts wiki page
# ============================================================================

OPTION_RE = re.compile(r'\{label\s*=\s*"([^"]*)"\s*,\s*action\s*=\s*"spawn"\s*,\s*template\s*=\s*"([^"]*)"\s*\}')
TRAILING_PAREN_RE = re.compile(r"\(([^)]+)\)\s*$")


def parse_commonspawn(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    idx = text.find("<strong>CommonSpawnMenu.lua</strong>")
    if idx == -1:
        return [], "CommonSpawnMenu.lua section not found in %s" % path
    m_block = re.search(r"```lua\n(.*?)\n```", text[idx:], re.S)
    if not m_block:
        return [], "no fenced lua block found after CommonSpawnMenu.lua heading"
    block = m_block.group(1)

    out = []
    for label, template in OPTION_RE.findall(block):
        if not template:
            continue
        if template.lower().startswith("explosion"):
            out.append(("FX", "Explosion", template))
        else:
            m_sub = TRAILING_PAREN_RE.search(label)
            sub = m_sub.group(1) if m_sub else ""
            out.append(("Vehicles", sub, template))
    return out, None


# ============================================================================
# Supplementary wiki tables (pg-spawn-calls.md / weapons.md) -- both render the
# same "<tr><td>name</td><td>key</td></tr>" hash-lookup table markup.
# ============================================================================

ROW_RE = re.compile(r"<tr><td>(.*?)</td><td>(.*?)</td></tr>")


def parse_html_table(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    return [(html.unescape(name), html.unescape(key)) for name, key in ROW_RE.findall(text)]


# pg-spawn-calls.md: every literal Pg.Spawn/SpawnOrdnance string in the shipped scripts. Vehicle/weapon
# rows are intentionally skipped here (already covered far more thoroughly by AllInOneSpawnMenu.lua /
# weapons.md) -- this source is mined only for FX, standalone character (Skins) templates, and a few
# misc world-prop names those two don't have at all.
FX_RE = re.compile(r"(?i)explosion|particle|projectile|shell|airstrike|flash|carpetbomb")
SKINS_EXACT = {
    "VZ Soldier": "VZ",
    "VZ Officer": "VZ",
    "VZ Deathsquad B HVT": "VZ",
    "OC Executive (OilCon002_Hostage)": "Mission NPC",
}
OTHER_EXACT = {
    "_global_containertransplant": "World Object",
    "_global_explosivebarrel_Long_Hibernation": "World Object",
    "_pmcoutpost_statueSolanobust_lowHP": "World Object",
    "_vzoutpost_fueltanks_PmcCon018": "World Object",
    "Verification Camera": "Utility",
}
# DLC content: excluded outright -- AllInOneSpawnMenu.lua's own hints confirm DLC templates do NOT spawn
# on a non-DLC install ("UNABLE TO SPAWN: DLC NOT ON PC"), so nothing with "dlc" in the name is
# confirmed-real for a typical player. "location" / "TankBuster_Instant" / "Explosion (TEST)" are
# excluded as ambiguous -- they read as a placeholder/keyword, an ability name, and a dev-test artifact
# respectively, not template names a modder would knowingly reach for.
EXCLUDE_AMBIGUOUS = {"location", "TankBuster_Instant", "Explosion (TEST)"}


def fx_sub(name):
    low = name.lower()
    if low.startswith("global_particle") or low.startswith("fx_"):
        return "Particle"
    if "explosion" in low:
        return "Explosion"
    return "Ordnance"


def classify_pgspawn(rows):
    out = []
    skipped_dlc = skipped_ambiguous = skipped_out_of_scope = 0
    for name, _key in rows:
        if not name:
            continue
        if "dlc" in name.lower():
            skipped_dlc += 1
            continue
        if name in EXCLUDE_AMBIGUOUS:
            skipped_ambiguous += 1
            continue
        if name in SKINS_EXACT:
            out.append(("Skins", SKINS_EXACT[name], name))
        elif name in OTHER_EXACT:
            out.append(("Other", OTHER_EXACT[name], name))
        elif FX_RE.search(name):
            out.append(("FX", fx_sub(name), name))
        else:
            skipped_out_of_scope += 1  # vehicle/weapon-shaped -- left to the primary sources
    return out, {"dlc": skipped_dlc, "ambiguous": skipped_ambiguous, "out_of_scope": skipped_out_of_scope}


def weapon_sub(name):
    low = name.lower()
    if "machine pistol" in low:
        return "Machine Pistols"
    if "pistol" in low:
        return "Pistols"
    if any(k in low for k in ("assault rifle", "bullpup", "combat rifle", "carbine")):
        return "Assault Rifles"
    if any(k in low for k in ("automatic rifle", "light mg")):
        return "Automatic Rifles"
    if low == "smg" or "covert smg" in low:
        return "SMGs"
    if "sniper" in low:
        return "Sniper Rifles"
    if any(k in low for k in ("at rocket", "stinger", "rpg", "grenade launcher", "fuel-air rpg")):
        return "Heavy"
    if any(k in low for k in ("minigun", "riot gun", "coilgun", "cheat rpg")):
        return "Special"
    return ""


def classify_weapons_md(rows):
    out = []
    for name, _key in rows:
        if not name:
            continue
        if name.startswith("Supply Drop"):
            out.append(("Other", "Supply Drop", name))
        else:
            out.append(("Weapons", weapon_sub(name), name))
    return out


# ============================================================================


def main():
    allinone_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ALLINONE)
    onkey_wiki_path = pathlib.Path(DEFAULT_ONKEY_WIKI)
    pgspawn_path = pathlib.Path(DEFAULT_PGSPAWN_MD)
    weapons_path = pathlib.Path(DEFAULT_WEAPONS_MD)

    for p in (allinone_path, onkey_wiki_path, pgspawn_path, weapons_path):
        if not p.exists():
            print("[gen_templates] missing source file: %s" % p)
            return 1

    allinone_entries, allinone_stats = parse_allinone(allinone_path)
    common_entries, common_err = parse_commonspawn(onkey_wiki_path)
    if common_err:
        print("[gen_templates] WARNING: %s" % common_err)

    pgspawn_rows = parse_html_table(pgspawn_path)
    pgspawn_entries, pgspawn_stats = classify_pgspawn(pgspawn_rows)

    weapons_rows = parse_html_table(weapons_path)
    weapons_entries = classify_weapons_md(weapons_rows)

    # Ingest in priority order -- first source to introduce a template string wins the category/sub
    # assignment; every later exact-string repeat (same source or a different one) is dropped, per the
    # "dedupe exact repeats, keep every genuinely distinct name" rule.
    categories = {name: [] for name in CATEGORY_ORDER}
    seen = {}

    def add_all(entries):
        for category, sub, name in entries:
            if not name or name in seen:
                continue
            seen[name] = category
            item = {"name": name, "sub": sub} if sub else {"name": name}
            categories.setdefault(category, []).append(item)

    add_all(allinone_entries)
    add_all(common_entries)
    add_all(weapons_entries)
    add_all(pgspawn_entries)

    total = sum(len(v) for v in categories.values())
    data = {
        "_source": (
            "AllInOneSpawnMenu.lua + CommonSpawnMenu.lua (Logan's hand-curated OnKey spawn menus) "
            "+ wiki spawn-reference/pg-spawn-calls.md + weapons.md (Skins/FX/extra-weapon supplement), "
            "%d confirmed names as of 2026-07-18" % total
        ),
        "categories": [{"name": name, "items": items} for name, items in categories.items() if items],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1), encoding="utf-8")

    print("[gen_templates] wrote %s -- %d templates in %d categories" %
          (OUT.name, total, len(data["categories"])))
    for cat in data["categories"]:
        print("   %-10s %d" % (cat["name"], len(cat["items"])))
    print("[gen_templates] AllInOneSpawnMenu.lua: %d entries skipped (DLC/unable-to-spawn: %d, empty template: %d)" %
          (allinone_stats["unable"] + allinone_stats["empty"], allinone_stats["unable"], allinone_stats["empty"]))
    if allinone_stats["underflow"]:
        print("[gen_templates] WARNING: %d unmatched category-close markers in AllInOneSpawnMenu.lua "
              "-- category nesting may have parsed incorrectly, spot-check the output" % allinone_stats["underflow"])
    print("[gen_templates] pg-spawn-calls.md: skipped %d DLC, %d ambiguous, %d left to primary sources (vehicle/weapon-shaped)" %
          (pgspawn_stats["dlc"], pgspawn_stats["ambiguous"], pgspawn_stats["out_of_scope"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
