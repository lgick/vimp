// ЗАМОРОЖЕНО. Снимок плагина 2026-08-29 (поколение engineApi: 3).
// Не править: правка фикстуры маскирует слом совместимости.
import FakeClientCore from './fakeClientCore.js';
import Actor from './parts/Actor.js';
import ActorRadar from './parts/ActorRadar.js';

// ClientPlugin миниигры-фикстуры (Этап 7 плана отделения движка, PLAN.md
// §3.3): минимальные заглушечные parts (без PixiJS) — доказывает, что
// gamePlugin.js/Factory работают с любым ClientPlugin, а не только с
// @vimp-games/tanks.
export default {
  id: 'gen-api3',
  engineApi: 3,

  async createClientCore(clientConfigJson) {
    return { core: new FakeClientCore(clientConfigJson), memory: null };
  },

  parts: { Actor, ActorRadar },
  bakers: {},
  styles: '',

  hooks: {
    onAuth(core, authData) {
      core.set_model?.(authData.model);
    },

    onPanel() {},

    onLocalAction(core, action, name, now) {
      if (action === 'down' && name === 'fire') {
        return core.try_fire?.(now) || null;
      }

      return null;
    },
  },
};
