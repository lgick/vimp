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
    scaffold: {
      local: '0.1.0',
      published: '0.1.0',
      changed: false,
      unreleased: quiet,
      pinsStale: false,
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
        // бамп версии API без публикации самого движка невозможен: он
        // приходит вместе с ⚠️ Breaking в журнале
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: true,
          unreleased: breaking,
        },
        engineApiChanged: true,
        games: [{ name: '@vimp-games/tanks', version: '0.4.2' }],
      }),
    );

    expect(plan.games[0].required).toBe(true);
    expect(plan.prod.strictlyLast).toBe(true);
    expect(plan.prod.push).toBe(true);
  });

  // против чего собирается игра: не «что публикуется в этом прогоне», а что
  // лежит в реестре — иначе прерванный прогон соберёт её на старом ядре
  it('берёт версии сборки игры из реестра, когда артефакты не публикуются', () => {
    const plan = decide(input());

    expect(plan.crateVersion).toBe('0.2.1');
    expect(plan.engineVersion).toBe('0.6.0');
  });

  it('берёт версии сборки игры из плана, когда артефакты публикуются', () => {
    const plan = decide(
      input({
        crate: { local: '0.2.1', published: '0.2.1', changed: true, unreleased: added },
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: true,
          unreleased: added,
        },
      }),
    );

    expect(plan.crateVersion).toBe('0.3.0');
    expect(plan.engineVersion).toBe('0.7.0');
  });

  // ровно состояние после прерванного релиза: крейт уже в реестре, publish у
  // него false, а игра осталась на старом пине
  it('делает игру обязательной, когда её ядро отстало от крейта в реестре', () => {
    const plan = decide(
      input({
        crate: { local: '0.3.0', published: '0.3.0', changed: false, unreleased: quiet },
        games: [
          {
            name: '@vimp-games/tanks',
            version: '0.4.2',
            published: '0.4.2',
            changed: false,
            corePin: '0.2.1',
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(true);
    expect(plan.games[0].required).toBe(true);
    // patch здесь занизил бы релиз: игра уезжает на другом ядре
    expect(plan.games[0].level).toBe('minor');
    expect(plan.games[0].reason).toBe(
      'ядро игры на 0.2.1, в реестре 0.3.0 → пересборка',
    );
  });

  it('не трогает игру, чьё ядро совпадает с крейтом в реестре', () => {
    const plan = decide(
      input({
        crate: { local: '0.3.0', published: '0.3.0', changed: false, unreleased: quiet },
        games: [
          {
            name: '@vimp-games/tanks',
            version: '0.4.2',
            published: '0.4.2',
            changed: false,
            corePin: '0.3.0',
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(false);
    expect(plan.games[0].required).toBe(false);
    expect(plan.games[0].level).toBe('patch');
  });

  // при бампе крейта причина уже названа, дублировать её пином не нужно
  it('не дублирует причину, когда крейт публикуется в этом же прогоне', () => {
    const plan = decide(
      input({
        crate: { local: '0.2.1', published: '0.2.1', changed: true, unreleased: added },
        games: [
          { name: '@vimp-games/tanks', version: '0.4.2', corePin: '0.2.1' },
        ],
      }),
    );

    expect(plan.games[0].reason).toBe('крейт публикуется → игру нужно пересобрать');
    expect(plan.games[0].level).toBe('minor');
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

  // прерванный прогон: крейт и движок опубликованы прошлым запуском, их
  // бампы закоммичены и затегированы, publish у обоих уже false — но релиз
  // всё ещё не доехал до прода, и решение обязано это видеть
  it('деплоит прод по незапушенным коммитам, даже когда публиковать нечего', () => {
    const plan = decide(input({ unpushed: true }));

    expect(plan.crate.publish).toBe(false);
    expect(plan.engine.publish).toBe(false);
    expect(plan.prod.push).toBe(true);
    expect(plan.prod.reason).toMatch(/не уехали в main/);
  });

  it('без незапушенных коммитов релиз одних игр прод не деплоит', () => {
    const plan = decide(
      input({
        unpushed: false,
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
    expect(plan.prod.push).toBe(false);
    expect(plan.prod.verifyGames).toBe(true);
  });

  // причина деплоя называется по самому сильному сигналу: публикация движка
  // важнее «на ветке лежит незапушенное»
  it('публикация движка перебивает незапушенные коммиты в причине', () => {
    const plan = decide(
      input({
        unpushed: true,
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: true,
          unreleased: added,
        },
      }),
    );

    expect(plan.prod.push).toBe(true);
    expect(plan.prod.reason).toBe('опубликован движок');
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
    // релиз одной игры прод не деплоит: игры едут через реестр auth-сервиса,
    // пинов игр в этом репозитории не осталось — пушить было бы нечего
    expect(plan.prod.push).toBe(false);
    expect(plan.prod.verifyGames).toBe(true);
    expect(plan.prod.reason).not.toMatch(/перепин/);
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
    expect(plan.prod.push).toBe(false);
    expect(plan.prod.verifyGames).toBe(true);
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

  // симметрия: журнал крейта блокирует так же, как журнал движка — пары
  // ⚠️ Breaking + Migration живут как раз в core/CHANGELOG.md
  it('прокидывает в общий список проблемы журнала крейта', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          changelogFile: 'packages/engine/core/CHANGELOG.md',
          unreleased: {
            present: true,
            isEmpty: false,
            sections: ['⚠️ Breaking — что-то'],
          },
        },
      }),
    );

    expect(plan.crate.publish).toBe(true);
    expect(plan.problems).toEqual([
      'packages/engine/core/CHANGELOG.md: есть ### ⚠️ Breaking, но нет ### Migration',
    ]);
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

  it('не трогает скаффолдер, пока пины и его файлы не менялись', () => {
    const plan = decide(input());

    expect(plan.scaffold.publish).toBe(false);
    expect(plan.scaffold.required).toBe(false);
  });

  // прогон, где движок уезжает в npm: prepack вшил бы в тарбол шаблона
  // прошлую версию движка, и `npm create vimp-game` генерировал бы игру,
  // которая ставит устаревший vimp-engine
  it('делает скаффолдер обязательным, когда публикуется движок', () => {
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

    expect(plan.scaffold.publish).toBe(true);
    expect(plan.scaffold.required).toBe(true);
    // перепин чужой версии — не новая фича: пустая [Unreleased] значит patch
    expect(plan.scaffold.target).toBe('0.1.1');
    expect(plan.scaffold.reason).toMatch(/пины шаблона устареют/);
  });

  it('делает скаффолдер обязательным, когда публикуется крейт', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          unreleased: added,
        },
      }),
    );

    expect(plan.scaffold.publish).toBe(true);
    expect(plan.scaffold.required).toBe(true);
    expect(plan.scaffold.target).toBe('0.1.1');
  });

  // прерванный прогон: движок опубликован, скаффолдер за ним не поехал —
  // publish у движка уже false, и остаётся единственный сигнал
  it('публикует скаффолдер по отставшим пинам, когда движок уже уехал', () => {
    const plan = decide(
      input({
        scaffold: {
          local: '0.1.0',
          published: '0.1.0',
          changed: false,
          unreleased: quiet,
          pinsStale: true,
        },
      }),
    );

    expect(plan.engine.publish).toBe(false);
    expect(plan.scaffold.publish).toBe(true);
    expect(plan.scaffold.required).toBe(true);
    expect(plan.scaffold.reason).toMatch(/пины шаблона отстали/);
  });

  it('предлагает minor скаффолдеру по его собственной [Unreleased]', () => {
    const plan = decide(
      input({
        scaffold: {
          local: '0.1.0',
          published: '0.1.0',
          changed: true,
          unreleased: added,
          pinsStale: false,
        },
      }),
    );

    expect(plan.scaffold.publish).toBe(true);
    expect(plan.scaffold.required).toBe(false);
    expect(plan.scaffold.target).toBe('0.2.0');
  });

  it('не бампает скаффолдер, чья версия уже поднята руками', () => {
    const plan = decide(
      input({
        scaffold: {
          local: '0.2.0',
          published: '0.1.0',
          changed: true,
          unreleased: added,
          pinsStale: false,
        },
      }),
    );

    expect(plan.scaffold.publish).toBe(true);
    expect(plan.scaffold.bump).toBe(false);
    expect(plan.scaffold.target).toBe('0.2.0');
  });

  it('прокидывает проблемы журнала скаффолдера в общий список', () => {
    const plan = decide(
      input({
        scaffold: {
          local: '0.1.0',
          published: '0.1.0',
          changed: true,
          unreleased: {
            present: true,
            isEmpty: false,
            sections: ['Улучшено'],
          },
          changelogFile: 'packages/create-vimp-game/CHANGELOG.md',
          pinsStale: false,
        },
      }),
    );

    expect(plan.problems).toContain(
      'packages/create-vimp-game/CHANGELOG.md: заголовок «### Улучшено» не из списка',
    );
  });

  // прод деплоит мастер и плагины; скаффолдер живёт только в npm
  it('не тянет прод из-за одного скаффолдера', () => {
    const plan = decide(
      input({
        scaffold: {
          local: '0.1.0',
          published: '0.1.0',
          changed: true,
          unreleased: added,
          pinsStale: false,
        },
      }),
    );

    expect(plan.scaffold.publish).toBe(true);
    expect(plan.prod.push).toBe(false);
  });
});
