/**
 * Level.js — "Dustline Outpost".
 *
 * A fortified desert compound at golden hour. Static geometry is accumulated
 * per material and merged into a handful of meshes at the end of the build, so
 * the whole map costs ~20 draw calls. Every solid volume also registers an OBB
 * in the CollisionWorld with a surface tag, which is what bullets, footsteps,
 * AI line of sight and explosions query.
 *
 * Layout (approx 220 × 220 m playable):
 *
 *        ┌──── perimeter T-walls, 3 m ────┐
 *        │  motor pool      barracks      │
 *        │  (open shed)     (2 floors)    │
 *        │                                │
 *        │  market       warehouse   ▣    │  ▣ = guard tower
 *        │  stalls       (containers)     │
 *        │        ▓ gate / player spawn   │
 *        └────────────────────────────────┘
 */

import * as THREE from 'three';
import { PartBuilder, rbox, box, cylinder, sphere, torus, wedge, tube, strut, at } from './ModelKit.js';
import { CollisionWorld } from './Collision.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, TAU, clamp } from '../core/Utils.js';

export class Level {
  constructor(scene, materials, settings) {
    this.scene = scene;
    this.M = materials;
    this.settings = settings;
    this.colliders = new CollisionWorld();
    this.rng = makeRng(20260929);

    this.buckets = new Map();      // material name → geometry[]
    this.spawnPoints = [];         // enemy spawn candidates {pos, ry}
    this.coverPoints = [];         // {pos, dir} — AI hides behind these
    // yaw 0 looks down −Z, i.e. from the gate toward the compound centre.
    this.playerSpawn = { pos: new THREE.Vector3(0, 0, 76), ry: 0 };
    this.rangeTargets = [];        // training range targets
    this.buildings = [];
    this.root = new THREE.Group();
    this.root.name = 'level';
  }

  /* ------------------------------------------------------- build helpers - */

  _bucket(name) {
    if (!this.buckets.has(name)) this.buckets.set(name, []);
    return this.buckets.get(name);
  }

  /** Add a bevelled box: visual geometry + collider. */
  addBox(mat, w, h, d, x, y, z, ry = 0, surface = 'concrete', opts = {}) {
    const geo = rbox(w, h, d, opts.r ?? Math.min(0.05, Math.min(w, d) * 0.25), opts.bevel ?? 0.008);
    this._bucket(mat).push(at(geo, [x, y, z], [0, ry, 0]));
    if (opts.collide !== false) {
      this.colliders.add(new THREE.Vector3(x, y, z), new THREE.Vector3(w / 2, h / 2, d / 2),
        ry, surface, opts);
    }
    return this;
  }

  /** Add a raw geometry (cylinder, wedge, torus...) — visual only by default. */
  addGeo(mat, geo, pos, rot = [0, 0, 0], opts = {}) {
    this._bucket(mat).push(at(geo, pos, rot));
    if (opts.collide && opts.half) {
      this.colliders.add(new THREE.Vector3(pos[0], pos[1], pos[2]),
        new THREE.Vector3(...opts.half), rot[1], opts.surface || 'metal');
    }
    return this;
  }

  /**
   * Wall with door/window openings.
   * @param {Array<{s0:number,s1:number,y0:number,y1:number}>} gaps local span + height band
   */
  wall(mat, { x, z, ry = 0, len, y0 = 0, h, t = 0.24, gaps = [], surface = 'concrete', collide = true }) {
    const list = gaps.slice().sort((a, b) => a.s0 - b.s0);
    const segs = [];
    let cursor = -len / 2;
    for (const g of list) {
      const s0 = clamp(g.s0, -len / 2, len / 2);
      const s1 = clamp(g.s1, -len / 2, len / 2);
      if (s0 > cursor + 1e-4) segs.push({ a: cursor, b: s0, y0, y1: y0 + h });
      // below opening
      if (g.y0 > y0 + 1e-4) segs.push({ a: s0, b: s1, y0, y1: g.y0 });
      // above opening
      if (y0 + h > g.y1 + 1e-4) segs.push({ a: s0, b: s1, y0: g.y1, y1: y0 + h });
      cursor = Math.max(cursor, s1);
    }
    if (cursor < len / 2 - 1e-4) segs.push({ a: cursor, b: len / 2, y0, y1: y0 + h });

    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (const s of segs) {
      const w = s.b - s.a;
      if (w < 1e-3) continue;
      const lx = (s.a + s.b) / 2;
      const hh = s.y1 - s.y0;
      const yy = (s.y0 + s.y1) / 2;
      const wx = x + lx * cos;
      const wz = z - lx * sin;
      this.addBox(mat, w, hh, t, wx, yy, wz, ry, surface, { collide, r: 0.03, bevel: 0.006 });
    }
    return this;
  }

  /** Rectangular room: four walls with per-wall openings, optional floor + roof. */
  room(opts) {
    const {
      x = 0, z = 0, w, d, h = 3, ry = 0, mat = 'plaster', t = 0.24,
      doors = [], windows = [], roof = null, floor = null, surface = 'concrete',
    } = opts;
    const place = (lx, lz, len, wallRy, gaps) => {
      // rotate the local offset into world space
      const c = Math.cos(ry), s = Math.sin(ry);
      const wx = x + lx * c - lz * s;
      const wz = z + lx * s + lz * c;
      this.wall(mat, { x: wx, z: wz, ry: ry + wallRy, len, y0: floor ?? 0, h, t, gaps, surface });
    };
    // north (local -z) and south (+z) walls span x
    for (const side of [-1, 1]) {
      const gaps = [];
      for (const o of [...doors, ...windows]) if (o.side === (side < 0 ? 'n' : 's')) gaps.push(o);
      place(0, side * d / 2, w, 0, gaps);
    }
    // west (-x) and east (+x) walls span z
    for (const side of [-1, 1]) {
      const gaps = [];
      for (const o of [...doors, ...windows]) if (o.side === (side < 0 ? 'w' : 'e')) gaps.push(o);
      place(side * w / 2, 0, d, Math.PI / 2, gaps);
    }

    const c = Math.cos(ry), s = Math.sin(ry);
    const cw = Math.abs(w * c) + Math.abs(d * s);
    const cd = Math.abs(w * s) + Math.abs(d * c);

    if (roof !== null) {
      this.addBox(mat, cw + 0.6, 0.26, cd + 0.6, x, floor === null ? h + 0.13 : (floor ?? 0) + h + 0.13, z, ry, surface, { r: 0.03 });
      // parapet
      const py = (floor ?? 0) + h + 0.4;
      this.addBox(mat, cw + 0.6, 0.5, 0.24, x - Math.sin(ry) * (cd / 2 + 0.2), py, z + Math.cos(ry) * (cd / 2 + 0.2), ry, surface);
      this.addBox(mat, cw + 0.6, 0.5, 0.24, x + Math.sin(ry) * (cd / 2 + 0.2), py, z - Math.cos(ry) * (cd / 2 + 0.2), ry, surface);
      this.addBox(mat, 0.24, 0.5, cd + 0.6, x + Math.cos(ry) * (cw / 2 + 0.2), py, z + Math.sin(ry) * (cw / 2 + 0.2), ry, surface);
      this.addBox(mat, 0.24, 0.5, cd + 0.6, x - Math.cos(ry) * (cw / 2 + 0.2), py, z - Math.sin(ry) * (cw / 2 + 0.2), ry, surface);
    }
    if (floor !== null) {
      this.addBox(mat, cw, 0.26, cd, x, floor - 0.13, z, ry, surface);
    }
    this.buildings.push({ x, z, w: cw, d: cd, h, ry });
    return this;
  }

  /** Stack of steps the player (and AI) can climb. */
  steps(mat, { x, z, ry = 0, width = 1.4, rise = 0.19, run = 0.30, count, y0 = 0 }) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (let i = 0; i < count; i++) {
      const h = rise * (i + 1);
      const lz = -i * run;
      const wx = x + lz * sin;
      const wz = z + lz * cos;
      this.addBox(mat, width, h, run, wx, y0 + h / 2, wz, ry, 'concrete', { r: 0.02, bevel: 0.005 });
    }
    return this;
  }

  /** Sandbag emplacement built from real bags. */
  sandbags(x, z, ry, { len = 4, rows = 3, bagW = 0.62, bagH = 0.24 } = {}) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (let r = 0; r < rows; r++) {
      const count = Math.floor(len / bagW) - r;
      for (let i = 0; i < count; i++) {
        const lx = (i - count / 2 + 0.5) * bagW + (r % 2) * bagW * 0.5;
        const wx = x + lx * cos;
        const wz = z - lx * sin;
        const y = 0.06 + r * bagH + bagH / 2;
        const g = rbox(bagW * 1.06, bagH * 0.94, 0.52, 0.13, 0.02);
        this._bucket('sandbag').push(at(g, [wx, y, wz],
          [this.rng.range(-0.03, 0.03), ry + this.rng.range(-0.09, 0.09), this.rng.range(-0.03, 0.03)]));
      }
    }
    // one collider for the whole emplacement
    this.addBox('sandbag', len, rows * bagH + 0.12, 0.55, x, (rows * bagH) / 2, z, ry, 'sandbag', { collide: true, r: 0.03, invisible: true });
    this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z), dir: ry });
    return this;
  }

  /** Shipping container with frame, doors and vents. */
  container(x, z, ry, colorMat = 'containerBlue', stack = 0) {
    const w = 2.44, h = 2.59, d = 6.06;
    const y = h / 2 + stack * (h + 0.02);
    this.addBox(colorMat, w, h, d, x, y, z, ry, 'metal', { r: 0.03, bevel: 0.01 });
    // corner posts + door frame details
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (const [lx, lz] of [[-w / 2 + 0.09, -d / 2 + 0.09], [w / 2 - 0.09, -d / 2 + 0.09], [-w / 2 + 0.09, d / 2 - 0.09], [w / 2 - 0.09, d / 2 - 0.09]]) {
      const wx = x + lx * cos - lz * sin;
      const wz = z + lx * sin + lz * cos;
      this.addBox('rustyMetal', 0.16, h, 0.16, wx, y, wz, ry, 'metal', { r: 0.02, collide: false });
      // corner castings top and bottom
      this.addBox('rustyMetal', 0.20, 0.22, 0.20, wx, y + h / 2 - 0.1, wz, ry, 'metal', { collide: false, r: 0.015 });
      this.addBox('rustyMetal', 0.20, 0.22, 0.20, wx, y - h / 2 + 0.1, wz, ry, 'metal', { collide: false, r: 0.015 });
    }
    // door end: two leaves with locking bars
    const dz = d / 2 + 0.03;
    for (const side of [-1, 1]) {
      const lx = side * w / 4;
      const wx = x + lx * cos - dz * sin;
      const wz = z + lx * sin + dz * cos;
      this.addBox(colorMat, w / 2 - 0.06, h - 0.2, 0.06, wx, y, wz, ry, 'metal', { collide: false, r: 0.02 });
      this.addBox('rustyMetal', 0.05, h - 0.3, 0.05, wx + (side * 0.25) * cos, y, wz + (side * 0.25) * sin, ry, 'metal', { collide: false, r: 0.01 });
    }
    // roof ribs
    for (let i = -2; i <= 2; i++) {
      this.addBox('rustyMetal', w * 0.9, 0.05, 0.09, x + (i * 1.1) * cos, y + h / 2 + 0.03, z + (i * 1.1) * sin, ry, 'metal', { collide: false, r: 0.01 });
    }
    this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z), dir: ry });
    return this;
  }

  /** Steel barrel, optionally on its side. */
  barrel(x, z, tipped = false, ry = 0) {
    const g = at(cylinder(0.29, 0.29, 0.88, 18), [x, tipped ? 0.29 : 0.44, z],
      tipped ? [Math.PI / 2, 0, ry] : [0, ry, 0]);
    this._bucket('rustyMetal').push(g);
    // rims
    for (const o of [0.42, -0.42]) {
      const rg = at(torus(0.295, 0.022, 8, 14), [x, tipped ? 0.29 : 0.44 + o, z], tipped ? [Math.PI / 2, 0, ry] : [Math.PI / 2, 0, 0]);
      this._bucket('rustyMetal').push(rg);
    }
    this.colliders.add(
      new THREE.Vector3(x, tipped ? 0.29 : 0.44, z),
      tipped ? new THREE.Vector3(0.29, 0.29, 0.45) : new THREE.Vector3(0.30, 0.44, 0.30),
      ry, 'metal',
    );
    return this;
  }

  /** Wooden crate stack. */
  crates(x, z, ry, rows = 2) {
    const size = 0.78;
    for (let r = 0; r < rows; r++) {
      const n = r === 0 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * (size + 0.06);
        const cos = Math.cos(ry), sin = Math.sin(ry);
        const wx = x + off * cos, wz = z - off * sin;
        const y = size / 2 + r * (size + 0.01);
        this.addBox('crateWood', size, size, size, wx, y, wz, ry + this.rng.range(-0.1, 0.1), 'wood', { r: 0.02, bevel: 0.006 });
        // frame slats on both faces
        for (const s of [-1, 1]) {
          for (const face of [-1, 1]) {
            const lz = face * size / 2;
            this.addBox('crateWood', size * 1.02, 0.06, 0.03,
              wx + (-lz * sin), y + s * size * 0.3, wz + (lz * cos), ry, 'wood', { collide: false, r: 0.01 });
          }
        }
      }
    }
    this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z), dir: ry });
    return this;
  }

  /** Jersey barrier. */
  jersey(x, z, ry) {
    const g = wedge(0.62, 0.82, 1.8);
    this._bucket('concrete').push(at(g, [x, 0.41, z], [0, ry, 0]));
    this.addBox('concrete', 0.62, 0.16, 1.8, x, 0.08, z, ry, 'concrete', { collide: false, r: 0.02 });
    this.colliders.add(new THREE.Vector3(x, 0.41, z), new THREE.Vector3(0.31, 0.41, 0.9), ry, 'concrete');
    this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z), dir: ry });
    return this;
  }

  /** Tall concrete T-wall segment (perimeter). */
  tWall(x, z, ry) {
    this.addBox('concrete', 3.6, 2.9, 0.22, x, 1.45, z, ry, 'concrete', { r: 0.02, bevel: 0.01 });
    this.addBox('concrete', 3.6, 0.30, 0.42, x, 3.0, z, ry, 'concrete', { r: 0.02, collide: false });
    this.addBox('concrete', 0.7, 0.30, 0.7, x, 0.15, z, ry, 'concrete', { collide: false, r: 0.02 });
    return this;
  }

  /** Palm tree: tapered trunk + cut-out fronds. */
  palm(x, z, height = 7) {
    const rng = this.rng;
    const segs = 10;
    let px = x, pz = z, py = 0;
    const lean = rng.range(0.02, 0.09);
    const dir = rng.range(0, TAU);
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const r = 0.26 * (1 - t * 0.55);
      const segH = height / segs;
      const g = at(cylinder(r * (1 - 1 / segs), r, segH * 1.1, 9),
        [px, py + segH / 2, pz], [lean * Math.sin(dir) * 3, 0, lean * Math.cos(dir) * 3]);
      this._bucket('bark').push(g);
      px += Math.sin(dir) * lean * segH * 1.4;
      pz += Math.cos(dir) * lean * segH * 1.4;
      py += segH;
    }
    this.colliders.add(new THREE.Vector3(x, height / 2, z), new THREE.Vector3(0.24, height / 2, 0.24), 0, 'wood');

    // crown: 9 fronds as cut-out planes
    const fronds = Math.round(9 * (this.settings?.get?.('foliageDensity') ?? 1)) + 4;
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * TAU + rng.range(-0.2, 0.2);
      const droop = rng.range(-0.85, -0.25);
      const len = rng.range(1.9, 2.7);
      const g = new THREE.PlaneGeometry(len, 0.85, 6, 3);
      // bend the blade downward along its length
      const pos = g.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const t = (pos.getX(v) + len / 2) / len;
        pos.setZ(v, -Math.pow(t, 2) * 0.55);
      }
      const placed = at(g, [px + Math.cos(a) * len * 0.42, py + 0.1, pz + Math.sin(a) * len * 0.42],
        [droop, -a, 0]);
      this._bucket('frond').push(placed);
    }
    // coconuts
    for (let i = 0; i < 3; i++) {
      this._bucket('bark').push(at(sphere(0.09, 8, 6), [
        px + rng.range(-0.2, 0.2), py - 0.12, pz + rng.range(-0.2, 0.2),
      ]));
    }
    return this;
  }

  /** Utility pole with crossarms and strung cables. */
  pole(x, z, h = 9) {
    this._bucket('bark').push(at(cylinder(0.15, 0.19, h, 10), [x, h / 2, z]));
    this._bucket('bark').push(at(box(2.4, 0.12, 0.14), [x, h - 0.7, z]));
    this._bucket('bark').push(at(box(1.8, 0.11, 0.13), [x, h - 1.5, z]));
    for (const o of [-1.0, 1.0]) {
      this._bucket('rustyMetal').push(at(cylinder(0.05, 0.05, 0.22, 8), [x + o, h - 0.55, z]));
      this._bucket('rustyMetal').push(at(cylinder(0.05, 0.05, 0.22, 8), [x + o * 0.7, h - 1.35, z]));
    }
    this.colliders.add(new THREE.Vector3(x, h / 2, z), new THREE.Vector3(0.2, h / 2, 0.2), 0, 'wood');
    return { x, z, h };
  }

  /** Catenary cable between two poles. */
  cable(a, b, sag = 1.4, radius = 0.035) {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push([
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * sag,
        a.z + (b.z - a.z) * t,
      ]);
    }
    this._bucket('rustyMetal').push(tube(pts, radius, 4));
    return this;
  }

  /* --------------------------------------------------------------- world - */

  addGround() {
    // Ground planes: one huge terrain sheet (so the horizon never shows an
    // edge), the compound's packed dirt apron, and an asphalt access road.
    const mk = (w, d, matName, repeatX, repeatY, y, ry = 0, z = 0, x = 0) => {
      const g = new THREE.PlaneGeometry(w, d, 1, 1);
      g.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(g, this.tiled(matName, repeatX, repeatY ?? repeatX));
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.receiveShadow = true;
      mesh.name = `ground_${matName}`;
      this.root.add(mesh);
      return mesh;
    };

    mk(1600, 1600, 'sandDune', 1600 / 26, 1600 / 26, 0);             // terrain
    mk(130, 130, 'dirt', 130 / 9, 130 / 9, 0.032);                    // compound apron
    mk(190, 9, 'asphalt', 190 / 6.5, 9 / 6.5, 0.046, Math.PI / 2);    // access road
    mk(40, 26, 'concrete', 40 / 3, 26 / 3, 0.05, Math.PI / 2, 34, 30); // warehouse apron

    // The world floor for collision is y = 0 everywhere.
    this.colliders.ground = 0;
    return this;
  }

  /** Clone a material with a UV repeat applied to every map. */
  tiled(name, repeatX, repeatY = repeatX) {
    const base = this.M[name];
    if (!base) return null;
    const m = base.clone();
    for (const key of ['map', 'normalMap', 'ormMap']) {
      const t = base[key];
      if (!t) continue;
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(repeatX, repeatY);
      c.needsUpdate = true;
      m[key] = c;
    }
    return m;
  }

  /* ------------------------------------------------------------- compound - */

  build() {
    const rng = this.rng;
    this.addGround();

    /* ---- perimeter ------------------------------------------------------ */
    const R = 62;                          // half-extent of the compound
    const seg = 3.6;
    const gapsAt = [
      { z: 60, from: -4.2, to: 4.2 },      // main gate on the south side
      { x: 30, from: 26, to: 34 },         // sally port east
    ];
    for (let i = -R / seg; i < R / seg; i++) {
      const p = i * seg + seg / 2;
      // north / south rows
      for (const z of [-R, R]) {
        const skip = (z === R) && gapsAt.some((g) => g.z === 60 && p > g.from - seg && p < g.to + seg);
        if (!skip) this.tWall(p, z, 0);
      }
      // east / west rows
      for (const x of [-R, R]) {
        const skip = (x === R) && gapsAt.some((g) => g.x === 30 && p > g.from - seg && p < g.to + seg);
        if (!skip) this.tWall(x, p, Math.PI / 2);
      }
    }
    // gate posts + barrier arm
    this.addBox('concrete', 1.1, 4.2, 1.1, -5.4, 2.1, 62, 0, 'concrete', { r: 0.05 });
    this.addBox('concrete', 1.1, 4.2, 1.1, 5.4, 2.1, 62, 0, 'concrete', { r: 0.05 });
    this.addBox('rustyMetal', 10.5, 0.18, 0.18, 0, 1.1, 62, 0, 'metal', { r: 0.02 });  // boom arm
    this.gate = { x: 0, z: 62, w: 10 };

    /* ---- barracks: two floors, exterior stair --------------------------- */
    this.room({
      x: -32, z: -34, w: 22, d: 12, h: 3.1, mat: 'plaster', ry: 0,
      roof: null,
      floor: null,
      doors: [
        { side: 's', s0: -1.1, s1: 1.1, y0: 0, y1: 2.2 },
        { side: 's', s0: 7.5, s1: 9.7, y0: 0, y1: 2.2 },
      ],
      windows: [
        { side: 'n', s0: -8, s1: -5.6, y0: 1.1, y1: 2.3 },
        { side: 'n', s0: -2, s1: 0.4, y0: 1.1, y1: 2.3 },
        { side: 'n', s0: 4, s1: 6.4, y0: 1.1, y1: 2.3 },
        { side: 'w', s0: -3, s1: -0.8, y0: 1.1, y1: 2.3 },
        { side: 'e', s0: -3, s1: -0.8, y0: 1.1, y1: 2.3 },
      ],
      surface: 'concrete',
    });
    // upper storey (its floor slab doubles as the ground floor's ceiling)
    this.room({
      x: -32, z: -34, w: 22, d: 12, h: 3.0, mat: 'plaster', ry: 0, floor: 3.25,
      doors: [{ side: 's', s0: 7.5, s1: 9.7, y0: 3.25, y1: 5.45 }],
      windows: [
        { side: 'n', s0: -8, s1: -5.6, y0: 4.3, y1: 5.5 },
        { side: 'n', s0: -2, s1: 0.4, y0: 4.3, y1: 5.5 },
        { side: 'n', s0: 4, s1: 6.4, y0: 4.3, y1: 5.5 },
        { side: 'w', s0: -3, s1: -0.8, y0: 4.3, y1: 5.5 },
        { side: 'e', s0: -3, s1: -0.8, y0: 4.3, y1: 5.5 },
      ],
      roof: 3.0, surface: 'concrete',
    });
    // interior divider on ground floor
    this.wall('plaster', { x: -32, z: -34, ry: Math.PI / 2, len: 12, h: 3.1, t: 0.2, y0: 0, gaps: [{ s0: 1.4, s1: 3.6, y0: 0, y1: 2.2 }] });
    // exterior stair to the upper door
    this.steps('concrete', { x: -23.6, z: -28.2, ry: 0, width: 1.6, rise: 0.217, run: 0.31, count: 15 });
    // roof access ladder (visual struts)
    this._bucket('rustyMetal').push(strut([-20.9, 6.6, -39.6], [-20.9, 9.6, -39.6], 0.028, 6));
    this._bucket('rustyMetal').push(strut([-20.6, 6.6, -39.6], [-20.6, 9.6, -39.6], 0.028, 6));
    for (let i = 0; i < 12; i++) {
      this._bucket('rustyMetal').push(strut([-20.9, 6.7 + i * 0.25, -39.6], [-20.6, 6.7 + i * 0.25, -39.6], 0.02, 6));
    }

    /* ---- motor pool: open shed on columns ------------------------------ */
    {
      const x = 30, z = -36;
      for (const [cx, cz] of [[-8, -5], [8, -5], [-8, 5], [8, 5], [0, -5], [0, 5]]) {
        this.addBox('rustyMetal', 0.34, 5.4, 0.34, x + cx, 2.7, z + cz, 0, 'metal', { r: 0.02 });
      }
      this.addBox('rustyMetal', 18, 0.22, 11, x, 5.5, z, 0, 'metal', { r: 0.03 });
      // corrugated roof ridge
      for (let i = -8; i <= 8; i++) {
        this.addBox('rustyMetal', 0.24, 0.16, 11, x + i * 1.05, 5.68, z, 0, 'metal', { collide: false, r: 0.02 });
      }
      // workbench + tool wall
      this.addBox('wood', 7, 0.14, 1.0, x - 4, 0.9, z - 4.6, 0, 'wood', { r: 0.02 });
      this.addBox('rustyMetal', 0.14, 0.9, 0.9, x - 7.4, 0.45, z - 4.6, 0, 'metal', { r: 0.02 });
      this.addBox('rustyMetal', 0.14, 0.9, 0.9, x - 0.6, 0.45, z - 4.6, 0, 'metal', { r: 0.02 });
      // stacked spares
      for (let i = 0; i < 4; i++) this.crates(x + 6.5, z + 3.4 - i * 1.0, rng.range(0, TAU), 1);
      this.barrel(x + 2.2, z + 4.2);
      this.barrel(x + 3.0, z + 4.2);
      // the technical
      this.vehicle(x - 1, z + 1.5, Math.PI * 0.5);
    }

    /* ---- warehouse + container yard ------------------------------------ */
    this.room({
      x: 30, z: 34, w: 26, d: 16, h: 4.6, mat: 'concrete', ry: 0,
      doors: [
        { side: 'n', s0: -7.5, s1: -2.5, y0: 0, y1: 3.6 },
        { side: 'w', s0: -3, s1: 3, y0: 0, y1: 3.6 },
      ],
      windows: [
        { side: 'e', s0: -6, s1: -4, y0: 2.6, y1: 3.8 },
        { side: 'e', s0: 0, s1: 2, y0: 2.6, y1: 3.8 },
      ],
      roof: 4.6, surface: 'concrete',
    });
    this.container(36, 28, 0.1, 'containerRed');
    this.container(36, 20, 0.05, 'containerGreen');
    this.container(23, 26, Math.PI / 2 + 0.06, 'containerBlue');
    this.container(44, 4, 0.9, 'containerRed', 1);
    this.container(20.5, 47, 0.02, 'containerGreen');

    /* ---- guard tower --------------------------------------------------- */
    {
      const x = 52, z = 52;
      this.addBox('concrete', 5.2, 0.5, 5.2, x, 0.25, z, 0, 'concrete', { r: 0.03 });
      for (const [cx, cz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
        this.addBox('concrete', 0.5, 6.4, 0.5, x + cx, 3.2, z + cz, 0, 'concrete', { r: 0.03 });
        // cross bracing
        this._bucket('rustyMetal').push(strut([x + cx, 1.0, z + cz], [x + cx * 0.3, 5.6, z + cz * 0.3], 0.05, 6));
      }
      this.addBox('concrete', 5.6, 0.35, 5.6, x, 6.6, z, 0, 'concrete', { r: 0.03 });      // platform
      this.addBox('concrete', 5.8, 0.3, 5.8, x, 10.1, z, 0, 'concrete', { r: 0.03 });      // roof
      for (const [cx, cz] of [[-2.7, 0], [2.7, 0], [0, -2.7], [0, 2.7]]) {
        this.addBox('concrete', cx ? 0.3 : 5.8, 3.2, cz ? 0.3 : 5.8, x + cx, 8.45, z + cz, 0, 'concrete', { r: 0.03 });
      }
      // sandbag parapet + ladder
      this.sandbags(x, z + 2.4, 0, { len: 4.4, rows: 2 });
      this.steps('rustyMetal', { x: x + 2.9, z: z + 2.9, ry: Math.PI / 2, width: 0.9, rise: 0.24, run: 0.3, count: 27 });
      this.addBox('concrete', 0.9, 2.4, 0.3, x + 2.9, 1.2, z + 3.4, Math.PI / 2, 'concrete', { collide: false, r: 0.02 });
      this.spawnPoints.push({ pos: new THREE.Vector3(x, 6.8, z), ry: Math.PI });
    }

    /* ---- market stalls ------------------------------------------------- */
    for (let i = 0; i < 4; i++) {
      const x = -44 + i * 7.5;
      const z = 22;
      for (const [cx, cz] of [[-2.6, -1.8], [2.6, -1.8], [-2.6, 1.8], [2.6, 1.8]]) {
        this.addBox('wood', 0.12, 2.5, 0.12, x + cx, 1.25, z + cz, 0, 'wood', { r: 0.01 });
      }
      // cloth awning
      const aw = new THREE.PlaneGeometry(6.2, 4.2, 6, 4);
      const pos = aw.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const xx = pos.getX(v) / 3.1, zz = pos.getZ(v) / 2.1;
        pos.setY(v, Math.sin(xx * 1.4) * 0.12 - Math.abs(zz) * 0.16);
      }
      aw.rotateX(-Math.PI / 2);
      this._bucket('cloth').push(at(aw, [x, 2.55, z], [0.10, i * 0.3, 0]));
      // counter + goods
      this.addBox('wood', 5.4, 0.9, 1.0, x, 0.45, z - 1.2, 0, 'wood', { r: 0.02 });
      for (let j = 0; j < 3; j++) this.crates(x - 2 + j * 2, z + 1.2, rng.range(0, TAU), 1);
      this.spawnPoints.push({ pos: new THREE.Vector3(x, 0, z - 3), ry: Math.PI });
    }

    /* ---- houses -------------------------------------------------------- */
    const houses = [
      { x: -50, z: -12, w: 9, d: 8, ry: 0.12 },
      { x: -18, z: 24, w: 8, d: 7.5, ry: -0.5 },
      { x: 6, z: -44, w: 10, d: 8, ry: 0.3 },
      { x: 46, z: 14, w: 8.5, d: 7, ry: 1.2 },
      { x: -12, z: 48, w: 9, d: 7, ry: -1.1 },
    ];
    for (const h of houses) {
      this.room({
        x: h.x, z: h.z, w: h.w, d: h.d, h: 3.2, mat: 'plaster', ry: h.ry,
        doors: [{ side: 's', s0: -1.0, s1: 1.0, y0: 0, y1: 2.2 }],
        windows: [
          { side: 'n', s0: -2.4, s1: -0.6, y0: 1.2, y1: 2.4 },
          { side: 'e', s0: -2.4, s1: -0.8, y0: 1.2, y1: 2.4 },
        ],
        roof: 3.2, surface: 'concrete',
      });
      // interior wall + props
      this.wall('brick', {
        x: h.x, z: h.z, ry: h.ry + Math.PI / 2, len: h.d - 0.4, h: 3.2, t: 0.18, y0: 0,
        gaps: [{ s0: -1.4, s1: 0.2, y0: 0, y1: 2.2 }],
      });
      this.addBox('wood', 1.8, 0.75, 0.9, h.x + 1.4, 0.38, h.z + 1.4, h.ry, 'wood', { r: 0.02 });
      this.addBox('tile', 2.0, 0.06, 1.4, h.x - 1.6, 0.03, h.z - 1.8, h.ry, 'concrete', { collide: false, r: 0.01 });
      // A/C unit on the roof
      this.addBox('rustyMetal', 1.0, 0.75, 0.85, h.x + 1.5, 3.9, h.z - 1.2, h.ry, 'metal', { r: 0.03 });
      this._bucket('rustyMetal').push(at(cylinder(0.32, 0.32, 0.12, 10), [h.x + 1.5, 4.0, h.z - 0.75], [Math.PI / 2, 0, 0]));
      this.spawnPoints.push({ pos: new THREE.Vector3(h.x, 0, h.z + 6), ry: 0 });
    }

    /* ---- sandbag positions + barriers ---------------------------------- */
    this.sandbags(0, 44, 0, { len: 7, rows: 3 });
    this.sandbags(-14, -6, Math.PI / 2, { len: 6, rows: 2 });
    this.sandbags(14, 10, 0, { len: 5, rows: 2 });
    this.sandbags(-28, 40, Math.PI / 2, { len: 8, rows: 3 });
    this.sandbags(40, -12, 0.4, { len: 6, rows: 2 });
    for (let i = 0; i < 6; i++) this.jersey(-8 + i * 2.4, 18, 0.02);
    for (let i = 0; i < 4; i++) this.jersey(20, -20 + i * 2.4, Math.PI / 2);
    for (let i = 0; i < 3; i++) this.jersey(-40, 4 + i * 2.4, Math.PI / 2);

    /* ---- containers as cover around the yard --------------------------- */
    this.container(-24, 4, 0.6, 'containerBlue');
    this.container(-24, 8, 0.62, 'containerBlue', 1);
    this.container(12, -14, -0.4, 'containerRed');
    this.container(-44, 30, 1.4, 'containerGreen');

    /* ---- barrels, crates, tyres, rubble -------------------------------- */
    for (let i = 0; i < 14; i++) {
      const a = rng.range(0, TAU), r = rng.range(8, 52);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      this.barrel(x, z, rng.bool(0.35), rng.range(0, TAU));
    }
    for (let i = 0; i < 12; i++) {
      const a = rng.range(0, TAU), r = rng.range(10, 56);
      this.crates(Math.cos(a) * r, Math.sin(a) * r, rng.range(0, TAU), rng.int(1, 2));
    }
    for (let i = 0; i < 16; i++) {
      const a = rng.range(0, TAU), r = rng.range(12, 58);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const rot = [rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU)];
      this._bucket('rubber').push(at(torus(0.36, 0.15, 8, 18), [x, 0.19, z], rot.map((v, i) => i === 1 ? 0 : v)));
      this.colliders.add(new THREE.Vector3(x, 0.19, z), new THREE.Vector3(0.5, 0.2, 0.5), 0, 'rubber');
    }
    // rubble piles
    for (let i = 0; i < 10; i++) {
      const a = rng.range(0, TAU), r = rng.range(6, 58);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const n = rng.int(5, 11);
      for (let j = 0; j < n; j++) {
        const s = rng.range(0.25, 0.75);
        this._bucket('rock').push(at(rbox(s, s * rng.range(0.5, 1.1), s * rng.range(0.7, 1.3), s * 0.3, 0.02),
          [x + rng.range(-1.6, 1.6), rng.range(s * 0.3, s * 0.6), z + rng.range(-1.6, 1.6)],
          [rng.range(-0.4, 0.4), rng.range(0, TAU), rng.range(-0.4, 0.4)]));
      }
      this.colliders.add(new THREE.Vector3(x, 0.3, z), new THREE.Vector3(1.7, 0.35, 1.7), 0, 'concrete');
      // rebar
      for (let j = 0; j < 3; j++) {
        this._bucket('rustyMetal').push(strut(
          [x + rng.range(-1, 1), 0.05, z + rng.range(-1, 1)],
          [x + rng.range(-1, 1), rng.range(0.6, 1.4), z + rng.range(-1, 1)], 0.018, 5,
        ));
      }
    }
    // wooden pallets and planks
    for (let i = 0; i < 10; i++) {
      const a = rng.range(0, TAU), r = rng.range(8, 56);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const ry = rng.range(0, TAU);
      for (let j = 0; j < 5; j++) {
        const off = (j - 2) * 0.22;
        this._bucket('wood').push(at(box(1.2, 0.04, 0.14),
          [x + Math.cos(ry) * 0 - Math.sin(ry) * off, 0.06, z + Math.cos(ry) * off], [0, ry, 0]));
      }
      this.colliders.add(new THREE.Vector3(x, 0.08, z), new THREE.Vector3(0.65, 0.08, 0.55), ry, 'wood');
    }

    /* ---- poles, cables, palms, antenna masts --------------------------- */
    const poles = [
      this.pole(-58, 8, 9.5), this.pole(-30, 8, 9.0), this.pole(0, 8, 9.4), this.pole(30, 8, 9.1),
      this.pole(58, 8, 9.6), this.pole(58, -30, 9.2), this.pole(58, -58, 9.0),
    ];
    for (let i = 0; i < poles.length - 1; i++) {
      this.cable({ x: poles[i].x, y: poles[i].h - 1.0, z: poles[i].z }, { x: poles[i + 1].x, y: poles[i + 1].h - 1.0, z: poles[i + 1].z }, 1.6);
      this.cable({ x: poles[i].x, y: poles[i].h - 1.8, z: poles[i].z }, { x: poles[i + 1].x, y: poles[i + 1].h - 1.8, z: poles[i + 1].z }, 1.9);
    }
    // laundry line between two houses
    this.cable({ x: -12, y: 3.4, z: 48 }, { x: -18, y: 3.6, z: 24 }, 1.1, 0.02);
    for (let i = 0; i < 5; i++) {
      const t = i / 5;
      this._bucket('cloth').push(at(box(0.6, 0.9, 0.03), [-13.2 + t * -4.4, 3.1 - Math.sin(t * Math.PI) * 0.5, 45.2 + t * -18.8], [0, 0, rng.range(-0.1, 0.1)]));
    }

    // palms around the perimeter and the yard
    const palmSpots = [
      [-56, -22], [-46, -46], [-18, -52], [14, -52], [40, -50], [56, -22], [56, 22],
      [-56, 30], [-40, 52], [-6, 56], [24, 56], [46, 40], [-30, -20], [8, 20], [-8, -30],
    ];
    for (const [px, pz] of palmSpots) this.palm(px + rng.range(-1, 1), pz + rng.range(-1, 1), rng.range(6, 9.5));

    // radio masts
    for (const [mx, mz] of [[-52, -52], [52, 20]]) {
      this._bucket('rustyMetal').push(at(cylinder(0.09, 0.14, 14, 8), [mx, 7, mz]));
      for (let i = 0; i < 3; i++) {
        this._bucket('rustyMetal').push(strut([mx - 1.2, 0.2, mz], [mx, 12 - i * 2, mz], 0.03, 5));
        this._bucket('rustyMetal').push(strut([mx + 1.2, 0.2, mz], [mx, 12 - i * 2, mz], 0.03, 5));
      }
      this.colliders.add(new THREE.Vector3(mx, 7, mz), new THREE.Vector3(0.16, 7, 0.16), 0, 'metal');
    }
    // satellite dish
    this._bucket('rustyMetal').push(at(cylinder(0.9, 0.9, 0.12, 16), [44, 3.6, -46], [0.6, 0.4, 0]));
    this._bucket('rustyMetal').push(at(cylinder(0.1, 0.1, 1.4, 8), [44, 2.9, -46]));

    /* ---- enemy spawn ring + patrol/cover data --------------------------- */
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU + rng.range(-0.1, 0.1);
      const r = rng.range(24, 56);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      this.spawnPoints.push({ pos: new THREE.Vector3(x, 0, z), ry: Math.atan2(-x, -z) });
    }
    // cover points near the player spawn so wave attackers have places to hide
    for (let i = 0; i < 26; i++) {
      const a = rng.range(0, TAU), r = rng.range(10, 54);
      this.coverPoints.push({ pos: new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), dir: rng.range(0, TAU) });
    }

    this._flush();
    return this;
  }

  /** Improvised armoured pickup with a pintle-mounted MG. */
  vehicle(x, z, ry) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    // local (lx, lz) → world (x + lx·cos − lz·sin, z + lx·sin + lz·cos)
    const wx = (lx, lz) => x + lx * cos - lz * sin;
    const wz = (lx, lz) => z + lx * sin + lz * cos;

    this.addBox('containerGreen', 2.0, 0.9, 4.6, x, 1.15, z, ry, 'metal', { r: 0.05 });            // body tub
    this.addBox('containerGreen', 1.9, 0.55, 2.2, wx(0, 0.9), 1.72, wz(0, 0.9), ry, 'metal', { collide: false, r: 0.05 }); // bed walls
    this.addBox('containerGreen', 1.75, 0.95, 1.7, wx(0, -1.5), 2.05, wz(0, -1.5), ry, 'metal', { r: 0.06 });              // cab
    this.addBox('glass', 1.55, 0.55, 0.06, wx(0, -2.32), 2.25, wz(0, -2.32), ry, 'glass', { collide: false, r: 0.02, transparent: true });
    this.addBox('glass', 0.06, 0.55, 1.2, wx(-0.86, -1.5), 2.25, wz(-0.86, -1.5), ry, 'glass', { collide: false, r: 0.02, transparent: true });
    this.addBox('glass', 0.06, 0.55, 1.2, wx(0.86, -1.5), 2.25, wz(0.86, -1.5), ry, 'glass', { collide: false, r: 0.02, transparent: true });

    // wheels: tyre + rim
    for (const [lx, lz] of [[-1.05, -1.4], [1.05, -1.4], [-1.05, 1.5], [1.05, 1.5]]) {
      const px = wx(lx, lz), pz = wz(lx, lz);
      this._bucket('rubber').push(at(cylinder(0.46, 0.46, 0.30, 16), [px, 0.46, pz], [0, 0, Math.PI / 2]));
      this._bucket('paintedMetal').push(at(cylinder(0.23, 0.23, 0.32, 12), [px, 0.46, pz], [0, 0, Math.PI / 2]));
      this.colliders.add(new THREE.Vector3(px, 0.46, pz), new THREE.Vector3(0.25, 0.46, 0.46), 0, 'rubber');
    }

    // roll bar + pintle-mounted machine gun
    const rbx = wx(-0.92, 1.3), rbz = wz(-0.92, 1.3);
    this._bucket('rustyMetal').push(strut([rbx, 1.45, rbz], [rbx, 2.55, rbz], 0.055, 6));
    const bx = wx(0, 1.0), bz = wz(0, 1.0);
    this._bucket('rustyMetal').push(at(cylinder(0.045, 0.045, 0.55, 8), [bx, 2.35, bz]));
    this._bucket('weaponAccent').push(at(rbox(0.07, 0.13, 0.85, 0.02), [bx, 2.66, bz + 0.05]));
    this._bucket('weaponAccent').push(at(cylinder(0.022, 0.022, 0.55, 8), [bx, 2.66, bz - 0.62], [Math.PI / 2, 0, 0]));
    this._bucket('rustyMetal').push(at(rbox(0.05, 0.30, 0.12, 0.02), [bx, 2.50, bz + 0.42]));   // ammo box

    this.coverPoints.push({ pos: new THREE.Vector3(x, 0, z), dir: ry });
    return this;
  }

  /* ------------------------------------------------------------- flush --- */

  _flush() {
    for (const [name, geos] of this.buckets) {
      const mat = this.M[name];
      if (!mat || !geos.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeAll(geos);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `static_${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
    }
    this.scene.add(this.root);
    this.colliders._buildGrid();
  }

  /* ---------------------------------------------------------- queries ---- */

  /** Map a world XZ to a navigable point (used by AI and spawns). */
  snapToGround(pos) {
    pos.y = this.colliders.groundAt(pos.x, pos.z);
    return pos;
  }
}

/** Merge a list of geometries into one, tolerating mixed attributes. */
function mergeAll(geos) {
  const norm = geos.map((g) => {
    const geo = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    }
    if (!geo.attributes.uv) {
      const n = geo.attributes.position.count;
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    return geo;
  });
  // Dynamic import would be async; mergeGeometries is imported lazily here.
  return mergeGeometries(norm);
}
