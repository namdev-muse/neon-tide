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
