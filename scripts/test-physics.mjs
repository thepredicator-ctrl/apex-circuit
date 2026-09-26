/**
 * Physics validation harness (Node, no DOM).
 * Simulates real driving scenarios and asserts the model behaves like a
 * drift game: straight-line stability, handbrake initiation, holdable
 * slides, counter-steer recovery, and NaN-free fuzzing.
 */
import { DriftPhysics } from '../src/vehicle/DriftPhysics.js';

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

console.log('== 1. Straight-line full throttle ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  const trace = run(p, 8, () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }));
  const end = trace[trace.length - 1];
  assert('no divergence', finite(p));
  assert('reaches high speed', end.speed > 32, `${(end.speed * 3.6).toFixed(0)} km/h`);
  assert('stays straight', Math.abs(end.beta) < 0.05, `beta=${end.beta.toFixed(3)}`);
  assert('yaw stable', Math.abs(p.omega) < 0.05, `omega=${p.omega.toFixed(3)}`);
}

console.log('== 2. Handbrake initiation -> held drift (THE core scenario) ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  // get up to speed
  run(p, 3.5, () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }));
  // flick + short handbrake tap (what a thumb actually does)
  run(p, 0.55, () => ({ steer: 0.9, throttle: 0.4, brake: 0, handbrake: true }));
  assert('slide initiated', Math.abs(p.beta) > 0.2, `beta=${p.beta.toFixed(2)}`);
  // thumb holds steer into the slide + partial throttle for 3s (assist on)
  const trace = run(p, 3, () => ({
    steer: 0.55,
    throttle: 0.6,
    brake: 0,
    handbrake: false,
    driftAssist: true,
  }));
  const sliding = trace.filter((s) => s.drift).length / trace.length;
  const maxBeta = Math.max(...trace.map((s) => Math.abs(s.beta)));
  assert('drift sustained >= 60% of window', sliding > 0.6, `${(sliding * 100).toFixed(0)}% of 3s`);
  assert('no spin-out', maxBeta < 1.35, `max beta=${maxBeta.toFixed(2)}`);
  assert('kept momentum', p.speed > 5.5, `${(p.speed * 3.6).toFixed(0)} km/h`);
}

console.log('== 2b. Idle hands after handbrake: must self-recover, never spin ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 3.5, () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }));
  run(p, 0.7, () => ({ steer: 0.9, throttle: 0.4, brake: 0, handbrake: true }));
  // true panic: everything released
  const trace = run(p, 3, () => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, driftAssist: true }));
  const maxBeta = Math.max(...trace.map((s) => Math.abs(s.beta)));
  assert('no spin-out with idle hands', maxBeta < 1.45, `max beta=${maxBeta.toFixed(2)}`);
  assert('eventually settles', Math.abs(p.beta) < 0.2, `final beta=${p.beta.toFixed(2)}`);
}

console.log('== 3. Manual counter-steer recovery (no assist) ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 3.5, () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }));
  run(p, 0.8, () => ({ steer: 1, throttle: 0.3, brake: 0, handbrake: true }));
  const sign = Math.sign(p.beta);
  assert('slide started', Math.abs(p.beta) > 0.3, `beta=${p.beta.toFixed(2)}`);
  // countersteer: steer opposite the slide, feather throttle
  let recovered = false;
  run(p, 2.5, (t) => {
    const cs = -sign * clamp(Math.abs(p.beta) * 1.3, 0.12, 0.5); // real driver modulates
    const b = Math.abs(p.beta);
    return { steer: b > 0.1 ? cs : 0, throttle: b > 0.3 ? 0.5 : 0.7, brake: 0, handbrake: false, driftAssist: false };
  });
  recovered = Math.abs(p.beta) < 0.22;
  assert('recovered with countersteer', recovered, `final beta=${p.beta.toFixed(2)}`);
}

console.log('== 4. Grip cornering at moderate speed (planted, no assist) ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 2.2, () => ({ steer: 0, throttle: 0.65, brake: 0, handbrake: false })); // ~90 km/h
  const trace = run(p, 5, () => ({ steer: 0.35, throttle: 0.5, brake: 0, handbrake: false, driftAssist: false }));
  const end = trace[trace.length - 1];
  assert('converges to cornering', Math.abs(p.omega) > 0.15, `omega=${p.omega.toFixed(2)} rad/s`);
  assert('stays planted (grip corner)', Math.abs(end.beta) < 0.45, `beta=${end.beta.toFixed(2)}`);
}

console.log('== 5. Brake-from-speed stability ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 5, () => ({ steer: 0, throttle: 1, brake: 0, handbrake: false }));
  run(p, 3, () => ({ steer: 0, throttle: 0, brake: 1, handbrake: false }));
  assert('braked near stop', p.speed < 4, `speed=${p.speed.toFixed(1)} m/s`);
  assert('no fishtail', Math.abs(p.beta) < 0.2, `beta=${p.beta.toFixed(2)}`);
}

console.log('== 6. Reverse ==');
{
  const p = new DriftPhysics();
  p.teleport(0, 0, 0);
  run(p, 2.5, () => ({ steer: 0, throttle: 0, brake: 1, handbrake: false }));
  assert('reverses', p.speed > 1.5 && p.reversing, `speed=${p.speed.toFixed(1)} m/s`);
}

console.log('== 7. Fuzz: 4000 random steps, must stay finite & bounded ==');
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
    if (!finite(p) || Math.hypot(p.vxW, p.vzW) > 90 || Math.abs(p.omega) > 12) { ok = false; break; }
  }
  assert('finite & bounded under fuzz', ok);
}

console.log(failures === 0 ? '\nALL PHYSICS TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
