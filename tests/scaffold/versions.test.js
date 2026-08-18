import { readFile } from 'node:fs/promises';

import { describe, it, expect } from 'vitest';

import {
  GENERATED_FILE,
  parseCrateVersion,
  readRepoVersions,
  resolveVersions,
  toPins,
} from '../../packages/create-vimp-game/src/versions.js';

// Пины движка в шаблоне не хардкодятся: устаревший пин ловится здесь, а не
// на сборке ядра у автора игры (болезнь vimp-street-fighters).

describe('parseCrateVersion', () => {
  it('берёт версию из [package], а не из зависимостей', () => {
    const toml = [
      '[package]',
      'name = "space-arena-core"',
      'version = "0.1.0"',
      '',
      '[dependencies]',
      'vimp-engine-core = { version = "9.9.9" }',
      '',
    ].join('\n');

    expect(parseCrateVersion(toml)).toBe('0.1.0');
  });

  it('падает, когда секции [package] нет', () => {
    expect(() => parseCrateVersion('[workspace]\nmembers = []\n')).toThrow();
  });
});

describe('версии репозитория', () => {
  it('читаются из packages/engine', async () => {
    const { engine, core } = await readRepoVersions();

    expect(engine).toMatch(/^\d+\.\d+\.\d+/);
    expect(core).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('пины: движок — caret-диапазон, крейт — точная версия', () => {
    expect(toPins({ engine: '0.9.0', core: '0.3.2' })).toEqual({
      engineVersion: '^0.9.0',
      coreVersion: '0.3.2',
    });
  });

  it('resolveVersions в монорепозитории отдаёт фактические версии', async () => {
    expect(await resolveVersions()).toEqual(await readRepoVersions());
  });
});

describe('versions.generated.json', () => {
  it('совпадает с фактическими версиями репозитория', async () => {
    const generated = JSON.parse(await readFile(GENERATED_FILE, 'utf8'));

    expect(generated).toEqual(await readRepoVersions());
  });
});
