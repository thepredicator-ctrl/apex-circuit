/**
 * Physics validation harness (Node, no DOM) — ARCADE drift model.
 * Asserts CarX-style behavior: planted grip when gentle, easy initiation,
 * big holdable slides, throttle-controlled angle, no spins ever.
 */
import { DriftPhysics, TUNE } from '../src/vehicle/DriftPhysics.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const H = 1 / 120;
let failures = 0;

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

function finite(p) {
  return [p.x, p.z, p.vxW, p.vzW, p.omega, p.heading].every(Number.isFinite);
}

/** Run for N seconds with a (t, p) => input callback. */
function run(p, seconds, cb) {
  const steps = Math.round(seconds / H);
  const trace = [];
  for (let i = 0; i < steps; i++) {
    p.step(H, cb(i * H, p));
    trace.push({ t: i * H, beta: p.beta, speed: p.speed, drift: p.drifting });
    if (!finite(p)) { console.error(`  DIVERGED at t=${i * H}s`); return trace; }
  }
  return trace;
}

const gas = (o = {}) => ({ steer: 0, throttle: 1, brake: 0, handbrake: false, ...o });

console.log('== 1. Straight-line full throttle ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  const trace = run(p, 8, () => gas());
  const end = trace[trace.length - 1];
  assert('no divergence', finite(p));
  assert('reaches high speed', end.speed > 32, `${(end.speed * 3.6).toFixed(0)} km/h`);
  assert('stays straight', Math.abs(end.beta) < 0.05, `beta=${end.beta.toFixed(3)}`);
  assert('yaw stable', Math.abs(p.omega) < 0.05, `omega=${p.omega.toFixed(3)}`);
}

console.log('== 2. Handbrake tap -> held drift (THE core scenario) ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 3.5, () => gas());
  // flick + short handbrake tap (what a thumb actually does)
  run(p, 0.5, () => gas({ steer: 0.9, throttle: 0.5, handbrake: true }));
  assert('slide initiated', Math.abs(p.beta) > 0.28, `beta=${p.beta.toFixed(2)}`);
  // hold steer into the slide + partial throttle for 3s (assist on)
  const trace = run(p, 3, () => gas({ steer: 0.55, throttle: 0.6, driftAssist: true }));
  const sliding = trace.filter((s) => s.drift).length / trace.length;
  const maxBeta = Math.max(...trace.map((s) => Math.abs(s.beta)));
  const avgBeta = trace.reduce((a, s) => a + Math.abs(s.beta), 0) / trace.length;
  assert('drift sustained >= 80% of window', sliding > 0.8, `${(sliding * 100).toFixed(0)}% of 3s`);
  assert('big arcade angle held', avgBeta > 0.35, `avg beta=${avgBeta.toFixed(2)} (${(avgBeta * 57.3).toFixed(0)}°)`);
  assert('no spin-out', maxBeta < 1.3, `max beta=${maxBeta.toFixed(2)}`);
  assert('kept momentum', p.speed > 7, `${(p.speed * 3.6).toFixed(0)} km/h`);
}

console.log('== 2b. Idle hands after handbrake: must self-recover, never spin ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 3.5, () => gas());
  run(p, 0.7, () => gas({ steer: 0.9, throttle: 0.4, handbrake: true }));
  const trace = run(p, 3.5, () => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, driftAssist: true }));
  const maxBeta = Math.max(...trace.map((s) => Math.abs(s.beta)));
  assert('no spin-out with idle hands', maxBeta < 1.45, `max beta=${maxBeta.toFixed(2)}`);
  assert('eventually settles', Math.abs(p.beta) < 0.2, `final beta=${p.beta.toFixed(2)}`);
}

console.log('== 3. Manual counter-steer recovery (no assist) ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 3.5, () => gas());
  run(p, 0.8, () => gas({ steer: 1, throttle: 0.3, handbrake: true }));
  const sign = Math.sign(p.beta);
  assert('slide started', Math.abs(p.beta) > 0.3, `beta=${p.beta.toFixed(2)}`);
  run(p, 2.5, () => {
    const b = Math.abs(p.beta);
    const cs = -sign * clamp(b * 1.3, 0.12, 0.5); // real driver modulates
    return { steer: b > 0.1 ? cs : 0, throttle: b > 0.3 ? 0.5 : 0.7, brake: 0, handbrake: false, driftAssist: false };
  });
  assert('recovered with countersteer', Math.abs(p.beta) < 0.22, `final beta=${p.beta.toFixed(2)}`);
}

console.log('== 4. Gentle cornering stays planted (grip mode) ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 2.5, () => gas({ throttle: 0.6 })); // ~65 km/h
  const trace = run(p, 5, () => gas({ steer: 0.12, throttle: 0.5, driftAssist: false }));
  const end = trace[trace.length - 1];
  assert('converges to cornering', Math.abs(p.omega) > 0.12, `omega=${p.omega.toFixed(2)} rad/s`);
  assert('stays planted', Math.abs(end.beta) < 0.14, `beta=${end.beta.toFixed(2)}`);
  const drifted = trace.filter((s) => s.drift).length / trace.length;
  assert('no drift flag while cruising', drifted === 0, `${(drifted * 100).toFixed(0)}% drift`);
}

console.log('== 4b. Full lock at speed -> CarX power-over initiation ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 2.5, () => gas({ throttle: 0.55 })); // ~65 km/h
  const trace = run(p, 2, () => gas({ steer: 1, throttle: 0.7, driftAssist: true }));
  const maxBeta = Math.max(...trace.map((s) => Math.abs(s.beta)));
  assert('hard flick breaks the tail', maxBeta > 0.3, `max beta=${maxBeta.toFixed(2)}`);
  assert('but never spins', maxBeta < 1.3, `max beta=${maxBeta.toFixed(2)}`);
}

console.log('== 5. Throttle controls the angle (CarX rule) ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 3.5, () => gas());
  run(p, 0.5, () => gas({ steer: 0.9, throttle: 0.5, handbrake: true }));
  // same steering, only throttle differs
  run(p, 2, () => gas({ steer: 0.5, throttle: 1, driftAssist: false }));
  const betaFull = Math.abs(p.beta);
  run(p, 2, () => gas({ steer: 0.5, throttle: 0.08, driftAssist: false }));
  const betaOff = Math.abs(p.beta);
  assert('more throttle = bigger angle', betaFull > betaOff + 0.1,
    `full=${betaFull.toFixed(2)} vs lifted=${betaOff.toFixed(2)}`);
  assert('lifting tucks the slide', betaOff < 0.5, `beta=${betaOff.toFixed(2)}`);
}

console.log('== 5b. Skidpad donut: initiate on handbrake, sustain on power ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 2.5, () => gas({ throttle: 0.7 }));
  run(p, 1.2, () => gas({ steer: 0.85, throttle: 0.75, handbrake: true, driftAssist: true }));
  // release handbrake — full throttle + lock holds the donut (CarX power donut)
  const trace = run(p, 3, () => gas({ steer: 0.85, throttle: 1, driftAssist: true }));
  const avgBeta = trace.reduce((a, s) => a + Math.abs(s.beta), 0) / trace.length;
  const maxBeta = Math.max(...trace.map((s) => Math.abs(s.beta)));
  assert('sustained donut angle', avgBeta > 0.5, `avg beta=${(avgBeta * 57.3).toFixed(0)}°`);
  assert('angle stays under the wall', maxBeta < 1.3, `max=${(maxBeta * 57.3).toFixed(0)}°`);
  assert('keeps moving in a circle', p.speed > 3, `${(p.speed * 3.6).toFixed(0)} km/h`);
}

console.log('== 5c. Left/right symmetry ==');
{
  const sim = (dir) => {
    const p = new DriftPhysics();
    p.teleport(0, 0, 0);
    run(p, 3.5, () => gas());
    run(p, 0.5, () => gas({ steer: 0.9 * dir, throttle: 0.5, handbrake: true }));
    const t = run(p, 2, () => gas({ steer: 0.55 * dir, throttle: 0.6, driftAssist: true }));
    return { beta: p.beta, avg: t.reduce((a, s) => a + Math.abs(s.beta), 0) / t.length };
  };
  const R = sim(1), L = sim(-1);
  assert('mirror drifts mirror', Math.sign(R.beta) === 1 && Math.sign(L.beta) === -1,
    `R=${R.beta.toFixed(2)} L=${L.beta.toFixed(2)}`);
  assert('symmetric magnitude', Math.abs(R.avg - L.avg) < 0.12,
    `Ravg=${R.avg.toFixed(2)} Lavg=${L.avg.toFixed(2)}`);
}

console.log('== 6. Brake-from-speed stability ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 5, () => gas());
  // brake for 3 s; after the stop the arcade convention shifts to reverse —
  // stability is asserted during the FORWARD braking phase only
  let maxBetaFwd = 0;
  run(p, 3, (t, car) => {
    const sinH2 = Math.sin(car.heading), cosH2 = Math.cos(car.heading);
    if (car.vxW * sinH2 + car.vzW * cosH2 > 5) maxBetaFwd = Math.max(maxBetaFwd, Math.abs(car.beta));
    return gas({ throttle: 0, brake: 1 });
  });
  assert('no fishtail while braking forward', maxBetaFwd < 0.12, `max beta=${maxBetaFwd.toFixed(2)}`);
  assert('slowed right down', p.speed < TUNE.vRevMax + 0.5, `speed=${p.speed.toFixed(1)} m/s (${p.reversing ? 'reversing' : 'forward'})`);
  assert('reverse phase stays straight', p.reversing ? Math.abs(p.beta) < 0.05 : true, `beta=${p.beta.toFixed(2)}`);
}

console.log('== 7. Reverse ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 2.5, () => gas({ throttle: 0, brake: 1 }));
  assert('reverses', p.speed > 1.5 && p.reversing, `speed=${p.speed.toFixed(1)} m/s`);
  assert('reverse reads beta≈0 (no false spin)', Math.abs(p.beta) < 0.1, `beta=${p.beta.toFixed(2)}`);
  // steer while reversing — must not explode
  run(p, 1.5, () => gas({ steer: 0.8, throttle: 0, brake: 1 }));
  assert('reverse steering stable', finite(p) && Math.abs(p.omega) < 3, `omega=${p.omega.toFixed(2)}`);
}

console.log('== 8. Fuzz: 4000 random steps, must stay finite & bounded ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  let ok = true;
  let seedState = 12345;
  const rand = () => {
    seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
    return seedState / 0x7fffffff;
  };
  for (let i = 0; i < 4000; i++) {
    const hard = i % 400 < 40; // periodic chaos
    p.step(H, {
      steer: rand() * 2 - 1,
      throttle: rand(),
      brake: hard ? 1 : (rand() < 0.2 ? 1 : 0),
      handbrake: hard,
      driftAssist: rand() < 0.5,
    });
    if (!finite(p) || Math.hypot(p.vxW, p.vzW) > 90 || Math.abs(p.omega) > 12
      || Math.abs(p.beta) > 2.2) { ok = false; break; }
  }
  assert('finite & bounded under fuzz', ok);
}

console.log(failures === 0 ? '\nALL PHYSICS TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
