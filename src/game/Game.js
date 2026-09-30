/**
 * Game.js — the orchestrator.
 *
 * Owns the world, the player, weapons, enemies, waves and every gameplay
 * system, and runs the fixed-order update loop:
 *
 *   input → player → weapon → enemies → projectiles/pickups → fx → hud
 *
 * Two modes: an endless survival wave defence at the compound, and a training
 * range with steel targets and unlimited ammunition.
 */

import * as THREE from 'three';
// The engine is created by main.js (materials must be baked against a live
// renderer first) and handed in here.
import { Player } from '../entities/Player.js';
import { WeaponSystem, WEAPONS } from '../entities/WeaponSystem.js';
import { EnemyPool } from '../entities/Enemy.js';
import { Environment } from '../world/Environment.js';
import { Level } from '../world/Level.js';
import { ParticleSystem } from '../fx/Particles.js';
import { AudioEngine } from '../audio/Audio.js';
import { HUD } from '../ui/HUD.js';
import { clamp, clamp01, damp, fmt, lerp, rand, randInt, smoothstep, TAU } from '../core/Utils.js';

export class Game {
  constructor(engine, canvas, settings, materials, audio) {
    this.settings = settings;
    this.audio = audio;
    this.materials = materials;
    this.canvas = canvas;

    this.engine = engine;
    this.scene = engine.scene;
    this.camera = engine.camera;

    this.level = new Level(this.scene, materials, settings);
    this.level.build();

    this.environment = new Environment(this.scene, this.engine.renderer, settings);
    this.environment.setShadowQuality(settings.get('shadows'));
    this.engine.shareLightsWithViewmodel();

    this.particles = new ParticleSystem(this.scene, materials, settings, this.level.colliders);

    this.player = new Player(this.camera, this.level, audio, settings);
    this.weapon = new WeaponSystem(this.engine, this.level, materials, audio, this.particles, settings, this.player, this);
    this.enemies = new EnemyPool(this, materials, audio, this.particles, settings);

    this.hud = new HUD(settings);

    // gameplay state
    this.mode = 'survival';
    this.time = 0;
    this.wave = 0;
    this.intermission = 0;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.score = 0;
    this.kills = 0;
    this.running = false;
    this.paused = false;
    this.dead = false;
    this.grenades = [];
    this.pickups = [];
    this.targets = [];
    this.lastPlayerShot = -99;
    this.stats = {
      fps: 0, kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0,
      distance: 0, wave: 0, score: 0, timeLabel: '0:00',
    };
    this.hitMarker = { show: null };

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    /* ---- hooks --------------------------------------------------------- */
    this.player.onDamage = (amount, fromPos) => {
      this.hud.flashDamage();
      if (fromPos) this.hud.damageDirection(fromPos, this.player.pos, this.camera);
      this.audio?.play('grunt', { pos: this.player.pos });
    };
    this.player.onDeath = () => this.onPlayerDeath();
    this.player.onFootstep = (surface) => {
      // kick a little dust behind the player when sprinting
      if (this.player.sprinting) {
        const p = this._v.copy(this.player.pos);
        this.particles.smoke.spawn({
          pos: p, vel: new THREE.Vector3(rand(-0.5, 0.5), rand(0.3, 0.9), rand(-0.5, 0.5)),
          color: { r: 0.72, g: 0.66, b: 0.5, a: 0.24 },
          size: 0.1, size1: 0.5, life: rand(0.4, 0.8), drag: 2, gravity: -0.4,
        });
      }
    };
  }

  /* ------------------------------------------------------------- lifecycle */

  start(mode = 'survival') {
    this.mode = mode;
    this.time = 0;
    this.wave = 0;
    this.intermission = 2.5;
    this.spawnQueue.length = 0;
    this.score = 0;
    this.kills = 0;
    this.dead = false;
    this.paused = false;
    this.running = true;
    this.enemies.clear();
    this.particles.clear();
    for (const g of this.grenades) g.mesh.visible = false;
    this.grenades.length = 0;
    for (const p of this.pickups) this.scene.remove(p.mesh);
    this.pickups.length = 0;
    for (const t of this.targets) { this.scene.remove(t.mesh); }
    this.targets.length = 0;

    const spawn = this.level.playerSpawn;
    this.player.spawn(spawn.pos.clone(), spawn.ry);
    this.player.kills = 0;
    this.player.shotsFired = 0;
    this.player.shotsHit = 0;
    this.player.headshots = 0;
    this.player.damageDealt = 0;

    this.weapon.equip('carbine', true);
    // reset ammo to a clean loadout
    for (const [key, def] of Object.entries(WEAPONS)) {
      this.weapon.ammo[key] = { mag: def.magSize, reserve: mode === 'range' ? def.maxReserve : def.reserve };
    }
    this.weapon.grenades = mode === 'range' ? 2 : 2;
    this.weapon.medkits = 2;

    this.hud.show();
    if (mode === 'range') {
      this.spawnTargets();
      this.hud.toast('Training Range', 'Steel targets · unlimited ammo');
    } else {
      this.hud.toast('Operation Dustline', 'Hold the compound');
    }
    this.audio?.init();
    this.audio?.resume();
  }

  stop() {
    this.running = false;
    this.hud.hide();
    this.enemies.clear();
  }

  /* ---------------------------------------------------------------- update */

  update(dt, input) {
    if (!this.running || this.paused) return;
    dt = Math.min(dt, 1 / 24);
    this.time += dt;

    /* ---- player + weapon ---------------------------------------------- */
    this.player.update(dt, input, this);
    this.weapon.update(dt, input, this);

    // record shots for AI hearing
    if (this.player.shotsFired !== this._lastShots) {
      this._lastShots = this.player.shotsFired;
      this.lastPlayerShot = this.time;
    }

    /* ---- weapon fov zoom ---------------------------------------------- */
    const def = this.weapon.def;
    const targetFov = this.settings.get('fov') * lerp(1, def.adsFovScale, this.player.adsBlend);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }

    /* ---- enemies -------------------------------------------------------- */
    if (this.mode === 'survival') this.updateWaves(dt);
    this.enemies.update(dt, this.player);

    /* ---- grenades ------------------------------------------------------- */
    this.updateGrenades(dt);

    /* ---- pickups -------------------------------------------------------- */
    this.updatePickups(dt, input);

    /* ---- targets -------------------------------------------------------- */
    this.updateTargets(dt);

    /* ---- world + fx ----------------------------------------------------- */
    this.environment.update(dt, this.camera, this.player.pos);
    this.engine.postfx.setSuppression(clamp01(this.player.suppression * 0.8 + (1 - clamp01(this.player.health / 50)) * 0.35));
    this.particles.update(dt, this.camera);

    /* ---- hud ------------------------------------------------------------ */
    this.hud.update(dt, this);
    this.hud.updateDamageDirs(dt, this.player.yaw);
    this.updateInteractPrompt();

    /* ---- stats ---------------------------------------------------------- */
    this.stats.kills = this.player.kills;
    this.stats.headshots = this.player.headshots;
    this.stats.shotsFired = this.player.shotsFired;
    this.stats.shotsHit = this.player.shotsHit;
    this.stats.distance = this.player.distanceTravelled;
    this.stats.wave = this.wave;
    this.stats.score = this.score;
    this.stats.timeLabel = fmt.time(this.time);
  }

  /* ---------------------------------------------------------------- waves - */

  updateWaves(dt) {
    if (this.intermission > 0) {
      this.intermission -= dt;
      if (this.intermission <= 0) this.beginWave();
      return;
    }

    if (this.spawnQueue.length) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.enemiesAlive < 6) {
        this.spawnTimer = rand(0.5, 1.6);
        const spec = this.spawnQueue.pop();
        this.spawnEnemy(spec);
      }
    } else if (this.enemiesAlive === 0) {
      // wave cleared
      const bonus = 250 + this.wave * 120;
      this.score += bonus;
      this.intermission = 12;
      this.hud.toast(`Wave ${this.wave} cleared`, `+${bonus} · resupply and reposition`);
      this.audio?.play('ui');
      // resupply crates at the gate
      for (let i = 0; i < 3; i++) {
        this.spawnPickup(new THREE.Vector3(rand(-8, 8), 0, rand(40, 58)), 'ammo');
      }
      if (this.wave % 2 === 0) this.spawnPickup(new THREE.Vector3(rand(-6, 6), 0, rand(30, 45)), 'medkit');
      this.player.stamina = 100;
      this.player.heal(35);
    }
  }

  beginWave() {
    this.wave++;
    const count = Math.min(16, 3 + Math.round(this.wave * 1.35));
    const health = Math.min(230, 100 + this.wave * 9);
    const accuracy = Math.min(0.86, 0.42 + this.wave * 0.032);
    this.spawnQueue.length = 0;
    for (let i = 0; i < count; i++) {
      this.spawnQueue.push({
        health, accuracy,
        weapon: Math.random() < 0.45 ? 'akm' : 'carbine',
      });
    }
    this.spawnTimer = 0.4;
    this.hud.toast(`Wave ${this.wave}`, `${count} hostiles inbound`);
    this.audio?.play('ui');
    this.audio?.play('ui');
  }

  spawnEnemy(spec) {
    const candidates = this.level.spawnPoints;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 22; i++) {
      const sp = candidates[(Math.random() * candidates.length) | 0];
      if (!sp) continue;
      const d = sp.pos.distanceTo(this.player.pos);
      if (d < 18) continue;
      const los = this.level.colliders.lineOfSight(
        this._v.set(sp.pos.x, sp.pos.y + 1.6, sp.pos.z),
        this._v2.set(this.player.pos.x, this.player.pos.y + 1.4, this.player.pos.z),
      );
      const score = (los ? -14 : 22) - Math.abs(d - 42) * 0.45 + rand(-4, 4);
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    const sp = best || candidates[0];
    const pos = sp.pos.clone();
    pos.x += rand(-2, 2); pos.z += rand(-2, 2);
    pos.y = this.level.colliders.groundAt(pos.x, pos.z);
    this.enemies.spawn(pos, {
      yaw: Math.atan2(this.player.pos.x - pos.x, this.player.pos.z - pos.z),
      health: spec.health, accuracy: spec.accuracy, weapon: spec.weapon,
    });
  }

  get enemiesAlive() { return this.enemies.alive.length; }

  /* --------------------------------------------------------------- combat - */

  hitTestEnemies(origin, dir, maxDist, tmp) {
    const e = this.enemies.hitTest(origin, dir, maxDist, tmp || this._v);
    if (e) return e;
    // steel targets (training range)
    return this.hitTestTargets(origin, dir, maxDist);
  }

  applyEnemyDamage(enemy, damage, hit, source, def) {
    const res = enemy.applyDamage(damage, hit, source, def);
    if (res.damage <= 0) return;
    this.player.damageDealt += res.damage;

    const isHead = hit.part === 'head';
    // blood only on flesh hits, and always on a penetration-limited basis
    this.particles.bloodImpact(hit.point, hit.normal, this._v.copy(hit.point).sub(source.pos).normalize(), isHead ? 1.6 : 1.0);
    this.audio?.play('footstep', { surface: 'flesh', force: 0.4, pos: hit.point });

    if (res.killed) {
      this.onKill(enemy, isHead, hit.distance);
    } else {
      this.hud.showHitmarker(isHead, false);
      this.audio?.play(isHead ? 'headshot' : 'hitmarker');
      if (Math.random() < 0.4) this.audio?.play('grunt', { pos: enemy.pos });
      if (!isHead) this._hitMarkerDamage = true;
    }
  }

  onKill(enemy, headshot, distance) {
    this.kills++;
    this.player.kills++;
    if (headshot) this.player.headshots++;
    const base = 100 + Math.round(clamp(distance, 0, 80) * 1.6);
    const points = headshot ? Math.round(base * 1.75) : base;
    this.score += points;
    this.hud.showHitmarker(headshot, true);
    this.hud.killFeed(headshot ? 'Hostile neutralised' : 'Hostile down', headshot, distance);
    this.audio?.play('kill');
    this.particles.bloodPool(enemy.pos, this.level.colliders);
    // dropped supplies
    if (Math.random() < 0.42) this.spawnPickup(enemy.pos.clone(), Math.random() < 0.28 ? 'medkit' : 'ammo');
    if (this.enemiesAlive === 0 && this.spawnQueue.length === 0) {
      // last one down — let the wave-complete logic fire next frame
    }
  }

  onPlayerHitBy(enemy) {
    this.hud.damageDirection(enemy.pos, this.player.pos, this.camera);
  }

  throwGrenade() {
    const cam = this.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const pos = cam.position.clone().addScaledVector(dir, 0.45).add(new THREE.Vector3(0, -0.1, 0));
    const mesh = this._makeGrenadeMesh();
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.grenades.push({
      pos, vel: dir.multiplyScalar(15).add(this.player.vel.clone().multiplyScalar(1.0)).add(new THREE.Vector3(0, 2.2, 0)),
      fuse: 3.4, mesh, bounced: 0,
    });
  }

  _makeGrenadeMesh() {
    if (!this._grenadeGeo) {
      this._grenadeGeo = new THREE.SphereGeometry(0.055, 14, 10);
      this._grenadeGeo.scale(1, 1.25, 1);
    }
    const mat = this.materials.olive || this.materials.paintedMetal;
    const g = new THREE.Group();
    const body = new THREE.Mesh(this._grenadeGeo, mat);
    body.castShadow = true;
    g.add(body);
    const lever = new THREE.Mesh(
      new THREE.BoxGeometry(0.018, 0.075, 0.02),
      this.materials.gunSteel || this.materials.paintedMetal,
    );
    lever.position.set(0.02, 0.06, 0);
    g.add(lever);
    return g;
  }

  updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      g.vel.y -= 20 * dt;
      const step = this._v.copy(g.vel).multiplyScalar(dt);
      const dist = step.length();
      const hit = dist > 1e-5
        ? this.level.colliders.raycast(g.pos, this._v2.copy(step).multiplyScalar(1 / dist), dist, { ignoreTransparent: true })
        : null;
      if (hit) {
        g.pos.copy(hit.point).addScaledVector(hit.normal, 0.055);
        // reflect with restitution
        const vn = g.vel.dot(hit.normal);
        g.vel.addScaledVector(hit.normal, -1.45 * vn);
        g.vel.multiplyScalar(0.55);
        g.bounced++;
        if (g.bounced < 3) this.audio?.play('grenadeBounce', { pos: g.pos });
        this.particles.impact(hit.point, hit.normal, hit.box.surface, g.vel.clone().normalize(), { dust: 0.4, spark: 0 }, 0.5);
      } else {
        g.pos.add(step);
      }
      // ground contact
      const gy = this.level.colliders.groundAt(g.pos.x, g.pos.z, g.pos.y + 0.3);
      if (g.pos.y < gy + 0.055) {
        g.pos.y = gy + 0.055;
        if (g.vel.y < 0) g.vel.y = -g.vel.y * 0.35;
        g.vel.x *= 0.7; g.vel.z *= 0.7;
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += dt * 6;
      g.mesh.rotation.y += dt * 4.2;

      if (g.fuse <= 0) {
        this.explode(g.pos, 8.5);
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
      }
    }
  }

  /** Explosion: damage falls off with distance and is blocked by cover. */
  explode(pos, radius) {
    this.audio?.play('explosion', { pos, distance: pos.distanceTo(this.player.pos) });
    this.particles.explosion(pos, radius, () => {});

    // enemies
    for (const e of this.enemies.enemies) {
      if (!e.group.visible || !e.alive) continue;
      const d = e.pos.distanceTo(pos);
      if (d > radius * 1.6) continue;
      const los = this.level.colliders.lineOfSight(
        this._v.set(pos.x, pos.y + 0.4, pos.z),
        this._v2.set(e.pos.x, e.pos.y + 1.0, e.pos.z),
      );
      const falloff = clamp01(1 - d / (radius * 1.6)) * (los ? 1 : 0.42);
      if (falloff <= 0.02) continue;
      const dmg = 130 * falloff;
      const hit = {
        distance: d, part: 'chest', mult: 1, armour: 1,
        point: e.pos.clone().setY(e.pos.y + 1.0),
        normal: this._v2.copy(e.pos).sub(pos).normalize(),
        enemy: e,
      };
      const res = e.applyDamage(dmg, hit, this.player, { headMult: 1 });
      e.suppress(2.5);
      if (res.killed) this.onKill(e, false, d);
    }
    // player
    const pd = this.player.pos.distanceTo(pos);
    if (pd < radius * 1.4 && this.player.alive) {
      const los = this.level.colliders.lineOfSight(
        this._v.set(pos.x, pos.y + 0.4, pos.z),
        this._v2.set(this.player.pos.x, this.player.pos.y + 1.0, this.player.pos.z),
      );
      const falloff = clamp01(1 - pd / (radius * 1.4)) * (los ? 1 : 0.35);
      if (falloff > 0.02) this.player.takeDamage(80 * falloff, pos.clone());
    }
    // shake the whole area
    this.player.cameraShake = Math.min(1.6, this.player.cameraShake + clamp01(1 - pd / 30) * 1.1);
    this.hud.flashDamage();
  }

  /* -------------------------------------------------------------- pickups - */

  spawnPickup(pos, kind = 'ammo') {
    const geo = kind === 'ammo' ? new THREE.BoxGeometry(0.36, 0.22, 0.26) : new THREE.BoxGeometry(0.28, 0.2, 0.2);
    if (!this._pickupMats) {
      this._pickupMats = {
        ammo: new THREE.MeshStandardMaterial({
          color: 0x4a5238, roughness: 0.7, metalness: 0.25,
          emissive: 0x1a2408, emissiveIntensity: 0.6,
        }),
        medkit: new THREE.MeshStandardMaterial({
          color: 0x7a2020, roughness: 0.6, metalness: 0.15,
          emissive: 0x330808, emissiveIntensity: 0.7,
        }),
      };
    }
    const mesh = new THREE.Mesh(geo, this._pickupMats[kind]);
    mesh.castShadow = true;
    const y = this.level.colliders.groundAt(pos.x, pos.z) + 0.16;
    mesh.position.set(pos.x, y, pos.z);
    this.scene.add(mesh);
    this.pickups.push({ mesh, kind, pos: mesh.position.clone(), t: rand(0, TAU) });
  }

  updatePickups(dt, input) {
    let nearest = null, nearestD = 2.6;
    for (const p of this.pickups) {
      p.t += dt;
      p.mesh.position.y = p.pos.y + Math.sin(p.t * 2.2) * 0.045;
      p.mesh.rotation.y += dt * 0.7;
      const d = p.mesh.position.distanceTo(this._v.copy(this.player.pos));
      if (d < nearestD) { nearestD = d; nearest = p; }
    }
    this._nearPickup = nearest;
    if (nearest && input.down('interact')) {
      if (nearest.kind === 'ammo') {
        this.weapon.addAmmo(0.6);
        this.hud.toast('Ammunition', '+reserve rounds');
      } else {
        this.weapon.medkits++;
        this.hud.toast('Medical supplies', '+1 medkit');
      }
      this.audio?.play('magTap');
      this.scene.remove(nearest.mesh);
      this.pickups.splice(this.pickups.indexOf(nearest), 1);
    }
  }

  updateInteractPrompt() {
    if (this._nearPickup) {
      const label = this._nearPickup.kind === 'ammo' ? 'pick up ammunition' : 'pick up medical supplies';
      this.hud.prompt(`<kbd>F</kbd> ${label}`);
    } else if (this.weapon.getState().mag === 0) {
      this.hud.prompt('<kbd>R</kbd> reload');
    } else {
      this.hud.prompt(null);
    }
  }

  /* --------------------------------------------------------- range targets - */

  spawnTargets() {
    const spots = [];
    for (let i = 0; i < 10; i++) {
      const a = rand(-1.1, 1.1);
      const d = 14 + i * 3.6;
      spots.push(new THREE.Vector3(Math.sin(a) * d * 0.7, 0, -d));
    }
    const steel = this.materials.paintedMetal;
    const post = this.materials.rustyMetal;
    for (const s of spots) {
      const g = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.CircleGeometry(0.32, 20), steel);
      plate.position.y = 1.15;
      plate.castShadow = true;
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 0.06), steel);
      torso.position.y = 1.4;
      torso.castShadow = true;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), steel);
      head.position.y = 1.86;
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), post);
      stand.position.y = 0.6;
      g.add(plate, torso, head, stand);
      g.position.copy(this.level.snapToGround(s.clone()));
      g.rotation.y = Math.PI;
      this.scene.add(g);
      this.targets.push({
        mesh: g, alive: true, timer: 0, score: 0,
        spheres: [
          { local: new THREE.Vector3(0, 1.86, 0), r: 0.16, head: true },
          { local: new THREE.Vector3(0, 1.4, 0), r: 0.36, head: false },
          { local: new THREE.Vector3(0, 1.15, 0), r: 0.34, head: false },
        ],
      });
    }
  }

  hitTestTargets(origin, dir, maxDist) {
    let best = null;
    for (const t of this.targets) {
      if (!t.alive) continue;
      for (const s of t.spheres) {
        const center = this._v.copy(s.local).add(t.mesh.position);
        const to = this._v2.copy(center).sub(origin);
        const along = to.dot(dir);
        if (along < 0 || along > maxDist) continue;
        const distSq = to.lengthSq() - along * along;
        if (distSq > s.r * s.r) continue;
        const back = Math.sqrt(Math.max(0, s.r * s.r - distSq));
        const tt = along - back;
        if (!best || tt < best.distance) {
          best = {
            distance: tt, part: s.head ? 'head' : 'chest', mult: s.head ? 3 : 1,
            point: origin.clone().addScaledVector(dir, tt),
            normal: dir.clone().negate(), target: t, enemy: null,
          };
        }
      }
    }
    return best;
  }

  updateTargets(dt) {
    for (const t of this.targets) {
      if (!t.alive) {
        t.timer -= dt;
        t.mesh.rotation.x = damp(t.mesh.rotation.x, -Math.PI / 2.2, 8, dt);
        if (t.timer <= 0) {
          t.alive = true;
          t.mesh.rotation.x = 0;
          t.mesh.position.y = this.level.colliders.groundAt(t.mesh.position.x, t.mesh.position.z);
        }
      }
    }
  }

  get targetsRemaining() { return this.targets.filter((t) => t.alive).length; }

  /* ------------------------------------------------------------- lifecycle */

  onPlayerDeath() {
    this.dead = true;
    this.player.deathTime = 0;
    setTimeout(() => {
      if (!this.dead) return;
      this.paused = true;
      this.menu?.showDeath({ ...this.stats, kills: this.player.kills, score: this.score });
    }, 2600);
  }

  get alive() { return this.player.alive; }
}
