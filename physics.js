// Neon Tide v0.1.0 — pure simulation core (no DOM, no Three.js).
// A 3D neon wave-surfer: the surfer rides a rolling wave down a
// channel, carving the wave face to stay in the pocket (the fast
// water), pumping (crouching into the wave) to build speed and flow,
// releasing at a crest to launch for air, and landing clean in the
// pocket to keep the combo. The wave face is a 2D ride plane
// (x = lateral across the face, dist = distance down the channel);
// the wave, camera and spray give it 3D depth in game.js, while the
// mechanic itself is a clean 2D sim — the same shape as the Spire
// physics split (pure sim here, rendering there).
//
// Core loop per crest: carve to the pocket, pump while in it to build
// speed + flow, release pump inside the launch window just before a
// crest to launch over the closeout gap, steer in the air, land clean
// past the gap. The gap is load-bearing: the wave face ENDS at every
// crest, so a surfer who never jumps falls into the gap. Holding pump
// forever never launches; holding one direction runs off the face;
// spamming jump releases outside the launch window and bleeds speed.
// No auto-carve, no "jump now" prompt, no assist that rides the
// pocket for you. The bot plays through the same stepRun + public
// input hooks and must carve/pump/jump with real timing decisions;
// a bot that holds one direction, holds pump forever, or spams jump
// loses on every break (see simulateRun + the bot harness).
//
// Deterministic: every break is hand-built from fixed numbers, and
// the fixed-step simulation gives identical results for identical
// inputs.

export const VERSION = '0.1.0';
export const DT = 1 / 60;
export const GRAVITY = 18; // air gravity
export const START_SPEED = 12;
export const STALL_SPEED = 5; // below this on the wave: the run stalls out
export const MAX_SPEED = 24;
export const FACE_HALF = 14; // wave face half-width; |x| beyond it = off the face
export const POCKET_HALF = 3.5; // pocket half-width around pocketX(dist)
export const CARVE_ACCEL = 30;
export const AIR_CARVE_ACCEL = 12;
export const MAX_VX = 12;
export const MAX_AIR_VX = 8;
export const PUMP_ACCEL = 4.5; // forward accel while pumping inside the pocket
export const PUMP_BOG = 1.2; // extra forward drag while pumping outside the pocket
export const DRAG = 0.1; // exponential speed decay coefficient (per second)
export const FLOW_BUILD = 0.5; // flow gained per second of pumping in the pocket
export const FLOW_DECAY = 0.15; // flow lost per second otherwise
export const LAUNCH_MIN_FLOW = 0.35;
export const LAUNCH_MIN_SPEED = 8;
export const LAUNCH_WINDOW_BEFORE = 4; // metres before a crest the launch window opens
export const LAUNCH_WINDOW_AFTER = 2; // metres after a crest it closes
export const LAND_POCKET_TOL = POCKET_HALF + 1.5;
export const LAND_VX_TOL = 7;
export const MAX_FALLS = 5;
export const PICKUP_RADIUS = 2.2;
export const PICKUP_SCORE = 100;
export const CLEAN_LAND_SCORE = 150;
export const DIST_SCORE = 2; // per metre of max distance reached
export const AIR_SCORE = 60; // per second of air time
export const WIN_TIME_BONUS = 20; // per second under par

// ---------------------------------------------------------------- helpers
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- breaks
// A break is a channel down the wave: length in metres, a pocket that
// drifts laterally as pocketX(dist) = amp * sin(dist * freq + phase),
// crests where the wave face ends in a closeout gap [crest,
// crest + gapWidth] that must be jumped, checkpoints to respawn at,
// and gold pickups along the good line.
function crest(d) { return d; }

export const BREAKS = [
  {
    id: 1,
    name: 'First Swell',
    hint: 'Stay in the pocket, pump to build flow, release at the crest to fly the gap.',
    accent: '#22e6ff',
    accentName: 'cyan',
    par: 40,
    length: 300,
    faceHalf: FACE_HALF,
    pocketAmp: 5,
    pocketFreq: 0.018,
    pocketPhase: 0,
    gapWidth: 12,
    crests: [60, 120, 180, 240].map(crest),
    checkpoints: [0, 100, 200],
    pickups: [
      { dist: 35, x: 2 }, { dist: 95, x: -3 }, { dist: 155, x: 4 },
      { dist: 215, x: -4 }, { dist: 275, x: 2 },
    ],
  },
  {
    id: 2,
    name: 'Crosscurrent',
    hint: 'The pocket swings wider now — carve early, pump late.',
    accent: '#ff3df0',
    accentName: 'magenta',
    par: 55,
    length: 360,
    faceHalf: FACE_HALF,
    pocketAmp: 7,
    pocketFreq: 0.022,
    pocketPhase: 1.2,
    gapWidth: 14,
    crests: [55, 115, 175, 235, 295].map(crest),
    checkpoints: [0, 120, 240],
    pickups: [
      { dist: 30, x: 5 }, { dist: 85, x: -5 }, { dist: 145, x: 6 },
      { dist: 205, x: -6 }, { dist: 265, x: 5 }, { dist: 330, x: -3 },
    ],
  },
  {
    id: 3,
    name: 'Violet Break',
    hint: 'Long gaps, fast pocket. Every launch counts.',
    accent: '#b26bff',
    accentName: 'violet',
    par: 70,
    length: 420,
    faceHalf: FACE_HALF,
    pocketAmp: 8,
    pocketFreq: 0.026,
    pocketPhase: 2.4,
    gapWidth: 16,
    crests: [50, 105, 160, 215, 270, 325, 380].map(crest),
    checkpoints: [0, 140, 280],
    pickups: [
      { dist: 28, x: -6 }, { dist: 80, x: 6 }, { dist: 135, x: -7 },
      { dist: 190, x: 7 }, { dist: 245, x: -6 }, { dist: 300, x: 6 },
      { dist: 355, x: -5 }, { dist: 405, x: 3 },
    ],
  },
];

export function breakById(id) {
  return BREAKS.find((b) => b.id === id) || null;
}

// Lateral position of the pocket (the fast water) at a distance down
// the channel. The pocket is the target the surfer must track.
export function pocketX(brk, dist) {
  return brk.pocketAmp * Math.sin(dist * brk.pocketFreq + brk.pocketPhase);
}

export function inPocket(brk, dist, x) {
  return Math.abs(x - pocketX(brk, dist)) <= POCKET_HALF;
}

// The next crest ahead of a distance (or null past the last one).
export function nextCrest(brk, dist) {
  for (const c of brk.crests) {
    if (c > dist) return c;
  }
  return null;
}

// Is this distance inside a closeout gap (the wave face is gone here)?
export function inGap(brk, dist) {
  for (const c of brk.crests) {
    if (dist >= c && dist <= c + brk.gapWidth) return true;
  }
  return false;
}

export function breakThreat(b) {
  // Rough difficulty measure: length + pocket swing + gap load.
  return b.length + b.pocketAmp * 3 + b.pocketFreq * 1000 + b.crests.length * 10 + b.gapWidth;
}

// ---------------------------------------------------------------- run state
export function createRun(brk) {
  return {
    brk,
    phase: 'riding', // 'riding' | 'won' | 'lost'
    time: 0,
    dist: 0,
    x: pocketX(brk, 0),
    vx: 0,
    speed: START_SPEED,
    airborne: false,
    airY: 0,
    airVy: 0,
    airTime: 0,
    totalAirTime: 0,
    flow: 0, // 0..1: pump energy — the HUD meter, spray and pump-tick pitch all read from this
    combo: 0,
    falls: 0,
    jumps: 0,
    cleanLandings: 0,
    badLandings: 0,
    pickups: 0,
    pickupsCollected: brk.pickups.map(() => false),
    maxDist: 0,
    score: 0,
    pumpHeld: false, // previous step's pump state — a launch fires on the release EDGE
    lastCheckpoint: 0, // index into brk.checkpoints
    graceT: 0,
  };
}

export function startRun(breakId) {
  const brk = breakById(breakId);
  if (!brk) return null;
  return createRun(brk);
}

// The checkpoint distance the run respawns at.
export function checkpointDist(run) {
  return run.brk.checkpoints[run.lastCheckpoint];
}

function respawn(run) {
  const cp = checkpointDist(run);
  run.dist = cp;
  run.x = pocketX(run.brk, cp);
  run.vx = 0;
  run.speed = START_SPEED;
  run.airborne = false;
  run.airY = 0;
  run.airVy = 0;
  run.airTime = 0;
  run.flow = 0;
  run.combo = 0;
  run.pumpHeld = false;
  run.time += 3; // a wipeout costs 3 seconds on the clock
}

function wipeout(run, reason) {
  run.falls++;
  run.combo = 0;
  if (run.falls >= MAX_FALLS) {
    run.phase = 'lost';
    finishScore(run);
    return;
  }
  respawn(run);
}

function collectPickups(run) {
  for (let i = 0; i < run.brk.pickups.length; i++) {
    if (run.pickupsCollected[i]) continue;
    const p = run.brk.pickups[i];
    if (Math.abs(p.dist - run.dist) <= PICKUP_RADIUS && Math.abs(p.x - run.x) <= PICKUP_RADIUS) {
      run.pickupsCollected[i] = true;
      run.pickups++;
      run.score += PICKUP_SCORE;
    }
  }
}

function finishScore(run) {
  run.score += Math.round(run.maxDist * DIST_SCORE);
  run.score += Math.round(run.totalAirTime * AIR_SCORE);
  if (run.phase === 'won') {
    run.score += Math.max(0, Math.round((run.brk.par - run.time) * WIN_TIME_BONUS));
  }
  if (run.score < 0) run.score = 0;
}

// Flow energy, 0..1: how much pump energy the surfer currently carries.
// The HUD meter, spray and pump-tick pitch all read from this — the
// player must always be able to see how much flow they have, without
// it ever becoming a "jump now" prompt: there is no marker, no cue,
// just the energy.
export function flowEnergy(run) {
  return clamp(run.flow, 0, 1);
}

// One fixed step. input: { pump: boolean, carve: -1 | 0 | 1 }.
// carve = -1 means "carve left" (A / Left), +1 means "carve right".
export function stepRun(run, input, dt = DT) {
  if (run.phase !== 'riding') return run;
  const carve = clamp(input.carve || 0, -1, 1);
  const pump = !!input.pump;
  const brk = run.brk;
  run.time += dt;
  const wasPumpHeld = run.pumpHeld;
  run.pumpHeld = pump;

  if (run.airborne) {
    // Ballistic air: gravity, weak carve steering, forward travel.
    run.airVy -= GRAVITY * dt;
    run.airY += run.airVy * dt;
    run.airTime += dt;
    run.vx += carve * AIR_CARVE_ACCEL * dt;
    run.vx = clamp(run.vx, -MAX_AIR_VX, MAX_AIR_VX);
    run.x += run.vx * dt;
    run.dist += run.speed * dt;
    run.speed = Math.max(0, run.speed * (1 - 0.02 * dt));
    if (run.dist > run.maxDist) run.maxDist = run.dist;
    // Landed?
    if (run.airY <= 0) {
      run.airY = 0;
      run.airborne = false;
      run.totalAirTime += run.airTime;
      run.airTime = 0;
      if (run.dist >= brk.length) {
        run.phase = 'won';
        finishScore(run);
        return run;
      }
      if (inGap(brk, run.dist)) {
        run.badLandings++;
        wipeout(run, 'gap');
        return run;
      }
      const pocket = pocketX(brk, run.dist);
      const clean = Math.abs(run.x - pocket) <= LAND_POCKET_TOL && Math.abs(run.vx) <= LAND_VX_TOL;
      if (clean) {
        run.cleanLandings++;
        run.combo++;
        run.score += CLEAN_LAND_SCORE * run.combo;
      } else {
        run.badLandings++;
        wipeout(run, 'bad-landing');
        return run;
      }
    }
    return run;
  }

  // On the wave.
  const pocket = pocketX(brk, run.dist);
  const pocketed = Math.abs(run.x - pocket) <= POCKET_HALF;

  // Carve: lateral accel + drag; the surfer tracks the pocket.
  run.vx += carve * CARVE_ACCEL * dt;
  run.vx *= 1 - 1.6 * dt;
  run.vx = clamp(run.vx, -MAX_VX, MAX_VX);
  run.x += run.vx * dt;

  // Pump: crouching into the wave builds speed + flow in the pocket,
  // and bogs the board down outside it. Releasing pump inside the
  // launch window before a crest launches the surfer over the gap.
  if (pump) {
    if (pocketed) {
      run.speed += PUMP_ACCEL * dt;
      run.flow = clamp(run.flow + FLOW_BUILD * dt, 0, 1);
    } else {
      run.speed -= PUMP_BOG * dt;
      run.flow = clamp(run.flow - FLOW_DECAY * dt, 0, 1);
    }
  } else {
    run.flow = clamp(run.flow - FLOW_DECAY * dt, 0, 1);
    // Release edge: the launch. Only inside the launch window before
    // a crest, with real flow and speed — a release anywhere else just
    // stops pumping, and a spam of releases bleeds speed for nothing.
    if (wasPumpHeld) {
      const c = nextCrest(brk, run.dist);
      if (c !== null && run.dist >= c - LAUNCH_WINDOW_BEFORE && run.dist <= c + LAUNCH_WINDOW_AFTER
        && run.flow >= LAUNCH_MIN_FLOW && run.speed >= LAUNCH_MIN_SPEED) {
        run.airborne = true;
        run.airVy = 5 + run.flow * 7 + run.speed * 0.2;
        run.airY = 0.01;
        run.airTime = 0;
        run.jumps++;
        run.flow = clamp(run.flow - 0.2, 0, 1); // the launch spends flow
      }
    }
  }

  // Speed decay + cap, forward travel.
  run.speed *= 1 - DRAG * dt;
  run.speed = clamp(run.speed, 0, MAX_SPEED);
  run.dist += run.speed * dt;
  if (run.dist > run.maxDist) run.maxDist = run.dist;
  collectPickups(run);

  // Checkpoints: crossing one banks the respawn point.
  for (let i = 0; i < brk.checkpoints.length; i++) {
    if (run.dist >= brk.checkpoints[i] && i > run.lastCheckpoint) run.lastCheckpoint = i;
  }

  // Reached the end of the break: the run is won.
  if (run.dist >= brk.length) {
    run.phase = 'won';
    finishScore(run);
    return run;
  }

  // The wave face ends at every crest: riding into the gap is a wipeout.
  if (inGap(brk, run.dist)) {
    wipeout(run, 'gap');
    return run;
  }

  // Off the face: the surfer ran out of wave.
  if (Math.abs(run.x) > brk.faceHalf) {
    wipeout(run, 'off-face');
    return run;
  }

  // Stall: no speed left, the wave leaves the surfer behind.
  if (run.speed < STALL_SPEED) {
    wipeout(run, 'stall');
    return run;
  }

  return run;
}

// ---------------------------------------------------------------- bots
export function noInputPolicy() {
  return { pump: false, carve: 0 };
}

export function holdPolicy() {
  // Holds pump forever and carves one way forever: the anti-slop bot
  // that must lose. Holding pump means it never releases, so it can
  // never launch over a gap; carving one way runs it off the face.
  return { pump: true, carve: 1 };
}

export function spamJumpPolicy() {
  // Pumps in short bursts and releases constantly: the jump-spam bot
  // that must lose. Releases outside the launch window do nothing but
  // stop pumping, so speed and flow never build.
  return { pump: false, carve: 0 };
}

export function randomPolicy(rng) {
  return {
    pump: rng() < 0.5,
    carve: rng() < 0.33 ? -1 : rng() < 0.5 ? 1 : 0,
  };
}

// The decision bot: real carve/pump/jump timing through the same
// public input hooks a human uses.
// - On the wave: carve toward the pocket with a lead (where the pocket
//   will be, not where it is); pump while in the pocket, and pump
//   anyway while approaching a crest to build flow for the launch;
//   release pump inside the launch window with real flow + speed.
// - Airborne: steer toward the pocket at the landing distance.
export function decisionPolicy(run) {
  const brk = run.brk;
  if (run.airborne) {
    // Steer toward the pocket where the surfer will actually land:
    // lead by the remaining air time, not a fixed distance — the
    // pocket drifts fast at high speed on the late breaks.
    const tLand = (run.airVy + Math.sqrt(Math.max(0, run.airVy * run.airVy + 2 * GRAVITY * run.airY))) / GRAVITY;
    const landDist = run.dist + run.speed * Math.max(0, tLand);
    const target = pocketX(brk, landDist);
    let carve = target > run.x + 0.4 ? 1 : target < run.x - 0.4 ? -1 : 0;
    // Bleed lateral speed before touchdown so the landing stays clean:
    // a fast sideways landing is a wipeout, however well placed.
    if (tLand < 0.35 && Math.abs(run.vx) > 4) carve = run.vx > 0 ? -1 : 1;
    return { pump: false, carve };
  }
  // On the wave: track the pocket with a lead.
  const leadDist = run.dist + run.speed * 0.35;
  const target = pocketX(brk, leadDist);
  const carve = target > run.x + 0.5 ? 1 : target < run.x - 0.5 ? -1 : 0;
  const pocketed = Math.abs(run.x - pocketX(brk, run.dist)) <= POCKET_HALF;
  const c = nextCrest(brk, run.dist);
  const nearCrest = c !== null && run.dist >= c - LAUNCH_WINDOW_BEFORE - 12;
  let pump = pocketed || nearCrest;
  // Release check: inside the launch window, with real flow and speed.
  if (c !== null && run.dist >= c - LAUNCH_WINDOW_BEFORE && run.dist <= c + LAUNCH_WINDOW_AFTER
    && run.flow >= LAUNCH_MIN_FLOW + 0.05 && run.speed >= LAUNCH_MIN_SPEED + 1) {
    pump = false;
  }
  return { pump, carve };
}

export function simulateRun(brk, policy, maxSeconds = 400) {
  const run = createRun(brk);
  const maxSteps = Math.floor(maxSeconds / DT);
  let steps = 0;
  const rng = mulberry32(1337 + brk.id);
  let cached = policy === 'random' ? randomPolicy(rng) : null;
  // Jump-spam bot: pump 6 steps, release 6 steps, carve at random.
  let spamStep = 0;
  while (run.phase === 'riding' && steps < maxSteps) {
    let input;
    if (policy === 'none') input = noInputPolicy();
    else if (policy === 'hold') input = holdPolicy();
    else if (policy === 'spam') {
      spamStep++;
      input = { pump: (spamStep % 12) < 6, carve: (spamStep % 24) < 12 ? 1 : -1 };
    } else if (policy === 'random') {
      if (steps % 15 === 0) cached = randomPolicy(rng);
      input = cached;
    } else if (policy === 'decision') input = decisionPolicy(run);
    else throw new Error('unknown policy: ' + policy);
    stepRun(run, input);
    steps++;
  }
  return {
    policy,
    breakId: brk.id,
    won: run.phase === 'won',
    lost: run.phase === 'lost',
    time: +run.time.toFixed(2),
    maxDist: +run.maxDist.toFixed(1),
    falls: run.falls,
    jumps: run.jumps,
    cleanLandings: run.cleanLandings,
    badLandings: run.badLandings,
    pickups: run.pickups,
    score: run.score,
    steps,
  };
}

// ---------------------------------------------------------------- save
export const RANK_ORDER = { B: 1, A: 2, S: 3 };
export function defaultSave() {
  return {
    version: 1,
    best: {}, // breakId -> { score, time, falls, pickups, won, rank? }
    unlocked: 1, // highest break id unlocked
    settings: { muted: false, shake: 100, flash: true },
  };
}

export function serializeSave(save) {
  return JSON.stringify(save);
}

export function parseSave(raw) {
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return defaultSave();
    const d = defaultSave();
    const best = {};
    for (const [id, entry] of Object.entries(s.best || {})) {
      if (!entry || typeof entry !== 'object') continue;
      const kept = { ...entry };
      if (kept.rank !== undefined && !['S', 'A', 'B'].includes(kept.rank)) delete kept.rank;
      best[id] = kept;
    }
    return {
      version: 1,
      best,
      unlocked: Number.isInteger(s.unlocked) ? clamp(s.unlocked, 1, BREAKS.length) : 1,
      settings: { ...d.settings, ...(s.settings || {}) },
    };
  } catch {
    return defaultSave();
  }
}

export function recordBest(save, breakId, result) {
  const prev = save.best[breakId];
  if (!result.won) return save;
  const better = !prev || result.score > prev.score;
  let rank = prev ? prev.rank : undefined;
  if (typeof result.par === 'number') {
    const r = rankFor(result);
    if (r && (!rank || RANK_ORDER[r] > RANK_ORDER[rank])) rank = r;
  }
  if (better) {
    save.best[breakId] = {
      score: result.score,
      time: result.time,
      falls: result.falls,
      pickups: result.pickups,
      won: true,
    };
  }
  if (rank) save.best[breakId].rank = rank;
  if (breakId < BREAKS.length && save.unlocked < breakId + 1) {
    save.unlocked = breakId + 1;
  }
  return save;
}

export function isBreakUnlocked(save, breakId) {
  return breakId <= save.unlocked;
}

export function rankFor(result) {
  // S: won with 0 falls and under par. A: won under par. B: won over par.
  if (!result.won) return null;
  if (result.falls === 0 && result.time <= result.par) return 'S';
  if (result.time <= result.par) return 'A';
  return 'B';
}

// ---------------------------------------------------------------- feedback
// Game-feel tiers (same shape as the other games): every event fires a
// bundle of layered responses within ~100ms.
export const FEEDBACK = {
  pump: { trauma: 0.05, hitStop: 0, sfx: 'pump', flash: 0, particles: 2 },
  launch: { trauma: 0.22, hitStop: 0, sfx: 'launch', flash: 0, particles: 10 },
  land: { trauma: 0.3, hitStop: 0.04, sfx: 'land', flash: 0, particles: 16 },
  pickup: { trauma: 0.15, hitStop: 0, sfx: 'pickup', flash: 0, particles: 14 },
  wipeout: { trauma: 0.5, hitStop: 0.06, sfx: 'wipeout', flash: 0.12, particles: 26 },
  finish: { trauma: 0.8, hitStop: 0.12, sfx: 'finish', flash: 0.2, particles: 60 },
  denied: { trauma: 0.08, hitStop: 0, sfx: 'denied', flash: 0, particles: 0 },
};
export const FEEDBACK_TIERS = {
  small: { trauma: [0.1, 0.2], hitStop: 0 },
  medium: { trauma: [0.3, 0.5], hitStop: [0.04, 0.06] },
  large: { trauma: [0.7, 1.0], hitStop: [0.1, 0.15] },
};
export const FEEDBACK_LAYERS = ['sound', 'particles', 'shake', 'flash', 'number-pop'];
