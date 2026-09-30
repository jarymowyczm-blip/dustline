/**
 * ModelKit.js — the geometry toolkit every model is built with.
 *
 * Two things matter for the "detailed model" look:
 *
 *  1. Bevels. Hard 90° corners read as flat CG boxes. Every block here is a
 *     rounded/bevelled solid so edges catch a specular line from the sky,
 *     which is what the eye reads as machined metal.
 *
 *  2. UV density. UVs are expressed in metres, so a texture with repeat(1,1)
 *     tiles exactly once per metre on every part regardless of its size.
 *     No stretched texels between a huge crate and a tiny bolt.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ---------------------------------------------------------- uv helpers --- */

/** Multiply UVs (in metres) by a factor — >1 = finer detail. */
export function scaleUV(geo, s) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  uv.needsUpdate = true;
  return geo;
}

/** Re-map baked 0..1 box UVs to metres per face so texture density is uniform. */
function boxUVtoMeters(geo, w, h, d) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  // BoxGeometry face layout: px, nx, py, ny, pz, nz — 4 verts each (indexed).
  const faceW = [d, d, w, w, w, w];
  const faceH = [h, h, d, d, h, h];
  const vertsPerFace = uv.count / 6;
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < vertsPerFace; v++) {
      const i = f * vertsPerFace + v;
      uv.setXY(i, uv.getX(i) * faceW[f], uv.getY(i) * faceH[f]);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Rounded rectangle path for extrusion. */
function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

/* ------------------------------------------------------------ primitives -- */

/**
 * Bevelled box. The workhorse of every model in the game.
 * @param {number} w width (x) @param {number} h height (y) @param {number} d depth (z)
 * @param {number} r corner radius @param {number} bevel edge chamfer
 */
export function rbox(w, h, d, r = 0.012, bevel = 0.0022) {
  const shape = roundedRectShape(
    Math.max(1e-3, w - bevel * 2),
    Math.max(1e-3, h - bevel * 2),
    Math.max(0.0006, r - bevel),
  );
  const depth = Math.max(1e-3, d - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 2,
    steps: 1,
  });
  geo.center();
  return geo;
}

/** Plain box with metre UVs (cheaper, for large panels). */
export function box(w, h, d, seg = 1) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  boxUVtoMeters(g, w, h, d);
  return g;
}

export function cylinder(rt, rb, h, seg = 16, open = false) {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
}

export function sphere(r, ws = 16, hs = 12) {
  return new THREE.SphereGeometry(r, ws, hs);
}

export function torus(r, tube, rs = 12, ts = 8) {
  return new THREE.TorusGeometry(r, tube, rs, ts);
}

/** Triangular prism / wedge — sloped armour, roof slopes, muzzle ramps. */
export function wedge(w, h, d) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2);
  s.lineTo(w / 2, -h / 2);
  s.lineTo(-w / 2, h / 2);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, steps: 1 });
  geo.center();
  return geo;
}

/** Tube along a path — cables, wires, gas lines. */
export function tube(points, radius, radial = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, Math.max(8, points.length * 4), radius, radial, false);
}

/** Cylinder between two points — struts, limbs, rebar. */
export function strut(a, b, radius, seg = 8) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const dir = new THREE.Vector3().subVectors(vb, va);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, seg, 1, false);
  const mid = new THREE.Vector3().addVectors(va, vb).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m);
  return geo;
}

/** Staircase of solid steps. */
export function stairs(w, rise, run, steps, depth) {
  const geos = [];
  for (let i = 0; i < steps; i++) {
    const g = box(w, rise * (i + 1), run);
    g.translate(0, (rise * (i + 1)) / 2, -i * run - run / 2);
    geos.push(g);
  }
  const merged = mergeGeometries(geos.map((g) => g.toNonIndexed()), false);
  const out = merged || geos[0];
  return out;
}

/* ------------------------------------------------------------ transforms -- */

/** Return a transformed clone of a geometry. */
export function at(geo, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const g = geo.clone();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
    new THREE.Vector3(...scale),
  );
  g.applyMatrix4(m);
  return g;
}

/** Mirror a geometry across X (for left/right limbs). */
export function mirrored(geo) {
  const g = geo.clone();
  const m = new THREE.Matrix4().makeScale(-1, 1, 1);
  g.applyMatrix4(m);
  // flip winding so normals stay outward
  const idx = g.index;
  if (idx) { for (let i = 0; i < idx.count; i += 3) { const t = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, t); } idx.needsUpdate = true; }
  else {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      const ax = pos.getX(i + 1), ay = pos.getY(i + 1), az = pos.getZ(i + 1);
      pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
      pos.setXYZ(i + 2, ax, ay, az);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/* --------------------------------------------------------------- builder -- */

/**
 * Accumulates geometry per material and merges on build(), so a model with
 * 120 primitives still draws in a handful of calls.
 */
export class PartBuilder {
  constructor() { this.buckets = new Map(); }

  /**
   * @param {string} materialName bucket key
   * @param {THREE.BufferGeometry|THREE.BufferGeometry[]} geo
   */
  add(materialName, geo) {
    if (!this.buckets.has(materialName)) this.buckets.set(materialName, []);
    const list = this.buckets.get(materialName);
    const geos = Array.isArray(geo) ? geo : [geo];
    for (const g of geos) if (g) list.push(normalizeGeo(g));
    return this;
  }

  /**
   * @param {Object<string, THREE.Material>} materials
   * @returns {THREE.Group} merged meshes, named after their material
   */
  build(materials) {
    const group = new THREE.Group();
    for (const [name, geos] of this.buckets) {
      if (!geos.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mat = materials[name] || materials.default;
      if (!mat) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

/** Strip non-core attributes and force non-indexed so merges never fail. */
export function normalizeGeo(g) {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const key of Object.keys(geo.attributes)) {
    if (!['position', 'normal', 'uv'].includes(key)) geo.deleteAttribute(key);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  // never let bounds check hide merged geometry
  geo.boundingSphere = null;
  return geo;
}

/** Convenience: build a mesh group from a part list in one call. */
export function buildModel(materials, fn) {
  const b = new PartBuilder();
  fn(b, { rbox, box, cylinder, sphere, torus, wedge, tube, strut, at, mirrored, stairs, scaleUV });
  return b.build(materials);
}

/** Compute a tight box collider for a group (used for hard cover). */
export function colliderFromGroup(group, margin = 0) {
  const b = new THREE.Box3().setFromObject(group);
  const size = b.getSize(new THREE.Vector3());
  const center = b.getCenter(new THREE.Vector3());
  return { center, half: size.multiplyScalar(0.5).addScalar(margin) };
}
