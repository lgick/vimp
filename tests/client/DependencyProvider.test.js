import { describe, it, expect } from 'vitest';
import DependencyProvider from '../../packages/engine/src/client/providers/DependencyProvider.js';

// Пул сервисов клиента (main.js): renderer, soundManager и assetsBase —
// база ассетов активной игры. Последний важен тем, что это не объект, а
// строка: провайдер обязан переносить значение как есть, иначе part игры
// не сможет построить URL своих текстур (`${assetsBase}img/<file>`).

describe('DependencyProvider.collectAll', () => {
  it('переносит сервис-строку в объявивший её компонент', () => {
    const provider = new DependencyProvider();

    provider.collectAll(
      { assetsBase: '/games/tanks/' },
      { assetsBase: ['Map'] },
    );

    expect(provider.getDependenciesCollection().get('Map')).toEqual({
      assetsBase: '/games/tanks/',
    });
  });

  it('раздаёт один сервис нескольким компонентам и копит их в одном объекте', () => {
    const renderer = {};
    const provider = new DependencyProvider();

    provider.collectAll(
      { renderer, assetsBase: '/' },
      { renderer: ['Map'], assetsBase: ['Map', 'Backdrop'] },
    );

    const collection = provider.getDependenciesCollection();

    expect(collection.get('Map')).toEqual({ renderer, assetsBase: '/' });
    expect(collection.get('Backdrop')).toEqual({ assetsBase: '/' });
  });

  it('сервис, которого нет в пуле, молча пропускается', () => {
    const provider = new DependencyProvider();

    provider.collectAll({ renderer: {} }, { assetsBase: ['Map'] });

    expect(provider.getDependenciesCollection().has('Map')).toBe(false);
  });

  it('пустая карта зависимостей не создаёт записей', () => {
    const provider = new DependencyProvider();

    provider.collectAll({ assetsBase: '/' }, undefined);

    expect(provider.getDependenciesCollection().size).toBe(0);
  });

  // восстановление WebGL-контекста прогоняет сборку заново: остатки прошлого
  // прохода не должны пережить смену карты зависимостей
  it('повторный сбор очищает прежнюю коллекцию', () => {
    const provider = new DependencyProvider();

    provider.collectAll({ assetsBase: '/' }, { assetsBase: ['Map'] });
    provider.collectAll({ assetsBase: '/' }, { assetsBase: ['Backdrop'] });

    const collection = provider.getDependenciesCollection();

    expect(collection.has('Map')).toBe(false);
    expect(collection.get('Backdrop')).toEqual({ assetsBase: '/' });
  });
});
