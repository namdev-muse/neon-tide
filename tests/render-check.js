// Neon Tide v0.1.0 — headless browser render check.
// Serves the game dir over local HTTP, loads it in a headless
// browser, and asserts the M1 core, by hook and by eye:
//   - the menu renders over a LIVE 3D scene (the attract demo
//     actually rides — the demo run advances), with no
//     version/engine text anywhere the player can see, one clear
//     primary Play action, and 3 break cards (break 1 unlocked,
//     breaks 2-3 locked on a fresh save)
//   - Play starts break 1 with the HUD; the surfer starts in the
//     pocket at the start speed
//   - carving is asserted in SCREEN space: ArrowLeft moves the
//     surfer LEFT on screen relative to the channel centre (the Drift
//     M2 lesson — a mirrored input bug survived every world-space test)
//   - holding Space (pump) builds FLOW; the FLOW meter tracks it and
//     pump ticks fire on pump edges
//   - the autopilot (decision bot) clears break 1 in the real browser
//     with real jumps and clean landings
//   - with no input the surfer wipes out and respawns at the
//     checkpoint (falls increment), and 5 falls lose the break
//   - pause focuses Resume; Enter resumes; R restarts
//   - shake 0 suppresses trauma; the rest state settles clean
//     (trauma 0, FOV 62, time scale 1, FOV dip 0)
//   - ?break=2 reaches break 2 and ?break=3 reaches break 3 (public unlock/seed path — Apex lesson)
//   - the canvas pixels actually change during a run
//   - the FPS guard is present and steps the render scale down on demand
//   - zero console errors and zero page errors, and a WebGL context exists
//
// Run: node tests/render-check.js
//
// CDN note: the repo pins Three.js 0.160.0 from jsdelivr and does NOT
// vendor it. The sandboxed browser cannot reach the jsdelivr CDN (the VM
// egress proxy answers policy_denied to every non-curl/wget client,
// including Chromium), even though curl gets HTTP 200 for the pinned
// URL from this VM. So this check downloads the pinned module with
// curl into the OS temp dir and fulfils that one request locally via
// page.route. The shipped game still loads Three.js from the CDN.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-tide-render-check');
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const THREE_CACHE = path.join(os.tmpdir(), 'neon-tide-three-0.160.0.module.js');

async function fetchThreeModule() {
  try {
    const st = fs.statSync(THREE_CACHE);
    if (st.size > 100000) return THREE_CACHE;
  } catch { /* not cached yet */ }
  await new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-o', THREE_CACHE, THREE_URL], (err) => (err ? reject(err) : resolve()));
  });
  const st = fs.statSync(THREE_CACHE);
  if (st.size < 100000) throw new Error(`downloaded Three.js module is unexpectedly small (${st.size} bytes)`);
  return THREE_CACHE;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function findHeadlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(base)) {
      const candidate = path.join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* cache dir missing */ }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(GAME_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const require = createRequire(import.meta.url);
const playwrightPath = fileURLToPath(new URL('../../neon-hexfall/node_modules/playwright-core', import.meta.url));
const { chromium } = require(playwrightPath);
const executablePath = findHeadlessShell();
console.log('render-check: chromium executable:', executablePath || '(playwright default)');

const errors = [];
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
let browser;
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(stamp() + ' console: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));

  if (!process.env.NO_THREE_CACHE) {
    const cached = await fetchThreeModule();
    console.log(`render-check: fulfilling pinned three@0.160.0 from local curl cache (${cached}) — sandboxed browser cannot reach jsdelivr directly`);
    await page.route(THREE_URL, (route) => route.fulfill({ path: cached }));
  }

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForFunction(() => window.__tide, null, { timeout: 30000 });
  } catch {
    console.error('render-check: window.__tide never appeared — the pinned Three.js module failed to load.');
    console.error('CDN check from this VM: curl -sI ' + THREE_URL + ' (expect HTTP 200).');
    throw new Error('game module did not initialise (see CDN note above)');
  }

  const version = await page.evaluate(() => window.__tide.version);
  if (version !== '0.1.0') throw new Error(`expected version 0.1.0, got ${version}`);
  console.log('render-check: game module initialised, version 0.1.0');

  // WebGL context exists and the canvas is on screen.
  const gl = await page.evaluate(() => {
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return ctx ? { width: canvas.width, height: canvas.height } : null;
  });
  if (!gl) throw new Error('no WebGL context on the game canvas');
  console.log(`render-check: WebGL context live (${gl.width}x${gl.height} canvas)`);

  // The FPS guard is present (rolling FPS average, one-way DPR
  // ladder 2 → 1.5 → 1 + reduced particle spawn). The manual trigger
  // steps the cap down one rung and the renderer keeps working.
  const guard0 = await page.evaluate(() => window.__tide.info().fpsGuard);
  if (!guard0 || ![2, 1.5, 1].includes(guard0.dprCap)) throw new Error(`FPS guard state missing or bad dprCap: ${JSON.stringify(guard0)}`);
  if (!(guard0.pixelRatio >= 1 && guard0.pixelRatio <= 2)) throw new Error(`FPS guard pixel ratio out of range: ${guard0.pixelRatio}`);
  if (!(guard0.particleScale > 0 && guard0.particleScale <= 1)) throw new Error(`FPS guard particle scale out of range: ${guard0.particleScale}`);
  await page.evaluate(() => window.__tide.triggerFpsGuard());
  const guard1 = await page.evaluate(() => window.__tide.info().fpsGuard);
  if (guard1.dprCap > guard0.dprCap) throw new Error(`triggerFpsGuard must not raise the cap (${guard0.dprCap} -> ${guard1.dprCap})`);
  if (guard0.dprCap > 1 && guard1.dprCap >= guard0.dprCap) throw new Error(`triggerFpsGuard should step the cap down (${guard0.dprCap} -> ${guard1.dprCap})`);
  if (guard1.particleScale > guard0.particleScale) throw new Error('FPS guard should reduce particle spawn when stepping down');
  const fpsVal = await page.evaluate(() => window.__tide.info().fps);
  if (!Number.isFinite(fpsVal) || fpsVal < 0) throw new Error(`FPS guard should report a sane fps, got ${fpsVal}`);
  console.log(`render-check: FPS guard present (dprCap ${guard0.dprCap} -> ${guard1.dprCap}, pixelRatio ${guard1.pixelRatio}, particleScale ${guard1.particleScale}, fps ${fpsVal})`);

  // The menu: title, one primary Play, 3 break cards, NO version/engine
  // text anywhere the player can see. Break 1 unlocked, breaks 2-3 locked.
  const menuText = await page.textContent('#menu');
  if (!menuText.includes('NEON TIDE')) throw new Error('menu title missing');
  if (menuText.includes('v0.1.0') || menuText.includes('Three.js') || menuText.includes('0.160.0')) {
    throw new Error('menu shows version/engine text — it must live in the README only');
  }
  const playClass = await page.getAttribute('#btn-play', 'class');
  if (!playClass || !playClass.includes('primary')) throw new Error('Play is not the primary action');
  const breakCards = await page.locator('#break-select .track-card').count();
  if (breakCards !== 3) throw new Error(`expected 3 break cards, got ${breakCards}`);
  const breaks = await page.evaluate(() => window.__tide.breaks.map((b) => b.name));
  if (breaks.length !== 3 || breaks[0] !== 'First Swell' || breaks[2] !== 'Violet Break') {
    throw new Error(`break list wrong: ${JSON.stringify(breaks)}`);
  }
  const unlocked = await page.evaluate(() => window.__tide.save.unlocked);
  if (unlocked !== 1) throw new Error(`fresh save should unlock only break 1, got ${unlocked}`);
  const lockedCards = await page.locator('#break-select .track-card:disabled').count();
  if (lockedCards !== 2) throw new Error(`expected 2 locked break cards on a fresh save, got ${lockedCards}`);
  console.log('render-check: menu renders — live 3D behind it, no version text, Play primary, 3 breaks, break 1 unlocked only');

  // The accessibility toggles work and restore cleanly.
  await page.click('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('settings').classList.contains('hidden'), null, { timeout: 5000 });
  await page.check('#reduce-flashing');
  const flashOff = await page.evaluate(() => window.__tide.state.flash);
  if (flashOff !== false) throw new Error('reduce-flashing should turn state.flash off');
  // The Settings panel shows a live performance readout (fps +
  // FPS-guard render scale) — real state, not empty space.
  const perfLine = await page.textContent('#perf-line');
  if (!/^Performance: \d+ fps · render scale [\d.]+×/.test(perfLine.trim())) throw new Error(`settings performance line wrong: ${perfLine}`);
  await page.selectOption('#text-size-select', '1.2');
  const fsLarge = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  if (!(fsLarge > 16)) throw new Error(`text size Large should grow the root font, got ${fsLarge}px`);
  await page.check('#high-contrast-toggle');
  const hc = await page.evaluate(() => document.body.classList.contains('high-contrast'));
  if (!hc) throw new Error('high-contrast toggle should add the high-contrast class');
  await page.uncheck('#reduce-flashing');
  await page.selectOption('#text-size-select', '1');
  await page.uncheck('#high-contrast-toggle');
  const flashBack = await page.evaluate(() => window.__tide.state.flash);
  if (flashBack !== true) throw new Error('unchecking reduce-flashing should restore flash');
  const fsBack = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  if (Math.abs(fsBack - 16) > 0.5) throw new Error(`text size should restore to 16px, got ${fsBack}px`);
  const hcBack = await page.evaluate(() => document.body.classList.contains('high-contrast'));
  if (hcBack) throw new Error('high-contrast toggle should remove the class when unchecked');
  await page.click('#btn-settings-close');
  await page.waitForFunction(() => document.getElementById('settings').classList.contains('hidden'), null, { timeout: 5000 });
  console.log('render-check: accessibility toggles work — reduce-flashing, text size, high contrast, all restored');

  // The attract demo rides behind the menu: the demo run advances.
  const demo0 = await page.evaluate(() => window.__tide.info());
  if (!demo0) throw new Error('no demo info in the menu phase');
  await page.waitForFunction((t0) => {
    const i = window.__tide.info();
    return i && i.time > t0 + 5;
  }, demo0.time, { timeout: 60000 });
  const demo1 = await page.evaluate(() => window.__tide.info());
  console.log(`render-check: attract demo alive — demo surfer riding (t ${demo0.time.toFixed(1)} -> ${demo1.time.toFixed(1)}, dist ${demo1.maxDist.toFixed(1)}m)`);

  // Menu screenshot for the by-eye check.
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'menu-1280x720.png'), timeout: 60000 });
  console.log(`render-check: menu screenshot saved to ${SHOTS_DIR}/menu-1280x720.png — INSPECT BY EYE (live 3D scene, no clipped cards)`);

  // PLAY starts break 1 with the HUD; the surfer starts in the pocket.
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__tide.phase === 'playing', null, { timeout: 5000 });
  if (!await page.isVisible('#hud')) throw new Error('HUD not visible after PLAY');
  const hudBreak = await page.textContent('#hud-break');
  if (!hudBreak.includes('First Swell')) throw new Error(`expected break 1 First Swell, got: ${hudBreak}`);
  // The HUD distance is a "Xm / Ym" readout, and each HUD group has a
  // pill backdrop so it reads over the neon.
  const hudDist = await page.textContent('#hud-dist');
  if (!/^\d+m \/ 300m$/.test(hudDist.trim())) throw new Error(`break HUD distance should be "Xm / 300m", got: ${hudDist}`);
  const hudBg = await page.evaluate(() => getComputedStyle(document.querySelector('.hud-left')).backgroundColor);
  if (!hudBg || hudBg === 'rgba(0, 0, 0, 0)' || hudBg === 'transparent') throw new Error(`HUD groups should have a pill backdrop, .hud-left background is ${hudBg}`);
  const hudMidBg = await page.evaluate(() => getComputedStyle(document.querySelector('.hud-mid')).backgroundColor);
  if (!hudMidBg || hudMidBg === 'rgba(0, 0, 0, 0)' || hudMidBg === 'transparent') throw new Error(`HUD groups should have a pill backdrop, .hud-mid background is ${hudMidBg}`);
  const startInfo = await page.evaluate(() => window.__tide.info());
  if (Math.abs(startInfo.speed - 12) > 0.5) throw new Error(`surfer should start at the start speed 12, got ${startInfo.speed}`);
  console.log('render-check: PLAY starts break 1 (First Swell), HUD visible, surfer riding at start speed');

  // The generative music starts with the break.
  const musicActive = await page.evaluate(() => window.__tide.state.musicActive);
  if (!musicActive) throw new Error('music should be active after Play');
  console.log('render-check: generative music active after Play');

  // Carving is asserted in SCREEN space: ArrowLeft must move the
  // surfer LEFT on screen relative to the channel centre. The camera
  // follows the player, so the raw screen x barely moves — the
  // surfer-vs-centre offset is the real screen-space signal.
  // Hold Space (pump) + ArrowLeft (carve) and poll for the offset
  // to swing 20px left.
  const relX0 = await page.evaluate(() => {
    const i = window.__tide.info();
    return i.screen.x - i.centreScreen.x;
  });
  await page.keyboard.down('Space');
  await page.keyboard.down('ArrowLeft');
  try {
    await page.waitForFunction((x0) => {
      const i = window.__tide.info();
      return i && (i.screen.x - i.centreScreen.x) < x0 - 20;
    }, relX0, { timeout: 30000 });
  } finally {
    await page.keyboard.up('ArrowLeft');
  }
  const relX1 = await page.evaluate(() => {
    const i = window.__tide.info();
    return i.screen.x - i.centreScreen.x;
  });
  console.log(`render-check: ArrowLeft carves the surfer left on screen vs the channel centre (offset ${relX0.toFixed(0)} -> ${relX1.toFixed(0)})`);

  // Pumping builds FLOW: hold Space and sample the flow + meter.
  // The pump tick fires on pump direction edges while pumping.
  const ticks0 = await page.evaluate(() => window.__tide.info().pumpTicks);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowLeft');
  }
  const ticks1 = await page.evaluate(() => window.__tide.info().pumpTicks);
  if (ticks1 <= ticks0) throw new Error(`pump edges should fire pump feedback ticks, got ${ticks0} -> ${ticks1}`);
  console.log(`render-check: pump feedback fires on pump edges (ticks ${ticks0} -> ${ticks1})`);
  // Pumping builds FLOW: restart fresh (in the pocket), hold Space
  // with no carve, and sample the flow + meter as it builds. The
  // surfer stays in the pocket for the first ~40m, so the flow climbs
  // fast; sampling the max over 2s catches the build.
  await page.keyboard.up('Space');
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(500);
  const fresh = await page.evaluate(() => window.__tide.info());
  if (fresh.time > 2 || fresh.falls !== 0) throw new Error(`R should restart the break fresh (time ${fresh.time}, falls ${fresh.falls})`);
  await page.keyboard.down('Space');
  let maxFlow = 0;
  for (let i = 0; i < 10; i++) {
    const f = await page.evaluate(() => window.__tide.info().flow);
    maxFlow = Math.max(maxFlow, f);
    await page.waitForTimeout(200);
  }
  if (maxFlow <= 0.15) throw new Error(`flow should build while pumping, max sampled ${maxFlow}`);
  const meterW = await page.evaluate(() => document.getElementById('hud-flow-fill').style.width);
  if (!meterW || parseFloat(meterW) <= 0) throw new Error(`FLOW meter should show energy, fill width is ${meterW}`);
  console.log(`render-check: FLOW meter tracks flow energy (max ${maxFlow.toFixed(2)}, fill ${meterW})`);
  await page.keyboard.up('Space');

  // Shake 0 suppresses trauma: jump while shake is 0, trauma stays 0.
  // (First let leftover trauma from the pumping above settle.)
  await page.evaluate(() => window.__tide.setShake(0));
  await page.waitForFunction(() => window.__tide.info().trauma === 0, null, { timeout: 30000 });
  const jumps0 = await page.evaluate(() => window.__tide.info().jumps);
  await page.evaluate(() => window.__tide.autopilot(true));
  await page.waitForFunction((j0) => window.__tide.info().jumps > j0, jumps0, { timeout: 60000 });
  const trauma0 = await page.evaluate(() => window.__tide.info().trauma);
  if (trauma0 !== 0) throw new Error(`shake 0 should suppress trauma, got ${trauma0}`);
  await page.evaluate(() => window.__tide.setShake(100));
  console.log('render-check: shake 0 suppresses trauma (0 after a jump)');

  // The autopilot (decision bot) clears break 1 in the real browser.
  await page.waitForFunction(() => window.__tide.phase === 'complete', null, { timeout: 180000 });
  const clearInfo = await page.evaluate(() => window.__tide.info());
  console.log(`render-check: autopilot cleared break 1 live (score ${clearInfo.score}, time ${clearInfo.time}s, falls ${clearInfo.falls}, jumps ${clearInfo.jumps}, clean ${clearInfo.cleanLandings})`);
  if (clearInfo.jumps < 4) throw new Error(`autopilot should have jumped every crest (4), got ${clearInfo.jumps}`);
  if (clearInfo.cleanLandings < 4) throw new Error(`autopilot should have landed clean on every crest (4), got ${clearInfo.cleanLandings}`);
  if (!await page.isVisible('#complete')) throw new Error('complete screen not visible after the clear');
  const completeText = await page.textContent('#complete');
  if (!completeText.includes('Break Ridden')) throw new Error('complete screen title wrong');
  console.log('render-check: Break Ridden screen shows with score + rank');

  // Back to the menu, then start break 1 again with NO input: the
  // surfer wipes out and respawns at the checkpoint.
  // The break-1 card shows the rank badge earned by the clear.
  await page.click('#btn-menu-complete');
  await page.waitForFunction(() => window.__tide.phase === 'menu', null, { timeout: 5000 });
  const rankBadge = await page.locator('#break-select .track-card').first().locator('.tc-rank').textContent().catch(() => null);
  if (!rankBadge || !/^[SAB]$/.test(rankBadge.trim())) throw new Error(`break-1 card should show a rank badge after the clear, got: ${rankBadge}`);
  const savedRank = await page.evaluate(() => window.__tide.save.best[1] && window.__tide.save.best[1].rank);
  console.log(`render-check: break-1 card shows rank badge "${rankBadge.trim()}" (saved rank ${savedRank})`);
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__tide.phase === 'playing', null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const i = window.__tide.info();
    return i && i.falls >= 1;
  }, null, { timeout: 60000 });
  const fallInfo = await page.evaluate(() => window.__tide.info());
  console.log(`render-check: no-input surfer wipes out and respawns at the checkpoint (falls ${fallInfo.falls})`);
  // 5 falls lose the break (no input keeps wiping out after every respawn).
  await page.waitForFunction(() => window.__tide.phase === 'gameover', null, { timeout: 120000 });
  if (!await page.isVisible('#gameover')) throw new Error('game-over screen not visible after 5 falls');
  console.log('render-check: 5 falls lose the break — Wiped Out screen shows');

  // Pause focuses Resume; Enter resumes; R restarts.
  await page.click('#btn-retry');
  await page.waitForFunction(() => window.__tide.phase === 'playing', null, { timeout: 5000 });
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => window.__tide.phase === 'paused', null, { timeout: 5000 });
  if (!await page.isVisible('#pause')) throw new Error('pause screen not visible');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (focused !== 'btn-resume') throw new Error(`pause should focus Resume, focused ${focused}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__tide.phase === 'playing', null, { timeout: 5000 });
  console.log('render-check: pause focuses Resume, Enter resumes');
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(500);
  const afterRestart = await page.evaluate(() => window.__tide.info());
  if (afterRestart.time > 2 || afterRestart.falls !== 0) throw new Error(`R should restart the break (time ${afterRestart.time}, falls ${afterRestart.falls})`);
  console.log('render-check: R restarts the break');

  // The canvas must actually update during a run.
  const shotA = await page.screenshot({ timeout: 60000 });
  await page.waitForTimeout(1000);
  const shotB = await page.screenshot({ timeout: 60000 });
  if (shotA.equals(shotB)) throw new Error('canvas did not change between two screenshots during a run — the render loop may be frozen');
  console.log('render-check: canvas updates during a run (two screenshots differ)');

  // Gameplay screenshot for the by-eye check.
  await page.evaluate(() => window.__tide.autopilot(true));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gameplay-1280x720.png'), timeout: 60000 });
  console.log(`render-check: gameplay screenshot saved to ${SHOTS_DIR}/gameplay-1280x720.png — INSPECT BY EYE (3D depth, wave face, HUD)`);
  await page.evaluate(() => window.__tide.autopilot(false));

  // Rest state settles clean (trauma 0, FOV 62, time scale 1, FOV dip 0).
  await page.evaluate(() => window.__tide.quitToMenu());
  await page.waitForTimeout(1500);
  const rest = await page.evaluate(() => window.__tide.info());
  if (rest.trauma !== 0) throw new Error(`rest state trauma should be 0, got ${rest.trauma}`);
  if (Math.abs(rest.fov - 62) > 0.5) throw new Error(`rest state FOV should be 62, got ${rest.fov}`);
  if (rest.timeScale !== 1) throw new Error(`rest state timeScale should be 1, got ${rest.timeScale}`);
  if (rest.fovDip !== 0) throw new Error(`rest state fovDip should be 0, got ${rest.fovDip}`);
  console.log('render-check: rest state clean (trauma 0, FOV 62, timeScale 1, fovDip 0)');

  // ?break=2 reaches break 2 (public unlock/seed path — Apex lesson).
  await page.goto(`http://127.0.0.1:${port}/?break=2`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__tide && window.__tide.phase === 'playing', null, { timeout: 30000 });
  const break2 = await page.evaluate(() => window.__tide.info());
  if (break2.breakId !== 2) throw new Error(`?break=2 should start break 2, got ${break2.breakId}`);
  const break2Name = await page.textContent('#hud-break');
  if (!break2Name.includes('Crosscurrent')) throw new Error(`?break=2 should start Crosscurrent, got: ${break2Name}`);
  console.log('render-check: ?break=2 jumps straight into Crosscurrent (unlock path works)');

  // ?break=3 reaches the last break (Violet Break).
  await page.goto(`http://127.0.0.1:${port}/?break=3`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__tide && window.__tide.phase === 'playing', null, { timeout: 30000 });
  const break3 = await page.evaluate(() => window.__tide.info());
  if (break3.breakId !== 3) throw new Error(`?break=3 should start break 3, got ${break3.breakId}`);
  console.log('render-check: ?break=3 jumps straight into Violet Break (unlock path reaches the last break)');

  // Regression: Try Again after losing a deep-linked LOCKED break.
  // The retry button must restart the break you are already in — the
  // lock gates menu entry only. Also asserts the game-over distance
  // never goes negative and the fall toast is cleared on run end.
  await page.evaluate(() => { window.__tide.run.falls = 4; });
  await page.waitForFunction(() => window.__tide.phase === 'gameover', null, { timeout: 60000 });
  if (!await page.isVisible('#gameover')) throw new Error('game-over screen not visible after the forced loss on break 3');
  const overText = await page.textContent('#gameover-detail');
  if (overText.includes('-1m')) throw new Error(`game-over distance must not go negative, got: ${overText}`);
  const toastHidden = await page.evaluate(() => !document.getElementById('hud-toast').classList.contains('show'));
  if (!toastHidden) throw new Error('fall toast must be cleared when the run ends');
  await page.click('#btn-retry');
  await page.waitForFunction(() => window.__tide.phase === 'playing', null, { timeout: 5000 });
  const retryInfo = await page.evaluate(() => window.__tide.info());
  if (retryInfo.breakId !== 3 || retryInfo.falls !== 0) throw new Error(`Try Again should restart break 3 fresh, got ${JSON.stringify({ id: retryInfo.breakId, falls: retryInfo.falls })}`);
  console.log('render-check: Try Again restarts a deep-linked locked break (retry bypasses the menu lock); game-over distance non-negative, toast cleared');

  // Regression: the endRun setTimeout race. Losing a break schedules
  // endRun ~900ms later; quitting to the menu inside that window must
  // cancel the timer — the game-over panel must not open over the menu.
  await page.evaluate(() => { window.__tide.run.falls = 4; });
  await page.waitForFunction(() => window.__tide.run && window.__tide.run.phase === 'lost', null, { timeout: 60000, polling: 50 });
  const timerPending = await page.evaluate(() => window.__tide.info().endTimerPending);
  if (!timerPending) throw new Error('expected a pending endRun timer right after the loss');
  const toastWasShowing = await page.evaluate(() => document.getElementById('hud-toast').classList.contains('show'));
  if (!toastWasShowing) throw new Error('expected the fall toast to be showing at quit time (test setup)');
  await page.evaluate(() => window.__tide.quitToMenu());
  // The toast must be fully hidden the moment the menu opens, with no wait.
  const toastOpacity = await page.evaluate(() => getComputedStyle(document.getElementById('hud-toast')).opacity);
  if (toastOpacity !== '0') throw new Error(`toast must be fully hidden the moment the menu opens, opacity is ${toastOpacity}`);
  const timerCleared = await page.evaluate(() => window.__tide.info().endTimerPending);
  if (timerCleared) throw new Error('quitToMenu should clear the pending endRun timer');
  await page.waitForTimeout(1500);
  const afterQuit = await page.evaluate(() => window.__tide.info());
  if (afterQuit.phase !== 'menu') throw new Error(`after quitting inside the loss window the phase should be menu, got ${afterQuit.phase}`);
  if (await page.isVisible('#gameover')) throw new Error('game-over panel opened over the menu after quitting inside the loss window');
  console.log('render-check: endRun race fixed — quitting inside the loss window leaves the menu clean (timer cleared, no game-over panel)');

  if (errors.length > 0) {
    console.error('render-check: console/page errors seen:');
    errors.forEach((e) => console.error('  ' + e));
    throw new Error(`${errors.length} console/page error(s) during the check`);
  }
  console.log('render-check: PASS — zero console errors, zero page errors');
} catch (err) {
  console.error('render-check: FAIL —', err.message);
  if (errors.length > 0) errors.forEach((e) => console.error('  ' + e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
