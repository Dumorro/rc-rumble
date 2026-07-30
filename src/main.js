import CONFIG from './core/Config.js';
import { Game, GameState } from './core/Game.js';

import { RenderSystem } from './render/RenderSystem.js';
import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { TrackSystem } from './track/TrackSystem.js';
import { CarSystem } from './vehicle/CarSystem.js';
import { RaceSystem } from './gameplay/RaceSystem.js';
import { PickupSystem } from './gameplay/PickupSystem.js';
import { FXSystem } from './fx/FXSystem.js';
import { CameraDirector } from './camera/CameraDirector.js';
import { AudioSystem } from './audio/AudioSystem.js';
import { UISystem } from './ui/UISystem.js';

const boot = document.getElementById('boot');
const bootBar = document.getElementById('boot-bar');
const bootMsg = document.getElementById('boot-msg');
const bootErr = document.getElementById('boot-err');

function progress(p, msg) {
  bootBar.style.width = `${Math.round(p * 100)}%`;
  if (msg) bootMsg.textContent = msg.replace(/System$|Director$|World$/, '').toLowerCase();
}

function fail(err) {
  console.error(err);
  bootMsg.textContent = 'failed to start';
  bootErr.textContent = `${err?.message ?? err}\n\n${(err?.stack ?? '').split('\n').slice(1, 5).join('\n')}`;
  boot.classList.remove('hidden');
}

async function main() {
  const container = document.getElementById('app');
  const uiRoot = document.getElementById('ui-root');

  const game = new Game(container, uiRoot);
  if (CONFIG.debug) globalThis.GAME = game;

  // Registration order == update order. See ARCHITECTURE.md.
  game.register('physics', new PhysicsWorld(game));
  game.register('trackSystem', new TrackSystem(game));
  game.register('carSystem', new CarSystem(game));
  game.register('race', new RaceSystem(game));
  game.register('pickups', new PickupSystem(game));
  game.register('fx', new FXSystem(game));
  game.register('audio', new AudioSystem(game));
  game.register('ui', new UISystem(game));
  game.register('cameraDirector', new CameraDirector(game));
  game.register('renderer', new RenderSystem(game));

  await game.initSystems(progress);

  progress(1, 'ready');
  boot.classList.add('hidden');
  setTimeout(() => { boot.style.display = 'none'; }, 600);

  game.start();

  if (CONFIG.startup.track || CONFIG.startup.skipMenu) {
    await game.loadRace({
      trackId: CONFIG.startup.track || 'toy_museum',
      carId: CONFIG.startup.car,
      laps: CONFIG.startup.laps,
      opponents: CONFIG.startup.opponents,
    });
  } else {
    game.setState(GameState.MENU);
  }
}

main().catch(fail);

window.addEventListener('error', (e) => { if (boot.style.display !== 'none') fail(e.error ?? e.message); });
window.addEventListener('unhandledrejection', (e) => { if (boot.style.display !== 'none') fail(e.reason); });
