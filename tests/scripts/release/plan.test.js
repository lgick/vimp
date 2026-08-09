import { describe, it, expect } from 'vitest';

import { decide } from '../../../scripts/release/plan.js';

// Форма как у parseUnreleased: без present секция читается как отсутствующая
const quiet = { present: true, isEmpty: true, sections: [] };
const added = { present: true, isEmpty: false, sections: ['Added'] };
// пара Breaking + Migration обязательна — журнал без неё контракт отвергает
const breaking = {
  present: true,
  isEmpty: false,
  sections: ['⚠️ Breaking — что-то', 'Migration'],
};

function input(overrides = {}) {
  return {
    crate: {
      local: '0.2.1',
      published: '0.2.1',
      changed: false,
      unreleased: quiet,
    },
    engine: {
      local: '0.6.0',
      published: '0.6.0',
      changed: false,
      unreleased: quiet,
    },
    engineApiChanged: false,
    games: [],
    ...overrides,
  };
}

describe('decide', () => {
  it('ничего не публикует, когда нет ни изменений, ни записей в [Unreleased]', () => {
    const plan = decide(input());

    expect(plan.crate.publish).toBe(false);
    expect(plan.engine.publish).toBe(false);
    expect(plan.prod.push).toBe(false);
  });

  it('публикует движок по непустой [Unreleased] и предлагает minor на Added', () => {
    const plan = decide(
      input({
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: true,
          unreleased: added,
        },
      }),
    );

    expect(plan.engine.publish).toBe(true);
    expect(plan.engine.target).toBe('0.7.0');
    expect(plan.prod.push).toBe(true);
  });

  it('на ⚠️ Breaking в 0.x предлагает minor', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          unreleased: breaking,
        },
      }),
    );

    expect(plan.crate.target).toBe('0.3.0');
  });

  it('не бампает версию, которая уже поднята, но не опубликована', () => {
    const plan = decide(
      input({
        engine: {
          local: '0.7.0',
          published: '0.6.0',
          changed: false,
          unreleased: quiet,
        },
      }),
    );

    expect(plan.engine.publish).toBe(true);
    expect(plan.engine.bump).toBe(false);
    expect(plan.engine.target).toBe('0.7.0');
  });

  it('считает публикацию обязательной для всех игр, если публикуется крейт', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          unreleased: added,
        },
        games: [{ name: '@vimp-games/tanks', version: '0.4.2' }],
      }),
    );

    expect(plan.games[0].publish).toBe(true);
    expect(plan.games[0].required).toBe(true);
    expect(plan.prod.push).toBe(true);
  });

  it('делает игру обязательной при бампе ENGINE_API_VERSION и требует пуш последним', () => {
    const plan = decide(
      input({
        engineApiChanged: true,
        games: [{ name: '@vimp-games/tanks', version: '0.4.2' }],
      }),
    );

    expect(plan.games[0].required).toBe(true);
    expect(plan.prod.strictlyLast).toBe(true);
    expect(plan.prod.push).toBe(true);
  });

  it('не трогает игру без изменений и без неопубликованной версии', () => {
    const plan = decide(
      input({
        games: [
          {
            name: '@vimp-games/tanks',
            version: '0.4.2',
            published: '0.4.2',
            changed: false,
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(false);
    expect(plan.prod.push).toBe(false);
  });

  it('публикует игру, у которой версия поднята руками, но не уехала', () => {
    const plan = decide(
      input({
        games: [
          {
            name: '@vimp-games/tanks',
            version: '0.5.0',
            published: '0.4.2',
            changed: false,
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(true);
    expect(plan.games[0].required).toBe(false);
    expect(plan.games[0].bump).toBe(false);
    expect(plan.prod.push).toBe(true);
  });

  it('публикует игру по её собственным коммитам после тега версии', () => {
    const plan = decide(
      input({
        games: [
          {
            name: '@vimp-games/tanks',
            version: '0.4.2',
            published: '0.4.2',
            changed: true,
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(true);
    expect(plan.games[0].bump).toBe(true);
    expect(plan.games[0].reason).toMatch(/коммиты после тега/);
    expect(plan.prod.push).toBe(true);
  });

  it('публикует игру, которой ещё нет в npm', () => {
    const plan = decide(
      input({
        games: [
          {
            name: '@vimp-games/street-fighters',
            version: '0.1.0',
            published: null,
            changed: false,
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(true);
    expect(plan.games[0].bump).toBe(false);
  });

  // нарушение контракта заголовков доезжает до preflight и останавливает
  // релиз до первой изменяющей команды
  it('прокидывает проблемы заголовков в артефакт и в общий список', () => {
    const plan = decide(
      input({
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: true,
          changelogFile: 'packages/engine/CHANGELOG.md',
          unreleased: { present: true, isEmpty: false, sections: ['Improved'] },
        },
      }),
    );

    expect(plan.engine.publish).toBe(true);
    // проблема и подсказка про допустимые имена
    expect(plan.engine.problems).toHaveLength(2);
    // префикс с именем журнала — часть контракта: preflight печатает строку как есть
    expect(plan.engine.problems[0]).toBe(
      'packages/engine/CHANGELOG.md: заголовок «### Improved» не из списка',
    );
    expect(plan.problems).toEqual(plan.engine.problems);
    expect(plan.crate.problems).toEqual([]);
    // публикуемый артефакт блокирует, а не предупреждает: иначе одна опечатка
    // приехала бы двумя противоречащими сообщениями
    expect(plan.warnings).toEqual([]);
  });

  // журнал движка сломан, но движок не публикуется — релиз крейта из-за
  // этого блокировать нельзя, а вот молчать нельзя тем более: `## Added`
  // вместо `### Added` сам обнуляет секцию и сам же гасит publish
  it('не тянет в общий список проблемы непубликуемого артефакта', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          changelogFile: 'packages/engine/core/CHANGELOG.md',
          unreleased: added,
        },
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: false,
          changelogFile: 'packages/engine/CHANGELOG.md',
          unreleased: { present: false, isEmpty: true, sections: [] },
        },
      }),
    );

    expect(plan.crate.publish).toBe(true);
    expect(plan.engine.publish).toBe(false);
    expect(plan.engine.problems).toHaveLength(1);
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual(plan.engine.problems);
  });

  // тот самый дефект, который прячет сам себя: секция оборвана на `## Added`,
  // из-за этого пуста, из-за этого publish: false — в problems он бы не попал
  it('показывает предупреждением дефект, из-за которого артефакт не публикуется', () => {
    const plan = decide(
      input({
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: false,
          changelogFile: 'packages/engine/CHANGELOG.md',
          unreleased: {
            present: true,
            isEmpty: true,
            sections: [],
            terminator: '## Added',
          },
        },
      }),
    );

    expect(plan.engine.publish).toBe(false);
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual([
      'packages/engine/CHANGELOG.md: секция [Unreleased] оборвана заголовком «## Added» — вероятно, ### написан как ##',
    ]);
  });

  it('игнорирует артефакт, исключённый флагом --only', () => {
    const plan = decide(input({ crate: null }));

    expect(plan.crate.publish).toBe(false);
    expect(plan.crate.reason).toMatch(/не рассматривался/);
  });
});
