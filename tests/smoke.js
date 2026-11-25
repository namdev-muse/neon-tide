// Neon Tide v0.3.0 — Node smoke tests for physics.js (no DOM, no Three.js).
import {
  VERSION, BREAKS, breakById, breakThreat, DT, GRAVITY, START_SPEED,
  STALL_SPEED, MAX_SPEED, FACE_HALF, POCKET_HALF, CARVE_ACCEL,
  PUMP_ACCEL, FLOW_BUILD, LAUNCH_MIN_FLOW, LAUNCH_MIN_SPEED,
  MAX_FALLS, PICKUP_SCORE, CLEAN_LAND_SCORE, pocketX, inPocket,
  nextCrest, inGap, createRun, startRun, stepRun, flowEnergy,
  noInputPolicy, holdPolicy, randomPolicy, decisionPolicy, simulateRun,
  defaultSave, serializeSave, parseSave, recordBest, isBreakUnlocked,
  rankFor, FEEDBACK, FEEDBACK_TIERS, FEEDBACK_LAYERS,
} from '../physics.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed++;
  else { failed++; failures.push(name); console.error('FAIL:', name); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

check('physics version is 0.3.0', VERSION === '0.3.0');
check('12 breaks defined', BREAKS.length === 12);
check('break ids are 1..12 in order', BREAKS.every((b, i) => b.id === i + 1));
check('every break has a name and a hint', BREAKS.every((b) => b.name && b.hint));
check('every break has a distinct accent', new Set(BREAKS.map((b) => b.accent)).size === 12);
check('breakById finds break 1', breakById(1) && breakById(1).name === 'First Swell');
check('breakById finds break 3', breakById(3) && breakById(3).name === 'Violet Break');
check('breakById finds break 12', breakById(12) && breakById(12).name === 'Void Crown');
check('breakById returns null for unknown id', breakById(99) === null);
check('every break has 4+ crests', BREAKS.every((b) => b.crests.length >= 4));
check('every break has 2+ checkpoints', BREAKS.every((b) => b.checkpoints.length >= 2));
check('every break has 3+ pickups', BREAKS.every((b) => b.pickups.length >= 3));
check('crest distances strictly increase', BREAKS.every((b) => b.crests.every((c, i) => i === 0 || c > b.crests[i - 1])));
check('last crest sits before the end of the break', BREAKS.every((b) => b.crests[b.crests.length - 1] + b.gapWidth < b.length));
check('checkpoints start at 0 and increase', BREAKS.every((b) => b.checkpoints[0] === 0 && b.checkpoints.every((c, i) => i === 0 || c > b.checkpoints[i - 1])));
check('threat grows with break number', BREAKS.every((b, i) => i === 0 || breakThreat(b) > breakThreat(BREAKS[i - 1])));
check('no difficulty cliff: each break within 1.6x of the previous threat',
  BREAKS.every((b, i) => i === 0 || breakThreat(b) < breakThreat(BREAKS[i - 1]) * 1.6));

// --- pocket / gap geometry ---
check('pocketX starts at the phase offset', approx(pocketX(BREAKS[0], 0), 0));
check('pocket stays inside the face', BREAKS.every((b) => {
  for (let d = 0; d <= b.length; d += 5) {
    if (Math.abs(pocketX(b, d)) + POCKET_HALF > b.faceHalf) return false;
  }
  return true;
}));
check('inPocket is true at the pocket centre', inPocket(BREAKS[0], 0, pocketX(BREAKS[0], 0)));
check('inPocket is false far from the pocket', !inPocket(BREAKS[0], 0, pocketX(BREAKS[0], 0) + POCKET_HALF + 2));
check('inGap is true inside a crest gap', inGap(BREAKS[0], BREAKS[0].crests[0] + 2));
check('inGap is false before the first crest', !inGap(BREAKS[0], BREAKS[0].crests[0] - 2));
check('inGap is false after the gap ends', !inGap(BREAKS[0], BREAKS[0].crests[0] + BREAKS[0].gapWidth + 2));
check('nextCrest finds the first crest ahead', nextCrest(BREAKS[0], 0) === BREAKS[0].crests[0]);
check('nextCrest is null past the last crest', nextCrest(BREAKS[0], BREAKS[0].length) === null);
check('nextCrest still names a crest through its launch window', nextCrest(BREAKS[0], 61) === BREAKS[0].crests[0]);
check('nextCrest moves on past the window', nextCrest(BREAKS[0], 63) === BREAKS[0].crests[1]);

// --- run lifecycle ---
const run1 = startRun(1);
check('startRun returns a run on break 1', !!run1 && run1.brk.id === 1);
check('run starts in the pocket', approx(run1.x, pocketX(run1.brk, 0)));
check('run starts at the start speed', run1.speed === START_SPEED);
check('run starts in riding phase', run1.phase === 'riding');
check('startRun returns null for unknown break', startRun(99) === null);

// --- carve: carving left moves the surfer left, right moves it right ---
{
  const r = startRun(1);
  const x0 = r.x;
  for (let i = 0; i < 30; i++) stepRun(r, { pump: false, carve: -1 });
  check('carving left moves the surfer left', r.x < x0 - 1);
  const r2 = startRun(1);
  const x02 = r2.x;
  for (let i = 0; i < 30; i++) stepRun(r2, { pump: false, carve: 1 });
  check('carving right moves the surfer right', r2.x > x02 + 1);
}
// --- pump: pumping in the pocket builds speed + flow; outside it bogs ---
{
  const r = startRun(1);
  const s0 = r.speed;
  for (let i = 0; i < 60; i++) stepRun(r, { pump: true, carve: 0 });
  check('pumping in the pocket builds speed', r.speed > s0);
  check('pumping in the pocket builds flow', flowEnergy(r) > 0.3);
  const r2 = startRun(1);
  r2.x = r2.brk.faceHalf - 1; // far from the pocket
  const s02 = r2.speed;
  for (let i = 0; i < 60; i++) stepRun(r2, { pump: true, carve: 0 });
  check('pumping outside the pocket bogs the board (no speed gain)', r2.speed <= s02 + 0.5);
  check('pumping outside the pocket does not build flow', flowEnergy(r2) < 0.1);
}
// --- release: outside the launch window a release does nothing ---
{
  const r = startRun(1);
  for (let i = 0; i < 120; i++) stepRun(r, { pump: true, carve: 0 });
  const flow0 = r.flow;
  check('flow is built before the release test', flow0 >= LAUNCH_MIN_FLOW);
  stepRun(r, { pump: false, carve: 0 }); // release at dist ~30, far from any crest
  check('releasing outside the launch window does not launch', r.airborne === false && r.jumps === 0);
}
// --- denied release: a failed launch names the reason (M3) ---
// A release near a crest that does not launch reports why, so the
// game can give post-action feedback; a release far from any crest
// is just stopping the pump and stays silent.
{
  const setup = (dist, flow, speed) => {
    const r = startRun(1);
    r.dist = dist;
    r.x = pocketX(r.brk, dist);
    r.speed = speed;
    r.flow = flow;
    r.pumpHeld = true; // previous step held, so this release is an edge
    return r;
  };
  const c0 = BREAKS[0].crests[0]; // 60
  let r = setup(c0 - 10, 0.9, 14);
  stepRun(r, { pump: false, carve: 0 });
  check('release before the window reports early', r.deniedReason === 'early' && r.jumps === 0);
  r = setup(c0 - 3, 0.1, 14);
  stepRun(r, { pump: false, carve: 0 });
  check('release in the window without flow reports flow', r.deniedReason === 'flow' && r.jumps === 0);
  r = setup(c0 - 3, 0.9, 6);
  stepRun(r, { pump: false, carve: 0 });
  check('release in the window without speed reports speed', r.deniedReason === 'speed' && r.jumps === 0);
  r = setup(c0 + 4, 0.9, 14);
  stepRun(r, { pump: false, carve: 0 });
  check('release past the crest reports late', r.deniedReason === 'late');
  r = setup(30, 0.9, 14);
  stepRun(r, { pump: false, carve: 0 });
  check('release far from any crest reports nothing', r.deniedReason === null && r.jumps === 0);
  r = setup(c0 - 3, 0.9, 14);
  stepRun(r, { pump: false, carve: 0 });
  check('a good release launches and reports nothing', r.airborne === true && r.deniedReason === null);
  r = setup(c0 + 1, 0.9, 14);
  stepRun(r, { pump: false, carve: 0 });
  check('a release just past the crest lip still launches', r.airborne === true && r.deniedReason === null);
  stepRun(r, { pump: false, carve: 0 });
  check('denied reason clears on the next step', r.deniedReason === null);
}
// --- launch: release inside the window with flow + speed launches ---
{
  const r = startRun(1);
  // Set up just inside the launch window with real flow and speed,
  // pump held on the previous step so this release is an edge.
  r.dist = r.brk.crests[0] - 3;
  r.x = pocketX(r.brk, r.dist);
  r.speed = 14;
  r.flow = 0.8;
  r.pumpHeld = true;
  const flow0 = r.flow;
  const jumps0 = r.jumps;
  stepRun(r, { pump: false, carve: 0 });
  check('releasing inside the launch window launches', r.airborne === true && r.jumps === jumps0 + 1);
  check('the launch spends flow', r.flow < flow0);
}
// --- air: gravity pulls the airborne surfer down, air time accrues ---
{
  const r = startRun(1);
  r.airborne = true;
  r.airY = 5;
  r.airVy = 0;
  const y0 = r.airY;
  stepRun(r, { pump: false, carve: 0 });
  check('gravity pulls the airborne surfer down', r.airY < y0 && r.airVy < 0);
  check('air time accrues while airborne', r.airTime > 0);
}
// --- clean landing: in the pocket with low lateral speed keeps the combo ---
{
  const r = startRun(1);
  r.airborne = true;
  r.airY = 0.01; // one step from touchdown
  r.airVy = -1;
  r.dist = 100; // past the first gap [60,72], in open water
  r.x = pocketX(r.brk, 100);
  r.vx = 0;
  stepRun(r, { pump: false, carve: 0 });
  check('a clean landing keeps the run riding', r.phase === 'riding' && r.airborne === false);
  check('a clean landing builds the combo', r.combo === 1 && r.cleanLandings === 1);
  check('a clean landing scores', r.score >= CLEAN_LAND_SCORE);
}
// --- bad landing: landing outside the pocket is a wipeout ---
{
  const r = startRun(1);
  r.airborne = true;
  r.airY = 0.01; // one step from touchdown
  r.airVy = -1;
  r.dist = 100;
  r.lastCheckpoint = 1; // banked at the 100m checkpoint
  r.x = pocketX(r.brk, 100) + POCKET_HALF + 5; // way outside the pocket
  r.vx = 0;
  stepRun(r, { pump: false, carve: 0 });
  check('a bad landing is a wipeout (fall counted)', r.falls === 1);
  check('a bad landing respawns at the checkpoint', r.dist === r.brk.checkpoints[1]);
}
// --- gap: riding into a closeout gap is a wipeout ---
{
  const r = startRun(1);
  r.dist = r.brk.crests[0] - 1;
  r.speed = 20;
  for (let i = 0; i < 30 && r.falls === 0; i++) stepRun(r, { pump: false, carve: 0 });
  check('riding into the gap wipes out', r.falls >= 1);
}
// --- off the face: |x| beyond the face half-width is a wipeout ---
{
  const r = startRun(1);
  r.x = r.brk.faceHalf + 0.5;
  r.vx = 0;
  stepRun(r, { pump: false, carve: 0 });
  check('running off the face wipes out', r.falls === 1);
}
// --- stall: speed below the stall threshold wipes out ---
{
  const r = startRun(1);
  r.speed = STALL_SPEED - 0.1;
  stepRun(r, { pump: false, carve: 0 });
  check('stalling out wipes out', r.falls === 1);
}
// --- 5 falls lose the run ---
{
  const r = startRun(1);
  r.falls = MAX_FALLS - 1;
  r.speed = STALL_SPEED - 0.1;
  stepRun(r, { pump: false, carve: 0 });
  check('5th fall loses the run', r.phase === 'lost' && r.falls === MAX_FALLS);
}
// --- a fall costs 3 seconds and resets the combo ---
{
  const r = startRun(1);
  r.combo = 3;
  const t0 = r.time;
  r.speed = STALL_SPEED - 0.1;
  stepRun(r, { pump: false, carve: 0 });
  check('a fall costs 3 seconds on the clock', r.time >= t0 + 3);
  check('a fall resets the combo', r.combo === 0);
}
// --- pickups: riding through one collects it for score, once ---
{
  const r = startRun(1);
  const p = r.brk.pickups[0];
  r.dist = p.dist;
  r.x = p.x;
  const score0 = r.score;
  stepRun(r, { pump: false, carve: 0 });
  check('pickup collected on contact', r.pickups === 1 && r.score === score0 + PICKUP_SCORE);
  const s = r.score;
  stepRun(r, { pump: false, carve: 0 });
  check('pickup cannot be collected twice', r.score === s);
}
// --- checkpoints: crossing one banks the respawn point ---
{
  const r = startRun(1);
  r.dist = r.brk.checkpoints[1] - 0.5;
  r.speed = 12;
  for (let i = 0; i < 30 && r.lastCheckpoint === 0; i++) stepRun(r, { pump: false, carve: 0 });
  check('crossing a checkpoint banks it', r.lastCheckpoint === 1);
}
// --- determinism: identical inputs give identical runs ---
{
  const a = startRun(2);
  const b = startRun(2);
  for (let i = 0; i < 300; i++) {
    const inp = decisionPolicy(a);
    stepRun(a, inp);
    stepRun(b, decisionPolicy(b));
  }
  check('identical inputs give identical runs', a.dist === b.dist && a.x === b.x && a.score === b.score);
}
// --- save / unlock / ranks ---
{
  const s = defaultSave();
  check('fresh save unlocks only break 1', s.unlocked === 1 && isBreakUnlocked(s, 1) && !isBreakUnlocked(s, 2));
  recordBest(s, 1, { won: true, score: 1500, time: 30, falls: 0, pickups: 3 });
  check('clearing break 1 unlocks break 2', s.unlocked === 2 && isBreakUnlocked(s, 2));
  check('best score recorded', s.best[1].score === 1500);
  const s2 = parseSave(serializeSave(s));
  check('save round-trips through JSON', s2.unlocked === 2 && s2.best[1].score === 1500);
  check('corrupt save falls back to defaults', parseSave('not json').unlocked === 1);
  check('S rank needs no falls under par', rankFor({ won: true, falls: 0, time: 30, par: 40 }) === 'S');
  check('A rank is a win under par with a fall', rankFor({ won: true, falls: 1, time: 30, par: 40 }) === 'A');
  check('B rank is a win over par', rankFor({ won: true, falls: 0, time: 90, par: 40 }) === 'B');
  check('no rank without a win', rankFor({ won: false, falls: 0, time: 30, par: 40 }) === null);
  check('a loss does not record a best', (() => {
    const s3 = defaultSave();
    recordBest(s3, 1, { won: false, score: 9999, time: 10, falls: 5, pickups: 0 });
    return !s3.best[1];
  })());
}
// --- per-break clear ranks are saved and kept: rank tracking is
// independent of the score — a better rank upgrades the saved rank
// even on a lower-score clear, and a worse rank never downgrades it.
{
  const s = defaultSave();
  recordBest(s, 1, { won: true, score: 1500, time: 30, falls: 0, pickups: 3, par: 40 });
  check('an S clear stores rank S', s.best[1].rank === 'S');
  recordBest(s, 1, { won: true, score: 1600, time: 30, falls: 1, pickups: 3, par: 40 });
  check('a later A clear with a better score keeps rank S', s.best[1].rank === 'S' && s.best[1].score === 1600);
  const s2 = defaultSave();
  recordBest(s2, 1, { won: true, score: 1000, time: 90, falls: 0, pickups: 2, par: 40 });
  check('a B clear stores rank B', s2.best[1].rank === 'B');
  recordBest(s2, 1, { won: true, score: 900, time: 30, falls: 1, pickups: 2, par: 40 });
  check('a later A clear with a lower score upgrades rank B to A', s2.best[1].rank === 'A' && s2.best[1].score === 1000);
  recordBest(s2, 1, { won: true, score: 800, time: 90, falls: 2, pickups: 2, par: 40 });
  check('rank survives a lower-score clear', s2.best[1].rank === 'A' && s2.best[1].score === 1000);
  const s3 = parseSave(serializeSave(s2));
  check('save round-trip keeps rank', s3.best[1].rank === 'A');
  check('parseSave drops an invalid rank', parseSave(JSON.stringify({ best: { 1: { score: 1, won: true, rank: 'X' } } })).best[1].rank === undefined);
  check('parseSave keeps a valid rank', parseSave(JSON.stringify({ best: { 1: { score: 1, won: true, rank: 'S' } } })).best[1].rank === 'S');
}
// --- flow energy: the meter the HUD, spray and pump tick all read from.
{
  const r = startRun(1);
  check('flow energy is 0 at rest', flowEnergy(r) === 0);
  for (let i = 0; i < 60; i++) stepRun(r, { pump: true, carve: 0 });
  const e = flowEnergy(r);
  check('flow energy rises as the surfer pumps in the pocket', e > 0.3 && e <= 1);
  for (let i = 0; i < 1800; i++) stepRun(r, { pump: true, carve: 0 });
  check('flow energy never exceeds 1 (capped)', flowEnergy(r) <= 1);
}
// --- feedback table is complete and tiered.
check('feedback events exist for every game event',
  ['pump', 'launch', 'land', 'pickup', 'wipeout', 'finish', 'denied'].every((e) => !!FEEDBACK[e]));
check('every feedback entry carries a full bundle (sfx, particles, trauma, hit-stop, flash)',
  Object.values(FEEDBACK).every((fb) =>
    typeof fb.sfx === 'string' && fb.sfx.length > 0 &&
    Number.isInteger(fb.particles) && fb.particles >= 0 &&
    fb.trauma >= 0 && fb.trauma <= 1 &&
    fb.hitStop >= 0 && fb.hitStop <= 0.15 &&
    fb.flash >= 0 && fb.flash <= 0.2));
check('feedback tiers match the game-feel skill ranges',
  FEEDBACK_TIERS.small.trauma[0] === 0.1 && FEEDBACK_TIERS.small.trauma[1] === 0.2 && FEEDBACK_TIERS.small.hitStop === 0 &&
  FEEDBACK_TIERS.medium.trauma[0] === 0.3 && FEEDBACK_TIERS.medium.trauma[1] === 0.5 &&
  FEEDBACK_TIERS.medium.hitStop[0] === 0.04 && FEEDBACK_TIERS.medium.hitStop[1] === 0.06 &&
  FEEDBACK_TIERS.large.trauma[0] === 0.7 && FEEDBACK_TIERS.large.trauma[1] === 1.0 &&
  FEEDBACK_TIERS.large.hitStop[0] === 0.1 && FEEDBACK_TIERS.large.hitStop[1] === 0.15);
check('every feedback event sits inside its tier (trauma within the matching tier band)',
  FEEDBACK.pump.trauma <= FEEDBACK_TIERS.small.trauma[1] &&
  FEEDBACK.launch.trauma <= FEEDBACK_TIERS.medium.trauma[1] &&
  FEEDBACK.land.trauma >= FEEDBACK_TIERS.medium.trauma[0] && FEEDBACK.land.trauma <= FEEDBACK_TIERS.medium.trauma[1] &&
  FEEDBACK.land.hitStop >= FEEDBACK_TIERS.medium.hitStop[0] && FEEDBACK.land.hitStop <= FEEDBACK_TIERS.medium.hitStop[1] &&
  FEEDBACK.wipeout.trauma >= FEEDBACK_TIERS.medium.trauma[0] && FEEDBACK.wipeout.trauma <= FEEDBACK_TIERS.medium.trauma[1] &&
  FEEDBACK.wipeout.hitStop >= FEEDBACK_TIERS.medium.hitStop[0] && FEEDBACK.wipeout.hitStop <= FEEDBACK_TIERS.medium.hitStop[1] &&
  FEEDBACK.finish.trauma >= FEEDBACK_TIERS.large.trauma[0] && FEEDBACK.finish.hitStop >= FEEDBACK_TIERS.large.hitStop[0]);
check('feedback tiers cover small/medium/large',
  !!FEEDBACK_TIERS.small && !!FEEDBACK_TIERS.medium && !!FEEDBACK_TIERS.large);
check('feedback layers list sound, particles, shake, flash, number-pop',
  FEEDBACK_LAYERS.join(',') === 'sound,particles,shake,flash,number-pop');
check('finish is the biggest feedback (trauma >= wipeout)',
  FEEDBACK.finish.trauma >= FEEDBACK.wipeout.trauma && FEEDBACK.finish.hitStop >= FEEDBACK.wipeout.hitStop);
check('gravity is positive and sane', GRAVITY > 10 && GRAVITY < 30);
check('pump beats drag enough to build speed', PUMP_ACCEL > 2);
check('fixed step is 1/60', approx(DT, 1 / 60));

console.log(`smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('failures:', failures.join(' | '));
  process.exit(1);
}
