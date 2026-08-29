import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  collectSurface,
  diffSurface,
  formatSurface,
} from '../../packages/engine/src/devtools/surface/collect.js';
import { parseAbi } from '../../packages/engine/src/devtools/surface/abiParse.js';

// Страж плагинной поверхности (этап 1 плана plugin-forward-compat).
// Правка движка, которая удаляет или переименовывает что-либо из
// поверхности плагина (И1) или меняет форму данных (И3), обязана падать
// здесь — в репозитории движка, а не через полгода в чужом репозитории.
// Добавление поверхности совместимость не ломает: оно проходит с подсказкой.

const SURFACE_URL = new URL(
  '../../packages/engine/contract/surface.json',
  import.meta.url,
);

let collected;
let committed;

beforeAll(async () => {
  collected = await collectSurface();
  committed = JSON.parse(await readFile(SURFACE_URL, 'utf8'));
});

describe('слепок поверхности', () => {
  it('ничего не исчезло и не сменило форму по сравнению с закоммиченным', () => {
    const { violations, additions } = diffSurface(committed, collected);

    // добавление — не падение: печатаем список, чтобы слепок обновили
    if (violations.length === 0 && additions.length > 0) {
      console.info(
        `слепок устарел, запусти \`npm run surface:update\` — добавлено: ${additions.join(', ')}`,
      );
    }

    expect(violations).toEqual([]);
  });

  it('каждый раздел непустой — молча пустой слепок пропустил бы всё', () => {
    expect(collected.abi.game.length).toBeGreaterThan(0);
    expect(collected.abi.client.length).toBeGreaterThan(0);
    expect(collected.clientServices.length).toBeGreaterThan(0);
    expect(collected.engineCapabilities.length).toBeGreaterThan(0);
    expect(collected.formControls.length).toBeGreaterThan(0);
    expect(collected.hostPluginMembers.length).toBeGreaterThan(0);
    expect(collected.clientPluginMembers.length).toBeGreaterThan(0);
    expect(collected.manifestFields.length).toBeGreaterThan(0);
    expect(collected.requiredGameConfig.length).toBeGreaterThan(0);
    expect(collected.gameConfigFields.length).toBeGreaterThan(0);
  });

  it('записан отсортированным, с отступом 2 — стабильный diff', async () => {
    expect(formatSurface(collected)).toBe(await readFile(SURFACE_URL, 'utf8'));
  });
});

describe('diffSurface', () => {
  it('удаление имени — нарушение И1 с именем в тексте', () => {
    const without = {
      ...collected,
      formControls: collected.formControls.filter(
        entry => entry.name !== 'radio',
      ),
    };
    const { violations } = diffSurface(committed, without);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'radio' исчез из formControls");
    expect(violations[0]).toContain('Инвариант И1');
  });

  it('переименование сервиса — исчезновение старого имени', () => {
    const renamed = {
      ...collected,
      clientServices: collected.clientServices.map(entry =>
        entry.name === 'accolades' ? { ...entry, name: 'ranks' } : entry,
      ),
    };
    const { violations, additions } = diffSurface(committed, renamed);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'accolades' исчез из clientServices");
    expect(additions).toEqual(['clientServices: ranks']);
  });

  it('смена сигнатуры ABI-метода — нарушение И3', () => {
    const changed = {
      ...collected,
      abi: {
        ...collected.abi,
        game: collected.abi.game.map(method =>
          method.name === 'pack_frame'
            ? { ...method, args: [...method.args, 'u32'] }
            : method,
        ),
      },
    };
    const { violations } = diffSurface(committed, changed);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("сигнатура 'pack_frame'");
    expect(violations[0]).toContain('Инвариант И3');
  });

  it('перенумерация порта — нарушение И3', () => {
    const renumbered = {
      ...collected,
      ports: {
        ...collected.ports,
        server: { ...collected.ports.server, ACCOLADES_DATA: 19 },
      },
    };
    const { violations } = diffSurface(committed, renumbered);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('ports.server.ACCOLADES_DATA изменился');
    expect(violations[0]).toContain('Инвариант И3');
  });

  // требование, которого раньше не было, отвергает каждую уже
  // опубликованную игру — для этого раздела правило зеркально общему (И2)
  it('requiredGameConfig может только сокращаться (И2)', () => {
    const grown = {
      ...collected,
      requiredGameConfig: [...collected.requiredGameConfig, 'panel.fields'],
    };
    const { violations } = diffSurface(committed, grown);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "'panel.fields' добавлен в requiredGameConfig",
    );
    expect(violations[0]).toContain('Инвариант И2');
  });

  it('снятое требование gameConfig нарушением не считается', () => {
    const shrunk = {
      ...collected,
      requiredGameConfig: collected.requiredGameConfig.filter(
        path => path !== 'playerKeys',
      ),
    };
    const { violations, additions } = diffSurface(committed, shrunk);

    expect(violations).toEqual([]);
    expect(additions).toEqual([
      'requiredGameConfig: снято требование playerKeys',
    ]);
  });

  // поле с умолчанием игра всё ещё может написать — его исчезновение из
  // движка остаётся сломом (И1), просто живёт оно теперь в другом разделе
  it('исчезнувшее поле gameConfig с умолчанием — нарушение И1', () => {
    const without = {
      ...collected,
      gameConfigFields: collected.gameConfigFields.filter(
        path => path !== 'statMode',
      ),
    };
    const { violations } = diffSurface(committed, without);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'statMode' исчез из gameConfigFields");
    expect(violations[0]).toContain('Инвариант И1');
  });

  it('добавление проходит: нарушений нет, добавленное перечислено', () => {
    const grown = {
      ...collected,
      clientServices: [...collected.clientServices, 'weather'],
      ports: {
        ...collected.ports,
        server: { ...collected.ports.server, WEATHER_DATA: 19 },
      },
      abi: {
        ...collected.abi,
        game: [
          ...collected.abi.game,
          { name: 'weather_json', args: [], ret: 'String' },
        ],
      },
    };
    const { violations, additions } = diffSurface(committed, grown);

    expect(violations).toEqual([]);
    expect(additions).toEqual(
      expect.arrayContaining([
        'clientServices: weather',
        'ports.server.WEATHER_DATA',
        'abi.game: weather_json',
      ]),
    );
  });
});

describe('parseAbi', () => {
  it('падает, а не возвращает пустоту, если файл перестроен', () => {
    expect(() => parseAbi('fn load_map() {}\n')).toThrow(/macro_rules/);
    expect(() =>
      parseAbi(
        'macro_rules! export_game_core_abi { () => { impl X {} }; }\n' +
          'macro_rules! export_client_core_abi { () => { impl Y {} }; }\n',
      ),
    ).toThrow(/no "pub fn"/);
  });

  it('нормализует сигнатуру: ссылки, mut и путь до wasm_bindgen не считаются', () => {
    const source = `
      macro_rules! export_game_core_abi {
        ($T:ty) => { impl $T {
          pub fn load_map(&mut self, map_json: &str)
            -> Result<(), ::wasm_bindgen::JsError> { todo!() }
        } };
      }
      macro_rules! export_client_core_abi {
        ($T:ty) => { impl $T {
          pub fn push_frame(&mut self, data: &[u8], local_now: f64) -> bool {
            todo!()
          }
        } };
      }
    `;

    expect(parseAbi(source)).toEqual({
      game: [{ name: 'load_map', args: ['str'], ret: 'Result<()>' }],
      client: [
        { name: 'push_frame', args: ['[u8]', 'f64'], ret: 'bool' },
      ],
    });
  });
});
