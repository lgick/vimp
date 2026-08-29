// ЗАМОРОЖЕНО. Снимок плагина 2026-08-29 (поколение engineApi: 4).
// Не править: правка фикстуры маскирует слом совместимости.
import FakeGameCore from './fakeCore.js';
import gameConfig from '../config/game.js';
import authSchema from '../config/auth.js';
import clientConfig from '../config/client.js';
import systemMessages from './systemMessages.js';
import spawnCommand from './spawnCommand.js';
import createModules from './createModules.js';

// HostPlugin миниигры-фикстуры (Этап 7 плана отделения движка, PLAN.md
// §3.2): доказывает, что HostGame и движковая мета работают с любым
// HostPlugin, реализующим контракт — не только с @vimp-games/tanks. createCore
// не грузит WASM (fake-core — обычный JS-класс), поэтому фикстура не
// требует собранного Rust-ядра игры.
export default {
  id: 'gen-api4',
  engineApi: 4,

  async createCore(coreConfigJson) {
    return new FakeGameCore(coreConfigJson);
  },

  gameConfig,
  authSchema,
  chatCommands: [spawnCommand],
  systemMessages,
  createModules,
  buildClientGameConfig: () => clientConfig,
};
