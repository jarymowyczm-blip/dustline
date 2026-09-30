/**
 * Settings.js — persisted player options.
 *
 * Every value lives in one flat object so it can be serialised to localStorage,
 * merged with a quality preset, and read from anywhere without plumbing.
 * `on()` subscribers are notified whenever a key changes, which is how the
 * engine reacts to graphics changes live (no reload required).
 */

const KEY = 'dustline.settings.v1';

export const QUALITY_PRESETS = {
  low: {
    renderScale: 75, shadows: 'off', ao: false, bloom: false, aa: false,
    grade: true, pixelRatioCap: 1, envResolution: 128, gtaoSamples: 8,
    reflProbe: 64, particleBudget: 0.5, decalBudget: 40, foliageDensity: 0.35,
  },
  medium: {
    renderScale: 90, shadows: 'medium', ao: true, bloom: true, aa: true,
    grade: true, pixelRatioCap: 1, envResolution: 256, gtaoSamples: 12,
    reflProbe: 128, particleBudget: 0.75, decalBudget: 80, foliageDensity: 0.7,
  },
  high: {
    renderScale: 100, shadows: 'high', ao: true, bloom: true, aa: true,
    grade: true, pixelRatioCap: 2, envResolution: 512, gtaoSamples: 16,
    reflProbe: 256, particleBudget: 1, decalBudget: 140, foliageDensity: 1,
  },
  ultra: {
    renderScale: 115, shadows: 'high', ao: true, bloom: true, aa: true,
    grade: true, pixelRatioCap: 2, envResolution: 1024, gtaoSamples: 24,
    reflProbe: 512, particleBudget: 1.4, decalBudget: 220, foliageDensity: 1.25,
  },
};

export const DEFAULTS = {
  // graphics
  quality: 'high',
  renderScale: 100,
  fov: 90,
  shadows: 'high',
  ao: true,
  bloom: true,
  aa: true,
  grade: true,
  bob: true,
  sway: true,
  gore: true,
  envResolution: 512,
  gtaoSamples: 16,
  pixelRatioCap: 2,
  particleBudget: 1,
  decalBudget: 140,
  foliageDensity: 1,

  // input / aim
  sensitivity: 38,        // 1..200 → cm/360 style scale (§ see Player for mapping)
  adsSensMultiplier: 80,  // percent
  smoothing: 0,
  invertY: false,
  adsMode: 'hold',        // hold | toggle
  sprintMode: 'hold',     // hold | toggle
  crosshair: 'white',

  // audio
  volume: 80,
  volSfx: 100,
  volAmb: 70,
};

const GRAPHIC_KEYS = ['quality', 'renderScale', 'fov', 'shadows', 'ao', 'bloom', 'aa',
  'grade', 'bob', 'sway', 'gore', 'envResolution', 'gtaoSamples', 'pixelRatioCap',
  'particleBudget', 'decalBudget', 'foliageDensity'];

export class Settings {
  constructor() {
    this.data = { ...DEFAULTS };
    this._subs = new Set();
    this.load();

    // Applying a preset copies its graphics fields into the active settings.
    if (QUALITY_PRESETS[this.data.quality]) {
      this.data = { ...this.data, ...QUALITY_PRESETS[this.data.quality] };
    }
  }

  get(k) { return this.data[k]; }
  set(k, v) {
    if (this.data[k] === v) return;
    const prev = this.data[k];
    this.data[k] = v;
    this.save();
    this._subs.forEach((fn) => fn(k, v, prev));
  }

  /** Apply a named quality preset (keeps input/audio preferences untouched). */
  applyQuality(name) {
    const p = QUALITY_PRESETS[name];
    if (!p) return;
    this.data.quality = name;
    Object.assign(this.data, p);
    this.save();
    GRAPHIC_KEYS.forEach((k) => this._subs.forEach((fn) => fn(k, this.data[k])));
  }

  on(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch { /* ignore corrupt storage */ }
  }

  reset() {
    Object.assign(this.data, DEFAULTS);
    Object.assign(this.data, QUALITY_PRESETS[this.data.quality] || {});
    this.save();
    GRAPHIC_KEYS.forEach((k) => this._subs.forEach((fn) => fn(k, this.data[k])));
  }
}
