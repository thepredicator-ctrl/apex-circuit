# APEX ROADS — Open World Driving

**APEX ROADS** is a seeded, *open-world* driving game that runs entirely in
your browser. Every world grows deterministically from a single seed:
an infinite network of highways, avenues, ring roads and city streets,
villages that swell into megacities, rivers and lakes, mountain passes with
covered cut galleries, viaducts over the water — plus regional weather,
a full day/night cycle, lane-following traffic, and a mystery system that
slowly unhinges the world the farther you drive from the origin.

Play it live: **https://thepredicator-ctrl.github.io/apex-circuit/**

## The World

- **World-scale road network** — roads are analytic, seeded routes on two
  lattices (highways every ~4.2 km, avenues every ~1.5 km) that meander with
  layered noise, so they are perfectly coherent across chunks and infinite in
  extent. Highway crossings become grade-separated interchanges with diamond
  ramps; cities contribute rotated street grids and ring roads.
- **Engineered road elevation** — routes march over the low-frequency terrain
  with a 7.5 % grade limiter, never dip below water level (causeways and
  viaducts with rails and pylons), and climb real mountains. Deep cuts get
  portal-framed galleries.
- **Procedural cities** — villages, towns, cities and megacities (with a
  165 m landmark tower) spawn on flat coastal shelves: downtown towers,
  commercial mid-rise, residential blocks, suburbs, an industrial warehouse
  wedge, parking lots and pocket parks, all instanced and window-lit at night.
- **Biomes & water** — oceans, beaches, plains, forests, deserts, rocky
  mountains and snow, with rivers carving toward the sea and lakes filling
  the basins below sea level.
- **The Deep** — beyond ~6 km the world starts changing: ashen tints, dead
  groves, wrecked pile-ups, stone circles, leaning monolith arches, and
  rarely… something impossible. No meter, no warnings. You just drive.

## The Drive

- **The CARRERA** — a textured sports-coupe GLB with independently rigged
  wheels (suspension travel, steering, rolling), working tail/brake lights
  and headlight spotlights.
- **Real vehicle physics** — a dynamic bicycle model: per-axle slip angles,
  Pacejka-style tires with post-peak falloff, friction ellipse, load
  transfer, aero downforce, ABS that keeps panic stops short *and steerable*
  (100–0 km/h in ~2.8 s), a locked-rear handbrake for drift entries,
  relaxation-length tire response and a low-speed kinematic blend.
- **7-speed powertrain** — torque curve, clutch slip on launch, rev limiter,
  automatic + manual (Q/E) modes, engine audio synthesized live.
- **Traffic** — AI vehicles that follow lanes, keep gaps, overtake on
  highways, yield near junctions, and thin out in the wilderness.
- **Weather & time** — a continuous day/night cycle (headlights, stars,
  city windows) and regional weather (clear / cloudy / fog / rain / storms
  with lightning and wet-road grip loss).

## Interface

Speedometer + tachometer, status panel (road, region, coordinates, world
clock, weather, seed), rotating radar minimap, a full **world map (Tab)**
with click-to-waypoint + teleport, toasts, graphics presets (LOW/MED/HIGH
with view distance + bloom), and settings that persist locally.

## Tech

- Three.js r182, zero frameworks in the game layer — modular systems:
  `core/` (seeded noise, tuning), `world/` (terrain, road network, cities,
  chunk streamer, scenery, mystery), `vehicle/` (physics, GLB car,
  transmission), `traffic/`, `weather/`, `multiplayer/`, `rendering/`
  (bloom post-FX), `ui/` (HUD, minimap, world map).
- 192 m chunks stream in a time-budgeted build queue with prioritized
  nearest-first ordering and full geometry disposal behind you — the world
  never grows in memory while you drive.
- Everything is derived from the seed: no assets to sync, and every player
  of seed **X** drives the *same* world. Multiplayer-ready relay rooms are
  keyed by seed (offline builds silently run solo).
- PWA: installable, the service worker precaches the app shell + car model
  so the whole world generates offline.

## Run it

```bash
npm install
npm run dev        # vite dev server
npm run build      # production build + service worker manifest
npm run preview    # serve the production build
```

Share any world with `?seed=123456` in the URL. Press **N** in-game for a
brand-new world, **R** to snap back onto the road, **Tab** for the map.
