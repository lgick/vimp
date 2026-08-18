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
  // Файл генерируемый и под .gitignore: в свежем клоне и в CI после `npm ci`
  // его нет — писать его умеет только хук prepack. Отсутствие проверять
  // нечего, а вот несовпадение — это ровно та устаревшая пара пинов, из-за
  // которой тест и заведён.
  it('совпадает с фактическими версиями репозитория, если снимок снят', async () => {
    let generated;

    try {
      generated = JSON.parse(await readFile(GENERATED_FILE, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return;
    }

    expect(generated).toEqual(await readRepoVersions());
  });
});
