/**
 * Menu.js — front end, pause screen, settings, controls and stats.
 *
 * Every control is bound to the Settings object, so changes apply live and
 * persist to localStorage. The menu only ever talks to the game through the
 * callbacks passed in by main.js.
 */

import { clamp } from '../core/Utils.js';

const KEYMAP = [
  ['Move', 'W A S D'], ['Sprint', 'Shift (hold)'], ['Crouch', 'Ctrl / C'],
  ['Jump', 'Space'], ['Fire', 'Left mouse'], ['Aim down sights', 'Right mouse'],
  ['Reload', 'R'], ['Melee / inspect', 'Q / B'], ['Grenade', 'G'],
  ['Medkit', 'H'], ['Interact / pickup', 'F'], ['Fire mode', 'V'],
  ['Weapons', '1 2 3 · mouse wheel'], ['Pause', 'Esc'],
];

export class Menu {
  constructor(settings, audio, callbacks) {
    this.settings = settings;
    this.audio = audio;
    this.cb = callbacks;
    this.screens = {
      menu: document.getElementById('screen-menu'),
      pause: document.getElementById('screen-pause'),
      dead: document.getElementById('screen-dead'),
      settings: document.getElementById('screen-settings'),
      controls: document.getElementById('screen-controls'),
      stats: document.getElementById('screen-stats'),
    };
    this.current = 'menu';
    this._settingsReturn = 'menu';
    this.bind();
    this.syncControls();
    this.buildKeymap();
  }

  /* ----------------------------------------------------------- visibility */

  show(name) {
    for (const [k, el] of Object.entries(this.screens)) el.classList.toggle('on', k === name);
    this.current = name;
    document.getElementById('lock-overlay').classList.remove('on');
  }
  hideAll() {
    for (const el of Object.values(this.screens)) el.classList.remove('on');
    this.current = null;
  }
  get isOpen() { return !!this.current; }

  bind() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => { this.audio?.play('ui'); fn(); });
    };

    on('btn-play', () => this.cb.onStart?.('survival'));
    on('btn-range', () => this.cb.onStart?.('range'));
    on('btn-settings', () => { this._settingsReturn = 'menu'; this.show('settings'); });
    on('btn-controls', () => this.show('controls'));
    on('btn-stats', () => { this.updateStats(); this.show('stats'); });
    on('btn-controls-back', () => this.show('menu'));
    on('btn-settings-back', () => this.show(this._settingsReturn || 'menu'));
    on('btn-stats-back', () => this.show('menu'));
    on('btn-settings-reset', () => {
      this.settings.reset();
      this.syncControls();
      this.cb.onSettingsChanged?.(true);
    });
    on('btn-resume', () => this.cb.onResume?.());
    on('btn-pause-settings', () => { this._settingsReturn = 'pause'; this.show('settings'); });
    on('btn-restart', () => this.cb.onRestart?.());
    on('btn-quit', () => this.cb.onQuit?.());
    on('btn-redeploy', () => this.cb.onRestart?.());
    on('btn-dead-menu', () => this.cb.onQuit?.());

    /* ---- sliders ------------------------------------------------------- */
    const slider = (id, key, fmt = (v) => v, after = null) => {
      const el = document.getElementById(id);
      const val = document.getElementById(`v-${id.slice(2)}`);
      if (!el) return;
      el.value = this.settings.get(key);
      if (val) val.textContent = fmt(this.settings.get(key));
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        this.settings.set(key, v);
        if (val) val.textContent = fmt(v);
        after?.(v);
      });
    };
    slider('s-res', 'renderScale', (v) => `${v}%`, () => this.cb.onSettingsChanged?.());
    slider('s-fov', 'fov', (v) => `${v}°`, (v) => this.cb.onFov?.(v));
    slider('s-sens', 'sensitivity', (v) => `${v}`);
    slider('s-adssens', 'adsSensMultiplier', (v) => `${v}%`);
    slider('s-smooth', 'smoothing', (v) => String(v), (v) => this.cb.onSmoothing?.(v / 100));
    slider('s-vol', 'volume', (v) => `${v}%`, () => this.audio?.applySettings());
    slider('s-volsfx', 'volSfx', (v) => `${v}%`, () => this.audio?.applySettings());
    slider('s-volamb', 'volAmb', (v) => `${v}%`, () => this.audio?.applySettings());

    /* ---- switches ------------------------------------------------------ */
    const sw = (id, key, extra = null) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = !!this.settings.get(key);
      el.addEventListener('change', () => {
        this.settings.set(key, el.checked);
        this.audio?.play('ui');
        extra?.(el.checked);
        this.cb.onSettingsChanged?.();
      });
    };
    sw('s-ao', 'ao'); sw('s-bloom', 'bloom'); sw('s-aa', 'aa'); sw('s-grade', 'grade');
    sw('s-bob', 'bob'); sw('s-sway', 'sway'); sw('s-gore', 'gore');
    sw('s-invert', 'invertY');

    /* ---- segmented ------------------------------------------------------ */
    const seg = (id, key, after = null) => {
      const wrap = document.getElementById(id);
      if (!wrap) return;
      const sync = () => {
        for (const b of wrap.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(this.settings.get(key)));
      };
      for (const b of wrap.querySelectorAll('button')) {
        b.addEventListener('click', () => {
          this.settings.set(key, b.dataset.v);
          sync(); this.audio?.play('ui');
          after?.(b.dataset.v);
          this.cb.onSettingsChanged?.();
        });
      }
      sync();
      return sync;
    };
    seg('seg-quality', 'quality', (v) => this.cb.onQuality?.(v));
    seg('seg-shadows', 'shadows');
    seg('seg-adsmode', 'adsMode');
    seg('seg-sprint', 'sprintMode');
    this._syncFns = {
      quality: () => seg('seg-quality', 'quality'),
    };

    const xhair = document.getElementById('s-xhair');
    if (xhair) {
      xhair.value = this.settings.get('crosshair');
      xhair.addEventListener('change', () => {
        this.settings.set('crosshair', xhair.value);
        this.cb.onCrosshair?.();
      });
    }
  }

  /** Reflect the settings object back into the DOM (after reset / preset). */
  syncControls() {
    const s = this.settings;
    const setVal = (id, key, fmt = (v) => v) => {
      const el = document.getElementById(id);
      const val = document.getElementById(`v-${id.slice(2)}`);
      if (el) el.value = s.get(key);
      if (val) val.textContent = fmt(s.get(key));
    };
    setVal('s-res', 'renderScale', (v) => `${v}%`);
    setVal('s-fov', 'fov', (v) => `${v}°`);
    setVal('s-sens', 'sensitivity');
    setVal('s-adssens', 'adsSensMultiplier', (v) => `${v}%`);
    setVal('s-smooth', 'smoothing');
    setVal('s-vol', 'volume', (v) => `${v}%`);
    setVal('s-volsfx', 'volSfx', (v) => `${v}%`);
    setVal('s-volamb', 'volAmb', (v) => `${v}%`);

    for (const [id, key] of [['s-ao', 'ao'], ['s-bloom', 'bloom'], ['s-aa', 'aa'], ['s-grade', 'grade'],
      ['s-bob', 'bob'], ['s-sway', 'sway'], ['s-gore', 'gore'], ['s-invert', 'invertY']]) {
      const el = document.getElementById(id);
      if (el) el.checked = !!this.settings.get(key);
    }
    for (const [id, key] of [['seg-quality', 'quality'], ['seg-shadows', 'shadows'],
      ['seg-adsmode', 'adsMode'], ['seg-sprint', 'sprintMode']]) {
      const wrap = document.getElementById(id);
      if (!wrap) continue;
      for (const b of wrap.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(this.settings.get(key)));
    }
    const xh = document.getElementById('s-xhair');
    if (xh) xh.value = this.settings.get('crosshair');
  }

  buildKeymap() {
    const wrap = document.getElementById('keymap');
    if (!wrap) return;
    wrap.innerHTML = KEYMAP.map(([k, v]) => `<div class="km"><span>${k}</span><span><kbd>${v}</kbd></span></div>`).join('');
  }

  updateStats() {
    const s = this.cb.getStats?.() || {};
    const grid = document.getElementById('stats-grid');
    if (!grid) return;
    const acc = s.shotsFired ? (s.shotsHit / s.shotsFired) * 100 : 0;
    const hs = s.kills ? (s.headshots / s.kills) * 100 : 0;
    const items = [
      ['FPS', (s.fps || 0).toFixed(0)],
      ['Kills', s.kills ?? 0],
      ['Headshots', `${hs.toFixed(0)}%`],
      ['Accuracy', `${acc.toFixed(1)}%`],
      ['Shots fired', s.shotsFired ?? 0],
      ['Damage dealt', Math.round(s.damageDealt ?? 0)],
      ['Distance', `${(s.distance ?? 0).toFixed(0)} m`],
      ['Wave', s.wave ?? 0],
    ];
    grid.innerHTML = items.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  }

  /** Fill and show the KIA screen. */
  showDeath(stats) {
    const acc = stats.shotsFired ? (stats.shotsHit / stats.shotsFired) * 100 : 0;
    const hs = stats.kills ? (stats.headshots / stats.kills) * 100 : 0;
    document.getElementById('dead-wave').textContent = stats.wave ?? 1;
    document.getElementById('dead-kills').textContent = stats.kills ?? 0;
    document.getElementById('dead-score').textContent = stats.score ?? 0;
    document.getElementById('dead-acc').textContent = `${acc.toFixed(0)}%`;
    document.getElementById('dead-hs').textContent = `${hs.toFixed(0)}%`;
    document.getElementById('dead-time').textContent = stats.timeLabel ?? '0:00';
    document.getElementById('pause-sub').textContent = 'Operation in progress';
    this.show('dead');
  }
}
