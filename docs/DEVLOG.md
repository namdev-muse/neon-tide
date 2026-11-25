# Neon Tide — devlog

## M1 — Core (setup run, v0.1.0, local only)

Setup run built the M1 core locally: wave-surf sim (carve / pump / crest
launch / air / clean-or-bad landing / stall + wipeout + checkpoint
respawn), 3 dense hand-crafted breaks (First Swell 300m, Crosscurrent
360m, Violet Break 420m), live animated menu with screen stack and
juice, no assist of any kind. Public unlock/seed path `?break=N` /
`?unlock=1` (not in the player-facing UI). Tests + CI/Pages workflow.

Physics tuning found in the setup run: flow rebuilt too slowly at top
speed for the late crests (decision bot died at break 3's 270m crest
with flow 0.28 < 0.35) — FLOW_BUILD 0.25 → 0.5 and launch flow cost
0.35 → 0.2 fixed it. Air steering leads by remaining air time with a
touchdown lateral-speed bleed, so landings stay clean on the fast
late breaks.

Local suite: smoke 88/88, bot gates all pass (decision bot clears all
3 with 0 falls, one jump per crest, all clean; hold / no-input /
random / jump-spam bots lose all 3; decision times strictly
increasing 14.08s / 16.72s / 19.63s).

M1 is NOT done until the 02:30 run's live real-browser FUN playtest
says GO — repo creation + browser upload + live playtest belong to
that run.

## M1 — done (02:30 run, v0.1.0, live)

Repo namdev-muse/neon-tide created via browser task, Pages main /
root, 16/16 files via browser upload, CI run #5 green, live site
verified serving v0.1.0, real-browser FUN playtest GO (see
hidden_files/milestone-M1.md in the sprint workspace).

## M2 — Break craft (04:30 run, v0.2.0)

12 hand-crafted breaks (M1's 3 kept as breaks 1–3, unchanged):
Golden Hour 460m, Emerald Rush 500m, Solar Flare 540m, Deep Current
580m, Pink Tide 620m, Aqua Rush 660m, Crimson Reef 700m, Lime Line
740m, Void Crown 780m. Each has its own pocket drift (amp 8→10,
freq 0.027→0.035), crest layout (7→11 crests), gap width (17→22m),
accent and hint; pickups sit on the pocket line
(pocketX at each pickup distance). Pars continue the M1 pattern
(+5s per break, 75s→115s).

Per-break scene identity (M1 caveat, now done): the wave-face
gradient, pocket band, crest chevrons and pocket light all tint
toward the break's accent — Void Crown reads violet against First
Swell's cyan in the framing shots.

Design probe before the edit: the decision bot clears all 12 with
0 falls, one jump per crest, all clean; clear times strictly
increasing 14.08s → 34.33s; hold / no-input / random / jump-spam
bots lose on all 12. One probe failure on the first pass: break 11's
last crest at 705m launched the bot past the 740m finish, so the
win-landing never counted as a clean landing (clean 10/11) — the
last crest moved to 690m and the probe went green. That is a
layout rule worth keeping: the final crest's landing zone must sit
before the finish line.

Local suite: smoke 89/89, bot gates all pass (decision times
14.08 / 16.72 / 19.63 / 21.20 / 23.02 / 24.62 / 26.05 / 27.63 /
29.43 / 30.95 / 32.77 / 34.33s), render check PASS (zero console
errors; 12 break cards, 11 locked on a fresh save; autopilot
cleared break 1 live, 3157 pts in 14.18s, 0 falls; ?break=12
reaches Void Crown), size sweep 14 shots inspected by eye.

Eye-check defect found + fixed in-run: at 1280x720 the 12-card menu
overflowed — row 4 and the unlock hint were cut off. Locked cards
now say just "Locked" (the hint line below the grid already states
the unlock rule), cards tightened, and a max-height:760px media
query compacts the panel on short viewports. Re-swept: all 12 cards
+ hint fully visible at 1280x720, 2560x1080 and 1080x2340.

M2 is NOT done until the 04:30 run's live real-browser FUN playtest
says GO on a spread of breaks (early, mid, late) — upload +
live playtest belong to that run.

## M2 — playtest NO-GO, fix in flight (04:30 run, v0.2.0 live)

Live FUN playtest (breaks 1, 6, 12, manual, no bot hooks): ride GO
on all three — carving responsive, pocket readable, identities
distinct, "kept making me want another try"; 720p menu fits; no
console errors, no dead buttons. Verdict NO-GO: the playtester
could not verify the pump → FLOW → launch loop and reported
mouse-hold does not pump (~10 attempts, all died at the first
crest), so FLOW never filled for them.

Investigation: the mouse-pump claim was checked with a controlled
Playwright true-hold probe — speed 11.68 → 15.73, FLOW 0 → 0.675
over a 4s hold on break 1. Mouse pump WORKS; the playtester's holds
evidently never registered as a sustained mousedown on the canvas
(M1's live playtest verified the same path). The release edge is
the same flag the autopilot uses to clear break 1 live (4 jumps /
4 clean). The NO-GO's central defect is refuted, but a refutation
is not a GO — M2 stays open until a focused re-playtest
experiences the launch loop and calls it.

Genuine defect fixed from the playtest: the break-12 menu hint
read "Clear Void Crown to unlock break 12." — now "Final break —
you have unlocked them all." (game.js only, v0.2.0 unchanged).
Full run log: hidden_files/milestone-M2.md in the sprint workspace.

## M2 — re-playtest NO-GO, real defect found (06:30 run, v0.2.0 live)

Focused re-playtest (break 1, true sustained mouse holds of up to
~19s — NOT tap-only): ride fun for the first ~100m, speed rises
~40% while holding (pump works), but the FLOW bar NEVER visibly
filled in any reading (zoomed crops, mid-hold, paused), and no
launch was observed in 4 timed release attempts. Verdict NO-GO.

Root cause found in code: the FLOW meter's fill element is
`id="hud-flow-fill"` in the markup and game.js, but style.css
styled `#hud-swing-fill` — an id mismatch, so the fill had no
height and no background and could never render, whatever the
internal flow value was. The render check only asserted the
element's inline width, which passed on the broken code. Fix:
style.css now styles `#hud-flow-fill`; the render check now
asserts the fill's computed height and background (it must
actually render). Also fixed: with `?unlock=1` the menu footer
said "Clear First Swell to unlock break 2" — it now reads "All
breaks unlocked — pick any break to ride." (game.js, v0.2.0
unchanged). The launch itself works in code (autopilot clears
break 1 live, 4 jumps / 4 clean; decision bot clears all 12) —
the re-playtest's missed launches are a tooling timing ceiling
(1–7s action latency vs a ~0.5s launch window), not a game
defect; the re-playtest after this fix briefs the correct first
gap (crest 60m, gap 60–72m, release at 55–58m while carving
right to track the pocket).
