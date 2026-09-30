/**
 * Environment.js — atmosphere, sun, image-based lighting.
 *
 * The lighting rig is deliberately physically motivated:
 *   • a Preetham sky model drives both the visible background and the
 *     environment probe, so metal reflections match the sky exactly
 *   • one shadow-casting sun at a low late-afternoon elevation (long shadows)
 *   • a hemisphere fill for dusty bounce light
 *   • exponential haze that matches the horizon, so distance reads correctly
 * The sun's shadow camera follows the player and is snapped to shadow-map
 * texels to stop edge shimmer while walking.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { damp } from '../core/Utils.js';

export class Environment {
  constructor(scene, renderer, settings) {
    this.scene = scene;
    this.renderer = renderer;
    this.settings = settings;

    this.sunDirection = new THREE.Vector3();

    // ---- sky ---------------------------------------------------------------
    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    this.sky.material.depthWrite = false;
    this.sky.material.fog = false;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    const u = this.sky.material.uniforms;
    u.turbidity.value = 5.4;          // dust in the air
    u.rayleigh.value = 1.85;          // low sun ⇒ warm scattering
    u.mieCoefficient.value = 0.0062;
    u.mieDirectionalG.value = 0.82;

    // ---- sun ---------------------------------------------------------------
    // Intensities here are calibrated against an ACES exposure of 0.75 so that a
    // sunlit plaster wall lands around 0.75 luminance instead of clipping.
    this.sun = new THREE.DirectionalLight(0xffd9a6, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 340;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.blurSamples = 10;
    this.sun.shadow.radius = 1.5;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // ---- fill / bounce -----------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0xb08c5a, 0.20);
    scene.add(this.hemi);

    // A very dim ambient keeps pitch-black interiors readable.
    this.ambient = new THREE.AmbientLight(0x4a5560, 0.06);
    scene.add(this.ambient);

    // ---- haze --------------------------------------------------------------
    this.fogColor = new THREE.Color(0xc9b394);
    scene.fog = new THREE.FogExp2(this.fogColor.getHex(), 0.0034);

    // ---- environment probe -------------------------------------------------
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader?.();
    this._envScene = new THREE.Scene();
    this._envSky = new Sky();
    this._envSky.scale.setScalar(10000);
    this._envSky.material.uniforms.turbidity.value = u.turbidity.value;
    this._envSky.material.uniforms.rayleigh.value = u.rayleigh.value;
    this._envSky.material.uniforms.mieCoefficient.value = u.mieCoefficient.value;
    this._envSky.material.uniforms.mieDirectionalG.value = u.mieDirectionalG.value;
    this._envScene.add(this._envSky);
    this._envRT = null;

    // ---- shadow follow -----------------------------------------------------
    this._shadowTexel = 1;
    this._shadowSize = 60;
    this.shadowTarget = new THREE.Vector3();

    this.setSun(118, 12.5);      // azimuth°, elevation°
    this.buildTerrain();
    this.buildDustMotes();
  }

  /* ------------------------------------------------------------ sun setup - */

  /**
   * @param {number} azimuthDeg compass bearing in degrees
   * @param {number} elevationDeg height above horizon
   */
  setSun(azimuthDeg, elevationDeg) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

    this.sky.material.uniforms.sunPosition.value.copy(sunDir);
    this._envSky.material.uniforms.sunPosition.value.copy(sunDir);
    this.sunDirection.copy(sunDir);

    this.sun.position.copy(sunDir).multiplyScalar(160);
    this.sun.target.position.set(0, 0, 0);

    // Warmer and dimmer as the sun drops toward the horizon.
    const t = THREE.MathUtils.clamp(elevationDeg / 30, 0, 1);
    this.sun.color.setHSL(0.075 + 0.02 * t, 0.62 - 0.25 * t, 0.52 + 0.14 * t);
    this.sun.intensity = 0.85 + 1.35 * t;
    this.hemi.intensity = 0.10 + 0.16 * t;

    this.rebuildEnvironment();
  }

  /** Re-bake the PMREM probe from the sky (cheap: only on change / load). */
  rebuildEnvironment() {
    const res = this.settings?.get?.('envResolution') ?? 512;
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    this._envRT = this.pmrem.fromScene(this._envScene, 0, 100, 100000);
    this.scene.environment = this._envRT.texture;
    // Sky IBL is the dominant ambient term — keep it modest so shadows stay
    // readable and lit surfaces do not clip.
    this.scene.environmentIntensity = 0.32;
  }

  /* -------------------------------------------------------------- terrain - */

  /** Low-poly haze-blended mountain ring so the horizon has real depth. */
  buildTerrain() {
    const g = new THREE.Group();
    g.name = 'distantTerrain';

    const rand = (a, b) => a + Math.random() * (b - a);
    // Build a couple of staggered rings of jagged ridges.
    for (const ring of [{ r: 900, h: 120, n: 46 }, { r: 1500, h: 210, n: 38 }, { r: 2300, h: 320, n: 30 }]) {
      const positions = [];
      const colors = [];
      const c = new THREE.Color();
      const haze = this.fogColor.clone();

      for (let i = 0; i < ring.n; i++) {
        const a = (i / ring.n) * Math.PI * 2 + rand(-0.05, 0.05);
        const rr = ring.r * rand(0.86, 1.16);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const h = ring.h * rand(0.55, 1.35);
        const w = ring.r * rand(0.06, 0.12);
        // A ridge as two triangles (a thin blade silhouette).
        const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
        const base = -12;
        const verts = [
          [x - px, base, z - pz], [x + px, base, z + pz], [x + rand(-w * .4, w * .4), h, z + rand(-w * .4, w * .4)],
        ];
        for (const v of verts) positions.push(...v);
        // Height-based blending into haze: peaks catch a little more light.
        for (let k = 0; k < 3; k++) {
          const isApex = k === 2;
          const mix = isApex ? 0.42 : 0.72;
          c.copy(haze).lerp(new THREE.Color(0x9a8e78), 1 - mix);
          colors.push(c.r * (isApex ? 1.1 : 0.94), c.g * (isApex ? 1.04 : 0.92), c.b * (isApex ? 0.96 : 0.9));
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      g.add(mesh);
    }

    this.scene.add(g);
    this.terrain = g;
  }

  /* ----------------------------------------------------------- dust motes - */

  /** Slow-drifting motes near the camera: sells "air you can feel". */
  buildDustMotes() {
    const count = 900;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 44;
      pos[i * 3 + 1] = Math.random() * 14;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 44;
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0xffe9c0) },
        uOpacity: { value: 0.30 },
        uSize: { value: 46 },
      },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime, uSize;
        varying float vFade;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.25 + aSeed) * 1.6;
          p.y += sin(uTime * 0.17 + aSeed * 1.7) * 0.9;
          p.z += cos(uTime * 0.21 + aSeed * 0.7) * 1.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * (0.4 + 0.6 * fract(aSeed)) / max(1.0, -mv.z);
          vFade = smoothstep(46.0, 2.0, -mv.z);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity;
        varying float vFade;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.05, length(d));
          gl_FragColor = vec4(uColor, a * uOpacity * vFade);
        }`,
    });

    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 3;
    this.scene.add(this.motes);
  }

  /* -------------------------------------------------------------- runtime - */

  update(dt, camera, playerPos) {
    // Sky + motes ride along with the camera, avoiding any parallax pop.
    this.sky.position.copy(camera.position);
    if (this.motes) {
      this.motes.position.set(playerPos.x, 0, playerPos.z);
      this.motes.material.uniforms.uTime.value += dt;
    }

    // Sun follows the player so shadow resolution stays high where it matters.
    const size = this._shadowSize;
    const cam = this.sun.shadow.camera;
    if (cam.right !== size) {
      cam.left = -size; cam.right = size;
      cam.top = size; cam.bottom = -size;
      cam.updateProjectionMatrix();
      this._shadowTexel = (size * 2) / this.sun.shadow.mapSize.x;
    }

    const ahead = this.sunDirection.clone().setY(0).normalize().multiplyScalar(-16);
    const tx = playerPos.x + ahead.x;
    const tz = playerPos.z + ahead.z;

    // Snap the shadow frustum to texels to prevent crawling edges.
    const texel = this._shadowTexel;
    const sx = Math.round(tx / texel) * texel;
    const sz = Math.round(tz / texel) * texel;

    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + this.sunDirection.x * 160, this.sunDirection.y * 160, sz + this.sunDirection.z * 160);
    this.sun.target.updateMatrixWorld();

    // Fog density breathes very slightly — a living haze, not a static veil.
    if (this.scene.fog) {
      this.scene.fog.density = damp(this.scene.fog.density, 0.0034, 0.4, dt);
    }
  }

  setShadowQuality(level) {
    const map = { off: 0, low: 1024, medium: 2048, high: 4096 }[level] ?? 2048;
    if (map === 0) {
      this.sun.castShadow = false;
      return;
    }
    this.sun.castShadow = true;
    if (this.sun.shadow.mapSize.x !== map) {
      this.sun.shadow.mapSize.set(map, map);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    // Higher resolutions can afford a wider, softer penumbra.
    this.sun.shadow.radius = map >= 4096 ? 2.2 : map >= 2048 ? 1.5 : 1.0;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
  }
}
