# Apex Circuit — 3D Arcade Racer

A polished, lightweight 3D arcade racing game that runs in modern desktop and
mobile/tablet browsers. Three laps, checkpoint validation, drifting physics,
procedural engine audio and large touch controls — built entirely with
**HTML, CSS, JavaScript and [Three.js](https://threejs.org/)**, bundled by
**Vite**. No external assets, no CDNs at runtime: every mesh, texture and
sound is generated procedurally in code, and the production build bundles
all dependencies into static files.

![Tech](https://img.shields.io/badge/Three.js-r182-049ef4) ![Vite](https://img.shields.io/badge/Vite-7-9575ff) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Procedural low-poly sports car** — body, glass canopy, four wheels with
  rims & spokes, steering front wheels, spinning wheels, rear wing, splitter,
  diffuser, headlights, brake lights and a reverse light
- **Arcade vehicle physics** — acceleration with a tapered power curve,
  braking, reverse gear, top speed, air drag, rolling resistance,
  speed-dependent steering, lateral grip with traction loss at high steering
  angles, handbrake drifting, power oversteer, weight/inertia feel via body
  roll & pitch, grass and curb surfaces
- **Complete 3D circuit** — closed Catmull-Rom spline (~1.3 km) with asphalt,
  painted edge lines, red/white curbs on the corners, concrete walls with
  tire stacks, grass, ~150 trees, a grandstand, start/finish gantry with
  banner, checkpoint gates, distant mountains, clouds, gradient sky with sun
  glow, fog and dynamic shadows
- **Race system** — 3 laps, 3 checkpoint gates per lap that must be crossed
  **in order**, lap/total/best timing, 3-2-1-GO! countdown with locked
  controls, wrong-way warning, anti-cheat (backwards finish crossings and
  gate skips never count; walls make infield cuts impossible), finish screen
  with lap breakdown, best-lap persistence via `localStorage`
- **Chase camera** — smooth exponentially-damped follow, pulls back and
  widens FOV with speed, subtle roll and lateral swing in corners
- **Procedural audio** (Web Audio API) — engine with a fake 6-speed gearbox
  whose pitch follows RPM, tire screech on slides, wind rush, curb rumble,
  countdown beeps, lap dings, finish jingle. The game runs silently if audio
  is unavailable
- **Modern HUD** — speed & gear, lap counter with checkpoint pips, current
  lap / total / best times, reset & restart & mute buttons, lap toasts,
  countdown display, finish panel
- **Touch controls** — large multi-touch-safe steering, throttle, brake,
  drift and reset buttons (pointer events + pointer capture), shown
  automatically on touch devices, comfortable in iPad landscape
- **Mobile-friendly rendering** — capped device pixel ratio, modest shadow
  map that follows the car, instanced scenery, a handful of draw calls
- **Robust error handling** — WebGL capability check, visible error overlay
  for initialization failures, console logging; a blank screen is never
  shown

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

| Key                       | Action                |
| ------------------------- | --------------------- |
| `W` / `↑`                 | Throttle              |
| `S` / `↓`                 | Brake / reverse       |
| `A` / `←`                 | Steer left            |
| `D` / `→`                 | Steer right           |
| `Space`                   | Handbrake (drift)     |
| `R`                       | Reset car onto track  |

HUD buttons: **RESET** (car), **RESTART** (race), **SOUND** (mute).

### Mobile / tablet

Large on-screen buttons appear automatically on touch devices:
steer left / right (bottom-left), **GAS**, **BRAKE** and **DRIFT**
(bottom-right), plus a reset button (top-right). Multi-touch is supported —
steer and throttle simultaneously. Hold **BRAKE** while stopped to reverse.

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
    │   ├── Constants.js    # all tuning values (physics, camera, world)
    │   ├── Game.js         # engine orchestrator, fixed-step loop, states
    │   ├── Track.js        # procedural circuit + scenery + sampling API
    │   ├── Environment.js  # sky shader, fog, lights, shadows, env probe
    │   ├── Car.js          # procedural low-poly car + visual effects
    │   ├── Physics.js      # arcade vehicle physics + surface + walls
    │   ├── Race.js         # laps, checkpoints, timers, countdown, finish
    │   ├── Camera.js       # damped chase camera
    │   ├── Input.js        # keyboard + touch → smoothed control state
    │   ├── Audio.js        # Web Audio engine/screech/wind/UI sounds
    │   └── Effects.js      # pooled tire smoke / dust particles
    └── ui/
        ├── HUD.js          # DOM HUD (panels, countdown, toasts, finish)
        └── TouchControls.js# touch button clusters (pointer events)
```

## Implementation notes

- **Physics** runs at a fixed 120 Hz with an accumulator (max 8 substeps) so
  handling is frame-rate independent; rendering runs per rAF frame.
- **Track sampling**: the circuit centerline is sampled into 1000 points.
  Physics uses a windowed nearest-sample search for surface lookup
  (`asphalt/curb/grass`), signed lateral offset (wall collision pushes back
  along the *track* normal) and race progress `s ∈ [0,1)`.
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
