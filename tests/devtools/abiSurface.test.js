import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseAbi } from '../../packages/engine/src/devtools/surface/abiParse.js';
import { collectSurface } from '../../packages/engine/src/devtools/surface/collect.js';
import { abiOps } from '../../packages/engine/src/config/abiOps.js';

// Страж механизма расширения ABI (этап 4 плана plugin-forward-compat).
// Слепок поверхности ловит удаление и смену формы уже существующего
// (tests/devtools/surface.test.js); здесь проверяется, что на месте сам
// механизм, которым поверхность впредь растёт: самоописание и dispatch.
// Убрать их — значит вернуть движку способность состарить игру новым
// символом, и никакой diff слепка этого не заметит (добавление символа
// нарушением не считается).

const ABI_URL = new URL(
  '../../packages/engine/core/src/abi.rs',
  import.meta.url,
);

let abi;

beforeAll(async () => {
  abi = parseAbi(await readFile(ABI_URL, 'utf8'));
});

describe('механизм расширения ABI', () => {
  it('abi_describe и dispatch есть в обоих макросах', () => {
    for (const section of ['game', 'client']) {
      const byName = new Map(abi[section].map(m => [m.name, m]));

      expect(byName.get('abi_describe')).toEqual({
        name: 'abi_describe',
        args: [],
        ret: 'String',
      });
      expect(byName.get('dispatch')).toEqual({
        name: 'dispatch',
        args: ['str', '[u8]'],
        ret: 'Vec<u8>',
      });
    }
  });

  it('шапка abi.rs объявляет таблицу экспортов замороженной', async () => {
    const source = await readFile(ABI_URL, 'utf8');

    expect(source).toContain('ЗАМОРОЖЕНО');
  });
});

describe('реестр опкодов', () => {
  it('попадает в слепок поверхности', async () => {
    const surface = await collectSurface();

    expect(surface.abiOps).toEqual(
      expect.arrayContaining([{ name: 'debug.json', since: 4 }]),
    );
  });

  it('опкод, который умеет ядро, объявлен движком', () => {
    // движковый список из core/src/abi.rs зеркалит JS-реестр: опкод,
    // известный только одной стороне, не позовётся никогда
    expect(abiOps.has('debug.json')).toBe(true);
  });

  it('вывод опкода — алиас, а не удаление (И1)', () => {
    expect(abiOps.list().every(entry => typeof entry.value === 'string')).toBe(
      true,
    );
    expect(abiOps.resolve('debug.json')).toBe('debug.json');
    expect(abiOps.resolve('нет-такого')).toBeUndefined();
  });
});
