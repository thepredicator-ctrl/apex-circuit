# APEX DRIFT

A mobile-first **seeded drift game** for the browser. Tap DRIFT, slide the
rear out, chain the combo, bank the points. Every map is procedurally
generated from a short text seed — same seed in, identical park out, on every
device. Three.js + Vite PWA, fully offline-installable.

> This project began life as *APEX ROADS*, an open-world driving sandbox.
> It was refactored into APEX DRIFT: the open-world systems (chunk streaming,
> traffic, multiplayer, mystery zones, weather) were removed, the vehicle
> model was retuned for drifting, and a compact seeded drift park replaced
> the infinite world. The cartoon sports car asset is kept.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build (`dist/`, also stamps the offline service worker):

```bash
npm run build
npm run preview
```

Deployed automatically to GitHub Pages on push to `main`
(`.github/workflows/deploy.yml`).

## Controls

**Touch (phones & tablets)** — the game is built for thumbs:

| Control | Action |
|---|---|
| ◀ ▶ (bottom-left) | steer — slide your thumb between the pads |
| GAS (bottom-right) | throttle |
| BRAKE | brake · hold at standstill to reverse |
| DRIFT pill | handbrake — tap to kick the tail out, hold to keep sliding |

Comfort options on the start screen: **tilt steering**, **auto-throttle**
(one-thumb play), **drift assist** (auto counter-steer), **vibration**, mute.

**Keyboard (desktop):** WASD / arrows · `SPACE` = handbrake · `R` = reset ·
`C` = camera (chase / far / hood). Add `?touch=1` to the URL to preview the
touch UI on desktop.

## Scoring

- While sliding, points accrue from **slip angle × speed × zone multiplier × combo**
- The **combo** grows the longer a chain lives (up to ×10)
- Painted **DRIFT ZONES** on sharp corners pay ×2 / ×3, the central
  **skidpad** pays ×1.5
- Stop sliding and you have ~1 s of grace to re-hook the car; run out and the
  chain **banks** into your total
- Wall crashes and spin-outs drop the unbanked chain
- Best score per seed is saved on-device (`localStorage`)

## Map generation

`src/world/DriftMap.js` builds the park from the seed:

1. 12 jittered control points on a ring → centripetal Catmull-Rom spline →
   640 evenly spaced centerline samples with tangents, normals and curvature
2. Sharp corners (curvature > 1/70 rad/m) become drift zones; the sharpest
   (> 1/40) pay ×3
3. Road ribbon, red/white curbs, striped tire walls, zone overlays, start
   gantry + checkered line, cone / tire-stack dressing, tree scatter, and a
   central skidpad with painted rings

Collisions are analytic (nearest centerline sample + lateral clamp with
reflection) — no physics meshes, cheap on mobile.

## Vehicle physics

`src/vehicle/DriftPhysics.js` is an **arcade drift model in the CarX
tradition**, stepped at a fixed 120 Hz. Instead of simulating tire contact
patches it tracks two things: the heading (rotated by a directly-controlled
yaw rate) and the velocity direction (pulled toward the heading by a
traction rate). The angle between them IS the drift angle:

- **Traction is a curve over that angle** — strong when nearly straight
  (planted cornering), weak inside the hold zone (slides sustain at big
  angles), rising again near the cap (the car refuses to spin)
- **Throttle controls the angle, steering controls the radius** — more
  throttle deepens the slide, lifting tucks it, winding in tightens it
- **Easy initiation**: a handbrake tap dumps traction instantly, and full
  lock at speed power-overs the tail by itself
- **Drift thrust** keeps slides flowing instead of scrubbing to a stop;
  the handbrake cuts engine power so it stays a true initiator
- Mobile comfort nets (all toggleable, on by default):
  - **Drift assist** holds the wheel near the sustain angle when hands come
    off — slides keep a clean angle instead of snapping back
  - A **beta cap** (~68°) is a soft wall — spins are physically impossible
  - **Yaw ceiling** bleeds rotation the tires could never bend into

Validate the model headlessly anytime:

```bash
npm run test:physics
```

It asserts straight-line stability, handbrake initiation, sustained
CarX-angle drifts, no-spin recovery with idle hands, manual counter-steer,
planted grip cornering, power-over initiation, throttle-controlled angle,
power donuts, left/right symmetry, braking, reverse and a 4000-step
NaN/bounds fuzz.

## Project layout

```
src/
  main.js               bootstrap, wiring, error overlay, audio unlock
  core/
    RNG.js              xmur3 + mulberry32 seeded PRNG + helpers
    Input.js            unified keyboard / touch / tilt state
    Settings.js         localStorage prefs + per-seed best scores
    Audio.js            WebAudio synth: engine, screech, wind, chimes
  vehicle/
    DriftPhysics.js     the drift model (DOM-free, unit-testable)
    Car.js              GLB rig (nose=+Z, wheel pivots), body articulation
    Fx.js               tire smoke (1 draw call) + skid mark ring buffer
  world/
    DriftMap.js         seeded track, zones, walls, props, collisions
    Environment.js      golden-hour sky, sun shadows, clouds, mountains
  game/
    Game.js             orchestrator, fixed-step loop, quality governor
    DriftScore.js       chain / combo / banking rules
    CameraRig.js        drift-aware chase cam (3 modes, FOV by speed)
  ui/
    TouchControls.js    multi-touch pads, haptics, safe-area layout
    HUD.js              score, combo chip, angle needle, popups
    Menu.js             start screen (seed + comfort toggles), pause
scripts/
  test-physics.mjs      headless physics validation harness
  build-sw.mjs          stamps the precache manifest into dist/sw.js
  make-icons.mjs        regenerates PWA icons
  secrets.mjs           AES-256-GCM secrets CLI (dev tooling, kept)
```

## Tech notes

- Three.js r182, no framework, ~2.5 k lines of game code
- One smoke `THREE.Points` draw call; skid marks are a preallocated quad ring
  buffer — zero per-frame allocations in the hot path
- Auto quality governor: sustained < 40 fps drops pixel ratio, shadows, fog
  distance (shows a toast)
- PWA: precache manifest stamped at build time; installs standalone in
  landscape with safe-area-aware UI
