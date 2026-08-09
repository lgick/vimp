import { describe, it, expect } from 'vitest';

import {
  parseUnreleased,
  suggestLevel,
  releaseUnreleased,
  releaseLink,
} from '../../../scripts/release/changelog.js';

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

  it('предлагает инкремент по под-заголовкам', () => {
    expect(suggestLevel(parseUnreleased(CORE).sections, '0.2.1').level).toBe('minor');
    expect(suggestLevel(['Added'], '0.6.0').level).toBe('minor');
    expect(suggestLevel(['Changed', 'Fixed'], '0.6.0').level).toBe('patch');
    expect(suggestLevel(['⚠️ Breaking'], '1.2.0').level).toBe('major');
  });

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
