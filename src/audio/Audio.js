/**
 * Audio.js — a fully procedural sound engine (no audio files).
 *
 * Everything is synthesised from noise bursts, filtered impulses and swept
 * oscillators, then pushed through a bus structure:
 *
 *   source → [sound shaping] → sfxBus ─┬→ master → compressor → out
 *                                      └→ reverb sends (2 generated IRs)
 *
 * Gunfire is modelled in layers — supersonic crack, body, low thump and a
 * reverb tail — and distant shots are delayed by real sonic travel time
 * (343 m/s) with distance-dependent air absorption, so a firefight across the
 * map sounds like it is happening 80 metres away instead of in your ear.
 */

import { clamp, clamp01, lerp, rand, randInt } from '../core/Utils.js';

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    this.lastPlay = new Map();
    this._pendingAmbience = true;
  }

  /** Must be called from a user gesture (pointer lock / click). */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.get('volume') / 100;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 7;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.22;
    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    // buses
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.settings.get('volSfx') / 100;
    this.sfx.connect(this.master);

    this.amb = ctx.createGain();
    this.amb.gain.value = (this.settings.get('volAmb') / 100) * 0.5;
    this.amb.connect(this.master);

    // noise source material
    this.noiseBuf = this._makeNoise(2.5);
    this.noiseBufShort = this._makeNoise(0.5);

    // reverbs: a tight interior and an open desert tail
    this.roomVerb = ctx.createConvolver();
    this.roomVerb.buffer = this._makeIR(0.55, 2.6);
    this.roomSend = ctx.createGain();
    this.roomSend.gain.value = 0.5;
    this.roomSend.connect(this.roomVerb);
    this.roomVerb.connect(this.master);

    this.openVerb = ctx.createConvolver();
    this.openVerb.buffer = this._makeIR(2.1, 1.7);
    this.openSend = ctx.createGain();
    this.openSend.gain.value = 0.75;
    this.openSend.connect(this.openVerb);
    this.openVerb.connect(this.master);

    this.ready = true;
    this.startAmbience();
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  applySettings() {
    if (!this.ctx) return;
    this.master.gain.value = this.settings.get('volume') / 100;
    this.sfx.gain.value = this.settings.get('volSfx') / 100;
    this.amb.gain.value = (this.settings.get('volAmb') / 100) * 0.5;
  }

  /* --------------------------------------------------------- generators - */

  _makeNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // slightly pink-ish noise reads better than pure white
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    return buf;
  }

  /** Exponentially decaying noise burst = serviceable reverb impulse. */
  _makeIR(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // early reflections then a diffuse tail
        let v = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        if (i < ctx.sampleRate * 0.06) v *= 0.4;
        d[i] = v;
      }
    }
    return buf;
  }

  /* ------------------------------------------------------------ plumbing - */

  _noiseSource(buf = this.noiseBuf, rate = 1, offset = null) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    s.loop = true;
    return s;
  }

  _env(gainNode, gain, attack, decay, when = 0, curve = 'exp') {
    const t = this.ctx.currentTime + when;
    const g = gainNode.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    if (attack > 0) g.linearRampToValueAtTime(gain, t + attack);
    else g.setValueAtTime(gain, t);
    if (curve === 'exp') g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    else g.linearRampToValueAtTime(0.0001, t + attack + decay);
    return t + attack + decay;
  }

  _filter(type, freq, q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    return f;
  }

  _gain(v = 1) { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  /**
   * Route a source chain to the master bus with distance handling.
   * @returns {{out:AudioNode, delay:number, wet:number}}
   */
  _place(dist = 0, opts = {}) {
    const speedOfSound = 343;
    const delay = opts.enemy ? clamp(dist / speedOfSound, 0, 1.6) : 0;
    const airAbsorb = clamp(Math.exp(-dist / (opts.enemy ? 55 : 400)), 0.12, 1);
    const atten = clamp(1 / (1 + dist * dist / 900), 0.02, 1);
    const lp = this._filter('lowpass', clamp(2000 + 16000 * airAbsorb, 700, 20000), 0.7);
    const out = this._gain(atten * (opts.gain ?? 1));
    lp.connect(out);
    return { out, input: lp, delay, wet: clamp01((opts.enemy ? 0.55 : 0.2) + dist / 120) };
  }

  _send(node, wet, distance = 0, open = true) {
    const send = this._gain(wet);
    node.connect(send);
    send.connect(open ? this.openSend : this.roomSend);
    return send;
  }

  /* --------------------------------------------------------------- shots - */

  /** Layered gunshot: crack + body + thump + tail. */
  playShot(kind, opts = {}) {
    const ctx = this.ctx;
    const dist = opts.distance || 0;
    const { out, input, delay, wet } = this._place(dist, { enemy: opts.enemy, gain: opts.enemy ? 0.75 : 1 });
    const t0 = ctx.currentTime + delay;
    out.connect(this.sfx);

    // --- parameters per calibre
    const P = kind === 'shot762' ? { crack: 1200, crackDecay: 0.075, bodyF: 780, bodyDecay: 0.30, thump: 96, thumpDecay: 0.22, dur: 0.05, level: 1.25 }
      : kind === 'shot9mm' ? { crack: 1500, crackDecay: 0.05, bodyF: 900, bodyDecay: 0.17, thump: 130, thumpDecay: 0.13, dur: 0.035, level: 0.85 }
        : { crack: 1350, crackDecay: 0.065, bodyF: 900, bodyDecay: 0.24, thump: 110, thumpDecay: 0.18, dur: 0.045, level: 1.0 };

    const ind = opts.wet ?? 0;

    // 1. supersonic crack — a very short bright transient
    {
      const src = this._noiseSource(this.noiseBufShort, rand(0.95, 1.05));
      const hp = this._filter('highpass', P.crack * (1 - ind * 0.35), 0.8);
      const pk = this._filter('peaking', 2600, 1.6);
      pk.gain.value = 7;
      const g = this._gain(0);
      src.connect(hp); hp.connect(pk); pk.connect(g); g.connect(input);
      src.start(t0);
      this._env(g, 0.9 * P.level, 0.0008, P.crackDecay, delay, 'exp');
      src.stop(t0 + P.crackDecay + 0.05);
    }
    // 2. body — the main report, a resonant low band
    {
      const src = this._noiseSource(this.noiseBuf, rand(0.9, 1.1));
      const lp = this._filter('lowpass', P.bodyF * (1 + ind * 0.5), 1.1);
      const bp = this._filter('bandpass', P.bodyF * 0.55, 0.9);
      const g = this._gain(0);
      src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(input);
      src.start(t0);
      this._env(g, 0.85 * P.level, 0.001, P.bodyDecay, delay, 'exp');
      src.stop(t0 + P.bodyDecay + 0.1);
    }
    // 3. muzzle thump — swept sine
    {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(P.thump * 2.1, t0);
      osc.frequency.exponentialRampToValueAtTime(P.thump * 0.55, t0 + P.thumpDecay);
      const g = this._gain(0);
      osc.connect(g); g.connect(input);
      osc.start(t0);
      this._env(g, 0.55 * P.level, 0.001, P.thumpDecay, delay, 'exp');
      osc.stop(t0 + P.thumpDecay + 0.05);
    }
    // 4. mechanical action noise
    {
      const src = this._noiseSource(this.noiseBufShort, rand(1.4, 1.8));
      const bp = this._filter('bandpass', 3200, 2.2);
      const g = this._gain(0);
      src.connect(bp); bp.connect(g); g.connect(input);
      src.start(t0 + 0.02);
      this._env(g, 0.16, 0.0006, 0.05, delay + 0.02, 'exp');
      src.stop(t0 + 0.12);
    }

    this._send(out, wet * 0.9, dist, true);
    if (ind > 0.2) this._send(out, 0.35 * ind, dist, false);
  }

  playImpact(kind, opts = {}) {
    const ctx = this.ctx;
    const dist = opts.distance || 0;
    const { out, input, delay } = this._place(dist, { enemy: false, gain: 0.55 });
    out.connect(this.sfx);
    const t0 = ctx.currentTime + delay;

    const cfg = {
      concrete: { f: 420, q: 0.9, type: 'lowpass', decay: 0.11, gain: 0.75, hiss: 0.5, hissF: 4200 },
      sand: { f: 300, q: 0.7, type: 'lowpass', decay: 0.09, gain: 0.5, hiss: 0.35, hissF: 2600 },
      metal: { f: 2100, q: 12, type: 'bandpass', decay: 0.5, gain: 0.85, hiss: 0.8, hissF: 6000, ring: 1450 },
      wood: { f: 780, q: 4, type: 'bandpass', decay: 0.16, gain: 0.7, hiss: 0.4, hissF: 3400 },
      glass: { f: 4800, q: 2, type: 'bandpass', decay: 0.35, gain: 0.7, hiss: 1.0, hissF: 8000 },
      cloth: { f: 380, q: 0.8, type: 'lowpass', decay: 0.07, gain: 0.4, hiss: 0.2, hissF: 2000 },
      flesh: { f: 520, q: 0.8, type: 'lowpass', decay: 0.14, gain: 0.7, hiss: 0.25, hissF: 1400 },
    }[kind] || { f: 420, q: 1, type: 'lowpass', decay: 0.1, gain: 0.6, hiss: 0.4, hissF: 4000 };

    {
      const src = this._noiseSource(this.noiseBufShort, rand(0.9, 1.15));
      const f = this._filter(cfg.type, cfg.f, cfg.q);
      const g = this._gain(0);
      src.connect(f); f.connect(g); g.connect(input);
      src.start(t0);
      this._env(g, cfg.gain, 0.0008, cfg.decay, delay, 'exp');
      src.stop(t0 + cfg.decay + 0.06);
    }
    {
      const src = this._noiseSource(this.noiseBufShort, rand(1.2, 1.6));
      const hp = this._filter('highpass', cfg.hissF, 0.8);
      const g = this._gain(0);
      src.connect(hp); hp.connect(g); g.connect(input);
      src.start(t0);
      this._env(g, 0.14 * cfg.hiss, 0.001, cfg.decay * 0.7, delay, 'exp');
      src.stop(t0 + cfg.decay + 0.05);
    }
    if (cfg.ring) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(cfg.ring, t0);
      osc.frequency.exponentialRampToValueAtTime(cfg.ring * 0.86, t0 + cfg.decay);
      const g = this._gain(0);
      osc.connect(g); g.connect(input);
      osc.start(t0);
      this._env(g, 0.16, 0.001, cfg.decay, delay, 'exp');
      osc.stop(t0 + cfg.decay + 0.05);
    }
    this._send(out, 0.35, dist, true);
  }

  playFootstep(opts = {}) {
    const surface = opts.surface || 'sand';
    const force = clamp01(opts.force ?? 0.6);
    const { out, input } = this._place(opts.pos ? 0 : 0, { gain: 0.5 });
    out.connect(this.sfx);
    const t0 = this.ctx.currentTime + rand(0, 0.012);
    const cfg = {
      sand: { f: 700, q: 0.8, type: 'lowpass', decay: 0.09, gain: 0.5, crunch: 0.35 },
      dirt: { f: 900, q: 0.9, type: 'lowpass', decay: 0.085, gain: 0.5, crunch: 0.4 },
      concrete: { f: 1700, q: 1.4, type: 'bandpass', decay: 0.06, gain: 0.42, crunch: 0.5 },
      metal: { f: 2300, q: 5, type: 'bandpass', decay: 0.22, gain: 0.5, crunch: 0.3, ring: 1750 },
      wood: { f: 640, q: 3, type: 'bandpass', decay: 0.11, gain: 0.5, crunch: 0.3 },
    }[surface] || { f: 900, q: 1, type: 'lowpass', decay: 0.08, gain: 0.45, crunch: 0.3 };

    const src = this._noiseSource(this.noiseBufShort, rand(0.85, 1.2));
    const f = this._filter(cfg.type, cfg.f * rand(0.92, 1.08), cfg.q);
    const g = this._gain(0);
    src.connect(f); f.connect(g); g.connect(input);
    src.start(t0);
    this._env(g, cfg.gain * (0.5 + force), 0.001, cfg.decay * rand(0.85, 1.2), 0, 'exp');
    src.stop(t0 + cfg.decay + 0.05);

    // grit / gear rustle
    const src2 = this._noiseSource(this.noiseBufShort, rand(1.6, 2.2));
    const hp = this._filter('highpass', 3000, 0.8);
    const g2 = this._gain(0);
    src2.connect(hp); hp.connect(g2); g2.connect(input);
    src2.start(t0);
    this._env(g2, 0.07 * cfg.crunch * (0.4 + force), 0.002, 0.07, 0, 'exp');
    src2.stop(t0 + 0.12);

    if (cfg.ring) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = cfg.ring * rand(0.95, 1.05);
      const rg = this._gain(0);
      osc.connect(rg); rg.connect(input);
      osc.start(t0);
      this._env(rg, 0.08, 0.001, 0.2, 0, 'exp');
      osc.stop(t0 + 0.25);
    }
    this._send(out, 0.22, 0, false);
  }

  /** Mechanical foley: mags, bolts, selectors, medkits. */
  playMech(kind) {
    const ctx = this.ctx;
    const out = this._gain(0.7);
    out.connect(this.sfx);
    this._send(out, 0.3, 0, false);
    const t0 = ctx.currentTime;

    const click = (freq, q, decay, gain, at = 0, type = 'bandpass') => {
      const src = this._noiseSource(this.noiseBufShort, rand(1.3, 1.9));
      const f = this._filter(type, freq, q);
      const g = this._gain(0);
      src.connect(f); f.connect(g); g.connect(out);
      src.start(t0 + at);
      this._env(g, gain, 0.0006, decay, at, 'exp');
      src.stop(t0 + at + decay + 0.05);
    };
    const tone = (freq, decay, gain, at = 0, type = 'triangle') => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0 + at);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t0 + at + decay);
      const g = this._gain(0);
      osc.connect(g); g.connect(out);
      osc.start(t0 + at);
      this._env(g, gain, 0.001, decay, at, 'exp');
      osc.stop(t0 + at + decay + 0.05);
    };

    switch (kind) {
      case 'magRelease': click(2600, 6, 0.06, 0.5); tone(1500, 0.05, 0.1); break;
      case 'magOut': click(1200, 3, 0.14, 0.45); tone(420, 0.12, 0.12); break;
      case 'magIn': click(900, 2.4, 0.16, 0.5); tone(300, 0.16, 0.16); break;
      case 'magTap': click(1800, 4, 0.09, 0.55, 0); click(2400, 5, 0.07, 0.4, 0.05); break;
      case 'boltBack': click(1100, 3, 0.09, 0.6); click(700, 2, 0.13, 0.5, 0.07); break;
      case 'boltRelease': click(1500, 4, 0.07, 0.65); tone(900, 0.09, 0.14, 0.01); break;
      case 'boltTap': click(2200, 5, 0.05, 0.4); break;
      case 'shoulderWeapon': click(600, 1.6, 0.12, 0.35); break;
      case 'selector': click(3200, 8, 0.04, 0.45); break;
      case 'dryFire': click(3000, 9, 0.03, 0.5); break;
      case 'drawRifle': click(800, 2, 0.14, 0.35, 0); click(1600, 3, 0.08, 0.3, 0.06); break;
      case 'drawPistol': click(1400, 4, 0.08, 0.35); break;
      case 'reloadStart': click(1500, 3, 0.1, 0.35); break;
      case 'reloadEnd': click(1900, 3, 0.09, 0.35); break;
      case 'medkit': {
        click(2600, 4, 0.08, 0.35);
        // cloth rustle
        const src = this._noiseSource(this.noiseBufShort, 0.7);
        const lp = this._filter('lowpass', 900, 0.8);
        const g = this._gain(0);
        src.connect(lp); lp.connect(g); g.connect(out);
        src.start(t0 + 0.05);
        this._env(g, 0.22, 0.06, 0.7, 0.05, 'lin');
        src.stop(t0 + 0.9);
        break;
      }
      case 'grenadeThrow': click(700, 2, 0.1, 0.4); click(1200, 3, 0.07, 0.3, 0.08); break;
      case 'grenadeBounce': click(1800, 5, 0.09, 0.5); tone(2400, 0.2, 0.15); break;
      default: click(1500, 3, 0.08, 0.4);
    }
  }

  playExplosion(opts = {}) {
    const ctx = this.ctx;
    const dist = opts.distance || 0;
    const { out, input, delay, wet } = this._place(dist, { enemy: !!opts.enemy, gain: 1.2 });
    out.connect(this.sfx);
    const t0 = ctx.currentTime + delay;

    // low sweep
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(32, t0 + 0.65);
    const og = this._gain(0);
    osc.connect(og); og.connect(input);
    osc.start(t0);
    this._env(og, 1.0, 0.004, 0.75, delay, 'exp');
    osc.stop(t0 + 0.9);

    // blast noise
    const src = this._noiseSource(this.noiseBuf, rand(0.85, 1.1));
    const lp = this._filter('lowpass', 1400, 0.9);
    const g = this._gain(0);
    src.connect(lp); lp.connect(g); g.connect(input);
    src.start(t0);
    this._env(g, 0.95, 0.003, 0.55, delay, 'exp');
    src.stop(t0 + 0.8);

    // debris hiss
    const src2 = this._noiseSource(this.noiseBuf, 1.4);
    const hp = this._filter('highpass', 2600, 0.7);
    const g2 = this._gain(0);
    src2.connect(hp); hp.connect(g2); g2.connect(input);
    src2.start(t0 + 0.03);
    this._env(g2, 0.16, 0.02, 1.1, delay + 0.03, 'exp');
    src2.stop(t0 + 1.4);

    this._send(out, Math.max(0.6, wet), dist, true);
  }

  /** Bullet snapping past your head. */
  playNearMiss(opts = {}) {
    const ctx = this.ctx;
    const out = this._gain(0.9);
    out.connect(this.sfx);
    this._send(out, 0.4, 0, true);
    const t0 = ctx.currentTime;
    const src = this._noiseSource(this.noiseBufShort, rand(1.1, 1.5));
    const hp = this._filter('highpass', 2600, 0.9);
    const g = this._gain(0);
    src.connect(hp); hp.connect(g); g.connect(out);
    src.start(t0);
    this._env(g, 0.5, 0.001, 0.07, 0, 'exp');
    src.stop(t0 + 0.15);
    // descending whistle
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(rand(2600, 3600), t0);
    osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.14);
    const og = this._gain(0);
    osc.connect(og); og.connect(out);
    osc.start(t0);
    this._env(og, 0.18, 0.001, 0.13, 0, 'exp');
    osc.stop(t0 + 0.2);
  }

  playPlayerHit() {
    const ctx = this.ctx;
    const out = this._gain(1.0);
    out.connect(this.sfx);
    const t0 = ctx.currentTime;
    // impact thud through the vest
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(60, t0 + 0.18);
    const og = this._gain(0);
    osc.connect(og); og.connect(out);
    osc.start(t0);
    this._env(og, 0.8, 0.002, 0.22, 0, 'exp');
    osc.stop(t0 + 0.3);

    const src = this._noiseSource(this.noiseBufShort, 0.8);
    const lp = this._filter('lowpass', 900, 0.8);
    const g = this._gain(0);
    src.connect(lp); lp.connect(g); g.connect(out);
    src.start(t0);
    this._env(g, 0.5, 0.001, 0.12, 0, 'exp');
    src.stop(t0 + 0.2);
    this._send(out, 0.3, 0, false);
  }

  playGrunt(kind = 'pain') {
    const ctx = this.ctx;
    const out = this._gain(0.5);
    out.connect(this.sfx);
    this._send(out, 0.5, 0, true);
    const t0 = ctx.currentTime;
    // Formant-ish vowel from a saw + bandpass pair, with a pitch bend.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = kind === 'death' ? rand(95, 120) : rand(110, 145);
    osc.frequency.setValueAtTime(base, t0);
    osc.frequency.linearRampToValueAtTime(base * (kind === 'death' ? 0.6 : 0.82), t0 + 0.45);

    const f1 = this._filter('bandpass', kind === 'death' ? 520 : 680, 6);
    const f2 = this._filter('bandpass', 1150, 9);
    const g = this._gain(0);
    osc.connect(f1); f1.connect(g);
    osc.connect(f2); f2.connect(g);
    g.connect(out);
    // rough up the tone with noise
    const src = this._noiseSource(this.noiseBufShort, 1.2);
    const nf = this._filter('bandpass', 1400, 2);
    const ng = this._gain(0);
    src.connect(nf); nf.connect(ng); ng.connect(g);
    osc.start(t0); src.start(t0);
    const dur = kind === 'death' ? 0.6 : 0.28;
    this._env(g, 0.5, 0.03, dur, 0, 'exp');
    osc.stop(t0 + dur + 0.1);
    src.stop(t0 + dur + 0.1);
  }

  /** UI ticks: hitmarker, headshot, kill confirm, low ammo. */
  playUI(kind) {
    const ctx = this.ctx;
    const out = this._gain(0.5);
    out.connect(this.sfx);
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = this._gain(0);
    osc.connect(g); g.connect(out);
    if (kind === 'hit') { osc.type = 'square'; osc.frequency.value = 1250; this._env(g, 0.18, 0.001, 0.045, 0, 'exp'); osc.start(t0); osc.stop(t0 + 0.08); }
    else if (kind === 'headshot') {
      osc.type = 'triangle'; osc.frequency.setValueAtTime(1900, t0); osc.frequency.exponentialRampToValueAtTime(2700, t0 + 0.09);
      this._env(g, 0.22, 0.001, 0.12, 0, 'exp'); osc.start(t0); osc.stop(t0 + 0.15);
    } else if (kind === 'kill') {
      osc.type = 'triangle'; osc.frequency.setValueAtTime(700, t0); osc.frequency.exponentialRampToValueAtTime(1150, t0 + 0.1);
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 1400;
      const g2 = this._gain(0); o2.connect(g2); g2.connect(out); o2.start(t0 + 0.06); this._env(g2, 0.14, 0.002, 0.12, 0.06, 'exp'); o2.stop(t0 + 0.3);
      this._env(g, 0.18, 0.002, 0.16, 0, 'exp'); osc.start(t0); osc.stop(t0 + 0.25);
    } else if (kind === 'lowAmmo') {
      osc.type = 'sine'; osc.frequency.value = 420; this._env(g, 0.2, 0.002, 0.12, 0, 'exp'); osc.start(t0); osc.stop(t0 + 0.2);
    } else {
      osc.type = 'sine'; osc.frequency.value = 880; this._env(g, 0.15, 0.002, 0.09, 0, 'exp'); osc.start(t0); osc.stop(t0 + 0.15);
    }
  }

  playDeath() {
    this.playGrunt('death');
    const ctx = this.ctx;
    const out = this._gain(0.7);
    out.connect(this.sfx);
    this._send(out, 0.8, 0, true);
    const t0 = ctx.currentTime + 0.05;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t0);
    osc.frequency.exponentialRampToValueAtTime(38, t0 + 1.2);
    const g = this._gain(0);
    osc.connect(g); g.connect(out);
    osc.start(t0);
    this._env(g, 0.5, 0.02, 1.4, 0.05, 'exp');
    osc.stop(t0 + 1.6);
  }

  /* ----------------------------------------------------------- ambience - */

  startAmbience() {
    const ctx = this.ctx;
    // Wind: filtered noise with a slowly modulated cutoff and gain.
    const src = this._noiseSource(this.noiseBuf, 0.55);
    const lp = this._filter('lowpass', 420, 0.6);
    const bp = this._filter('bandpass', 260, 0.5);
    const g = this._gain(0.16);
    src.connect(lp); lp.connect(bp); bp.connect(g); g.connect(this.amb);
    src.start();

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoGain = this._gain(220);
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
    lfo.start();

    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.031;
    const lfo2Gain = this._gain(0.06);
    lfo2.connect(lfo2Gain); lfo2Gain.connect(g.gain);
    lfo2.start();

    // Distant battle rumbles and far-off gunfire for atmosphere.
    const scheduleDistant = () => {
      if (!this.ctx) return;
      const t = rand(6, 22) * 1000;
      setTimeout(() => {
        if (!this.ctx || this.ctx.state === 'closed') return;
        if (Math.random() < 0.55) {
          const burst = randInt(2, 6);
          for (let i = 0; i < burst; i++) {
            setTimeout(() => this.playImpact('concrete', { distance: rand(120, 400) }), i * rand(60, 180));
          }
          this.playShot('shot762', { distance: rand(180, 520), enemy: true, gain: 0.35 });
        } else {
          this._distantRumble();
        }
        scheduleDistant();
      }, t);
    };
    scheduleDistant();
  }

  _distantRumble() {
    const ctx = this.ctx;
    const out = this._gain(0.5);
    out.connect(this.amb);
    this._send(out, 1.2, 0, true);
    const t0 = ctx.currentTime;
    const src = this._noiseSource(this.noiseBuf, 0.22);
    const lp = this._filter('lowpass', 160, 0.7);
    const g = this._gain(0);
    src.connect(lp); lp.connect(g); g.connect(out);
    src.start(t0);
    this._env(g, 0.6, 0.2, 2.2, 0, 'lin');
    src.stop(t0 + 2.6);
  }

  /* --------------------------------------------------------------- entry - */

  /**
   * @param {string} name
   * @param {object} opts { pos, distance, surface, enemy, ads, wet, force }
   */
  play(name, opts = {}) {
    if (!this.ready) return;
    // simple rate limiting per sound family
    const now = this.ctx.currentTime;
    const last = this.lastPlay.get(name) || -1;
    const min = { footstep: 0.12, impact_metal: 0.02, impact_concrete: 0.02, playerHit: 0.15 }[name] ?? 0.012;
    if (now - last < min && !name.startsWith('shot')) return;
    this.lastPlay.set(name, now);

    if (name.startsWith('shot')) return this.playShot(name, opts);
    if (name.startsWith('impact_')) return this.playImpact(name.slice(7), opts);

    switch (name) {
      case 'footstep': return this.playFootstep(opts);
      case 'land': return this.playFootstep({ ...opts, force: 1 });
      case 'jump': return this.playFootstep({ ...opts, force: 0.5 });
      case 'explosion': return this.playExplosion(opts);
      case 'nearMiss': return this.playNearMiss(opts);
      case 'playerHit': return this.playPlayerHit();
      case 'death': return this.playDeath();
      case 'grunt':
      case 'pain': return this.playGrunt('pain');
      case 'hitmarker': return this.playUI('hit');
      case 'headshot': return this.playUI('headshot');
      case 'kill': return this.playUI('kill');
      case 'lowAmmo': return this.playUI('lowAmmo');
      case 'ui': return this.playUI('ui');
      default: return this.playMech(name);
    }
  }
}
