/**
 * main.js — bootstrap.
 *
 * Load order matters: renderer → procedural materials (the slow part, with a
 * progress bar) → world → UI → loop. The game is playable the instant the
 * loading screen fades, and every system is driven from one place so the frame
 * order is explicit.
 */

import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Settings } from './core/Settings.js';
import { TextureFactory } from './world/Textures.js';
import { AudioEngine } from './audio/Audio.js';
import { Game } from './game/Game.js';
import { Menu } from './ui/Menu.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ error trap - */
function showError(msg) {
  const box = $('error-box');
  if (!box) return;
  box.style.display = 'block';
  box.textContent = String(msg).slice(0, 900);
  console.error(msg);
}
window.addEventListener('error', (e) => showError(e.message || e.error));
window.addEventListener('unhandledrejection', (e) => showError(e.reason?.message || String(e.reason)));

/* ------------------------------------------------------------------ boot - */
async function boot() {
  const settings = new Settings();
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  $('app').appendChild(canvas);

  const setProgress = (pct, text) => {
    const bar = $('loadbar')?.firstElementChild;
    if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
    const t = $('loadtext');
    if (t && text) t.textContent = text;
  };

  setProgress(0.02, 'creating renderer');
  await frame();
  const engine = new Engine(canvas, settings);

  // Context loss is usually a GPU hiccup — tell the player rather than freeze.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showError('WebGL context lost. Reload the page to continue (try lowering the quality preset).');
  });

  setProgress(0.05, 'baking procedural materials');
  await frame();
  const factory = new TextureFactory(engine.renderer);
  const quality = settings.get('quality');
  const materials = await factory.buildAll(
    (t, name) => setProgress(0.05 + t * 0.72, `baking materials · ${name}`),
    {
      texLarge: quality === 'low' || quality === 'medium' ? 512 : 1024,
      texMedium: quality === 'low' ? 256 : 512,
    },
  );

  setProgress(0.80, 'assembling outpost');
  await frame();
  const audio = new AudioEngine(settings);
  const game = new Game(engine, canvas, settings, materials, audio);

  setProgress(0.92, 'compiling shaders');
  await frame();
  // Warm the shader cache so the first seconds don't hitch.
  engine.renderer.compile(engine.scene, engine.camera);
  engine.renderer.compile(engine.scene, engine.viewmodelCamera);

  setProgress(1.0, 'ready');
  await frame();

  const input = new Input(canvas);
  input.setSmoothing(settings.get('smoothing') / 100);

  const menu = new Menu(settings, audio, {
    onStart: (mode) => {
      menu.hideAll();
      audio.init();
      audio.resume();
      game.start(mode);
      input.requestLock();
    },
    onResume: () => {
      menu.hideAll();
      game.paused = false;
      input.requestLock();
    },
    onRestart: () => {
      menu.hideAll();
      game.stop();
      game.start(game.mode);
      input.requestLock();
    },
    onQuit: () => {
      game.stop();
      game.paused = true;
      menu.show('menu');
    },
    onSettingsChanged: (structural = false) => {
      engine.applySettings();
      input.setSmoothing(settings.get('smoothing') / 100);
      game.environment.rebuildEnvironment();
      if (structural) menu.syncControls();
    },
    onQuality: (name) => {
      settings.applyQuality(name);
      engine.applySettings();
      game.environment.setShadowQuality(settings.get('shadows'));
      game.environment.rebuildEnvironment();
      menu.syncControls();
    },
    onFov: (fov) => engine.applyFov(fov),
    onSmoothing: (v) => input.setSmoothing(v),
    onCrosshair: () => game.hud.applyCrosshairColor(),
    getStats: () => game.stats,
  });
  game.menu = menu;

  /* ---- pointer lock lifecycle ---------------------------------------- */
  input.on('unlock', () => {
    if (!game.running || game.dead) return;
    game.paused = true;
    menu.show('pause');
  });
  input.on('lock', () => {
    $('lock-overlay').classList.remove('on');
    audio.resume();
  });

  const lockOverlay = $('lock-overlay');
  lockOverlay.addEventListener('click', () => {
    audio.init();
    audio.resume();
    input.requestLock();
  });
  canvas.addEventListener('mousedown', () => {
    if (game.running && !menu.isOpen && !input.locked) {
      audio.init(); audio.resume();
      input.requestLock();
    }
  });

  /* ---- pause key (ESC releases the pointer; this catches the menu case) - */
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (menu.current === 'settings' || menu.current === 'controls' || menu.current === 'stats') {
        menu.show('pause');
      } else if (menu.current === null && game.running && !game.dead) {
        game.paused = true;
        input.exitLock();
        menu.show('pause');
      }
    }
    if (e.code === 'KeyM' && menu.current === null && game.running) {
      game.hud.toast('Audio', 'Ambience and gunfire are fully procedural');
    }
  });

  /* ---------------------------------------------------------- main loop - */
  let last = performance.now();
  let acc = 0;
  let frames = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    const rawDt = (now - last) / 1000;
    last = now;
    // Guard against tab-switch spikes and cap the simulation step.
    const dt = Math.min(rawDt, 0.1);

    if (game.running && !game.paused) {
      game.update(dt, input);
    } else if (game.running) {
      // paused: keep particles and the world subtly alive so the menu breathes
      game.environment.update(dt * 0.25, game.camera, game.player.pos);
      game.particles.update(dt * 0.25, game.camera);
    } else {
      // main menu: slowly orbit the compound as a backdrop
      const t = now / 1000;
      const cam = game.camera;
      const r = 46 + Math.sin(t * 0.06) * 8;
      const a = t * 0.035;
      const y = 12 + Math.sin(t * 0.09) * 3.5;
      cam.position.set(Math.sin(a) * r, y, 20 + Math.cos(a) * r);
      cam.lookAt(6, 3, 6);
      game.environment.update(dt, cam, game.player.pos);
      game.particles.update(dt, cam);
      // keep the viewmodel camera in sync so nothing pops when the game starts
      engine.viewmodelCamera.position.copy(cam.position);
      engine.viewmodelCamera.quaternion.copy(cam.quaternion);
    }

    engine.render(dt);
    input.endFrame();

    frames++;
    acc += rawDt;
    if (acc > 1) { frames = 0; acc = 0; }
  }

  // Handy for debugging and for the automated smoke test:
  //   __DUSTLINE.game.start('survival') / .wave / .enemies.spawn(...)
  window.__DUSTLINE = { game, engine, settings, audio, input, materials, THREE };

  // give the loading state a frame to paint before the heavy world build
  await frame();
  $('loading').classList.add('hidden');
  setTimeout(() => $('loading')?.remove(), 700);
  menu.show('menu');

  requestAnimationFrame(loop);
}

function frame() { return new Promise((r) => requestAnimationFrame(r)); }

boot().catch((err) => showError(err?.stack || err?.message || err));
