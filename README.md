# Apex Circuit — 3D Arcade Racer

A polished 3D arcade racing game that runs in modern desktop and
mobile/tablet browsers — **play it live:
https://thepredicator-ctrl.github.io/apex-circuit/** — featuring a real
**Porsche 911 Carrera 4S** with four independently animated wheels (spin,
steer, suspension travel), a **Jaguar XJ220 cockpit** with an animated
steering wheel and a live instrument cluster with **physical moving
needles**, a real gearbox with manual / automatic modes, weight-transfer
physics, elevation + banked corners, an instanced GLB tree forest and large
touch controls. Built with **HTML, CSS, JavaScript and
[Three.js](https://threejs.org/)**, bundled by **Vite**. Engine and
environment audio are synthesized live (no samples), and the production
build **pre-downloads the entire game onto your device** via a service
worker so it installs like an app and plays fully offline.

![Tech](https://img.shields.io/badge/Three.js-r182-049ef4) ![Vite](https://img.shields.io/badge/Vite-7-9575ff) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Porsche 911 Carrera 4S exterior** (Karol Miklas, CC-BY-SA-4.0) — the
  real body, glass, lights and brake calipers, upgraded with clearcoat
  paint presets (**8 factory colors** selectable in Settings), emissive
  headlamps with spotlight beams + lens halos, and a brake-reactive rear
  light bar
- **Four animated wheels split from the model's merged axles** — every
  corner spins at exactly `v / r` around its true hub, front wheels **steer
  around their own kingpin axis**, every wheel travels independently on its
  suspension, and dark wheel-well liners keep the arches looking solid
- **Jaguar XJ220 cockpit** (Gerhald, CC-BY-4.0) mirrored to LHD — the
  model's **steering wheel is re-pivoted around its column axis and rotates
  ~137° lock-to-lock** with your input, sport pedals + shifter + handbrake
  are rigged to the drivetrain state
- **Instrument cluster with physical moving needles** — a canvas-drawn
  dual-dial face (tach + speed, shift LEDs, gear, lap timing) with **real
  3D red needles** sweeping the dials at 20 Hz, plus an **MMI-style center
  screen** showing the live track minimap with the car dot moving in real
  time
- **First-person cockpit camera** (`V`) — sits at the driver's head, rides
  the suspension and banking, dips under braking, leans in corners; the
  in-dash cluster shows live RPM / speed / gear
- **Real transmission simulation** — torque curve, 6 gear ratios + reverse,
  final drive, clutch behavior on launch, rev limiter, engine braking and a
  sequential manual gearbox (`R-N-1…6`) with torque-cut shifts. **Automatic**
  mode shifts by RPM with kickdown and engages reverse when you brake at a
  standstill
- **Weight-transfer physics** — drive force is capped by rear traction
  (wheelspin), braking is traction-limited, accelerating loosens the rear,
  braking loosens the front, downforce adds grip at speed, handbrake unglues
  the rear axle — drifting is earned, not automatic
- **Suspension** — per-wheel spring/damper travel with curb rumble, grass
  jitter, body roll in corners, pitch under accel/brake and an underdamped
  body settle after bumps
- **Elevation + banking** — the circuit rolls with the terrain (smooth
  hills), corners get progressive banking that eases in/out, gravel runoff
  areas, terrain mesh that follows the road height
- **Complete 3D circuit** — closed Catmull-Rom spline (~1.3 km) with asphalt,
  painted edge lines, red/white curbs, concrete walls with tire stacks,
  grass, a **forest of ~150 instanced GLB trees** (TechArtBGN, CC-BY-4.0), a grandstand, brake-marker boards, sponsor boards,
  light poles, start/finish gantry with a **5-lamp start-light tree**,
  checkpoint gates, distant mountains, clouds, gradient sky, fog and
  dynamic shadows
- **Race system** — 3 laps, 3 checkpoint gates per lap that must be crossed
  **in order**, lap/total/best timing, 3-2-1-GO! countdown with locked
  controls and start lights, wrong-way warning, anti-cheat (backwards finish
  crossings and gate skips never count), finish screen with lap breakdown,
  best-lap persistence via `localStorage`
- **Cameras** — chase camera with velocity prediction, accel/brake
  reaction, corner swing, subtle roll, aggressive speed FOV (+17°),
  high-speed camera shake and ground-clipping protection; cockpit camera
  with speed FOV, head inertia and suspension motion — plus world-anchored
  **speed-line streaks** that fade in above ~100 km/h for a real sense of
  speed
- **Settings menu** (Esc or the HUD button) — automatic/manual transmission,
  camera mode, graphics quality (LOW / MEDIUM / HIGH), **paint color**, master
  & engine volume, steering speed, camera smoothing — persisted via
  `localStorage`
- **Procedural flat-six engine audio** (Web Audio API, no samples) — a
  baked combustion-pulse loop (144 uneven, ringing cylinder pulses) played
  back at `rpm / 2400` with a bright top-end scream layer, dual exhaust
  body resonances, throttle-driven drive + lowpass, sub octave and
  combustion roar — plus a full **starter-motor sequence (whirr → catch →
  idle flare)** on launch, **exhaust crackles and afterfire pops** on
  lift-off and downshifts, intake + plenum hiss, dual-band tire screech,
  wind rush, cabin rumble, curb rumble and **impact thuds on wall hits**.
  The game runs silently if audio is unavailable
- **Racing HUD** — canvas tachometer with shift lights and big gear readout,
  lap counter with checkpoint pips, current lap / total / best times,
  transmission & camera badges, reset/restart/sound/settings buttons, lap
  toasts, countdown display, finish panel
- **Touch controls** — large multi-touch-safe steering, throttle, brake,
  drift, **gear ±**, **camera**, **transmission** and reset buttons (pointer
  events + pointer capture), shown automatically on touch devices,
  comfortable in iPad landscape
- **Mobile-friendly rendering** — capped device pixel ratio, quality presets
  that scale shadows/fog/particles, instanced scenery, merged geometry
- **Robust error handling** — WebGL capability check, visible error overlay
  for initialization failures, console logging; a blank screen is never
  shown

## Install it on your device (PWA)

Apex Circuit is a **Progressive Web App**. On the first visit a service
worker downloads the entire game — app shell, Three.js bundle and all three
GLB models — onto the device (watch the progress bar on the loading screen).
After that the game launches from the home screen / app drawer like a native
app and **plays fully offline**. Chrome / Edge on desktop and Android show an
**INSTALL GAME ON DEVICE** button on the start screen; on iOS use
*Share → Add to Home Screen*.

## Model & asset credits

The game ships with three community models (optimized with
[gltf-transform](https://gltf-transform.dev/), vertex-quantized):

| Asset | Author | License |
| ----- | ------ | ------- |
| Porsche 911 Carrera 4S | [Karol Miklas](https://sketchfab.com/karolmiklas) | CC-BY-SA-4.0 |
| Car interior (Jaguar XJ220) | [Gerhald](https://sketchfab.com/Gerhald) | CC-BY-4.0 |
| Tree GN | [TechArtBGN](https://sketchfab.com/TechArtBGN) | CC-BY-4.0 |

All other meshes, textures and every sound are generated procedurally in
code. Engine audio is a real-time synthesis, not a recording.

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL (default `http://localhost:5173`).
Click / tap / press any key to start.

## Production build

```bash
npm run build      # outputs static files to dist/
npm run preview    # serves dist/ locally to verify
```

The build is fully static — everything (Three.js included) is bundled, so
the game does not depend on any CDN at runtime.

## Controls

### Desktop

| Key                       | Action                                |
| ------------------------- | ------------------------------------- |
| `W` / `↑`                 | Throttle                              |
| `S` / `↓`                 | Brake (hold at standstill: reverse in auto) |
| `A` / `←`                 | Steer left                            |
| `D` / `→`                 | Steer right                           |
| `Space`                   | Handbrake (drift)                     |
| `Q`                       | Shift down (manual mode)              |
| `E`                       | Shift up (manual mode)                |
| `V`                       | Switch chase ↔ cockpit camera         |
| `M`                       | Toggle automatic ↔ manual gearbox     |
| `R`                       | Reset car onto track                  |
| `Esc`                     | Settings menu                         |

Pressing `Q`/`E` while in automatic mode switches the gearbox to manual.
All settings (including volumes and graphics quality) also live in the
settings menu and are remembered between sessions.

### Mobile / tablet

Large on-screen buttons appear automatically on touch devices:
steer left / right (bottom-left), **GAS**, **BRAKE** and **DRIFT**
(bottom-right), **gear − / +** next to the pedals, and **camera** /
**transmission** / **reset** buttons (top-right). Multi-touch is supported —
steer and throttle simultaneously. Hold **BRAKE** while stopped to reverse
in automatic mode.

## Deploying as a static website

`npm run build` produces a self-contained `dist/` folder that works on any
static host, because all asset paths are relative (`base: './'`):

- **GitHub Pages** — a ready-made workflow is included
  (`.github/workflows/deploy.yml`): enable *Settings → Pages → Source:
  GitHub Actions* and every push to `main` builds and deploys the game
  automatically. Alternatively push the contents of `dist/` to a `gh-pages`
  branch.
- **Netlify / Cloudflare Pages** — build command `npm run build`,
  publish directory `dist`
- **Vercel** — framework preset *Vite*; zero config
- **Any web server** — copy `dist/` into your web root
  (`nginx`, Apache, S3 + CloudFront, …)

## Project structure

```
├── index.html              # shell: canvas, overlays (start/finish/error)
├── vite.config.js          # base './', build config
├── public/
│   └── favicon.svg         # checkered-flag icon
└── src/
    ├── main.js             # bootstrap, WebGL check, error handling, screens
    ├── styles/
    │   └── main.css        # HUD, overlays, touch controls, responsive rules
    ├── game/
    │   ├── Constants.js    # all tuning values (physics, transmission, camera)
    │   ├── Game.js         # engine orchestrator, fixed-step loop, settings
    │   ├── Track.js        # procedural circuit + elevation/banking + scenery
    │   ├── Environment.js  # sky shader, fog, lights, shadows, env probe
    │   ├── Car.js          # detailed procedural car + wheel arches + wheels
    │   ├── Interior.js     # Audi-style cockpit, steering wheel, live screens
    │   ├── Physics.js      # weight-transfer vehicle physics + surfaces
    │   ├── Transmission.js # engine, torque curve, gears, clutch, shifting
    │   ├── Race.js         # laps, checkpoints, timers, countdown, finish
    │   ├── Camera.js       # chase + cockpit camera rig (shake, speed FOV)
    │   ├── Input.js        # keyboard + touch → smoothed control state
    │   ├── Audio.js        # Web Audio V10-style synthesis + effects
    │   ├── Settings.js     # persisted player settings
    │   └── Effects.js      # pooled smoke/dust particles + speed lines
    └── ui/
        ├── HUD.js          # DOM HUD (tachometer, panels, settings, finish)
        └── TouchControls.js# touch button clusters (pointer events)
```

## Implementation notes

- **Physics** runs at a fixed 120 Hz with an accumulator (max 8 substeps) so
  handling is frame-rate independent; rendering runs per rAF frame.
- **Transmission**: `rpm = |v| / wheelRadius × gearRatio × finalDrive ×
  60 / 2π`; wheel force = `torque(rpm) × ratio × efficiency / wheelRadius`,
  capped by rear-axle traction. The clutch slips below ~5.5 m/s on launch
  so the engine revs freely and the cap keeps launches believable.
- **Track sampling**: the circuit centerline is sampled into 1000 points.
  Physics uses a windowed nearest-sample search for surface lookup
  (`asphalt/curb/grass`), signed lateral offset (wall collision pushes back
  along the *track* normal), surface height incl. banking and race progress
  `s ∈ [0,1)`.
- **Anti-cheat**: three gates at 30 % / 62 % / 85 % of the lap must be
  collected in order and near the centerline; only a forward, fully-gated
  crossing of `s = 0` counts a lap. Reverse crossings are ignored.
- **Debug hooks**: `window.__game` exposes the running game (useful for
  automated tests and tinkering).

## Browser support

Modern desktop and mobile browsers with WebGL (Chrome, Edge, Firefox,
Safari, iOS Safari, Chrome for Android). The game shows a clear message if
WebGL is unavailable.

## License

MIT. All game code, models, textures and audio are generated from scratch —
no third-party assets beyond the npm packages listed in `package.json`.
