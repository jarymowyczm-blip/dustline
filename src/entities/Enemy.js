/**
 * Enemy.js — hostile soldiers.
 *
 * Three layers live here:
 *
 *  1. Perception & decision making: a finite state machine (idle → alert →
 *     seek cover → peek & fire → reposition) driven by a vision cone with real
 *     line-of-sight raycasts, distance-based hearing, reaction time and an aim
 *     error that tightens the longer a unit holds its sight on you.
 *
 *  2. Procedural animation: no animation clips — the bones are driven by
 *     sine-based walk cycles, breathing, inertial torso lean and two-bone IK so
 *     the rifle actually points where the unit is aiming.
 *
 *  3. Ragdoll death: at the moment of death the bone hierarchy is converted to
 *     a Verlet particle system with distance constraints, inheriting the pose
 *     and the bullet's momentum. It then collides with the world and settles.
 */

import * as THREE from 'three';
import { buildSoldier, createCharacterMaterials } from '../world/CharacterModel.js';
import { buildCarbine, buildAKM, createWeaponMaterials } from '../world/WeaponModels.js';
import { clamp, clamp01, damp, lerp, rand, randInt, sign, smoothstep, turnToward, angleDelta, wrapAngle, TAU } from '../core/Utils.js';

const TYPE_HEIGHT = 1.8;
const WEAPON_FORWARD = new THREE.Vector3(0, 0, -1);   // bore axis in weapon space

/* Hit spheres in bone space, ordered from most to least valuable to hit. */
const HIT_PARTS = [
  { bone: 'neck', part: 'head', offset: [0, 0.11, 0.0], radius: 0.115, mult: 'head' },
  { bone: 'neck', part: 'neck', offset: [0, 0.0, 0], radius: 0.085, mult: 1.9 },
  { bone: 'chest', part: 'chest', offset: [0, 0.06, 0], radius: 0.185, mult: 1.0, armour: 0.82 },
  { bone: 'chest', part: 'abdomen', offset: [0, -0.12, 0], radius: 0.165, mult: 0.92 },
  { bone: 'pelvis', part: 'pelvis', offset: [0, 0.0, 0], radius: 0.175, mult: 0.85 },
  { bone: 'upperArmL', part: 'armL', offset: [0, -0.14, 0], radius: 0.065, mult: 0.62 },
  { bone: 'upperArmR', part: 'armR', offset: [0, -0.14, 0], radius: 0.065, mult: 0.62 },
  { bone: 'forearmL', part: 'forearmL', offset: [0, -0.13, 0], radius: 0.055, mult: 0.55 },
  { bone: 'forearmR', part: 'forearmR', offset: [0, -0.13, 0], radius: 0.055, mult: 0.55 },
  { bone: 'thighL', part: 'thighL', offset: [0, -0.22, 0], radius: 0.09, mult: 0.7 },
  { bone: 'thighR', part: 'thighR', offset: [0, -0.22, 0], radius: 0.09, mult: 0.7 },
  { bone: 'kneeL', part: 'shinL', offset: [0, -0.2, 0], radius: 0.075, mult: 0.6 },
  { bone: 'kneeR', part: 'shinR', offset: [0, -0.2, 0], radius: 0.075, mult: 0.6 },
];

/* ------------------------------------------------------ weapon templates - */

const WEAPON_TEMPLATES = new Map();
function getWeaponTemplate(key, M) {
  if (WEAPON_TEMPLATES.has(key)) return WEAPON_TEMPLATES.get(key);
  const built = key === 'akm' ? buildAKM(M) : buildCarbine(M);
  // The builders already place a named 'muzzle' marker in the group, and
  // cloning copies it, so no extra pivot is needed here.
  const template = { group: built.group, length: built.length };
  WEAPON_TEMPLATES.set(key, template);
  return template;
}

/* ----------------------------------------------------------------- enemy - */

export class Enemy {
  constructor(game, materials, audio, particles, opts = {}) {
    this.game = game;
    this.level = game.level;
    this.colliders = this.level.colliders;
    this.audio = audio;
    this.particles = particles;
    this.M = createCharacterMaterials(createWeaponMaterials(materials));

    this.health = opts.health ?? 100;
    this.maxHealth = this.health;
    this.accuracy = opts.accuracy ?? 0.55;      // 0..1 skill
    this.weaponKey = opts.weapon || 'akm';

    /* ---- model ------------------------------------------------------- */
    const template = getWeaponTemplate(this.weaponKey, this.M);
    const weapon = template.group.clone(true);
    weapon.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.muzzle = weapon.getObjectByName('muzzle') || weapon;
    this.muzzleRef = this.muzzle;

    const soldier = buildSoldier(this.M, { weapon, name: 'enemy' });
    this.bones = soldier.bones;
    this.group = soldier.group;
    this.group.name = 'enemy';
    this.group.scale.setScalar(1);
    this.parts = soldier.meshes;

    // Remember the rest pose: procedural animation offsets it every frame and
    // a respawned body must be able to return to it exactly.
    for (const b of Object.values(this.bones)) {
      if (b && b.isObject3D) b.userData.restPos = b.position.clone();
    }

    this.pos = new THREE.Vector3();       // feet
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.aimYaw = 0; this.aimPitch = 0;
    this.aimError = 0.06;
    this.height = TYPE_HEIGHT;
    this.radius = 0.36;

    this.state = 'idle';
    this.stateTime = 0;
    this.alive = true;
    this.deadTime = 0;
    this.ragdoll = null;
    this.reactionTimer = 0;
    this.burstCount = 0;
    this.fireTimer = 0;
    this.repathTimer = 0;
    this.target = new THREE.Vector3();
    this.cover = null;
    this.peekSide = 1;
    this.moving = false;
    this.speed = 0;
    this.walkPhase = rand(0, TAU);
    this.breathPhase = rand(0, TAU);
    this.hitFlash = 0;
    this.suppressTimer = 0;
    this.flinch = new THREE.Vector3();
    this.lastSeenPlayer = new THREE.Vector3();
    this.hasSeenPlayer = false;
    this.alertness = 0;
    this.corpseTimer = 0;
    this.deathVelocity = new THREE.Vector3();

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._handV = new THREE.Vector3();
    this._handV2 = new THREE.Vector3();
    this._handQ = new THREE.Quaternion();
    this._handQ2 = new THREE.Quaternion();
    this._aimV = new THREE.Vector3();
    this._aimV2 = new THREE.Vector3();
    this._aimQ = new THREE.Quaternion();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this.eyeHeight = 1.62;

    this.game.scene.add(this.group);
    this.group.visible = false;
  }

  spawn(pos, yaw = 0, opts = {}) {
    this.pos.copy(pos);
    this.pos.y = this.colliders.groundAt(pos.x, pos.z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.aimYaw = yaw;
    this.aimPitch = 0;
    this.health = opts.health ?? this.maxHealth;
    this.maxHealth = this.health;
    this.alive = true;
    this.deadTime = 0;
    this.ragdoll = null;
    this.state = 'idle';
    this.stateTime = 0;
    this.alertness = 0;
    this.hasSeenPlayer = false;
    this.reactionTimer = 0;
    this.burstCount = 0;
    this.cover = null;
    this.corpseTimer = 0;
    this.group.visible = true;
    this.group.position.copy(this.pos);
    this.group.rotation.set(0, yaw, 0);
    this.group.scale.setScalar(1);
    // restore original bone rotations in case this body was a ragdoll before
    this._resetPose();
    this.ragdollPartCache = null;
    return this;
  }

  _resetPose() {
    for (const [, b] of Object.entries(this.bones)) {
      if (!b || !b.isObject3D) continue;
      b.rotation.set(0, 0, 0);
      if (b.userData.restPos) b.position.copy(b.userData.restPos);
      else b.position.set(0, 0, 0);
    }
  }

  /* ------------------------------------------------------------ perception */

  get eyePos() {
    // Dedicated temp: callers chain `.sub(this.eyePos)` onto another vector, so
    // this must never alias one of the shared scratch vectors (_v/_v2/_v3).
    return this._eye.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  canSee(point, fovCos = -0.15, maxDist = 95) {
    const eye = this.eyePos.clone();
    const to = this._v2.copy(point).sub(eye);
    const dist = to.length();
    if (dist > maxDist) return false;
    to.multiplyScalar(1 / dist);
    const facing = this._v3.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const dot = facing.dot(this._v3.copy(to).setY(0).normalize());
    if (dot < fovCos && dist > 3.5) return false;       // outside the cone (but close = felt)
    return this.colliders.lineOfSight(eye, point);
  }

  /* --------------------------------------------------------------- combat */

  update(dt, player, game) {
    this.stateTime += dt;

    if (!this.alive) {
      this.deadTime += dt;
      if (this.ragdoll) this.ragdoll.step(dt);
      this.corpseTimer += dt;
      return;
    }

    const playerPos = player.pos;
    const playerEye = new THREE.Vector3(playerPos.x, playerPos.y + player.eyeHeight * 0.9, playerPos.z);
    const toPlayer = this._v.copy(playerEye).sub(this.eyePos);
    const distToPlayer = toPlayer.length();

    /* ---- perception ---------------------------------------------------- */
    const actuallySees = player.alive && this.canSee(playerEye, -0.12, 100);
    if (actuallySees) {
      this.lastSeenPlayer.copy(playerPos);
      this.hasSeenPlayer = true;
      this.alertness = Math.min(1, this.alertness + dt * 4.5);
    } else {
      this.alertness = Math.max(0, this.alertness - dt * 0.24);
    }
    // gunshots and sprinting are loud
    if (this.alertness < 1 && game.time - (game.lastPlayerShot ?? -99) < 0.2) {
      const shotDist = this.pos.distanceTo(playerPos);
      if (shotDist < 85) this.alertness = Math.min(1, this.alertness + dt * 12 * (1 - shotDist / 85));
      if (!this.hasSeenPlayer) this.lastSeenPlayer.copy(playerPos);
    }
    if (this.alertness < 1 && player.sprinting && this.pos.distanceTo(playerPos) < 22) {
      this.alertness = Math.min(1, this.alertness + dt * 0.8);
      this.lastSeenPlayer.copy(playerPos);
    }

    /* ---- state machine -------------------------------------------------- */
    const wasState = this.state;
    if (!this.hasSeenPlayer && this.alertness <= 0.02) {
      this.state = 'idle';
    } else if (!this.hasSeenPlayer) {
      this.state = this.alertness > 0.35 ? 'seek' : 'alert';
    } else if (actuallySees) {
      this.state = 'combat';
    } else {
      this.state = this.stateTime < 8 ? 'seek' : 'idle';
      if (this.state === 'idle') this.hasSeenPlayer = false;
    }
    if (wasState !== this.state) { this.stateTime = 0; this.state = this.state; }

    /* ---- behaviour ------------------------------------------------------ */
    switch (this.state) {
      case 'idle': this._behaviourIdle(dt); break;
      case 'alert': this._behaviourSeek(dt, this.lastSeenPlayer, 0.7, player); break;
      case 'seek': this._behaviourSeek(dt, this.lastSeenPlayer, 1.0, player); break;
      case 'combat': this._behaviourCombat(dt, player, playerPos, actuallySees, distToPlayer); break;
    }

    /* ---- physics -------------------------------------------------------- */
    this.vel.y -= 23.5 * dt;
    this.pos.addScaledVector(this.vel, dt);
    const res = this.colliders.resolveCapsule(this.pos, this.radius, this.height, { stepHeight: 0.5 });
    if (res.grounded && this.vel.y < 0) this.vel.y = 0;
    // if the AI is stuck against geometry, slide along it
    if (this.moving && this.speed > 0.1) {
      const moved = this._v.copy(this.pos).sub(this._lastPos || this.pos).length();
      this.stuckTimer = moved < this.speed * dt * 0.35 ? (this.stuckTimer || 0) + dt : 0;
      if (this.stuckTimer > 0.45) { this.stuckTimer = 0; this.yaw += rand(-1.2, 1.2); }
    }
    this._lastPos = this._lastPos || new THREE.Vector3();
    this._lastPos.copy(this.pos);

    this.group.position.copy(this.pos);
    this.group.rotation.set(0, this.yaw, 0);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4);

    this._animate(dt, player, distToPlayer, actuallySees);
  }

  _behaviourIdle(dt) {
    this.moving = false;
    this.speed = damp(this.speed, 0, 6, dt);
    this.vel.x = damp(this.vel.x, 0, 6, dt);
    this.vel.z = damp(this.vel.z, 0, 6, dt);
    // slow scan of the surroundings
    if ((this.scanTimer = (this.scanTimer ?? 0) - dt) <= 0) {
      this.scanTimer = rand(2.5, 5.5);
      this.scanTarget = this.yaw + rand(-1.1, 1.1);
    }
    if (this.scanTarget !== undefined) this.yaw = damp(this.yaw, this.scanTarget, 1.6, dt);
    this.aimYaw = damp(this.aimYaw, this.yaw, 4, dt);
    this.aimPitch = damp(this.aimPitch, 0, 4, dt);
  }

  _behaviourSeek(dt, targetPos, speedScale, player) {
    this._moveTo(dt, targetPos, speedScale);
    const dir = this._v2.copy(targetPos).sub(this.pos);
    if (dir.lengthSq() > 0.5) {
      const want = Math.atan2(-dir.x, -dir.z);
      this.yaw = turnToward(this.yaw, want, 2.2 * dt);
    }
    this.aimYaw = damp(this.aimYaw, this.yaw, 5, dt);
    this.aimPitch = damp(this.aimPitch, this.aimPitch * 0.9, 3, dt);
  }

  _behaviourCombat(dt, player, playerPos, sees, distToPlayer) {
    const idealRange = this.weaponKey === 'akm' ? 20 : 26;
    const tooClose = distToPlayer < 8;
    const tooFar = distToPlayer > idealRange + 12;

    // ---- pick or keep cover -------------------------------------------
    if (!this.cover || this.coverTimer === undefined || this.coverTimer <= 0) {
      this.cover = this._pickCover(playerPos, idealRange);
      this.coverTimer = rand(3.5, 7.5);
      this.peekSide = Math.random() < 0.5 ? -1 : 1;
    }
    this.coverTimer -= dt;

    // ---- aim -----------------------------------------------------------
    const targetPoint = this._v3.set(
      playerPos.x + player.vel.x * 0.14 * this.accuracy,
      playerPos.y + rand(0.35, 1.45),
      playerPos.z + player.vel.z * 0.14 * this.accuracy,
    );
    const aimDir = this._v2.copy(targetPoint).sub(this.eyePos);
    const wantYaw = Math.atan2(-aimDir.x, -aimDir.z);
    const wantPitch = Math.atan2(aimDir.y, Math.hypot(aimDir.x, aimDir.z));
    const turnRate = 3.4 + this.accuracy * 3.6;
    this.yaw = turnToward(this.yaw, wantYaw, turnRate * dt);
    this.aimYaw = turnToward(this.aimYaw, wantYaw, (turnRate + 2) * dt);
    this.aimPitch = damp(this.aimPitch, clamp(wantPitch, -1.1, 1.1), 8, dt);

    const aimAligned = Math.abs(angleDelta(this.aimYaw, wantYaw)) < 0.11 &&
      Math.abs(this.aimPitch - wantPitch) < 0.14;

    // ---- movement: reposition, or hold the firing position -------------
    if (tooClose) {
      this._moveTo(dt, this._v.copy(this.pos).addScaledVector(this._v2.copy(this.pos).sub(playerPos).setY(0).normalize(), 6), 1);
    } else if (this.cover && this.pos.distanceTo(this.cover.pos) > 1.6) {
      this._moveTo(dt, this.cover.pos, 0.85);
    } else if (tooFar && this.stateTime > 1.2) {
      this._moveTo(dt, playerPos, 0.75);
    } else if (distToPlayer > 6 && this.stateTime > 3 && Math.random() < 0.02) {
      // small lateral shuffle so units are not static targets
      this._sidestep = rand(-1, 1) * rand(2, 5);
      this.sidestepTimer = 0.8;
    } else {
      this.moving = false;
      this.speed = damp(this.speed, 0, 6, dt);
      this.vel.x = damp(this.vel.x, 0, 7, dt);
      this.vel.z = damp(this.vel.z, 0, 7, dt);
    }

    if (this.sidestepTimer > 0) {
      this.sidestepTimer -= dt;
      const right = this._v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(sign(this._sidestep || 1));
      const target = this._v.copy(this.pos).addScaledVector(right, 3);
      this._moveTo(dt, target, 1.1);
    }

    // ---- shoot ---------------------------------------------------------
    this.fireTimer -= dt;
    if (this.suppressTimer > 0) {
      this.suppressTimer -= dt;
      // suppressed units duck and stop firing for a moment
      this.moving = this.moving && Math.random() > 0.02;
      return;
    }
    if (sees && aimAligned && this.fireTimer <= 0 && distToPlayer < 95 && this._weaponAligned(playerPos)) {
      if (this.reactionTimer <= 0) this.reactionTimer = this.reactionTimer || (0.18 + (1 - this.accuracy) * 0.45);
      this.reactionTimer -= dt;
      if (this.reactionTimer <= 0) {
        this._shoot(player, distToPlayer);
        if (--this.burstCount <= 0) {
          // pause between bursts — longer at long range and for poor shooters
          this.fireTimer = rand(0.35, 0.9) + distToPlayer * 0.012 + (1 - this.accuracy) * 0.5;
          this.burstCount = randInt(3, 6);
        } else {
          this.fireTimer = 60 / 640;
        }
      }
    } else {
      this.reactionTimer = Math.min(this.reactionTimer || 0.3, 0.3);
    }
  }

  /**
   * Is the held rifle actually pointed at the target yet?
   *
   * The arms ease towards the aim direction over a few frames, so without this
   * gate a unit would shoot while its weapon is still coming up — tracers and
   * muzzle flashes would leave a barrel pointing somewhere else entirely.
   */
  _weaponAligned(playerPos, cosTol = 0.985) {
    if (!this.muzzle) return true;
    this.muzzle.updateWorldMatrix(true, false);
    this._aimV.set(0, 0, -1).applyQuaternion(this.muzzle.getWorldQuaternion(this._aimQ));
    const muzzle = this.muzzle.getWorldPosition(this._aimV2);
    const to = this._v3.set(playerPos.x, playerPos.y + 1.15, playerPos.z).sub(muzzle).normalize();
    return this._aimV.dot(to) >= cosTol;
  }

  /** Fire at the player, with cone error that tightens with skill. */
  _shoot(player, dist) {
    // Rounds leave the muzzle, so the shot is aimed from there: wherever the
    // rifle points is where the bullet goes, and the tracer matches the hit.
    const muzzle = this.muzzle.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(player.pos.x, player.pos.y + 1.15, player.pos.z)
      .sub(muzzle).normalize();
    // error grows with range and shrinks with accuracy
    const err = (0.030 - this.accuracy * 0.020) * (1 + dist / 70) * (0.6 + this.speed * 0.06);
    const a = rand(0, TAU), r = Math.sqrt(Math.random()) * err;
    const right = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();

    this.particles?.muzzleFlash(muzzle, dir, 0.85, 715);
    this.particles?.tracer(muzzle, dir.clone(), 0xffc46a, 0.85);
    this.audio?.play(this.weaponKey === 'akm' ? 'shot762' : 'shot556', {
      pos: this.pos, enemy: true, distance: dist,
    });

    // Where does the round actually go?
    const levelHit = this.colliders.raycast(muzzle, dir, 200, { ignoreTransparent: true });
    const maxDist = levelHit ? levelHit.distance : 200;
    const playerHit = this._rayPlayer(muzzle, dir, maxDist, player);
    if (playerHit) {
      const falloff = clamp(1 - (playerHit.distance - 25) / 120, 0.5, 1);
      const dmg = (this.weaponKey === 'akm' ? 15 : 12) * falloff * (0.85 + this.accuracy * 0.3);
      player.takeDamage(dmg, this.pos.clone());
      this.game.onPlayerHitBy?.(this);
    } else {
      // near miss → suppression
      const perp = this._perpDistanceTo(player.pos.clone().setY(player.pos.y + 1.2), muzzle, dir);
      if (perp < 2.6 && levelHit) {
        player.suppression = Math.min(1, player.suppression + (2.6 - perp) * 0.09);
        this.audio?.play('nearMiss', { pos: player.pos, distance: dist });
        this.particles?.impact(levelHit.point, levelHit.normal, levelHit.box.surface, dir,
          { spark: 0.4, dust: 1, sound: 'concrete' }, 1);
      }
    }
  }

  _perpDistanceTo(point, rayOrigin, rayDir) {
    const toPoint = this._v.copy(point).sub(rayOrigin);
    const along = toPoint.dot(rayDir);
    if (along < 0) return 999;
    return toPoint.addScaledVector(rayDir, -along).length();
  }

  /**
   * Analytic ray vs vertical capsule test against the player.
   * Solves the quadratic for the ray's closest approach to the capsule's axis,
   * then checks the hit point against the capsule's height span (with cap
   * fallback for steep shots).
   */
  _rayPlayer(origin, dir, maxDist, player) {
    const r = 0.42;
    const y0 = player.pos.y + 0.30;
    const y1 = player.pos.y + player.height - 0.20;

    const ox = origin.x - player.pos.x;
    const oz = origin.z - player.pos.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-6) return null;
    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    let t = (-b - sq) / (2 * a);
    if (t < 0) t = 0;

    const y = origin.y + dir.y * t;
    if (y < y0 || y > y1) {
      // The ray misses the cylinder body — test the cap it is heading toward.
      if (Math.abs(dir.y) < 1e-6) return null;
      const tCap = ((dir.y > 0 ? y1 : y0) - origin.y) / dir.y;
      if (!isFinite(tCap) || tCap < 0) return null;
      const cx = origin.x + dir.x * tCap - player.pos.x;
      const cz = origin.z + dir.z * tCap - player.pos.z;
      if (cx * cx + cz * cz > r * r) return null;
      t = tCap;
    }
    if (t > maxDist) return null;
    return { distance: Math.max(0.1, t) };
  }

  /* ------------------------------------------------------------ navigation */

  _pickCover(playerPos, idealRange) {
    let best = null, bestScore = -Infinity;
    const list = this.level.coverPoints;
    for (let i = 0; i < list.length; i += 2) {      // sample to keep it cheap
      const c = list[(i + this.coverOffset) % list.length] || list[i];
      if (!c) continue;
      const d = c.pos.distanceTo(this.pos);
      if (d > 34) continue;
      const dPlayer = c.pos.distanceTo(playerPos);
      if (dPlayer < 7 || dPlayer > 65) continue;
      // cover is good if the player cannot see it
      const hidden = !this.colliders.lineOfSight(
        this._v.set(c.pos.x, c.pos.y + 0.75, c.pos.z),
        this._v2.set(playerPos.x, playerPos.y + 1.4, playerPos.z),
      );
      let score = (hidden ? 26 : 0) - Math.abs(dPlayer - idealRange) * 0.55 - d * 0.35;
      // prefer advancing when far away
      score += clamp(28 - dPlayer, 0, 12);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) {
      // no cover found: hold position but keep a target for movement
      return { pos: this.pos.clone(), dir: this.yaw };
    }
    return { pos: best.pos.clone(), dir: best.dir };
  }

  /** Steering with obstacle avoidance. */
  _moveTo(dt, targetPos, speedScale = 1) {
    const to = this._v2.copy(targetPos).sub(this.pos);
    to.y = 0;
    const dist = to.length();
    if (dist < 0.6) {
      this.moving = false;
      this.speed = damp(this.speed, 0, 8, dt);
      this.vel.x = damp(this.vel.x, 0, 8, dt);
      this.vel.z = damp(this.vel.z, 0, 8, dt);
      return;
    }
    to.multiplyScalar(1 / dist);
    const maxSpeed = (this.state === 'combat' ? 3.4 : 4.6) * speedScale;
    this.moving = true;
    this.speed = damp(this.speed, maxSpeed, 5, dt);

    // Avoidance: probe ahead, then fan out to the sides.
    let dir = to;
    const origin = this._v3.set(this.pos.x, this.pos.y + 0.95, this.pos.z);
    const probe = 1.5;
    const blocked = this.colliders.raycast(origin, dir, probe, { ignoreTransparent: true, filter: (b) => b.climbable });
    if (blocked) {
      const angles = [0.35, -0.35, 0.75, -0.75, 1.15, -1.15, 1.6, -1.6];
      let found = false;
      for (const a of angles) {
        const c = Math.cos(a), s = Math.sin(a);
        const rx = dir.x * c - dir.z * s;
        const rz = dir.x * s + dir.z * c;
        const test = this._v.set(rx, 0, rz);
        if (!this.colliders.raycast(origin, test, probe * 1.2, { ignoreTransparent: true, filter: (b) => b.climbable })) {
          dir = test; found = true; break;
        }
      }
      if (!found) { this.speed = 0; return; }
    }

    this.vel.x = damp(this.vel.x, dir.x * this.speed, 6, dt);
    this.vel.z = damp(this.vel.z, dir.z * this.speed, 6, dt);
    // Face the movement direction when not fighting.
    if (this.state !== 'combat') {
      const want = Math.atan2(-dir.x, -dir.z);
      this.yaw = turnToward(this.yaw, want, 4.5 * dt);
    }
  }

  /* ---------------------------------------------------------- hit testing - */

  /** Ray vs the bone spheres. Returns the closest hit or null. */
  hitTest(origin, dir, maxDist) {
    if (!this.alive && this.deadTime > 4) return null;    // corpses stop bullets after settling
    let best = null;
    for (const hp of HIT_PARTS) {
      const bone = this.bones[hp.bone];
      if (!bone) continue;
      const center = bone.getWorldPosition(new THREE.Vector3());
      if (hp.offset) {
        // offset in bone-local space, then to world
        const off = new THREE.Vector3(hp.offset[0], hp.offset[1], hp.offset[2]);
        center.add(off.applyQuaternion(bone.getWorldQuaternion(this._q)));
      }
      const r = hp.radius + (this.alive ? 0 : 0.02);
      // ray-sphere
      const toC = this._v.copy(center).sub(origin);
      const along = toC.dot(dir);
      if (along < 0) continue;
      const distSq = toC.lengthSq() - along * along;
      if (distSq > r * r) continue;
      const back = Math.sqrt(Math.max(0, r * r - distSq));
      const t = along - back;
      if (t < 0 || t > maxDist) continue;
      if (!best || t < best.distance) {
        best = {
          distance: t,
          part: hp.part,
          mult: hp.mult === 'head' ? 'head' : hp.mult,
          armour: hp.armour || 1,
          point: origin.clone().addScaledVector(dir, t),
          normal: dir.clone().negate(),
          enemy: this,
        };
      }
    }
    return best;
  }

  /* -------------------------------------------------------------- damage -- */

  applyDamage(amount, hit, source, weaponDef) {
    if (!this.alive) return { damage: 0, killed: false };
    let mult = 1;
    if (hit.mult === 'head') mult = weaponDef?.headMult ?? 3.0;
    else if (typeof hit.mult === 'number') mult = hit.mult;
    let dmg = amount * mult * (hit.armour || 1);
    // energy falls off with distance
    const dist = hit.distance;
    if (dist > 40) dmg *= clamp(1 - (dist - 40) / 160, 0.55, 1);
    dmg = Math.max(1, dmg);

    this.health -= dmg;
    this.hitFlash = 1;

    // flinch from the impact
    const fb = this._v.copy(hit.point).sub(source.pos).setY(0).normalize().multiplyScalar(clamp(dmg / 60, 0.1, 1.2));
    this.flinch.add(fb);
    this.deathVelocity.copy(hit.point).sub(hit.point.clone().addScaledVector(hit.normal, 1)).multiplyScalar(0);
    this._lastHitDir = hit.normal.clone();

    // being shot at makes units react even if they never saw the shooter
    if (!this.hasSeenPlayer) {
      this.hasSeenPlayer = true;
      this.alertness = 1;
      this.lastSeenPlayer.copy(source.pos);
      this.state = 'seek';
      this.stateTime = 0;
    }
    if (Math.random() < 0.5) this.suppressTimer = Math.max(this.suppressTimer, 0.25);

    const killed = this.health <= 0;
    if (killed) this.die(this._v.copy(source.pos).sub(this.pos).setY(0.2).normalize(), hit);
    return { damage: dmg, killed, part: hit.part };
  }

  /** Called when a nearby explosion or incoming fire staggers the unit. */
  suppress(amount) {
    this.suppressTimer = Math.max(this.suppressTimer, amount);
  }

  /* ---------------------------------------------------------------- death - */

  die(impulseDir, hit) {
    if (!this.alive) return;
    this.alive = false;
    this.deadTime = 0;
    this.corpseTimer = 0;
    this.health = 0;
    this.vel.set(0, 0, 0);
    this.ragdoll = new Ragdoll(this, impulseDir, hit);
  }

  /* ------------------------------------------------------------ animation - */

  _animate(dt, player, distToPlayer, sees) {
    const bones = this.bones;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const runBlend = clamp01(speed / 3.0);
    this.walkPhase += dt * (4.2 + speed * 1.25);
    this.breathPhase += dt * 1.4;

    const swing = Math.sin(this.walkPhase);
    const swing2 = Math.sin(this.walkPhase + Math.PI);
    const lift = (t, side) => Math.max(0, t) * side;

    /* ---- legs ---------------------------------------------------------- */
    const thighAmp = lerp(0.10, 0.62, runBlend);
    const kneeAmp = lerp(0.22, 1.05, runBlend);
    if (bones.hipL) bones.hipL.rotation.x = swing * thighAmp;
    if (bones.hipR) bones.hipR.rotation.x = swing2 * thighAmp;
    if (bones.kneeL) bones.kneeL.rotation.x = Math.max(0, -swing) * kneeAmp + 0.06;
    if (bones.kneeR) bones.kneeR.rotation.x = Math.max(0, -swing2) * kneeAmp + 0.06;
    if (bones.footL) bones.footL.rotation.x = -bones.kneeL.rotation.x * 0.45 + swing * 0.15;
    if (bones.footR) bones.footR.rotation.x = -bones.kneeR.rotation.x * 0.45 + swing2 * 0.15;

    /* ---- torso: bob, lean into motion, breathing ----------------------- */
    const bob = Math.abs(Math.sin(this.walkPhase)) * lerp(0.005, 0.035, runBlend);
    if (bones.pelvis) {
      bones.pelvis.position.y = (bones.pelvis.userData.restPos?.y ?? 0) + bob;
      bones.pelvis.rotation.z = -swing * 0.06 * runBlend;
      bones.pelvis.rotation.y = swing * 0.12 * runBlend;
    }
    if (bones.spine) {
      bones.spine.rotation.x = lerp(0.02, 0.16, runBlend) + Math.sin(this.breathPhase) * 0.012;
      bones.spine.rotation.z = swing * 0.05 * runBlend;
    }
    if (bones.chest) {
      bones.chest.rotation.y = -swing * 0.14 * runBlend;
      bones.chest.rotation.z = -swing * 0.04 * runBlend;
    }

    /* ---- flinch from incoming fire ------------------------------------- */
    if (this.flinch.lengthSq() > 1e-6) {
      const f = this.flinch;
      if (bones.spine) {
        bones.spine.rotation.x += clamp(f.z * 0.3, -0.3, 0.3);
        bones.spine.rotation.z += clamp(f.x * 0.4, -0.4, 0.4);
      }
      if (bones.neck) bones.neck.rotation.z += clamp(f.x * 0.25, -0.3, 0.3);
      f.multiplyScalar(1 - Math.min(1, dt * 6));
    }

    /* ---- arms: two-bone IK toward the aim point ------------------------ */
    const aiming = this.state === 'combat' || this.state === 'seek' || this.state === 'alert';
    const aimPoint = this._v.set(
      this.pos.x - Math.sin(this.aimYaw) * Math.cos(this.aimPitch) * 20,
      this.pos.y + this.eyeHeight + Math.tan(this.aimPitch) * 20,
      this.pos.z - Math.cos(this.aimYaw) * Math.cos(this.aimPitch) * 20,
    );

    if (aiming) {
      this._ikArm(bones.shoulderR, bones.upperArmR, bones.forearmR, aimPoint, 1, runBlend);
      this._ikArm(bones.shoulderL, bones.upperArmL, bones.forearmL, this._v2.copy(aimPoint).add(this._v3.set(0.06, 0.02, 0)), -1, runBlend);
      // The rifle is rigidly parented to the right hand, so twisting that hand
      // is what actually points the barrel: aim the bore axis at the target.
      this._aimWeaponHand(bones.handR, aimPoint, 0.5);
    } else {
      // relaxed carry: right hand at the hip, left arm swinging
      const swingR = swing2 * 0.35 * runBlend;
      if (bones.shoulderR) bones.shoulderR.rotation.set(-0.25 - swingR, 0.25, -0.12);
      if (bones.upperArmR) { bones.upperArmR.rotation.set(0.55, 0, -0.25); }
      if (bones.forearmR) bones.forearmR.rotation.set(-1.15, 0, 0.1);
      if (bones.shoulderL) bones.shoulderL.rotation.set(-0.1 + swing * 0.4 * runBlend, -0.15, 0.1);
      if (bones.upperArmL) bones.upperArmL.rotation.set(0.35, 0, 0.3);
      if (bones.forearmL) bones.forearmL.rotation.set(-0.7 - swing * 0.2, 0, -0.15);
    }

    /* ---- head: look where we are aiming -------------------------------- */
    if (bones.neck) {
      const headYaw = clamp(angleDelta(this.yaw, this.aimYaw), -0.7, 0.7);
      const headPitch = clamp(this.aimPitch * 0.75, -0.5, 0.5);
      bones.neck.rotation.y = damp(bones.neck.rotation.y, headYaw, 12, dt);
      bones.neck.rotation.x = damp(bones.neck.rotation.x, -headPitch * 0.5, 12, dt);
    }
  }

  /**
   * Twist a hand so the weapon it carries points at the target.
   *
   * The rifle sits at the hand's origin with its bore along local -Z, so the
   * hand's world orientation is what aims the barrel. `pivot` is that hand: the
   * muzzle then ends up on the line from the hand to the target.
   */
  _aimWeaponHand(hand, targetWorld, blend) {
    if (!hand || !hand.parent) return;
    const origin = hand.getWorldPosition(this._handV);
    const dir = this._handV2.copy(targetWorld).sub(origin);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    // minimal rotation that lays the bore on the aim direction (keeps the
    // weapon upright for level shots instead of rolling it)
    this._handQ.setFromUnitVectors(WEAPON_FORWARD, dir);
    // world → hand-local, using up-to-date parent transforms
    hand.parent.updateWorldMatrix(true, false);
    hand.parent.getWorldQuaternion(this._handQ2).invert();
    this._handQ2.multiply(this._handQ);
    hand.quaternion.slerp(this._handQ2, blend);
  }

  /**
   * Two-bone IK: point the upper arm at the target and bend the elbow.
   * All maths happens in the shoulder's parent space so the hierarchy does the
   * rest.
   */
  _ikArm(shoulder, upper, fore, targetWorld, side, runBlend) {
    if (!shoulder || !upper || !fore) return;
    shoulder.parent.updateWorldMatrix(true, false);
    const shoulderWorld = shoulder.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3().copy(targetWorld).sub(shoulderWorld);
    const dist = Math.max(0.25, dir.length());
    dir.normalize();
    // into parent space: the aim direction must be expressed in the space the
    // shoulder's local quaternion lives in, otherwise the arm swings the wrong
    // way as soon as the unit faces away from the world origin.
    dir.applyQuaternion(shoulder.parent.getWorldQuaternion(this._q2).invert());

    // Rotate the arm's local -Y onto the target direction.
    const desired = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    // Keep the elbow pointing outward/down for a natural silhouette.
    const twist = new THREE.Quaternion().setFromAxisAngle(dir, side * (0.5 + runBlend * 0.15));
    const q = twist.multiply(desired);
    shoulder.quaternion.slerp(q, 0.55);

    // Elbow: more bend the closer the target is.
    const armLen = 0.56;
    const bend = clamp(Math.acos(clamp(dist / armLen, 0.2, 1)) , 0, 1.35);
    fore.rotation.x = damp(fore.rotation.x, -bend * 1.5 - 0.15, 14, 1 / 60);
    upper.rotation.set(0, 0, 0);
  }
}

/* --------------------------------------------------------------- ragdoll - */

/**
 * Verlet particle ragdoll built from the rig's bones at the moment of death.
 *
 * Each bone becomes a particle (position + previous position + its own radius).
 * Distance constraints preserve bone lengths, and a height-dependent angular
 * constraint keeps joints from folding through themselves. Particles collide
 * with the level's OBBs and go to sleep once the body settles.
 */
class Ragdoll {
  constructor(enemy, impulseDir, hit) {
    this.enemy = enemy;
    this.colliders = enemy.level.colliders;
    this.points = [];
    this.byName = {};
    this.constraints = [];
    this.sleepTimer = 0;
    this.awake = true;
    this.age = 0;

    const boneList = [
      ['pelvis', 0.17, null],
      ['spine', 0.15, 'pelvis'],
      ['chest', 0.19, 'spine'],
      ['neck', 0.10, 'chest'],
      ['headMesh', 0.15, 'neck'],
      ['shoulderL', 0.09, 'chest'],
      ['forearmL', 0.08, 'shoulderL'],
      ['handL', 0.07, 'forearmL'],
      ['shoulderR', 0.09, 'chest'],
      ['forearmR', 0.08, 'shoulderR'],
      ['handR', 0.07, 'forearmR'],
      ['hipL', 0.11, 'pelvis'],
      ['kneeL', 0.09, 'hipL'],
      ['footL', 0.10, 'kneeL'],
      ['hipR', 0.11, 'pelvis'],
      ['kneeR', 0.09, 'hipR'],
      ['footR', 0.10, 'kneeR'],
    ];

    const boneToNode = {
      pelvis: 'pelvis', spine: 'spine', chest: 'chest', neck: 'neck',
      headMesh: 'headMesh', shoulderL: 'upperArmL', forearmL: 'forearmL', handL: 'handL',
      shoulderR: 'upperArmR', forearmR: 'forearmR', handR: 'handR',
      hipL: 'thighL', kneeL: 'kneeL', footL: 'footL',
      hipR: 'thighR', kneeR: 'kneeR', footR: 'footR',
    };

    for (const [name, radius, parent] of boneList) {
      const nodeName = boneToNode[name] || name;
      const node = enemy.bones[nodeName] || enemy.bones[name];
      if (!node) continue;
      const world = new THREE.Vector3();
      if (name === 'headMesh') {
        node.getWorldPosition(world);
        world.y += 0.12;
      } else if (name === 'forearmL' || name === 'forearmR') {
        node.getWorldPosition(world);
        world.y -= 0.13;
      } else if (name === 'handL' || name === 'handR') {
        node.getWorldPosition(world);
        world.y -= 0.09;
      } else {
        node.getWorldPosition(world);
      }
      const p = {
        pos: world.clone(),
        prev: world.clone(),
        vel: new THREE.Vector3(),
        radius,
        name,
        node: nodeName,
        restQuat: new THREE.Quaternion(),
      };
      node.getWorldQuaternion(p.restQuat);
      this.points.push(p);
      this.byName[name] = p;
      if (parent && this.byName[parent]) {
        this.constraints.push({ a: this.byName[parent], b: p, rest: this.byName[parent].pos.distanceTo(p.pos) });
      }
    }

    // structural constraints that stop the torso collapsing
    const extra = [['pelvis', 'chest'], ['chest', 'hipL'], ['chest', 'hipR'], ['headMesh', 'chest'],
      ['shoulderL', 'shoulderR'], ['hipL', 'hipR'], ['footL', 'footR']];
    for (const [a, b] of extra) {
      if (this.byName[a] && this.byName[b]) {
        this.constraints.push({ a: this.byName[a], b: this.byName[b], rest: this.byName[a].pos.distanceTo(this.byName[b].pos) });
      }
    }

    // initial momentum: the bullet's direction plus a fall
    const imp = impulseDir.clone().multiplyScalar(clamp((hit?.mult === 'head' ? 1.9 : 1.2), 0.4, 2.4));
    for (const p of this.points) {
      p.vel.copy(imp).multiplyScalar(rand(0.5, 1.3));
      p.vel.y += rand(-0.2, 0.5);
    }
    // Head shots snap the head back.
    if (hit?.part === 'head') {
      const h = this.byName.headMesh;
      if (h) h.vel.addScaledVector(impulseDir, 1.6).add(new THREE.Vector3(0, 0.6, 0));
    }
    this.sampleBones();
  }

  step(dt) {
    if (!this.awake) return;
    this.age += dt;
    const steps = 1;
    const h = Math.min(dt, 1 / 45) / steps;
    for (let s = 0; s < steps; s++) {
      this.integrate(h);
      for (let i = 0; i < 5; i++) {
        this.solveConstraints();
        this.collide();
      }
    }
    this.sampleBones();

    // Sleep when everything has come to rest.
    let motion = 0;
    for (const p of this.points) motion += p.vel.lengthSq();
    if (motion / this.points.length < 0.02 && this.age > 1.4) {
      this.sleepTimer += dt;
      if (this.sleepTimer > 1.2) {
        this.awake = false;
        for (const p of this.points) p.vel.set(0, 0, 0);
      }
    } else this.sleepTimer = 0;
  }

  integrate(h) {
    const g = -17;
    for (const p of this.points) {
      const damping = 0.994;
      p.vel.set(
        (p.pos.x - p.prev.x) * damping,
        (p.pos.y - p.prev.y) * damping,
        (p.pos.z - p.prev.z) * damping,
      );
      p.prev.copy(p.pos);
      p.vel.y += g * h;
      p.pos.add(p.vel);
    }
  }

  solveConstraints() {
    for (const c of this.constraints) {
      const a = c.a, b = c.b;
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-5;
      const diff = (d - c.rest) / d;
      const mx = dx * diff * 0.5, my = dy * diff * 0.5, mz = dz * diff * 0.5;
      const aLocked = a.pos.y < 0.05, bLocked = b.pos.y < 0.05;
      if (!aLocked) { a.pos.x += mx; a.pos.y += my; a.pos.z += mz; }
      if (!bLocked) { b.pos.x -= mx; b.pos.y -= my; b.pos.z -= mz; }
    }
  }

  collide() {
    const boxes = this.colliders.near(this.points[0].pos, 6);
    for (const p of this.points) {
      // ground
      if (p.pos.y < p.radius) {
        p.pos.y = p.radius;
        p.vel.x *= 0.55; p.vel.z *= 0.55;
        if (Math.abs(p.vel.y) < 0.6) p.vel.y = 0;
      }
      for (const b of boxes) {
        // cheap broadphase then a closest-point push-out
        if (b.center.distanceToSquared(p.pos) > (b.radius + p.radius + 0.5) ** 2) continue;
        b.worldToLocal(p.pos, _tmpA);
        const cx = clamp(_tmpA.x, -b.half.x, b.half.x);
        const cy = clamp(_tmpA.y, -b.half.y, b.half.y);
        const cz = clamp(_tmpA.z, -b.half.z, b.half.z);
        _tmpB.set(cx, cy, cz);
        const d = _tmpA.distanceTo(_tmpB);
        if (d < p.radius) {
          let n;
          if (d > 1e-4) {
            n = _tmpA.clone().sub(_tmpB).multiplyScalar(1 / d);
          } else {
            // inside: push out along the shallowest axis
            const ox = b.half.x - Math.abs(_tmpA.x);
            const oy = b.half.y - Math.abs(_tmpA.y);
            const oz = b.half.z - Math.abs(_tmpA.z);
            n = new THREE.Vector3();
            if (ox < oy && ox < oz) n.x = _tmpA.x >= 0 ? 1 : -1;
            else if (oy < oz) n.y = _tmpA.y >= 0 ? 1 : -1;
            else n.z = _tmpA.z >= 0 ? 1 : -1;
          }
          n.applyQuaternion(b.quat);
          const push = p.radius - d;
          p.pos.addScaledVector(n, push + 1e-3);
          p.vel.multiplyScalar(0.6);
        }
      }
    }
  }

  /** Drive the visual rig from the particles. */
  sampleBones() {
    const e = this.enemy;
    const bones = e.bones;
    for (const p of this.points) {
      const node = bones[p.node];
      if (!node || !node.parent) continue;
      const world = p.pos.clone();
      node.parent.worldToLocal(world);
      node.position.copy(world);
      node.updateWorldMatrix(true, false);
    }
    // Orient limbs towards their child particles so the mesh follows the body.
    for (const c of this.constraints) {
      const a = this.byName[c.a.name], b = c.b;
      const nodeA = bones[a.node], nodeB = bones[b.node];
      if (!nodeA || !nodeB) continue;
      const dirWorld = new THREE.Vector3().subVectors(b.pos, a.pos);
      if (dirWorld.lengthSq() < 1e-6) continue;
      dirWorld.normalize();
      const parentInv = nodeA.parent.getWorldQuaternion(_tmpQ2).invert();
      const localDir = dirWorld.clone().applyQuaternion(parentInv);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), localDir);
      nodeA.quaternion.slerp(q, 0.85);
    }
    e.group.updateMatrixWorld(true);
  }
}

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();

/* ------------------------------------------------------------------ pool - */

export class EnemyPool {
  constructor(game, materials, audio, particles, settings) {
    this.game = game;
    this.materials = materials;
    this.audio = audio;
    this.particles = particles;
    this.settings = settings;
    this.enemies = [];
    this.maxCorpses = 6;
  }

  spawn(pos, opts = {}) {
    let e = this.enemies.find((x) => !x.alive && (x.corpseTimer > 12 || !x.group.visible));
    if (!e) {
      e = new Enemy(this.game, this.materials, this.audio, this.particles, opts);
      this.enemies.push(e);
    }
    // NOTE: the weapon mesh is cloned at construction, so a recycled body keeps
    // its original weapon type — the pool therefore spawns one type per body.
    e.health = opts.health ?? e.maxHealth;
    e.maxHealth = e.health;
    e.accuracy = opts.accuracy ?? e.accuracy;
    e.suppressTimer = 0;
    e.spawn(pos, opts.yaw ?? rand(0, TAU), opts);
    return e;
  }

  update(dt, player) {
    for (const e of this.enemies) {
      if (!e.group.visible) continue;
      e.update(dt, player, this.game);
      // retire old corpses
      if (!e.alive && e.corpseTimer > 25) e.group.visible = false;
    }
    // keep the corpse count sane
    const corpses = this.enemies.filter((e) => !e.alive && e.group.visible);
    if (corpses.length > this.maxCorpses) {
      corpses.sort((a, b) => b.corpseTimer - a.corpseTimer);
      for (let i = this.maxCorpses; i < corpses.length; i++) corpses[i].group.visible = false;
    }
  }

  get alive() { return this.enemies.filter((e) => e.alive && e.group.visible); }

  /** Nearest enemy hit along a ray (used by the weapon system). */
  hitTest(origin, dir, maxDist, tmp) {
    let best = null;
    for (const e of this.enemies) {
      if (!e.group.visible) continue;
      // broadphase: distance from the ray to the body centre
      const center = tmp.copy(e.pos).setY(e.pos.y + 0.95);
      const to = center.clone().sub(origin);
      const along = to.dot(dir);
      if (along < -1 || along > maxDist + 1) continue;
      const perp = to.addScaledVector(dir, -along).length();
      if (perp > 1.3) continue;
      const hit = e.hitTest(origin, dir, maxDist);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }

  clear() {
    for (const e of this.enemies) { e.group.visible = false; e.alive = false; }
  }
}
