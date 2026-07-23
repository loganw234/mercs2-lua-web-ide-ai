# Ess — Capabilities Reference

What the `Ess` framework can do **right now**, organized by what you reach for. This is the current-state
reference; for *why* things are the way they are (the design history, the absorption pivots, the bug hunts),
see [FEATURE_SHEET.md](FEATURE_SHEET.md) — that's the append-only build log, this is the map of the finished
building.

`Ess` (`_G.Ess`) is one global. Deploy `dist/Ess.lua` (built with `python build/merge.py`) as an OnLoad
script — nothing else is required; the four frameworks it grew out of (uilib, ModNet, ContractFramework,
LayerFw) are all absorbed natively, not dependencies.

## The three tiers

Most namespaces expose one or more of three parallel tiers. Use the highest one that fits:

- **`Ess.Easy.*`** — guardrails. Intent-named presets (`Ess.Easy.Mark.enemy(guid)`), smallest surface, hard
  to misconfigure. Where a beginner starts.
- **`Ess.*`** (unqualified, "Core") — named parameters and sensible defaults with full control. Where you go
  when you want to override a default.
- **`Ess.Raw.*`** — the building blocks the other two are assembled from, for composing something Ess didn't
  anticipate. Not a "skip the safety" hatch — the actual primitives.

Tiering is selective — only namespaces with a real beginner/advanced gap have all three (Mark, AIOrders,
Relations, Triggers, Sandbox). Simple namespaces (RNG, Time, Table…) are single-tier.

### Instant-gratification one-liners

For a newcomer whose whole thought is "I want X to happen," these hide the import + namespace entirely —
each is one guessable call:

| Verb | Does |
|---|---|
| `Ess.Easy.Vehicle.summon(template)` | spawn a vehicle in front + drop you in the driver seat |
| `Ess.Easy.Spawn.explosion(type)` / `.crate(type)` / `.weapon(name)` / `.airstrike(round)` / `.enemies(n)` | a boom in front / a supply drop / a weapon pickup / a shell on your own head / a squad of hostiles sent at you |
| `Ess.Easy.World.removeMapBoundary()` / `.clearWanted()` | roam the whole map / lose all heat |
| `Ess.Easy.World.hellscape()` / `.tint(r,g,b)` / `.brightness(n)` / `.resetAtmosphere()` | recolor/darken the world (region-gated — only shows when you're standing in a real map region, not the HQ) |
| `Ess.Easy.Player.giveGrapplingHook()` / `.unlockFastTravel()` / `.unlockAllHQs()` / `.giveAllRewards()` / `.freeSupport()` / `.skin(code)` / `.ghost()` | the game's own cheat-menu unlocks, whole-figure skin swap, and stealth mode (floor your AI detectability; toggle restores exactly) |
| `Ess.Easy.World.noPursuit()` | stop the current police/faction chase AND keep new organic heat off (false restores) |
| `Ess.Easy.Spawn.fx(t, x,y,z)` / `.fxOn(t, guid, bone)` | spawn a particle/FX at a location, on an object, or glued to a bone (you name the bone) |
| `Ess.Easy.Fun.dance()` / `.fanfare(win)` | technoviking dance / victory-or-fail music sting |

All use confirmed template names / real engine functions. `Ess.Easy.Console.open()` browses the full set
in-game.

---

## Core primitives

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Safe` | The `pcall`-and-log idiom, once | `.call(fn, ...)`, `.quiet(fn, ...)`, `.string(ok, val, fallback)`, `.template(name)` (true only for a usable non-blank spawn-template string — gate every raw `Pg.Spawn` with it; a blank template hard-CTDs straight past `pcall`) |
| `Ess.Table` | Dense-array repair + collection helpers | `.compact(t)` (rebuild after a nil hole); `.keys/.values/.count/.isEmpty/.contains/.indexOf`, `.map/.filter/.find/.reduce/.slice/.reverse` (array), `.copy/.merge` (shallow) |
| `Ess.Str` | The string helpers Lua 5.1 omits (all LITERAL, not patterns) | `.split/.join/.trim`, `.startsWith/.endsWith/.contains/.count`, `.padLeft/.padRight`, `.capitalize/.title/.lines/.truncate` |
| `Ess.Color` | RGB for the `rgb = {r,g,b}` params (Ess.Mark / Ess.UI) | `.hex(s)`, `.hsv(h,s,v)`, `.lerp(c1,c2,t)`, `.of(name)`, `.NAMES` (preset table) |
| `Ess.Vec` | 3D vector math on flat x,y,z (aim / offset / knockback) | `.length/.normalize/.scale/.add/.sub/.dot/.cross`, `.dir(from,to)`, `.toward(from,to,dist)`, `.lerp` |
| `Ess.Math` | Geometry/number helpers in the engine's yaw convention | `.clamp/.lerp/.sign/.round/.approach`, `.dist2D/.dist3D`, `.angleTo(fx,fz,tx,tz)` (yaw facing a point), `.pointAhead(x,z,yaw,dist)` (the spawn-ahead projection), `.rotateOffset(x,z,yaw,localX,localZ)` (a local right/forward offset → world — use instead of hand-rolling a rotation matrix), `.normDeg`; **forward is `(+sin,+cos)`** — read the file header before touching it; `.clamp01/.remap/.smoothstep/.lerpAngle/.wrap`; `.dist2DSq/.dist3DSq`, `.within2D/.within3D` (range tests, no sqrt) |
| `Ess.Guid` / `Ess.Name` | Name↔guid, pcall-wrapped | `Ess.Guid(name)`, `Ess.Name(guid)` |
| `Ess.Log` | One line to the bridge log | `Ess.Log(msg)` |
| `Ess.State` | Reload-safe `_G` state, field-merged | `Ess.State(name, defaults)` (adding a default later still takes effect) |
| `Ess.SaveVar` | Namespaced persistent vars over `Loader.SaveVar` | `Ess.SaveVar.ns(prefix)` → `:get/:set/:flag/:setFlag` |
| `Ess.RNG` | Engine-safe RNG (avoids the 32-bit-float big-LCG trap) | `Ess.RNG.new(seed)` → `:next/:int/:pick/:chance/:shuffle/:pickN` |

## Identity & world query

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Player` | Player/character identity without the 8-getter sprawl | `.character(i)` (0 local, 1 co-op partner), `.slot(i)`, `.camera(i)`, `.pose(i)` (4th return = **chest/body** yaw), `.viewYaw(i)` (the yaw you're **LOOKING** along — body and view differ by up to 111° when you swing the mouse; falls back to body yaw when the reticle has no hit, 2nd return says which), `.giveCash(n)`, `.giveFuel(n)`, `.targetUnderReticle(i)`, `.rumble(i, len)`, `.removeBoundaries()`, `.setInputEnabled(on, i)` (freeze/restore gameplay input for a modal UI/cutscene), `.teleport(x,y,z, yaw, onDone)` (co-op-safe warp), `.inVehicle(i)/.onFoot(i)` |
| `Ess.Object` | The everyday object-manipulation namespace | **spawn:** `.spawn(template, x,y,z, yaw)` (guarded), `.spawnAhead(template, dist, height, i, {useView=})` (in front of the player, hides the yaw/trig; **`useView=true`** places it where you're *looking* instead of where your body is turned — opt-in, existing calls unchanged); **transform:** `.pos/.setPos`, `.yaw/.setYaw`, `.faceToward(g,x,y,z)/.faceObject(g,target)` (turn to face), `.distance`; **life:** `.health/.setHealth/.maxHealth/.heal/.damage` (`.damage` kills outright when it would reach ≤ 0 — a bare `SetHealth(g, 0)` doesn't reliably register as a death), `.kill/.revive/.remove`, `.alive/.valid`, `.setInvincible`; **state:** `.visible/.setVisible`, `.hasLabel/.addLabel/.removeLabel`, `.invincible` (the setInvincible getter), `.displayName`, `.playerControlled`; **physics & motion:** `.enablePhysics/.disablePhysics`, `.impulse`, `.velocity(g)` (vx,vy,vz), `.speed(g)/.speedSq(g)`; **geometry:** `.size(g)` (model bbox extents — takes a guid, not a name), `.localToWorld(g, lx,ly,lz)` (full 3D incl. pitch/roll — prefer over the yaw-only Ess.Math rotateOffset on tilted objects), `.heightAboveGround(g)`, `.snapToGround(g, offset)`; **vehicle watch:** `.vehicleOf`, `.pollVehicleChange` |
| `Ess.Vehicle` | Seats/riders/entry/upkeep | `.driver(veh)`, `.riders(veh)`, `.seatOf(char)`, `.enterBestSeat(char, veh)`, `.enterSeatExcluding(char, veh, excl)`, `.exit(veh, char)`, `.evictAll(veh)` (force EVERY occupant out), `.repair(veh)` (full heal + rearm — the vehicle repair long thought missing), `.isFlipped(veh)`, `.land(heliOrPilot)` (command an AI heli to descend and set down — pairs with `.flyTo`), `.followGhost(template, x,y,z)`, `.flyTo(heli, x,y,z, {onReady=})` (send an AI heli to a point — driver-wait + `Ai.Deliver`), `.orbitFlight(heli, cx,cy,cz, {radius=, height=, orbits=, onDone=})` (fly a crewed heli in timed orbits around a point; returns the total flight seconds so you can pace a camera against it); **`Ess.Easy.Vehicle.summon(template)`** — spawn a vehicle in front + hop in the driver seat (the "I want a helicopter" → flying-it one-liner) |
| `Ess.Probe` | Nearby-object collection, one dispatcher | `.nearby(...)` (**excludes the player by default**; kinds: humans, vehicles, buildings, tanks, helicopters, boats, cars, jets, props, usables, groundNoTanks, any), `.nearest(...)` (closest match), `.allByName(name)` (EVERY guid matching a name — `Ess.Guid` is the single-match form), `.getFaction(guid)`, `.describeSafe(guid)` |
| `Ess.Impulse` | Launch / boost / knock objects around (the speed-boost effect), mass-scaling handled | **Raw:** `Ess.Raw.Impulse.apply/.applyAtPoint/.mass`; **Core:** `Ess.Impulse.push(g, {forward,up,side or dir, strength, scaleByMass})`, `.spin`, `.mass`; **Easy:** `Ess.Easy.Impulse.speedBoost(g)` / `.launch(g)` / `.knockback(g, from)` — all mass-scaled so a bike and a tank feel the same |

## Timing & input

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Time` | All wall-clock timing (survives world-pause) | `.stamp()`/`.elapsed(s)`/`.mark(s)` (explicit, real-time), `.mainStamp()` (the pausable/scaled GAME clock — freezes with pause and tracks `.scale`; use it for gameplay cooldowns, `.stamp()` for UI/real-world timing), `.cooldown(seconds)` → `ready()`, `.clock(maxDelta)` → `:delta()` (auto-advancing per-frame dt), `.scale(n)`/`.restoreScale()`, `.format(sec, tenths)`; `Ess.Easy.Time.slowmo(n, seconds)` |
| `Ess.Loop` | The one shared reload-safe heartbeat | `.start(id, interval, tickFn)`, `.stop(id)`, `.isRunning(id)` |
| `Ess.Input` | The only correct key-polling shape + device query | `.poll()` → `{pressed, down(vk)}` (owns the edge events), `.held(vk)` (level check — "is it down right now"; safe to call from any number of loops without eating `.poll()`'s edges), `.clear()` (flush the key buffer), `.VkToChar(vk, shift)`, `.usingController()`, `.hijackController(onInput)` |
| `Ess.Keys` | Bind several hotkeys in ONE script (a toolkit) | `.on(key, fn)` (key = VK or name `"F5"`/`"space"`/`"a"`; `fn(bShift)`), `.off/.clear/.isBound`, `.vk(name)` — edge-triggered dispatch on one shared loop |
| `Ess.TextConsole` | A typed-input console, no `.gfx` asset needed | `.open{ onSubmit=, … }`, `.close()`, `.isOpen()` |

## Tracking & cleanup

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Track` | One registry for every leak-prone Add/Remove pair | `Ess.Track.new()` → `:event/:guid/:marker/:radar/:pda/:qualityRef/:disposer/:contextAction/:add`, then `:closeAll()` |
| `Ess.Event` | `Event.Create` that logs failures + auto-tracks | `.on(type, args, cb, tracker)`, `.off(handle)` |
| `Ess.On` | Intent-named REACTIVE hooks (respond to the world) | `.death(guid, fn)`, `.enterArea/.exitArea/.insideArea(x,y,z,r, fn)`, `.healthBelow(guid, pct, fn)`, `.playerHurt(fn)`, `.vehicle(fn)`, `.tick(iv, fn)`, `.labeled(label, r, fn)` (fires once per world-labeled object as it streams in near you — the label-discovery idiom) — each → `stop()` |
| `Ess.Save` | The **one** shared save-gate (suppress saves during an ephemeral mode) | `.gate(key)`, `.ungate(key)`, `.isGated()`, `.holders()` (who's currently holding it — diagnostics) — saves suppressed while ≥1 holder; used internally by Layers + Sandbox |

## Humans & combat

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Human` | Weapon/inventory/action control for a character | `.equipWeapon/.dropWeapon/.primaryWeapon/.secondaryWeapon/.allWeapons/.setAllWeapons`, `.ammo/.setAmmo/.maxAmmo/.refillAmmo/.setInfiniteAmmo`, `.reloadAll/.doAction/.knockdown/.disableWeapons/.enableWeapons`; `Ess.Easy.Human.giveWeapon(char, templateName)` |
| `Ess.Support` | The iconic combat call-ins, standalone (no contract) | `.airstrike/.artillery/.bombingrun/.gunship/.reinforce/.shell` (world x,y,z + opts; `owner=` faction attributes it); **`Ess.Easy.Airstrike.at(x,y,z)` / `.onTarget(i)` / `.onMe(i)`** |
| `Ess.Pursuit` | The wanted/heat system, with its two live-confirmed traps encoded | `.state()` (the read channel: Level/Active/Faction/SecondsLeft…), `.level()`, `.start(faction, level)` (starts a real countdown; spawns nothing by itself), **`.clear()`** (the ONE true reset for an active chase), `.seconds(faction, n)`, `.levelTimes(n1, n2)`, `.lock(faction, level)`, `.custom(faction, dur, settings)`, `.capLevel(n)` (⚠ ONE-WAY ratchet down for the whole session — only a save-load restores the ceiling), `.restrictAll(on)/.restrictFaction(faction, on)/.clearRestrictions()` (gate ORGANIC heat only — they do NOT clear an active chase and don't block a scripted start) |

## Markers

| Tier | Key calls |
|---|---|
| `Ess.Easy.Mark` | `.enemy(guid)` (radar+PDA), `.objective(guid)` (all 3), `.zone(x,y,z,r)` (world ring) |
| `Ess.Mark` | `.object(guid, {radar=, pda=, world=, disc=, kind=, rgb=, radius=, discAlpha=, size=, dist=})`, `.zone(x,y,z,r, {world=, radar=, pda=, icon=, kind=, rgb=, discAlpha=, size=, dist=})`, `.clear(handle)` — every surface (radar / PDA / ground ring / floating icon) is an independent opt, so one call covers any combination |
| `Ess.Raw.Mark` | `.radar/.pda/.world(guid,tex,rgb,size,dist)/.worldDisc` (4 surfaces independently), `.removeRadar/.removePda/.removeWorld(handle)` (per-surface removal), `.pulse/.haltPulse` (flash existing), `.showPlayerMarkers(on)` |

## Camera, bones & spatial

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Camera` | Camera effects (top-level `Camera` + `Graphics.Camera` + `Graphics.Effect`, kept clear) | `.shake/.stopShake`, `.fov/.restoreFov`, `.fade(amt)` (+ `Easy.Camera.shake/fadeOut/fadeIn`), `.blend(i, dur)` (re-arm a smooth glide for the NEXT discrete `placeCamera` move — per-tick moving cameras still want blend 0), `.lookAtAnchor`, `.followHardpoint`, `.staleAxisDecay`; **cinematic:** `.beginCinematic/.placeCamera/.lookAtObject/.lookAtPoint/.hold/.endCinematic/.panicRevert` + `Ess.Easy.Camera.watch(uGuid, {chase=, angle=})` (locked-off tracking shot by default, or a `Blend 0` fixed-angle follow) + `Ess.Easy.Camera.orbit(uGuid, {radius=, speed=, smooth=})`. **chase/orbit damp the follow through `Ess.Vec.lerp` by default** (jitter-free on a fast subject; `smooth=false` / `smoothFactor` to tune). Steals control until `stop()` |
| `Ess.Bones` | The confirmed bone/hardpoint recipes | `.attachFX/.detachFX`, `.waitForReady`, `.aimVector`, `.probeNames` |
| `Ess.Points` | Arena spawn-point selection | `.bucket(spawnList)`, `.ideal(pts, refX, refZ, opts)` |
| `Ess.Cinematic` | A declarative **cutscene timeline** — the runtime the cinematic authoring suite feeds | `.play(steps, opts)` (steps: `camera`(cut/track/dolly)/`orbit`/`chase`/`wait`/`spawn`/`face`/`order`/`fly`/`say`/`banner`/`subtitle`/`hint`/`vo`/`music`/`sound`/`fade`/`shake`/`teleport`/`relations`/`func`, each paced by `hold` seconds; steps share a `ctx` — `spawn name=`/`group=` register actors that later steps reference by label), `.skip()`, `.stop()`, `.isPlaying()/.active()`, `.define(id, steps, opts)` / `.playNamed(id)` (name a reusable cutscene); always restores control on end/error, **skippable with ESC** (every remaining step still fires). `Ess.Easy.Cinematic.play(steps, onDone)` / `.shot(at, lookAt, seconds)`. Also `def.cinematic` on a contract (inline steps **or a named-id string**; intro), or a `cinematic` support effect (trigger-fired mid-mission) |

## Audio & HUD

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Sound` | Direct sound/ambience cueing | `.cue/.stop/.ambience/.stopAmbience/.volume`; `Ess.Easy.Sound.play(cue)` |
| `Ess.Hud` | Native HUD popups | `.hint/.hideHint` (tutorial-style), `.banner(msg)` (centered text), `.objective(text)` (the persistent objective-tray line; nil clears), `.radio(text, hold)` (a self-clearing radio-chatter subtitle) |

## UI kit

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.UI` | The 9-widget kit (native port of uilib) | `.Menu`, `.List`, `.Panel`, `.Bar`, `.Toast`, `.Confirm`, `.Input`, `.Chat`, `.Board` (+ `.wrap/.comma/.fmt_time` helpers); `.Focus(w)/.Focused()` (route the kit's one shared key listener to a widget / read who has it), `.navName(vk)` |
| `Ess.Easy` (UI) | Single-call UI | `Ess.Easy.Toast(msg)`, `Ess.Easy.Confirm(text, onYes, onNo)`, `Ess.Easy.Menu(title, entries)` |
| `Ess.Gfx` | Raw FlashWidget primitives (the Raw tier of UI) | `.widget/.call/.onEvent/.setVisible/.warmupRerender/.menuNav` |
| `Ess.ScrollLog` | A scrolling text log widget | `.new(name, x,y,w,h)` |
| `Ess.Easy.Console` | In-game reference **AND interactive playground** | `.open()` (browse/search the reference), **`.play()` (drill in, RUN a function live + cycle its params to see what it does)**, `.search()` (typed substring filter over the registry), `.close()` |
| `Ess.Easy.Debug` | A live **dev overlay** for mod authors | `.overlay(opts)` (toggle a panel: exact coords+yaw, what you're aiming at, on-foot/vehicle, health, nearby counts), `.hide()`, `.isOn()` |

`Ess.UI.Menu`'s builder (`:entry/:category/:header/:switch`) and its `ctx:` helpers
(`:hint/:toast/:confirm/:ask/:spawn/:close`) are the one surface kept byte-for-byte backward-compatible with
the old uilib menu system, so existing menu scripts port unchanged.

## Encounter toolkit (standalone gameplay scripting)

All tiered (`Raw`/Core/`Easy`). This is the encounter machinery extracted from ContractFramework, usable
without a running contract.

| Namespace | Core | Easy |
|---|---|---|
| `Ess.AIOrders` | `.command(guids, behavior, opts, tracker)` — 11 behaviors (move/patrol/defend/attack/hold/face/follow/flee/enter/deploy/animate); `.setGroup/.group` | `Ess.Easy.AIOrders.attack(guids, target)`, `.patrol(guids, points)`, `.guard(guids, at)` |
| `Ess.Relations` | `.apply(pairs, label)` → **handle**, `.restore(handle)`, `.isActive(handle)`, `.getFeeling/.setFeeling` (per-individual), `.getPerceivability/.setPerceivability` (per-individual AI detectability — reversible; the stat behind Easy ghost) | `Ess.Easy.Relations.makeHostile(factions)`, `.makeAllies(factions)`, `.war(a, b)` (two factions fight each other), `.sideWith(friend, foe)` (you join `friend` against `foe`), `.restore()` |
| `Ess.Triggers` | `.arm(spec, onFire, tracker)` (stateless); `.scope()` → an **isolated** `:arm/:armNamed/:gate/:declare/:markFired` namespace | `Ess.Easy.Triggers.onPlayerNear(x,y,z,r,fn)`, `.onDeath(guid,fn)`, `.after(seconds,fn)` |
| `Ess.Sandbox` | `.begin(id, providerNames, opts)`, `.finish(id)`, `.isActive(id)` — providers: layers/economy/supports/relations, all save-gated | `Ess.Easy.Sandbox.arena(id, opts)` (all providers on), `.done(id)` |
| `Ess.Layers` | Save-clean `vz_state_*` layer manipulation for arenas/minigames: `.begin/.add/.remove/.swap/.expect/.composite/.finish`, `.isActive/.isLoaded/.snapshot/.current` | (used via `Ess.Sandbox`'s `layers` provider) |
| `Ess.Raw` | `Raw.AIOrders` (actor/pri/goal/haste/priorityTarget/enable), `Raw.Relations` (snapshot/set/restore), `Raw.Triggers.arm` (full condition vocabulary), `Raw.Sandbox` (register/gateSaves/ungateSaves) | |

Trigger conditions (`Ess.Raw.Triggers.arm` specs): `"immediate"`/`"once"`/`"recurring"`, `{proximity=r, at=}`,
`{onDestroy=guidOrName | "nearest"}`, `{onHealthBelow={target=, pct=}}`, `{onCleared={at=, radius=, faction=}}`.

## Missions

Three weights, lightest first: a single tracked goal → a linear sequence → the full save-safe engine.

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Objective` | A single **counted goal** on the HUD objective line (state, no Contract) | `.new{label, target, slot, onComplete, onProgress, onFail, id}` → `:advance(n)/:set(n)/:progress()/:isDone()/:label(s)/:complete()/:fail()/:cancel()`; `id` makes it reload-safe (re-create cancels the prior) |
| `Ess.Quest` | An ordered **sequence** shown one step at a time | `.new{steps, slot, showCounter, onStep, onComplete}` → `:advance(n)/:skip()/:current()/:step()/:isDone()/:cancel()`; steps are `"text"`, `{label,target}`, or auto-wired `{reach={x,y,z,r}}` / `{destroy=guid}` / `{clear={x,y,z,r,faction}}` |
| `Ess.Easy.Objective` | The intent bundles — a goal wired to a world event + its marker, in one line | `(label, target, onComplete)`; `.reach(x,y,z,r, label, onDone)`, `.destroy(guid, label, onDone)`, `.clear(x,y,z,r, faction, label, onDone)` (polls the area), `.survive(seconds, label, onDone, onFail)`; `Ess.Easy.Quest(steps, onComplete)` |
| `Ess.Contract` | The full ephemeral-mission engine (native port of ContractFramework) | `.Register(def)`, `.Accept(id)`, `.Abort()`, `.Status()`, `.List()`; 16 objective-type constructors (each takes a spec table): `.Destroy/.Reach/.Defend/.Collect/.Escort/.Enter/.Hold/.Group/.Interact/.Verify/.Extract/.Race/.Survive/.Chase/.Protect/.StayInArea`; relations/support/AI-orders/triggers subsystems (consumers of the encounter toolkit above) |
| `Ess.Easy.Contract` | One-call contracts | `.destroy(title, spawns, opts)`, `.reach(title, at, radius, opts)` |

## Networking

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Net` | Co-op data sync (native port of ModNet) | `.Shared(ns)` (auto-syncing table), `.Set/.Get/.Track`, `.setv(ns, key, value)/.getv(ns, key)` (the namespaced primitives `.Shared` wraps), `.On/.Send` (messages), `.OnRaw/.SendRaw`, `.Me/.IsCoop/.IsHost/.IsAuthority`; `.hijackCallback(module, name, isMine, onMine)` (safely extend any resident callback) |

## Meta

| Namespace | What it's for | Key calls |
|---|---|---|
| `Ess.Override` | Change engine logic without the tail-call crash | `.wrap(target, name, newFn)` (makes the crash shape structurally impossible), `.mergeIntoLiveTable(t, key, data)` |

---

## Verification status

Most of the surface is built and live-tested against the running game (many with exact before/after value
confirmations). The 0.3.0 batch — the mirrored-forward-vector fix, view-relative placement, and the whole
"creativity gaps" set (`Ess.Support`, `Ess.On`, `Ess.Keys`, `Ess.Easy.Spawn.enemies`, the `Console.play()`
playground, `Ess.Objective`/`Ess.Quest`/`Ess.Easy.Debug`) — was **verified in-game before release**:
7 of 8 `Ess.On` hooks fired live, all 7 `Ess.Support` call-ins delivered, the overlay renders, the
playground runs. See `CHANGELOG.md`'s `[0.3.0]` entry for the feature-by-feature ledger. Honest limits:

- **The six bundled OnKey demos** (`VehicleInspector`, `WaveSurvival`, `BossFight`, `EncounterDirector`,
  `CreatorToolkit`, `Playground`) load-check clean but haven't each had a full keypress-through pass.
- **`Ess.On.exitArea`** — the one reactive hook not yet exercised live (the other seven fired).
- **Co-op peer-to-peer delivery** (`Ess.Net`) — the wire protocol is a faithful port of confirmed-working
  co-op code, but full two-machine delivery hasn't been re-verified solo (needs a second machine).
- **`Ess.Input.hijackController`** — its known bug is fixed, but it hasn't been driven with real controller
  input at an open PDA (needs `tools/xpad.py` driving a live controller event).

## Not in scope

`WaveDefense.lua` (a gamemode, not a framework) stays its own file — a future refactor will make it *consume*
`Ess.*` rather than be absorbed. WAD/gfx authoring (gfxforge/gfx_tool) and the lua-bridge substrate itself
are separate tools Ess builds on, not things it wraps.
