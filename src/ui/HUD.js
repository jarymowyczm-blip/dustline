/**
 * HUD.js — the in-game heads-up display.
 *
 * DOM-based rather than canvas: text stays crisp at any resolution and CSS
 * handles the animation, so all this class does is push state into cached
 * elements once per frame.
 */

import { clamp, clamp01, damp, lerp, RAD } from '../core/Utils.js';

const XHAIR_COLORS = {
  white: 'rgba(240,245,235,0.92)',
  green: 'rgba(150,255,120,0.95)',
  cyan: 'rgba(120,240,255,0.95)',
  magenta: 'rgba(255,130,220,0.95)',
  amber: 'rgba(255,190,90,0.95)',
};

export class HUD {
  constructor(settings) {
    this.settings = settings;
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'),
      healthNum: $('health-num'), healthBar: document.querySelector('#health-bar > i'),
      healthBlock: $('health-block'), staminaBar: document.querySelector('#stamina-bar > i'),
      weaponName: $('weapon-name'), fireMode: $('fire-mode'),
      ammoMag: $('ammo-mag'), ammoRes: $('ammo-res'),
      reloadWrap: $('reload-progress'), reloadBar: document.querySelector('#reload-progress > i'),
      grenades: $('grenade-count'), medkits: $('medkit-count'),
      waveLine: $('wave-line'), enemyLine: $('enemy-line'), scoreLine: $('score-line'),
      compass: $('compass'), compassStrip: $('compass-strip'),
      killfeed: $('killfeed'), toasts: $('toasts'),
      dmgVignette: $('dmg-vignette'), lowhp: $('lowhp'), dmgDirs: $('dmg-dirs'),
      perf: $('perf'), prompt: $('prompt'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'),
    };

    this.lines = {
      up: document.querySelector('#crosshair [data-d=up]'),
      down: document.querySelector('#crosshair [data-d=down]'),
      left: document.querySelector('#crosshair [data-d=left]'),
      right: document.querySelector('#crosshair [data-d=right]'),
    };
    this.hm = [
      { el: this.el.hitmarker.children[0], rot: 45 },
      { el: this.el.hitmarker.children[1], rot: 135 },
      { el: this.el.hitmarker.children[2], rot: 225 },
      { el: this.el.hitmarker.children[3], rot: 315 },
    ];

    this.gap = 6;
    this.hitTimer = 0;
    this.vignette = 0;
    this.toastCount = 0;
    this.damageDirs = [];
    this.buildCompass();
    this.fpsSamples = [];
    this.applyCrosshairColor();
  }

  show() { this.el.hud.classList.add('on'); }
  hide() { this.el.hud.classList.remove('on'); }

  buildCompass() {
    const strip = this.el.compassStrip;
    strip.innerHTML = '';
    const pxPerDeg = 6;
    this.compassPxPerDeg = pxPerDeg;
    // -180..540 degrees so labels wrap smoothly
    for (let deg = -180; deg <= 540; deg += 5) {
      if (deg % 45 === 0) {
        const label = document.createElement('div');
        label.className = 'card';
        label.style.left = `${deg * pxPerDeg}px`;
        const heading = ((deg % 360) + 360) % 360;
        label.textContent = heading === 0 ? 'N' : heading === 90 ? 'E' : heading === 180 ? 'S'
          : heading === 270 ? 'W' : String(heading);
        strip.appendChild(label);
      }
      const tick = document.createElement('div');
      tick.className = `tick${deg % 15 === 0 ? ' major' : ''}`;
      tick.style.left = `${deg * pxPerDeg}px`;
      strip.appendChild(tick);
    }
  }

  applyCrosshairColor() {
    const c = XHAIR_COLORS[this.settings.get('crosshair')] || XHAIR_COLORS.white;
    for (const k of ['up', 'down', 'left', 'right']) if (this.lines[k]) this.lines[k].style.background = c;
  }

  /* ------------------------------------------------------------- updates - */

  update(dt, game) {
    const player = game.player;
    const weapon = game.weapon;

    /* ---- crosshair ---------------------------------------------------- */
    const w = weapon.getState();
    const ads = w.ads;
    const spreadPx = clamp(this.gap + w.spread * 3.4 + player.currentInaccuracy() * 320, 3, 42);
    this.gap = damp(this.gap, spreadPx, 14, dt);
    const len = lerp(7, 4, ads);
    const alpha = lerp(1, 0.14, clamp01(ads * 1.2));
    const thickness = 2;
    if (this.lines.up) {
      this.lines.up.style.cssText = `height:${len}px;width:${thickness}px;left:-${thickness / 2}px;top:${-this.gap - len}px;background:${XHAIR_COLORS[this.settings.get('crosshair')] || XHAIR_COLORS.white};opacity:${alpha}`;
      this.lines.down.style.cssText = `height:${len}px;width:${thickness}px;left:-${thickness / 2}px;top:${this.gap}px;background:${XHAIR_COLORS[this.settings.get('crosshair')] || XHAIR_COLORS.white};opacity:${alpha}`;
      this.lines.left.style.cssText = `width:${len}px;height:${thickness}px;top:-${thickness / 2}px;left:${-this.gap - len}px;background:${XHAIR_COLORS[this.settings.get('crosshair')] || XHAIR_COLORS.white};opacity:${alpha}`;
      this.lines.right.style.cssText = `width:${len}px;height:${thickness}px;top:-${thickness / 2}px;left:${this.gap}px;background:${XHAIR_COLORS[this.settings.get('crosshair')] || XHAIR_COLORS.white};opacity:${alpha}`;
    }

    /* ---- hitmarker ---------------------------------------------------- */
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      const t = clamp01(this.hitTimer / 0.22);
      const s = lerp(1.5, 0.7, t);
      for (const h of this.hm) {
        if (!h.el) continue;
        const r = h.rot * Math.PI / 180;
        const d = 9 * s;
        h.el.style.cssText = `transform: translate(${Math.cos(r) * d}px, ${Math.sin(r) * d}px) rotate(${h.rot}deg);opacity:${t}`;
        h.el.style.background = this.hitHeadshot ? '#ff5544' : '#ffffff';
        h.el.style.width = this.hitHeadshot ? '14px' : '10px';
      }
      this.el.hitmarker.style.opacity = 1;
    } else {
      this.el.hitmarker.style.opacity = 0;
    }

    /* ---- health + stamina --------------------------------------------- */
    const hp = Math.max(0, Math.round(player.health));
    this.el.healthNum.textContent = hp;
    this.el.healthBar.style.width = `${clamp01(player.health / player.maxHealth) * 100}%`;
    this.el.healthBlock.classList.toggle('low', player.health < 35);
    this.el.staminaBar.style.width = `${player.stamina}%`;
    const low = player.health < 35 && player.alive;
    this.el.lowhp.classList.toggle('on', low);

    /* ---- ammo ---------------------------------------------------------- */
    this.el.weaponName.textContent = w.name;
    this.el.fireMode.textContent = `${w.mode} · ${w.caliber}`;
    this.el.ammoMag.textContent = w.mag;
    this.el.ammoMag.classList.toggle('empty', w.mag <= 5);
    this.el.ammoRes.textContent = `/ ${w.reserve}`;
    if (w.reloading) {
      this.el.reloadWrap.style.opacity = 1;
      this.el.reloadBar.style.width = `${w.reloadProgress * 100}%`;
    } else {
      this.el.reloadWrap.style.opacity = 0;
      this.el.reloadBar.style.width = '0%';
    }
    this.el.grenades.textContent = w.grenades;
    this.el.medkits.textContent = w.medkits;

    /* ---- scoreboard ---------------------------------------------------- */
    this.el.waveLine.innerHTML = game.mode === 'range' ? 'Training <span>Range</span>' : `Wave <span>${game.wave}</span>`;
    this.el.enemyLine.textContent = game.mode === 'range'
      ? `Targets ${game.targetsRemaining}`
      : `Hostiles ${game.enemiesAlive}${game.intermission > 0 ? ` · next ${Math.ceil(game.intermission)}s` : ''}`;
    this.el.scoreLine.innerHTML = `Score <b>${game.score}</b> · Kills <b>${game.kills}</b>`;

    /* ---- compass ------------------------------------------------------- */
    const heading = ((-player.yaw * RAD) % 360 + 360) % 360;
    this.el.compassStrip.style.transform = `translateX(${-heading * this.compassPxPerDeg}px)`;

    /* ---- damage vignette ------------------------------------------------ */
    const dmgTarget = clamp01((100 - player.health) / 120) + player.suppression * 0.35;
    this.vignette = damp(this.vignette, player.alive ? dmgTarget : 1, 5, dt);
    this.el.dmgVignette.style.opacity = this.vignette * 0.9;

    /* ---- perf ---------------------------------------------------------- */
    this.fpsSamples.push(1 / Math.max(dt, 1e-4));
    if (this.fpsSamples.length > 45) this.fpsSamples.shift();
    if (!this._perfTimer || (this._perfTimer -= dt) <= 0) {
      this._perfTimer = 0.35;
      const fps = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
      const info = game.engine.renderer.info.render;
      this.el.perf.innerHTML = `<b>${fps.toFixed(0)}</b> FPS · ${(1000 / fps).toFixed(1)} ms<br>${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris`;
      game.stats.fps = fps;
    }
  }

  /* ------------------------------------------------------------- effects - */

  showHitmarker(headshot = false, kill = false) {
    this.hitTimer = kill ? 0.3 : 0.22;
    this.hitHeadshot = headshot;
  }

  damageDirection(fromPos, playerPos, camera) {
    const dx = fromPos.x - playerPos.x;
    const dz = fromPos.z - playerPos.z;
    const angleToSource = Math.atan2(dx, dz);
    // the indicator is a child of a 0x0 origin at screen centre, rotated
    const rel = angleToSource - (this._camYaw ?? 0);
    const el = document.createElement('div');
    el.className = 'dmg-dir';
    this.el.dmgDirs.appendChild(el);
    const deg = rel * RAD;
    this.damageDirs.push({ el, deg, life: 1.4 });
  }

  updateDamageDirs(dt, yaw) {
    for (let i = this.damageDirs.length - 1; i >= 0; i--) {
      const d = this.damageDirs[i];
      d.life -= dt;
      // the indicator sits above; rotate around the screen centre
      const deg = d.deg - yaw * RAD + 180;
      d.el.style.transform = `rotate(${deg}deg)`;
      d.el.style.opacity = clamp01(d.life / 1.4) * 0.9;
      if (d.life <= 0) { d.el.remove(); this.damageDirs.splice(i, 1); }
    }
  }

  flashDamage() {
    this.el.dmgVignette.style.opacity = 1;
    this.vignette = Math.max(this.vignette, 0.9);
  }

  killFeed(text, headshot = false, distance = null) {
    const div = document.createElement('div');
    div.className = 'kf';
    div.innerHTML = `${text}${headshot ? ' <span class="hs">HEADSHOT</span>' : ''}` +
      (distance !== null ? ` <span class="dist">${Math.round(distance)}m</span>` : '');
    this.el.killfeed.appendChild(div);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.removeChild(this.el.killfeed.firstChild);
    setTimeout(() => { div.style.transition = 'opacity .4s'; div.style.opacity = '0'; setTimeout(() => div.remove(), 420); }, 4200);
  }

  toast(text, sub = null) {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = text;
    this.el.toasts.appendChild(div);
    if (sub) {
      const s = document.createElement('div');
      s.className = 'toast sub';
      s.textContent = sub;
      this.el.toasts.appendChild(s);
      setTimeout(() => s.remove(), 2200);
    }
    setTimeout(() => div.remove(), 2200);
  }

  prompt(text) {
    if (text) {
      this.el.prompt.innerHTML = text;
      this.el.prompt.classList.add('on');
    } else {
      this.el.prompt.classList.remove('on');
    }
  }
}
