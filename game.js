// Neon Tide v0.1.0 — Three.js renderer + menus + game feel.
// The simulation lives in physics.js (pure, no DOM); this file owns the
// 3D scene, the screen stack, input, Web Audio SFX and the feel tiers.
// The surfer rides down a channel (sim dist -> world -z, sim x -> world
// x, sim airY -> world y above the wave); the camera chases from behind
// and above so the wave face fills the frame and the pocket + next
// crest are always readable.
import * as THREE from 'three';
import {
  VERSION, DT, BREAKS, breakById, createRun, startRun, stepRun,
  decisionPolicy, pocketX, inPocket, inGap, nextCrest, flowEnergy,
  defaultSave, serializeSave, parseSave, recordBest, isBreakUnlocked, rankFor,
  FEEDBACK, FACE_HALF, POCKET_HALF, MAX_FALLS,
} from './physics.js';

const SAVE_KEY = 'neon-tide-save-v1';
const FOV_BASE = 62;

// ---------------------------------------------------------------- save
let save = defaultSave();
try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) save = parseSave(raw);
} catch { /* storage unavailable — play without saving */ }
function persistSave() {
  try { localStorage.setItem(SAVE_KEY, serializeSave(save)); } catch { /* ignore */ }
}
const params = new URLSearchParams(location.search);
if (params.get('unlock') === '1') {
  save.unlocked = BREAKS.length;
  persistSave();
}

// ---------------------------------------------------------------- state
const state = {
  phase: 'menu', // 'menu' | 'playing' | 'paused' | 'complete' | 'gameover'
  breakId: 1,
  run: null,
  demoRun: createRun(BREAKS[0]),
  autopilot: false,
  trauma: 0,
  hitStopT: 0,
  slowMoT: 0,
  timeScale: 1,
  fovPunch: 0,
  fovDip: 0,
  pumpTicks: 0,
  lastCarveSign: 0,
  musicActive: false,
  toastT: 0,
  muted: save.settings.muted,
  shakePct: save.settings.shake,
  flash: save.settings.flash,
  musicOn: true,
  sfxOn: true,
  volume: 0.6,
  textScale: 1,
  highContrast: false,
  endTimer: null, // pending setTimeout(() => endRun(...)) after a win/loss — cleared on quit / new run (race fix)
};
const screenStack = []; // screen ids, top = last

// ---------------------------------------------------------------- audio
let audioCtx = null;
let masterGain = null;
let musicNodes = null;
function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.volume;
    masterGain.connect(audioCtx.destination);
  } catch { audioCtx = null; }
}
function tone(freq, dur, type = 'sine', gain = 0.2, slideTo = null, delay = 0) {
  if (!audioCtx || !masterGain || state.muted || !state.sfxOn) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}
function playSfx(name, energy = 0) {
  if (!audioCtx) return;
  switch (name) {
    case 'launch': tone(300, 0.22, 'sawtooth', 0.14, 900); break;
    // Pump tick: pitch rises with flow energy, so pumping a fast
    // wave sounds brighter than pumping a dead one — the ear learns
    // the flow before the eye does.
    case 'pump': tone(480 + energy * 420, 0.05, 'sine', 0.05 + energy * 0.04, 620 + energy * 420); break;
    case 'land': tone(240, 0.12, 'sine', 0.2, 90); tone(1200, 0.06, 'sine', 0.08); break;
    case 'pickup': tone(1320, 0.1, 'sine', 0.16); tone(1760, 0.14, 'sine', 0.12, null, 0.06); break;
    case 'wipeout': tone(170, 0.35, 'sawtooth', 0.2, 55); break;
    case 'finish':
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, 'sine', 0.16, null, i * 0.09));
      break;
    case 'denied': tone(140, 0.08, 'square', 0.1); break;
    case 'tick': tone(1200, 0.03, 'sine', 0.06); break;
    case 'checkpoint': tone(784, 0.12, 'sine', 0.14); tone(1046, 0.18, 'sine', 0.12, null, 0.08); break;
    default: break;
  }
}
// Generative music: a low pad (Am–F–C–G, one chord per bar) plus a
// bass pulse and a soft arpeggio, sequenced from the frame loop with a
// short lookahead. The arpeggio lifts an octave as the surfer gains
// speed, so the music rides with you. Everything is scheduled through
// the audio clock — no timers to drift — and every note is guarded:
// with no AudioContext (or while muted) the scheduler simply does nothing.
const MUSIC_BPM = 104;
const MUSIC_STEP = 60 / MUSIC_BPM / 2; // 8th notes
const MUSIC_CHORDS = [
  { root: 110.00, tones: [220.00, 261.63, 329.63] }, // Am
  { root: 87.31, tones: [174.61, 220.00, 261.63] }, // F
  { root: 130.81, tones: [196.00, 261.63, 329.63] }, // C
  { root: 98.00, tones: [196.00, 246.94, 293.66] }, // G
];
let musicStep = 0;
let musicNextTime = 0;
function scheduleMusic() {
  if (!audioCtx || !masterGain || state.muted || !state.musicOn || !state.musicActive) return;
  const ahead = audioCtx.currentTime + 0.25;
  if (musicNextTime < audioCtx.currentTime) musicNextTime = audioCtx.currentTime + 0.05;
  const run = state.run || state.demoRun;
  const speed01 = run ? Math.min(1, Math.max(0, (run.speed - 5) / 19)) : 0;
  while (musicNextTime < ahead) {
    const bar = Math.floor(musicStep / 8) % MUSIC_CHORDS.length;
    const chord = MUSIC_CHORDS[bar];
    const stepInBar = musicStep % 8;
    const t0 = musicNextTime;
    if (stepInBar === 0) {
      // Bass root, one per bar.
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = chord.root;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + MUSIC_STEP * 7);
      osc.connect(g).connect(masterGain);
      osc.start(t0);
      osc.stop(t0 + MUSIC_STEP * 7 + 0.05);
    }
    // Arpeggio: chord tones cycling, lifting an octave at high speed.
    const toneF = chord.tones[stepInBar % chord.tones.length] * (speed01 > 0.6 ? 2 : 1);
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = toneF;
    const vol = 0.05 + speed01 * 0.05;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + MUSIC_STEP * 0.9);
    osc.connect(g).connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + MUSIC_STEP + 0.05);
    musicStep++;
    musicNextTime += MUSIC_STEP;
  }
}
function startMusic() {
  ensureAudio();
  if (!audioCtx) return;
  state.musicActive = true;
  musicStep = 0;
  musicNextTime = audioCtx.currentTime + 0.05;
}
function stopMusic() {
  state.musicActive = false;
}

// ---------------------------------------------------------------- dom
const $ = (id) => document.getElementById(id);
const isTouch = () => 'ontouchstart' in window || (window.matchMedia && matchMedia('(pointer: coarse)').matches);

// ---------------------------------------------------------------- three
let renderer = null;
let webglOK = true;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch {
  webglOK = false;
}
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050514);
scene.fog = new THREE.Fog(0x050514, 40, 220);
const camera = new THREE.PerspectiveCamera(FOV_BASE, window.innerWidth / window.innerHeight, 0.1, 500);
let dprCap = 2;
let particleScale = 1;
let fpsEma = 60;
let fpsLowT = 0;
if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  $('game-container').appendChild(renderer.domElement);
}
scene.add(new THREE.HemisphereLight(0x8f7bff, 0x0a0a24, 0.9));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
dirLight.position.set(8, 20, 12);
scene.add(dirLight);
const pocketLight = new THREE.PointLight(0x22e6ff, 1.4, 30);
scene.add(pocketLight);

// Stars.
{
  const n = 600;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 500;
    pos[i * 3 + 1] = 20 + Math.random() * 160;
    pos[i * 3 + 2] = -Math.random() * 500 - 20;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaac4ff, size: 0.9, sizeAttenuation: false }));
  scene.add(stars);
}
// No horizon slab: an earlier version drew a wide dark plane far
// down the channel and it read as a glitch rectangle, not a glow.
// The fog + stars + gradient wave carry the horizon on their own.

// ---------------------------------------------------------------- wave
// The wave face: a long ribbon down the channel. Sim dist -> world -z,
// sim x -> world x. The swell is a rolling sine plus a ridge that
// follows the pocket, so the fast water is a visible crest line.
// Vertex colours run cyan -> magenta across the face and darken inside
// the closeout gaps, so every crest gap reads at a glance.
let waveMesh = null;
let waveBase = null; // Float32Array of base positions (x, z per vertex)
let waveGeo = null;
let pocketBand = null;
let pocketBandBase = null;
let pickupMeshes = [];
let gapMarkers = [];
let currentBreak = null;

function waveSwell(x, dist, t) {
  const edge = Math.max(0, 1 - (x * x) / (FACE_HALF * FACE_HALF * 2.2));
  const roll = 0.55 * Math.sin(dist * 0.09 - t * 1.6) * edge;
  const p = pocketX(currentBreak, dist);
  const ridge = 1.3 * Math.exp(-((x - p) * (x - p)) / 9) * edge;
  return roll + ridge;
}

function buildBreakScene(brk) {
  currentBreak = brk;
  if (waveMesh) {
    scene.remove(waveMesh);
    waveGeo.dispose();
    waveMesh.material.dispose();
    waveMesh = null;
  }
  if (pocketBand) {
    scene.remove(pocketBand);
    pocketBand.geometry.dispose();
    pocketBand.material.dispose();
    pocketBand = null;
  }
  for (const m of pickupMeshes) scene.remove(m);
  pickupMeshes = [];
  for (const m of gapMarkers) scene.remove(m);
  gapMarkers = [];

  const len = brk.length;
  const W = 48;
  const H = len + 60;
  waveGeo = new THREE.PlaneGeometry(W, H, 40, 140);
  waveGeo.rotateX(-Math.PI / 2);
  waveGeo.translate(0, 0, 10 - len / 2);
  const posAttr = waveGeo.attributes.position;
  waveBase = new Float32Array(posAttr.array);
  // Vertex colours: cyan -> magenta across the face, dark in the gaps.
  const colors = new Float32Array(posAttr.count * 3);
  const cA = new THREE.Color(0x22e6ff);
  const cB = new THREE.Color(0xff3df0);
  const cDark = new THREE.Color(0x0a0a22);
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const dist = -posAttr.getZ(i);
    const t = (x + W / 2) / W;
    const col = cA.clone().lerp(cB, t);
    if (inGap(brk, dist)) col.lerp(cDark, 0.75);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  waveGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const waveMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
  });
  waveMesh = new THREE.Mesh(waveGeo, waveMat);
  scene.add(waveMesh);

  // Pocket band: a glowing ribbon that tracks the pocket line.
  const bandSegs = Math.floor(len / 4) + 1;
  const bandGeo = new THREE.BufferGeometry();
  const bandPos = new Float32Array(bandSegs * 2 * 3);
  const bandIdx = [];
  for (let i = 0; i < bandSegs; i++) {
    const d = i * 4;
    const p = pocketX(brk, d);
    bandPos[i * 6] = p - POCKET_HALF;
    bandPos[i * 6 + 1] = 0;
    bandPos[i * 6 + 2] = -d;
    bandPos[i * 6 + 3] = p + POCKET_HALF;
    bandPos[i * 6 + 4] = 0;
    bandPos[i * 6 + 5] = -d;
    if (i < bandSegs - 1) {
      const a = i * 2;
      bandIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  bandGeo.setAttribute('position', new THREE.BufferAttribute(bandPos, 3));
  bandGeo.setIndex(bandIdx);
  pocketBandBase = new Float32Array(bandPos);
  pocketBand = new THREE.Mesh(bandGeo, new THREE.MeshBasicMaterial({
    color: 0x22e6ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false,
  }));
  scene.add(pocketBand);

  // Gap markers: magenta chevrons at each crest gap edge.
  const coneGeo = new THREE.ConeGeometry(0.7, 2.2, 4);
  const coneMat = new THREE.MeshBasicMaterial({ color: 0xff3df0 });
  for (const c of brk.crests) {
    for (const side of [-1, 1]) {
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(side * (FACE_HALF - 2), 2.4, -c - brk.gapWidth / 2);
      cone.rotation.x = Math.PI;
      scene.add(cone);
      gapMarkers.push(cone);
    }
  }

  // Pickups: gold rings along the good line.
  const ringGeo = new THREE.TorusGeometry(0.9, 0.18, 8, 20);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xffd75e, emissive: 0xffb52e, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.6,
  });
  for (const p of brk.pickups) {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(p.x, 2.2, -p.dist);
    scene.add(ring);
    pickupMeshes.push(ring);
  }
}

// Surfer: board + rider, neon.
const surfer = new THREE.Group();
{
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.12, 0.75),
    new THREE.MeshStandardMaterial({ color: 0x22e6ff, emissive: 0x22e6ff, emissiveIntensity: 0.9, roughness: 0.3 }),
  );
  board.position.y = 0.1;
  surfer.add(board);
  const rider = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.3, 1.1, 10),
    new THREE.MeshStandardMaterial({ color: 0xff3df0, emissive: 0xb01a8f, emissiveIntensity: 0.7, roughness: 0.4 }),
  );
  rider.position.y = 0.75;
  surfer.add(rider);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xffd75e, emissive: 0xffb52e, emissiveIntensity: 0.9, roughness: 0.3 }),
  );
  head.position.y = 1.5;
  surfer.add(head);
}
scene.add(surfer);

// Pooled spray particles (one Points cloud, dead particles parked far away).
const PARTICLE_N = 300;
const particleGeo = new THREE.BufferGeometry();
const particlePos = new Float32Array(PARTICLE_N * 3);
const particleVel = new Float32Array(PARTICLE_N * 3);
const particleLife = new Float32Array(PARTICLE_N);
for (let i = 0; i < PARTICLE_N; i++) particlePos[i * 3 + 1] = -999;
particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
const particles = new THREE.Points(particleGeo, new THREE.PointsMaterial({
  color: 0x9beaff, size: 0.35, transparent: true, opacity: 0.9, depthWrite: false,
}));
scene.add(particles);
let particleCursor = 0;
function spawnParticles(x, y, z, n, spread = 3, up = 4) {
  const count = Math.max(1, Math.round(n * particleScale));
  for (let k = 0; k < count; k++) {
    const i = particleCursor;
    particleCursor = (particleCursor + 1) % PARTICLE_N;
    particlePos[i * 3] = x + (Math.random() - 0.5) * 1.2;
    particlePos[i * 3 + 1] = y + Math.random() * 0.5;
    particlePos[i * 3 + 2] = z + (Math.random() - 0.5) * 1.2;
    particleVel[i * 3] = (Math.random() - 0.5) * spread;
    particleVel[i * 3 + 1] = Math.random() * up + 1;
    particleVel[i * 3 + 2] = (Math.random() - 0.5) * spread;
    particleLife[i] = 0.5 + Math.random() * 0.5;
  }
  particleGeo.attributes.position.needsUpdate = true;
}
function updateParticles(dt) {
  for (let i = 0; i < PARTICLE_N; i++) {
    if (particleLife[i] <= 0) continue;
    particleLife[i] -= dt;
    if (particleLife[i] <= 0) {
      particlePos[i * 3 + 1] = -999;
      continue;
    }
    particleVel[i * 3 + 1] -= 9 * dt;
    particlePos[i * 3] += particleVel[i * 3] * dt;
    particlePos[i * 3 + 1] += particleVel[i * 3 + 1] * dt;
    particlePos[i * 3 + 2] += particleVel[i * 3 + 2] * dt;
  }
  particleGeo.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------- feel
function addTrauma(amount) {
  state.trauma = Math.min(1, state.trauma + amount * (state.shakePct / 100));
}
function hitStop(dur) {
  state.hitStopT = Math.max(state.hitStopT, dur);
}
function feedback(event, energy = 0) {
  const fb = FEEDBACK[event];
  if (!fb) return;
  addTrauma(fb.trauma);
  if (fb.hitStop) hitStop(fb.hitStop);
  if (fb.flash && state.flash) flashScreen(fb.flash);
  playSfx(fb.sfx, energy);
}
function flashScreen(strength) {
  const el = $('hit-flash');
  el.style.opacity = String(strength);
  setTimeout(() => { el.style.opacity = '0'; }, 90);
}
function scorePop(text, x, y) {
  const pops = $('pops');
  const el = document.createElement('div');
  el.className = 'pop';
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  pops.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
function toast(msg, seconds = 2.5) {
  const el = $('hud-toast');
  el.textContent = msg;
  el.style.opacity = '';
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  state.toastT = seconds;
  $('sr-status').textContent = msg;
}
function hideToast() {
  const el = $('hud-toast');
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
  // Hide instantly (no 200ms CSS fade): a toast fading over the menu
  // after quit is a real bug, not a timing caveat (Talon lesson).
  el.style.transition = 'none';
  el.style.opacity = '0';
  requestAnimationFrame(() => { el.style.transition = ''; });
  state.toastT = 0;
}

// ---------------------------------------------------------------- input
const input = {
  carveKeys: 0, // -1 | 0 | 1 from held keys
  left: false,
  right: false,
  pump: false, // Space / mouse / touch SURF held
  mouseCarve: 0,
  touchCarve: 0,
};
function recomputeCarve() {
  let c = 0;
  if (input.left) c -= 1;
  if (input.right) c += 1;
  if (input.mouseCarve !== 0) c = input.mouseCarve;
  if (input.touchCarve !== 0) c = input.touchCarve;
  input.carveKeys = c;
}
function currentInput() {
  return { pump: input.pump, carve: input.carveKeys };
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  ensureAudio();
  switch (e.code) {
    case 'ArrowLeft':
    case 'KeyA': input.left = true; recomputeCarve(); e.preventDefault(); break;
    case 'ArrowRight':
    case 'KeyD': input.right = true; recomputeCarve(); e.preventDefault(); break;
    case 'Space': input.pump = true; e.preventDefault(); break;
    case 'KeyP': togglePause(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyR': if (state.phase === 'playing') restartBreak(); break;
    case 'Escape': closeTopScreen(); break;
    case 'Enter': confirmFocused(); break;
    default: break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'ArrowLeft':
    case 'KeyA': input.left = false; recomputeCarve(); break;
    case 'ArrowRight':
    case 'KeyD': input.right = false; recomputeCarve(); break;
    case 'Space': input.pump = false; break;
    default: break;
  }
});
window.addEventListener('blur', () => {
  input.left = false; input.right = false; input.pump = false; input.mouseCarve = 0; recomputeCarve();
});
let lastMouseX = null;
renderer.domElement.addEventListener('mousedown', (e) => {
  ensureAudio();
  input.pump = true;
  lastMouseX = e.clientX;
});
window.addEventListener('mouseup', () => { input.pump = false; input.mouseCarve = 0; lastMouseX = null; recomputeCarve(); });
window.addEventListener('mousemove', (e) => {
  if (lastMouseX === null) return;
  const dx = e.clientX - lastMouseX;
  input.mouseCarve = dx > 12 ? 1 : dx < -12 ? -1 : 0;
  recomputeCarve();
});
function bindTouchButton(id, down, up) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); down(); });
  el.addEventListener('pointerup', (e) => { e.preventDefault(); up(); });
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
}
bindTouchButton('btn-surf', () => { input.pump = true; }, () => { input.pump = false; });
bindTouchButton('btn-carve-left', () => { input.touchCarve = -1; recomputeCarve(); }, () => { input.touchCarve = 0; recomputeCarve(); });
bindTouchButton('btn-carve-right', () => { input.touchCarve = 1; recomputeCarve(); }, () => { input.touchCarve = 0; recomputeCarve(); });

// ---------------------------------------------------------------- screens
function showOnly(id) {
  for (const el of document.querySelectorAll('.overlay')) el.classList.add('hidden');
  if (id) {
    const el = $(id);
    el.classList.remove('hidden');
    const focusable = el.querySelector('button:not([disabled]), input, select');
    if (focusable) focusable.focus();
  }
}
function pushScreen(id) {
  screenStack.push(id);
  showOnly(id);
}
function popScreen() {
  screenStack.pop();
  showOnly(screenStack.length ? screenStack[screenStack.length - 1] : null);
}
function closeTopScreen() {
  if (state.phase === 'playing') { togglePause(); return; }
  if (screenStack.length > 1) popScreen();
}
function confirmFocused() {
  const el = document.activeElement;
  if (el && el.tagName === 'BUTTON') el.click();
}
function hoverFeedback(el) {
  el.addEventListener('mouseenter', () => { playSfx('tick'); });
}
document.querySelectorAll('button').forEach((b) => hoverFeedback(b));

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function buildBreakCards() {
  const wrap = $('break-select');
  wrap.innerHTML = '';
  for (const b of BREAKS) {
    const best = save.best[b.id];
    const locked = !isBreakUnlocked(save, b.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-card' + (b.id === state.breakId ? ' selected' : '');
    btn.disabled = locked;
    btn.innerHTML = `<span class="tc-name">${b.id}. ${b.name}</span>`
      + `<span class="tc-meta">${b.length}m · par ${b.par}s</span>`
      + (best ? `<span class="tc-best">Best ${best.score}</span>${best.rank ? ` <span class="tc-rank rank-${best.rank}">${best.rank}</span>` : ''}` : '<span class="tc-best">Not ridden yet</span>')
      + (locked ? '<span class="tc-meta">Locked — clear the previous break</span>' : '');
    btn.addEventListener('click', () => {
      ensureAudio();
      state.breakId = b.id;
      buildBreakCards();
      updateMenuText();
    });
    wrap.appendChild(btn);
  }
}
function updateMenuText() {
  const b = breakById(state.breakId);
  const best = save.best[b.id];
  $('menu-best').textContent = best
    ? `Best on ${b.name}: ${best.score} pts in ${fmtTime(best.time)}`
    : `Break ${b.id} of ${BREAKS.length} — ${b.name}, ${b.length}m.`;
  $('menu-hint').textContent = b.hint;
  $('break-hint').textContent = `Clear ${b.name} to unlock break ${Math.min(b.id + 1, BREAKS.length)}.`;
}
function updateMuteButtons() {
  const label = state.muted ? 'Sound: Off' : 'Sound: On';
  for (const id of ['btn-mute-hud', 'btn-mute-menu', 'btn-mute-pause']) {
    const el = $(id);
    if (el) el.textContent = label;
  }
}
function toggleMute() {
  state.muted = !state.muted;
  save.settings.muted = state.muted;
  persistSave();
  if (masterGain) masterGain.gain.value = state.muted ? 0 : state.volume;
  updateMuteButtons();
}
function showMenu() {
  state.phase = 'menu';
  state.run = null;
  state.autopilot = false;
  screenStack.length = 0;
  screenStack.push('menu');
  showOnly('menu');
  $('hud').classList.add('hidden');
  $('touch-controls').classList.add('hidden');
  hideToast();
  buildBreakCards();
  updateMenuText();
  updateMuteButtons();
  stopMusic();
}

// ---------------------------------------------------------------- run flow
function startBreak(id, unlockedOverride = false) {
  const brk = breakById(id);
  if (!brk) return;
  if (!unlockedOverride && !isBreakUnlocked(save, id)) {
    toast('That break is locked — clear the previous break first.');
    playSfx('denied');
    return;
  }
  if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
  state.breakId = id;
  buildBreakScene(brk);
  state.run = startRun(id);
  state.phase = 'playing';
  state.autopilot = false;
  state.trauma = 0;
  state.hitStopT = 0;
  state.slowMoT = 0;
  state.timeScale = 1;
  state.pumpTicks = 0;
  state.lastCarveSign = 0;
  screenStack.length = 0;
  showOnly(null);
  $('hud').classList.remove('hidden');
  if (isTouch()) $('touch-controls').classList.remove('hidden');
  hideToast();
  const best = save.best[id];
  $('hud-best').textContent = best ? `Best ${best.score}` : 'Best —';
  $('hud-break').textContent = `Break ${id} — ${brk.name}`;
  toast(`${brk.name} — ${brk.hint}`, 3.5);
  ensureAudio();
  startMusic();
  updateMuteButtons();
}
function restartBreak() {
  startBreak(state.breakId, true);
}
function endRun(won) {
  if (!state.run) return;
  const run = state.run;
  const brk = run.brk;
  const result = {
    won,
    score: run.score,
    time: run.time,
    falls: run.falls,
    pickups: run.pickups,
    par: brk.par,
  };
  recordBest(save, brk.id, result);
  persistSave();
  state.phase = won ? 'complete' : 'gameover';
  $('hud').classList.add('hidden');
  $('touch-controls').classList.add('hidden');
  hideToast();
  if (won) {
    state.slowMoT = 0.7;
    feedback('finish');
    $('complete-score').textContent = `Score ${run.score}`;
    $('complete-detail').textContent = `${brk.name} ridden in ${fmtTime(run.time)} · ${run.cleanLandings} clean landings · ${run.jumps} jumps · ${run.falls} falls`;
    const best = save.best[brk.id];
    $('complete-best').textContent = best ? `Best: ${best.score} pts` : '';
    $('complete-rank').textContent = best && best.rank ? `Rank: ${best.rank}` : '';
    $('complete-pickups').textContent = `Pickups ${run.pickups}/${brk.pickups.length}`;
    pushScreen('complete');
  } else {
    feedback('wipeout');
    $('gameover-detail').textContent = `Wiped out ${run.falls} times on ${brk.name} — rode ${Math.floor(run.maxDist)}m of ${brk.length}m.`;
    const best = save.best[brk.id];
    $('gameover-best').textContent = best ? `Best: ${best.score} pts` : '';
    pushScreen('gameover');
  }
  stopMusic();
}
function quitToMenu() {
  if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
  input.pump = false;
  input.left = false;
  input.right = false;
  input.mouseCarve = 0;
  input.touchCarve = 0;
  recomputeCarve();
  showMenu();
}
function pauseGame() {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  pushScreen('pause');
}
function resumeGame() {
  if (state.phase !== 'paused') return;
  popScreen();
  state.phase = 'playing';
}
function togglePause() {
  if (state.phase === 'playing') pauseGame();
  else if (state.phase === 'paused') resumeGame();
}

// Menu buttons.
$('btn-play').addEventListener('click', () => { ensureAudio(); startBreak(state.breakId); });
$('btn-howto').addEventListener('click', () => pushScreen('howto'));
$('btn-howto-close').addEventListener('click', () => popScreen());
$('btn-settings').addEventListener('click', () => pushScreen('settings'));
$('btn-settings-close').addEventListener('click', () => popScreen());
$('btn-mute-menu').addEventListener('click', toggleMute);
$('btn-mute-hud').addEventListener('click', toggleMute);
$('btn-mute-pause').addEventListener('click', toggleMute);
$('btn-pause').addEventListener('click', () => togglePause());
$('btn-resume').addEventListener('click', () => resumeGame());
$('btn-restart').addEventListener('click', () => { popScreen(); restartBreak(); });
$('btn-quit').addEventListener('click', () => quitToMenu());
$('btn-next').addEventListener('click', () => {
  const nextId = Math.min(state.breakId + 1, BREAKS.length);
  startBreak(nextId, true);
});
$('btn-replay').addEventListener('click', () => restartBreak());
$('btn-menu-complete').addEventListener('click', () => quitToMenu());
$('btn-retry').addEventListener('click', () => restartBreak());
$('btn-menu-over').addEventListener('click', () => quitToMenu());

// Settings controls.
$('volume-range').addEventListener('input', (e) => {
  state.volume = Number(e.target.value) / 100;
  $('volume-value').textContent = `${e.target.value}%`;
  if (masterGain) masterGain.gain.value = state.muted ? 0 : state.volume;
});
$('shake-range').addEventListener('input', (e) => {
  state.shakePct = Number(e.target.value);
  $('shake-value').textContent = `${e.target.value}%`;
  save.settings.shake = state.shakePct;
  persistSave();
});
$('shake-range-pause').addEventListener('input', (e) => {
  state.shakePct = Number(e.target.value);
  $('shake-value-pause').textContent = `${e.target.value}%`;
  $('shake-value').textContent = `${e.target.value}%`;
  $('shake-range').value = e.target.value;
  save.settings.shake = state.shakePct;
  persistSave();
});
$('music-toggle').addEventListener('change', (e) => { state.musicOn = e.target.checked; });
$('sfx-toggle').addEventListener('change', (e) => { state.sfxOn = e.target.checked; });
$('reduce-flashing').addEventListener('change', (e) => {
  state.flash = !e.target.checked;
  save.settings.flash = state.flash;
  persistSave();
});
$('text-size-select').addEventListener('change', (e) => {
  state.textScale = Number(e.target.value);
  document.documentElement.style.fontSize = `${16 * state.textScale}px`;
});
$('high-contrast-toggle').addEventListener('change', (e) => {
  state.highContrast = e.target.checked;
  document.body.classList.toggle('high-contrast', state.highContrast);
});
// Restore saved settings into the controls.
$('shake-range').value = String(state.shakePct);
$('shake-value').textContent = `${state.shakePct}%`;
$('shake-range-pause').value = String(state.shakePct);
$('shake-value-pause').textContent = `${state.shakePct}%`;
if (!state.flash) $('reduce-flashing').checked = true;

// ---------------------------------------------------------------- camera + render
function waveYAt(x, dist, t) {
  if (!currentBreak) return 0;
  return waveSwell(x, dist, t);
}
function updateWave(t) {
  if (!waveMesh) return;
  const posAttr = waveGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const x = waveBase[i * 3];
    const z = waveBase[i * 3 + 2];
    posAttr.setY(i, waveSwell(x, -z, t));
  }
  posAttr.needsUpdate = true;
  // No computeVertexNormals: the wave is a flat neon surface
  // (MeshBasicMaterial), so per-frame normals would only burn CPU.
  if (pocketBand) {
    const bandAttr = pocketBand.geometry.attributes.position;
    for (let i = 0; i < bandAttr.count; i++) {
      const x = pocketBandBase[i * 3];
      const z = pocketBandBase[i * 3 + 2];
      bandAttr.setY(i, waveSwell(x, -z, t) + 0.15);
    }
    bandAttr.needsUpdate = true;
    pocketBand.material.opacity = 0.24 + 0.1 * Math.sin(t * 2.2);
  }
}
function worldToScreen(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, behind: v.z > 1 };
}

let lastT = performance.now();
let simAcc = 0;
let elapsed = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  elapsed += rawDt;

  // FPS guard: rolling average; under 28fps for 2s steps the render
  // scale down one rung (DPR 2 -> 1.5 -> 1) and thins particles.
  fpsEma = fpsEma * 0.95 + (rawDt > 0 ? 1 / rawDt : 60) * 0.05;
  if (fpsEma < 28) {
    fpsLowT += rawDt;
    if (fpsLowT > 2) { stepFpsGuard(); fpsLowT = 0; }
  } else {
    fpsLowT = 0;
  }

  // Hit-stop freezes the sim in real time; slow-mo stretches it.
  if (state.hitStopT > 0) {
    state.hitStopT -= rawDt;
    state.timeScale = 0;
  } else if (state.slowMoT > 0) {
    state.slowMoT -= rawDt;
    state.timeScale = 0.35;
  } else {
    state.timeScale = 1;
  }
  state.trauma = Math.max(0, state.trauma - rawDt * 1.6);

  const activeRun = state.phase === 'menu' ? state.demoRun : state.run;
  const dt = rawDt * state.timeScale;

  if (activeRun && (state.phase === 'playing' || state.phase === 'menu')) {
    simAcc += dt;
    let guard = 0;
    while (simAcc >= DT && guard < 5) {
      simAcc -= DT;
      guard++;
      const inp = state.phase === 'menu'
        ? decisionPolicy(activeRun)
        : state.autopilot ? decisionPolicy(activeRun) : currentInput();
      const before = {
        falls: activeRun.falls,
        jumps: activeRun.jumps,
        clean: activeRun.cleanLandings,
        pickups: activeRun.pickups,
        checkpoint: activeRun.lastCheckpoint,
        airborne: activeRun.airborne,
        phase: activeRun.phase,
      };
      stepRun(activeRun, inp);
      // Feedback on transitions, read from the sim (never from the DOM).
      if (state.phase === 'playing') {
        if (activeRun.jumps > before.jumps) {
          feedback('launch');
          state.fovPunch = 0.5;
          const s = worldToScreen(activeRun.x, 2 + activeRun.airY, -activeRun.dist);
          spawnParticles(activeRun.x, 1, -activeRun.dist, FEEDBACK.launch.particles, 4, 6);
          scorePop('AIR!', s.x, s.y);
        }
        if (activeRun.cleanLandings > before.clean) {
          feedback('land');
          const s = worldToScreen(activeRun.x, 1, -activeRun.dist);
          spawnParticles(activeRun.x, 0.5, -activeRun.dist, FEEDBACK.land.particles, 5, 3);
          if (activeRun.combo > 1) scorePop(`COMBO x${activeRun.combo}`, s.x, s.y - 24);
        }
        if (activeRun.pickups > before.pickups) {
          feedback('pickup');
          spawnParticles(activeRun.x, 2, -activeRun.dist, FEEDBACK.pickup.particles, 2, 3);
        }
        if (activeRun.falls > before.falls) {
          feedback('wipeout');
          spawnParticles(activeRun.x, 1, -activeRun.dist, FEEDBACK.wipeout.particles, 6, 5);
          toast(activeRun.falls >= MAX_FALLS ? 'Wiped out — run over' : `Wipeout ${activeRun.falls}/${MAX_FALLS} — back to the checkpoint`);
        }
        if (activeRun.lastCheckpoint > before.checkpoint) {
          playSfx('checkpoint');
          toast('Checkpoint');
        }
        // Pump tick: on each carve-direction edge while pumping with
        // real flow — pitch rises with flow, so pumping a fast wave
        // sounds brighter than pumping a dead one. The tick marks the
        // player's input edge, not the velocity sign: at low frame
        // rates the velocity takes a while to reverse, but the
        // decision is the edge itself.
        if (inp.pump && activeRun.flow > 0.05 && inp.carve !== 0) {
          if (state.lastCarveSign !== 0 && inp.carve !== state.lastCarveSign) {
            state.pumpTicks++;
            playSfx('pump', activeRun.flow);
            spawnParticles(activeRun.x, 0.4, -activeRun.dist, FEEDBACK.pump.particles, 2, 2);
          }
          state.lastCarveSign = inp.carve;
        }
        if (activeRun.phase !== before.phase) {
          if (activeRun.phase === 'won' || activeRun.phase === 'lost') {
            if (!state.endTimer) {
              state.endTimer = setTimeout(() => {
                state.endTimer = null;
                endRun(activeRun.phase === 'won');
              }, activeRun.phase === 'won' ? 700 : 900);
            }
          }
        }
      }
      // Menu demo: reset the demo run when it wins or loses so the
      // attract scene never stops moving.
      if (state.phase === 'menu' && activeRun.phase !== 'riding') {
        state.demoRun = createRun(BREAKS[0]);
      }
    }
    if (guard >= 5) simAcc = 0;
  }

  // HUD.
  if (state.phase === 'playing' && state.run) {
    const run = state.run;
    $('hud-time').textContent = fmtTime(run.time);
    $('hud-dist').textContent = `${Math.floor(run.maxDist)}m / ${run.brk.length}m`;
    $('hud-score').textContent = `Score ${run.score}`;
    $('hud-pickups').textContent = `Pickups ${run.pickups}/${run.brk.pickups.length}`;
    $('hud-falls').textContent = `Falls ${run.falls}`;
    const fill = $('hud-flow-fill');
    fill.style.width = `${Math.round(flowEnergy(run) * 100)}%`;
    fill.classList.toggle('hot', flowEnergy(run) > 0.7);
    if (state.toastT > 0) {
      state.toastT -= rawDt;
      if (state.toastT <= 0) hideToast();
    }
  }
  // Settings performance readout.
  if (!$('settings').classList.contains('hidden')) {
    $('perf-line').textContent = `Performance: ${Math.round(fpsEma)} fps · render scale ${renderer.getPixelRatio().toFixed(1)}×`;
  }

  // Scene: wave + pocket band + pickups + surfer + camera.
  if (renderer && currentBreak) {
    updateWave(elapsed);
    const run = activeRun;
    const t = elapsed;
    for (let i = 0; i < pickupMeshes.length; i++) {
      const mesh = pickupMeshes[i];
      mesh.rotation.y = t * 1.5 + i;
      mesh.visible = run ? !run.pickupsCollected[i] : true;
      mesh.position.y = 2.2 + Math.sin(t * 2 + i) * 0.25;
    }
    for (const cone of gapMarkers) {
      cone.position.y = 2.4 + Math.sin(t * 3 + cone.position.z) * 0.2;
    }
    if (run) {
      const y = waveYAt(run.x, run.dist, t) + run.airY;
      surfer.position.set(run.x, y + 0.15, -run.dist);
      surfer.rotation.z = -run.vx * 0.045;
      surfer.rotation.x = run.airborne ? -run.airVy * 0.02 : 0.08;
      const crouch = (state.phase === 'playing' && currentInput().pump) ? 0.82 : 1;
      surfer.scale.y += (crouch - surfer.scale.y) * 0.2;
      surfer.visible = true;
      pocketLight.position.set(run.x, 3, -run.dist);
      // Camera: chase behind and above, looking down the channel.
      const shake = state.trauma * state.trauma * (state.shakePct / 100);
      const shX = (Math.random() - 0.5) * shake * 1.2;
      const shY = (Math.random() - 0.5) * shake * 1.2;
      camera.position.set(
        run.x * 0.85 + shX,
        6.5 + run.airY * 0.45 + shY,
        -run.dist + 11,
      );
      camera.lookAt(run.x * 0.9, 1.2 + run.airY * 0.55, -run.dist - 14);
      const targetFov = FOV_BASE + state.fovPunch * 6 - state.fovDip * 4;
      state.fovPunch = Math.max(0, state.fovPunch - rawDt * 2);
      state.fovDip = Math.max(0, state.fovDip - rawDt * 2);
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
    }
    updateParticles(rawDt);
    scheduleMusic();
    renderer.render(scene, camera);
  }
}
function stepFpsGuard() {
  if (dprCap > 1.5) dprCap = 1.5;
  else if (dprCap > 1) dprCap = 1;
  else return dprCap;
  particleScale = dprCap === 1.5 ? 0.6 : 0.35;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  return dprCap;
}

window.addEventListener('resize', () => {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
});
window.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (state.phase === 'playing') pauseGame();
});
window.addEventListener('webglcontextrestored', () => { /* renderer recovers on next frame */ });

// ---------------------------------------------------------------- test hooks
function info() {
  const run = state.phase === 'menu' ? state.demoRun : state.run;
  return {
    phase: state.phase,
    version: VERSION,
    breakId: state.breakId,
    dist: run ? +run.dist.toFixed(2) : null,
    x: run ? +run.x.toFixed(2) : null,
    speed: run ? +run.speed.toFixed(2) : null,
    flow: run ? +flowEnergy(run).toFixed(3) : 0,
    airborne: run ? run.airborne : false,
    airY: run ? +run.airY.toFixed(2) : 0,
    pumpTicks: state.pumpTicks,
    fovDip: +state.fovDip.toFixed(3),
    musicActive: state.musicActive,
    nextCrest: run ? nextCrest(run.brk, run.dist) : null,
    jumps: run ? run.jumps : 0,
    cleanLandings: run ? run.cleanLandings : 0,
    runPhase: run ? run.phase : null,
    screen: run ? worldToScreen(run.x, waveYAt(run.x, run.dist, elapsed) + run.airY, -run.dist) : null,
    centreScreen: run ? worldToScreen(0, waveYAt(0, run.dist, elapsed), -run.dist) : null,
    score: run ? run.score : 0,
    maxDist: run ? +run.maxDist.toFixed(1) : 0,
    falls: run ? run.falls : 0,
    pickups: run ? run.pickups : 0,
    time: run ? +run.time.toFixed(2) : 0,
    trauma: +state.trauma.toFixed(3),
    timeScale: state.timeScale,
    fov: +camera.fov.toFixed(1),
    autopilot: state.autopilot,
    unlocked: save.unlocked,
    endTimerPending: state.endTimer !== null,
    fps: Math.round(fpsEma),
    fpsGuard: {
      dprCap,
      pixelRatio: renderer ? +renderer.getPixelRatio().toFixed(2) : 0,
      particleScale,
    },
  };
}
window.__tide = {
  version: VERSION,
  get run() { return state.run; },
  get demoRun() { return state.demoRun; },
  get phase() { return state.phase; },
  get state() { return state; },
  get save() { return save; },
  breaks: BREAKS,
  info,
  startBreak: (id) => startBreak(id, true),
  autopilot(on) { state.autopilot = !!on; },
  pause: pauseGame,
  resume: resumeGame,
  quitToMenu,
  setMuted(m) { if (!!m !== state.muted) toggleMute(); },
  triggerFpsGuard() { stepFpsGuard(); return dprCap; },
  get dprCap() { return dprCap; },
  setShake(p) { state.shakePct = p; },
  setFlash(b) { state.flash = !!b; },
  pump(down) { input.pump = !!down; },
  setCarve(v) { input.touchCarve = v; recomputeCarve(); },
  releasePump() { input.pump = false; },
  worldToScreen,
  feel: FEEDBACK,
};

// ---------------------------------------------------------------- boot
if (!webglOK || !renderer) {
  $('webgl-error').classList.remove('hidden');
} else {
  buildBreakScene(BREAKS[0]);
  showMenu();
  const breakParam = Number(params.get('break'));
  if (breakParam >= 1 && breakParam <= BREAKS.length) {
    startBreak(breakParam, true);
  }
  requestAnimationFrame(frame);
}
