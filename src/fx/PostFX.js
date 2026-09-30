/**
 * PostFX.js — the post-processing chain.
 *
 * Order mirrors a real camera pipeline:
 *
 *   RenderPass       → scene into a half-float HDR buffer (linear light)
 *   GTAOPass         → screen-space ambient occlusion for contact shadows
 *   ViewmodelPass    → weapon drawn with a separate narrow-FOV camera
 *   UnrealBloomPass  → lens/sensor bloom on genuine HDR overbrights
 *   OutputPass       → ACES filmic tonemap + sRGB transfer
 *   GradePass        → lens character: vignette, grain, chroma, split-tone
 *   SMAAPass         → edge anti-aliasing on the final display image
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

/** Renders the first-person weapon on top of the scene with a cleared depth buffer. */
class ViewmodelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.clear = false;
    this.needsSwap = true;
  }
  render(renderer, writeBuffer, readBuffer) {
    if (!this.enabled || !this.scene || !this.camera) return;
    const target = this.renderToScreen ? null : readBuffer;
    renderer.setRenderTarget(target);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
  setSize() { /* camera aspect handled by the engine */ }
}

/** Lens character: barrel distortion, chromatic aberration, vignette, grain, split-tone. */
const LensGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAmount: { value: 1 },        // master on/off blend
    uVignette: { value: 0.42 },
    uGrain: { value: 0.030 },
    uChroma: { value: 0.0022 },
    uDistort: { value: 0.012 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.045 },
    uLift: { value: new THREE.Vector3(0.008, 0.010, 0.017) },   // cool shadows
    uGain: { value: new THREE.Vector3(1.030, 1.006, 0.968) },   // warm highlights
    uSuppress: { value: 0 },      // rises under fire → desaturation + tunnel vision
    uExposure: { value: 1.0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAmount, uVignette, uGrain, uChroma, uDistort;
    uniform float uSaturation, uContrast, uSuppress, uExposure;
    uniform vec3 uLift, uGain;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 cc = vUv - 0.5;
      float r2 = dot(cc, cc);

      // barrel distortion (kind to the eye at low amounts)
      vec2 uv = vUv + cc * r2 * uDistort;

      // radial chromatic aberration, scaled up while suppressed
      float ca = uChroma * (1.0 + uSuppress * 2.0);
      vec2 dir = cc * ca * (0.4 + r2 * 2.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir).b;

      col *= uExposure;

      // ---- grade: exposure → contrast → split tone → saturation -------------
      col = clamp(col, 0.0, 1.0);
      col = (col - 0.5) * uContrast + 0.5;
      col = col * uGain + uLift * (1.0 - col);
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float sat = uSaturation * (1.0 - uSuppress * 0.45);
      col = mix(vec3(lum), col, sat);
      col = mix(col, vec3(lum) * vec3(0.92, 0.97, 1.05), uSuppress * 0.30);

      // ---- vignette --------------------------------------------------------
      float vig = smoothstep(0.95, 0.18, r2 * (1.0 + uSuppress * 0.5));
      col *= mix(1.0, vig, uVignette);

      // ---- film grain (more visible in shadows, like real negative) --------
      float g = hash(vUv * uResolution + fract(uTime) * 71.13) - 0.5;
      col += g * uGrain * (1.25 - lum) * (1.0 + uSuppress);

      col = clamp(col, 0.0, 1.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera, settings) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.settings = settings;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // ---- ambient occlusion ------------------------------------------------
    this.gtaoPass = new GTAOPass(scene, camera, size.x, size.y);
    this.gtaoPass.output = GTAOPass.OUTPUT.Default;
    this.gtaoPass.blendIntensity = 0.9;
    if (this.gtaoPass.updateGtaoMaterial) {
      this.gtaoPass.updateGtaoMaterial({
        radius: 0.30, distanceExponent: 1.6, thickness: 0.9,
        distanceFalloff: 1.0, scale: 1.05, samples: settings.get('gtaoSamples') || 16,
        screenSpaceRadius: false,
      });
    }
    this.gtaoPass.enabled = settings.get('ao');
    this.composer.addPass(this.gtaoPass);

    // ---- first-person weapon ---------------------------------------------
    this.viewmodelPass = new ViewmodelPass(null, null);
    this.viewmodelPass.enabled = false;
    this.composer.addPass(this.viewmodelPass);

    // ---- bloom ------------------------------------------------------------
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.34,   // strength — subtle: only real overbrights should glow
      0.62,   // radius
      1.15,   // threshold: above the calibrated sky, so only true highlights bloom
    );
    this.bloomPass.enabled = settings.get('bloom');
    this.composer.addPass(this.bloomPass);

    // ---- tonemap + colour space ------------------------------------------
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // ---- lens grade -------------------------------------------------------
    this.gradePass = new ShaderPass(LensGradeShader);
    this.gradePass.material.uniforms.uAmount.value = settings.get('grade') ? 1 : 0;
    this.gradePass.enabled = settings.get('grade');
    this.gradePass.material.uniforms.uResolution.value.set(size.x, size.y);
    this.composer.addPass(this.gradePass);

    // ---- anti-aliasing ----------------------------------------------------
    this.smaaPass = null;
    try { this.smaaPass = new SMAAPass(); } catch { this.smaaPass = null; }
    if (this.smaaPass) {
      this.smaaPass.enabled = settings.get('aa');
      this.composer.addPass(this.smaaPass);
    }

    this._time = 0;
    this._exposureTarget = 1;
  }

  /** GTAO writes its AO buffer at the composer resolution. */
  setSize(w, h) {
    this.composer.setSize(w, h);
    this.gtaoPass.setSize(w, h);
    this.bloomPass.setSize(w, h);
    this.gradePass.material.uniforms.uResolution.value.set(w, h);
    this.smaaPass?.setSize?.(w, h);
  }

  setViewmodel(scene, camera) {
    this.viewmodelPass.scene = scene;
    this.viewmodelPass.camera = camera;
    this.viewmodelPass.enabled = !!(scene && camera);
  }

  applySettings(s) {
    this.gtaoPass.enabled = s.get('ao');
    this.bloomPass.enabled = s.get('bloom');
    if (this.smaaPass) this.smaaPass.enabled = s.get('aa');
    this.gradePass.enabled = s.get('grade');
    if (this.gtaoPass.updateGtaoMaterial) {
      this.gtaoPass.updateGtaoMaterial({ samples: s.get('gtaoSamples') || 16 });
    }
  }

  /** Suppression amount 0..1 — driven by nearby enemy fire. */
  setSuppression(v) {
    this.gradePass.material.uniforms.uSuppress.value = v;
  }

  render(dt, exposure) {
    this._time += dt;
    this.gradePass.material.uniforms.uTime.value = this._time;
    if (exposure !== undefined) {
      this._exposureTarget = exposure;
      this.gradePass.material.uniforms.uExposure.value = exposure;
    }
    this.composer.render(dt);
  }
}
