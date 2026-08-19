import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  discoverLocalGames,
  mergeGames,
  applyLocalGames,
} from '../../packages/engine/src/master/localGames.js';

// Локальный каталог игр: в проде master:games задаёт GAMES_MATRIX от деплоя,
// на машине разработчика игры просто лежат в node_modules/@vimp-games/*
// (зависимостью или симлинком npm link).

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

  it('не трогает каталог в проде и при заданном GAMES_MATRIX', () => {
    installGame('snakes', { id: 'snakes' });

    const configured = [{ id: 'tanks', package: '@vimp-games/tanks' }];
    const prod = fakeConfig(configured);
    const pinned = fakeConfig(configured);

    expect(applyLocalGames(prod, nodeModulesDir, { NODE_ENV: 'production' })).toEqual([]);
    expect(prod.get('master:games')).toEqual(configured);

    // явный каталог — слово разработчика, в том числе о порядке игр
    expect(
      applyLocalGames(pinned, nodeModulesDir, { GAMES_MATRIX: '[]' }),
    ).toEqual([]);
    expect(pinned.get('master:games')).toEqual(configured);
  });

  it('без единой найденной игры оставляет конфиг как есть', () => {
    const configured = [{ id: 'tanks', package: '@vimp-games/tanks' }];
    const config = fakeConfig(configured);

    expect(applyLocalGames(config, nodeModulesDir, {})).toEqual([]);
    expect(config.get('master:games')).toEqual(configured);
  });
});
