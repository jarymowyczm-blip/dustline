/** Utils.js — tiny math/helper layer shared by every module. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

/** Frame-rate independent exponential smoothing (higher lambda = snappier). */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Critically-damped spring, handy for weapon/viewport motion. */
export class Spring {
  constructor(value = 0, stiffness = 120, damping = 16) {
    this.value = value; this.target = value;
    this.velocity = 0; this.k = stiffness; this.d = damping;
  }
  kick(force) { this.velocity += force; return this; }
  set(v) { this.target = v; this.value = v; this.velocity = 0; return this; }
  update(dt) {
    const step = Math.min(dt, 1 / 60);
    const sub = 2;
    for (let i = 0; i < sub; i++) {
      const h = step / sub;
      const a = -this.k * (this.value - this.target) - this.d * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const chance = (p) => Math.random() < p;
export const sign = (v) => (v < 0 ? -1 : 1);

/** Seeded PRNG (mulberry32) so procedural content is reproducible per seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const r = mulberry32(seed);
  return {
    next: r,
    range: (a, b) => a + r() * (b - a),
    int: (a, b) => Math.floor(a + r() * (b - a + 1)),
    pick: (arr) => arr[(r() * arr.length) | 0],
    bool: (p = 0.5) => r() < p,
    gauss: (mean = 0, sd = 1) => {
      // Box-Muller, clamped to keep outliers sane.
      const u = Math.max(1e-6, r()), v = r();
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
      return mean + g * sd;
    },
  };
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function angleDelta(from, to) { return wrapAngle(to - from); }

/** Move `from` toward `to` by at most `maxStep` radians. */
export function turnToward(from, to, maxStep) {
  const d = angleDelta(from, to);
  return from + clamp(d, -maxStep, maxStep);
}

export const fmt = {
  time(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },
  pct(v) { return `${Math.round(v * 100)}%`; },
  num(v) { return Math.round(v).toLocaleString('en-US'); },
};

/** Weighted random table: weights = [[value, weight], ...] */
export function weighted(weights, r = Math.random) {
  let total = 0;
  for (const w of weights) total += w[1];
  let x = r() * total;
  for (const w of weights) { x -= w[1]; if (x <= 0) return w[0]; }
  return weights[weights.length - 1][0];
}

/** Simple object pool to keep gameplay allocation-free in hot paths. */
export class Pool {
  constructor(factory, reset, size = 32) {
    this.factory = factory; this.reset = reset;
    this.free = []; this.live = [];
    for (let i = 0; i < size; i++) this.free.push(factory());
  }
  obtain() {
    const o = this.free.pop() || this.factory();
    this.live.push(o);
    return o;
  }
  release(o) {
    const i = this.live.indexOf(o);
    if (i >= 0) this.live.splice(i, 1);
    if (this.reset) this.reset(o);
    this.free.push(o);
  }
}
