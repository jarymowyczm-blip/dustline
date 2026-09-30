/**
 * WeaponSystem.js — weapons, viewmodel animation and ballistics.
 *
 * The viewmodel lives on its own render layer and is drawn by a narrow-FOV
 * camera after the world, so it never clips into geometry.
 *
 * Ballistics are hitscan with real material penetration: a bullet that strikes
 * a surface finds the exit point by re-casting past the entry face, computes the
 * thickness crossed, and continues only if its penetration budget covers
 * `density × thickness`. Damage falls off with distance and with each layer of
 * material, and per-part multipliers drive headshots.
 */

import * as THREE from 'three';
import { buildCarbine, buildAKM, buildPistol, createWeaponMaterials } from '../world/WeaponModels.js';
import { createCharacterMaterials, buildFPHands } from '../world/CharacterModel.js';
import { LAYER_VIEWMODEL } from '../core/Engine.js';
import { SURFACE } from '../world/Collision.js';
import { clamp, clamp01, damp, lerp, rand, randInt, sign, Spring, smoothstep, makeRng } from '../core/Utils.js';

const HIP_POS = new THREE.Vector3(0.155, -0.150, -0.30);
const HIP_ROT = new THREE.Euler(0.02, 0.10, 0.02);

export const WEAPONS = {
  carbine: {
    key: 'carbine', name: 'M4A1 CARBINE', caliber: '5.56×45 NATO',
    mode: 'auto', rpm: 780, damage: 33, headMult: 3.0, limbMult: 0.68,
    muzzleVel: 880, magSize: 30, reserve: 240, maxReserve: 360,
    reloadTac: 2.05, reloadEmpty: 3.05, reloadStyle: 'ar',
    adsTime: 0.20, adsFovScale: 0.66, adsSens: 0.85,
    spreadBase: 0.55, spreadPerShot: 0.30, spreadDecay: 3.6, spreadMax: 4.6,
    recoil: { pitch: 0.0105, yaw: 0.0034, roll: 0.006, kick: 3.2, pattern: 'ar' },
    penetration: 0.088, bulletMass: 4.0, weight: 1.0,
    tracerEvery: 1, tracerColor: 0xffd08a,
    build: buildCarbine, hands: { rightPos: [0.028, -0.115, 0.075], rightRot: [0.30, 0.18, 0.10], leftPos: [-0.035, -0.085, -0.255], leftRot: [0.18, -0.6, -0.15] },
    sounds: { shot: 'shot556', suppressed: false },
  },
  akm: {
    key: 'akm', name: 'AKM RIFLE', caliber: '7.62×39 mm',
    mode: 'auto', rpm: 600, damage: 47, headMult: 2.6, limbMult: 0.72,
    muzzleVel: 715, magSize: 30, reserve: 180, maxReserve: 300,
    reloadTac: 2.35, reloadEmpty: 3.4, reloadStyle: 'ak',
    adsTime: 0.26, adsFovScale: 0.70, adsSens: 0.85,
    spreadBase: 1.15, spreadPerShot: 0.42, spreadDecay: 3.0, spreadMax: 6.4,
    recoil: { pitch: 0.0175, yaw: 0.0058, roll: 0.011, kick: 4.4, pattern: 'ak' },
    penetration: 0.105, bulletMass: 7.9, weight: 0.85,
    tracerEvery: 1, tracerColor: 0xffbb55,
    build: buildAKM, hands: { rightPos: [0.030, -0.120, 0.085], rightRot: [0.28, 0.20, 0.08], leftPos: [-0.035, -0.070, -0.245], leftRot: [0.20, -0.5, -0.20] },
    sounds: { shot: 'shot762', suppressed: false },
  },
  pistol: {
    key: 'pistol', name: 'M9 SIDEARM', caliber: '9×19 mm',
    mode: 'semi', rpm: 420, damage: 27, headMult: 2.4, limbMult: 0.75,
    muzzleVel: 380, magSize: 15, reserve: 60, maxReserve: 120,
    reloadTac: 1.65, reloadEmpty: 2.25, reloadStyle: 'pistol',
    adsTime: 0.16, adsFovScale: 0.80, adsSens: 0.9,
    spreadBase: 0.85, spreadPerShot: 0.55, spreadDecay: 4.2, spreadMax: 5.5,
    recoil: { pitch: 0.016, yaw: 0.0045, roll: 0.008, kick: 3.0, pattern: 'pistol' },
    penetration: 0.055, bulletMass: 8.0, weight: 0.7,
    tracerEvery: 3, tracerColor: 0xffcc88,
    build: buildPistol, hands: { rightPos: [0.020, -0.105, 0.085], rightRot: [0.26, 0.14, 0.06] },
    sounds: { shot: 'shot9mm', suppressed: false },
  },
};

/* Recoil ladders — the first shots are the most predictable, then it wanders. */
const RECOIL_PATTERNS = {
  ar: [[0, 1], [0.15, 1.12], [-0.2, 1.2], [0.3, 1.25], [-0.35, 1.3], [0.5, 1.34], [-0.55, 1.36],
    [0.7, 1.4], [-0.75, 1.42], [0.85, 1.45], [-0.9, 1.46], [1.0, 1.48], [1.05, 1.5]],
  ak: [[0, 1.15], [-0.4, 1.3], [0.5, 1.42], [-0.6, 1.5], [0.7, 1.6], [-0.8, 1.68], [0.9, 1.74],
    [-1.0, 1.8], [1.1, 1.85], [-1.15, 1.9]],
  pistol: [[0.2, 1], [-0.3, 1.05], [0.4, 1.1], [-0.5, 1.15]],
};

export class WeaponSystem {
  constructor(engine, level, materials, audio, particles, settings, player, game) {
    this.engine = engine;
    this.level = level;
    this.colliders = level.colliders;
    this.settings = settings;
    this.audio = audio;
    this.particles = particles;
    this.player = player;
    this.game = game;

    this.M = createWeaponMaterials(materials);
    this.charMats = createCharacterMaterials(this.M);

    this.rig = new THREE.Object3D();
    this.rig.name = 'viewmodelRig';
    engine.viewmodelCamera.add(this.rig);

    this.slots = {
      1: { key: 'carbine', ammo: {}, },
      2: { key: 'akm', ammo: {} },
      3: { key: 'pistol', ammo: {} },
    };
    this.current = null;
    this.models = new Map();
    this.rng = makeRng(88117);

    // animation springs
    this.kickZ = new Spring(0, 220, 22);
    this.kickPitch = new Spring(0, 200, 18);
    this.swayX = new Spring(0, 90, 12);
    this.swayY = new Spring(0, 90, 12);
    this.bobX = new Spring(0, 60, 10);
    this.bobY = new Spring(0, 60, 10);
    this.reloadBlend = 0;
    this.adsBlend = 0;
    this.sprintBlend = 0;
    this.inspectBlend = 0;

    this.ammo = {};       // key → { mag, reserve }
    this.equippedKey = null;
    this.fireCooldown = 0;
    this.shotsInBurst = 0;
    this.burstQueue = 0;
    this.reloading = false;
    this.reloadTime = 0;
    this.reloadDuration = 1;
    this.reloadIsEmpty = false;
    this.reloadPhase = 0;
    this.spread = 0;
    this.heat = 0;
    this.triggerWasDown = false;
    this.burstHeld = false;
    this.adsHeld = false;
    this.adsLatched = false;
    this.lastShotTime = -99;
    this.shotIndex = 0;
    this.caseTimer = 0;
    this.magNode = null;
    this.boltNode = null;
    this.chargingNode = null;
    this.muzzleNode = null;
    this.ejectNode = null;
    this.muzzleFlash = null;
    this.muzzleLight = new THREE.PointLight(0xffd9a0, 0, 9, 2);
    this.muzzleLight.layers.enable(LAYER_VIEWMODEL);
    this.rig.add(this.muzzleLight);
    this.tracerCounter = 0;
    this.autoMode = true;      // M4 has a select-fire switch; V toggles semi
    this.inspectTime = 0;
    this.flashTimer = 0;
    this.caseTimer = 0;
    this.grenades = 2;
    this.medkits = 2;
    this.healTimer = 0;
    this.healDuration = 0;
    this.grenadeCook = 0;

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._hipPos = HIP_POS.clone();
    this._hipRot = HIP_ROT.clone();
    this._adsPos = new THREE.Vector3();
  }

  /* ------------------------------------------------------------- inventory */

  get def() { return WEAPONS[this.equippedKey]; }

  equip(key, silent = false) {
    if (!key || !WEAPONS[key]) return;
    if (this.equippedKey === key) return;
    const model = this._getModel(key);
    for (const [, m] of this.models) m.group.visible = false;
    model.group.visible = true;

    this.equippedKey = key;
    this.magNode = model.nodes.magazine || null;
    this.boltNode = model.nodes.bolt || null;
    this.chargingNode = model.nodes.charging || null;
    this.muzzleNode = model.nodes.muzzle || null;
    this.ejectNode = model.nodes.ejectPort || null;
    this.sightLocal = model.adsOffset.clone();

    if (!this.ammo[key]) this.ammo[key] = { mag: WEAPONS[key].magSize, reserve: WEAPONS[key].reserve };
    this.spread = WEAPONS[key].spreadBase;
    this.reloading = false;
    this.reloadBlend = 0;
    this.shotIndex = 0;
    this.adsBlend = 0;

    // Snap the animation pose so swapping doesn't slide across the screen.
    this.swapBlend = 1;
    if (!silent) this.audio?.play(this.def.key === 'pistol' ? 'drawPistol' : 'drawRifle', { pos: this.player.pos });
  }

  _getModel(key) {
    if (this.models.has(key)) return this.models.get(key);
    const def = WEAPONS[key];
    const built = def.build(this.M);
    const group = new THREE.Group();
    group.add(built.group);

    const hands = buildFPHands(this.charMats, def.hands);
    group.add(hands);

    // Everything on the viewmodel layer, casting shadows on the world only.
    group.traverse((o) => {
      o.layers.set(LAYER_VIEWMODEL);
      if (o.isMesh) {
        o.castShadow = false;      // the weapon is held above the shadow camera's interest
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });

    this.rig.add(group);
    const model = { group, nodes: built.nodes, adsOffset: built.adsOffset, dot: built.dot, hands };
    this.models.set(key, model);
    return model;
  }

  /* ---------------------------------------------------------------- input */

  wantsAds() {
    const key = this.equippedKey;
    if (!key) return false;
    if (this.def.key === 'pistol' && this.reloading) return false;
    if (this.settings.get('adsMode') === 'toggle') {
      if (this.adsLatched) return true;
      return this.adsHeld && false;
    }
    return this.adsHeld;
  }

  get isAiming() { return this.adsBlend > 0.55; }
  get canFire() {
    return !this.reloading && this.healTimer <= 0 && this.player.alive &&
      this.ammo[this.equippedKey]?.mag > 0;
  }

  update(dt, input, game) {
    if (!this.equippedKey) this.equip('carbine', true);
    const def = this.def;
    const ammo = this.ammo[this.equippedKey];

    /* ---- weapon switching --------------------------------------------- */
    for (const [slot, num] of [[1, 'Digit1'], [2, 'Digit2'], [3, 'Digit3']]) {
      if (input.down(`slot${slot}`)) this.equip(this.slots[slot].key);
    }
    if (input.mouse.wheel !== 0) {
      const order = ['carbine', 'pistol', 'akm'];
      const i = order.indexOf(this.equippedKey);
      const next = order[(i + (input.mouse.wheel > 0 ? 1 : order.length - 1)) % order.length];
      this.equip(next);
    }
    if (input.down('firemode') && (def.key === 'carbine' || def.key === 'akm')) {
      this.autoMode = !this.autoMode;
      this.audio?.play('selector', { pos: this.player.pos });
    }
    if (input.down('inspect')) this.inspectTime = 1.6;

    /* ---- aim ----------------------------------------------------------- */
    if (this.settings.get('adsMode') === 'toggle') {
      if (input.mousePressed(2)) this.adsLatched = !this.adsLatched;
      this.adsHeld = this.adsLatched;
    } else {
      this.adsHeld = input.mouseDown(2);
    }
    const wantAds = this.wantsAds() && !this.reloading;
    const adsRate = wantAds ? 1 / Math.max(0.06, def.adsTime) : 1 / Math.max(0.06, def.adsTime * 0.75);
    this.adsBlend = clamp01(this.adsBlend + (wantAds ? dt * adsRate : -dt * adsRate));

    /* ---- fire ---------------------------------------------------------- */
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    // Firing works from the hip and while aiming — but not while sprinting or
    // mid-reload, and never while the operator is dead.
    const canPullTrigger = this.player.alive && !this.player.sprinting && this.healTimer <= 0;
    const triggerDown = input.mouseDown(0) && canPullTrigger;
    const triggerPressed = input.mousePressed(0) && canPullTrigger;

    const mode = def.key === 'carbine' && !this.autoMode ? 'semi' : def.mode;
    if (mode === 'auto') {
      if (triggerDown && !this.reloading && this.healTimer <= 0) this._tryFire(game);
    } else if (mode === 'semi') {
      if (triggerPressed && !this.reloading) this._tryFire(game);
    } else if (mode === 'burst') {
      if (triggerPressed) this.burstQueue = 3;
      if (this.burstQueue > 0 && this.fireCooldown <= 0 && !this.reloading) {
        this._fire(game);
        this.burstQueue--;
      }
    }

    /* ---- reload -------------------------------------------------------- */
    if (input.down('reload')) this.startReload();
    if (this.reloading) {
      this.reloadTime += dt;
      const t = clamp01(this.reloadTime / this.reloadDuration);
      this.reloadPhase = t;
      if (t >= 1) this._finishReload();
    }
    if (ammo.mag === 0 && !this.reloading && this.fireCooldown <= 0) {
      // auto-reload on empty
      this.startReload();
    }

    /* ---- grenade + medkit --------------------------------------------- */
    if (input.down('grenade') && this.grenades > 0 && !this.reloading) {
      this.grenades--;
      game?.throwGrenade?.();
      this.audio?.play('grenadeThrow', { pos: this.player.pos });
      this._kick(0.6, 0.4);
    }
    if (input.down('medkit') && this.medkits > 0 && this.healTimer <= 0) {
      this.medkits--;
      this.healTimer = 2.0;
      this.healDuration = 2.0;
      this.audio?.play('medkit', { pos: this.player.pos });
    }
    if (this.healTimer > 0) {
      this.healTimer -= dt;
      this.player.heal(70 * dt / this.healDuration);
    }

    /* ---- spread + heat ------------------------------------------------- */
    this.spread = damp(this.spread, def.spreadBase, def.spreadDecay, dt);
    this.heat = Math.max(0, this.heat - dt * 0.6);

    /* ---- viewmodel pose ------------------------------------------------ */
    this._animate(dt, input);
  }

  /** True while the weapon may not be fired (reloading, healing, dead). */
  _tryFire(game) {
    if (!this.canFire) {
      if (!this.reloading && this.player.alive && this.ammo[this.equippedKey].mag === 0) {
        this.audio?.play('dryFire', { pos: this.player.pos });
        this.fireCooldown = 0.18;
      }
      return;
    }
    if (this.fireCooldown > 0.001) return;
    this.spread = Math.min(this.def.spreadMax, this.spread + this.def.spreadPerShot);
    if (this.reloadBlend > 0) return;
    this._fire(game);
  }

  _fire(game) {
    const def = this.def;
    const ammo = this.ammo[this.equippedKey];
    const player = this.player;

    ammo.mag--;
    this.fireCooldown = 60 / def.rpm;
    this.shotIndex++;
    player.shotsFired++;
    this.lastShotTime = performance.now() / 1000;
    this.tracerCounter++;

    /* ---- direction: cone spread from camera + movement inaccuracy ------ */
    const cam = this.engine.camera;
    cam.getWorldDirection(this._fwd);
    this._quat.copy(cam.quaternion);

    const inacc = player.currentInaccuracy() + (this.spread * Math.PI / 180) * lerp(1, 0.28, this.adsBlend);
    {
      // Uniformly-distributed cone offset (sqrt keeps the pattern round).
      const a = this.rng.range(0, Math.PI * 2);
      const r = Math.sqrt(this.rng.next()) * inacc;
      this._right.set(1, 0, 0).applyQuaternion(this._quat);
      this._tmp2.set(0, 1, 0).applyQuaternion(this._quat);
      this._fwd.addScaledVector(this._right, Math.cos(a) * r).addScaledVector(this._tmp2, Math.sin(a) * r).normalize();
    }

    const origin = this._tmp.copy(cam.position)
      .addScaledVector(this._right.set(1, 0, 0).applyQuaternion(this._quat), 0.06);

    /* ---- recoil -------------------------------------------------------- */
    const pat = RECOIL_PATTERNS[def.recoil.pattern];
    const idx = Math.min(this.shotIndex - 1, pat.length - 1);
    const [wander, climb] = pat[idx];
    const adsScale = lerp(1, 0.62, this.adsBlend);
    const kickPitch = def.recoil.pitch * climb * (1 + (player.speed / 6) * 0.35) * adsScale;
    const kickYaw = def.recoil.yaw * (wander + this.rng.range(-0.35, 0.35)) * adsScale;
    player.addRecoil(kickPitch, kickYaw, def.recoil.roll * (this.equippedKey === 'akm' ? 1 : 1.1));
    this._kick(def.recoil.kick, kickPitch * 60);

    /* ---- audio + fx ---------------------------------------------------- */
    this.audio?.play(def.sounds.shot, {
      pos: player.pos, weapon: def.key, ads: this.adsBlend,
      wet: this._indoorFactor(),
    });
    if (this.muzzleNode) {
      const mp = this.muzzleNode.getWorldPosition(new THREE.Vector3());
      const md = this._tmp2.copy(this._fwd);
      this.particles?.muzzleFlash(mp, md, def.key === 'pistol' ? 0.7 : 1.0, def.muzzleVel);
      this.muzzleLight.position.copy(this.rig.worldToLocal(mp.clone()));
      this.muzzleLight.intensity = def.key === 'pistol' ? 6 : 11;
      this.muzzleLight.distance = def.key === 'pistol' ? 6 : 12;
      this.flashTimer = 0.035;
    }
    this.caseTimer = 0.02;

    /* ---- ballistics ---------------------------------------------------- */
    this._trace(game, origin, this._fwd.clone(), def);

    /* ---- projectile smoke trail on rapid fire -------------------------- */
    if (this.tracerCounter % (def.tracerEvery || 1) === 0) {
      this.particles?.tracer(origin.clone(), this._fwd.clone(), def.tracerColor, this.adsBlend > 0.5 ? 0.75 : 1);
    }
    if (this.heat > 0.55) {
      this.particles?.barrelSmoke(this.muzzleNode, this._fwd, this.heat);
    }
    this.heat = Math.min(1.4, this.heat + 0.22);
  }

  /** Rough "indoors" test used to muffle the gunshot tail. */
  _indoorFactor() {
    const p = this.player.pos;
    // Is there geometry within 3.5 m in most directions? Cheap approximation:
    const up = this.colliders.raycast(this._tmp.set(p.x, p.y + 1.6, p.z), this._tmp2.set(0, 1, 0), 6);
    return up ? 0.75 : 0.0;
  }

  /**
   * Hitscan with material penetration.
   * Walks up to three layers: entry/exit thickness, density and the weapon's
   * penetration budget decide whether the round keeps going.
   */
  _trace(game, origin, dir, def) {
    let damage = def.damage * (1 + this.rng.range(-0.04, 0.04));
    let budget = def.penetration * (1 - this.adsBlend * 0.0);
    const originPoint = origin.clone();
    let travel = 0;
    const maxRange = def.key === 'pistol' ? 120 : 320;
    const used = new Set();
    let hitSomething = false;
    this._hitEnemy = false;

    for (let layer = 0; layer < 3; layer++) {
      const maxDist = maxRange - travel;
      if (maxDist <= 0.2) break;

      const levelHit = this.colliders.raycast(origin, dir, maxDist, {
        ignoreTransparent: true,
        filter: (b) => !used.has(b),
      });
      const enemyHit = game?.hitTestEnemies?.(origin, dir, levelHit ? Math.min(maxDist, levelHit.distance) : maxDist, this._tmp2) || null;

      if (enemyHit && (!levelHit || enemyHit.distance <= levelHit.distance)) {
        game.applyEnemyDamage(enemyHit.enemy, damage, enemyHit, this.player, def);
        hitSomething = true;
        this._hitEnemy = true;
        break;   // rounds stop in a body
      }

      if (!levelHit) break;

      travel += levelHit.distance;
      const surf = SURFACE[levelHit.box.surface] || SURFACE.concrete;
      this.particles?.impact(levelHit.point, levelHit.normal, levelHit.box.surface, dir, surf, 1);
      this.audio?.play(`impact_${surf.sound}`, {
        pos: levelHit.point, surface: levelHit.box.surface,
        distance: travel,
      });

      // ---- penetration: find the exit face of this box -------------------
      used.add(levelHit.box);
      const inside = levelHit.point.clone().addScaledVector(dir, 0.008);
      const exit = this.colliders.raycast(inside, dir, maxDist - levelHit.distance, {
        filter: (b) => b === levelHit.box,
      });

      // Real thickness: distance from entry to exit along the fired line.
      const trueThickness = exit
        ? Math.max(0.01, exit.point.distanceTo(levelHit.point) * levelHit.box.penetrationScale)
        : 0.35 * levelHit.box.penetrationScale;

      const cost = surf.density * trueThickness;
      if (cost > budget) {
        // Stopped: spawn a small dust puff on the back face too.
        if (exit) this.particles?.impactBack(exit.point, dir, levelHit.box.surface, surf);
        break;
      }
      budget -= cost;
      // bullets lose energy punching through material
      damage *= clamp(1 - cost / (def.penetration * 2.4), 0.35, 0.95) * 0.92;
      travel += trueThickness;
      origin = exit ? exit.point.clone().addScaledVector(dir, 0.01)
        : levelHit.point.clone().addScaledVector(dir, 0.25);
      if (exit) this.particles?.impact(exit.point, dir.clone().negate(), levelHit.box.surface, dir, surf, 0.6);
    }

    if (this._hitEnemy) this.player.shotsHit++;
  }

  /* ------------------------------------------------------------- reloading */

  startReload() {
    if (this.reloading || !this.player.alive) return;
    const def = this.def;
    const ammo = this.ammo[this.equippedKey];
    if (ammo.mag >= def.magSize || ammo.reserve <= 0) return;
    this.reloading = true;
    this.reloadIsEmpty = ammo.mag === 0;
    this.reloadTime = 0;
    this.reloadDuration = this.reloadIsEmpty ? def.reloadEmpty : def.reloadTac;
    this.reloadPhase = 0;
    this._playedPhases = new Set();
    this.audio?.play('reloadStart', { pos: this.player.pos, weapon: def.key });
  }

  _finishReload() {
    const def = this.def;
    const ammo = this.ammo[this.equippedKey];
    const need = def.magSize - ammo.mag;
    const take = Math.min(need, ammo.reserve);
    ammo.mag += take;
    ammo.reserve -= take;
    this.reloading = false;
    this.reloadBlend = 0;
    this.shotIndex = 0;
    this.audio?.play('reloadEnd', { pos: this.player.pos, weapon: def.key });
  }

  /** Fire the foley cues at the right points in the reload timeline. */
  _reloadAudio(phase) {
    const set = this._playedPhases || (this._playedPhases = new Set());
    const cue = (t, name, opts) => {
      if (phase >= t && !set.has(name)) { set.add(name); this.audio?.play(name, { pos: this.player.pos, ...opts }); }
    };
    cue(0.02, 'magRelease');
    cue(0.18, 'magOut');
    cue(0.52, 'magIn');
    cue(0.62, 'magTap');
    if (this.reloadIsEmpty) { cue(0.72, 'boltBack'); cue(0.80, 'boltRelease'); }
    if (this.reloadStyle === 'ar' && !this.reloadIsEmpty) cue(0.74, 'boltTap');
    cue(0.92, 'shoulderWeapon');
  }

  /* ------------------------------------------------------------ viewmodel */

  _kick(back, pitch) {
    this.kickZ.kick(-back * 0.09);
    this.kickPitch.kick(pitch * 0.0016 + 0.9);
  }

  _animate(dt, input) {
    const def = this.def;
    const player = this.player;
    const rig = this.rig;
    const t = performance.now() / 1000;

    /* ---- look sway: the weapon lags behind the camera ------------------- */
    if (this.settings.get('sway')) {
      this.swayY.kick(clamp(-input.mouse.dx * 0.00035, -0.05, 0.05));
      this.swayX.kick(clamp(-input.mouse.dy * 0.00030, -0.05, 0.05));
    }
    this.swayY.update(dt); this.swayX.update(dt);

    /* ---- movement bob --------------------------------------------------- */
    const speed = player.speed;
    const bobAmt = this.settings.get('bob') ? clamp01(speed / 6) : 0;
    this.bobPhase = player.bobPhase;
    this.bobX.set(Math.sin(this.bobPhase) * 0.012 * bobAmt * lerp(1, 0.4, this.adsBlend));
    this.bobY.set(Math.abs(Math.sin(this.bobPhase * 2)) * -0.010 * bobAmt * lerp(1, 0.35, this.adsBlend));
    this.bobX.update(dt); this.bobY.update(dt);

    /* ---- sprint / inspect blends ---------------------------------------- */
    const wantSprint = player.sprinting && this.adsBlend < 0.1;
    this.sprintBlend = damp(this.sprintBlend, wantSprint ? 1 : 0, 9, dt);
    if (this.inspectTime > 0) this.inspectTime -= dt;
    this.inspectBlend = damp(this.inspectBlend, this.inspectTime > 0 ? 1 : 0, 7, dt);

    /* ---- reload blend --------------------------------------------------- */
    if (this.reloading) {
      const p = this.reloadPhase;
      // ease in, hold, ease out
      this.reloadBlend = smoothstep(0, 0.12, p) * (1 - smoothstep(0.88, 1.0, p));
      this._reloadAudio(p);
    } else {
      this.reloadBlend = damp(this.reloadBlend, 0, 14, dt);
    }

    /* ---- springs -------------------------------------------------------- */
    this.kickZ.update(dt);
    this.kickPitch.update(dt);

    /* ---- muzzle light decay --------------------------------------------- */
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.muzzleLight.intensity = 0;
    }
    if (this.caseTimer > 0) {
      this.caseTimer -= dt;
      if (this.caseTimer <= 0 && this.ejectNode) {
        this.particles?.ejectCasing(this.ejectNode, player.vel, def.key);
      }
    }

    /* ---- build the pose -------------------------------------------------- */
    // Hip-fire anchor
    const hip = this._tmp.set(
      HIP_POS.x + this.bobX.value + this.swayX.value * 0.35,
      HIP_POS.y + this.bobY.value + this.swayY.value * 0.35,
      HIP_POS.z + this.kickZ.value * 0.6,
    );

    // Aim-down-sights anchor: put the sight axis on the camera's centre line.
    const sl = this.sightLocal;
    this._adsPos.set(-sl.x, -sl.y - 0.0, -0.30 - sl.z);

    const blend = smoothstep(0, 1, this.adsBlend);
    rig.position.lerpVectors(hip, this._adsPos, blend);

    const hipRotX = HIP_ROT.x + this.swayX.value * 2.2;
    const hipRotY = HIP_ROT.y + this.swayY.value * 2.2;
    const hipRotZ = HIP_ROT.z;
    let rotX = lerp(hipRotX, 0, blend);
    let rotY = lerp(hipRotY, 0, blend);
    let rotZ = lerp(hipRotZ, 0, blend);

    /* ---- recoil kick ---------------------------------------------------- */
    rotX += this.kickPitch.value * 0.35;
    rig.position.z += this.kickZ.value * 0.4;

    /* ---- sprint pose: weapon lowered and rolled out --------------------- */
    if (this.sprintBlend > 0.001) {
      const s = this.sprintBlend;
      const bobS = Math.sin(this.bobPhase * 2) * 0.02;
      rig.position.x += s * 0.05;
      rig.position.y += s * (-0.12 + bobS);
      rig.position.z += s * 0.06;
      rotX += s * 0.35;
      rotY += s * -0.55;
      rotZ += s * 0.45;
    }

    /* ---- inspect: tilt the weapon to show the left side ----------------- */
    if (this.inspectBlend > 0.001) {
      const s = this.inspectBlend;
      rotY += s * 0.85;
      rotX += s * -0.25;
      rotZ += s * 0.35;
      rig.position.y += s * -0.02;
    }

    /* ---- reload choreography -------------------------------------------- */
    if (this.reloadBlend > 0.001) {
      const p = this.reloadPhase;
      const rb = this.reloadBlend;
      // tilt toward the shooter
      rotX += rb * 0.28;
      rotY += rb * -0.30;
      rotZ += rb * 0.55;
      rig.position.y += rb * -0.05;
      rig.position.x += rb * -0.03;

      // magazine path
      if (this.magNode) {
        if (this.reloadStyle === 'pistol') {
          const outT = smoothstep(0.05, 0.35, p);
          const inT = smoothstep(0.45, 0.75, p);
          this.magNode.position.y = lerp(-0.110, -0.42, outT) + lerp(0, 0.31, inT);
          this.magNode.visible = true;
        } else {
          const drop = smoothstep(0.10, 0.30, p);
          const rise = smoothstep(0.38, 0.62, p);
          this.magNode.visible = !(drop > 0.98 && rise < 0.02);
          this.magNode.position.y = lerp(-0.052, -0.55, drop) + lerp(0, 0.50, rise);
          this.magNode.rotation.z = Math.sin(drop * 6) * 0.25 * (1 - rise);
        }
      }
      // charging handle / bolt manipulation on an empty reload
      if (this.reloadIsEmpty && this.equippedKey !== 'pistol') {
        const pull = smoothstep(0.66, 0.74, p) * (1 - smoothstep(0.78, 0.88, p));
        if (this.chargingNode) this.chargingNode.position.z = 0.098 + pull * 0.085;
        if (this.boltNode) this.boltNode.position.z = pull * 0.07;
      } else if (this.boltNode && this.equippedKey === 'pistol') {
        // slide release after a tactical reload
        const pull = smoothstep(0.68, 0.76, p) * (1 - smoothstep(0.78, 0.86, p));
        this.boltNode.position.z = pull * 0.03;
      }
    } else if (this.magNode) {
      // idle magazine position
      const base = this.equippedKey === 'pistol' ? -0.110 : this.equippedKey === 'akm' ? -0.042 : -0.052;
      this.magNode.position.y = damp(this.magNode.position.y, base, 16, dt);
      this.magNode.rotation.z = damp(this.magNode.rotation.z, 0, 12, dt);
      this.magNode.visible = true;
      if (this.chargingNode && this.equippedKey === 'carbine') this.chargingNode.position.z = damp(this.chargingNode.position.z, 0.098, 14, dt);
      if (this.boltNode) this.boltNode.position.z = damp(this.boltNode.position.z, 0, 14, dt);
      if (this.boltNode && this.boltNode.rotation) this.boltNode.rotation.x = damp(this.boltNode.rotation.x, 0, 12, dt);
    }

    /* ---- fire cycling: bolt/slide animation ----------------------------- */
    if (!this.reloading) {
      const cycle = clamp01(1 - this.fireCooldown / Math.max(0.02, 60 / def.rpm));
      if (this.fireCooldown > 0.002 && this.equippedKey === 'pistol' && this.boltNode) {
        this.boltNode.position.z = (1 - cycle) * 0.028;
      }
    }

    /* ---- apply ----------------------------------------------------------- */
    rig.rotation.set(rotX, rotY, rotZ);
    rig.position.z += 0;   // (kick already applied above)

    // Keep the viewmodel camera glued to the world camera every frame.
    const cam = this.engine.camera;
    this.engine.viewmodelCamera.position.copy(cam.position);
    this.engine.viewmodelCamera.quaternion.copy(cam.quaternion);
  }

  /* ---------------------------------------------------------------- state */

  getState() {
    const def = this.def;
    const ammo = this.ammo[this.equippedKey] || { mag: 0, reserve: 0 };
    return {
      name: def.name, caliber: def.caliber,
      mode: def.key === 'carbine' && !this.autoMode ? 'SEMI' : def.mode.toUpperCase(),
      mag: ammo.mag, reserve: ammo.reserve, magSize: def.magSize,
      reloading: this.reloading,
      reloadProgress: this.reloading ? clamp01(this.reloadTime / this.reloadDuration) : 0,
      grenades: this.grenades, medkits: this.medkits,
      spread: this.spread,
      ads: this.adsBlend,
      healing: this.healTimer > 0,
    };
  }

  addAmmo(fraction = 0.5) {
    const def = this.def;
    const ammo = this.ammo[this.equippedKey];
    ammo.reserve = Math.min(def.maxReserve, ammo.reserve + Math.round(def.magSize * 3 * fraction));
    if (this.grenades < 4 && Math.random() < 0.4) this.grenades++;
  }
}
