/**
 * Particles.js — every transient visual effect in the game.
 *
 * All effects are pooled and CPU-simulated into a handful of buffers, so a
 * firefight never allocates or recompiles shaders:
 *
 *   • two Points systems (additive for fire/sparks, alpha for dust/smoke/blood)
 *   • a decal pool of oriented quads with per-surface bullet-hole textures
 *   • tracers, ejected brass casings and muzzle flashes
 *   • explosions with a light flash, shockwave ring and debris
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, rand, randInt } from '../core/Utils.js';

/* ------------------------------------------------------------ sprites ---- */

function makeSpriteTexture(size = 128, core = 0.14, soft = 1) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / c, dy = (y + 0.5 - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = Math.pow(clamp01(1 - d), 2.4 * soft);
      a = Math.pow(a, 1.0);
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = clamp01(a) * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Bullet-hole decals drawn to a canvas so we can use real vector shapes. */
function makeDecalTexture(kind) {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;

  const hole = (r, col) => {
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grd.addColorStop(0, 'rgba(0,0,0,0.95)');
    grd.addColorStop(0.55, col);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  };

  if (kind === 'concrete') {
    hole(26, 'rgba(190,182,168,0.85)');
    g.strokeStyle = 'rgba(215,208,192,0.5)';
    for (let i = 0; i < 14; i++) {
      const a = rand(0, Math.PI * 2), r = rand(14, 56);
      g.lineWidth = rand(0.6, 2.2);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8);
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.stroke();
    }
    hole(9, 'rgba(30,26,22,0.95)');
  } else if (kind === 'metal') {
    hole(22, 'rgba(150,150,158,0.55)');
    g.fillStyle = 'rgba(210,215,225,0.75)';
    g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(20,18,16,0.9)';
    g.beginPath(); g.arc(cx, cy, 4.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,240,220,0.45)';
    for (let i = 0; i < 8; i++) {
      const a = rand(0, Math.PI * 2);
      g.lineWidth = rand(1, 3);
      g.beginPath(); g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * rand(20, 52), cy + Math.sin(a) * rand(20, 52));
      g.stroke();
    }
  } else if (kind === 'wood') {
    hole(20, 'rgba(90,66,42,0.7)');
    g.fillStyle = 'rgba(24,16,10,0.92)';
    g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(140,104,66,0.7)';
    for (let i = 0; i < 22; i++) {
      const a = rand(0, Math.PI * 2);
      g.lineWidth = rand(1, 3);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8);
      g.lineTo(cx + Math.cos(a) * rand(28, 60), cy + Math.sin(a) * rand(28, 60) * (0.3 + Math.random()));
      g.stroke();
    }
  } else if (kind === 'glass') {
    g.strokeStyle = 'rgba(235,245,255,0.75)';
    g.lineWidth = 1.6;
    for (let i = 0; i < 12; i++) {
      const a = rand(0, Math.PI * 2);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * rand(20, 58), cy + Math.sin(a) * rand(20, 58));
      g.stroke();
    }
    // concentric fracture rings
    for (let r = 10; r < 56; r += rand(8, 16)) {
      g.beginPath();
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const rr = r * rand(0.85, 1.15);
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    hole(12, 'rgba(220,235,255,0.25)');
  } else if (kind === 'blood') {
    g.fillStyle = 'rgba(96,10,8,0.85)';
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2), r = rand(0, 46);
      const rad = rand(3, 14) * (1 - r / 70);
      g.beginPath();
      g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.max(1.5, rad), 0, Math.PI * 2);
      g.fill();
    }
    hole(24, 'rgba(70,6,4,0.9)');
  } else if (kind === 'sand') {
    hole(28, 'rgba(190,168,124,0.6)');
    g.fillStyle = 'rgba(120,100,66,0.55)';
    for (let i = 0; i < 40; i++) {
      g.fillRect(cx + rand(-40, 40), cy + rand(-40, 40), rand(1, 3), rand(1, 3));
    }
    hole(11, 'rgba(60,48,32,0.9)');
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------- point systems --- */

class PointPool {
  constructor(scene, count, blending, sprite, opts = {}) {
    this.count = count;
    this.cursor = 0;

    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 4);   // rgb + alpha
    const siz = new Float32Array(count);
    for (let i = 0; i < count; i++) { pos[i * 3 + 1] = -9999; siz[i] = 0; }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest !== false,
      blending,
      uniforms: {
        uSprite: { value: sprite },
        uPixelScale: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec4 aColor;
        attribute float aSize;
        uniform float uPixelScale;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, aSize * uPixelScale / max(0.35, -mv.z));
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uSprite;
        varying vec4 vColor;
        void main() {
          vec4 s = texture2D(uSprite, gl_PointCoord);
          float a = s.a * vColor.a;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.renderOrder ?? 4;
    scene.add(this.points);

    // CPU simulation state
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.size1 = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.col0 = new Float32Array(count * 4);
    this.timeScale = new Float32Array(count);
  }

  spawn({ pos, vel, color, size, size1, life, drag = 1.2, gravity = 0, fade = 1 }) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const p = this.geo.attributes.position.array;
    p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
    this.vel[i * 3] = vel.x; this.vel[i * 3 + 1] = vel.y; this.vel[i * 3 + 2] = vel.z;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = size; this.size1[i] = size1 ?? size * 0.6;
    this.drag[i] = drag; this.grav[i] = gravity;
    const c = this.geo.attributes.aColor.array;
    c[i * 4] = color.r; c[i * 4 + 1] = color.g; c[i * 4 + 2] = color.b;
    c[i * 4 + 3] = color.a ?? 1;
    this.col0[i * 4] = color.r; this.col0[i * 4 + 1] = color.g; this.col0[i * 4 + 2] = color.b;
    this.col0[i * 4 + 3] = (color.a ?? 1) * fade;
    return i;
  }

  update(dt) {
    const p = this.geo.attributes.position.array;
    const c = this.geo.attributes.aColor.array;
    const s = this.geo.attributes.aSize.array;
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) { if (s[i] !== 0) { s[i] = 0; any = true; } continue; }
      any = true;
      this.life[i] -= dt;
      const t = clamp01(1 - this.life[i] / this.maxLife[i]);   // 0 → 1 over life
      const dragK = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= dragK;
      this.vel[i * 3 + 2] *= dragK;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dragK + this.grav[i] * dt;
      p[i * 3] += this.vel[i * 3] * dt;
      p[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      p[i * 3 + 2] += this.vel[i * 3 + 2] * dt;

      s[i] = lerp(this.size0[i], this.size1[i], t);
      // fade in fast, out slow
      const a = this.col0[i * 4 + 3] * (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88);
      c[i * 4 + 3] = a;
      if (this.life[i] <= 0) { s[i] = 0; c[i * 4 + 3] = 0; }
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
    }
  }
}

/* ------------------------------------------------------------ decals ----- */

class DecalPool {
  constructor(scene, textures, max = 140) {
    this.max = max;
    this.items = [];
    this.textures = textures;
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < max; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: textures.concrete,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        toneMapped: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.items.push({ mesh, life: 0, size: 0.2 });
    }
    this.cursor = 0;
  }

  add(point, normal, surface, size = 0.22, life = 40) {
    const kind = ({ concrete: 'concrete', asphalt: 'concrete', metal: 'metal', thinMetal: 'metal', wood: 'wood', glass: 'glass', sand: 'sand', dirt: 'sand', sandbag: 'sand' })[surface] || 'concrete';
    const item = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    item.mesh.visible = true;
    item.life = life;
    item.size = size;
    item.mesh.material.map = this.textures[kind];
    item.mesh.material.needsUpdate = true;
    item.mesh.position.copy(point).addScaledVector(normal, 0.012);
    const up = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), normal.clone().negate(), up);
    item.mesh.quaternion.setFromRotationMatrix(m);
    item.mesh.rotateZ(rand(0, Math.PI * 2));
    // random slight scale variation
    const s = size * rand(0.8, 1.25);
    item.mesh.scale.set(s, s, s);
    item.mesh.material.opacity = 1;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life -= dt;
      if (it.life < 6) it.mesh.material.opacity = clamp01(it.life / 6);
      if (it.life <= 0) it.mesh.visible = false;
    }
  }

  clear() { for (const it of this.items) { it.mesh.visible = false; it.life = 0; } }
}

/* ----------------------------------------------------------- tracers ----- */

class TracerPool {
  constructor(scene, max = 80) {
    this.max = max;
    this.items = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    // A tracer is a long thin quad, additive, billboarded towards the camera.
    for (let i = 0; i < max; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffcc88, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.items.push({ mesh, life: 0, vel: new THREE.Vector3(), pos: new THREE.Vector3(), len: 6 });
    }
    this.cursor = 0;
  }

  add(origin, dir, color, opacity = 1, speed = 900, len = 7) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    it.mesh.visible = true;
    it.mesh.material.color.setHex(color);
    it.mesh.material.opacity = opacity;
    it.pos.copy(origin);
    it.vel.copy(dir).multiplyScalar(speed);
    it.life = 0.55;
    it.len = len;
    it.dir = dir.clone();
  }

  update(dt, camera, colliders) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      const step = it.vel.clone().multiplyScalar(dt);
      // stop the tracer when it hits something
      const hit = colliders.raycast(it.pos, it.dir, step.length(), { ignoreTransparent: true });
      if (hit) {
        it.pos.copy(hit.point);
        it.mesh.material.opacity *= 0.4;
        it.life = Math.min(it.life, 0.05);
      } else {
        it.pos.add(step);
      }
      it.mesh.position.copy(it.pos);
      it.mesh.lookAt(camera.position);
      it.mesh.scale.set(it.len, 0.055, 1);
      it.mesh.material.opacity = Math.max(0, it.mesh.material.opacity - dt * 1.6);
    }
  }
}

/* ----------------------------------------------------------- casings ----- */

class CasingPool {
  constructor(scene, materials, max = 48) {
    this.max = max;
    this.items = [];
    const geo = new THREE.CylinderGeometry(0.0052, 0.0056, 0.021, 8);
    geo.rotateX(Math.PI / 2);
    const mat = materials;
    this.cursor = 0;
    for (let i = 0; i < max; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.castShadow = false;
      scene.add(mesh);
      this.items.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, grounded: false });
    }
  }

  eject(muzzleWorld, upDir, inheritVel, colliders) {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    it.mesh.visible = true;
    it.mesh.position.copy(muzzleWorld);
    // brass flies up and to the right of the weapon
    it.vel.set(rand(1.2, 2.4), rand(1.6, 2.9), rand(-0.4, 0.4));
    it.vel.addScaledVector(inheritVel, 0.35);
    it.spin.set(rand(-28, 28), rand(-28, 28), rand(-28, 28));
    it.life = 9;
    it.grounded = false;
    it.colliders = colliders;
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      if (!it.grounded) {
        it.vel.y -= 16 * dt;
        it.mesh.position.addScaledVector(it.vel, dt);
        const g = it.colliders ? it.colliders.groundAt(it.mesh.position.x, it.mesh.position.z, it.mesh.position.y + 0.2) : 0;
        if (it.mesh.position.y <= g + 0.012) {
          it.mesh.position.y = g + 0.012;
          it.vel.y = Math.abs(it.vel.y) * 0.32;
          it.vel.x *= 0.6; it.vel.z *= 0.6;
          it.spin.multiplyScalar(0.5);
          if (it.vel.y < 0.35) { it.grounded = true; it.vel.set(0, 0, 0); it.mesh.rotation.x = Math.PI / 2; }
        }
        it.mesh.rotation.x += it.spin.x * dt;
        it.mesh.rotation.y += it.spin.y * dt;
        it.mesh.rotation.z += it.spin.z * dt;
      }
      if (it.life < 2) it.mesh.visible = false;
    }
  }
}

/* -------------------------------------------------------------- system --- */

export class ParticleSystem {
  constructor(scene, materials, settings, colliders) {
    this.scene = scene;
    this.settings = settings;
    this.colliders = colliders;

    const budget = settings?.get?.('particleBudget') ?? 1;
    const soft = makeSpriteTexture(128, 0.14, 1);
    const sparks = makeSpriteTexture(64, 0.2, 2.2);

    this.additive = new PointPool(scene, Math.round(2600 * budget), THREE.AdditiveBlending, sparks, { renderOrder: 6 });
    this.smoke = new PointPool(scene, Math.round(2200 * budget), THREE.NormalBlending, soft, { renderOrder: 4 });
    this.smoke.mat.blending = THREE.NormalBlending;

    this.decals = new DecalPool(scene, {
      concrete: makeDecalTexture('concrete'),
      metal: makeDecalTexture('metal'),
      wood: makeDecalTexture('wood'),
      glass: makeDecalTexture('glass'),
      blood: makeDecalTexture('blood'),
      sand: makeDecalTexture('sand'),
    }, Math.round(settings?.get?.('decalBudget') ?? 140));

    this.tracers = new TracerPool(scene, 90);
    this.casings = new CasingPool(scene, materials.brass, 48);

    // muzzle flash quad
    this.flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.flashMat);
    this.flashMesh.visible = false;
    this.flashMesh.frustumCulled = false;
    scene.add(this.flashMesh);

    // explosion light + ring
    this.exploLight = new THREE.PointLight(0xffb070, 0, 34, 2);
    scene.add(this.exploLight);
    this.exploLightTimer = 0;

    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd0a0, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.55, 32), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);
    this.ringLife = 0;

    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.time = 0;
  }

  /* ------------------------------------------------------------ effects - */

  /** Muzzle flash: light-driven quad + sparks + a puff of smoke. */
  muzzleFlash(pos, dir, scale = 1, velocity = 800) {
    this.flashMesh.visible = true;
    this.flashMesh.position.copy(pos);
    this.flashMesh.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize()));
    this.flashMesh.rotateZ(rand(0, Math.PI * 2));
    const s = scale * rand(0.42, 0.62);
    this.flashMesh.scale.set(s, s, s);
    this.flashMat.opacity = 1.0;
    this.flashTimer = 0.045;

    // unburnt powder and sparks out of the muzzle
    for (let i = 0; i < 5 * scale; i++) {
      this._c.setRGB(1, rand(0.55, 0.85), rand(0.2, 0.45));
      this.additive.spawn({
        pos: this._v.copy(pos),
        vel: this._v2.copy(dir).multiplyScalar(rand(6, 22)).add(new THREE.Vector3(rand(-2, 2), rand(-1, 3), rand(-2, 2))),
        color: { r: this._c.r, g: this._c.g, b: this._c.b, a: 1 },
        size: rand(0.06, 0.14) * scale, size1: 0.01,
        life: rand(0.05, 0.16), drag: 4, gravity: -2,
      });
    }
    // smoke
    for (let i = 0; i < 2; i++) {
      this._c.setRGB(0.62, 0.6, 0.56);
      this.smoke.spawn({
        pos: this._v.copy(pos),
        vel: this._v2.copy(dir).multiplyScalar(rand(2, 5)).add(new THREE.Vector3(rand(-1, 1), rand(0.4, 1.4), rand(-1, 1))),
        color: { r: this._c.r, g: this._c.g, b: this._c.b, a: 0.30 },
        size: 0.14 * scale, size1: 0.7 * scale,
        life: rand(0.5, 1.1), drag: 1.6, gravity: 0.5,
      });
    }
  }

  barrelSmoke(muzzleNode, dir, heat) {
    if (!muzzleNode || Math.random() > 0.35) return;
    const pos = muzzleNode.getWorldPosition(this._v.clone());
    this._c.setRGB(0.7, 0.68, 0.64);
    this.smoke.spawn({
      pos,
      vel: this._v2.copy(dir).multiplyScalar(rand(0.6, 1.6)).add(new THREE.Vector3(rand(-0.2, 0.2), rand(0.4, 0.9), rand(-0.2, 0.2))),
      color: { r: this._c.r, g: this._c.g, b: this._c.b, a: 0.22 * clamp(heat, 0, 1) },
      size: 0.05, size1: 0.42,
      life: rand(0.7, 1.4), drag: 1.1, gravity: 0.35,
    });
  }

  tracer(origin, dir, color, opacity) {
    // spawn slightly down-range so it appears to leave the barrel
    const start = origin.clone().addScaledVector(dir, 0.5);
    this.tracers.add(start, dir, color, opacity);
  }

  ejectCasing(ejectNode, playerVel, weaponKey) {
    const pos = ejectNode.getWorldPosition(new THREE.Vector3());
    this.casings.eject(pos, null, playerVel, this.colliders);
  }

  /** Bullet impact: sparks, dust, chips and a decal. */
  impact(point, normal, surface, dir, surf, strength = 1) {
    const rng = Math.random;
    const kind = surface || 'concrete';
    // dust cloud for porous materials
    const dustiness = surf.dust * strength;
    if (dustiness > 0.05) {
      const dusty = kind === 'sand' || kind === 'dirt' || kind === 'sandbag';
      this._c.setRGB(dusty ? 0.78 : 0.72, dusty ? 0.68 : 0.70, dusty ? 0.5 : 0.68);
      for (let i = 0; i < Math.ceil(4 * dustiness); i++) {
        this.smoke.spawn({
          pos: this._v.copy(point).addScaledVector(normal, 0.03),
          vel: this._v2.copy(dir).multiplyScalar(-rand(0.4, 1.4))
            .add(new THREE.Vector3(rand(-1.2, 1.2), rand(0.3, 1.8), rand(-1.2, 1.2))),
          color: { r: this._c.r, g: this._c.g, b: this._c.b, a: 0.5 * dustiness },
          size: rand(0.08, 0.2), size1: rand(0.5, 0.95),
          life: rand(0.4, 1.0), drag: 2.2, gravity: -0.6,
        });
      }
    }
    // sparks for metal
    if (surf.spark > 0.05) {
      for (let i = 0; i < Math.ceil(9 * surf.spark * strength); i++) {
        const spread = 0.9;
        this._c.setRGB(1, rand(0.6, 0.9), rand(0.25, 0.5));
        this.additive.spawn({
          pos: this._v.copy(point).addScaledVector(normal, 0.02),
          vel: this._v2.copy(normal).multiplyScalar(rand(1, 5))
            .add(new THREE.Vector3(rand(-spread, spread) * 3, rand(0, 3), rand(-spread, spread) * 3)),
          color: { r: 1, g: this._c.g, b: this._c.b, a: 1 },
          size: rand(0.02, 0.05), size1: 0.005,
          life: rand(0.18, 0.5), drag: 1.2, gravity: -9,
        });
      }
    }
    // wood splinters
    if (kind === 'wood') {
      for (let i = 0; i < 6; i++) {
        this._c.setRGB(0.45, 0.33, 0.2);
        this.additive.spawn({
          pos: this._v.copy(point),
          vel: this._v2.copy(normal).multiplyScalar(rand(1, 4)).add(new THREE.Vector3(rand(-2, 2), rand(0.5, 3), rand(-2, 2))),
          color: { r: 0.5, g: 0.36, b: 0.2, a: 0.9 },
          size: rand(0.02, 0.06), size1: 0.01,
          life: rand(0.3, 0.7), drag: 1.4, gravity: -8,
        });
      }
    }
    if (this.settings?.get?.('gore') !== false || kind === 'metal') {
      this.decals.add(point, normal, kind, rand(0.14, 0.24));
    }
  }

  /** Small puff on the back face when a round fails to punch through. */
  impactBack(point, dir, surface, surf) {
    const dusty = surface === 'sand' || surface === 'dirt';
    this._c.setRGB(dusty ? 0.75 : 0.66, dusty ? 0.66 : 0.64, dusty ? 0.48 : 0.62);
    for (let i = 0; i < 3; i++) {
      this.smoke.spawn({
        pos: this._v.copy(point).addScaledVector(dir, 0.02),
        vel: this._v2.copy(dir).multiplyScalar(rand(0.4, 1.6)).add(new THREE.Vector3(rand(-0.6, 0.6), rand(0.2, 1.2), rand(-0.6, 0.6))),
        color: { r: this._c.r, g: this._c.g, b: this._c.b, a: 0.35 },
        size: 0.06, size1: 0.4,
        life: rand(0.3, 0.8), drag: 2, gravity: -0.4,
      });
    }
    if (surf?.spark > 0.3) {
      for (let i = 0; i < 4; i++) {
        this.additive.spawn({
          pos: this._v.copy(point),
          vel: this._v2.copy(dir).multiplyScalar(rand(1, 3)).add(new THREE.Vector3(rand(-1, 1), rand(0, 2), rand(-1, 1))),
          color: { r: 1, g: 0.7, b: 0.35, a: 1 },
          size: 0.02, size1: 0.004, life: rand(0.15, 0.4), drag: 1.2, gravity: -9,
        });
      }
    }
  }

  /** Blood spray and mist. */
  bloodImpact(point, normal, dir, amount = 1) {
    if (this.settings?.get?.('gore') === false) return;
    const red = { r: 0.30, g: 0.018, b: 0.012 };
    const n = Math.round(10 * clamp(amount, 0.4, 2.4));
    for (let i = 0; i < n; i++) {
      const spread = 0.55;
      this.smoke.spawn({
        pos: this._v.copy(point),
        vel: this._v2.copy(dir).multiplyScalar(rand(1.5, 5.5))
          .add(new THREE.Vector3(rand(-spread, spread) * 3, rand(0, 2.4), rand(-spread, spread) * 3)),
        color: { r: red.r * rand(0.7, 1.3), g: red.g, b: red.b, a: 0.85 },
        size: rand(0.02, 0.055), size1: rand(0.05, 0.13),
        life: rand(0.25, 0.6), drag: 1.4, gravity: -12,
      });
    }
    // mist
    for (let i = 0; i < 4; i++) {
      this.smoke.spawn({
        pos: this._v.copy(point),
        vel: this._v2.copy(dir).multiplyScalar(rand(0.4, 1.4)).add(new THREE.Vector3(rand(-0.6, 0.6), rand(0, 1), rand(-0.6, 0.6))),
        color: { r: 0.22, g: 0.02, b: 0.02, a: 0.35 },
        size: 0.12, size1: 0.5,
        life: rand(0.3, 0.8), drag: 1.6, gravity: 0.2,
      });
    }
    this.decals.add(point, normal, 'blood', rand(0.16, 0.3), 30);
  }

  /** Ground/floor blood pool after a kill. */
  bloodPool(pos, colliders) {
    if (this.settings?.get?.('gore') === false) return;
    const y = colliders.groundAt(pos.x, pos.z) + 0.012;
    this.decals.add(new THREE.Vector3(pos.x, y, pos.z), new THREE.Vector3(0, 1, 0), 'blood', rand(0.7, 1.2), 60);
  }

  /** Grenade / explosive: fireball, smoke, dust ring, debris, shockwave ring. */
  explosion(pos, radius = 7, onDamage) {
    // fireball
    for (let i = 0; i < 34; i++) {
      const a = rand(0, Math.PI * 2), e = rand(-0.4, 1.2);
      this._c.setRGB(1, rand(0.45, 0.8), rand(0.1, 0.35));
      this.additive.spawn({
        pos: this._v.copy(pos),
        vel: this._v2.set(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)).multiplyScalar(rand(3, 13)),
        color: { r: 1, g: this._c.g, b: this._c.b, a: 1 },
        size: rand(0.2, 0.6), size1: rand(0.5, 1.4),
        life: rand(0.16, 0.5), drag: 2.6, gravity: 3,
      });
    }
    // smoke column
    for (let i = 0; i < 46; i++) {
      const a = rand(0, Math.PI * 2);
      const g = rand(0.08, 0.22);
      this.smoke.spawn({
        pos: this._v.copy(pos).add(new THREE.Vector3(rand(-1, 1), rand(-0.4, 1.2), rand(-1, 1))),
        vel: this._v2.set(Math.cos(a) * rand(1, 7), rand(1, 6), Math.sin(a) * rand(1, 7)),
        color: { r: g, g: g * 0.95, b: g * 0.9, a: 0.7 },
        size: rand(0.5, 1.4), size1: rand(2.2, 4.6),
        life: rand(1.2, 3.0), drag: 1.1, gravity: 0.7,
      });
    }
    // ground dust ring
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      this.smoke.spawn({
        pos: this._v.copy(pos).setY(pos.y + 0.15),
        vel: this._v2.set(Math.cos(a), 0.12, Math.sin(a)).multiplyScalar(rand(4, 12)),
        color: { r: 0.66, g: 0.6, b: 0.46, a: 0.6 },
        size: 0.4, size1: 2.4,
        life: rand(0.9, 1.8), drag: 1.8, gravity: -0.3,
      });
    }
    // debris
    for (let i = 0; i < 24; i++) {
      this.additive.spawn({
        pos: this._v.copy(pos),
        vel: this._v2.set(rand(-1, 1), rand(0.4, 1.6), rand(-1, 1)).normalize().multiplyScalar(rand(5, 18)),
        color: { r: 0.35, g: 0.3, b: 0.24, a: 0.9 },
        size: 0.08, size1: 0.03,
        life: rand(0.6, 1.4), drag: 0.9, gravity: -16,
      });
    }
    // flash + ring
    this.exploLight.position.copy(pos);
    this.exploLight.intensity = 90;
    this.exploLight.distance = radius * 7;
    this.exploLightTimer = 0.35;
    this.ring.position.copy(pos).setY(pos.y + 0.06);
    this.ring.visible = true;
    this.ring.scale.setScalar(1);
    this.ringMat.opacity = 0.75;
    this.ringLife = 0.5;

    onDamage?.(pos, radius);
  }

  /* -------------------------------------------------------------- frame - */

  update(dt, camera) {
    this.time += dt;
    this.additive.update(dt);
    this.smoke.update(dt);
    this.decals.update(dt);
    this.tracers.update(dt, camera, this.colliders);
    this.casings.update(dt);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.flashMat.opacity = clamp01(this.flashTimer / 0.045) * 0.95;
      if (this.flashTimer <= 0) this.flashMesh.visible = false;
    }
    if (this.exploLightTimer > 0) {
      this.exploLightTimer -= dt;
      this.exploLight.intensity = Math.max(0, this.exploLight.intensity - dt * 320);
      if (this.exploLightTimer <= 0) this.exploLight.intensity = 0;
    }
    if (this.ringLife > 0) {
      this.ringLife -= dt;
      const t = 1 - this.ringLife / 0.5;
      this.ring.scale.setScalar(1 + t * 9);
      this.ringMat.opacity = 0.75 * (1 - t);
      if (this.ringLife <= 0) this.ring.visible = false;
    }
  }

  clear() {
    this.decals.clear();
    for (const it of this.tracers.items) it.mesh.visible = false;
    for (const it of this.casings.items) it.mesh.visible = false;
  }
}
