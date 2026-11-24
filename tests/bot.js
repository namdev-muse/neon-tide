// Neon Tide v0.1.0 — bot harness gates.
// The decision bot must clear every break with real carve/pump/jump
// timing; the bots that must lose (hold one direction + pump forever,
// no input, random, jump-spam) must lose on every break. If a
// hold-one-button bot clears a break, the break is not done.
import { BREAKS, simulateRun } from '../physics.js';

let failed = 0;
function gate(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
}

for (const brk of BREAKS) {
  const decision = simulateRun(brk, 'decision');
  gate(
    `decision bot clears break ${brk.id} (${brk.name})`,
    decision.won,
    `time ${decision.time}s (par ${brk.par}s), maxDist ${decision.maxDist}/${brk.length}, falls ${decision.falls}, jumps ${decision.jumps}, clean ${decision.cleanLandings}, pickups ${decision.pickups}, score ${decision.score}`,
  );
  gate(
    `decision bot clears break ${brk.id} without falling`,
    decision.won && decision.falls === 0,
    `falls ${decision.falls}`,
  );
  gate(
    `decision bot uses real timing on break ${brk.id} (one jump per crest, all clean)`,
    decision.won && decision.jumps === brk.crests.length && decision.cleanLandings === brk.crests.length,
    `jumps ${decision.jumps}, crests ${brk.crests.length}, clean ${decision.cleanLandings}`,
  );

  const hold = simulateRun(brk, 'hold');
  gate(
    `hold-one-direction bot LOSES break ${brk.id}`,
    !hold.won,
    `maxDist ${hold.maxDist}/${brk.length}, falls ${hold.falls}`,
  );
  gate(
    `hold bot never gets halfway down break ${brk.id}`,
    hold.maxDist < brk.length * 0.5,
    `maxDist ${hold.maxDist}`,
  );

  const none = simulateRun(brk, 'none');
  gate(
    `no-input bot LOSES break ${brk.id}`,
    !none.won && none.lost,
    `lost=${none.lost}, falls ${none.falls}, time ${none.time}s`,
  );

  const random = simulateRun(brk, 'random');
  gate(
    `random-input bot LOSES break ${brk.id}`,
    !random.won,
    `maxDist ${random.maxDist}/${brk.length}, falls ${random.falls}`,
  );

  const spam = simulateRun(brk, 'spam');
  gate(
    `jump-spam bot LOSES break ${brk.id}`,
    !spam.won,
    `maxDist ${spam.maxDist}/${brk.length}, jumps ${spam.jumps}, falls ${spam.falls}`,
  );
}

// Difficulty curve: the decision bot's clear time grows with break number
// (later breaks take more real surfing, not less).
{
  const times = BREAKS.map((b) => simulateRun(b, 'decision').time);
  gate(
    'decision-bot clear time grows with break number (real curve, no cliff)',
    times.every((t, i) => i === 0 || t > times[i - 1]),
    `times ${times.join('s, ')}s`,
  );
}

if (failed > 0) {
  console.error(`bot gates: ${failed} FAILED`);
  process.exit(1);
}
console.log('bot gates: all pass');
