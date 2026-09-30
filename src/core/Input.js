/**
 * Input.js — pointer-lock mouse look + keyboard state.
 *
 * Mouse deltas are accumulated between frames and consumed by the Player so
 * look-feel stays frame-rate independent and can be smoothed/slope-limited.
 * Keys are tracked as a held-set plus edge events (pressed/released) which the
 * gameplay code polls, avoiding callback spaghetti.
 */

const KEY_ALIASES = {
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', CapsLock: 'sprintToggle',
  ControlLeft: 'crouch', ControlRight: 'crouch', KeyC: 'crouch',
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  KeyR: 'reload', KeyF: 'interact', KeyG: 'grenade', KeyQ: 'melee',
  KeyH: 'medkit', KeyE: 'use', KeyV: 'firemode', KeyB: 'inspect',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4',
  Wheel1: 'slot1', Wheel2: 'slot2', Wheel3: 'slot3',
  KeyM: 'map', KeyN: 'nightvision', KeyL: 'laser',
  ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  Tab: 'scoreboard', Backslash: 'debug',
};

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.held = new Set();
    this.pressed = new Set();     // edge: went down this frame
    this.released = new Set();    // edge: went up this frame
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = new Set();
    this.buttonsPressed = new Set();
    this.buttonsReleased = new Set();
    this.locked = false;
    this.enabled = true;
    this.sensitivityScale = 1;
    this._smoothing = 0;
    this._smoothX = 0;
    this._smoothY = 0;
    this._listeners = { lock: [], unlock: [] };
    this._bind();
  }

  on(evt, fn) { this._listeners[evt]?.push(fn); return () => {
    const a = this._listeners[evt]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }; }

  _emit(evt, arg) { this._listeners[evt]?.forEach((f) => f(arg)); }

  setSmoothing(v) { this._smoothing = Math.max(0, Math.min(0.85, v)); }

  /** True while the key is held. */
  key(name) { return this.held.has(name); }
  /** True on the frame the key went down. */
  down(name) { return this.pressed.has(name); }
  /** True on the frame the key went up. */
  up(name) { return this.released.has(name); }
  mouseDown(btn = 0) { return this.buttons.has(btn); }
  mousePressed(btn = 0) { return this.buttonsPressed.has(btn); }
  mouseReleased(btn = 0) { return this.buttonsReleased.has(btn); }

  requestLock() {
    if (!this.locked && this.dom.requestPointerLock) {
      const p = this.dom.requestPointerLock({ unadjustedMovement: true });
      // Chrome returns a promise; Safari/Firefox return undefined or throw.
      if (p && p.catch) p.catch(() => { try { this.dom.requestPointerLock(); } catch { /* noop */ } });
    }
  }
  exitLock() { if (document.exitPointerLock) document.exitPointerLock(); }

  /** Clear per-frame edge state. Call once at the end of every frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed.clear();
    this.buttonsReleased.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F5' || (e.ctrlKey && e.code === 'KeyR')) return; // let dev reloads through
      const map = KEY_ALIASES[e.code];
      if (!map) return;
      if (['jump', 'scoreboard', 'map'].includes(map) || map === 'sprintToggle' || map === 'crouch') e.preventDefault();
      if (!this.enabled && map !== 'jump') return;
      if (!this.held.has(map)) this.pressed.add(map);
      this.held.add(map);
    });

    window.addEventListener('keyup', (e) => {
      const map = KEY_ALIASES[e.code];
      if (!map) return;
      this.held.delete(map);
      this.released.add(map);
    });

    // Keys are dropped if focus is lost so the player never "sticks" running.
    window.addEventListener('blur', () => { this.held.clear(); this.buttons.clear(); });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      let dx = e.movementX || 0;
      let dy = e.movementY || 0;
      if (this._smoothing > 0) {
        this._smoothX += (dx - this._smoothX) * (1 - this._smoothing);
        this._smoothY += (dy - this._smoothY) * (1 - this._smoothing);
        dx = this._smoothX; dy = this._smoothY;
      }
      this.mouse.dx += dx * this.sensitivityScale;
      this.mouse.dy += dy * this.sensitivityScale;
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.locked) { this.requestLock(); return; }
      if (this.buttons.has(e.button)) return;
      this.buttons.add(e.button);
      this.buttonsPressed.add(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons.delete(e.button);
      this.buttonsReleased.add(e.button);
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom ||
                    document.pointerLockElement?.contains?.(this.dom) === true;
      if (this.locked) { this._emit('lock'); }
      else { this.held.clear(); this.buttons.clear(); this._emit('unlock'); }
    });
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      this._emit('unlock');
    });
  }
}
