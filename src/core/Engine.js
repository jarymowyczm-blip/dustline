/**
 * Engine.js — renderer, cameras, layers and quality management.
 *
 * Two cameras are used, exactly like most shipped shooters:
 *   • the world camera (user FOV, far plane at 900 m)
 *   • a separate viewmodel camera (narrow FOV, 1 cm near plane) so the weapon
 *     never intersects walls and keeps a slightly "compressed" look.
 * Objects on LAYER_VIEWMODEL are only visible to the viewmodel camera; lights
 * are enabled on both layers so the weapon receives the same sun and IBL.
 */

import * as THREE from 'three';
import { PostFX } from '../fx/PostFX.js';

export const LAYER_WORLD = 0;
export const LAYER_VIEWMODEL = 1;

export class Engine {
  constructor(canvas, settings) {
    this.settings = settings;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // SMAA handles edges after tonemapping
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });
    this.isWebGL2 = this.renderer.capabilities.isWebGL2 !== false;
    this.renderer.setClearColor(0x0b0d10, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Calibrated so a sunlit exterior sits around 0.75 luminance: the sun,
    // hemisphere fill and sky IBL in Environment.js are all balanced to this.
    this.renderer.toneMappingExposure = 0.75;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // ---- cameras ----------------------------------------------------------
    const fov = settings.get('fov');
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.06, 1200);
    this.camera.layers.enable(LAYER_WORLD);
    this.camera.layers.disable(LAYER_VIEWMODEL);

    this.viewmodelCamera = new THREE.PerspectiveCamera(52, 1, 0.01, 24);
    this.viewmodelCamera.layers.set(LAYER_VIEWMODEL);

    this.scene = new THREE.Scene();
    // The camera itself must be in the graph so its children (the weapon rig)
    // are traversed by the renderer.
    this.scene.add(this.viewmodelCamera);
    this.viewmodelScene = new THREE.Scene();
    this.viewmodelScene.matrixWorldAutoUpdate = true;

    // The viewmodel is lit through the same scene graph so we simply share it.
    // (Layered visibility keeps it out of the world camera's render.)
    this.viewmodelRoot = new THREE.Group();
    this.viewmodelRoot.name = 'viewmodelRoot';
    this.scene.add(this.viewmodelRoot);

    this.width = 1; this.height = 1;
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, settings);
    this.postfx.setViewmodel(this.scene, this.viewmodelCamera);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  get pixelRatio() {
    // Perf guard: 1440p+ screens with ultra settings would melt most laptops.
    const cap = this.settings.get('pixelRatioCap') || 1.5;
    return Math.min(window.devicePixelRatio || 1, cap);
  }

  resize() {
    const w = Math.max(320, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(240, this.canvas.clientHeight || window.innerHeight);
    const scale = (this.settings.get('renderScale') || 100) / 100;
    const dpr = this.pixelRatio * scale;

    this.width = w; this.height = h;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);

    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();

    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.postfx.setSize(buf.x, buf.y);
  }

  applyFov(fov) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  applySettings() {
    this.postfx.applySettings(this.settings);
    const sh = this.settings.get('shadows');
    this.renderer.shadowMap.enabled = sh !== 'off';
    this.renderer.shadowMap.needsUpdate = true;
    this.resize();
  }

  /** Push every light onto the viewmodel layer so the weapon is lit correctly. */
  shareLightsWithViewmodel() {
    this.scene.traverse((o) => {
      if (o.isLight) o.layers.enable(LAYER_VIEWMODEL);
    });
  }

  render(dt) {
    this.renderer.info.reset();
    this.postfx.render(dt, this.renderer.toneMappingExposure);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
