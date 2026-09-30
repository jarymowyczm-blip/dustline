/**
 * Collision.js — an analytic oriented-box world.
 *
 * The entire level is built from boxes, so instead of mesh raycasts (which
 * would need a BVH to be fast) movement, bullets, explosions and AI line of
 * sight all query a list of OBBs. A ray against an OBB is a slab test in the
 * box's local space — about 40 ns each — so hundreds of boxes are affordable.
 *
 * Every box carries a `surface` tag (concrete / metal / sand / wood / glass)
 * which drives impact decals, particles, audio and penetration.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Private scratch for the raycast path. These MUST NOT alias `_v`/`_v2`:
// callers legitimately pass shared temporaries as the ray origin and direction,
// and transforming them in place would corrupt the caller's own maths.
const _rOrig = new THREE.Vector3();
const _rDir = new THREE.Vector3();
const _rNorm = new THREE.Vector3();

/** How a bullet behaves on contact with each surface type. */
export const SURFACE = {
  concrete: { penetration: 0.06, density: 1.0, spark: 0.0, dust: 1.0, blood: 0, sound: 'concrete' },
  asphalt: { penetration: 0.05, density: 1.0, spark: 0.0, dust: 0.8, blood: 0, sound: 'concrete' },
  sand: { penetration: 0.16, density: 0.7, spark: 0.0, dust: 1.2, blood: 0, sound: 'sand' },
  dirt: { penetration: 0.14, density: 0.8, spark: 0.0, dust: 1.1, blood: 0, sound: 'sand' },
  metal: { penetration: 0.022, density: 1.6, spark: 1.0, dust: 0.3, blood: 0, sound: 'metal' },
  thinMetal: { penetration: 0.045, density: 1.1, spark: 0.8, dust: 0.2, blood: 0, sound: 'metal' },
  wood: { penetration: 0.09, density: 0.6, spark: 0.0, dust: 0.5, blood: 0, sound: 'wood' },
  glass: { penetration: 0.5, density: 0.3, spark: 0.0, dust: 0.2, blood: 0, sound: 'glass' },
  cloth: { penetration: 0.7, density: 0.2, spark: 0.0, dust: 0.1, blood: 0, sound: 'cloth' },
  flesh: { penetration: 0.4, density: 0.5, spark: 0.0, dust: 0, blood: 1, sound: 'flesh' },
  sandbag: { penetration: 0.07, density: 0.9, spark: 0.0, dust: 1.0, blood: 0, sound: 'sand' },
  rubber: { penetration: 0.08, density: 0.5, spark: 0.0, dust: 0.2, blood: 0, sound: 'cloth' },
};

// How far above/below the feet the ground probe looks.
const PROBE_UP = 0.10;
const PROBE_DOWN = 0.42;

export class BoxCollider {
  /**
   * @param {THREE.Vector3} center
   * @param {THREE.Vector3} half
   * @param {number} rotY radians
   * @param {string} surface SURFACE key
   */
  constructor(center, half, rotY = 0, surface = 'concrete', opts = {}) {
    this.center = center.clone();
    this.half = half.clone();
    this.rotY = rotY;
    this.surface = surface;
    this.penetrationScale = opts.penetrationScale ?? 1;
    this.invisible = !!opts.invisible;
    this.transparent = !!opts.transparent;      // glass / cloth: no LOS block
    this.climbable = opts.climbable !== false;
    this.radius = this.half.length();
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    this.quat = _q.clone();
    this.invQuat = this.quat.clone().invert();
    this.enabled = true;
  }

  worldToLocal(p, out) {
    return out.copy(p).sub(this.center).applyQuaternion(this.invQuat);
  }
  localToWorld(p, out) {
    return out.copy(p).applyQuaternion(this.quat).add(this.center);
  }

  containsPoint(p) {
    this.worldToLocal(p, _v);
    return Math.abs(_v.x) <= this.half.x && Math.abs(_v.y) <= this.half.y && Math.abs(_v.z) <= this.half.z;
  }
}

/** Distance from point to the box (0 when inside). */
function pointBoxDistance(box, p, closestOut) {
  box.worldToLocal(p, _v);
  const cx = THREE.MathUtils.clamp(_v.x, -box.half.x, box.half.x);
  const cy = THREE.MathUtils.clamp(_v.y, -box.half.y, box.half.y);
  const cz = THREE.MathUtils.clamp(_v.z, -box.half.z, box.half.z);
  if (closestOut) closestOut.set(cx, cy, cz);
  const dx = _v.x - cx, dy = _v.y - cy, dz = _v.z - cz;
  const inside = dx === 0 && dy === 0 && dz === 0;
  return { dist: Math.sqrt(dx * dx + dy * dy + dz * dz), inside };
}

export class CollisionWorld {
  constructor() {
    this.boxes = [];
    this.ground = 0;
    this._grid = null;
  }

  add(center, half, rotY = 0, surface = 'concrete', opts = {}) {
    const b = new BoxCollider(center, half, rotY, surface, opts);
    this.boxes.push(b);
    return b;
  }

  /** Uniform grid broadphase — rebuilt lazily when boxes are added. */
  _buildGrid() {
    const cell = 12;
    const grid = new Map();
    for (const b of this.boxes) {
      const r = b.radius;
      const minX = Math.floor((b.center.x - r) / cell);
      const maxX = Math.floor((b.center.x + r) / cell);
      const minZ = Math.floor((b.center.z - r) / cell);
      const maxZ = Math.floor((b.center.z + r) / cell);
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const k = `${x},${z}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(b);
        }
      }
    }
    this._grid = { cell, map: grid };
  }

  /** Boxes near a point (broadphase), falling back to everything if no grid. */
  near(p, radius = 4, out = []) {
    out.length = 0;
    if (!this._grid) this._buildGrid();
    const { cell, map } = this._grid;
    const minX = Math.floor((p.x - radius) / cell);
    const maxX = Math.floor((p.x + radius) / cell);
    const minZ = Math.floor((p.z - radius) / cell);
    const maxZ = Math.floor((p.z + radius) / cell);
    const seen = new Set();
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const list = map.get(`${x},${z}`);
        if (!list) continue;
        for (const b of list) {
          if (b.enabled && !seen.has(b)) { seen.add(b); out.push(b); }
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- raycast - */

  /**
   * Ray vs all enabled boxes.
   * @returns {?{distance:number, point:THREE.Vector3, normal:THREE.Vector3, box:BoxCollider}}
   */
  raycast(origin, direction, maxDist = 500, opts = {}) {
    const { ignoreTransparent = false, filter = null } = opts;
    let best = null;
    let bestT = maxDist;

    for (const b of this.boxes) {
      if (!b.enabled) continue;
      if (ignoreTransparent && b.transparent) continue;
      if (filter && !filter(b)) continue;
      const t = this._rayBox(b, origin, direction, bestT);
      if (t !== null && t < bestT) { bestT = t; best = b; }
    }
    if (!best) return null;

    // Build the hit record with fresh vectors: callers keep their own temps.
    const point = new THREE.Vector3().copy(direction).multiplyScalar(bestT).add(origin);
    const normal = this._boxNormal(best, point, new THREE.Vector3());
    return { distance: bestT, point, normal, box: best };
  }

  /** Slab test in box local space. Returns hit distance or null. */
  _rayBox(b, origin, dir, maxDist) {
    b.worldToLocal(origin, _rOrig);
    const d = _rDir.copy(dir).applyQuaternion(b.invQuat);
    let tmin = 0, tmax = maxDist;

    // X
    if (Math.abs(d.x) < 1e-9) {
      if (Math.abs(_rOrig.x) > b.half.x) return null;
    } else {
      const inv = 1 / d.x;
      let t1 = (-b.half.x - _rOrig.x) * inv;
      let t2 = (b.half.x - _rOrig.x) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    // Y
    if (Math.abs(d.y) < 1e-9) {
      if (Math.abs(_rOrig.y) > b.half.y) return null;
    } else {
      const inv = 1 / d.y;
      let t1 = (-b.half.y - _rOrig.y) * inv;
      let t2 = (b.half.y - _rOrig.y) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    // Z
    if (Math.abs(d.z) < 1e-9) {
      if (Math.abs(_rOrig.z) > b.half.z) return null;
    } else {
      const inv = 1 / d.z;
      let t1 = (-b.half.z - _rOrig.z) * inv;
      let t2 = (b.half.z - _rOrig.z) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (tmin < 0) {
      // Origin starts inside the box — report an immediate surface contact.
      return 0.0001;
    }
    return tmin;
  }

  /**
   * Outward face normal at a world-space point on the box surface.
   * The axis is recovered from which face the point is closest to, so it is
   * independent of test order across the box list.
   */
  _boxNormal(b, point, out) {
    b.worldToLocal(point, _rNorm);
    const n = out || new THREE.Vector3();
    const dx = Math.abs(b.half.x - Math.abs(_rNorm.x));
    const dy = Math.abs(b.half.y - Math.abs(_rNorm.y));
    const dz = Math.abs(b.half.z - Math.abs(_rNorm.z));
    if (dx <= dy && dx <= dz) n.set(_rNorm.x >= 0 ? 1 : -1, 0, 0);
    else if (dy <= dz) n.set(0, _rNorm.y >= 0 ? 1 : -1, 0);
    else n.set(0, 0, _rNorm.z >= 0 ? 1 : -1);
    return n.applyQuaternion(b.quat).normalize();
  }

  /** Line of sight between two points (used by AI). */
  lineOfSight(from, to, opts = {}) {
    const dir = _v.copy(to).sub(from);
    const dist = dir.length();
    if (dist < 1e-4) return true;
    dir.multiplyScalar(1 / dist);
    const hit = this.raycast(from, dir, dist, { ignoreTransparent: true, ...opts });
    return !hit;
  }

  /* ------------------------------------------------------------ movement - */

  /**
   * Resolve a vertical capsule against the world.
   * @param {THREE.Vector3} feet capsule bottom-centre (mutated)
   * @param {number} radius
   * @param {number} height
   * @returns {{grounded:boolean, groundSurface:string, normal:THREE.Vector3}}
   */
  resolveCapsule(feet, radius, height, opts = {}) {
    const normal = new THREE.Vector3(0, 1, 0);
    const maxStep = opts.stepHeight ?? 0.48;
    let grounded = false;
    let groundSurface = 'concrete';
    let iterations = 0;

    const candidates = this.near(feet, radius + 3);

    // A vertical capsule only ever needs horizontal push-out: the segment is
    // axis-aligned in every box's local space (boxes are only ever yaw-rotated),
    // so XZ distance from the segment axis to the box is the whole story.
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const b of candidates) {
        if (!b.enabled) continue;
        const r = b.radius + radius + height;
        const ddx = b.center.x - feet.x, ddy = b.center.y - feet.y, ddz = b.center.z - feet.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz > r * r) continue;

        b.worldToLocal(feet, _v);
        const segY0 = _v.y + radius;                 // bottom sphere centre
        const segY1 = _v.y + height - radius;        // top sphere centre

        const qx = THREE.MathUtils.clamp(_v.x, -b.half.x, b.half.x);
        const qz = THREE.MathUtils.clamp(_v.z, -b.half.z, b.half.z);
        const dxL = _v.x - qx, dzL = _v.z - qz;
        const dXZ = Math.hypot(dxL, dzL);

        const yOverlap = segY1 > -b.half.y && segY0 < b.half.y;
        const topY = b.center.y + b.half.y;

        if (!yOverlap) {
          // Entirely above (step/land) or below the box: only the sphere end matters.
          if (segY0 >= b.half.y) {
            const gap = (segY0 - b.half.y);
            if (Math.hypot(dXZ, gap) >= radius) continue;
            const stepUp = topY - feet.y;
            if (stepUp > 0 && stepUp <= maxStep && dXZ < radius) {
              feet.y = topY;
              grounded = true; groundSurface = b.surface;
              normal.set(0, 1, 0);
              moved = true;
              continue;
            }
            continue;   // resting on top is handled by the downward probe
          }
          continue;
        }

        if (dXZ >= radius) continue;

        // ---- we are inside the box's horizontal footprint ------------------
        if (dXZ < 1e-5) {
          // Deep inside: escape along the shallowest local axis.
          const ox = b.half.x - Math.abs(_v.x);
          const oz = b.half.z - Math.abs(_v.z);
          _v2.set(0, 0, 0);
          if (ox < oz) _v2.x = _v.x >= 0 ? 1 : -1;
          else _v2.z = _v.z >= 0 ? 1 : -1;
        } else {
          _v2.set(dxL / dXZ, 0, dzL / dXZ);
        }
        const worldN = _v2.applyQuaternion(b.quat).setY(0).normalize();
        const push = radius - dXZ + 1e-3;
        feet.x += worldN.x * push;
        feet.z += worldN.z * push;
        normal.copy(worldN);
        moved = true;
      }
      iterations = iter;
      if (!moved) break;
    }

    // ---- ground probe ------------------------------------------------------
    // Cast from just above the feet downward far enough to catch a surface the
    // feet are hovering above (landing, stepping down a kerb).
    const probeOrigin = new THREE.Vector3(feet.x, feet.y + PROBE_UP, feet.z);
    const probeDir = new THREE.Vector3(0, -1, 0);
    const hit = this.raycast(probeOrigin, probeDir, PROBE_UP + PROBE_DOWN, {
      ignoreTransparent: true,
      filter: (b) => b.climbable,
    });
    if (hit && hit.point.y <= feet.y + 0.12) {
      feet.y = hit.point.y;
      grounded = true;
      groundSurface = hit.box.surface;
      normal.copy(hit.normal);
    }
    // The open ground/terrain plane is implicit (y = ground) rather than a box,
    // so treat it as a surface when the capsule is standing on it.
    if (!grounded && feet.y <= this.ground + 0.06) {
      feet.y = this.ground;
      grounded = true;
      groundSurface = 'sand';
      normal.set(0, 1, 0);
    }
    if (feet.y < this.ground) { feet.y = this.ground; grounded = true; groundSurface = 'sand'; }

    return { grounded, groundSurface, normal, iterations };
  }

  /**
   * Find the highest surface under a point (spawn placement, AI ground snap).
   * Returns y in world units.
   */
  groundAt(x, z, fromY = 60) {
    const hit = this.raycast(
      new THREE.Vector3(x, fromY, z),
      new THREE.Vector3(0, -1, 0),
      fromY - this.ground + 1,
      { filter: (b) => b.climbable },
    );
    return hit ? hit.point.y : this.ground;
  }

  /**
   * Can a 1.8 m body stand at this point? Used to reject AI spawns.
   */
  isClear(pos, radius = 0.4, height = 1.7) {
    const probe = pos.clone();
    const r = this.resolveCapsule(probe, radius, height);
    return probe.distanceTo(pos) < 0.25 && r.grounded;
  }

  /** Nearest point that is not inside geometry (spawn recovery). */
  findOpenSpot(pos, radius = 0.4) {
    if (this.isClear(pos, radius)) return pos;
    for (let ring = 1; ring <= 6; ring++) {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const c = new THREE.Vector3(pos.x + Math.cos(a) * ring, pos.y, pos.z + Math.sin(a) * ring);
        c.y = this.groundAt(c.x, c.z);
        if (this.isClear(c, radius)) return c;
      }
    }
    return pos;
  }
}
