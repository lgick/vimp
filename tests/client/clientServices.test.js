import { describe, it, expect } from 'vitest';
import DependencyProvider from '../../packages/engine/src/client/providers/DependencyProvider.js';
import {
  clientServices,
  SERVICES,
} from '../../packages/engine/src/config/clientServices.js';

// Реестр движковых сервисов (этап 3 плана plugin-forward-compat). Пул отдаёт
// ЗАПРОШЕННОЕ, а не всё подряд: шестой сервис ничего не требует от старых
// игр — они его не просят и не получают.

describe('реестр клиентских сервисов', () => {
  it('движковый пул — пять имён, ни одно не выведено', () => {
    expect(SERVICES).toEqual([
      'renderer',
      'soundManager',
      'assetsBase',
      'localPlayer',
      'accolades',
    ]);
    expect(SERVICES.some(name => clientServices.isRetired(name))).toBe(false);
  });

  it('игра получает ровно то подмножество сервисов, которое объявила', () => {
    const available = {
      renderer: {},
      soundManager: {},
      assetsBase: '/games/tanks/',
      localPlayer: {},
      accolades: {},
    };
    const provider = new DependencyProvider();

    // плагин старого поколения знает про два сервиса из пяти
    provider.collectAll(available, { renderer: ['Map'], assetsBase: ['Map'] });

    expect(provider.getDependenciesCollection().get('Map')).toEqual({
      renderer: available.renderer,
      assetsBase: '/games/tanks/',
    });
  });

  it('незнакомое имя не роняет сборку зависимостей — парт просто без сервиса', () => {
    const provider = new DependencyProvider();

    provider.collectAll({ renderer: {} }, { mapGeometry: ['Map'] });

    expect(provider.getDependenciesCollection().get('Map')).toBeUndefined();
  });
});
