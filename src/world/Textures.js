/**
 * Textures.js — procedural PBR material library.
 *
 * Nothing is downloaded. Every material is synthesised pixel by pixel into
 * typed arrays and uploaded as DataTextures:
 *
 *   • albedo  — RGB specular/base colour, sRGB
 *   • normal  — derived from the generated height field with a Sobel filter
 *   • ORM     — R: ambient occlusion, G: roughness, B: metalness (glTF packing;
 *               three.js reads roughness from .g and metalness from .b)
 *
 * The noise is tileable (lattice wraps modulo the octave frequency) so large
 * floors and walls can repeat without seams.
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/Utils.js';

/* ============================================================== noise ==== */

class Noise {
  constructor(seed = 1337) {
    this.seed = seed | 0;
    const rnd = mulberry32(this.seed);
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    this.perm = perm;
  }

  /** hash of integer lattice point -> [0,1) */
  _h(ix, iy) {
    const p = this.perm;
    return p[(p[ix & 255] + iy) & 255] / 255;
  }

  /** Tileable bilinear value noise. `f` = integer lattice frequency. */
  value(x, y, f) {
    const fx = x * f, fy = y * f;
    let ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const wx0 = ((ix % f) + f) % f, wy0 = ((iy % f) + f) % f;
    const wx1 = (wx0 + 1) % f, wy1 = (wy0 + 1) % f;
    const a = this._h(wx0, wy0), b = this._h(wx1, wy0);
    const c = this._h(wx0, wy1), d = this._h(wx1, wy1);
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  }

  /** Tileable fractional Brownian motion. */
  fbm(x, y, baseFreq = 4, octaves = 5, gain = 0.5, lacunarity = 2) {
    let sum = 0, amp = 1, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.value(x, y, Math.max(1, Math.round(f)));
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Tileable ridged multifractal — cracks, veins, dune crests. */
  ridge(x, y, baseFreq = 4, octaves = 4, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      const n = this.value(x, y, Math.max(1, Math.round(f)));
      sum += amp * (1 - Math.abs(n * 2 - 1));
      norm += amp;
      amp *= gain; f *= 2;
    }
    return sum / norm;
  }

  /**
   * Tileable Worley/cellular noise.
   * Returns { f1, f2, id } where id is a per-cell random value (0..1).
   */
  worley(x, y, cells, jitter = 1) {
    const fx = x * cells, fy = y * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let f1 = 1e9, f2 = 1e9, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ix + ox, cy = iy + oy;
        const wx = ((cx % cells) + cells) % cells;
        const wy = ((cy % cells) + cells) % cells;
        const h = this._h(wx, wy);
        const h2 = this._h(wx + 71, wy + 13);
        const px = cx + 0.5 + (h - 0.5) * jitter * 0.9;
        const py = cy + 0.5 + (h2 - 0.5) * jitter * 0.9;
        const dx = px - fx, dy = py - fy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; id = h; }
        else if (d < f2) { f2 = d; }
      }
    }
    return { f1, f2, id };
  }
}

/* ============================================================ factory ==== */

const N_CACHE = new Map();
function noiseFor(seed) {
  if (!N_CACHE.has(seed)) N_CACHE.set(seed, new Noise(seed));
  return N_CACHE.get(seed);
}

export class TextureFactory {
  /**
   * @param {THREE.WebGLRenderer} renderer used for max anisotropy
   */
  constructor(renderer) {
    this.maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
    this.recipes = new Map();
    this._cache = new Map();
  }

  /* ------------------------------------------------------ texture makers - */

  _dataTex(data, size, { srgb = false, repeat = [1, 1], mips = true } = {}) {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = Math.min(this.maxAniso, 8);
    t.magFilter = THREE.LinearFilter;
    if (mips) {
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
    } else {
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
    }
    t.needsUpdate = true;
    return t;
  }

  /**
   * Run a per-pixel recipe.
   * `fn(u, v, ctx)` must fill `ctx.out` = [r,g,b, height, rough, metal].
   */
  _bake(size, fn, opts = {}) {
    const albedo = new Uint8Array(size * size * 4);
    const orm = new Uint8Array(size * size * 4);
    const height = new Float32Array(size * size);
    const out = [0, 0, 0, 0.5, 0.8, 0];
    const ctx = { out, size };

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size;
        ctx.u = u; ctx.v = v; ctx.x = x; ctx.y = y;
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0.5; out[4] = 0.8; out[5] = 0;
        fn(u, v, ctx);
        const i = (y * size + x) * 4;
        albedo[i] = clamp(out[0], 0, 255) | 0;
        albedo[i + 1] = clamp(out[1], 0, 255) | 0;
        albedo[i + 2] = clamp(out[2], 0, 255) | 0;
        // out[7] carries an optional alpha mask (cut-out foliage).
        albedo[i + 3] = out[7] !== undefined ? clamp(out[7] * 255, 0, 255) | 0 : 255;
        orm[i] = clamp(out[6] !== undefined ? out[6] * 255 : 255, 0, 255) | 0;
        orm[i + 1] = clamp(out[4] * 255, 0, 255) | 0;
        orm[i + 2] = clamp(out[5] * 255, 0, 255) | 0;
        orm[i + 3] = 255;
        height[y * size + x] = out[3];
      }
    }

    const normal = this._normalFromHeight(height, size, opts.normalStrength ?? 2.4);
    const repeat = opts.repeat || [1, 1];
    return {
      map: this._dataTex(albedo, size, { srgb: true, repeat }),
      normalMap: this._dataTex(normal, size, { repeat }),
      ormMap: this._dataTex(orm, size, { repeat }),
      size,
    };
  }

  /** Sobel height→normal, tileable, with wrap-around sampling. */
  _normalFromHeight(h, size, strength) {
    const out = new Uint8Array(size * size * 4);
    const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        const l = at(x - 1, y), r = at(x + 1, y);
        const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
        let dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        let dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        dx *= strength; dy *= strength;
        const len = Math.sqrt(dx * dx + dy * dy + 1);
        const i = (y * size + x) * 4;
        out[i] = ((-dx / len) * 0.5 + 0.5) * 255;
        out[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
        out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ material - */

  material(set, opts = {}) {
    const m = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.ormMap,
      metalnessMap: set.ormMap,
      roughness: opts.roughness ?? 1,
      metalness: opts.metalness ?? 1,
      normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
      color: opts.color !== undefined ? new THREE.Color(opts.color) : 0xffffff,
      envMapIntensity: opts.envMapIntensity ?? 1,
      side: opts.side ?? THREE.FrontSide,
      transparent: opts.transparent ?? false,
      alphaTest: opts.alphaTest ?? 0,
      vertexColors: opts.vertexColors ?? false,
      depthWrite: opts.depthWrite !== false,
      polygonOffset: !!opts.polygonOffset,
      polygonOffsetFactor: opts.polygonOffsetFactor ?? 0,
      polygonOffsetUnits: opts.polygonOffsetUnits ?? 0,
    });
    m.name = opts.name || 'procedural';
    return m;
  }

  /* ============================================================ recipes == */

  /** Coarse concrete: aggregate speckle, hairline cracks, stains, patches. */
  concrete(size = 1024, seed = 11) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 5);
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const grain = n.fbm(u, v, 96, 4, 0.55);            // fine aggregate
      const blotch = n.fbm(u, v, 4, 5, 0.5);             // large discolouration
      const patch = smoothstep(0.45, 0.72, n2.fbm(u, v, 3, 4, 0.55));
      const w = n2.worley(u, v, 26, 1);
      const cell = clamp01(1 - (w.f2 - w.f1) * 2.6);      // pebbles
      const crack = Math.pow(smoothstep(0.0, 0.22, w.f2 - w.f1), 2.2);

      let l = 150 + grain * 62 - blotch * 38 + patch * 26;
      l *= 1 - cell * 0.16;
      l -= crack * 46;
      const warm = 1 + (blotch - 0.5) * 0.10;

      o[0] = l * 1.015 * warm;
      o[1] = l * 0.995;
      o[2] = l * 0.945;
      o[3] = 0.52 + grain * 0.16 - crack * 0.42 - cell * 0.10 - blotch * 0.05;
      o[4] = 0.80 + grain * 0.14 + patch * 0.08 - crack * 0.05;
      o[5] = 0.0;
      o[6] = 1 - cell * 0.10 - crack * 0.55;
    }, { repeat: [1, 1], normalStrength: 3.1 });
  }

  /** Weathered plaster / stucco — smoother, warmer, chips revealing render. */
  plaster(size = 1024, seed = 21) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 3);
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const fine = n.fbm(u, v, 128, 3, 0.55);
      const soft = n.fbm(u, v, 6, 4, 0.55);
      const stain = smoothstep(0.35, 0.75, n2.fbm(u, v, 3, 5, 0.5));
      const w = n2.worley(u, v, 7, 1);
      const chip = smoothstep(0.055, 0.02, w.f1);
      const hair = Math.pow(smoothstep(0.0, 0.09, w.f2 - w.f1), 3.0);

      let l = 182 + fine * 20 - soft * 26 - stain * 22;
      l -= hair * 30;
      o[0] = l * 1.020;
      o[1] = l * 0.980;
      o[2] = l * 0.912;
      if (chip > 0.01) {                     // exposed render beneath the skim
        o[0] = lerp(o[0], 140, chip); o[1] = lerp(o[1], 130, chip); o[2] = lerp(o[2], 116, chip);
      }
      o[3] = 0.66 + fine * 0.14 - hair * 0.30 - chip * 0.28 + soft * 0.06;
      o[4] = 0.86 + fine * 0.08 + stain * 0.06 - chip * 0.10;
      o[5] = 0.0;
      o[6] = 1 - hair * 0.4 - chip * 0.35;
    }, { normalStrength: 2.1 });
  }

  /** Asphalt: dark aggregate, tar seams, worn wheel polish. */
  asphalt(size = 1024, seed = 31) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 9);
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const agg = n.fbm(u, v, 220, 3, 0.6);
      const w = n.worley(u, v, 60, 1);
      const stone = smoothstep(0.30, 0.06, w.f1);
      const seam = Math.pow(smoothstep(0.0, 0.05, n2.worley(u, v, 7, 0.7).f2 - n2.worley(u, v, 7, 0.7).f1), 2.0);
      const wear = n2.fbm(u, v, 2, 3, 0.5);
      const polish = smoothstep(0.55, 0.85, wear);

      let l = 44 + agg * 34 + stone * 26 - polish * 10;
      l *= 1 - seam * 0.35;
      o[0] = l * 1.02; o[1] = l; o[2] = l * 0.96;
      o[3] = 0.5 + agg * 0.25 + stone * 0.25 - seam * 0.4;
      o[4] = 0.87 + agg * 0.08 - polish * 0.22 - seam * 0.05;
      o[5] = 0.0;
      o[6] = 1 - seam * 0.6;
    }, { normalStrength: 2.6 });
  }

  /** Desert sand with wind ripples and dry crust patches. */
  sand(size = 1024, seed = 41, opts = {}) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 7);
    const rippleFreq = opts.rippleFreq ?? 34;
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const grain = n.fbm(u, v, 256, 3, 0.6);
      const big = n.fbm(u, v, 5, 5, 0.5);
      // Ripples are warped by low-frequency noise so they never look stamped.
      const warp = (n2.fbm(u, v, 4, 3, 0.5) - 0.5) * 0.055;
      const ripple = Math.sin((u * 0.72 + v) * rippleFreq + warp * 44) * 0.5 + 0.5;
      const rippleSoft = Math.pow(ripple, 1.6);
      const crust = smoothstep(0.42, 0.62, n2.fbm(u, v, 8, 4, 0.55));
      const pebble = smoothstep(0.16, 0.03, n2.worley(u, v, 90, 1).f1);

      let l = 172 + grain * 20 + big * 22 - crust * 14 + rippleSoft * 20;
      l -= pebble * 30;
      o[0] = l * 1.030; o[1] = l * 0.945 + rippleSoft * 3; o[2] = l * 0.790;
      o[3] = 0.5 + rippleSoft * 0.30 + grain * 0.10 - pebble * 0.16 + big * 0.05;
      o[4] = 0.97 + grain * 0.03 - crust * 0.04;
      o[5] = 0.0;
      o[6] = 0.92 + rippleSoft * 0.08;
    }, { normalStrength: opts.normalStrength ?? 2.2 });
  }

  /** Mixed dirt/gravel for tracks and courtyards. */
  dirt(size = 1024, seed = 51) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 4);
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const fine = n.fbm(u, v, 180, 4, 0.55);
      const broad = n.fbm(u, v, 5, 5, 0.5);
      const w = n2.worley(u, v, 40, 1);
      const gravel = smoothstep(0.20, 0.05, w.f1);
      const tyre = smoothstep(0.62, 0.78, n2.fbm(u * 3 % 1, v, 2, 3, 0.5));

      let l = 104 + fine * 34 + broad * 30 - tyre * 26;
      o[0] = l * 1.055; o[1] = l * 0.960; o[2] = l * 0.815;
      o[0] = lerp(o[0], 132, gravel); o[1] = lerp(o[1], 124, gravel); o[2] = lerp(o[2], 112, gravel);
      o[3] = 0.5 + fine * 0.2 + gravel * 0.3 + broad * 0.1;
      o[4] = 0.94 + fine * 0.05;
      o[5] = 0.0;
      o[6] = 0.94;
    }, { normalStrength: 2.8 });
  }

  /** Fired clay brick in running bond with mortar and per-brick variation. */
  brick(size = 1024, seed = 61, opts = {}) {
    const n = noiseFor(seed);
    const rows = opts.rows ?? 16;
    const cols = opts.cols ?? 8;
    const rnd = mulberry32(seed + 99);
    // Per-brick random values, generated once into a lookup table.
    const brickTint = new Float32Array(rows * cols);
    const brickLum = new Float32Array(rows * cols);
    for (let i = 0; i < rows * cols; i++) {
      brickTint[i] = rnd(); brickLum[i] = 0.85 + rnd() * 0.32;
    }
    const mortar = opts.mortar ?? 0.055;
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const row = Math.floor(v * rows);
      const stagger = (row & 1) ? 0.5 : 0;
      const cu = (u * cols + stagger) % 1;
      const cv = (v * rows) % 1;
      const bx = Math.floor(u * cols + stagger + 1000) % cols;
      const by = row % rows;
      const idx = (by * cols + bx) % (rows * cols);

      const edgeU = Math.min(cu, 1 - cu), edgeV = Math.min(cv, 1 - cv);
      const mort = smoothstep(mortar + 0.012, mortar - 0.012, Math.min(edgeU, edgeV));
      const rough = n.fbm(u, v, 90, 3, 0.5);
      const pit = n.worley(u, v, 55, 1);
      const pits = smoothstep(0.10, 0.02, pit.f1) * 0.6;
      const grime = smoothstep(0.5, 0.85, n.fbm(u, v, 6, 4, 0.5));

      const t = brickTint[idx];
      let r = lerp(146, 108, t) + rough * 26 - pits * 30;
      let g = lerp(76, 52, t) + rough * 16 - pits * 22;
      let b = lerp(58, 42, t) + rough * 14 - pits * 20;
      const lum = brickLum[idx];
      r *= lum; g *= lum; b *= lum;

      // mortar bed
      r = lerp(r, 176, mort); g = lerp(g, 170, mort); b = lerp(b, 156, mort);
      r -= grime * 18; g -= grime * 18; b -= grime * 16;

      o[0] = r; o[1] = g; o[2] = b;
      o[3] = lerp(0.62 + rough * 0.16 - pits * 0.25, 0.38 + rough * 0.1, mort);
      o[4] = lerp(0.86 + rough * 0.10, 0.92, mort);
      o[5] = 0;
      o[6] = lerp(1 - pits * 0.5, 0.8, mort);
    }, { normalStrength: 3.4, repeat: opts.repeat || [1, 1] });
  }

  /** Weathered timber planks, optional crate framing colour. */
  wood(size = 1024, seed = 71, opts = {}) {
    const n = noiseFor(seed);
    const planks = opts.planks ?? 6;
    const tint = opts.tint || [122, 88, 54];
    const rnd = mulberry32(seed + 31);
    const plankTone = new Float32Array(planks);
    for (let i = 0; i < planks; i++) plankTone[i] = 0.82 + rnd() * 0.36;
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const pi = Math.floor(v * planks) % planks;
      const pv = (v * planks) % 1;
      // grain runs along the plank (u), stretched noise
      const grain = n.fbm(u * 0.35, v * 5.5 + pi * 7.3, 40, 4, 0.55);
      const ring = Math.pow(Math.abs(Math.sin((pv * 12 + grain * 5))), 0.5);
      const knot = smoothstep(0.055, 0.012, n.worley(u * 0.6, v * 4 + pi, 14, 1).f1);
      const splinter = n.fbm(u, v, 200, 2, 0.6);
      const gap = smoothstep(0.030, 0.0, Math.min(pv, 1 - pv));

      const tone = plankTone[pi];
      let r = tint[0] * (0.86 + grain * 0.34) * tone - ring * 14 - knot * 44;
      let g = tint[1] * (0.86 + grain * 0.34) * tone - ring * 12 - knot * 38;
      let b = tint[2] * (0.86 + grain * 0.34) * tone - ring * 10 - knot * 34;
      r -= splinter * 8; g -= splinter * 8; b -= splinter * 8;
      r = lerp(r, 26, gap); g = lerp(g, 20, gap); b = lerp(b, 15, gap);

      o[0] = r; o[1] = g; o[2] = b;
      o[3] = 0.55 + grain * 0.18 - knot * 0.35 - gap * 0.5 + ring * 0.05;
      o[4] = 0.62 + grain * 0.16 + ring * 0.05 - knot * 0.05;
      o[5] = 0.0;
      o[6] = 1 - gap * 0.7 - knot * 0.3;
    }, { normalStrength: 2.6, repeat: opts.repeat || [1, 1] });
  }

  /** Painted steel with chipped paint, scratches and dust. */
  paintedMetal(size = 512, seed = 81, opts = {}) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 2);
    const base = opts.color || [86, 96, 84];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const fine = n.fbm(u, v, 120, 3, 0.55);
      const scratches = Math.pow(n2.fbm(u * 4 % 1, v * 0.35, 120, 2, 0.6), 3.0) * 3.4;
      const w = n2.worley(u, v, 16, 1);
      const chip = smoothstep(0.13, 0.06, w.f1);
      const dust = smoothstep(0.45, 0.8, n.fbm(u, v, 3, 4, 0.5));
      const rust = smoothstep(0.55, 0.9, n2.fbm(u, v, 9, 4, 0.55));

      let r = base[0] * (0.86 + fine * 0.26);
      let g = base[1] * (0.86 + fine * 0.26);
      let b = base[2] * (0.86 + fine * 0.26);
      r += scratches * 40; g += scratches * 40; b += scratches * 40;
      // exposed bare steel
      r = lerp(r, 118, chip); g = lerp(g, 118, chip); b = lerp(b, 122, chip);
      // rust bloom
      r = lerp(r, 126, rust * 0.55); g = lerp(g, 74, rust * 0.55); b = lerp(b, 42, rust * 0.55);
      // settled dust brightens and desaturates
      r = lerp(r, 168, dust * 0.20); g = lerp(g, 152, dust * 0.20); b = lerp(b, 126, dust * 0.20);

      o[0] = r; o[1] = g; o[2] = b;
      o[3] = 0.5 + fine * 0.1 + chip * 0.18 - scratches * 0.35 + rust * 0.2;
      o[4] = 0.44 + fine * 0.16 + dust * 0.30 + rust * 0.35 - scratches * 0.22;
      o[5] = clamp01(0.25 + chip * 0.7 + scratches * 0.35 - dust * 0.2 - rust * 0.15);
      o[6] = 1;
    }, { normalStrength: 1.5, repeat: opts.repeat || [1, 1] });
  }

  /** Heavily rusted steel — barrels, wrecks, roof panels. */
  rustyMetal(size = 512, seed = 91, opts = {}) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 6);
    const base = opts.color || [104, 108, 112];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const fine = n.fbm(u, v, 140, 4, 0.55);
      const rustMask = smoothstep(0.32, 0.78, n.fbm(u, v, 6, 5, 0.55));
      const w = n2.worley(u, v, 30, 1);
      const pit = smoothstep(0.12, 0.03, w.f1);
      const streak = Math.pow(smoothstep(0.40, 0.9, n2.fbm(u * 0.5, v * 0.08, 20, 3, 0.5)), 1.6);

      let r = base[0] * (0.8 + fine * 0.3);
      let g = base[1] * (0.8 + fine * 0.3);
      let b = base[2] * (0.8 + fine * 0.3);
      const rm = clamp01(rustMask + streak * 0.4);
      r = lerp(r, 138, rm); g = lerp(g, 72, rm); b = lerp(b, 36, rm);
      r = lerp(r, 96, pit); g = lerp(g, 62, pit); b = lerp(b, 40, pit);

      o[0] = r; o[1] = g; o[2] = b;
      o[3] = 0.5 + fine * 0.12 + rm * 0.22 - pit * 0.32;
      o[4] = 0.42 + fine * 0.10 + rm * 0.45 - pit * 0.05;
      o[5] = clamp01(0.85 - rm * 0.75 - pit * 0.1);
      o[6] = 1 - rm * 0.4;
    }, { normalStrength: 2.2, repeat: opts.repeat || [1, 1] });
  }

  /** Corrugated shipping-container steel (vertical ribs + paint bands). */
  container(size = 512, seed = 101, opts = {}) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 12);
    const paint = opts.color || [58, 84, 108];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const ribs = Math.sin(u * Math.PI * 2 * 14) * 0.5 + 0.5;
      const ribShade = Math.pow(ribs, 0.7);
      const fine = n.fbm(u, v, 150, 3, 0.5);
      const worn = smoothstep(0.5, 0.9, n.fbm(u, v, 5, 4, 0.5));
      const rust = smoothstep(0.48, 0.86, n2.fbm(u, v, 7, 5, 0.55));
      const drip = Math.pow(smoothstep(0.6, 0.95, n2.fbm(u * 3 % 1, v * 0.2, 30, 3, 0.5)), 2.0);

      let r = paint[0] * (0.72 + ribShade * 0.5) * (0.88 + fine * 0.24);
      let g = paint[1] * (0.72 + ribShade * 0.5) * (0.88 + fine * 0.24);
      let b = paint[2] * (0.72 + ribShade * 0.5) * (0.88 + fine * 0.24);
      const rm = clamp01(rust * 0.9 + drip * 0.5);
      r = lerp(r, 120, rm); g = lerp(g, 66, rm); b = lerp(b, 34, rm);
      r = lerp(r, 200, worn * 0.12); g = lerp(g, 196, worn * 0.12); b = lerp(b, 186, worn * 0.12);

      o[0] = r; o[1] = g; o[2] = b;
      o[3] = 0.5 + ribShade * 0.5 + fine * 0.06 - rm * 0.1;
      o[4] = 0.40 + ribShade * 0.10 + fine * 0.12 + rm * 0.42;
      o[5] = clamp01(0.80 - rm * 0.5);
      o[6] = 1 - rm * 0.35;
    }, { normalStrength: 3.0, repeat: opts.repeat || [1, 1] });
  }

  /** Hessian sandbag with woven threads and seam. */
  sandbag(size = 512, seed = 111, opts = {}) {
    const n = noiseFor(seed);
    const base = opts.color || [146, 130, 92];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const weaveU = Math.sin(u * Math.PI * 2 * 46) * 0.5 + 0.5;
      const weaveV = Math.sin(v * Math.PI * 2 * 46) * 0.5 + 0.5;
      const weave = Math.max(weaveU, weaveV) * 0.5 + (weaveU * weaveV) * 0.5;
      const fibre = n.fbm(u * 3 % 1, v * 3 % 1, 160, 3, 0.55);
      const stain = smoothstep(0.35, 0.8, n.fbm(u, v, 5, 4, 0.5));
      const dirt = smoothstep(0.2, 0.9, v);

      let r = base[0] * (0.80 + weave * 0.24 + fibre * 0.16);
      let g = base[1] * (0.80 + weave * 0.24 + fibre * 0.16);
      let b = base[2] * (0.80 + weave * 0.24 + fibre * 0.16);
      r = lerp(r, r * 0.7, stain); g = lerp(g, g * 0.72, stain); b = lerp(b, b * 0.7, stain);
      r = lerp(r, 120, dirt * 0.3); g = lerp(g, 106, dirt * 0.3); b = lerp(b, 78, dirt * 0.3);

      o[0] = r; o[1] = g; o[2] = b;
      o[3] = 0.5 + weave * 0.34 + fibre * 0.10;
      o[4] = 0.95 + fibre * 0.04;
      o[5] = 0;
      o[6] = 0.9;
    }, { normalStrength: 2.4, repeat: opts.repeat || [1, 1] });
  }

  /** Ceramic floor tile for interiors (semi-gloss, grouted, scuffed). */
  tile(size = 512, seed = 121, opts = {}) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 8);
    const cells = opts.cells ?? 4;
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const cu = (u * cells) % 1, cv = (v * cells) % 1;
      const ei = Math.min(cu, 1 - cu, cv, 1 - cv);
      const grout = smoothstep(0.045, 0.012, ei);
      const idx = (Math.floor(v * cells) * cells + Math.floor(u * cells)) % 97;
      const tone = 0.93 + ((idx * 37) % 13) / 100;
      const scuff = Math.pow(smoothstep(0.45, 0.95, n2.fbm(u, v, 40, 3, 0.5)), 2.0);
      const speck = n.fbm(u, v, 200, 3, 0.55);

      let l = (196 + speck * 16) * tone - scuff * 22;
      let r = l * 1.01, g = l * 0.99, b = l * 0.955;
      const dirt = smoothstep(0.3, 0.9, n.fbm(u, v, 4, 4, 0.5));
      r = lerp(r, 120, dirt * 0.30); g = lerp(g, 112, dirt * 0.30); b = lerp(b, 94, dirt * 0.30);
      // grout lines: darker, matte, recessed
      r = lerp(r, 104, grout); g = lerp(g, 100, grout); b = lerp(b, 92, grout);

      o[0] = r; o[1] = g; o[2] = b;
      o[3] = lerp(0.62 - scuff * 0.06, 0.24, grout);
      o[4] = lerp(0.42 + scuff * 0.28 + speck * 0.06, 0.88, grout);
      o[5] = 0;
      o[6] = lerp(1 - scuff * 0.2, 0.85, grout);
    }, { normalStrength: 1.6, repeat: opts.repeat || [1, 1] });
  }

  /** Parkerised gun steel — the base of every weapon. */
  gunSteel(size = 512, seed = 131) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 3);
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const grain = n.fbm(u, v, 220, 3, 0.55);
      const blotch = n.fbm(u, v, 8, 4, 0.5);
      const wear = Math.pow(smoothstep(0.55, 0.95, n2.fbm(u * 2 % 1, v * 0.5, 60, 2, 0.6)), 2.0);
      const edge = n2.worley(u, v, 12, 1);
      const scratch = smoothstep(0.06, 0.02, edge.f1) * 0.5;

      let l = 46 + grain * 22 + blotch * 16 + wear * 26 + scratch * 30;
      o[0] = l * 1.00; o[1] = l * 1.01; o[2] = l * 1.06;
      o[3] = 0.5 + grain * 0.12 + wear * 0.20;
      o[4] = 0.40 + grain * 0.14 + wear * 0.26 - scratch * 0.15;
      o[5] = 0.88 - wear * 0.10;
      o[6] = 1;
    }, { normalStrength: 1.1, repeat: [1, 1] });
  }

  /** Stippled polymer for grips, stocks, magazine bodies. */
  polymer(size = 512, seed = 141, opts = {}) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 5);
    const base = opts.color || [42, 44, 46];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const stipple = n2.worley(u, v, 26, 1);
      const dome = clamp01(1 - stipple.f1 * 2.3);
      const fine = n.fbm(u, v, 180, 3, 0.55);
      const wear = smoothstep(0.6, 0.95, n.fbm(u, v, 6, 3, 0.5));

      const s = 0.78 + dome * 0.28 + fine * 0.16 + wear * 0.12;
      o[0] = base[0] * s; o[1] = base[1] * s; o[2] = base[2] * s;
      o[3] = 0.5 + dome * 0.34 + fine * 0.08;
      o[4] = 0.66 + dome * 0.10 + fine * 0.06;
      o[5] = 0.0;
      o[6] = 0.95;
    }, { normalStrength: 1.9, repeat: opts.repeat || [1, 1] });
  }

  /** Desert DPM-ish camo fabric for uniforms and helmet covers. */
  camo(size = 512, seed = 151, opts = {}) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 17);
    const cols = opts.palette || [
      [168, 152, 112], [128, 116, 84], [96, 88, 66], [74, 68, 52],
    ];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      // Two blotch scales mixed -> organic, non-repeating shapes.
      const a = n.fbm(u, v, 4, 4, 0.55);
      const b = n.fbm(u + 0.31, v + 0.17, 7, 3, 0.5);
      const fibre = n2.fbm(u, v, 190, 3, 0.55);
      let m = a * 0.62 + b * 0.38;
      m = clamp01((m - 0.34) * 2.1);
      const idx = m < 0.28 ? 0 : m < 0.52 ? 1 : m < 0.76 ? 2 : 3;
      const col = cols[idx];
      const s = 0.94 + fibre * 0.16;
      o[0] = col[0] * s; o[1] = col[1] * s; o[2] = col[2] * s;
      o[3] = 0.5 + fibre * 0.18;
      o[4] = 0.88 + fibre * 0.06;
      o[5] = 0;
      o[6] = 0.92;
    }, { normalStrength: 1.6, repeat: opts.repeat || [1, 1] });
  }

  /** Bark/fibre for palms and dead trees. */
  bark(size = 512, seed = 161, opts = {}) {
    const n = noiseFor(seed);
    const base = opts.color || [86, 70, 52];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const fibres = n.fbm(u * 4 % 1, v * 0.25, 26, 4, 0.6);
      const ridge = Math.pow(Math.abs(Math.sin(v * Math.PI * 2 * 22 + fibres * 9)), 0.6);
      const rot = smoothstep(0.45, 0.85, n.fbm(u, v, 6, 4, 0.5));
      let s = 0.72 + fibres * 0.5 - ridge * 0.22;
      o[0] = base[0] * s; o[1] = base[1] * s; o[2] = base[2] * s;
      o[0] = lerp(o[0], 74, rot * 0.3); o[1] = lerp(o[1], 60, rot * 0.3); o[2] = lerp(o[2], 42, rot * 0.3);
      o[3] = 0.5 + ridge * 0.4 + fibres * 0.16;
      o[4] = 0.94;
      o[5] = 0;
      o[6] = 0.9;
    }, { normalStrength: 3.2, repeat: opts.repeat || [1, 1] });
  }

  /** Woven shade cloth / canopy with stripes and sun damage. */
  canvasCloth(size = 512, seed = 171, opts = {}) {
    const n = noiseFor(seed);
    const stripe = opts.stripe || [186, 176, 150];
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const wu = Math.sin(u * Math.PI * 2 * 34) * 0.5 + 0.5;
      const wv = Math.sin(v * Math.PI * 2 * 34) * 0.5 + 0.5;
      const weave = wu * wv;
      const band = (Math.floor(u * 6) % 2) ? 1 : 0;
      const fade = smoothstep(0.4, 0.9, n.fbm(u, v, 5, 4, 0.5));
      const s = 0.86 + weave * 0.2 + n.fbm(u, v, 150, 3, 0.5) * 0.12;
      const r = lerp(226, stripe[0], band) * s;
      const g = lerp(216, stripe[1], band) * s;
      const b = lerp(188, stripe[2], band) * s;
      o[0] = lerp(r, 196, fade * 0.4);
      o[1] = lerp(g, 184, fade * 0.4);
      o[2] = lerp(b, 152, fade * 0.4);
      o[3] = 0.5 + weave * 0.3;
      o[4] = 0.96;
      o[5] = 0;
      o[6] = 0.88;
    }, { normalStrength: 1.4, repeat: opts.repeat || [1, 1] });
  }

  /** Palm frond — albedo carries an alpha mask for the leaflet silhouette. */
  frond(size = 512, seed = 181) {
    const n = noiseFor(seed);
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      // central rib at v=0.5, leaflets fanning outward
      const rib = smoothstep(0.06, 0.0, Math.abs(v - 0.5));
      const leaf = Math.abs(v - 0.5) * 2;
      const count = 30;
      const wave = Math.sin(u * Math.PI * 2 * count + leaf * 1.4) * 0.5 + 0.5;
      const taper = smoothstep(1.0, 0.1, u);
      const width = (0.55 + taper * 0.35) * (1 - leaf * 0.35);
      const inLeaf = wave > (1 - width * 1.5) ? 1 : 0;
      const alive = inLeaf || rib > 0.4;
      const grain = n.fbm(u, v, 90, 3, 0.55);
      const dry = smoothstep(0.3, 0.95, u);

      const r = lerp(78, 148, dry) * (0.75 + grain * 0.5);
      const g = lerp(104, 132, dry) * (0.75 + grain * 0.5);
      const b = lerp(44, 62, dry) * (0.75 + grain * 0.5);
      o[0] = r; o[1] = g; o[2] = b;
      o[3] = 0.5 + (rib > 0.4 ? 0.4 : 0.1);
      o[4] = 0.85; o[5] = 0; o[6] = 1;
      o[7] = alive ? 1 : 0;   // alpha, harvested below
    }, { normalStrength: 1.5, repeat: [1, 1] });
  }

  /** Generic rock for rubble piles and mountain silhouettes. */
  rock(size = 512, seed = 191) {
    const n = noiseFor(seed);
    const n2 = noiseFor(seed + 21);
    return this._bake(size, (u, v, c) => {
      const o = c.out;
      const big = n.fbm(u, v, 5, 5, 0.55);
      const med = n.fbm(u, v, 22, 4, 0.5);
      const fine = n.fbm(u, v, 140, 3, 0.55);
      const crev = Math.pow(smoothstep(0.0, 0.10, n2.worley(u, v, 11, 1).f2 - n2.worley(u, v, 11, 1).f1), 2.0);
      let l = 118 + big * 48 + med * 26 + fine * 16 - crev * 42;
      o[0] = l * 1.03; o[1] = l * 0.995; o[2] = l * 0.93;
      o[3] = 0.5 + med * 0.25 + big * 0.2 - crev * 0.4;
      o[4] = 0.90 + fine * 0.06;
      o[5] = 0;
      o[6] = 1 - crev * 0.5;
    }, { normalStrength: 3.6 });
  }

  /* ----------------------------------------------------------- build all - */

  /**
   * Bake the whole library, yielding to the browser between materials so the
   * loading bar can animate.
   * @returns {Promise<Object<string, THREE.Material>>} named materials
   */
  async buildAll(onProgress = () => {}, qualityHint = {}) {
    const big = qualityHint.texLarge ?? 1024;
    const mid = qualityHint.texMedium ?? 512;
    const steps = [
      ['concrete', () => this.concrete(big, 11)],
      ['plaster', () => this.plaster(big, 21)],
      ['asphalt', () => this.asphalt(big, 31)],
      ['sand', () => this.sand(big, 41)],
      ['sandDune', () => this.sand(big, 47, { rippleFreq: 9, normalStrength: 3.2 })],
      ['dirt', () => this.dirt(big, 51)],
      ['brick', () => this.brick(mid, 61)],
      ['wood', () => this.wood(mid, 71)],
      ['crateWood', () => this.wood(mid, 77, { planks: 4, tint: [138, 104, 62] })],
      ['paintedMetal', () => this.paintedMetal(mid, 81)],
      ['rustyMetal', () => this.rustyMetal(mid, 91)],
      ['containerBlue', () => this.container(mid, 101, { color: [46, 74, 104] })],
      ['containerRed', () => this.container(mid, 103, { color: [124, 52, 40] })],
      ['containerGreen', () => this.container(mid, 107, { color: [64, 92, 62] })],
      ['sandbag', () => this.sandbag(mid, 111)],
      ['tile', () => this.tile(mid, 121)],
      ['gunSteel', () => this.gunSteel(mid, 131)],
      ['polymer', () => this.polymer(mid, 141)],
      ['camo', () => this.camo(mid, 151)],
      ['bark', () => this.bark(mid, 161)],
      ['cloth', () => this.canvasCloth(mid, 171)],
      ['rock', () => this.rock(mid, 191)],
      ['frond', () => this.frond(mid, 181)],
    ];

    const sets = {};
    for (let i = 0; i < steps.length; i++) {
      const [name, fn] = steps[i];
      sets[name] = fn();
      onProgress((i + 1) / steps.length, name);
      // Yield so the loading UI can paint between bakes.
      await new Promise((r) => setTimeout(r, 0));
    }

    const M = {};
    const mk = (name, opts = {}) => { M[name] = this.material(sets[name], { name, ...opts }); return M[name]; };

    M.concrete = mk('concrete', { roughness: 0.94, metalness: 1, envMapIntensity: 0.85 });
    M.concreteWall = this.material(sets.concrete, {
      name: 'concreteWall', roughness: 0.95, metalness: 1, envMapIntensity: 0.8,
    });
    M.plaster = mk('plaster', { roughness: 1, metalness: 1, envMapIntensity: 0.9 });
    M.asphalt = mk('asphalt', { roughness: 1, metalness: 1, envMapIntensity: 0.7 });
    M.sand = mk('sand', { roughness: 1, metalness: 1, envMapIntensity: 0.95 });
    M.sandDune = mk('sandDune', { roughness: 1, metalness: 1, envMapIntensity: 1 });
    M.dirt = mk('dirt', { roughness: 1, metalness: 1, envMapIntensity: 0.9 });
    M.brick = mk('brick', { roughness: 1, metalness: 1, envMapIntensity: 0.8 });
    M.wood = mk('wood', { roughness: 1, metalness: 1, envMapIntensity: 0.85 });
    M.crateWood = mk('crateWood', { roughness: 1, metalness: 1, envMapIntensity: 0.85 });
    M.paintedMetal = mk('paintedMetal', { roughness: 1, metalness: 1, envMapIntensity: 1.1 });
    M.rustyMetal = mk('rustyMetal', { roughness: 1, metalness: 1, envMapIntensity: 0.95 });
    M.containerBlue = mk('containerBlue', { roughness: 1, metalness: 1, envMapIntensity: 1.05 });
    M.containerRed = mk('containerRed', { roughness: 1, metalness: 1, envMapIntensity: 1.05 });
    M.containerGreen = mk('containerGreen', { roughness: 1, metalness: 1, envMapIntensity: 1.05 });
    M.sandbag = mk('sandbag', { roughness: 1, metalness: 1, envMapIntensity: 0.8 });
    M.tile = mk('tile', { roughness: 1, metalness: 1, envMapIntensity: 1 });
    M.gunSteel = mk('gunSteel', { roughness: 1, metalness: 1, envMapIntensity: 1.25 });
    M.polymer = mk('polymer', { roughness: 1, metalness: 1, envMapIntensity: 0.85 });
    M.camo = mk('camo', { roughness: 1, metalness: 1, envMapIntensity: 0.75 });
    M.bark = mk('bark', { roughness: 1, metalness: 1, envMapIntensity: 0.8 });
    M.cloth = mk('cloth', { roughness: 1, metalness: 1, envMapIntensity: 0.85, side: THREE.DoubleSide });
    M.rock = mk('rock', { roughness: 1, metalness: 1, envMapIntensity: 0.85 });
    // Cut-out foliage: alphaTest keeps depth sorting correct (no transparency).
    M.frond = this.material(sets.frond, {
      name: 'frond', roughness: 0.82, metalness: 0, envMapIntensity: 0.9,
      side: THREE.DoubleSide, alphaTest: 0.5, transparent: false,
    });

    this._cache = { sets, M };
    return M;
  }

  /** UV scale helper: clone a material with its maps repeated n times. */
  static tiled(material, repeatX, repeatY = repeatX) {
    const m = material.clone();
    for (const key of ['map', 'normalMap', 'ormMap']) {
      const t = m[key];
      if (!t) continue;
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(repeatX, repeatY);
      c.needsUpdate = true;
      m[key] = c;
    }
    return m;
  }
}
