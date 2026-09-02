import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  discoverLocalGames,
  mergeGames,
  applyLocalGames,
  readGameId,
  readPackageVersion,
} from '../../packages/engine/src/master/localGames.js';

// Локальный каталог игр: в проде каталог платформы приходит из реестра
// auth-сервиса, на машине разработчика игры просто лежат в
// node_modules/@vimp-games/* (зависимостью или симлинком npm link).

let nodeModulesDir;

const installGame = (name, manifest) => {
  const distDir = path.join(nodeModulesDir, '@vimp-games', name, 'dist');

  fs.mkdirSync(distDir, { recursive: true });

  if (manifest !== null) {
    fs.writeFileSync(
      path.join(distDir, 'manifest.json'),
      JSON.stringify(manifest),
    );
  }
};

// заглушка lib/config.js: нужны только get/set по ключу master:games
const fakeConfig = games => {
  const store = { 'master:games': games };

  return {
    get: key => store[key],
    set: (key, value) => {
      store[key] = value;
    },
  };
};

beforeEach(() => {
  nodeModulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-games-'));
});

afterEach(() => {
  fs.rmSync(nodeModulesDir, { recursive: true, force: true });
});

describe('readGameId', () => {
  it('отдаёт id, объявленный сборкой пакета', () => {
    installGame('tanks-dev', { id: 'tanks' });

    expect(readGameId(nodeModulesDir, '@vimp-games/tanks-dev')).toBe('tanks');
  });

  it('пакет не установлен, не собран или без id — null, а не бросок', () => {
    installGame('unbuilt', null);
    installGame('nameless', { engineApi: 5 });
    fs.writeFileSync(
      path.join(nodeModulesDir, '@vimp-games', 'unbuilt', 'dist', 'manifest.json'),
      'not json',
    );

    // отсутствующий пакет, битый JSON и манифест без id одинаково означают
    // «игры здесь нет»: вызывающий пойдёт другим путём разрешения ссылки
    expect(readGameId(nodeModulesDir, '@vimp-games/missing')).toBeNull();
    expect(readGameId(nodeModulesDir, '@vimp-games/unbuilt')).toBeNull();
    expect(readGameId(nodeModulesDir, '@vimp-games/nameless')).toBeNull();
  });
});

describe('readPackageVersion', () => {
  it('версия берётся из package.json, а не из манифеста', () => {
    // manifest.version — хеш сборки, а не npm-версия: сверять пин по нему
    // значило бы сверять несравнимое
    installGame('tanks', { id: 'tanks', version: 'bundle-hash' });
    fs.writeFileSync(
      path.join(nodeModulesDir, '@vimp-games', 'tanks', 'package.json'),
      JSON.stringify({ name: '@vimp-games/tanks', version: '0.16.1' }),
    );

    expect(readPackageVersion(nodeModulesDir, '@vimp-games/tanks')).toBe('0.16.1');
  });

  it('пакета нет или package.json без версии — null', () => {
    installGame('nometa', { id: 'nometa' });

    expect(readPackageVersion(nodeModulesDir, '@vimp-games/missing')).toBeNull();
    expect(readPackageVersion(nodeModulesDir, '@vimp-games/nometa')).toBeNull();
  });
});

describe('discoverLocalGames', () => {
  it('находит собранные пакеты скоупа и сортирует их по id', () => {
    installGame('tanks', { id: 'tanks' });
    installGame('snakes', { id: 'snakes' });

    expect(discoverLocalGames(nodeModulesDir)).toEqual([
      { id: 'snakes', package: '@vimp-games/snakes' },
      { id: 'tanks', package: '@vimp-games/tanks' },
    ]);
  });

  it('id берётся из манифеста, а не из имени директории', () => {
    installGame('snakes-dev', { id: 'snakes' });

    // GameCatalog сверяет manifest.id с настроенным и молча выбрасывает игру
    // при расхождении — запись обязана нести id манифеста
    expect(discoverLocalGames(nodeModulesDir)).toEqual([
      { id: 'snakes', package: '@vimp-games/snakes-dev' },
    ]);
  });

  it('пропускает несобранное, битое и безымянное', () => {
    installGame('unbuilt', null);
    installGame('nameless', { engineApi: 5 });
    fs.writeFileSync(
      path.join(nodeModulesDir, '@vimp-games', 'broken.json'),
      'not a package',
    );

    const distDir = path.join(nodeModulesDir, '@vimp-games', 'garbage', 'dist');

    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), '{oops');

    expect(discoverLocalGames(nodeModulesDir)).toEqual([]);
  });

  it('игнорирует служебные записи npm внутри скоупа', () => {
    installGame('.package-lock', { id: 'ghost' });
    installGame('tanks', { id: 'tanks' });

    expect(discoverLocalGames(nodeModulesDir)).toEqual([
      { id: 'tanks', package: '@vimp-games/tanks' },
    ]);
  });

  it('без скоупа возвращает пустой список, а не падает', () => {
    expect(discoverLocalGames(nodeModulesDir)).toEqual([]);
    expect(discoverLocalGames(path.join(nodeModulesDir, 'nope'))).toEqual([]);
  });
});

describe('mergeGames', () => {
  it('найденное впереди, настроенное без дублей — следом', () => {
    const discovered = [{ id: 'snakes', package: '@vimp-games/snakes' }];
    const configured = [
      { id: 'tanks', package: '@vimp-games/tanks' },
      { id: 'snakes', package: '@vimp-games/snakes' },
    ];

    expect(mergeGames(discovered, configured)).toEqual([
      { id: 'snakes', package: '@vimp-games/snakes' },
      { id: 'tanks', package: '@vimp-games/tanks' },
    ]);
  });

  it('без конфига возвращает только найденное', () => {
    const discovered = [{ id: 'snakes', package: '@vimp-games/snakes' }];

    expect(mergeGames(discovered)).toEqual(discovered);
  });
});

describe('applyLocalGames', () => {
  it('дополняет master:games найденным локально', () => {
    installGame('snakes', { id: 'snakes' });

    const config = fakeConfig([{ id: 'tanks', package: '@vimp-games/tanks' }]);
    const added = applyLocalGames(config, nodeModulesDir, {});

    expect(added).toEqual([{ id: 'snakes', package: '@vimp-games/snakes' }]);
    expect(config.get('master:games')).toEqual([
      { id: 'snakes', package: '@vimp-games/snakes' },
      { id: 'tanks', package: '@vimp-games/tanks' },
    ]);
  });

  it('не трогает каталог в проде: там источник — реестр auth-сервиса', () => {
    installGame('snakes', { id: 'snakes' });

    const configured = [{ id: 'tanks', package: '@vimp-games/tanks' }];
    const prod = fakeConfig(configured);

    expect(applyLocalGames(prod, nodeModulesDir, { NODE_ENV: 'production' })).toEqual([]);
    expect(prod.get('master:games')).toEqual(configured);
  });

  it('без единой найденной игры оставляет конфиг как есть', () => {
    const configured = [{ id: 'tanks', package: '@vimp-games/tanks' }];
    const config = fakeConfig(configured);

    expect(applyLocalGames(config, nodeModulesDir, {})).toEqual([]);
    expect(config.get('master:games')).toEqual(configured);
  });
});
