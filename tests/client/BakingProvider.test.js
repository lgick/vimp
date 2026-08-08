import { describe, it, expect, vi } from 'vitest';
import BakingProvider from '../../packages/engine/src/client/providers/BakingProvider.js';

const app = { renderer: {} };

const makeTexture = () => ({ destroy: vi.fn() });

describe('BakingProvider.bakeAll', () => {
  it('раскладывает запечённые ассеты по компонентам', () => {
    const texture = makeTexture();
    const provider = new BakingProvider({ tank: () => texture });

    provider.bakeAll([{ name: 'tank', component: 'Tank', params: {} }], app);

    expect(provider.getAssetsCollection().get('Tank')).toEqual({
      tank: texture,
    });
  });

  it('перепечка уничтожает прежние текстуры (включая вложенные)', () => {
    const first = { live: makeTexture(), frames: [makeTexture()] };
    const second = { live: makeTexture(), frames: [makeTexture()] };
    let next = first;
    const provider = new BakingProvider({ tank: () => next });
    const arr = [{ name: 'tank', component: 'Tank', params: {} }];

    provider.bakeAll(arr, app);

    next = second;
    provider.bakeAll(arr, app);

    expect(first.live.destroy).toHaveBeenCalledWith(true);
    expect(first.frames[0].destroy).toHaveBeenCalledWith(true);
    expect(second.live.destroy).not.toHaveBeenCalled();
    expect(provider.getAssetsCollection().get('Tank').tank).toBe(second);
  });

  it('переживает мёртвые после потери контекста текстуры', () => {
    const dead = {
      destroy: () => {
        throw new Error('context lost');
      },
    };
    let next = dead;
    const provider = new BakingProvider({ tank: () => next });
    const arr = [{ name: 'tank', component: 'Tank', params: {} }];

    provider.bakeAll(arr, app);
    next = makeTexture();

    expect(() => provider.bakeAll(arr, app)).not.toThrow();
  });
});
