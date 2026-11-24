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
