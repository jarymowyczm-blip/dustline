# DUSTLINE

A realistic browser FPS built with **Three.js** and **Vite** — and *zero asset downloads*.

Clone it, install, run. Every texture, every model and every sound is generated
procedurally in code at load time, so there are no `.glb` / `.png` / `.wav` files to
fetch, no CDN to reach, and no build step you have to prepare by hand.

```bash
git clone <your-fork-url> dustline
cd dustline
npm install
npm run dev          # opens http://localhost:5173
```

Click **Deploy to Dustline**, then click the canvas to lock the mouse and play.

---

## What's in it

**A real gunfight, not a tech demo.** Hostile soldiers hold the compound: they see you
through a vision cone backed by actual line-of-sight raycasts, hear your gunfire over a
distance falloff, take cover behind level geometry, peek, fire in bursts, suppress you
with near misses, flinch when hit, and bleed out into a physics ragdoll when they drop.

**Rendering that reads as photographic.** Physically-based materials are baked in the
browser (albedo, normal and packed ORM maps derived from value/worley noise, then lit
through a PMREM sky IBL) and pushed through ACES filmic tone mapping. On top of that sit
ground-truth ambient occlusion, bloom, SMAA, and a grading pass that models your
suppression and low health as lens effects.

**Everything is modelled.** The three weapons are built from primitives into working
assemblies — receiver, bolt carrier, gas block, handguard, magazine, optic, muzzle
device — with separate nodes for the ones that move. The soldier rig is a 25-bone
hierarchy (pelvis → spine → chest → neck, four limb chains) driven by a procedural
walk cycle, breathing, inertial torso lean and two-bone IK, so units actually point
their rifles where they are aiming. Death converts that hierarchy into a Verlet
particle ragdoll that collides with the world and settles.

**Sound is synthesised too.** Gunshots are layered transients (a noise crack through a
swept filter, a body thump, a tail) generated with WebAudio at runtime — no samples, no
downloads, distance-attenuated in 3D.

### Feature list

- Two modes: **Survival** (endless escalating waves) and a **Training Range**.
- Three weapons (carbine, AKM, pistol) with magazines, reserve ammo, reloads, fire
  modes, recoil that walks the muzzle up, spread that tightens when you aim.
- Aim-down-sights through a separate narrow-FOV viewmodel camera, so the weapon renders
  with its own near plane instead of clipping into walls.
- Grenades, melee, medkits, pickups, damage-direction indicators, hitmarkers, headshots.
- Bullet impacts with surface-specific decals, dust, sparks, tracers, ejected brass that
  physically bounces, and smoke that follows weapon heat.
- Movement with sprint, crouch, stamina, strafe lean, landing punch and camera shake.
- Quality presets (low → ultra), plus per-effect toggles, saved to `localStorage`.

## Controls

| Action | Key |
| --- | --- |
| Move | `W A S D` |
| Sprint | `Shift` (hold) or `Caps Lock` (toggle) |
| Crouch | `Ctrl` / `C` |
| Jump | `Space` |
| Fire / aim | Left mouse / right mouse |
| Reload | `R` |
| Melee / inspect weapon | `Q` / `B` |
| Grenade | `G` |
| Medkit | `H` |
| Interact / pickup | `F` |
| Fire mode | `V` |
| Weapon slots | `1` `2` `3` or mouse wheel |
| Pause / release mouse | `Esc` |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run build:single` | Builds **one self-contained `.html`** into `dist/` — the whole game, including the engine, inlined into a single file you can email or drop on a static host |
| `npm run preview` | Serve the production build on port 4173 |
| `npm test` | Headless smoke suite (no GPU needed) |

### Tests

`npm test` does not just check "it didn't crash". It asserts content:

- baked textures are not flat (mean/variance on the albedo, normals centred on 0.5 and
  actually perturbed, ORM channels in range),
- the level produces hundreds of colliders and a plausible triangle budget,
- the collision world returns exact ray distances, rejects rotated-box misses, ejects
  capsules out of walls, lands them on the ground and steps them up ledges,
- weapons exceed a triangle budget and expose their animation nodes,
- the soldier rig stands on the ground, is life-size, and has knees below hips and
  ankles below knees,
- an enemy standing in the open actually *wounds* the player, with its rifle shouldered
  and its bore pointed at the target at the moment it fires,
- 600 frames of AI run without throwing, hit spheres report headshots, and a ragdoll
  settles without tunnelling through the floor.

## Deployment (GitHub Pages)

The repo ships a workflow at `.github/workflows/pages.yml`. Push to `main`, then in
**Settings → Pages** set the source to **GitHub Actions**. The build uses a relative
base, so the game works from `https://<user>.github.io/<repo>/` without changes.

Prefer a single file? Run `npm run build:single` and upload
`dist/dustline-single.html` anywhere — itch.io, a static host, or a USB stick.

## How the procedural assets work

| Layer | File | Idea |
| --- | --- | --- |
| Textures | `src/world/Textures.js` | A value/worley noise kit bakes albedo, normal (from a height field via Sobel) and packed ORM maps per material — concrete, plaster, asphalt, sand, dirt, brick, wood, rust, camo, foliage… — into `DataTexture`s with anisotropic filtering. |
| Models | `src/world/ModelKit.js` | A small CAD-ish kit (`PartBuilder`, rounded boxes, cylinders, spheres, wedges) so shapes can be composed, merged per material, and reused across the level, weapons and characters. |
| Level | `src/world/Level.js` | A compound of walls, buildings, containers, sandbags and dunes assembled from the kit, merged into a handful of static meshes, with OBB colliders, spawn points and cover points emitted alongside. |
| Weapons | `src/world/WeaponModels.js` | Receiver/handguard/stock/optic/action assemblies with named nodes (`muzzle`, `ejectPort`, `magazine`, `bolt`, `slide`). |
| Characters | `src/world/CharacterModel.js` | The 25-bone soldier rig, its gear (plate carrier, helmet, NVG mount, pouches), and the first-person gloved hands. |
| Audio | `src/audio/Audio.js` | WebAudio graph synthesis: noise bursts through envelopes and filters, modal bodies, tail reverb, distance falloff. |

## Project layout

```
index.html                 markup + UI styling (menus, HUD, settings)
src/
  main.js                  bootstrap: engine, game, menu wiring, frame loop
  core/                    engine (renderer/lights/IBL), input, settings, maths helpers
  world/                   textures, model kit, weapons, characters, level, collision
  entities/                player, weapon system, enemies (AI + animation + ragdoll)
  fx/                      particles, decals, post-processing chain
  audio/                   procedural audio
  ui/                      HUD and menus
  game/                    game loop, waves, scoring
test/smoke.mjs             headless assertions
tools/bundle-single.mjs    inlines the build into a single HTML file
```

## Notes

- One static draw-call-friendly scene: the level is merged per material and lit by a
  handful of lights plus image-based lighting; expect GPU-bound performance on
  integrated graphics at *high*, so drop the preset if needed.
- The simulation is fixed-cost per frame — entities are pooled, particles are budgeted
  by the quality preset, and corpses are retired.
- Requires WebGL2, which every current desktop and mobile browser ships.

## License

MIT — see [LICENSE](LICENSE).
