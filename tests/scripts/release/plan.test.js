import { describe, it, expect } from 'vitest';

import {
  decide,
  repoProblems,
  buildVersions,
} from '../../../scripts/release/plan.js';

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

  // крейт игру не обязывает: опубликованная игра везёт своё собранное ядро.
  // Он лишь предлагает её — release.js спрашивает отдельно
  it('релиз крейта предлагает игру, но не публикует её сам', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          unreleased: added,
        },
        games: [
          { name: '@vimp-games/tanks', version: '0.4.2', published: '0.4.2' },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(false);
    expect(plan.games[0].optional).toBe(true);
    expect(plan.games[0].level).toBe('patch');
    expect(plan.prod.push).toBe(true);
    expect(plan.prod.verifyGames).toBe(false);
  });

  it('согласие (follow) превращает предложенную игру в публикуемую', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          unreleased: added,
        },
        games: [
          {
            name: '@vimp-games/tanks',
            version: '0.4.2',
            published: '0.4.2',
            follow: true,
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(true);
    expect(plan.games[0].optional).toBe(true);
    expect(plan.prod.verifyGames).toBe(true);
  });

  it('follow без сигнала сверху ничего не публикует', () => {
    const plan = decide(
      input({
        games: [
          {
            name: '@vimp-games/tanks',
            version: '0.4.2',
            published: '0.4.2',
            changed: false,
            follow: true,
          },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(false);
    expect(plan.games[0].optional).toBe(false);
  });

  it('релиз движка тоже только предлагает игру', () => {
    const plan = decide(
      input({
        engine: { local: '0.6.0', published: '0.6.0', changed: true, unreleased: added },
        games: [
          { name: '@vimp-games/tanks', version: '0.4.2', published: '0.4.2' },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(false);
    expect(plan.games[0].optional).toBe(true);
    expect(plan.games[0].reason).toBe('движок публикуется → можно обновить');
  });

  // собственные сигналы игры делают её релиз обычным, не «по выбору», —
  // сборка всё равно пойдёт против нового крейта
  it('игра со своими изменениями при релизе крейта не optional', () => {
    const plan = decide(
      input({
        crate: { local: '0.2.1', published: '0.2.1', changed: true, unreleased: added },
        games: [
          { name: '@vimp-games/tanks', version: '0.4.2', published: '0.4.2', changed: true },
        ],
      }),
    );

    expect(plan.games[0].publish).toBe(true);
    expect(plan.games[0].optional).toBe(false);
    expect(plan.games[0].reason).toBe(
      'есть коммиты после тега версии; крейт публикуется → можно пересобрать',
    );
  });

  // ровно состояние после прерванного релиза: крейт уже в реестре, publish у
  // него false, а игра осталась на старом пине
  it('предлагает игру, когда её ядро отстало от крейта в реестре', () => {
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

    expect(plan.games[0].publish).toBe(false);
    expect(plan.games[0].optional).toBe(true);
    expect(plan.games[0].level).toBe('patch');
    expect(plan.games[0].reason).toBe(
      'ядро игры на 0.2.1, в реестре 0.3.0 → можно пересобрать',
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
    expect(plan.games[0].optional).toBe(false);
  });

  // при бампе крейта причина уже названа, дублировать её пином не нужно
  it('не дублирует причину, когда крейт публикуется в этом же прогоне', () => {
    const plan = decide(
      input({
        crate: { local: '0.2.1', published: '0.2.1', changed: true, unreleased: added },
        games: [
          { name: '@vimp-games/tanks', version: '0.4.2', published: '0.4.2', corePin: '0.2.1' },
        ],
      }),
    );

    expect(plan.games[0].reason).toBe('крейт публикуется → можно пересобрать');
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
    expect(plan.prod.reason).toMatch(/незапушенные коммиты/);
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
    expect(plan.games[0].optional).toBe(false);
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

  // журнал крейта сломан, но крейт не публикуется — релиз движка из-за
  // этого блокировать нельзя, а вот молчать нельзя тем более: `## Added`
  // вместо `### Added` сам обнуляет секцию и сам же гасит publish
  it('не тянет в общий список проблемы непубликуемого артефакта', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: false,
          changelogFile: 'packages/engine/core/CHANGELOG.md',
          unreleased: { present: false, isEmpty: true, sections: [] },
        },
        engine: {
          local: '0.6.0',
          published: '0.6.0',
          changed: true,
          changelogFile: 'packages/engine/CHANGELOG.md',
          unreleased: added,
        },
      }),
    );

    expect(plan.engine.publish).toBe(true);
    expect(plan.crate.publish).toBe(false);
    expect(plan.crate.problems).toHaveLength(1);
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual(plan.crate.problems);
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

  // бамп крейта переписывает core/Cargo.toml из "files" движка: без этого
  // движок всплывал «изменённым» лишь в следующем прогоне
  it('делает движок обязательным, когда публикуется крейт', () => {
    const plan = decide(
      input({
        crate: {
          local: '0.2.1',
          published: '0.2.1',
          changed: true,
          unreleased: quiet,
        },
      }),
    );

    expect(plan.engine.publish).toBe(true);
    expect(plan.engine.required).toBe(true);
    expect(plan.engine.target).toBe('0.6.1');
    expect(plan.engine.reason).toMatch(/core\/Cargo\.toml в тарболе устареет/);
  });

  it('не трогает движок, когда крейт не публикуется', () => {
    const plan = decide(input());

    expect(plan.engine.publish).toBe(false);
    expect(plan.engine.required).toBe(false);
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

// ***** СОСТОЯНИЕ РЕПОЗИТОРИЯ ДВИЖКА *****
//
// Игра едет до игроков через реестр auth-сервиса (master-game-registry), в
// vimp её релиз не меняет ни файла и собирается она против копий движка ИЗ
// РЕЕСТРА. Требовать ради неё чистый main с upstream — требование без
// причины: разработчик игры не обязан приводить в порядок чужое дерево.
describe('repoProblems', () => {
  const clean = {
    changelog: [],
    npmDryRun: false,
    branch: 'main',
    dirty: false,
    upstream: true,
    behind: 0,
    cratePatches: [],
  };

  it('чистое состояние — ни отказов, ни замечаний', () => {
    expect(repoProblems(clean, { writesRepo: true })).toEqual({
      problems: [],
      notes: [],
    });
  });

  it('грязное дерево на ветке не main — отказ, когда репозиторий правится', () => {
    const { problems, notes } = repoProblems(
      { ...clean, dirty: true, branch: 'wip' },
      { writesRepo: true },
    );

    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/дерево не чистое/);
    expect(notes).toEqual([]);
  });

  it('то же самое при релизе одних игр — замечание, релиз идёт', () => {
    const { problems, notes } = repoProblems(
      { ...clean, dirty: true, branch: 'wip', upstream: false },
      { writesRepo: false },
    );

    expect(problems).toEqual([]);
    expect(notes.join('\n')).toMatch(/дерево не чистое/);
    // и объяснение, почему это не отказ
    expect(notes.at(-1)).toMatch(/из реестра/);
  });

  // ядро из локального [patch.crates-io] нет ни у кого, кроме этой машины, а
  // `npm run sim` шага прода поднимает ядро именно этого дерева — проверка
  // прошла бы по тому, чего в проде не будет
  it('[patch.crates-io] остаётся отказом и при релизе одних игр', () => {
    const { problems } = repoProblems(
      { ...clean, cratePatches: ['Cargo.toml: [patch.crates-io]'] },
      { writesRepo: false },
    );

    expect(problems).toEqual(['Cargo.toml: [patch.crates-io]']);
  });

  // холостой npm из окружения к состоянию дерева отношения не имеет:
  // публикации молча не случатся, а теги и коммиты — да
  it('npm_config_dry_run — отказ в любом случае', () => {
    const { problems } = repoProblems(
      { ...clean, npmDryRun: true },
      { writesRepo: false },
    );

    expect(problems.join('\n')).toMatch(/npm_config_dry_run/);
  });

  // дефекты журнала считает decide(); repoProblems лишь не теряет их
  it('проблемы журнала остаются отказом', () => {
    const { problems } = repoProblems(
      { ...clean, changelog: ['CHANGELOG: ⚠️ Breaking без Migration'] },
      { writesRepo: false },
    );

    expect(problems).toEqual(['CHANGELOG: ⚠️ Breaking без Migration']);
  });
});

// против чего собирается игра: не «что публикуется в этом прогоне», а что
// лежит в реестре — иначе прерванный прогон соберёт её на старом ядре. И
// считается это ПОСЛЕ вопросов о версии: ответ (`major`, своя) иначе запинил
// бы игру на версию, которой нет в реестре
describe('buildVersions', () => {
  it('берёт версии из реестра, когда артефакты не публикуются', () => {
    const scoped = input();

    expect(buildVersions(decide(scoped), scoped)).toEqual({
      crateVersion: '0.2.1',
      engineVersion: '0.6.0',
    });
  });

  it('берёт ответы на вопрос о версии, а не предложения', () => {
    const scoped = input({
      crate: { local: '0.2.1', published: '0.2.1', changed: true, unreleased: added },
      engine: { local: '0.6.0', published: '0.6.0', changed: true, unreleased: added },
    });
    const plan = decide(scoped);

    expect(plan.crate.target).toBe('0.3.0');

    plan.crate.target = '1.0.0';
    plan.engine.target = '0.6.1';

    expect(buildVersions(plan, scoped)).toEqual({
      crateVersion: '1.0.0',
      engineVersion: '0.6.1',
    });
  });

  // --only без крейта: его пин в игре шаг B не трогает
  it('артефакт вне прогона даёт null', () => {
    const scoped = input({ crate: null, engine: null });

    expect(buildVersions(decide(scoped), scoped)).toEqual({
      crateVersion: null,
      engineVersion: null,
    });
  });
});
