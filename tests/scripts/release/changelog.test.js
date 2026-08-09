import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  SECTION_LEVELS,
  parseUnreleased,
  sectionName,
  suggestLevel,
  validateSections,
  validateUnreleased,
  releaseUnreleased,
  releaseLink,
} from '../../../scripts/release/changelog.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');

// Фрагменты повторяют реальные packages/engine/CHANGELOG.md и
// packages/engine/core/CHANGELOG.md: длинное тире в заголовке релиза,
// %40 в ссылке, ⚠️ в под-заголовке.
const CORE = `# Changelog

## [Unreleased]

### Added

- \`ClientState::resync()\` — сброс сетевой половины.

### ⚠️ Breaking — \`reset()\` также чистит \`my_game_id\`

Текст.

### Migration

Текст.

## [0.2.1] — 2026-08-05

### Fixed

- Что-то.

[0.2.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.1
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.0
`;

const ENGINE_EMPTY = `# Changelog

## [Unreleased]

## [0.6.0] — 2026-08-05

### Changed

- Что-то.

[0.6.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.6.0
`;

describe('changelog', () => {
  it('разбирает секцию [Unreleased] и её под-заголовки', () => {
    const parsed = parseUnreleased(CORE);

    expect(parsed.present).toBe(true);
    expect(parsed.isEmpty).toBe(false);
    expect(parsed.sections).toEqual([
      'Added',
      '⚠️ Breaking — `reset()` также чистит `my_game_id`',
      'Migration',
    ]);
    // тело секции обрывается на следующем релизном заголовке
    expect(parsed.body).not.toContain('0.2.1');
  });

  it('видит пустую секцию', () => {
    expect(parseUnreleased(ENGINE_EMPTY).isEmpty).toBe(true);
    expect(parseUnreleased('# Changelog\n').present).toBe(false);
  });

  // ранний выход не должен отдавать урезанный объект: потребитель ждёт
  // terminator/openFence и получил бы undefined там, где рассчитывал на null
  it('отдаёт ту же форму, когда секции нет', () => {
    expect(parseUnreleased('# Changelog\n')).toEqual({
      present: false,
      sections: [],
      body: '',
      isEmpty: true,
      terminator: null,
      openFence: false,
    });
  });

  it('предлагает инкремент по под-заголовкам', () => {
    expect(suggestLevel(parseUnreleased(CORE).sections, '0.2.1').level).toBe('minor');
    expect(suggestLevel(['Added'], '0.6.0').level).toBe('minor');
    expect(suggestLevel(['Changed', 'Fixed'], '0.6.0').level).toBe('patch');
    expect(suggestLevel(['⚠️ Breaking'], '1.2.0').level).toBe('major');
  });

  it('остальные заголовки списка дают patch', () => {
    for (const section of ['Removed', 'Deprecated', 'Security', 'Migration']) {
      expect(suggestLevel([section], '0.6.0').level).toBe('patch');
    }
  });

  // SECTION_LEVELS — единственный источник уровней: новый заголовок должен
  // заводиться одной строкой в карте, а не правкой ещё и в suggestLevel
  it('уровень каждого заголовка совпадает с объявленным в карте', () => {
    for (const [name, level] of SECTION_LEVELS) {
      const expected = level === 'breaking' ? 'minor' : (level ?? 'patch');

      expect({ name, level: suggestLevel([name], '0.6.0').level }).toEqual({
        name,
        level: expected,
      });
    }
  });

  // reason разработчик видит дважды: в таблице плана и в вопросе про версию —
  // и по нему идёт искать секцию в журнале
  it('подписывает уровень заголовком, который его задал', () => {
    expect(suggestLevel(['Fixed', 'Added'], '0.6.0').reason).toBe('### Added');
    expect(suggestLevel(['⚠️ Breaking — x', 'Migration'], '0.6.0').reason).toBe(
      '### ⚠️ Breaking',
    );
    expect(suggestLevel(['Changed', 'Fixed'], '0.6.0').reason).toBe(
      'без ### Added и ### ⚠️ Breaking',
    );
  });

  // значок необязателен, и дописывать его за автора нельзя: он пойдёт искать
  // в журнале подсказанную строку
  it('подпись цитирует журнал, а не каноничную форму', () => {
    expect(suggestLevel(['Breaking', 'Migration'], '0.6.0').reason).toBe(
      '### Breaking',
    );
  });

  // обещание карты — «новый заголовок заводится одной строкой»: приехать
  // должны и уровень, и подпись, иначе разработчика пошлют искать секцию,
  // которой в журнале нет
  it('подписывает заголовок, добавленный в карту', () => {
    SECTION_LEVELS.set('Performance', 'minor');

    try {
      expect(suggestLevel(['Performance'], '0.6.0')).toEqual({
        level: 'minor',
        reason: '### Performance',
      });
    } finally {
      SECTION_LEVELS.delete('Performance');
    }
  });

  // уровень берётся по старшинству, а не по порядку заголовков в секции
  it('решает старший заголовок независимо от порядка', () => {
    expect(suggestLevel(['Fixed', 'Added'], '0.6.0').level).toBe('minor');
    expect(suggestLevel(['Added', 'Fixed'], '0.6.0').level).toBe('minor');
    expect(suggestLevel(['Fixed', '⚠️ Breaking', 'Added'], '0.6.0').level).toBe(
      'minor',
    );
    expect(suggestLevel(['Added', '⚠️ Breaking'], '1.2.0').level).toBe('major');
  });
});

// Блоки кода: секция Migration по своей природе содержит примеры, в том
// числе примеры журнала. Разбор их не должен принимать за настоящие заголовки
describe('parseUnreleased и блоки кода', () => {
  const fenced = (body, fence = '```') => `# Changelog

## [Unreleased]

### Fixed

- Что-то.

${fence}
${body}
${fence}

## [0.2.1] — 2026-08-05

[0.2.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.1
`;

  // без этого ломающий релиз уехал бы как patch: строка ссылок в примере
  // обрывала секцию, а идущий следом ⚠️ Breaking терялся
  it('не обрывает секцию на строке ссылок внутри блока', () => {
    const text = fenced('[0.5.0]: https://example.test/tag/x').replace(
      '```\n\n## [0.2.1]',
      '```\n\n### ⚠️ Breaking — пример\n\n### Migration\n\n## [0.2.1]',
    );
    const parsed = parseUnreleased(text);

    expect(parsed.sections).toEqual([
      'Fixed',
      '⚠️ Breaking — пример',
      'Migration',
    ]);
    expect(suggestLevel(parsed.sections, '0.2.1').level).toBe('minor');
  });

  it('не считает под-заголовком пример внутри блока', () => {
    const parsed = parseUnreleased(fenced('### Added\n\n- пример записи.'));

    expect(parsed.sections).toEqual(['Fixed']);
    expect(suggestLevel(parsed.sections, '0.6.0').level).toBe('patch');
  });

  // иначе секция обрывалась на примере, Migration терялась и релиз вставал
  // на ложном «Breaking без Migration»
  it('не обрывает секцию на релизном заголовке внутри блока', () => {
    const text = fenced('## [0.5.0] — 2026-08-01')
      .replace('### Fixed', '### ⚠️ Breaking — пример')
      .replace('```\n\n## [0.2.1]', '```\n\n### Migration\n\n## [0.2.1]');
    const parsed = parseUnreleased(text);

    expect(parsed.sections).toEqual(['⚠️ Breaking — пример', 'Migration']);
    expect(validateUnreleased(parsed)).toEqual([]);
  });

  it('понимает ~~~ и инфо-строку после ограды', () => {
    expect(parseUnreleased(fenced('### Added', '~~~')).sections).toEqual(['Fixed']);
    expect(
      parseUnreleased(fenced('### Added').replace('```\n###', '```md\n###')).sections,
    ).toEqual(['Fixed']);
  });

  it('видит незакрытый блок кода', () => {
    const parsed = parseUnreleased(
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n```\nпример\n',
    );

    expect(parsed.openFence).toBe(true);
    expect(validateUnreleased(parsed)).toContain(
      'в [Unreleased] не закрыт блок кода — секция дочитана до конца файла',
    );
  });
});

describe('sectionName', () => {
  it('снимает эмодзи и уточнение после тире или в скобках', () => {
    expect(sectionName('⚠️ Breaking — `reset()` также чистит `my_game_id`')).toBe(
      'Breaking',
    );
    expect(sectionName('Migration (game plugins)')).toBe('Migration');
    expect(sectionName('Added')).toBe('Added');
  });

  // незнакомое имя возвращается как есть: отбраковка — дело validateSections,
  // и в сообщении о проблеме должно быть видно, что именно написано в журнале
  it('незнакомое имя возвращает как есть', () => {
    expect(sectionName('Improved')).toBe('Improved');
    expect(sectionName('  ')).toBeNull();
  });
});

describe('validateSections', () => {
  it('принимает реальный набор заголовков', () => {
    expect(validateSections(parseUnreleased(CORE).sections)).toEqual([]);
    expect(validateSections(['Added', 'Changed'])).toEqual([]);
  });

  // в core/CHANGELOG.md таких пар две в одной секции — проверка по наличию
  it('не считает проблемой две пары Breaking + Migration', () => {
    expect(
      validateSections([
        '⚠️ Breaking — первое',
        'Migration',
        '⚠️ Breaking — второе',
        'Migration',
      ]),
    ).toEqual([]);
  });

  it('отбраковывает заголовок вне списка', () => {
    expect(validateSections(['Improved'])[0]).toBe(
      'заголовок «### Improved» не из списка',
    );
  });

  // регистр и разделитель — самые вероятные причины отбраковки, и по одному
  // «не из списка» их не отличить
  it('подсказывает про регистр и разделитель', () => {
    for (const section of ['added', 'Added - x']) {
      const hint = validateSections([section]).at(-1);

      expect(hint).toContain('чувствительно к регистру');
      expect(hint).toContain('« — » или круглыми скобками');
    }
  });

  // подсказка длиннее самой проблемы: на трёх заголовках её повтор превратил
  // бы список отказа в три одинаковых абзаца
  it('подсказку печатает один раз на секцию', () => {
    const problems = validateSections(['Improved', 'Perf', 'Docs']);

    expect(problems).toHaveLength(4);
    expect(problems.filter(problem => problem.includes('регистру'))).toHaveLength(1);
  });

  it('требует пару Breaking + Migration в обе стороны', () => {
    expect(validateSections(['⚠️ Breaking'])).toEqual([
      'есть ### ⚠️ Breaking, но нет ### Migration',
    ]);
    expect(validateSections(['Migration'])).toEqual([
      'есть ### Migration, но нет ### ⚠️ Breaking',
    ]);
  });

  // правило из docs/en/publishing.md проверяется на живых журналах, иначе оно
  // остаётся пожеланием: релиз узнал бы о нарушении только в момент публикации
  it('живые журналы репозитория проходят контракт', async () => {
    for (const file of [
      'packages/engine/CHANGELOG.md',
      'packages/engine/core/CHANGELOG.md',
    ]) {
      const text = await readFile(path.join(ROOT, file), 'utf8');

      expect({ file, problems: validateUnreleased(parseUnreleased(text)) }).toEqual({
        file,
        problems: [],
      });
    }
  });
});

// Три способа не дать парсеру найти ни одного заголовка — все они молча
// давали бы patch, поэтому проверяются отдельно от validateSections
describe('validateUnreleased', () => {
  it('ловит ## вместо ### — секция обрывается на этой строке', () => {
    const parsed = parseUnreleased(
      '# Changelog\n\n## [Unreleased]\n\n## Added\n\n- запись.\n',
    );

    expect(parsed.sections).toEqual([]);
    expect(validateUnreleased(parsed)).toEqual([
      'секция [Unreleased] оборвана заголовком «## Added» — вероятно, ### написан как ##',
    ]);
  });

  it('ловит записи без единого под-заголовка', () => {
    const parsed = parseUnreleased('# Changelog\n\n## [Unreleased]\n\n- запись.\n');

    expect(validateUnreleased(parsed)).toEqual([
      'в [Unreleased] есть записи, но нет ни одного ### под-заголовка',
    ]);
  });

  it('ловит отсутствующую секцию', () => {
    expect(validateUnreleased(parseUnreleased('# Changelog\n'))).toEqual([
      'нет секции ## [Unreleased] — уровень релиза выводить не из чего',
    ]);
    expect(validateUnreleased(undefined)).toHaveLength(1);
  });

  // правка только фикстур или bin/: записей быть не должно, и это не ошибка
  it('пустую [Unreleased] проблемой не считает', () => {
    expect(validateUnreleased(parseUnreleased(ENGINE_EMPTY))).toEqual([]);
  });

  it('релизный заголовок как терминатор — норма', () => {
    expect(validateUnreleased(parseUnreleased(CORE))).toEqual([]);
  });
});

describe('releaseUnreleased', () => {
  it('датирует секцию и вставляет ссылку сверху блока', () => {
    const next = releaseUnreleased(CORE, {
      version: '0.3.0',
      date: '2026-08-09',
      repoUrl: 'https://github.com/lgick/vimp',
      artifact: 'vimp-engine-core',
    });

    expect(next).toContain('## [0.3.0] — 2026-08-09');

    // [Unreleased] остаётся, но становится пустой — иначе следующий релиз
    // теряет третий сигнал детекта
    const again = parseUnreleased(next);

    expect(again.present).toBe(true);
    expect(again.isEmpty).toBe(true);

    const links = next
      .split('\n')
      .filter(line => line.startsWith('[') && line.includes('releases/tag/'));

    expect(links[0]).toBe(
      '[0.3.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.3.0',
    );
    expect(links).toHaveLength(3);
  });

  it('заводит блок ссылок, если его ещё нет', () => {
    const next = releaseUnreleased('# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n', {
      version: '0.1.0',
      date: '2026-08-09',
      repoUrl: 'https://github.com/lgick/vimp',
      artifact: 'vimp-engine',
    });

    expect(next).toContain(
      releaseLink('https://github.com/lgick/vimp', 'vimp-engine', '0.1.0'),
    );
  });

  it('падает, если секции [Unreleased] нет', () => {
    expect(() =>
      releaseUnreleased('# Changelog\n', {
        version: '0.1.0',
        date: '2026-08-09',
        repoUrl: 'x',
        artifact: 'y',
      }),
    ).toThrow(/Unreleased/);
  });
});
