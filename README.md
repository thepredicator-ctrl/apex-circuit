# APEX ROADS — Endless Procedural Driving

**APEX ROADS** is an endless, *slowroads*-style driving game that runs entirely
in your browser: an infinite road generated as you drive, winding through
rolling hills, patchwork farmland, ranch fences, barns, pine forests and
wind farms — paired with a proper vehicle-dynamics simulation (slip angles,
Pacejka-style tire curves, friction ellipse, load transfer) that makes
braking, weight transfer and catchable drifts feel real.

Play it live: **https://thepredicator-ctrl.github.io/apex-circuit/**

## Features

- **Endless procedural roads** — the centerline is derived from seeded
  value-noise (curvature → heading, slope → elevation, superelevation on
  corners), so the world is deterministic per seed and streams in 128 m
  chunks around the car. Press **N** anytime for a brand-new road, or share
  a seed via `?seed=123456` in the URL.
- **Streaming 3D terrain** — rolling hills blend smoothly into the road
  corridor (no cliffs, no pops), with distant snow-capped mountains riding
  the horizon.
- **Rich living environment** — mixed conifer/broadleaf forests, grass
  tufts, bushes and rocks, reflector posts, wooden ranch fences, hay bales,
  red barns, power poles with crossarms, **spinning wind turbines**,
  drifting volumetric-style clouds, and a flock of birds circling overhead.
- **Real vehicle physics** — a dynamic bicycle model with per-axle slip
  angles, Pacejka "magic formula" tires with post-peak grip falloff, a
  friction ellipse for combined slip, longitudinal + lateral load transfer,
  aerodynamic downforce, load-sensitive grip, tire force relaxation length,
  a 6-speed gearbox with clutch slip and rev limiter, and an emergency
  handbrake with proper locked-wheel kinetics. Understeer, oversteer and
  counter-steering all *emerge* from the model — nothing is scripted.
- **Detailed low-poly coupe** — sculpted tapered body panels, fender arches,
  raked greenhouse with chrome beltline trim, 5-spoke alloys over visible
  brake discs and red calipers, dual exhausts, lip spoiler, grille slats,
  LED daytime-running lights, full-width taillight bar (brake-reactive),
  mirrors, wipers, sunroof and shark-fin antenna. Fully modeled cockpit with
  animated gauges (view with **V**).
- **Four times of day** — dawn / day / dusk / night presets drive a gradient
  sky shader, sun/moon, fog, star field, cloud tint and auto headlights.
- **Full HUD** — canvas tachometer with shift lights and gear indicator,
  journey odometer, altitude and road seed. No timers: this is a relaxing
  drive, not a race.
- **PWA** — installable, works offline after the first visit (service
  worker precaches the whole game; zero network assets are used at runtime).

## Install it on your device (PWA)

Open the site, then use **INSTALL GAME ON DEVICE** (Chrome/Edge desktop &
Android) — iOS Safari users can use *Share → Add to Home Screen* and the
**PRE-DOWNLOAD GAME** button to keep the cached game beyond Safari's
7-day eviction window.

## Quick start

```bash
npm install
npm run dev        # → http://localhost:5173
```

## Production build

```bash
npm run build      # vite build + service-worker precache manifest
npm run preview    # serve dist/ locally
```

## Controls

| Key                        | Action                                  |
| -------------------------- | --------------------------------------- |
| `W` / `↑`                  | Throttle                                |
| `S` / `↓`                  | Brake / reverse                         |
| `A` `D` / `←` `→`          | Steer                                   |
| `Space`                    | Handbrake (locked rear slides)          |
| `Q` / `E`                  | Shift down / up (manual mode)           |
| `M`                        | Auto ↔ manual transmission              |
| `V`                        | Camera: chase → hood → cockpit          |
| `R`                        | Recenter car on the road                |
| `N`                        | Generate a brand-new road (new seed)    |
| `Esc`                      | Settings                                |

Touch devices get on-screen steering, pedals, gears and camera controls
automatically.

## Project structure

```
index.html              app shell (loading / start / error screens)
src/
  main.js               bootstrap, WebGL check, PWA install + offline cache
  styles/main.css       HUD, overlays, touch controls
  game/
    Game.js             orchestrator: loop, journey state, settings, quality
    World.js            endless road + terrain streaming, all scenery
    Physics.js          dynamic bicycle model, Pacejka tires, handbrake
    Transmission.js     engine + 6-speed gearbox + clutch model
    Car.js              procedural detailed coupe + wheels + lights
    Interior.js         procedural cockpit, dashboard and gauges
    Environment.js      sky shader, sun/moon, fog, stars, clouds, birds
    Camera.js           chase / hood / cockpit rigs
    Audio.js            procedural engine, tires, wind, chimes
    Effects.js          drift smoke / dust particles, speed lines
    Input.js            keyboard + gamepad-ish smoothing, touch bridging
    Constants.js        every tuning knob (vehicle, world, quality, paints)
    Settings.js         persisted player settings
  ui/
    HUD.js              tachometer canvas, journey panel, settings panel
    TouchControls.js    on-screen controls for phones/tablets
public/                 PWA manifest, icons, service worker
scripts/                build helpers (precache manifest, icon generator)
```

## Implementation notes

- **Road model** — every 4 m sample derives curvature, slope and banking
  from layered value noise on its *absolute index*, so chunks can be
  generated incrementally in any travel direction with zero seams.
  Chunks own their slice of road ribbon, two terrain strips (vertex-colored
  with dry/grass/field tints) and instanced scenery allocated from recycled
  pools, so driving 100 km uses bounded memory.
- **Vehicle model** — forces live at the axle: slip angles from CG velocity
  + yaw rate, tire forces via the magic formula with load sensitivity and
  post-peak falloff, longitudinal forces capped by the friction ellipse,
  weight transfer from true CG acceleration. At parking speeds it blends
  into a kinematic model so maneuvers stay precise.
- **Performance** — flat/low-poly shading, instanced scenery, capped shadow
  frustum that follows the car, and LOW/MED/HIGH quality presets (pixel
  ratio, shadows, fog distance, scenery density).

## Browser support

Any modern browser with WebGL2 (Chrome, Edge, Firefox, Safari 16+). Works
on desktop and mobile; quality scales down automatically on phones.

## License

MIT — see `LICENSE` if present. Three.js is bundled as an npm dependency
under its own MIT license.
