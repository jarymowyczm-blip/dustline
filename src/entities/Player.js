/**
 * Player.js — first-person controller.
 *
 * Movement is a Quake-style accelerate/friction model, retuned to human
 * numbers: 3.4 m/s walk, 6.2 m/s sprint, 1.7 m/s crouch, 0.6 m jump, with
 * almost no air control. Collision is a vertical capsule resolved against the
 * level's OBB world (CollisionWorld.resolveCapsule), which also reports the
 * surface underfoot so footsteps, impacts and dust use the right material.
 *
 * The camera adds the small stuff that makes first person feel alive: head bob
 * driven by distance travelled, breathing idle, strafe lean, landing punches
 * and additive weapon recoil.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep, Spring, wrapAngle } from '../core/Utils.js';

export const CROUCH_HEIGHT = 1.32;
export const STAND_HEIGHT = 1.80;
export const EYE_STAND = 1.66;
export const EYE_CROUCH = 1.12;
const RADIUS = 0.34;

export class Player {
  constructor(camera, level, audio, settings) {
    this.camera = camera;
    this.level = level;
    this.colliders = level.colliders;
    this.audio = audio;
    this.settings = settings;

    this.pos = new THREE.Vector3(0, 0, 76);      // feet position
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.height = STAND_HEIGHT;
    this.eyeHeight = EYE_STAND;
    this.crouchBlend = 0;
    this.grounded = true;
    this.surface = 'sand';

    this.health = 100;
    this.maxHealth = 100;
    this.stamina = 100;
    this.alive = true;
    this.lastDamageTime = -99;

    this.adsBlend = 0;
    this.sprinting = false;
    this.crouching = false;

    // view state
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.stepDistance = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilRoll = 0;
    this.cameraShake = 0;
    this.landPunch = 0;
    this.spreadAdded = 0;      // extra inaccuracy from movement
    this.suppression = 0;
    this.breath = 0;
    this.holdBreath = false;

    this.roll = 0;
    this._leanVel = 0;
    this._lastYaw = 0;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._tmp = new THREE.Vector3();
    this._wishDir = new THREE.Vector3();

    this.deathTime = 0;
    this.kills = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.headshots = 0;
    this.damageDealt = 0;
    this.distanceTravelled = 0;
    this.onFootstep = null;
    this.onLand = null;
    this.onDamage = null;
    this.onDeath = null;
  }

  spawn(pos, ry = 0) {
    this.pos.copy(pos);
    this.pos.y = this.colliders.groundAt(pos.x, pos.z);
    this.vel.set(0, 0, 0);
    this.yaw = ry; this.pitch = 0;
    this.health = this.maxHealth;
    this.stamina = 100;
    this.alive = true;
    this.recoilPitch = this.recoilYaw = this.recoilRoll = 0;
    this.cameraShake = 0;
    this.height = STAND_HEIGHT;
    this.eyeHeight = EYE_STAND;
    this.crouchBlend = 0;
    this.sprinting = false;
    this.suppression = 0;
  }

  get eyePos() {
    return this._tmp.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  /* ------------------------------------------------------------ movement - */

  update(dt, input, game) {
    dt = Math.min(dt, 1 / 30);
    if (!this.alive) {
      this.deathTime += dt;
      // dead: sink the camera and lock the view to the killer
      this.eyeHeight = damp(this.eyeHeight, 0.25, 4, dt);
      this.vel.y -= 22 * dt;
      this.pos.addScaledVector(this.vel, dt);
      const r = this.colliders.resolveCapsule(this.pos, RADIUS, 0.6);
      this.grounded = r.grounded;
      this.vel.multiplyScalar(1 - Math.min(1, 8 * dt));
      this._applyCamera(dt, 0);
      return;
    }

    /* ---- look ---------------------------------------------------------- */
    const sensScale = 0.00022 * (this.settings.get('sensitivity') / 38) *
      (this.adsBlend > 0.01 ? lerp(1, this.settings.get('adsSensMultiplier') / 100, this.adsBlend) : 1);
    const invert = this.settings.get('invertY') ? -1 : 1;
    this.yaw -= input.mouse.dx * sensScale;
    this.pitch -= input.mouse.dy * sensScale * invert;
    this.yaw = wrapAngle(this.yaw);
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    /* ---- stance -------------------------------------------------------- */
    const wantCrouch = input.key('crouch');
    this.crouching = wantCrouch;
    const targetHeight = wantCrouch ? CROUCH_HEIGHT : STAND_HEIGHT;
    this.height = damp(this.height, targetHeight, 12, dt);
    this.crouchBlend = damp(this.crouchBlend, wantCrouch ? 1 : 0, 12, dt);
    const eyeTarget = lerp(EYE_STAND, EYE_CROUCH, this.crouchBlend);

    /* ---- wish direction ------------------------------------------------ */
    const fwd = (input.key('forward') ? 1 : 0) - (input.key('back') ? 1 : 0);
    const side = (input.key('right') ? 1 : 0) - (input.key('left') ? 1 : 0);
    const wish = this._wishDir.set(0, 0, 0);
    if (fwd || side) {
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      // forward is -Z at yaw 0
      wish.x += -sy * fwd + cy * side;
      wish.z += -cy * fwd - sy * side;
      wish.normalize();
    }
    const wantSprint = this.settings.get('sprintMode') === 'toggle'
      ? (input.key('sprint') || this._sprintLatch)
      : input.key('sprint');
    if (this.settings.get('sprintMode') === 'toggle' && input.down('sprintToggle')) {
      this._sprintLatch = !this._sprintLatch;
    }
    this.sprinting = !!wantSprint && fwd > 0 && !wantCrouch && this.adsBlend < 0.4 && this.stamina > 4;
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - 16 * dt);
    } else {
      this.stamina = Math.min(100, this.stamina + (this.speed < 0.5 ? 26 : 12) * dt);
    }

    /* ---- speed --------------------------------------------------------- */
    const adsFactor = lerp(1, 0.52, this.adsBlend);
    let maxSpeed = this.sprinting ? 6.2 : 3.4;
    if (wantCrouch) maxSpeed = 1.7;
    maxSpeed *= adsFactor;
    if (this.health < 35) maxSpeed *= 0.88;

    /* ---- accelerate / friction ---------------------------------------- */
    const accel = this.grounded ? 12 : 2.2;
    const friction = this.grounded ? 9 : 0.3;

    if (this.grounded) {
      const sp = this.speed;
      if (sp > 0.001) {
        const drop = sp * friction * dt;
        const nf = Math.max(sp - drop, 0) / sp;
        this.vel.x *= nf; this.vel.z *= nf;
      } else {
        this.vel.x = this.vel.z = 0;
      }
    }
    if (wish.lengthSq() > 0.001) {
      const current = this.vel.x * wish.x + this.vel.z * wish.z;
      const add = maxSpeed - current;
      if (add > 0) {
        const a = Math.min(accel * maxSpeed * dt, add);
        this.vel.x += wish.x * a;
        this.vel.z += wish.z * a;
      }
    }

    /* ---- jump ---------------------------------------------------------- */
    if (input.down('jump') && this.grounded && !wantCrouch && this.stamina > 12 && this.adsBlend < 0.5) {
      this.vel.y = 5.35;
      this.stamina -= 14;
      this.grounded = false;
      this.audio?.play('jump', { pos: this.pos, surface: this.surface });
    }

    /* ---- gravity + collision ------------------------------------------ */
    this.vel.y -= 23.5 * dt;
    if (this.vel.y < -55) this.vel.y = -55;

    const wasGrounded = this.grounded;
    const prevVelY = this.vel.y;

    // Move on the horizontal plane first, then vertically: this makes step-ups
    // reliable and stops the capsule from launching off stairs.
    const move = this._tmp.copy(this.vel).multiplyScalar(dt);
    this.pos.x += move.x;
    this.pos.z += move.z;
    this.pos.y += move.y;

    const res = this.colliders.resolveCapsule(this.pos, RADIUS, this.height, { stepHeight: 0.48 });
    this.grounded = res.grounded;
    this.surface = res.groundSurface;

    // If we were pushed back in Z, cancel that velocity component (wall slide).
    const pushedZ = Math.abs(this.pos.z - (this.pos.z + 0)) ;
    if (res.normal.y < 0.7) {
      // kill outward velocity along the collision normal
      const vn = this.vel.x * res.normal.x + this.vel.z * res.normal.z;
      if (vn < 0) {
        this.vel.x -= res.normal.x * vn;
        this.vel.z -= res.normal.z * vn;
      }
    }

    if (res.grounded && this.vel.y < 0) {
      const impact = prevVelY;
      this.vel.y = 0;
      if (!wasGrounded && impact < -4) {
        this.landPunch = clamp01((-impact - 4) / 9);
        this.cameraShake = Math.max(this.cameraShake, this.landPunch * 0.5);
        this.audio?.play('land', { pos: this.pos, surface: this.surface, force: this.landPunch });
        this.onLand?.(this.landPunch);
      }
    }

    /* ---- footsteps ----------------------------------------------------- */
    const planar = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && planar > 0.6) {
      this.stepDistance += planar * dt;
      const stride = this.sprinting ? 0.78 : this.crouching ? 0.62 : 0.66;
      if (this.stepDistance >= stride) {
        this.stepDistance = 0;
        this.audio?.play('footstep', {
          pos: this.pos, surface: this.surface,
          force: clamp01(planar / 6) * (this.crouching ? 0.35 : 1),
        });
        this.onFootstep?.(this.surface);
        if (this.settings.get('gore') && planar > 4.4) {
          // sprinting kicks up a little dust
          this.dustKick = true;
        }
      }
    }
    this.distanceTravelled += planar * dt;

    /* ---- bob + breathing ---------------------------------------------- */
    const bobTarget = this.settings.get('bob') ? clamp01(planar / 6) * (1 - this.adsBlend * 0.75) : 0;
    this.bobAmount = damp(this.bobAmount, bobTarget, 9, dt);
    this.bobPhase += dt * (this.sprinting ? 11.5 : 8.4) * clamp(planar / 3.4, 0.4, 1.6);
    this.breath += dt * (this.holdBreath ? 0.6 : 1.05);
    this.holdBreath = this.adsBlend > 0.7 && input.mouseDown(2);

    /* ---- recoil recovery ---------------------------------------------- */
    this.recoilPitch = damp(this.recoilPitch, 0, 7.5, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 7.5, dt);
    this.recoilRoll = damp(this.recoilRoll, 0, 6, dt);
    this.cameraShake = damp(this.cameraShake, 0, 6, dt);
    this.landPunch = damp(this.landPunch, 0, 7, dt);

    /* ---- suppression + health ----------------------------------------- */
    this.suppression = damp(this.suppression, 0, 1.6, dt);
    if (this.health < this.maxHealth && game?.time - this.lastDamageTime > 5.5) {
      this.health = Math.min(this.maxHealth, this.health + 13 * dt);
    }

    /* ---- ADS blend ----------------------------------------------------- */
    const wantAds = game?.weapon?.wantsAds?.() ?? false;
    this.adsBlend = damp(this.adsBlend, wantAds ? 1 : 0, 13, dt);

    this.eyeHeight = damp(this.eyeHeight, eyeTarget, 18, dt);

    this._applyCamera(dt, planar);
  }

  _applyCamera(dt, planar) {
    const cam = this.camera;
    const t = performance.now() / 1000;

    // Head bob: vertical + horizontal figure-8, plus a subtle roll.
    const bob = this.bobAmount;
    const bx = Math.sin(this.bobPhase) * 0.042 * bob * (1 - this.adsBlend * 0.6);
    const by = Math.abs(Math.sin(this.bobPhase * 2)) * -0.028 * bob * (1 - this.adsBlend * 0.6);
    const breathing = Math.sin(this.breath) * 0.0035 * (1 - this.holdBreath * 0.85);

    // Strafe lean: lean into lateral acceleration.
    const targetRoll = clamp(-this.vel.x * Math.cos(-this.yaw) * 0.006 + this.vel.z * Math.sin(-this.yaw) * 0.006, -0.045, 0.045);
    this.roll = damp(this.roll, targetRoll, 6, dt);

    const shake = this.cameraShake;
    const sx = (Math.sin(t * 47.3) + Math.sin(t * 23.1)) * 0.5 * shake * 0.02;
    const sy = (Math.cos(t * 39.7) + Math.sin(t * 51.9)) * 0.5 * shake * 0.02;

    // Landing dip
    const dip = -this.landPunch * 0.16;

    cam.position.set(
      this.pos.x + bx * Math.cos(this.yaw) + sx,
      this.pos.y + this.eyeHeight + by + breathing + dip + sy,
      this.pos.z - bx * Math.sin(this.yaw),
    );

    this._euler.set(
      this.pitch + this.recoilPitch,
      this.yaw + this.recoilYaw,
      this.roll + this.recoilRoll + Math.sin(this.bobPhase) * 0.006 * bob,
      'YXZ',
    );
    cam.quaternion.setFromEuler(this._euler);
  }

  /* --------------------------------------------------------------- combat - */

  /** Additive recoil applied to the view, with partial auto-recovery. */
  addRecoil(pitch, yaw, roll = 0) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.recoilRoll += roll;
    this.cameraShake = Math.min(1.1, this.cameraShake + 0.10);
    // Push the aim point so sustained fire walks the muzzle upward, like real
    // automatic fire — the player must pull down to compensate.
    this.pitch += pitch * 0.22;
    this.yaw += yaw * 0.16;
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  }

  takeDamage(amount, fromPos = null) {
    if (!this.alive) return;
    this.health -= amount;
    this.lastDamageTime = performance.now() / 1000;
    this.cameraShake = Math.min(1.4, this.cameraShake + clamp01(amount / 40) * 0.8);
    // Getting hit wrecks your accuracy for a moment.
    this.suppression = Math.min(1, this.suppression + clamp01(amount / 45));
    this.onDamage?.(amount, fromPos);
    this.audio?.play('playerHit', { pos: this.pos, surface: 'flesh' });
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deathTime = 0;
      this.audio?.play('death', { pos: this.pos });
      this.onDeath?.();
    }
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Accuracy penalty from motion, stance and suppression (radians). */
  currentInaccuracy() {
    let s = 0;
    s += this.speed * 0.0026;
    if (!this.grounded) s += 0.030;
    if (this.crouching) s *= 0.62;
    s += this.suppression * 0.014;
    s += (100 - this.stamina) * 0.00012;
    if (this.holdBreath) s *= 0.55;
    return s;
  }
}
