import { describe, it, expect, vi } from 'vitest';
import { createGameActivator } from '../../../packages/engine/src/client/lib/gameActivator.js';

const tanks = { id: 'tanks', title: 'Tanks' };
const snakes = { id: 'snakes', title: 'Snakes' };

function makeActivator(loadClientPlugin) {
  return createGameActivator({
    gamesById: new Map([
      ['tanks', tanks],
      ['snakes', snakes],
    ]),
    loadClientPlugin,
  });
}

describe('gameActivator.createGameActivator', () => {
  it('отдаёт манифест выбранной игры и её загруженный плагин', async () => {
    const plugin = { parts: {}, styles: '' };
    const activate = makeActivator(vi.fn().mockResolvedValue(plugin));

    await expect(activate('snakes')).resolves.toEqual({
      manifest: snakes,
      plugin,
    });
  });

  it('передаёт в загрузчик манифест именно этой игры', async () => {
    const loadClientPlugin = vi.fn().mockResolvedValue({});
    const activate = makeActivator(loadClientPlugin);

    await activate('tanks');

    expect(loadClientPlugin).toHaveBeenCalledWith(tanks);
  });

  it('бросает на неизвестной игре, не трогая загрузчик', async () => {
    const loadClientPlugin = vi.fn().mockResolvedValue({});
    const activate = makeActivator(loadClientPlugin);

    await expect(activate('chess')).rejects.toThrow('unknown game "chess"');
    expect(loadClientPlugin).not.toHaveBeenCalled();
  });

  it('грузит плагин одной игры только один раз', async () => {
    const loadClientPlugin = vi.fn().mockResolvedValue({});
    const activate = makeActivator(loadClientPlugin);

    await activate('tanks');
    await activate('snakes');
    await activate('tanks');

    expect(loadClientPlugin).toHaveBeenCalledTimes(2);
  });

  it('параллельные вызовы дают один импорт', async () => {
    const loadClientPlugin = vi.fn().mockResolvedValue({});
    const activate = makeActivator(loadClientPlugin);

    await Promise.all([activate('tanks'), activate('tanks')]);

    expect(loadClientPlugin).toHaveBeenCalledTimes(1);
  });

  it('две версии одной игры дают два разных плагина (master-game-registry)', async () => {
    const v1 = { parts: { a: 1 } };
    const v2 = { parts: { a: 2 } };
    const loadClientPlugin = vi.fn().mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);
    const gamesById = new Map([['tanks', { id: 'tanks', version: 'hash-1' }]]);
    const activate = createGameActivator({ gamesById, loadClientPlugin });

    await expect(activate('tanks')).resolves.toMatchObject({ plugin: v1 });

    // админ переключился на застейдженную версию: манифест той же игры, но
    // другой хеш бандла — кеш обязан промахнуться
    gamesById.set('tanks', { id: 'tanks', version: 'hash-2' });

    await expect(activate('tanks')).resolves.toMatchObject({ plugin: v2 });
    expect(loadClientPlugin).toHaveBeenCalledTimes(2);
  });

  it('повторный вызов с той же версией не грузит второй раз', async () => {
    const loadClientPlugin = vi.fn().mockResolvedValue({});
    const gamesById = new Map([['tanks', { id: 'tanks', version: 'hash-1' }]]);
    const activate = createGameActivator({ gamesById, loadClientPlugin });

    await activate('tanks');
    await activate('tanks');

    expect(loadClientPlugin).toHaveBeenCalledTimes(1);
  });

  it('отказ вычищается по версионному ключу', async () => {
    const loadClientPlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ parts: {} });
    const gamesById = new Map([['tanks', { id: 'tanks', version: 'hash-1' }]]);
    const activate = createGameActivator({ gamesById, loadClientPlugin });

    await expect(activate('tanks')).rejects.toThrow('network');
    await expect(activate('tanks')).resolves.toMatchObject({ manifest: { version: 'hash-1' } });
    expect(loadClientPlugin).toHaveBeenCalledTimes(2);
  });

  it('не кеширует отказ — следующий вызов пробует снова', async () => {
    const plugin = { parts: {} };
    const loadClientPlugin = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(plugin);
    const activate = makeActivator(loadClientPlugin);

    await expect(activate('tanks')).rejects.toThrow('network');

    const result = await activate('tanks');

    expect(result.plugin).toBe(plugin);
    expect(loadClientPlugin).toHaveBeenCalledTimes(2);
  });
});
